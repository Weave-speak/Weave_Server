// Weave admin console.
//
// Plain ES modules, no framework, no build step — the server has to be able to serve
// this straight off disk on a box where npm has never run, which is also why routing is
// a hash and rendering is string templates.
//
// Authentication is the HttpOnly admin cookie, never a token in JavaScript. That is the
// whole reason the admin panel logs in with `forAdminPanel: true` rather than reusing the
// client's bearer token: script on this page must not be able to read a credential.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Placeholders ───────────────────────────────────────────────────────────
 *
 * Screens whose backing functionality does not exist yet. Kept as data rather than
 * scattered through the views so the set is countable — `weave placeholders` and the
 * README both read this list, and a screen cannot quietly look finished when it is not.
 *
 * Each says what it will do, and what to use instead today.
 */
const PLACEHOLDERS = {
    roles: {
        title: 'Roles & Permissions',
        why: 'The server currently has exactly two levels of access: administrator, or not.',
        needs: [
            'Named roles with per-channel permissions, replacing the single is_admin flag',
            'A permission model the WebSocket handlers can check, not just the HTTP routes',
            'Assignment UI, and a rule that the last administrator cannot be demoted',
        ],
        instead: 'Members → select someone → Make administrator grants full access.',
    },
    timeouts: {
        title: 'Timeouts',
        why: 'Server mute and kick exist, but only from the client — this console cannot see or lift them.',
        needs: [
            'A list of the mutes and kicks currently in force, with who applied each and when it ends',
            'Lifting one from here, rather than having to find the person in a room first',
            'Ban as a separate verb: a kick is a cooldown, and blocking an account is not the same thing',
        ],
        instead: 'Right-click somebody in the client to server-mute or kick them. '
            + 'Members → Ban blocks an account outright.',
    },
    bugreports: {
        title: 'Bug Reports',
        why: 'Client-submitted diagnostic bundles need a client to submit them.',
        needs: [
            'A client-side "report a problem" action that gathers logs and getStats',
            'Redaction before anything leaves the reporter\'s machine, previewed by them first',
            'Storage with retention, and a download that streams rather than buffering',
        ],
        instead: 'System → Logs shows the server side of any incident.',
    },
    bubbles: {
        title: 'Bubbles',
        why: 'Not ported from the previous server yet.',
        needs: [
            'A bubbles module with its own tables and rotation timer',
            'Admin CRUD for bubbles, and a wipe action separate from deletion',
            'Client rendering, which is a client concern and does not exist yet',
        ],
        instead: 'Nothing — the feature is absent rather than half-present.',
    },
    diagnostics: {
        title: 'Diagnostics',
        why: 'Reachability testing needs something outside this network to answer.',
        needs: [
            'An inbound UDP probe, which cannot be done honestly from the server alone',
            'A per-connection view driven by iceSelectedTuple, showing who fell back to TCP',
            'A downloadable support bundle with redaction applied',
        ],
        instead: 'System → Overview reports the announced address and whether it was guessed.',
    },
};

/* ── API ───────────────────────────────────────────────────────────────────── */

let toastTimer = null;
function toast(message, kind = '') {
    $('.toast')?.remove();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4200);
}

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });

    let data = null;
    try { data = await res.json(); } catch { /* empty body is fine */ }

    if (res.status === 401 && state.me) {
        // The session went away underneath us. Say so rather than showing empty screens.
        state.me = null;
        location.hash = '#/login';
        render();
        throw new Error('Your session has expired. Sign in again.');
    }
    if (!res.ok) throw new Error(data?.message ?? `${res.status} on ${path}`);
    return data;
}

/* ── State ─────────────────────────────────────────────────────────────────── */

const state = {
    info: null,
    me: null,
    overview: null,
    tables: [],
    dbOpen: true,
    view: null,
    data: null,
    selected: null,
    search: '',
    filters: {},
    busy: false,
};

/**
 * Which table to show when Database is opened without one named.
 *
 * The busiest one, not the first alphabetically — landing on an empty table and being
 * told "No rows" says nothing about whether the browser works.
 */
const defaultTable = () =>
    [...state.tables].sort((a, b) => b.rows - a.rows)[0]?.name ?? null;

