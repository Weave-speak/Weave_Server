// Push: reaching a device whose app is not running.
//
// A ring that only travels over an open socket rings nobody whose phone has put Weave to
// sleep, which on Android is everybody within minutes. Web Push is the way out that needs
// no Google account and no vendor key: the phone's distributor (ntfy, for UnifiedPush)
// hands the app an https endpoint, the app gives it to us, and we POST an encrypted
// message there. The distributor cannot read it; only the app holds the key.
//
// In core rather than a module because modules may not import each other, and both the
// calls in `dm` and the huddle ring in `private-channels` need it. Modules reach it as
// `ctx.push.toUser`, and nothing else: they never see an endpoint or a key.
//
// Subscriptions belong to a SESSION, not to an account, and the table says so with a
// foreign key. Signing out, being signed out from another device, an administrator's
// sign-out-everywhere and plain expiry all delete the session row, and the subscription
// goes with it — so a phone that was signed out never rings again, with no code here
// remembering to make it so.

import crypto from 'node:crypto';
import net from 'node:net';
import { EXPOSURE } from '../config/index.js';
import { buildPushRequest, fromB64u, generateVapidKeys, isP256PublicKey } from './webpush.js';
import { PUSH_SESSION_TTL_MS, SESSION_LIVE_SQL, setSessionIdleTtl } from '../auth/index.js';

export class PushError extends Error {}

const ENDPOINT_MAX = 2048;
/** Sessions are cheap to make; deliveries per ring should not grow with them. */
const MAX_PER_USER = 10;
/** A ring is worth nothing late, and a slow push service must not pile up deliveries. */
const SEND_TIMEOUT_MS = 5_000;

/** An IP literal (no brackets) in loopback, private, shared, link-local or unspecified space. */
function isPrivateLiteral(host) {
    const family = net.isIP(host);
    if (family === 4) {
        const [a, b] = host.split('.').map(Number);
        return a === 0 || a === 10 || a === 127
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127);
    }
    if (family === 6) {
        const h = host.toLowerCase();
        // Mapped IPv4 is refused outright: the URL parser rewrites it to hex, and no push
        // service is reached that way.
        return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
    }
    return false;
}

/**
 * Whether the server may POST to `url` as a push endpoint.
 *
 * Accepting an endpoint is agreeing to POST to it later, on somebody else's call. https
 * always: plain http would put the ring and the VAPID token on the wire in clear, and every
 * distributor speaks https. On a PUBLIC server, no loopback or private address literals
 * either — there a member's "endpoint" on 10.0.0.1 can only be a way to make the server
 * poke its own network. A LAN or loopback server is different: a member's own ntfy sitting
 * beside it on the LAN is the ordinary case. This is not a full SSRF fence — a hostname
 * can resolve anywhere — but it closes the cheap door.
 */
export function endpointAllowed(url, exposure) {
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (exposure === EXPOSURE.PUBLIC) {
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (host === 'localhost' || host.endsWith('.localhost') || isPrivateLiteral(host)) return false;
    }
    return true;
}

/**
 * The subscription a client sent, checked and normalised, or a PushError saying why not.
 *
 * Shaped like the browser's PushSubscription JSON (`{ endpoint, keys: { p256dh, auth } }`),
 * which is also what a UnifiedPush connector hands an app, so neither side has to
 * translate.
 */
export function cleanSubscription(body, { exposure } = {}) {
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint || endpoint.length > ENDPOINT_MAX) throw new PushError('A push endpoint URL is required.');
    let url;
    try { url = new URL(endpoint); } catch { throw new PushError('The push endpoint is not a URL.'); }
    // Plain http would put the ring, and the VAPID token, on the wire in clear; every push
    // service and every distributor speaks https.
    if (url.protocol !== 'https:') throw new PushError('Push endpoints must use https.');
    if (url.username || url.password) throw new PushError('Push endpoints may not carry credentials.');
    if (!endpointAllowed(url, exposure)) throw new PushError('That push endpoint is not reachable from this server.');

    const p256dh = fromB64u(body?.keys?.p256dh);
    if (!isP256PublicKey(p256dh)) throw new PushError('keys.p256dh must be an uncompressed P-256 public key.');
    const auth = fromB64u(body?.keys?.auth);
    if (!auth || auth.length !== 16) throw new PushError('keys.auth must be 16 bytes.');

    return { endpoint: url.href, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
}

