// One account, one voice — the rule itself, without a media server.
//
// one-voice.test.js drives the whole server over real sockets, which needs mediasoup's
// worker. This drives the same socket handlers (join, move, leave, adminMove) against a
// real database and stand-in sockets, so the rule is checked wherever the tests run.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateCore } from '../src/db/index.js';
import { createChannel, defaultChannel } from '../src/core/channels/index.js';
import { PeerRegistry } from '../src/core/peers/index.js';
import { registerCoreWsHandlers } from '../src/core/ws/handlers/core.js';
import { movePeer } from '../src/core/peers/move.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

function harness() {
    const db = new Database(':memory:');
    migrateCore(db, quiet);
    // The accounts themselves: an administrator's move is audited against a real user.
    const addUser = db.prepare(`INSERT INTO users (id, username, username_lower, display_name, password_hash, is_admin)
                                VALUES (?, ?, ?, ?, 'not-a-real-hash', ?)`);
    addUser.run('u-kes', 'kes', 'kes', 'Kes', 0);
    addUser.run('u-admin', 'admin', 'admin', 'Admin', 1);
    if (!defaultChannel(db)) createChannel(db, { name: 'General', isDefault: true });
    const den = createChannel(db, { name: 'Den' });
    const away = createChannel(db, { name: 'Away', kind: 'afk', allowVoice: false });

    const peers = new PeerRegistry(quiet);
    const sockets = new Map();   // cid -> stand-in socket
    const frames = [];           // [cid, type, payload]
    const wsServer = {
        send(ws, type, payload = {}) {
            if (!ws || ws.closed) return false;
            frames.push([ws.cid, type, payload]);
            return true;
        },
        broadcast(type, payload, filter) {
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
        laptopToken: { userId: 'u-kes', username: 'kes', displayName: 'Kes', sessionId: 's1', isAdmin: false },
        phoneToken: { userId: 'u-kes', username: 'kes', displayName: 'Kes', sessionId: 's2', isAdmin: false },
        adminToken: { userId: 'u-admin', username: 'admin', displayName: 'Admin', sessionId: 's3', isAdmin: true },
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
    const connect = async (token, extra = {}) => {
        const ws = { cid: `c${++next}`, closed: false, close() { this.closed = true; }, terminate() {} };
        sockets.set(ws.cid, ws);
        await run(ws, 'join', { token, protocol: 1, ...extra });
        const joined = frames.findLast(([cid, t]) => cid === ws.cid && t === 'joined')?.[2];
        return { ws, joined, send: (type, msg) => run(ws, type, msg) };
    };
    const framesFor = (client, type) => frames.filter(([cid, t]) => cid === client.ws.cid && t === type)
        .map(([, , p]) => p);
    const standing = (userId) => peers.forUser(userId).filter((p) => p.channelId !== null).map((p) => p.cid);

    // A module's move (the call module's, the idle sweep's) goes through movePeer directly.
    const moduleMove = (client, channel, reason) => movePeer({
        db, peer: peers.get(client.ws.cid), channel, peers, sfu, ws: wsServer, hooks: { emit() {} }, reason,
    });

    return { connect, framesFor, standing, den, away, peers, moduleMove };
}

test('a second device taking voice stands the first one down, still signed in', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    assert.ok(laptop.joined.channel, 'the laptop arrives in a room');

    const phone = await h.connect('phoneToken');
    assert.equal(phone.joined.channel.id, laptop.joined.channel.id, 'the newest device takes voice');

    const [left] = h.framesFor(laptop, 'left');
    assert.deepEqual(left, { channel: null, reason: 'elsewhere' });
    assert.ok(h.peers.get(laptop.ws.cid), 'the laptop is still connected, reading');
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid], 'one account, one voice');
});

test('choosing a room on the stood-down device takes voice back', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    const phone = await h.connect('phoneToken');

    await laptop.send('move', { channelId: h.den.id });
    assert.equal(h.framesFor(laptop, 'moved')[0].channel.id, h.den.id);
    assert.deepEqual(h.framesFor(phone, 'left'), [{ channel: null, reason: 'elsewhere' }]);
    assert.deepEqual(h.standing('u-kes'), [laptop.ws.cid]);
});

