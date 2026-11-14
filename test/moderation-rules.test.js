// Server mute, the rules themselves — without a media server.
//
// moderation.test.js drives the whole server over real sockets, which needs mediasoup's
// worker. This drives the same socket handlers against a real database and stand-in
// sockets and producers, the way one-voice-rules.test.js does, so these run wherever the
// tests run.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateCore } from '../src/db/index.js';
import { createChannel, defaultChannel } from '../src/core/channels/index.js';
import { PeerRegistry } from '../src/core/peers/index.js';
import { registerCoreWsHandlers } from '../src/core/ws/handlers/core.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

const fakeProducer = () => {
    const it = { paused: false, pause() { it.paused = true; }, resume() { it.paused = false; } };
    return it;
};

function harness() {
    const db = new Database(':memory:');
    migrateCore(db, quiet);
    const addUser = db.prepare(`INSERT INTO users (id, username, username_lower, display_name, password_hash, is_admin, is_tester)
                                VALUES (?, ?, ?, ?, 'not-a-real-hash', ?, ?)`);
    addUser.run('u-kes', 'kes', 'kes', 'Kes', 0, 0);
    addUser.run('u-admin', 'admin', 'admin', 'Admin', 1, 0);
    addUser.run('u-deputy', 'deputy', 'deputy', 'Deputy', 1, 0);
    addUser.run('u-tess', 'tess', 'tess', 'Tess', 0, 1);
    addUser.run('u-tom', 'tom', 'tom', 'Tom', 0, 1);
    if (!defaultChannel(db)) createChannel(db, { name: 'General', isDefault: true });

    const peers = new PeerRegistry(quiet);
    const sockets = new Map();
    const frames = [];
    const wsServer = {
        send(ws, type, payload = {}) {
            if (!ws || ws.closed) return false;
            frames.push([ws.cid, type, payload]);
            return true;
        },
        broadcast(type, payload, filter = () => true) {
            for (const sock of sockets.values()) if (filter(sock)) this.send(sock, type, payload);
        },
    };
    const sfu = {
        workerIndexFor: () => 0,
        rtpCapabilities: () => ({ codecs: [] }),
        observeAudio: async () => {},
    };
    const handlers = new Map();
    const registry = { register(_owner, type, handler) { handlers.set(type, handler); } };
    const sessions = {
        kesToken: { userId: 'u-kes', username: 'kes', displayName: 'Kes', sessionId: 's1', isAdmin: false },
        adminToken: { userId: 'u-admin', username: 'admin', displayName: 'Admin', sessionId: 's2', isAdmin: true },
        deputyToken: { userId: 'u-deputy', username: 'deputy', displayName: 'Deputy', sessionId: 's3', isAdmin: true },
        // The flags the socket gate would have refreshed; this harness calls handlers directly.
        tessToken: { userId: 'u-tess', username: 'tess', displayName: 'Tess', sessionId: 's4', isAdmin: false, isTester: true },
        tomToken: { userId: 'u-tom', username: 'tom', displayName: 'Tom', sessionId: 's5', isAdmin: false, isTester: true },
    };
    registerCoreWsHandlers({
        registry, peers, sfu, db, log: quiet, hooks: { emit() {} }, ws: wsServer,
        auth: { resolveToken: (token) => sessions[token] ?? null },
    });

    let next = 0;
    const run = async (ws, type, msg = {}) => handlers.get(type)({
        ws,
        msg: { type, ...msg },
        send: (t, p) => wsServer.send(ws, t, p),
        fail: (sock, code, message) => wsServer.send(sock, 'error', { code, message }),
    });
    const connect = async (token) => {
        const ws = {
            cid: `c${++next}`, closed: false, log: quiet,
            close() { this.closed = true; }, terminate() {},
        };
        sockets.set(ws.cid, ws);
        await run(ws, 'join', { token, protocol: 1 });
        // A stand-in microphone, so pausing and resuming can be watched.
        const audio = fakeProducer();
        peers.get(ws.cid).producers.set('audio', audio);
        return { ws, audio, send: (type, msg) => run(ws, type, msg) };
    };
    const framesFor = (client, type) => frames.filter(([cid, t]) => cid === client.ws.cid && t === type)
        .map(([, , p]) => p);

    return { db, connect, framesFor };
}

test('a server-muted person cannot resume their own microphone with pauseProducer', async () => {
    // setMute already refused this; pauseProducer resumed whatever it was asked to, so one
    // hand-written frame lifted a mute its owner is not meant to be able to lift.
    const h = harness();
    const admin = await h.connect('adminToken');
    const kes = await h.connect('kesToken');

    await admin.send('serverMute', { userId: 'u-kes', minutes: 5 });
    assert.equal(kes.audio.paused, true, 'the mute paused them');

    await kes.send('pauseProducer', { slot: 'audio', paused: false });
    assert.equal(kes.audio.paused, true, 'and asking to resume does not undo it');
    assert.equal(h.framesFor(kes, 'producerPaused').at(-1).paused, true,
        'what they are told is the truth, not what they asked for');

    // Lifted, the same request works as it always did.
    await admin.send('serverMute', { userId: 'u-kes', muted: false });
    await kes.send('pauseProducer', { slot: 'audio', paused: true });
    await kes.send('pauseProducer', { slot: 'audio', paused: false });
    assert.equal(kes.audio.paused, false);
});

