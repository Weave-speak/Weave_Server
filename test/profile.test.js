// A status and a picture: the two things a person owns about themselves.
//
// The status assertions are about SEPARATION. The roster has always derived "away" from
// standing in an AFK channel, and a declared status is a different fact — being moved
// between rooms must never overwrite something its owner set on purpose, or the setting
// is a suggestion rather than a setting.
//
// The avatar assertions are mostly about what is refused. An endpoint that writes a file
// to disk under a name derived from a request is the shape every path-traversal bug takes,
// and "it is an image" is a claim about bytes rather than about a filename.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

import { sniffImage } from '../src/core/media/image-type.js';

/** The smallest thing that is genuinely a PNG as far as the sniffer is concerned. */
const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 7)]);

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-prof-'));
    let httpPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(await freePort()),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const call = async (method, url, { body, token, raw, contentType } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(raw ? { 'Content-Type': contentType ?? 'application/octet-stream' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: raw ?? (body ? JSON.stringify(body) : undefined),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed, headers: res.headers };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201);

    const mint = async (name) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username: name, password: 'a-long-enough-password' },
        });
        assert.equal(user.status, 201, JSON.stringify(user.body));
        return user.body;
    };

    const sockets = [];
    const connect = async (token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${httpPort}`);
        sockets.push(ws);
        const inbox = [];
        const waiters = [];
        ws.on('message', (rawMsg) => {
            const msg = JSON.parse(rawMsg);
            const i = waiters.findIndex((w) => w.type === msg.type);
            if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); }
            else inbox.push(msg);
        });
        const expect = (type, ms = 5000) => {
            const found = inbox.findIndex((m) => m.type === type);
            if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(
                    `timeout waiting for ${type}; saw ${inbox.map((m) => m.type)}`)), ms);
                waiters.push({ type, resolve, timer });
            });
        };
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: { min: 1, max: 1 } }));
        const joined = await expect('joined');
        return { ws, joined, expect };
    };

    return {
        call, mint, connect,
        dataDir: path.join(dir, 'data'),
        adminToken: admin.body.token,
        adminId: admin.body.user.id,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

// ── the sniffer, on its own ──────────────────────────────────────────────────

test('an image is recognised by its bytes, never by what it is called', () => {
    assert.equal(sniffImage(PNG).ext, 'png');
    assert.equal(sniffImage(GIF).ext, 'gif');

    // The shape of the attack this exists to stop: a script that says it is a picture.
    const script = Buffer.from('<script>alert(1)</script>                     ', 'ascii');
    assert.equal(sniffImage(script), null);

    // And nothing throws on rubbish.
    assert.equal(sniffImage(Buffer.alloc(0)), null);
    assert.equal(sniffImage(Buffer.from([0x89])), null);
    assert.equal(sniffImage(null), null);
});

// ── status ───────────────────────────────────────────────────────────────────

test('everybody starts online, and can say otherwise', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const before = await h.call('GET', '/api/me', { token: kes.token });
    assert.equal(before.body.user.status, 'online', 'the default is a fact, not a null');

    const set = await h.call('PATCH', '/api/me', { token: kes.token, body: { status: 'away' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.user.status, 'away');
});

test('a status survives signing out and back in', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    await h.call('PATCH', '/api/me', { token: kes.token, body: { status: 'away' } });

    // A brand-new session, so this can only have come from the account.
    const again = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    const me = await h.call('GET', '/api/me', { token: again.body.token });
    assert.equal(me.body.user.status, 'away');
});

test('a made-up status is refused rather than stored', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const bad = await h.call('PATCH', '/api/me', { token: kes.token, body: { status: 'invisible' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /online, away/);

    // 'offline' is not a choice: it is what having no connection looks like, and letting
    // somebody claim it while connected would make the roster lie.
    const offline = await h.call('PATCH', '/api/me', { token: kes.token, body: { status: 'offline' } });
    assert.equal(offline.status, 400);
});

test('a status change reaches everybody, and rides the roster', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const watcher = await h.connect(h.adminToken);
    await h.connect(kes.token);

    await h.call('PATCH', '/api/me', { token: kes.token, body: { status: 'away' } });
    const told = await watcher.expect('peer_profile_changed');
    assert.equal(told.userId, kes.user.id);
    assert.equal(told.status, 'away');

    // And a client arriving afterwards learns it from the roster rather than from an event
    // it was not connected for.
    const fresh = await h.connect(h.adminToken);
    const row = fresh.joined.peers.find((p) => p.userId === kes.user.id);
    assert.equal(row.status, 'away');
});

test('a status is not a permission: nobody can set anybody else s', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    // There is no route that takes a target, so the only reachable shape is your own —
    // and an extra key must not widen it.
    const sneaky = await h.call('PATCH', '/api/me', {
        token: kes.token, body: { status: 'away', userId: h.adminId, isAdmin: true },
    });
    assert.equal(sneaky.status, 200);

    const admin = await h.call('GET', '/api/me', { token: h.adminToken });
    assert.equal(admin.body.user.status, 'online', 'the administrator was untouched');
    assert.equal(admin.body.user.isAdmin, true);
});

// ── the picture ──────────────────────────────────────────────────────────────

test('a picture is stored, served back, and attached to the account', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const up = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: PNG });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.avatar, /^[0-9a-f-]{36}\.png$/);
    assert.equal(up.body.user.avatar, up.body.avatar);

    // Stored outside uploads/, which is swept on a retention timer.
    assert.ok(fs.existsSync(path.join(h.dataDir, 'avatars', up.body.avatar)));
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'uploads', up.body.avatar)),
        'an avatar in uploads/ would be deleted after the retention window');

    const got = await h.call('GET', `/api/avatars/${up.body.avatar}`, { token: kes.token });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
});

test('what is not an image is refused, whatever it claims to be', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const script = Buffer.from('<script>alert(document.cookie)</script>       ', 'ascii');
    const refused = await h.call('POST', '/api/me/avatar', {
        token: kes.token, raw: script, contentType: 'image/png',
    });
    assert.equal(refused.status, 415, 'the declared Content-Type is a claim, not evidence');

    const empty = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: Buffer.alloc(0) });
    assert.equal(empty.status, 400);
});

test('an avatar id from a URL is never treated as a path', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    for (const attempt of [
        '..%2f..%2fweave.db',
        '../../weave.db',
        'not-a-uuid.png',
        '00000000-0000-0000-0000-000000000000.png',
    ]) {
        const res = await h.call('GET', `/api/avatars/${attempt}`, { token: kes.token });
        assert.ok(res.status === 404 || res.status === 400,
            `${attempt} should not resolve (got ${res.status})`);
    }
});

test('replacing a picture removes the old file, and removing one clears the account', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const avatars = path.join(h.dataDir, 'avatars');

    const first = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: PNG });
    const second = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: GIF });

    assert.ok(!fs.existsSync(path.join(avatars, first.body.avatar)), 'the replaced file is gone');
    assert.ok(fs.existsSync(path.join(avatars, second.body.avatar)));

    const cleared = await h.call('DELETE', '/api/me/avatar', { token: kes.token });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.avatar, null);
    assert.ok(!fs.existsSync(path.join(avatars, second.body.avatar)));
});

test('a new picture reaches everybody who is watching', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const watcher = await h.connect(h.adminToken);
    await h.connect(kes.token);

    const up = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: PNG });
    const told = await watcher.expect('peer_profile_changed');
    assert.equal(told.userId, kes.user.id);
    assert.equal(told.avatar, up.body.avatar);
});

test('a picture is not public: it needs a session like everything else', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const up = await h.call('POST', '/api/me/avatar', { token: kes.token, raw: PNG });

    const anonymous = await h.call('GET', `/api/avatars/${up.body.avatar}`);
    assert.equal(anonymous.status, 401,
        'a roster is not public, and neither is what the people on it look like');
});
