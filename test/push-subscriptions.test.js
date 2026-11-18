// Push subscriptions: storage, the routes, delivery, and the cascade.
//
// Real HTTP and a real database, but no media server: the routes are mounted on the real
// router and front door with the real session auth, which is everything they touch. The
// push service at the far end is a stand-in `fetch`, so delivery is checked down to the
// headers without anything leaving the machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { migrateCore } from '../src/db/index.js';
import { Router } from '../src/core/http/router.js';
import { createHttpServer } from '../src/core/http/server.js';
import { registerPushRoutes } from '../src/core/http/routes/push.js';
import {
    createAuth, issueSession, revokeSession, revokeAllForUser, purgeExpiredSessions, resolveSession,
    SESSION_TTL_MS, PUSH_SESSION_TTL_MS,
} from '../src/core/auth/index.js';
import { createPush, cleanSubscription, endpointAllowed, PushError } from '../src/core/push/index.js';
import { fromB64u, toB64u, deriveContentKeys } from '../src/core/push/webpush.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

/** A device: a real P-256 key pair and auth secret, so a delivered message can be opened. */
function device(endpoint) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return {
        endpoint,
        keys: { p256dh: toB64u(ecdh.getPublicKey()), auth: toB64u(auth) },
        open(body) {
            const asPublic = body.subarray(21, 86);
            const { cek, nonce } = deriveContentKeys({
                ecdhSecret: ecdh.computeSecret(asPublic), authSecret: auth,
                uaPublic: ecdh.getPublicKey(), asPublic, salt: body.subarray(0, 16),
            });
            const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
            d.setAuthTag(body.subarray(body.length - 16));
            const plain = Buffer.concat([d.update(body.subarray(86, body.length - 16)), d.final()]);
            return JSON.parse(plain.subarray(0, -1).toString('utf8'));
        },
    };
}

function harness({ status = () => 201, exposure = 'public' } = {}) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateCore(db, quiet);
    const addUser = db.prepare(`INSERT INTO users (id, username, username_lower, display_name, password_hash)
                                VALUES (?, ?, ?, ?, 'not-a-real-hash')`);
    addUser.run('u-kes', 'kes', 'kes', 'Kes');
    addUser.run('u-moth', 'moth', 'moth', 'Moth');

    const posted = [];
    const fetch = async (url, init) => {
        posted.push({ url, ...init });
        const code = status(url);
        if (code instanceof Error) throw code;
        return new Response(null, { status: code });
    };
    const push = createPush({ db, log: quiet, fetch, subject: 'https://weave.example.com', exposure });
    const rows = () => db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all();
    return { db, push, posted, rows };
}

