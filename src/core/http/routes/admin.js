// Admin API.
//
// The console is the only browser surface this server has, and it is powerful: a generic
// table browser with edit and delete. Two rules keep that from being a liability.
//
// NOTHING SENSITIVE IS EVER SERVED. Password hashes, recovery hashes and session token
// hashes are stripped on the way out, by column name, in one place. A generic browser
// that faithfully renders every column is exactly how a database copy ends up in a
// screenshot.
//
// NOTHING SENSITIVE IS EVER WRITTEN. The same list is refused on update, so the console
// cannot be used to set a password hash directly and sidestep argon2.

import { HttpError } from '../server.js';
import { ensureDefaults } from '../../channels/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { listUsers, getUserById, setPassword, UserError } from '../../users/index.js';
import { revokeAllForUser } from '../../auth/index.js';
import { checkIntegrity, migrationStatus } from '../../../db/index.js';
import { audit as writeAudit } from '../../admin/audit.js';

/**
 * Columns never sent to a browser and never accepted from one.
 *
 * Matched by name across every table, so a new table cannot accidentally expose one by
 * being added later without anybody remembering this list exists.
 */
const SECRET_COLUMNS = new Set([
    'password_hash', 'recovery_hash', 'token_hash', 'secret_phrase', 'totp_secret',
]);

/** Tables the browser refuses to touch at all. */
const HIDDEN_TABLES = new Set(['_migrations']);

const isSecret = (name) => SECRET_COLUMNS.has(String(name).toLowerCase());

function tableNames(db) {
    return db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map((r) => r.name).filter((n) => !HIDDEN_TABLES.has(n));
}

/** Resolve a table name against the real schema. Never interpolate user input as SQL. */
function requireTable(db, name) {
    const found = tableNames(db).find((t) => t === name);
    if (!found) throw new HttpError(404, `No table named "${name}".`);
    return found;
}

function columnsOf(db, table) {
    return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
        .map((c) => ({ name: c.name, type: c.type, pk: c.pk === 1, notNull: c.notnull === 1 }));
}

const stripSecrets = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = isSecret(k) ? null : v;
    return out;
};