test('an automatic reconnect defers to the device that has voice', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    const phone = await h.connect('phoneToken', { reconnect: true });

    assert.equal(phone.joined.channel, null, 'it arrives standing nowhere');
    assert.equal(phone.joined.elsewhere, true, 'and is told why');
    assert.deepEqual(h.framesFor(laptop, 'left'), [], 'the laptop keeps voice');
    assert.deepEqual(h.standing('u-kes'), [laptop.ws.cid]);
});

test('a reconnect with nobody else in voice goes back where it was', async () => {
    const h = harness();
    const only = await h.connect('laptopToken', { reconnect: true });
    assert.ok(only.joined.channel);
    assert.equal(only.joined.elsewhere, undefined);
});

test('arriving to read, not to talk, takes nothing from anyone', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    const phone = await h.connect('phoneToken', { autoJoin: false });
    assert.equal(phone.joined.channel, null);
    assert.deepEqual(h.framesFor(laptop, 'left'), []);
});

test('leaving is the person\'s own, and says no more than it did', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    await laptop.send('leave');
    assert.deepEqual(h.framesFor(laptop, 'left'), [{ channel: null }]);
    await laptop.send('leave');
    assert.equal(h.framesFor(laptop, 'left').length, 2, 'leaving twice is calm');
});

test('two different people never stand each other down', async () => {
    const h = harness();
    const kes = await h.connect('laptopToken');
    await h.connect('adminToken');
    assert.deepEqual(h.framesFor(kes, 'left'), []);
});

test('an administrator moves the person once: the device they are heard on', async () => {
    const h = harness();
    const admin = await h.connect('adminToken');
    const laptop = await h.connect('laptopToken');
    const phone = await h.connect('phoneToken');   // takes voice; the laptop stands nowhere

    await admin.send('adminMove', { userId: 'u-kes', channelId: h.den.id });
    assert.equal(h.framesFor(phone, 'moved')[0]?.channel.id, h.den.id);
    assert.deepEqual(h.framesFor(laptop, 'moved'), [], 'the laptop stays out of the room');
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid], 'never in the room twice');
});

test('an administrator moving someone standing nowhere everywhere moves their newest device', async () => {
    const h = harness();
    const admin = await h.connect('adminToken');
    const laptop = await h.connect('laptopToken', { autoJoin: false });
    const phone = await h.connect('phoneToken', { autoJoin: false });
    h.peers.get(phone.ws.cid).joinedAt = h.peers.get(laptop.ws.cid).joinedAt + 1;

    await admin.send('adminMove', { userId: 'u-kes', channelId: h.den.id });
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid]);
});

test('taking voice to a new device continues in the room the person is in', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    await laptop.send('move', { channelId: h.den.id });

    // The phone last stood in General, but the person is talking in the Den.
    const phone = await h.connect('phoneToken', { channelId: laptop.joined.channel.id });
    assert.equal(phone.joined.channel.id, h.den.id, 'the conversation follows the person');
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid]);
});

test('a device idling in the away room does not drag a new one in with it', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    h.peers.get(laptop.ws.cid).channelId = h.away.id;   // where the idle sweep puts it

    const phone = await h.connect('phoneToken');
    assert.notEqual(phone.joined.channel.id, h.away.id, 'opening the app is not being idle');
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid]);
});

test('answering a call on one device takes voice to it; the idle sweep takes nobody', async () => {
    const h = harness();
    const laptop = await h.connect('laptopToken');
    const phone = await h.connect('phoneToken', { reconnect: true });   // standing nowhere

    h.moduleMove(phone, h.den, 'dm-call');
    assert.deepEqual(h.standing('u-kes'), [phone.ws.cid], 'the call is where the person is heard');
    assert.deepEqual(h.framesFor(laptop, 'left'), [{ channel: null, reason: 'elsewhere' }]);

    // Being moved for idling is not choosing to be heard anywhere.
    const before = h.framesFor(laptop, 'left').length;
    h.moduleMove(phone, h.away, 'afk_timeout');
    assert.equal(h.framesFor(laptop, 'left').length, before);
});