async function serve(h, { push = h.push } = {}) {
    const config = { trustedProxies: [], redactIps: true };
    const router = new Router(quiet);
    registerPushRoutes({ router, push, log: quiet });
    const server = createHttpServer({ config, log: quiet, router, auth: createAuth({ db: h.db, config, log: quiet }) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, { token, body } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { call, close: () => new Promise((r) => server.close(r)) };
}

test('the VAPID key is made once and kept: a restart signs with the same key', () => {
    const h = harness();
    const again = createPush({ db: h.db, log: quiet, fetch: async () => new Response(null, { status: 201 }) });
    assert.equal(again.publicKey, h.push.publicKey);
    assert.equal(fromB64u(h.push.publicKey).length, 65);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM push_vapid').get().n, 1);
});

test('routes: key, subscribe, replace, unsubscribe — always the calling session', async (t) => {
    const h = harness();
    const s = await serve(h);
    t.after(() => s.close());
    const token = issueSession(h.db, 'u-kes');

    assert.equal((await s.call('GET', '/api/push/key')).status, 401, 'sign-in first');
    const key = await s.call('GET', '/api/push/key', { token });
    assert.equal(key.status, 200);
    assert.equal(key.body.publicKey, h.push.publicKey);

    const phone = device('https://ntfy.example.org/upAbc123?up=1');
    const put = await s.call('PUT', '/api/push/subscription', { token, body: phone });
    assert.equal(put.status, 200);
    assert.equal(h.rows().length, 1);
    assert.equal(h.rows()[0].user_id, 'u-kes');

    // The distributor hands out a new endpoint: the session's row is replaced, not added to.
    const moved = device('https://ntfy.example.org/upXyz789?up=1');
    await s.call('PUT', '/api/push/subscription', { token, body: moved });
    assert.deepEqual(h.rows().map((r) => r.endpoint), [moved.endpoint]);

    const del = await s.call('DELETE', '/api/push/subscription', { token });
    assert.deepEqual(del.body, { ok: true, removed: true });
    assert.equal(h.rows().length, 0);
    assert.deepEqual((await s.call('DELETE', '/api/push/subscription', { token })).body, { ok: true, removed: false });
});

test('routes: bad subscriptions are refused with a reason; the admin console cannot subscribe', async (t) => {
    const h = harness();
    const s = await serve(h);
    t.after(() => s.close());
    const token = issueSession(h.db, 'u-kes');
    const good = device('https://push.example.net/x');

    const cases = [
        [{ ...good, endpoint: 'http://push.example.net/x' }, /https/],
        [{ ...good, endpoint: 'https://user:pw@push.example.net/x' }, /credentials/],
        [{ ...good, endpoint: 'https://127.0.0.1/x' }, /not reachable/],
        [{ ...good, endpoint: 'https://[::1]/x' }, /not reachable/],
        [{ ...good, endpoint: 'https://169.254.169.254/latest' }, /not reachable/],
        [{ ...good, endpoint: 'https://localhost:8443/x' }, /not reachable/],
        [{ ...good, keys: { ...good.keys, p256dh: good.keys.p256dh.slice(0, 40) } }, /p256dh/],
        [{ ...good, keys: { ...good.keys, auth: toB64u(crypto.randomBytes(8)) } }, /auth/],
        [{ keys: good.keys }, /endpoint/],
    ];
    for (const [body, why] of cases) {
        const res = await s.call('PUT', '/api/push/subscription', { token, body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.body.message, why);
    }
    assert.equal(h.rows().length, 0);

    const adminToken = issueSession(h.db, 'u-kes', 'admin');
    const asAdmin = await s.call('PUT', '/api/push/subscription', { token: adminToken, body: good });
    assert.equal(asAdmin.status, 403);
});

test('signing out takes the subscription with it, however the session ends', () => {
    const h = harness();
    const sessionFor = (token) => ({
        userId: h.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
            .get(crypto.createHash('sha256').update(token).digest('hex')).user_id,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    });

    // Sign-out (what POST /api/auth/logout does).
    const phone = issueSession(h.db, 'u-kes');
    h.push.subscribe(sessionFor(phone), device('https://push.example.net/phone'));
    const laptop = issueSession(h.db, 'u-kes');
    h.push.subscribe(sessionFor(laptop), device('https://push.example.net/laptop'));
    assert.equal(h.rows().length, 2);
    revokeSession(h.db, phone);
    assert.deepEqual(h.rows().map((r) => r.endpoint), ['https://push.example.net/laptop'], 'only that device');

    // Sign out everywhere (recovery, an administrator's reset).
    revokeAllForUser(h.db, 'u-kes');
    assert.equal(h.rows().length, 0);

    // Expiry.
    const stale = issueSession(h.db, 'u-moth');
    h.push.subscribe(sessionFor(stale), device('https://push.example.net/stale'));
    h.db.prepare('UPDATE sessions SET expires_at = 0').run();
    purgeExpiredSessions(h.db);
    assert.equal(h.rows().length, 0);

    // The account itself.
    const last = issueSession(h.db, 'u-moth');
    h.push.subscribe(sessionFor(last), device('https://push.example.net/last'));
    h.db.prepare('DELETE FROM users WHERE id = ?').run('u-moth');
    assert.equal(h.rows().length, 0);
});

test('the same phone signing in again moves its endpoint rather than ringing twice', () => {
    const h = harness();
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const first = issueSession(h.db, 'u-kes');
    const second = issueSession(h.db, 'u-kes');
    const phone = device('https://push.example.net/same-phone');
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(first) }, phone);
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(second) }, phone);
    const rows = h.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_hash, hash(second));
});

test('delivery: every device of the account, encrypted for each, with the headers asked for', async () => {
    const h = harness();
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const phone = device('https://push.example.net/phone');
    const tablet = device('https://other-push.example.com/tablet');
    const stranger = device('https://push.example.net/someone-else');
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(issueSession(h.db, 'u-kes')) }, phone);
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(issueSession(h.db, 'u-kes')) }, tablet);
    h.push.subscribe({ userId: 'u-moth', tokenHash: hash(issueSession(h.db, 'u-moth')) }, stranger);

    const payload = { v: 1, kind: 'ring', callId: 'Q2FsbElkMTIzNDU2Nzg5MA', call: { type: 'dm', threadId: 't1' } };
    const tally = await h.push.toUser('u-kes', payload, { ttl: 45, urgency: 'high', topic: payload.callId });
    assert.deepEqual(tally, { sent: 2, gone: 0, failed: 0 });

    const byUrl = new Map(h.posted.map((p) => [p.url, p]));
    assert.equal(byUrl.size, 2);
    assert.ok(!byUrl.has(stranger.endpoint), 'nobody else is rung');
    for (const d of [phone, tablet]) {
        const sent = byUrl.get(d.endpoint);
        assert.equal(sent.method, 'POST');
        assert.equal(sent.redirect, 'manual', 'a redirect is never followed');
        assert.equal(sent.headers.TTL, '45');
        assert.equal(sent.headers.Urgency, 'high');
        assert.equal(sent.headers.Topic, payload.callId);
        assert.equal(sent.headers['Content-Encoding'], 'aes128gcm');
        assert.deepEqual(d.open(sent.body), payload, 'each device can open its own copy');
    }
    assert.ok(h.rows().filter((r) => r.user_id === 'u-kes').every((r) => r.last_ok_at), 'a delivery is stamped');
});

