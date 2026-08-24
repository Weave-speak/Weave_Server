// Client diagnostics.
//
// The client has a "Send diagnostics" button on its update banner; until this module the
// server had nowhere for it to land, so the button was honest about failure and useless in
// practice. Reports are written to disk as single JSON files — no table, because the read
// side is an administrator with a shell (and later an admin panel), not a query.
//
// The endpoint accepts UNAUTHENTICATED posts on purpose: the moment a client most needs to
// report — its updater broke before sign-in — is exactly the moment it has no token. That
// makes this the most abusable route on the server, so it is also the most defended one:
// a hard per-address rate limit, a small size cap, and content treated as an opaque string
// that is stored and never interpreted, echoed, or executed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSession } from '../../core/auth/index.js';

/** A generous updater log; anything bigger is a file share, not a report. */
const MAX_LOG_BYTES = 256 * 1024;
const MAX_KIND = 64;

/** Sliding-window rate limit state: ip -> [timestamps]. */
const WINDOW_MS = 60 * 60 * 1000;

export function register(ctx) {
    const dir = path.join(ctx.paths.data, 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });

    ctx.settings.define('perHour', {
        type: 'number', integer: true, min: 1, max: 100,
        label: 'Reports accepted per address per hour',
        help: 'The endpoint accepts reports without sign-in, so this is its main defence.',
    }, 6);

    ctx.settings.define('keepDays', {
        type: 'number', integer: true, min: 1, max: 365,
        label: 'Keep reports for (days)',
        help: 'Old reports are deleted automatically.',
    }, 30);

    const recent = new Map();

    const allow = (ip) => {
        const now = Date.now();
        const seen = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
        if (seen.length >= ctx.settings.get('perHour')) { recent.set(ip, seen); return false; }
        seen.push(now);
        recent.set(ip, seen);
        return true;
    };

    ctx.http.route('POST', '/api/diagnostics', ({ req, body, ip, json, log }) => {
        if (!allow(ip)) {
            return json(429, { error: 'rate_limited', message: 'Too many reports from this address. Try later.' });
        }

        const kind = typeof body?.kind === 'string' ? body.kind.slice(0, MAX_KIND) : 'report';
        const logText = typeof body?.log === 'string' ? body.log : null;
        if (!logText || !logText.trim()) {
            return json(400, { error: 'empty', message: 'A report needs a log.' });
        }
        if (Buffer.byteLength(logText, 'utf8') > MAX_LOG_BYTES) {
            return json(413, { error: 'too_large', message: 'Reports are limited to 256 KB.' });
        }

        // Attribution is soft: a valid token names the account, its absence is fine. The
        // route itself is auth 'none', so this cannot lock out the client that most needs
        // it — one whose update failed before sign-in.
        const header = req.headers.authorization ?? '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        const session = bearer ? resolveSession(ctx.db.handle, bearer) : null;

        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify({
            receivedAt: new Date().toISOString(),
            kind,
            from: session ? { userId: session.userId, username: session.username } : null,
            client: {
                version: typeof body?.client?.version === 'string' ? body.client.version.slice(0, 32) : null,
                target: typeof body?.client?.target === 'string' ? body.client.target.slice(0, 32) : null,
            },
            log: logText,
        }, null, 2), { mode: 0o600 });

        log.info({ evt: 'diagnostics.received', kind, user: session?.username ?? null },
            `Diagnostics report stored (${kind}${session ? `, from ${session.username}` : ', anonymous'})`);
        json(202, { ok: true });
    }, { auth: 'none', maxBytes: MAX_LOG_BYTES + 8 * 1024 });

    // ── retention ────────────────────────────────────────────────────────────

    const sweep = () => {
        const cutoff = Date.now() - ctx.settings.get('keepDays') * 24 * 60 * 60 * 1000;
        for (const file of fs.readdirSync(dir)) {
            const full = path.join(dir, file);
            try {
                if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
            } catch { /* a report deleted underneath us is a report deleted */ }
        }
    };
    sweep();
    const timer = setInterval(sweep, 6 * 60 * 60 * 1000);
    timer.unref?.();
    ctx.onUnload(() => clearInterval(timer));
}
