// Sessions and request authentication.
//
// Two kinds of session share one table:
//
//   'client' — a Bearer token used by the app (native or browser). Sent in the
//              Authorization header and, for the WebSocket, in the join message,
//              because browsers cannot set headers on a WebSocket handshake.
//   'admin'  — a cookie used by the browser admin panel. HttpOnly and SameSite=Strict
//              so it cannot be read by script or sent cross-site.
//
// Tokens are stored HASHED. The database holds sha256(token), never the token, so a
// copy of weave.db does not hand someone a set of live sessions.

import crypto from 'node:crypto';
import { HttpError } from '../http/server.js';
import { EXPOSURE } from '../config/index.js';

/** Sliding window. An actively used session never lapses; only real inactivity does. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RENEW_BELOW_MS = SESSION_TTL_MS / 2;

export const ADMIN_COOKIE = 'weave_admin';

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const newToken = () => crypto.randomBytes(32).toString('base64url');

export function issueSession(db, userId, kind = 'client', userAgent = null) {
    const token = newToken();
    db.prepare(`
        INSERT INTO sessions (id, token_hash, user_id, kind, expires_at, last_used_at, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        crypto.randomUUID(), hashToken(token), userId, kind,
        Date.now() + SESSION_TTL_MS, Date.now(), userAgent,
    );
    return token;
}

export function revokeSession(db, token) {
    return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes > 0;
}

export function revokeAllForUser(db, userId) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/**
 * Every session this account holds EXCEPT the one asking.
 *
 * What somebody means by changing their own password: whoever else knew the old one is
 * signed out, and the device they are typing on is not. Keyed by the token's hash rather
 * than the token, because that is what a resolved session carries and what the table
 * stores — the secret itself is never needed to say "not this row".
 */
export function revokeAllForUserExcept(db, userId, tokenHash) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(userId, tokenHash ?? '').changes;
}

/**
 * An account's live sessions, newest first.
 *
 * Never the token and never its hash: the id exists so that this list can be shown at all.
 * Expired rows are left out rather than shown as dead entries — a session that cannot be
 * used is not a device somebody needs to sign out.
 */
export function listSessionsForUser(db, userId) {
    return db.prepare(`
        SELECT id, kind, created_at AS createdAt, last_used_at AS lastUsedAt,
               expires_at AS expiresAt, user_agent AS userAgent
        FROM sessions
        WHERE user_id = ? AND expires_at > ?
        ORDER BY last_used_at DESC, created_at DESC
    `).all(userId, Date.now());
}

/**
 * Revoke ONE session, by id, belonging to one account.
 *
 * The account is part of the WHERE rather than something the caller is trusted to have
 * checked. An id that belongs to somebody else matches no row, which is the same answer as
 * an id that never existed — so this cannot be used to find out whose id it is either.
 */
export function revokeSessionById(db, userId, id) {
    if (!id || typeof id !== 'string') return false;
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?')
        .run(userId, id).changes > 0;
}

/**
 * How stale "last active" is allowed to get.
 *
 * The expiry slide below only writes once a session is half spent, so without this the
 * figure could be six hours old — and "last active" being a lie is worse than not showing
 * it, because the whole point is deciding whether a device you half-remember is still in
 * use. A write every few minutes per session is nothing; a write per REQUEST is the shape
 * that silently logged out all-day users on the old server, so it is deliberately not that.
 */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

/**
 * Look up a session and slide its expiry.
 *
 * The rewrite only happens once the session drops below half its life, so an active
 * client does not cause a SQLite write on every single request — the old server's
 * equivalent check fired on a heartbeat and was the reason all-day users were silently
 * logged out, so it is worth getting right in both directions.
 */
export function resolveSession(db, token) {
    if (!token) return null;

    const row = db.prepare(`
        SELECT s.id, s.token_hash, s.user_id, s.kind, s.expires_at, s.last_used_at,
               u.username, u.display_name, u.avatar, u.status, u.is_admin, u.is_tester, u.is_disabled
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
    `).get(hashToken(token));

    if (!row) return null;

    if (row.expires_at < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
        return null;
    }
    if (row.is_disabled) return null;

    if (row.expires_at - Date.now() < RENEW_BELOW_MS) {
        db.prepare('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?')
            .run(Date.now() + SESSION_TTL_MS, Date.now(), row.token_hash);
    } else if (Date.now() - (row.last_used_at ?? 0) > TOUCH_AFTER_MS) {
        db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
            .run(Date.now(), row.token_hash);
    }

    return {
        userId: row.user_id,
        kind: row.kind,
        // The opaque id, so a request can be told which of the account's sessions it IS —
        // which is how the device list marks "this device" and refuses to sign it out from
        // under itself.
        sessionId: row.id,
        // The HASH, never the token. It is what lets a route revoke every OTHER session
        // without being handed the caller's bearer secret to compare against.
        tokenHash: row.token_hash,
        username: row.username,
        displayName: row.display_name,
        avatar: row.avatar,
        status: row.status,
        isAdmin: row.is_admin === 1,
        isTester: row.is_tester === 1,
    };
}

export function purgeExpiredSessions(db) {
    return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

/** Cookie flags for the admin session, given how the server is exposed. */
export function adminCookie(token, config, { clear = false } = {}) {
    const parts = [
        `${ADMIN_COOKIE}=${clear ? '' : token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    // Secure on a plain-HTTP LAN server would mean the browser silently never sends the
    // cookie, i.e. an admin panel that cannot log in and gives no clue why. Config
    // refuses public-without-TLS outright, so omitting it here is bounded to LAN and
    // loopback rather than being a general downgrade.
    if (config.behindTls || config.exposure === EXPOSURE.PUBLIC) parts.push('Secure');
    return parts.join('; ');
}

export function createAuth({ db, config, log }) {
    return {
        /**
         * Resolve a request's session and enforce the route's requirement.
         * `level`: 'none' | 'user' | 'admin'.
         */
        async resolve(req, level) {
            if (level === 'none') return null;

            const header = req.headers.authorization ?? '';
            const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
            const cookie = parseCookies(req.headers.cookie)[ADMIN_COOKIE] ?? null;

            const session = resolveSession(db, bearer ?? cookie);

            if (!session) {
                throw new HttpError(401, 'Sign in to continue.');
            }
            if (level === 'admin' && !session.isAdmin) {
                log.warn({ evt: 'auth.denied', user: session.username },
                    `Non-admin ${session.username} attempted an admin route`);
                throw new HttpError(403, 'This action requires an administrator account.');
            }
            return session;
        },

        issue: (userId, kind, userAgent) => issueSession(db, userId, kind, userAgent),
        revoke: (token) => revokeSession(db, token),
        revokeOthers: (userId, tokenHash) => revokeAllForUserExcept(db, userId, tokenHash),
        sessionsFor: (userId) => listSessionsForUser(db, userId),
        revokeById: (userId, id) => revokeSessionById(db, userId, id),
        resolveToken: (token) => resolveSession(db, token),
        cookieFor: (token, opts) => adminCookie(token, config, opts),
    };
}
