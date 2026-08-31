// The invite landing page.
//
// An invite CODE is for people who already have Weave; an invite LINK is for people who
// have nothing yet. This page is what the link opens: it names the server, offers the
// desktop download, and — for someone who already installed — a weave:// deep link that
// opens the app with the server and code prefilled. One self-contained HTML response, no
// SPA, no assets, so it renders instantly on a phone where the person will read it first.
//
// Unauthenticated by necessity and rate-limited accordingly. It never says WHY a code is
// invalid (used up, expired, revoked all read the same), and it never lists anything.

import { checkInvite, normaliseCode } from '../../invites/index.js';

const RELEASES_PAGE = 'https://github.com/Weave-speak/Weave_Client/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/Weave-speak/Weave_Client/releases?per_page=1';
const CACHE_MS = 10 * 60 * 1000;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The page, as one string. Inline styles: no assets, no second request, no CSP fuss. */
export function invitePage({ serverName, origin, code, valid }) {
    const deepLink = `weave://join?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
    const title = valid ? `Join ${esc(serverName)} on Weave` : 'This invite is no longer valid';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #08070f; color: #eceaf5;
         font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .card { width: min(420px, calc(100vw - 32px)); background: #1a1730;
          border: 1px solid #2a2740; border-radius: 20px; padding: 34px; text-align: center; }
  .mark { width: 64px; height: 64px; margin: 0 auto 16px; border-radius: 18px; display: grid;
          place-items: center; background: linear-gradient(150deg, #a78bfa, #6d28d9); }
  h1 { margin: 0 0 6px; font-size: 25px; letter-spacing: -0.02em; }
  p { margin: 0 0 22px; color: #9691b0; }
  .btn { display: block; padding: 13px 18px; margin: 0 0 10px; border-radius: 12px;
         background: linear-gradient(180deg, #a78bfa, #8b5cf6); color: #fff;
         font-weight: 600; text-decoration: none; }
  .btn.quiet { background: #221e3a; color: #eceaf5; border: 1px solid #2a2740; }
  .code { margin-top: 18px; font: 17px ui-monospace, Consolas, monospace;
          letter-spacing: 0.14em; color: #e0a33e; user-select: all; }
  .hint { margin-top: 6px; font-size: 12px; color: #625d7d; }
</style>
</head>
<body>
<main class="card">
  <div class="mark" aria-hidden="true">
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"
         stroke-linecap="round"><path d="M3 14c2.5 0 2.5-4 5-4s2.5 4 5 4 2.5-4 5-4 2.5 4 3 4"/></svg>
  </div>
  ${valid ? `
  <h1>${esc(serverName)}</h1>
  <p>You have been invited. Weave is a self-hosted voice and text app — this invite signs
     you into this crew's own server.</p>
  <a class="btn" id="open" href="${esc(deepLink)}">Open in Weave</a>
  <a class="btn quiet" id="dl" href="/download/windows">Download for Windows</a>
  <p class="hint" id="steps" hidden>Run the installer when it lands. Weave opens itself —
     then press <b>Open in Weave</b> above and you arrive with everything filled in.
     Keep this page open until then.</p>
  <div class="code">${esc(code)}</div>
  <div class="hint">Your invite code — the app fills it in for you.</div>
  <script>
    document.getElementById('dl').addEventListener('click', function () {
      document.getElementById('steps').hidden = false;
      var open = document.getElementById('open');
      open.textContent = 'Installed? Open in Weave';
    });
  </script>
  ` : `
  <h1>This invite is no longer valid</h1>
  <p>It may have been used, expired, or withdrawn. Ask whoever sent it for a fresh one.</p>
  <a class="btn quiet" href="/download/windows">Get Weave anyway</a>
  `}
</main>
</body>
</html>`;
}

/**
 * The one URL that always downloads the newest Windows installer.
 *
 * A 302 to the current GitHub release asset, so the bytes ride GitHub's CDN while the
 * link people share stays this server's own and never goes stale. The lookup is cached;
 * a lookup failure serves the last-known asset, and with no knowledge at all it falls
 * back to the releases page rather than a dead end.
 */
export function createDownloadResolver(fetcher = fetch) {
    let cached = { url: null, at: 0 };
    return async function resolveLatestExe() {
        if (cached.url && Date.now() - cached.at < CACHE_MS) return cached.url;
        try {
            const res = await fetcher(RELEASES_API, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'weave-server' },
            });
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const [release] = await res.json();
            const exe = release?.assets?.find((a) => a.name?.endsWith('.exe') && !a.name.includes('blockmap'));
            if (exe?.browser_download_url) {
                cached = { url: exe.browser_download_url, at: Date.now() };
                return cached.url;
            }
        } catch { /* the stale answer below is still the best one available */ }
        cached.at = Date.now();   // do not hammer a failing API
        return cached.url ?? RELEASES_PAGE;
    };
}

export function registerInvitePage({ router, db, config, resolveLatestExe = createDownloadResolver() }) {
    // A tiny in-memory limiter: this page is unauthenticated and enumerable-looking, so
    // an address gets a small budget and then silence. Codes are 128-bit-ish random, so
    // enumeration is hopeless anyway; the limiter just makes it expensive to try.
    const seen = new Map();
    const allow = (ip) => {
        const now = Date.now();
        const hits = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
        if (hits.length >= 20) { seen.set(ip, hits); return false; }
        hits.push(now);
        seen.set(ip, hits);
        return true;
    };

    router.register('core', 'GET', '/download/windows', async ({ ip, res, text }) => {
        if (!allow(ip)) return text(429, 'Slow down.');
        const target = await resolveLatestExe();
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
        res.end();
    }, { auth: 'none' });

    router.register('core', 'GET', '/invite/:code', ({ params, ip, req, text }) => {
        if (!allow(ip)) return text(429, 'Slow down.');

        const code = normaliseCode(params.code ?? '');
        const result = code ? checkInvite(db, code) : { ok: false };

        let origin;
        if (config.publicUrl) {
            origin = config.publicUrl;
        } else {
            // Host is safe to reflect here: the browser already sent it, so it matches
            // what the user typed. Forwarded-host is NOT reflected — it is attacker-
            // controlled when the request does not come through a trusted proxy, and even
            // when it does, publicUrl is the right answer.
            const host = req.headers.host ?? 'this-server';
            const proto = config.behindTls ? 'https' : 'http';
            origin = `${proto}://${host}`;
        }

        const html = invitePage({
            serverName: config.instanceName ?? 'a Weave server',
            origin,
            code,
            valid: Boolean(result.ok),
        });
        text(200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }, { auth: 'none' });
}