test('delivery: 404 and 410 drop the subscription; refusals and network errors only report', async () => {
    const outcomes = {
        'https://push.example.net/gone': 410,
        'https://push.example.net/unknown': 404,
        'https://push.example.net/busy': 429,
        'https://push.example.net/down': Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        'https://push.example.net/fine': 201,
    };
    const h = harness({ status: (url) => outcomes[url] });
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    for (const endpoint of Object.keys(outcomes)) {
        h.push.subscribe({ userId: 'u-kes', tokenHash: hash(issueSession(h.db, 'u-kes')) }, device(endpoint));
    }
    const tally = await h.push.toUser('u-kes', { v: 1, kind: 'missed' });
    assert.deepEqual(tally, { sent: 1, gone: 2, failed: 2 });
    assert.deepEqual(h.rows().map((r) => r.endpoint).sort(), [
        'https://push.example.net/busy', 'https://push.example.net/down', 'https://push.example.net/fine',
    ]);
});

test('delivery never logs the payload, and logs endpoints by origin only', async () => {
    const lines = [];
    const spy = {
        info: (o, m) => lines.push(JSON.stringify(o) + m), warn: (o, m) => lines.push(JSON.stringify(o) + m),
        error: (o, m) => lines.push(JSON.stringify(o) + m), debug: (o, m) => lines.push(JSON.stringify(o) + m),
        child() { return spy; },
    };
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateCore(db, quiet);
    db.prepare(`INSERT INTO users (id, username, username_lower, display_name, password_hash)
                VALUES ('u-kes', 'kes', 'kes', 'Kes', 'x')`).run();
    const statuses = [201, 410, 500];
    const push = createPush({ db, log: spy, fetch: async () => new Response(null, { status: statuses.shift() }) });
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    for (const p of ['secret-path-a', 'secret-path-b', 'secret-path-c']) {
        push.subscribe({ userId: 'u-kes', tokenHash: hash(issueSession(db, 'u-kes')) }, device(`https://push.example.net/${p}`));
    }
    await push.toUser('u-kes', { from: { displayName: 'Ana Lovelace' }, callId: 'CALL-ID-MARKER' });
    const all = lines.join('\n');
    assert.ok(lines.length >= 3, 'each outcome is logged');
    assert.ok(!all.includes('Ana Lovelace') && !all.includes('CALL-ID-MARKER'), 'no payload');
    assert.ok(!all.includes('secret-path'), 'no endpoint path');
    assert.ok(all.includes('https://push.example.net'));
});

test('an account keeps at most ten subscriptions: the stalest one goes', () => {
    const h = harness();
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    for (let i = 0; i < 12; i += 1) {
        h.push.subscribe({ userId: 'u-kes', tokenHash: hash(issueSession(h.db, 'u-kes')) }, device(`https://push.example.net/d${i}`));
    }
    const kept = h.rows().map((r) => r.endpoint);
    assert.equal(kept.length, 10);
    assert.ok(kept.includes('https://push.example.net/d11'), 'the newest is always kept');
});

test('private and loopback literals are refused on a public server only', () => {
    const lan = ['https://192.168.1.10/up', 'https://10.0.0.5:8443/up', 'https://[fd00::5]/up', 'https://localhost/up'];
    for (const href of lan) {
        assert.equal(endpointAllowed(new URL(href), 'public'), false, href);
        assert.equal(endpointAllowed(new URL(href), 'lan'), true, `${href} is a member's own ntfy on a LAN server`);
    }
    for (const href of ['https://ntfy.sh/upAbc', 'https://203.0.113.9/up', 'https://[2001:db8::1]/up']) {
        assert.equal(endpointAllowed(new URL(href), 'public'), true, href);
    }
    assert.equal(endpointAllowed(new URL('http://ntfy.sh/up'), 'lan'), false, 'https always');
    assert.equal(endpointAllowed(new URL('https://172.20.0.1/up'), 'public'), false);
    assert.equal(endpointAllowed(new URL('https://172.32.0.1/up'), 'public'), true, 'outside 172.16/12');
});