/** The server's VAPID key pair: made once, on the first start that needs it, then kept. */
function loadVapid(db) {
    const read = () => db.prepare('SELECT public_key AS publicKey, private_key AS privateKey FROM push_vapid WHERE id = 1').get();
    const existing = read();
    if (existing) return existing;
    const keys = generateVapidKeys();
    // OR IGNORE: if two processes ever raced here, the first key wins and both use it.
    db.prepare('INSERT OR IGNORE INTO push_vapid (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
        .run(keys.publicKey, keys.privateKey, Date.now());
    return read();
}

/**
 * The push service.
 *
 * `subject` is the VAPID contact (see webpush.js); `fetch` is injectable so tests can
 * stand in for a push service. Payloads are never logged — they carry who is calling whom
 * — and endpoints are logged by origin only, because the path is the device's secret.
 */
export function createPush({
    db, log, fetch = globalThis.fetch, subject = null, exposure = EXPOSURE.LOOPBACK, timeoutMs = SEND_TIMEOUT_MS,
}) {
    const plog = log.child?.({ mod: 'push' }) ?? log;
    const vapid = loadVapid(db);
    // Shutdown aborts whatever is still in flight, so a slow push service cannot hold the
    // process open past the stop watchdog.
    const stopping = new AbortController();

    const q = {
        forSession: db.prepare('SELECT endpoint FROM push_subscriptions WHERE session_hash = ?'),
        // Only sessions still live, of accounts not disabled: a row whose session lapsed but
        // was not yet purged must not ring anybody.
        forUser: db.prepare(`
            SELECT p.id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p
            JOIN sessions s ON s.token_hash = p.session_hash
            JOIN users u ON u.id = p.user_id
            WHERE p.user_id = @userId AND u.is_disabled = 0 AND ${SESSION_LIVE_SQL}`),
        dropEndpointOrSession: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? OR session_hash = ?'),
        insert: db.prepare(`
            INSERT INTO push_subscriptions (id, session_hash, user_id, endpoint, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`),
        // The row just written is excluded by id rather than trusted to sort first: rows
        // made in the same millisecond tie, and a tie must not evict the device asking.
        overflow: db.prepare(`
            DELETE FROM push_subscriptions WHERE id IN (
                SELECT id FROM push_subscriptions WHERE user_id = ? AND id != ?
                ORDER BY COALESCE(last_ok_at, created_at) DESC, rowid DESC LIMIT -1 OFFSET ?)`),
        dropSession: db.prepare('DELETE FROM push_subscriptions WHERE session_hash = ?'),
        drop: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
        ok: db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?'),
    };

    /**
     * Store `body` as this session's subscription, replacing whatever it had.
     *
     * One per session, because one session is one signed-in app on one device. An
     * endpoint already stored under ANOTHER session moves here: that is the same phone
     * signing in again, and leaving the old row would ring it twice until the old session
     * expired.
     */
    const subscribe = (session, body) => {
        const sub = cleanSubscription(body, { exposure });
        const before = q.forSession.get(session.tokenHash)?.endpoint ?? null;
        const id = crypto.randomUUID();
        db.transaction(() => {
            q.dropEndpointOrSession.run(sub.endpoint, session.tokenHash);
            q.insert.run(id, session.tokenHash, session.userId, sub.endpoint, sub.p256dh, sub.auth, Date.now());
            q.overflow.run(session.userId, id, MAX_PER_USER - 1);
            setSessionIdleTtl(db, session.tokenHash, PUSH_SESSION_TTL_MS);
        })();
        return { changed: before !== sub.endpoint };
    };

    const unsubscribe = (session) => {
        const removed = q.dropSession.run(session.tokenHash).changes > 0;
        setSessionIdleTtl(db, session.tokenHash, null);
        return removed;
    };

    const deliver = async (sub, payload, opts) => {
        const origin = (() => { try { return new URL(sub.endpoint).origin; } catch { return '?'; } })();
        try {
            const request = buildPushRequest({ subscription: sub, payload, vapid: { ...vapid, subject }, ...opts });
            const res = await fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                // A push service answers; it does not redirect. Following one would let a
                // stored endpoint bounce the POST to a host the check above never saw.
                redirect: 'manual',
                signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopping.signal]),
            });
            res.body?.cancel?.().catch?.(() => {});
            if (res.status >= 200 && res.status < 300) {
                q.ok.run(Date.now(), sub.id);
                plog.debug({ evt: 'push.sent', origin, status: res.status }, `Push delivered to ${origin}`);
                return 'sent';
            }
            // 404 and 410 are the push service saying this subscription is over (RFC 8030
            // §7.3): the app was uninstalled or the distributor dropped it. Keeping it
            // would only post into the void on every call.
            if (res.status === 404 || res.status === 410) {
                q.drop.run(sub.id);
                plog.info({ evt: 'push.gone', origin, status: res.status }, `Push subscription at ${origin} has ended; removed`);
                return 'gone';
            }
            plog.warn({ evt: 'push.failed', origin, status: res.status }, `Push to ${origin} was refused (${res.status})`);
            return 'failed';
        } catch (err) {
            if (stopping.signal.aborted) return 'failed';
            // The cause, not the error: Node's fetch error messages can carry the URL.
            plog.warn({ evt: 'push.failed', origin, code: err?.cause?.code ?? err?.name },
                `Push to ${origin} did not go through (${err?.cause?.code ?? err?.name})`);
            return 'failed';
        }
    };

    /**
     * Send `payload` to every device `userId` has subscribed. Never rejects: a caller
     * ringing somebody must not have its call fail because a phone is unreachable.
     *
     * `ttl` is how long the push service may hold the message for a device that is
     * offline (seconds); `urgency` is RFC 8030's, and 'high' is what lets a sleeping
     * Android phone wake for it; `topic` collapses a held message into its successor.
     */
    const toUser = async (userId, payload, { ttl = 60, urgency = 'normal', topic } = {}) => {
        const tally = { sent: 0, gone: 0, failed: 0 };
        let subs;
        try { subs = q.forUser.all({ userId, now: Date.now() }); } catch { return tally; }
        const outcomes = await Promise.all(subs.map((sub) => deliver(sub, payload, { ttl, urgency, topic })));
        for (const outcome of outcomes) tally[outcome] += 1;
        return tally;
    };

    return {
        publicKey: vapid.publicKey,
        subscribe,
        unsubscribe,
        toUser,
        stop: () => stopping.abort(),
    };
}
