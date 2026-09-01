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
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

    ctx.settings.define('signedInPerHour', {
        type: 'number', integer: true, min: 1, max: 100000,
        label: 'Reports accepted per signed-in account per hour',
        help: 'A tester reports a MOMENT, not a whole stream, and even a slight lag is worth '
            + 'recording — so this is deliberately high, a runaway-loop backstop rather than a '
            + 'quota. The strict per-address limit above governs anonymous posts only.',
    }, 600);

    // A coarse snapshot of how hard the machine is working at the instant a report lands.
    // This is the "is it the Pi?" half of the answer a stream report cannot get from either
    // endpoint: a report that says the picture froze, arriving while load-per-core is over 1
    // or the event loop is lagging, points at the box rather than at either connection.
    //
    // os.loadavg() counts EVERY process, so it sees the mediasoup worker's core even though
    // this process cannot (the worker is a separate child process, invisible to
    // process.cpuUsage here). eventLoopLagMs is this process's OWN saturation — signalling
    // and HTTP — which is a different bottleneck, and telling the two apart is the point:
    // one is the media core, the other is everything else the Pi does on the same chip.
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    ctx.onUnload(() => lag.disable());

    const vitals = () => {
        const cpus = Math.max(1, os.cpus().length);
        const [load1, load5, load15] = os.loadavg();
        return {
            at: new Date().toISOString(),
            uptimeS: Math.floor(process.uptime()),
            cpus,
            loadavg: [load1, load5, load15].map((n) => Math.round(n * 100) / 100),
            loadPerCore: Math.round((load1 / cpus) * 100) / 100,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
            memFreeMb: Math.round(os.freemem() / 1048576),
            memTotalMb: Math.round(os.totalmem() / 1048576),
            eventLoopLagMs: Number.isFinite(lag.mean) ? Math.round((lag.mean / 1e6) * 100) / 100 : null,
        };
    };

    // Two windows, because WHO is reporting decides how freely they may. Anonymous posts stay
    // on the strict per-ADDRESS limit — that is the abusable case. A signed-in tester, marking
    // a moment rather than a whole stream, is exactly who this endpoint is for now, so they get
    // a per-ACCOUNT window set high enough never to lose a real report.
    const recent = new Map();       // ip -> timestamps (anonymous)
    const recentAuth = new Map();   // userId -> timestamps (signed in)

    const allow = (map, key, limit) => {
        const now = Date.now();
        const seen = (map.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
        if (seen.length >= limit) { map.set(key, seen); return false; }
        seen.push(now);
        map.set(key, seen);
        return true;
    };

    ctx.http.route('POST', '/api/diagnostics', ({ req, body, ip, json, log }) => {
        // Attribution is soft: a valid token names the account, its absence is fine. The route
        // itself is auth 'none', so this cannot lock out the client that most needs it — one
        // whose update failed before sign-in. It is resolved FIRST because it also chooses the
        // rate limit: a signed-in tester is trusted to report often, an anonymous poster is not.
        const header = req.headers.authorization ?? '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        const session = bearer ? resolveSession(ctx.db.handle, bearer) : null;

        const permitted = session
            ? allow(recentAuth, session.userId, ctx.settings.get('signedInPerHour'))
            : allow(recent, ip, ctx.settings.get('perHour'));
        if (!permitted) {
            return json(429, { error: 'rate_limited', message: 'Too many reports just now. Try again shortly.' });
        }

        const kind = typeof body?.kind === 'string' ? body.kind.slice(0, MAX_KIND) : 'report';
        const logText = typeof body?.log === 'string' ? body.log : null;
        if (!logText || !logText.trim()) {
            return json(400, { error: 'empty', message: 'A report needs a log.' });
        }
        if (Buffer.byteLength(logText, 'utf8') > MAX_LOG_BYTES) {
            return json(413, { error: 'too_large', message: 'Reports are limited to 256 KB.' });
        }

        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify({
            receivedAt: new Date().toISOString(),
            kind,
            from: session ? { userId: session.userId, username: session.username } : null,
            client: {
                version: typeof body?.client?.version === 'string' ? body.client.version.slice(0, 32) : null,
                target: typeof body?.client?.target === 'string' ? body.client.target.slice(0, 32) : null,
            },
            // The machine's own load at receipt — added by the server, not the client, because
            // it is the one thing neither endpoint of a call can measure about the box between
            // them. See vitals() above.
            server: vitals(),
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
