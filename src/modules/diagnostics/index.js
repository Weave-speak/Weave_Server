// Client diagnostics.
//
// The client has a "Send diagnostics" button on its update banner and a Report a Bug
// screen; until this module the server had nowhere for either to land, so both were honest
// about failure and useless in practice. Reports are written to disk as single JSON files —
// no table, because a report is one blob read whole by one administrator, which is a file,
// not a query. The read side is an admin panel over the same files.
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
import { tailLog } from '../../core/log/tail.js';

/** A generous updater log; anything bigger is a file share, not a report. */
const MAX_LOG_BYTES = 256 * 1024;
const MAX_KIND = 64;

/** What somebody types about what went wrong. Long enough for the real story, no longer. */
const MAX_DESCRIPTION = 4_000;

/** Only a filename this module minted, so a name can never walk out of the directory. */
const REPORT_NAME = /^[0-9TZ-]+-[0-9a-f]{8}\.json$/;

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

    ctx.settings.define('serverLogLines', {
        type: 'number', integer: true, min: 0, max: 2000,
        label: 'Lines of server log attached to a bug report',
        help: 'A bug report describes a moment. Attaching what the SERVER was doing then means '
            + 'an administrator reads one file instead of correlating two by timestamp. Zero '
            + 'switches it off; it is never attached to any other kind of report.',
    }, 300);

    // One window, per ADDRESS, for every report. Reports are rare — a bug somebody bothered to
    // describe, an update that failed — so the same limit serves signed-in and anonymous
    // posters alike, and the anonymous case is the one it exists to hold back.
    const recent = new Map();       // ip -> timestamps

    const allow = (key, limit) => {
        const now = Date.now();
        const seen = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
        if (seen.length >= limit) { recent.set(key, seen); return false; }
        seen.push(now);
        recent.set(key, seen);
        return true;
    };

    ctx.http.route('POST', '/api/diagnostics', ({ req, body, ip, json, log }) => {
        if (!allow(ip, ctx.settings.get('perHour'))) {
            return json(429, { error: 'rate_limited', message: 'Too many reports just now. Try again shortly.' });
        }

        // Attribution is soft: a valid token names the account, its absence is fine. The route
        // itself is auth 'none', so this cannot lock out the client that most needs it — one
        // whose update failed before sign-in.
        const header = req.headers.authorization ?? '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        const session = bearer ? resolveSession(ctx.db.handle, bearer) : null;

        const kind = typeof body?.kind === 'string' ? body.kind.slice(0, MAX_KIND) : 'report';
        const logText = typeof body?.log === 'string' ? body.log : null;
        // What the person actually said. A bug report is mostly this — the log is corroboration
        // — so unlike every other kind, it may arrive with no log at all: a browser has no log
        // file to offer, and refusing the report would lose the only part that matters.
        const description = typeof body?.description === 'string'
            ? body.description.trim().slice(0, MAX_DESCRIPTION)
            : null;

        if (!logText?.trim() && !description) {
            return json(400, { error: 'empty', message: 'A report needs a log or a description.' });
        }
        if (logText && Buffer.byteLength(logText, 'utf8') > MAX_LOG_BYTES) {
            return json(413, { error: 'too_large', message: 'Reports are limited to 256 KB.' });
        }

        // Both sides of the moment, in one file. Only for a bug report: an update failure
        // happened on the client's machine and has nothing to do with what the server was
        // doing at the time.
        const serverLines = kind === 'bug' ? ctx.settings.get('serverLogLines') : 0;
        const serverLog = serverLines > 0 ? tailLog(ctx.paths.logs, serverLines).entries : null;

        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify({
            receivedAt: new Date().toISOString(),
            kind,
            from: session ? { userId: session.userId, username: session.username } : null,
            client: {
                version: typeof body?.client?.version === 'string' ? body.client.version.slice(0, 32) : null,
                target: typeof body?.client?.target === 'string' ? body.client.target.slice(0, 32) : null,
            },
            ...(description ? { description } : {}),
            ...(serverLog?.length ? { serverLog } : {}),
            log: logText,
        }, null, 2), { mode: 0o600 });

        log.info({ evt: 'diagnostics.received', kind, user: session?.username ?? null },
            `Diagnostics report stored (${kind}${session ? `, from ${session.username}` : ', anonymous'})`);
        json(202, { ok: true });
    }, { auth: 'none', maxBytes: MAX_LOG_BYTES + 8 * 1024 });


    // ── reading them ─────────────────────────────────────────────────────────
    //
    // Until now a report was only readable by somebody with a shell on the box, which for a
    // self-hosted app is a real person with real reasons not to have one open. The store is
    // still files; these two routes are a window onto it, not a second copy of it.

    /** One line per report, newest first — enough to decide which one to open. */
    const summarise = (name) => {
        try {
            const report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            return {
                name,
                receivedAt: report.receivedAt ?? null,
                kind: report.kind ?? 'report',
                from: report.from?.username ?? null,
                client: report.client ?? null,
                // The first line of what they said, which is what makes a list of reports
                // scannable rather than a list of timestamps.
                description: report.description ? String(report.description).slice(0, 200) : null,
                bytes: fs.statSync(path.join(dir, name)).size,
            };
        } catch {
            // A half-written or hand-edited file is still worth listing, because it is still
            // sitting on the disk taking up space and somebody may want to know why.
            return { name, receivedAt: null, kind: 'unreadable', from: null, description: null, bytes: 0 };
        }
    };

    ctx.http.route('GET', '/api/admin/diagnostics', ({ query, json }) => {
        const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
        const names = fs.readdirSync(dir).filter((f) => REPORT_NAME.test(f)).sort().reverse();
        json(200, {
            reports: names.slice(0, limit).map(summarise),
            total: names.length,
        });
    }, { auth: 'admin' });

    ctx.http.route('GET', '/api/admin/diagnostics/:name', ({ params, json }) => {
        // The name is checked against the shape this module mints rather than sanitised.
        // Sanitising a path is a game of finding every escape; refusing anything that is not
        // already one of ours is a game with one move.
        if (!REPORT_NAME.test(params.name ?? '')) {
            return json(404, { error: 'not_found', message: 'No such report.' });
        }
        const full = path.join(dir, params.name);
        if (!fs.existsSync(full)) {
            return json(404, { error: 'not_found', message: 'No such report.' });
        }
        try {
            json(200, { report: JSON.parse(fs.readFileSync(full, 'utf8')) });
        } catch {
            // Hand the bytes over rather than the parse error: whatever is in there is what
            // the administrator wanted to see.
            json(200, { report: { name: params.name, raw: fs.readFileSync(full, 'utf8') } });
        }
    }, { auth: 'admin' });

    ctx.http.route('DELETE', '/api/admin/diagnostics/:name', ({ params, json, log }) => {
        if (!REPORT_NAME.test(params.name ?? '')) {
            return json(404, { error: 'not_found', message: 'No such report.' });
        }
        try {
            fs.unlinkSync(path.join(dir, params.name));
        } catch {
            return json(404, { error: 'not_found', message: 'No such report.' });
        }
        log.info({ evt: 'diagnostics.deleted', report: params.name }, 'A diagnostics report was deleted');
        json(200, { ok: true });
    }, { auth: 'admin' });

    ctx.admin.panel({ id: 'diagnostics', label: 'Bug reports', order: 60 });

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