test('a registered phone stays signed in for 30 idle days; unregistering gives that back', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 18) });
    const h = harness();
    const token = issueSession(h.db, 'u-kes');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const session = resolveSession(h.db, token);
    const row = () => h.db.prepare('SELECT idle_ttl_ms AS ttl, expires_at AS exp FROM sessions WHERE token_hash = ?').get(hash);

    h.push.subscribe(session, device('https://push.example.net/phone'));
    assert.equal(row().ttl, PUSH_SESSION_TTL_MS);
    assert.equal(row().exp, Date.now() + PUSH_SESSION_TTL_MS);

    // A night, and then a week, in a drawer: still signed in, and still rung.
    t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
    assert.ok(resolveSession(h.db, token), 'a week idle is fine for a registered phone');
    assert.equal(purgeExpiredSessions(h.db), 0);
    assert.equal((await h.push.toUser('u-kes', { v: 1 })).sent, 1);

    // Unregistering puts it back on the ordinary window, measured from now.
    h.push.unsubscribe(session);
    assert.equal(row().ttl, null);
    assert.ok(row().exp <= Date.now() + SESSION_TTL_MS);
    t.mock.timers.tick(SESSION_TTL_MS + 1);
    assert.equal(resolveSession(h.db, token), null, '12 idle hours after that, it is gone');
});

test('a subscription lost any other way gives the long window back too', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 18) });
    const h = harness();
    const hash = (tk) => crypto.createHash('sha256').update(tk).digest('hex');
    const old = issueSession(h.db, 'u-kes');
    const phone = device('https://push.example.net/phone');
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(old) }, phone);

    // The same phone signs in again: its endpoint moves, and the abandoned session is
    // back on 12 hours from its last use rather than keeping 30 days.
    const fresh = issueSession(h.db, 'u-kes');
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(fresh) }, phone);
    const ttl = (tk) => h.db.prepare('SELECT idle_ttl_ms AS t FROM sessions WHERE token_hash = ?').get(hash(tk)).t;
    assert.equal(ttl(old), null);
    assert.equal(ttl(fresh), PUSH_SESSION_TTL_MS);
    t.mock.timers.tick(SESSION_TTL_MS + 1);
    assert.equal(purgeExpiredSessions(h.db), 1, 'the abandoned session lapses on the ordinary window');
    assert.equal(resolveSession(h.db, old), null);
});

test('delivery skips lapsed sessions and disabled accounts', async () => {
    const h = harness();
    const hash = (tk) => crypto.createHash('sha256').update(tk).digest('hex');
    const kes = issueSession(h.db, 'u-kes');
    h.push.subscribe({ userId: 'u-kes', tokenHash: hash(kes) }, device('https://push.example.net/kes'));
    const moth = issueSession(h.db, 'u-moth');
    h.push.subscribe({ userId: 'u-moth', tokenHash: hash(moth) }, device('https://push.example.net/moth'));

    h.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hash(kes));
    assert.deepEqual(await h.push.toUser('u-kes', { v: 1 }), { sent: 0, gone: 0, failed: 0 }, 'lapsed, not yet purged');

    h.db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run('u-moth');
    assert.deepEqual(await h.push.toUser('u-moth', { v: 1 }), { sent: 0, gone: 0, failed: 0 }, 'banned');
    assert.equal(h.posted.length, 0);
});

test('with push down, the routes say so rather than vanishing', async (t) => {
    const h = harness();
    const s = await serve(h, { push: null });
    t.after(() => s.close());
    const token = issueSession(h.db, 'u-kes');
    assert.equal((await s.call('GET', '/api/push/key', { token })).status, 503);
    assert.equal((await s.call('PUT', '/api/push/subscription', { token, body: device('https://push.example.net/x') })).status, 503);
});

test('cleanSubscription normalises a padded key and refuses nonsense', () => {
    const d = device('https://push.example.net/x');
    const padded = { ...d, keys: { p256dh: fromB64u(d.keys.p256dh).toString('base64'), auth: fromB64u(d.keys.auth).toString('base64') } };
    assert.deepEqual(cleanSubscription(padded), { endpoint: d.endpoint, ...d.keys });
    assert.throws(() => cleanSubscription(null), PushError);
    assert.throws(() => cleanSubscription({ endpoint: 'not a url', keys: d.keys }), PushError);
    assert.throws(() => cleanSubscription({ endpoint: `https://push.example.net/${'x'.repeat(2100)}`, keys: d.keys }), PushError);
});