const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const fmtWhen = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const ms = typeof v === 'number' ? v : Date.parse(v.endsWith?.('Z') ? v : `${v}Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
};

const fmtUptime = (s) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/* ── Navigation ────────────────────────────────────────────────────────────── */

const NAV = [
    {
        group: 'Data',
        items: [{ id: 'database', label: 'Database', glyph: '▤', expandable: true }],
    },
    {
        group: 'Community',
        items: [
            { id: 'members', label: 'Members', glyph: '◍' },
            { id: 'roles', label: 'Roles & Permissions', glyph: '★', placeholder: true },
            { id: 'rooms', label: 'Rooms', glyph: '◈' },
            { id: 'invites', label: 'Invites', glyph: '✉' },
        ],
    },
    {
        group: 'Moderation',
        items: [
            { id: 'timeouts', label: 'Timeouts', glyph: '◔', placeholder: true },
            { id: 'bugreports', label: 'Bug Reports', glyph: '✻', placeholder: true },
            { id: 'audit', label: 'Audit Log', glyph: '≡' },
        ],
    },
    {
        group: 'Customise',
        items: [
            { id: 'bubbles', label: 'Bubbles', glyph: '○', placeholder: true },
            { id: 'sounds', label: 'Sounds', glyph: '♪' },
        ],
    },
    {
        group: 'System',
        items: [
            { id: 'overview', label: 'Overview', glyph: '◉' },
            { id: 'modules', label: 'Modules', glyph: '⬡' },
            { id: 'settings', label: 'Settings', glyph: '⚙' },
            { id: 'logs', label: 'Logs', glyph: '☰' },
            { id: 'diagnostics', label: 'Diagnostics', glyph: '⚕', placeholder: true },
        ],
    },
];

const route = () => {
    const raw = (location.hash || '#/overview').slice(2);
    const [view, ...rest] = raw.split('/');
    return { view: view || 'overview', arg: rest.join('/') };
};

/* ── Shell ─────────────────────────────────────────────────────────────────── */

function sidebar() {
    const { view, arg } = route();
    const counts = state.overview?.counts ?? {};

    const tableRows = state.tables.map((t) => `
        <button class="nav-item ${view === 'database' && arg === t.name ? 'active' : ''}"
                data-go="#/database/${esc(t.name)}">
            <span class="label">${esc(t.name)}</span>
            <span class="nav-count">${t.rows > 999 ? `${(t.rows / 1000).toFixed(1)}k` : t.rows}</span>
        </button>`).join('');

    const groups = NAV.map((g) => `
        <div class="nav-group">${esc(g.group)}</div>
        ${g.items.map((it) => {
        if (it.expandable) {
            return `
                <button class="nav-item ${view === 'database' ? 'active' : ''}" data-toggle-db>
                    <span class="nav-toggle ${state.dbOpen ? 'open' : ''}">›</span>
                    <span class="glyph">${it.glyph}</span>
                    <span class="label">${esc(it.label)}</span>
                    <span class="nav-count">${state.tables.length}</span>
                </button>
                ${state.dbOpen ? `<div class="nav-sub">${tableRows}</div>` : ''}`;
        }
        const count = it.id === 'members' ? counts.users
            : it.id === 'rooms' ? counts.channels
                : it.id === 'invites' ? counts.invites
                    : it.id === 'sounds' ? counts.persona_sounds
                        : null;
        return `
            <button class="nav-item ${view === it.id ? 'active' : ''}" data-go="#/${it.id}">
                <span class="glyph">${it.glyph}</span>
                <span class="label">${esc(it.label)}</span>
                ${count !== null && count !== undefined ? `<span class="nav-count">${count}</span>` : ''}
                ${it.placeholder ? '<span class="nav-count" title="Not built yet">–</span>' : ''}
            </button>`;
    }).join('')}`).join('');

    const db = state.overview?.database;
    return `
    <aside class="sidebar">
      <div class="jump">
        <div class="jump-field">
          <span class="icon">⌕</span>
          <input id="jump" placeholder="Jump to..." autocomplete="off">
          <kbd>⌘K</kbd>
        </div>
      </div>
      <nav class="nav">${groups}</nav>
      <div class="sidebar-foot">
        <span class="dot ${db?.healthy ? 'ok' : 'bad'}"></span>
        SQLite · ${fmtBytes(db?.bytes ?? 0)} · ${db?.healthy ? 'healthy' : 'check failed'}
      </div>
    </aside>`;
}

function shell(inner, crumbs) {
    return `
    <div class="topbar">
      <div class="brand"><span class="brand-mark">W</span> Admin Console</div>
      <div class="topbar-spacer"></div>
      <div class="topbar-user">
        <span>${esc(state.me?.displayName ?? state.me?.username ?? '')}</span>
        <button class="btn small" data-signout>Sign out</button>
      </div>
    </div>
    <div class="crumbs">
      ${crumbs.map((c, i) => `${i ? '<span class="sep">›</span>' : ''}<span class="${i === crumbs.length - 1 ? 'here' : ''}">${esc(c)}</span>`).join('')}
    </div>
    <div class="body">
      ${sidebar()}
      <main class="main">${inner}</main>
    </div>`;
}

/* ── Views ─────────────────────────────────────────────────────────────────── */

function placeholderView(key) {
    const p = PLACEHOLDERS[key];
    return `
    <div class="scroll">
      <div class="placeholder">
        <span class="tag">Not built yet</span>
        <h2>${esc(p.title)}</h2>
        <p>${esc(p.why)}</p>
        <p><strong>What this screen will need:</strong></p>
        <ul>${p.needs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        <p style="margin-top:14px"><strong>In the meantime:</strong> ${esc(p.instead)}</p>
      </div>
    </div>`;
}

function overviewView() {
    const o = state.overview;
    if (!o) return '<div class="empty">Loading…</div>';

    // The announced address is the single most common misconfiguration and its symptom
    // is the worst one — everything connects and nobody hears anything — so it gets a
    // banner rather than a row in a table.
    const guessed = o.media.announcedSource === 'guessed' || o.media.announcedSource === 'loopback';

    return `
    <div class="scroll">
      ${guessed ? `
        <div class="banner warn">
          <strong>The media address was guessed, not configured.</strong>
          Weave is telling clients to send audio to <code>${esc(o.media.announcedAddress)}</code>,
          which it picked by looking at this machine's network interfaces. If that is not
          reachable from where your users are, calls will connect and then stay silent.
          Set <code>WEAVE_ANNOUNCED_ADDRESS</code> to your public hostname or IP.
        </div>` : ''}

      ${o.exposure === 'public' && !o.behindTls ? `
        <div class="banner bad"><strong>Reachable publicly without TLS.</strong>
        Session cookies cannot be marked Secure, so credentials travel in clear text.</div>` : ''}

      <div class="cards">
        <div class="card">
          <h3>Connected now</h3>
          <div class="big">${o.connections.peers}</div>
          <div class="sub">${Object.keys(o.connections.byChannel).length} channel(s) in use</div>
        </div>
        <div class="card">
          <h3>Accounts</h3>
          <div class="big">${o.counts.users ?? 0}</div>
          <div class="sub">${o.counts.invites ?? 0} invite(s) issued</div>
        </div>
        <div class="card">
          <h3>Uptime</h3>
          <div class="big">${fmtUptime(o.uptimeSeconds)}</div>
          <div class="sub">Node ${esc(o.node)} · ${o.memoryMb} MB resident</div>
        </div>
        <div class="card">
          <h3>Modules</h3>
          <div class="big">${o.modules.filter((m) => m.enabled).length}<span style="color:var(--faint);font-size:16px">/${o.modules.length}</span></div>
          <div class="sub">enabled</div>
        </div>
      </div>

      <div class="cards" style="grid-template-columns:1fr 1fr">
        <div class="card">
          <h3>Media</h3>
          <dl class="kv">
            <dt>Announced as</dt><dd>${esc(o.media.announcedAddress)}
              <span style="color:var(--${guessed ? 'warn' : 'ok'})">(${esc(o.media.announcedSource)})</span></dd>
            <dt>Ports</dt><dd>${o.media.ports.join(', ')} <span style="color:var(--dim)">UDP + TCP</span></dd>
            <dt>Workers</dt><dd>${o.media.workers}</dd>
          </dl>
          <p class="sub" style="margin-top:12px">
            Forward these ports on <strong>both</strong> UDP and TCP. Media does not go
            through a reverse proxy.
          </p>
        </div>
        <div class="card">
          <h3>Database</h3>
          <dl class="kv">
            <dt>File</dt><dd>${esc(o.database.path)}</dd>
            <dt>Size</dt><dd>${fmtBytes(o.database.bytes)}</dd>
            <dt>Integrity</dt><dd style="color:var(--${o.database.healthy ? 'ok' : 'bad'})">${o.database.healthy ? 'ok' : 'FAILED'}</dd>
            <dt>Schema</dt><dd>${o.database.migrations.map((m) => `${esc(m.namespace)}@${m.version}`).join(', ')}</dd>
          </dl>
        </div>
      </div>
    </div>`;
}

/** Render one cell, giving meaning-carrying columns their own treatment. */
function cell(col, value, row) {
    if (col.secret) return '<span class="secret">••••••••</span>';
    if (value === null || value === undefined) return '<span class="null">null</span>';

    const name = col.name ?? col;
    if (/(^|_)(id)$/i.test(name) || name === '_rowid') return `<span class="mono" style="color:var(--faint)">${esc(String(value).slice(0, 8))}</span>`;
    if (/_at$/.test(name) || /^last_seen/.test(name)) return `<span class="mono">${esc(fmtWhen(value) ?? value)}</span>`;
    if (name === 'is_admin') return value ? '<span class="role-admin">Admin</span>' : '<span class="role-member">Member</span>';
    if (typeof value === 'number') return `<span class="mono">${value}</span>`;
    return esc(value);
}

function databaseView(tableName) {
    const d = state.data;
    if (!d) return '<div class="empty">Loading…</div>';

    const cols = d.columns.filter((c) => c.name !== '_rowid');
    return `
    <div class="toolbar">
      <div class="search">
        <span class="icon">⌕</span>
        <input id="q" placeholder="Search ${d.total} rows in ${esc(d.table)}..." value="${esc(state.search)}">
      </div>
      <span class="chip">${d.rows.length} of ${d.total}</span>
    </div>
    <div class="grid-wrap">
      <table class="grid">
        <thead><tr>${cols.map((c) => `<th>${esc(c.name)}${c.secret ? ' 🔒' : ''}</th>`).join('')}</tr></thead>
        <tbody>
          ${d.rows.length ? d.rows.map((r) => `
            <tr data-rowid="${r._rowid}" class="${state.selected === r._rowid ? 'selected' : ''}">
              ${cols.map((c) => `<td>${cell(c, r[c.name], r)}</td>`).join('')}
            </tr>`).join('')
        : `<tr><td colspan="${cols.length}" class="empty">No rows${state.search ? ' match that search' : ''}.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn" data-edit ${state.selected ? '' : 'disabled'}>Edit</button>
      <button class="btn danger" data-delete ${state.selected ? '' : 'disabled'}>Delete</button>
    </div>`;
}

function membersView() {
    const rows = state.data?.members ?? [];
    const channels = state.data?.channels ?? [];
    const chanName = (id) => channels.find((c) => c.id === id)?.name ?? '—';

    const filtered = rows.filter((m) => {
        if (state.filters.state && m.state !== state.filters.state) return false;
        if (state.search) {
            const hay = `${m.username} ${m.displayName}`.toLowerCase();
            if (!hay.includes(state.search.toLowerCase())) return false;
        }
        return true;
    });

    const states = [...new Set(rows.map((m) => m.state))];

    return `
    <div class="toolbar">
      <div class="search">
        <span class="icon">⌕</span>
        <input id="q" placeholder="Search ${rows.length} members..." value="${esc(state.search)}">
      </div>
      <button class="chip ${state.filters.role ? 'on' : ''}" data-filter="role">
        role: ${esc(state.filters.role ?? 'any')} ▾
      </button>
      <button class="chip ${state.filters.state ? 'on' : ''}" data-filter="state">
        state: ${esc(state.filters.state ?? 'any')} ${state.filters.state ? '<span class="x">×</span>' : '▾'}
      </button>
      ${states.length ? `<span class="chip" style="cursor:default">${filtered.length} shown</span>` : ''}
    </div>
    <div class="grid-wrap">
      <table class="grid">
        <thead><tr>
          <th>ID</th><th>Username</th><th>Display name</th><th>Last seen</th>
          <th>Role</th><th>Room</th><th>State</th>
        </tr></thead>
        <tbody>
          ${filtered.length ? filtered.map((m, i) => `
            <tr data-member="${esc(m.id)}" class="${state.selected === m.id ? 'selected' : ''}">
              <td class="id">${String(i + 1).padStart(2, '0')}</td>
              <td class="key">${esc(m.username)}</td>
              <td>${esc(m.displayName)}</td>
              <td class="mono">${esc(fmtWhen(m.lastSeenAt) ?? '—')}</td>
              <td class="${m.isAdmin ? 'role-admin' : 'role-member'}">${m.isAdmin ? 'Admin' : 'Member'}</td>
              <td>${esc(m.channelId ? chanName(m.channelId) : '—')}</td>
              <td class="state-${esc(m.state)}">${esc(m.state)}</td>
            </tr>`).join('')
        : '<tr><td colspan="7" class="empty">No members match.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn" data-member-admin ${state.selected ? '' : 'disabled'}>Toggle admin</button>
      <button class="btn" data-member-reset ${state.selected ? '' : 'disabled'}>Reset password</button>
      <button class="btn danger" data-member-delete ${state.selected ? '' : 'disabled'}>Delete</button>
    </div>`;
}

function roomsView() {
    const rows = state.data?.channels ?? [];
    return `
    <div class="toolbar">
      <div class="search"><span class="icon">⌕</span>
        <input id="q" placeholder="Search ${rows.length} rooms..." value="${esc(state.search)}"></div>
      <button class="btn primary small" data-room-new>New room</button>
    </div>
    <div class="grid-wrap">
      <table class="grid">
        <thead><tr><th>Name</th><th>Kind</th><th>Voice</th><th>Text</th><th>Video</th><th>Default</th></tr></thead>
        <tbody>
          ${rows.filter((c) => c.name.toLowerCase().includes(state.search.toLowerCase())).map((c) => `
            <tr data-room="${esc(c.id)}" class="${state.selected === c.id ? 'selected' : ''}">
              <td class="key">${esc(c.name)}</td>
              <td>${esc(c.kind)}</td>
              <td class="${c.allowVoice ? 'state-live' : 'state-offline'}">${c.allowVoice ? 'yes' : 'no'}</td>
              <td class="${c.allowText ? 'state-live' : 'state-offline'}">${c.allowText ? 'yes' : 'no'}</td>
              <td class="${c.allowVideo ? 'state-live' : 'state-offline'}">${c.allowVideo ? 'yes' : 'no'}</td>
              <td>${c.isDefault ? '<span class="role-admin">default</span>' : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn" data-room-edit ${state.selected ? '' : 'disabled'}>Edit</button>
      <button class="btn danger" data-room-delete ${state.selected ? '' : 'disabled'}>Delete</button>
    </div>`;
}

function invitesView() {
    const rows = state.data?.invites ?? [];
    const status = (i) => {
        if (i.uses >= i.maxUses) return ['used', 'state-offline'];
        if (i.expiresAt && i.expiresAt < Date.now()) return ['expired', 'state-muted'];
        return ['open', 'state-live'];
    };
    return `
    <div class="toolbar">
      <div class="search"><span class="icon">⌕</span>
        <input id="q" placeholder="Search ${rows.length} invites..." value="${esc(state.search)}"></div>
      <button class="btn primary small" data-invite-new>Create invite</button>
    </div>
    <div class="grid-wrap">
      <table class="grid">
        <thead><tr><th>Code</th><th>Created by</th><th>Created</th><th>Expires</th><th>Uses</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.length ? rows.filter((i) => i.code.includes(state.search.toUpperCase())).map((i) => {
        const [label, cls] = status(i);
        return `<tr data-invite="${esc(i.code)}" class="${state.selected === i.code ? 'selected' : ''}">
              <td class="mono key">${esc(i.code)}</td>
              <td>${esc(i.createdByName ?? '—')}</td>
              <td class="mono">${esc(fmtWhen(i.createdAt) ?? '—')}</td>
              <td class="mono">${esc(i.expiresAt ? fmtWhen(i.expiresAt) : 'never')}</td>
              <td class="mono">${i.uses}/${i.maxUses}</td>
              <td class="${cls}">${label}</td>
            </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No invites yet.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn danger" data-invite-revoke ${state.selected ? '' : 'disabled'}>Revoke</button>
    </div>`;
}

function auditView() {
    const rows = state.data?.entries ?? [];
    return `
    <div class="toolbar">
      <div class="search"><span class="icon">⌕</span>
        <input id="q" placeholder="Search ${rows.length} entries..." value="${esc(state.search)}"></div>
    </div>
    <div class="grid-wrap">
      <table class="grid">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>
          ${rows.length ? rows
        .filter((e) => JSON.stringify(e).toLowerCase().includes(state.search.toLowerCase()))
        .map((e) => `
            <tr>
              <td class="mono">${esc(fmtWhen(e.at) ?? e.at)}</td>
              <td class="key">${esc(e.actor ?? 'system')}</td>
              <td class="mono">${esc(e.action)}</td>
              <td>${esc(e.target ?? '—')}</td>
              <td style="color:var(--dim)">${esc(e.detail ?? '')}</td>
            </tr>`).join('')
        : '<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function modulesView() {
    const mods = state.data?.modules ?? [];
    return `
    <div class="scroll">
      <div class="banner info">
        <strong>Every feature here can be switched off.</strong>
        Disabling removes a module's routes and message types from the running server —
        no restart — and leaves its data alone, so re-enabling restores it intact.
      </div>
      <div class="cards" style="grid-template-columns:1fr">
        ${mods.map((m) => `
          <div class="card" style="display:flex;gap:16px;align-items:flex-start">
            <span class="dot ${m.enabled ? 'ok' : 'idle'}" style="margin-top:6px"></span>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:10px">
                <strong>${esc(m.name)}</strong>
                <span class="mono" style="color:var(--faint);font-size:12px">${esc(m.id)} v${esc(m.version)}</span>
              </div>
              <p class="sub" style="margin-top:5px">${esc(m.description)}</p>
              ${m.requires.length ? `<p class="sub">Requires: ${m.requires.map(esc).join(', ')}</p>` : ''}
            </div>
            <button class="btn small ${m.enabled ? '' : 'primary'}"
                    data-module="${esc(m.id)}" data-action="${m.enabled ? 'disable' : 'enable'}">
              ${m.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>`).join('')}
      </div>
    </div>`;
}

function settingsView() {
    const groups = state.data?.groups ?? [];
    if (!groups.length) {
        return '<div class="scroll"><div class="empty">No settings are declared. Enable a module to see its options.</div></div>';
    }

    const control = (s) => {
        const id = `set_${s.key.replace(/[^a-z0-9]/gi, '_')}`;
        if (s.type === 'boolean') {
            return `<div class="field check">
                <input type="checkbox" id="${id}" data-setting="${esc(s.key)}" ${s.value ? 'checked' : ''}>
                <label for="${id}">${esc(s.label)}${s.help ? `<div class="help">${esc(s.help)}</div>` : ''}</label>
            </div>`;
        }
        if (s.type === 'enum') {
            return `<div class="field"><label for="${id}">${esc(s.label)}</label>
                <select id="${id}" data-setting="${esc(s.key)}">
                    ${s.values.map((v) => `<option ${v === s.value ? 'selected' : ''}>${esc(v)}</option>`).join('')}
                </select>${s.help ? `<div class="help">${esc(s.help)}</div>` : ''}</div>`;
        }
        const type = s.type === 'number' ? 'number' : 'text';
        return `<div class="field"><label for="${id}">${esc(s.label)}</label>
            <input type="${type}" id="${id}" data-setting="${esc(s.key)}" value="${esc(s.value)}"
                ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''}>
            ${s.help ? `<div class="help">${esc(s.help)}</div>` : ''}</div>`;
    };

    return `
    <div class="scroll">
      ${groups.map((g) => `
        <div class="card" style="margin-bottom:14px">
          <h3>${esc(g.owner)}</h3>
          ${g.items.map(control).join('')}
        </div>`).join('')}
      <button class="btn primary" data-save-settings>Save settings</button>
    </div>`;
}

function logsView() {
    const entries = state.data?.entries ?? [];
    const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
    return `
    <div class="toolbar">
      <div class="search"><span class="icon">⌕</span>
        <input id="q" placeholder="Filter ${entries.length} lines..." value="${esc(state.search)}"></div>
      <button class="btn small" data-reload-logs>Refresh</button>
    </div>
    <div class="logs">
      ${entries.length ? entries
        .filter((e) => !state.search || JSON.stringify(e).toLowerCase().includes(state.search.toLowerCase()))
        .map((e) => `
        <div class="logline">
          <span class="t">${esc((e.time ?? '').slice(11, 19))}</span>
          <span class="lvl lvl-${e.level ?? 30}">${esc(LEVELS[e.level] ?? '')}</span>
          <span class="evt">${esc(e.evt ?? '')}</span>
          <span>${esc(e.msg ?? '')}</span>
        </div>`).join('')
        : '<div class="empty">No log entries yet. The server writes here as things happen.</div>'}
    </div>
    <div class="actions"></div>`;
}

function soundsView() {
    const sounds = state.data?.sounds;
    if (sounds === null) {
        return `<div class="scroll"><div class="banner info">
          <strong>The join and leave sounds module is switched off.</strong>
          Turn it on under System → Modules to manage a sound library.
        </div></div>`;
    }
    return `
    <div class="scroll">
      <div class="banner info">
        <strong>This server ships with no sounds.</strong>
        The previous version bundled a library nobody had the right to redistribute, so
        the mechanism is here and the contents are not — upload what your group owns.
      </div>
      <div class="grid-wrap" style="max-height:none">
        <table class="grid">
          <thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead>
          <tbody>${sounds.length ? sounds.map((s) => `
            <tr><td class="key">${esc(s.name)}</td><td class="mono">${esc(s.mime)}</td>
            <td class="mono">${fmtBytes(s.bytes)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="empty">No sounds uploaded.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

/* ── Setup and login ───────────────────────────────────────────────────────── */

function setupView() {
    return `
    <div class="centre"><div class="centre-card">
      <div class="lead">
        <span class="brand-mark">W</span>
        <h1>Set up ${esc(state.info?.instance?.name ?? 'Weave')}</h1>
        <p>No administrator exists yet. The setup code was printed to the server console.</p>
      </div>
      <div class="steps"><div class="step done"></div><div class="step done"></div></div>
      <div id="msg"></div>
      <form id="setupForm">
        <div class="field">
          <label for="code">Setup code</label>
          <input id="code" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" required
                 style="font-family:var(--mono);letter-spacing:0.06em">
          <div class="help">Printed to the console at startup, and stored in the data directory.</div>
        </div>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" autocomplete="username" required>
          <div class="help">This is what you sign in with. It is not your real name.</div>
        </div>
        <div class="field">
          <label for="displayName">Display name</label>
          <input id="displayName" autocomplete="nickname">
          <div class="help">What other people see. Defaults to your username.</div>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="new-password" required minlength="10">
          <div class="help">At least 10 characters.</div>
        </div>
        <div class="field">
          <label for="recovery">Recovery phrase</label>
          <input id="recovery" autocomplete="off" minlength="12">
          <div class="help">
            A few unrelated words. It is the only way back in if you forget your password,
            and it is stored hashed, so nobody can read it back to you — write it down.
          </div>
        </div>
        <button class="btn primary" type="submit" style="width:100%">Create administrator</button>
      </form>
    </div></div>`;
}

function loginView() {
    return `
    <div class="centre"><div class="centre-card">
      <div class="lead">
        <span class="brand-mark">W</span>
        <h1>${esc(state.info?.instance?.name ?? 'Weave')} admin</h1>
        <p>Sign in with an administrator account.</p>
      </div>
      <div id="msg"></div>
      <form id="loginForm">
        <div class="field"><label for="lu">Username</label>
          <input id="lu" autocomplete="username" required></div>
        <div class="field"><label for="lp">Password</label>
          <input id="lp" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" type="submit" style="width:100%">Sign in</button>
      </form>
    </div></div>`;
}

/* ── Data loading ──────────────────────────────────────────────────────────── */

async function loadView() {
    const { view, arg } = route();
    state.view = view;

    if (PLACEHOLDERS[view]) { state.data = null; return; }

    switch (view) {
        case 'overview':
            state.overview = await api('/api/admin/overview');
            break;
        case 'database': {
            const table = arg || defaultTable();
            if (!table) { state.data = null; break; }
            const qs = new URLSearchParams({ limit: '200' });
            if (state.search) qs.set('q', state.search);
            state.data = await api(`/api/admin/tables/${encodeURIComponent(table)}?${qs}`);
            break;
        }
        case 'members': {
            const [m, c] = await Promise.all([
                api('/api/admin/members'), api('/api/channels'),
            ]);
            state.data = { members: m.members, channels: c.channels };
            break;
        }
        case 'rooms':
            state.data = await api('/api/channels');
            break;
        case 'invites':
            state.data = await api('/api/invites');
            break;
        case 'audit':
            state.data = await api('/api/admin/audit');
            break;
        case 'modules':
            state.data = await api('/api/admin/modules');
            break;
        case 'settings':
            state.data = await api('/api/admin/settings');
            break;
        case 'logs':
            state.data = await api('/api/admin/logs?lines=400');
            break;
        case 'sounds':
            // A module's screen has to cope with the module being switched off.
            try {
                state.data = await api('/api/personas/sounds');
            } catch {
                state.data = { sounds: null };
            }
            break;
        default:
            state.data = null;
    }
}

async function refreshChrome() {
    const [tables, overview] = await Promise.all([
        api('/api/admin/tables').catch(() => ({ tables: [] })),
        api('/api/admin/overview').catch(() => null),
    ]);
    state.tables = tables.tables;
    state.overview = overview;
}

/* ── Render ────────────────────────────────────────────────────────────────── */

const VIEWS = {
    overview: overviewView,
    database: databaseView,
    members: membersView,
    rooms: roomsView,
    invites: invitesView,
    audit: auditView,
    modules: modulesView,
    settings: settingsView,
    logs: logsView,
    sounds: soundsView,
};

const TITLES = {
    overview: 'Overview', database: 'Database', members: 'Members', rooms: 'Rooms',
    invites: 'Invites', audit: 'Audit Log', modules: 'Modules', settings: 'Settings',
    logs: 'Logs', sounds: 'Sounds', roles: 'Roles & Permissions', timeouts: 'Timeouts',
    bugreports: 'Bug Reports', bubbles: 'Bubbles', diagnostics: 'Diagnostics',
};

function render() {
    const app = $('#app');
    const { view, arg } = route();

    if (state.info?.setupRequired) { app.innerHTML = setupView(); return wire(); }
    if (!state.me) { app.innerHTML = loginView(); return wire(); }

    const inner = PLACEHOLDERS[view]
        ? placeholderView(view)
        : (VIEWS[view] ?? overviewView)(arg);

    const crumbs = ['Weave', 'Admin', TITLES[view] ?? view];
    if (view === 'database' && arg) crumbs.push(arg);

    app.innerHTML = shell(inner, crumbs);
    wire();
}

async function go() {
    try {
        state.busy = true;
        await loadView();
    } catch (err) {
        toast(err.message, 'bad');
    } finally {
        state.busy = false;
        render();
    }
}

/* ── Wiring ────────────────────────────────────────────────────────────────── */

function wire() {
    $('[data-signout]')?.addEventListener('click', async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        state.me = null;
        location.hash = '#/login';
        render();
    });

    document.querySelectorAll('[data-go]').forEach((el) => {
        el.addEventListener('click', () => {
            state.selected = null;
            state.search = '';
            location.hash = el.dataset.go;
        });
    });

    $('[data-toggle-db]')?.addEventListener('click', () => {
        state.dbOpen = !state.dbOpen;
        if (state.tables.length) location.hash = `#/database/${defaultTable()}`;
        else render();
    });

    // Search is debounced so the table browser does not issue a request per keystroke.
    // Views whose data is already in memory filter locally and never hit the network.
    const LOCAL_SEARCH = new Set(['members', 'rooms', 'invites', 'audit', 'logs']);
    const q = $('#q');
    if (q) {
        let timer = null;
        q.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                state.search = q.value;
                if (LOCAL_SEARCH.has(state.view)) render(); else go();
                // Re-rendering replaces the input, so put the cursor back where it was.
                const box = $('#q');
                if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
            }, 220);
        });
    }

    document.querySelectorAll('tr[data-rowid]').forEach((tr) => {
        tr.addEventListener('click', () => {
            state.selected = state.selected === Number(tr.dataset.rowid) ? null : Number(tr.dataset.rowid);
            render();
        });
    });

    for (const [attr, key] of [['data-member', 'member'], ['data-room', 'room'], ['data-invite', 'invite']]) {
        document.querySelectorAll(`tr[${attr}]`).forEach((tr) => {
            tr.addEventListener('click', () => {
                const value = tr.getAttribute(attr);
                state.selected = state.selected === value ? null : value;
                render();
            });
        });
    }

    $('[data-delete]')?.addEventListener('click', async () => {
        if (!confirm(`Delete this row from ${state.data.table}? This cannot be undone.`)) return;
        try {
            await api(`/api/admin/tables/${encodeURIComponent(state.data.table)}/${state.selected}`, { method: 'DELETE' });
            toast('Row deleted', 'ok');
            state.selected = null;
            await refreshChrome();
            go();
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('[data-edit]')?.addEventListener('click', () => openRowEditor());

    document.querySelectorAll('[data-module]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await api(`/api/admin/modules/${btn.dataset.module}/${btn.dataset.action}`, { method: 'POST' });
                toast(`Module ${btn.dataset.action}d`, 'ok');
                await refreshChrome();
                go();
            } catch (err) { toast(err.message, 'bad'); }
        });
    });

    $('[data-save-settings]')?.addEventListener('click', async () => {
        const payload = {};
        document.querySelectorAll('[data-setting]').forEach((el) => {
            payload[el.dataset.setting] = el.type === 'checkbox' ? el.checked
                : el.type === 'number' ? Number(el.value) : el.value;
        });
        try {
            await api('/api/admin/settings', { method: 'PUT', body: payload });
            toast('Settings saved', 'ok');
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('[data-reload-logs]')?.addEventListener('click', go);

    $('[data-member-reset]')?.addEventListener('click', async () => {
        const password = prompt('New password for this account (at least 10 characters):');
        if (!password) return;
        try {
            const r = await api(`/api/admin/members/${state.selected}/reset-password`, {
                method: 'POST', body: { password },
            });
            toast(`Password reset. ${r.sessionsRevoked} session(s) signed out.`, 'ok');
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('[data-member-admin]')?.addEventListener('click', async () => {
        const m = state.data.members.find((x) => x.id === state.selected);
        try {
            await api(`/api/admin/members/${state.selected}/admin`, {
                method: 'POST', body: { isAdmin: !m.isAdmin },
            });
            toast(m.isAdmin ? 'Administrator access removed' : 'Administrator access granted', 'ok');
            go();
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('[data-invite-new]')?.addEventListener('click', async () => {
        try {
            const r = await api('/api/invites', { method: 'POST', body: { maxUses: 1 } });
            toast(`Invite created: ${r.invite.code}`, 'ok');
            go();
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('[data-invite-revoke]')?.addEventListener('click', async () => {
        try {
            await api(`/api/invites/${encodeURIComponent(state.selected)}`, { method: 'DELETE' });
            toast('Invite revoked', 'ok');
            state.selected = null;
            go();
        } catch (err) { toast(err.message, 'bad'); }
    });

    $('#setupForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/setup', {
                method: 'POST',
                body: {
                    code: $('#code').value.trim(),
                    username: $('#username').value.trim(),
                    displayName: $('#displayName').value.trim() || undefined,
                    password: $('#password').value,
                    recoveryPhrase: $('#recovery').value.trim() || undefined,
                },
            });
            // Setup returns a bearer token for a client, but the console needs its cookie,
            // so sign in properly rather than pretending the token is a session here.
            await api('/api/auth/login', {
                method: 'POST',
                body: {
                    username: $('#username').value.trim(),
                    password: $('#password').value,
                    forAdminPanel: true,
                },
            });
            await boot();
        } catch (err) {
            $('#msg').innerHTML = `<div class="msg bad">${esc(err.message)}</div>`;
        }
    });

    $('#loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/auth/login', {
                method: 'POST',
                body: { username: $('#lu').value.trim(), password: $('#lp').value, forAdminPanel: true },
            });
            await boot();
        } catch (err) {
            $('#msg').innerHTML = `<div class="msg bad">${esc(err.message)}</div>`;
        }
    });
}

function openRowEditor() {
    const row = state.data.rows.find((r) => r._rowid === state.selected);
    const cols = state.data.columns.filter((c) => c.name !== '_rowid' && !c.pk && !c.secret);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Edit row</h2>
        <p class="sub">${esc(state.data.table)} · rowid ${state.selected}</p>
        ${cols.map((c) => `
          <div class="field">
            <label for="e_${esc(c.name)}">${esc(c.name)} <span style="color:var(--faint)">${esc(c.type)}</span></label>
            <input id="e_${esc(c.name)}" data-col="${esc(c.name)}" value="${esc(row[c.name] ?? '')}">
          </div>`).join('')}
        ${state.data.columns.some((c) => c.secret)
        ? '<p class="sub">Hidden columns (password and token hashes) are not editable here — use the proper action for them.</p>'
        : ''}
        <div class="modal-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-save>Save</button>
        </div>
      </div>`;

    document.body.append(overlay);
    overlay.querySelector('[data-cancel]').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('[data-save]').onclick = async () => {
        const payload = {};
        overlay.querySelectorAll('[data-col]').forEach((el) => {
            if (String(row[el.dataset.col] ?? '') !== el.value) payload[el.dataset.col] = el.value;
        });
        if (!Object.keys(payload).length) { overlay.remove(); return; }
        try {
            await api(`/api/admin/tables/${encodeURIComponent(state.data.table)}/${state.selected}`,
                { method: 'PUT', body: payload });
            toast('Row updated', 'ok');
            overlay.remove();
            go();
        } catch (err) { toast(err.message, 'bad'); }
    };
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */

async function boot() {
    state.info = await api('/api/server-info');

    if (state.info.setupRequired) { render(); return; }

    try {
        const me = await api('/api/me');
        state.me = me.user;
    } catch {
        state.me = null;
    }

    if (!state.me) { render(); return; }
    if (!state.me.isAdmin) {
        $('#app').innerHTML = `<div class="centre"><div class="centre-card">
          <div class="msg bad">This account is not an administrator.</div></div></div>`;
        return;
    }

    await refreshChrome();
    if (!location.hash || location.hash === '#/login') location.hash = '#/overview';
    go();
}

window.addEventListener('hashchange', () => { state.selected = null; go(); });
window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#jump')?.focus(); }
});

boot().catch((err) => {
    $('#app').innerHTML = `<div class="centre"><div class="centre-card">
      <div class="msg bad">Could not reach the server: ${esc(err.message)}</div></div></div>`;
});