export function registerAdminRoutes({ router, db, config, log, moduleHost, peers, sfu, auth, ws, setup }) {
    /** Close every live socket an account holds — the server-side half of a kick. */
    const kickUser = (userId, code = 4003, reason = 'account changed') => {
        let kicked = 0;
        for (const peer of peers?.forUser?.(userId) ?? []) {
            try { peer.ws.close(code, reason); } catch { /* going anyway */ }
            kicked += 1;
        }
        return kicked;
    };
    const admin = (method, path, handler, opts = {}) =>
        router.register('core', method, path, handler, { ...opts, auth: 'admin' });

    // The shared writer, so an audit row written from the WebSocket side looks identical
    // to one written here.
    const audit = (session, action, target, detail) =>
        writeAudit(db, { actorId: session.userId, action, target, detail });

    // ── overview ─────────────────────────────────────────────────────────────
    admin('GET', '/api/admin/overview', async ({ json }) => {
        let dbBytes = 0;
        try { dbBytes = fs.statSync(config.dbPath).size; } catch { /* not yet created */ }

        const counts = Object.fromEntries(tableNames(db).map((t) => [
            t, db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t)}`).get().n,
        ]));

        json(200, {
            uptimeSeconds: Math.floor(process.uptime()),
            node: process.version,
            memoryMb: Math.round(process.memoryUsage().rss / 1048576),
            database: {
                path: config.dbPath,
                bytes: dbBytes,
                healthy: checkIntegrity(db).ok,
                migrations: migrationStatus(db),
            },
            media: {
                announcedAddress: sfu.announcedAddress,
                // "guessed" is the interesting case: it means nobody set an address and
                // the server picked one, which is the most common reason a call connects
                // and then stays silent.
                announcedSource: sfu.announcedSource,
                ports: sfu.ports,
                workers: sfu.workerCount,
                // Worst consumer score seen since boot, and how many times a receiver
                // slid into losing audible packets. Before this the server had no quality
                // signal at all, so a regression could only be found by being told.
                ...sfu.quality,
            },
            connections: {
                peers: peers.count,
                byChannel: Object.fromEntries(
                    peers.all.reduce((m, p) => m.set(p.channelId, (m.get(p.channelId) ?? 0) + 1), new Map()),
                ),
            },
            modules: moduleHost.installed,
            counts,
            exposure: config.exposure,
            behindTls: config.behindTls,
        });
    });

    // ── live connections ─────────────────────────────────────────────────────
    // The roster as the server actually sees it, which is what makes the Members view a
    // blend of stored accounts and live presence rather than a plain table dump.
    admin('GET', '/api/admin/peers', ({ json }) => {
        json(200, {
            peers: peers.all.map((p) => ({
                cid: p.cid,
                userId: p.userId,
                username: p.username,
                displayName: p.displayName,
                channelId: p.channelId,
                muted: p.muted,
                deafened: p.deafened,
                joinedAt: p.joinedAt,
                protocol: p.protocol,
                producing: [...p.producers.keys()],
                transports: [...p.transports.keys()],
            })),
        });
    });

    // ── generic table browser ────────────────────────────────────────────────
    admin('GET', '/api/admin/tables', ({ json }) => {
        json(200, {
            tables: tableNames(db).map((name) => ({
                name,
                rows: db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name)}`).get().n,
                columns: columnsOf(db, name).map((c) => ({ ...c, secret: isSecret(c.name) })),
            })),
        });
    });

    admin('GET', '/api/admin/tables/:name', ({ params, query, json }) => {
        const table = requireTable(db, params.name);
        const columns = columnsOf(db, table);

        const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
        const offset = Math.max(0, Number(query.offset) || 0);

        // Search spans every non-secret column, cast to text. Parameterised — the search
        // term never becomes SQL, only the column list does, and that came from PRAGMA.
        const search = String(query.q ?? '').trim();
        let where = '';
        const args = [];
        if (search) {
            const searchable = columns.filter((c) => !isSecret(c.name));
            where = `WHERE ${searchable.map((c) => `CAST(${JSON.stringify(c.name)} AS TEXT) LIKE ?`).join(' OR ')}`;
            for (let i = 0; i < searchable.length; i += 1) args.push(`%${search}%`);
        }

        const total = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(table)} ${where}`).get(...args).n;
        const rows = db.prepare(
            `SELECT rowid AS _rowid, * FROM ${JSON.stringify(table)} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
        ).all(...args, limit, offset);

        json(200, {
            table,
            columns: columns.map((c) => ({ ...c, secret: isSecret(c.name) })),
            rows: rows.map(stripSecrets),
            total,
            limit,
            offset,
        });
    });

    admin('PUT', '/api/admin/tables/:name/:rowid', ({ params, body, session, json }) => {
        const table = requireTable(db, params.name);
        const columns = columnsOf(db, table);

        const changes = Object.entries(body ?? {}).filter(([key]) => {
            if (isSecret(key)) {
                // Refused rather than ignored: silently dropping it would let someone
                // believe they had set a password when they had not.
                throw new HttpError(403, `"${key}" cannot be edited here. Use the proper action for it.`);
            }
            return columns.some((c) => c.name === key && !c.pk);
        });

        if (!changes.length) throw new HttpError(400, 'Nothing to change.');

        const set = changes.map(([k]) => `${JSON.stringify(k)} = ?`).join(', ');
        const result = db.prepare(`UPDATE ${JSON.stringify(table)} SET ${set} WHERE rowid = ?`)
            .run(...changes.map(([, v]) => v), Number(params.rowid));

        if (!result.changes) throw new HttpError(404, 'No such row.');

        audit(session, 'ADMIN_ROW_UPDATE', `${table}#${params.rowid}`, changes.map(([k]) => k).join(','));
        log.warn({ evt: 'admin.row_updated', table, by: session.username },
            `${session.username} edited a row in ${table}`);
        json(200, { ok: true });
    }, { maxBytes: 100_000 });

    admin('DELETE', '/api/admin/tables/:name/:rowid', ({ params, session, json }) => {
        const table = requireTable(db, params.name);
        const result = db.prepare(`DELETE FROM ${JSON.stringify(table)} WHERE rowid = ?`)
            .run(Number(params.rowid));
        if (!result.changes) throw new HttpError(404, 'No such row.');

        audit(session, 'ADMIN_ROW_DELETE', `${table}#${params.rowid}`);
        log.warn({ evt: 'admin.row_deleted', table, by: session.username },
            `${session.username} deleted a row from ${table}`);
        json(200, { ok: true });
    });

    // ── members ──────────────────────────────────────────────────────────────
    admin('GET', '/api/admin/members', ({ json }) => {
        const live = new Map(peers.all.map((p) => [p.userId, p]));
        // Who brought whom: the redemption ledger joined back to the invite's creator.
        const flags = new Map(db.prepare(
            'SELECT id, is_disabled, must_reset FROM users'
        ).all().map((r) => [r.id, { banned: r.is_disabled === 1, mustReset: r.must_reset === 1 }]));
        const sponsors = new Map(db.prepare(`
            SELECT r.user_id AS userId, u.username AS invitedBy
            FROM invite_redemptions r
            JOIN invites i ON i.code = r.code
            LEFT JOIN users u ON u.id = i.created_by
        `).all().map((row) => [row.userId, row.invitedBy]));

        json(200, {
            members: listUsers(db).map((u) => {
                const peer = live.get(u.id);
                return {
                    ...u,
                    invitedBy: sponsors.get(u.id) ?? null,
                    ...(flags.get(u.id) ?? { banned: false, mustReset: false }),
                    // Presence is live state, not a stored column, which is why this view
                    // exists separately from the raw table browser.
                    state: peer
                        ? (peer.producers.has('screen') ? 'sharing'
                            : peer.producers.has('webcam') ? 'camera'
                                : peer.deafened ? 'deafened'
                                    : peer.muted ? 'muted' : 'live')
                        : 'offline',
                    channelId: peer?.channelId ?? null,
                    cid: peer?.cid ?? null,
                };
            }),
        });
    });

    admin('POST', '/api/admin/members/:id/reset-password', async ({ params, body, session, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');

        if (body?.password) {
            // The old form: the admin chooses the password and tells the person.
            try {
                await setPassword(db, user.id, body.password);
            } catch (err) {
                if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
                throw err;
            }
        } else {
            // The graceful form: nobody — not even the admin — knows the next password.
            // The account keeps its old hash but cannot COMPLETE a sign-in until its
            // owner chooses a new password at the login screen.
            db.prepare('UPDATE users SET must_reset = 1 WHERE id = ?').run(user.id);
        }

        // Whoever knew the old password is signed out, and any LIVE connection is cut —
        // "kicked to the login screen", exactly as it should read from their side.
        const revoked = revokeAllForUser(db, user.id);
        const kicked = kickUser(user.id, 4003, 'password reset');
        audit(session, 'ADMIN_PASSWORD_RESET', user.username);
        log.warn({ evt: 'admin.password_reset', target: user.username, by: session.username, revoked, kicked },
            `${session.username} reset the password for ${user.username}`);

        json(200, { ok: true, sessionsRevoked: revoked, kicked, mustReset: !body?.password });
    }, { maxBytes: 2_000 });

    admin('POST', '/api/admin/members/:id/ban', ({ params, body, session, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');
        if (user.id === session.userId) throw new HttpError(400, 'You cannot ban yourself.');

        const banned = body?.banned !== false;
        db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(banned ? 1 : 0, user.id);
        const revoked = banned ? revokeAllForUser(db, user.id) : 0;
        const kicked = banned ? kickUser(user.id, 4004, 'banned') : 0;
        audit(session, banned ? 'ADMIN_BANNED' : 'ADMIN_UNBANNED', user.username);
        log.warn({ evt: 'admin.ban', target: user.username, by: session.username, banned },
            `${session.username} ${banned ? 'banned' : 'unbanned'} ${user.username}`);
        json(200, { ok: true, banned, sessionsRevoked: revoked, kicked });
    }, { maxBytes: 1_000 });

    admin('DELETE', '/api/admin/members/:id', ({ params, session, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');
        if (user.id === session.userId) throw new HttpError(400, 'You cannot remove your own account from here.');

        revokeAllForUser(db, user.id);
        kickUser(user.id, 4004, 'account removed');
        const wipeOne = db.transaction(() => {
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
            db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(user.id);
            db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        });
        wipeOne();
        audit(session, 'ADMIN_REMOVED_USER', user.username);
        log.warn({ evt: 'admin.user_removed', target: user.username, by: session.username },
            `${session.username} removed the account ${user.username}`);
        json(200, { ok: true });
    });

    admin('PUT', '/api/admin/members/:id', ({ params, body, session, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');
        const displayName = String(body?.displayName ?? '').trim();
        if (!displayName || displayName.length > 40) {
            throw new HttpError(400, 'A display name is 1 to 40 characters.');
        }
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
        audit(session, 'ADMIN_RENAMED_USER', `${user.username} -> ${displayName}`);
        json(200, { ok: true });
    }, { maxBytes: 1_000 });

    admin('POST', '/api/admin/members/:id/admin', ({ params, body, session, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');

        const makeAdmin = body?.isAdmin === true;
        if (!makeAdmin && user.id === session.userId) {
            // Removing your own last route back in is the classic way to lock yourself
            // out of your own server.
            throw new HttpError(400, 'You cannot remove your own administrator access.');
        }

        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, user.id);
        audit(session, makeAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED', user.username);
        json(200, { ok: true });
    }, { maxBytes: 1_000 });

    // ── audit log ────────────────────────────────────────────────────────────
    admin('GET', '/api/admin/audit', ({ query, json }) => {
        const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
        json(200, {
            entries: db.prepare(`
                SELECT a.id, a.at, a.action, a.target, a.detail, u.username AS actor
                FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                ORDER BY a.id DESC LIMIT ?
            `).all(limit),
        });
    });

    // ── logs ─────────────────────────────────────────────────────────────────
    admin('GET', '/api/admin/logs', ({ query, json }) => {
        const lines = Math.min(2000, Math.max(1, Number(query.lines) || 300));
        const files = fs.existsSync(config.logDir)
            ? fs.readdirSync(config.logDir).filter((f) => f.startsWith('weave.log')).sort().reverse()
            : [];

        if (!files.length) return json(200, { entries: [], note: 'No log files yet.' });

        const file = path.join(config.logDir, files[0]);
        const { size } = fs.statSync(file);

        // Read a window from the END rather than the whole file. The previous server
        // loaded a 5 MB log into memory to take a 256 KB tail, every time.
        const window = Math.min(size, 512 * 1024);
        const buffer = Buffer.alloc(window);
        const fd = fs.openSync(file, 'r');
        try {
            fs.readSync(fd, buffer, 0, window, size - window);
        } finally {
            fs.closeSync(fd);
        }

        const entries = buffer.toString('utf8')
            .split('\n')
            // A partial first line is expected when reading from an offset.
            .slice(1)
            .filter(Boolean)
            .slice(-lines)
            .map((line) => { try { return JSON.parse(line); } catch { return { msg: line }; } });

        json(200, { entries, file: files[0], truncated: size > window });
    });

    // ── settings ─────────────────────────────────────────────────────────────
    admin('POST', '/api/admin/wipe', ({ body, session, json }) => {
        // The one confirmation the SERVER checks: the instance's exact name. The client
        // adds its own dialog and puzzle on top; this is the part that cannot be bypassed
        // by calling the API directly.
        if (String(body?.confirm ?? '') !== String(config.instanceName)) {
            throw new HttpError(400, 'Type the exact server name to confirm.');
        }

        log.warn({ evt: 'admin.WIPE', by: session.username },
            `${session.username} destroyed all data on "${config.instanceName}"`);

        // Answer first: the requester's own session is among the casualties.
        json(200, { ok: true, message: 'Everything is gone. The server is back at first run.' });

        setImmediate(() => {
            // Every live connection is cut before the ground vanishes beneath it.
            for (const peer of peers.all) {
                try { peer.ws.close(4005, 'server wiped'); }
                catch { /* going regardless */ }
            }

            // The migration ledger survives: schemas still exist after DELETE, so wiping
            // the ledger would make the next boot re-run CREATE TABLE into live tables.
            const tables = db.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).all().map((t) => t.name).filter((t) => t !== '_migrations');
            const razeAll = db.transaction(() => {
                for (const t of tables) db.prepare(`DELETE FROM "${t}"`).run();
            });
            razeAll();

            // The server remains, and it remembers how to be born: default channels
            // reseed and first-run setup re-arms with a fresh token in the journal.
            try { ensureDefaults(db, log); } catch { /* seeded on next boot instead */ }
            try {
                setup?.begin({
                    httpPort: config.httpPort,
                    httpBind: config.httpBind,
                    instanceName: config.instanceName,
                    version: '(after wipe)',
                });
            } catch { /* a restart re-arms it regardless */ }
        });
    }, { maxBytes: 1_000 });

    admin('GET', '/api/admin/settings', ({ json }) => {
        json(200, { groups: moduleHost.settingsView() });
    });

    admin('PUT', '/api/admin/settings', ({ body, session, json }) => {
        const changed = [];
        for (const [key, value] of Object.entries(body ?? {})) {
            moduleHost.setSetting(key, value);
            changed.push(key);
        }
        audit(session, 'ADMIN_SETTINGS', null, changed.join(','));
        json(200, { ok: true, changed });
    }, { maxBytes: 20_000 });
}
