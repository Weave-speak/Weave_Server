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

const RELEASES = 'https://github.com/Weave-speak/Weave_Client/releases/latest';

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
  <a class="btn" href="${esc(deepLink)}">Open in Weave</a>
  <a class="btn quiet" href="${esc(RELEASES)}">Download for Windows</a>
  <div class="code">${esc(code)}</div>
  <div class="hint">Your invite code — the app fills it in for you. After installing,
       open this link again.</div>
  ` : `
  <h1>This invite is no longer valid</h1>
  <p>It may have been used, expired, or withdrawn. Ask whoever sent it for a fresh one.</p>
  <a class="btn quiet" href="${esc(RELEASES)}">Get Weave anyway</a>
  `}
</main>
</body>
</html>`;
}

export function registerInvitePage({ router, db, config }) {
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

    router.register('core', 'GET', '/invite/:code', ({ params, ip, req, text }) => {
        if (!allow(ip)) return text(429, 'Slow down.');

        const code = normaliseCode(params.code ?? '');
        const result = code ? checkInvite(db, code) : { ok: false };
        // The origin the visitor actually used is the one the app should be told about —
        // config may know the server as 127.0.0.1 behind its tunnel.
        const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'this-server';
        const proto = req.headers['x-forwarded-proto'] ?? (config.behindTls ? 'https' : 'http');
        const html = invitePage({
            serverName: config.instanceName ?? 'a Weave server',
            origin: `${proto}://${host}`,
            code,
            valid: Boolean(result.ok),
        });
        text(200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }, { auth: 'none' });
}