test('a server mute can last thirty seconds, and the audit log says so', async () => {
    const h = harness();
    const admin = await h.connect('adminToken');
    await h.connect('kesToken');

    const before = Date.now();
    await admin.send('serverMute', { userId: 'u-kes', minutes: 0.5 });
    const [changed] = h.framesFor(admin, 'serverMuteChanged');
    assert.equal(changed.forceMuted, true);
    const length = changed.until - before;
    assert.ok(length >= 29_000 && length <= 31_000, `about thirty seconds, got ${length} ms`);

    const row = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'ADMIN_SERVER_MUTED'").get();
    assert.equal(row.detail, '30s', 'not "0.5m"');
});

test('anything shorter than thirty seconds is raised to thirty, not refused or ignored', async () => {
    const h = harness();
    const admin = await h.connect('adminToken');
    await h.connect('kesToken');

    const before = Date.now();
    await admin.send('serverMute', { userId: 'u-kes', minutes: 0.01 });
    const length = h.framesFor(admin, 'serverMuteChanged')[0].until - before;
    assert.ok(length >= 29_000 && length <= 31_000, `floored at thirty seconds, got ${length} ms`);
});

test('an administrator aimed at another is refused with a code that does not end their session', async () => {
    const h = harness();
    const admin = await h.connect('adminToken');
    await h.connect('deputyToken');

    await admin.send('serverMute', { userId: 'u-deputy', minutes: 5 });
    await admin.send('kickPeer', { userId: 'u-deputy' });
    assert.deepEqual(h.framesFor(admin, 'error').map((e) => e.code),
        ['target_is_admin', 'target_is_admin']);
});

// ── a tester's server mute ───────────────────────────────────────────────────

test('a tester can server-mute a member, and another tester', async () => {
    const h = harness();
    const tess = await h.connect('tessToken');
    const kes = await h.connect('kesToken');
    const tom = await h.connect('tomToken');

    await tess.send('serverMute', { userId: 'u-kes', minutes: 5 });
    await tess.send('serverMute', { userId: 'u-tom', minutes: 0.5 });
    assert.equal(kes.audio.paused, true);
    assert.equal(tom.audio.paused, true);
    assert.equal(h.framesFor(tess, 'serverMuteChanged').length, 2);
    assert.deepEqual(h.framesFor(tess, 'error'), []);
});

test('a tester cannot server-mute an administrator, and is told so in their own terms', async () => {
    const h = harness();
    const tess = await h.connect('tessToken');
    const admin = await h.connect('adminToken');

    await tess.send('serverMute', { userId: 'u-admin', minutes: 5 });
    const [refused] = h.framesFor(tess, 'error');
    assert.equal(refused.code, 'target_is_admin');
    assert.equal(refused.message, 'Administrators cannot be server-muted.');
    assert.equal(admin.audio.paused, false);
});

test('a tester\'s mute always ends on its own', async () => {
    const h = harness();
    const tess = await h.connect('tessToken');
    const kes = await h.connect('kesToken');

    await tess.send('serverMute', { userId: 'u-kes', minutes: null });
    const [refused] = h.framesFor(tess, 'error');
    assert.equal(refused.code, 'not_permitted');
    assert.match(refused.message, /until lifted/);
    assert.equal(kes.audio.paused, false, 'nothing was applied');
});

test('a tester lifts their own mute, and not an administrator\'s', async () => {
    const h = harness();
    const tess = await h.connect('tessToken');
    const admin = await h.connect('adminToken');
    const kes = await h.connect('kesToken');

    await tess.send('serverMute', { userId: 'u-kes', minutes: 5 });
    await tess.send('serverMute', { userId: 'u-kes', muted: false });
    assert.equal(kes.audio.paused, false, 'their own mute, theirs to lift');

    await admin.send('serverMute', { userId: 'u-kes', minutes: null });
    await tess.send('serverMute', { userId: 'u-kes', muted: false });
    const [refused] = h.framesFor(tess, 'error');
    assert.equal(refused.code, 'not_permitted');
    assert.match(refused.message, /whoever placed it/);
    assert.equal(kes.audio.paused, true, "the administrator's mute stands");
});

test('a tester cannot shorten somebody else\'s mute by muting over it', async () => {
    // Re-muting replaces the mute in force, so a 30-second mute over an administrator's
    // open-ended one would have lifted it in all but name.
    const h = harness();
    const tess = await h.connect('tessToken');
    const admin = await h.connect('adminToken');
    await h.connect('kesToken');

    await admin.send('serverMute', { userId: 'u-kes', minutes: null });
    await tess.send('serverMute', { userId: 'u-kes', minutes: 0.5 });
    assert.equal(h.framesFor(tess, 'error')[0].code, 'not_permitted');

    const standing = h.db.prepare(`SELECT by_user_id, expires_at FROM moderation
                                   WHERE user_id = 'u-kes' AND lifted_at IS NULL`).all();
    assert.deepEqual(standing, [{ by_user_id: 'u-admin', expires_at: null }],
        'the open-ended mute is still the one in force');
});

test('an administrator can still lift a tester\'s mute', async () => {
    const h = harness();
    const tess = await h.connect('tessToken');
    const admin = await h.connect('adminToken');
    const kes = await h.connect('kesToken');

    await tess.send('serverMute', { userId: 'u-kes', minutes: 60 });
    await admin.send('serverMute', { userId: 'u-kes', muted: false });
    assert.equal(kes.audio.paused, false);
    assert.deepEqual(h.framesFor(admin, 'error'), []);
});
