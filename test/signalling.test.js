// Signalling and media negotiation, driven over a real WebSocket against a real
// mediasoup worker.
//
// A genuine two-party call needs browsers and is verified at deploy time. What is
// verified here is everything the server is solely responsible for: that it refuses
// what it should refuse, that ICE offers both transports, and that channel isolation
// holds against a forged message rather than only against a well-behaved client.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

/** A tiny client that awaits specific message types, so tests read as a conversation. */
function client(url) {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];

    const deliver = (msg) => {
        const i = waiters.findIndex((w) => w.match(msg));
        if (i >= 0) {
            const [w] = waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(msg);
        } else {
            inbox.push(msg);
        }
    };

    ws.on('message', (raw) => deliver(JSON.parse(raw)));

    return {
        ws,
        open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
        send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
        /** Wait for the next message matching `type` (or a predicate). */
        expect(type, timeoutMs = 5000) {
            const match = typeof type === 'function' ? type : (m) => m.type === type;
            const found = inbox.findIndex(match);
            if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error(`Timed out waiting for "${type}". Saw: ${inbox.map((m) => m.type).join(', ') || '(nothing)'}`));
                }, timeoutMs);
                waiters.push({ match, resolve, timer });
            });
        },
        close: () => ws.close(),
    };
}

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-sig-'));
    let httpPort;
    let mediaPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        mediaPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(mediaPort),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const wsUrl = `ws://127.0.0.1:${httpPort}`;

    const call = async (method, url, { body, token } = {}) => {
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

    const setupCode = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: {
            code: setupCode,
            username: 'admin',
            password: 'a-long-enough-password',
            recoveryPhrase: 'three brass hinges on a door',
        },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    const channels = (await call('GET', '/api/channels', { token: admin.body.token })).body.channels;

    /** Make a second account so two peers can be tested against each other. */
    const makeMember = async (username) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: { maxUses: 1 } });
        const reg = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username, password: 'another-long-password' },
        });
        assert.equal(reg.status, 201, JSON.stringify(reg.body));
        return reg.body.token;
    };

    const sockets = [];
    const connect = async () => {
        const c = client(wsUrl);
        await c.open();
        sockets.push(c);
        return c;
    };

    return {
        app, call, connect, channels, makeMember,
        adminToken: admin.body.token,
        cleanup: async () => {
            for (const c of sockets) { try { c.close(); } catch { /* already gone */ } }
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Join and return the `joined` payload. */
async function join(c, token, channelId) {
    await c.expect('hello');
    c.send('join', { token, channelId, protocol: { min: 1, max: 1 } });
    return c.expect('joined');
}

test('a new connection is greeted with a quotable correlation id', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    const hello = await c.expect('hello');

    // Six Crockford characters — no I, L, O or U, so it survives being read aloud.
    assert.match(hello.cid, /^[0-9A-HJKMNP-TV-Z]{6}$/);
});

test('an unknown message type is refused explicitly, not silently dropped', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await c.expect('hello');
    c.send('nonsense');

    const err = await c.expect('error');
    assert.equal(err.code, 'unknown_type');
    // The hint matters: when a module is disabled this is how a client learns the
    // feature is unavailable rather than broken.
    assert.match(err.detail.hint, /disabled/);
});

test('signalling is refused before joining', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await c.expect('hello');
    c.send('createTransport', { direction: 'send' });

    assert.equal((await c.expect('error')).code, 'unauthenticated');
});

test('joining with a bad token is refused', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await c.expect('hello');
    c.send('join', { token: 'not-a-real-token', protocol: { min: 1, max: 1 } });

    assert.equal((await c.expect('error')).code, 'unauthenticated');
});

test('joining succeeds and returns what a client needs to start', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    const joined = await join(c, h.adminToken);

    assert.equal(joined.protocol, 1);
    assert.equal(joined.self.username, 'admin');
    assert.ok(joined.channel.id, 'landed in a channel');
    assert.ok(Array.isArray(joined.peers), 'told who else is here');

    // Without RTP capabilities the client cannot decide what it is able to send.
    const codecs = joined.rtpCapabilities.codecs.map((x) => x.mimeType);
    assert.ok(codecs.includes('audio/opus'));
    assert.ok(codecs.some((m) => m === 'video/H264'), 'H264 offered for hardware encode');
});

test('a client from the future is told which side is too old', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await c.expect('hello');
    c.send('join', { token: h.adminToken, protocol: { min: 99, max: 99 } });

    const err = await c.expect('error');
    assert.equal(err.code, 'protocol_mismatch');
    // Range negotiation, and the message says who should update rather than just
    // "mismatch" with no numbers.
    assert.match(err.message, /server is too old/i);
    assert.equal(err.detail.serverMax, 1);
});

test('a transport offers both UDP and TCP candidates on one port', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);
    c.send('createTransport', { direction: 'send' });

    const created = await c.expect('transportCreated');
    const protocols = new Set(created.iceCandidates.map((x) => x.protocol));

    // enableTcp defaults to false in mediasoup, which left the previous server with no
    // path at all for anyone on a UDP-blocking network.
    assert.ok(protocols.has('udp'), 'UDP offered');
    assert.ok(protocols.has('tcp'), 'TCP fallback offered');

    const ports = new Set(created.iceCandidates.map((x) => x.port));
    assert.equal(ports.size, 1, 'one port for everything — one firewall rule');
});

test('asking for a transport again REPLACES it, so a client can rebuild its media path', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);
    c.send('createTransport', { direction: 'send' });
    const first = await c.expect('transportCreated');

    // This used to answer 'transport_exists', which was a real outage: a client closes
    // its own transports whenever it rebuilds after an ICE failure, and the server's map
    // entry was never deleted — so every attempt afterwards was refused for as long as
    // the peer stayed in the room. Two people would sit in a channel unable to hear each
    // other while the server looked perfectly healthy. A client only asks when it has no
    // usable transport, so the request is honoured and a fresh one replaces the old.
    c.send('createTransport', { direction: 'send' });
    const second = await c.expect('transportCreated');
    assert.notEqual(second.id, first.id, 'a genuinely new transport, not the old one echoed back');
});

test('a rebuilt recv transport can still consume — the "we cannot hear each other" case', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Someone to listen to.
    const speaker = await h.connect();
    const speakerJoined = await join(speaker, h.adminToken);
    speaker.send('createTransport', { direction: 'send' });
    await speaker.expect('transportCreated');

    const memberToken = await h.makeMember('listener');
    const listener = await h.connect();
    await join(listener, memberToken);

    // The listener builds a recv transport, then rebuilds it — exactly what the client
    // does after a recovery cycle. Consuming has to keep working across that.
    listener.send('createTransport', { direction: 'recv' });
    await listener.expect('transportCreated');
    listener.send('createTransport', { direction: 'recv' });
    await listener.expect('transportCreated');

    // The consume is refused for a reason about the SPEAKER (they are not sending),
    // never 'no_transport' — which is what a stale, unusable slot would have produced.
    listener.send('consume', {
        cid: speakerJoined.self.cid,
        slot: 'audio',
        rtpCapabilities: { codecs: [], headerExtensions: [] },
    });
    const reply = await listener.expect('error');
    assert.equal(reply.code, 'no_producer',
        'the rebuilt transport is usable; the only thing missing is the producer');
});

test('peers in a channel are told when someone joins and leaves', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect();
    await join(a, h.adminToken);

    const memberToken = await h.makeMember('second');
    const b = await h.connect();
    await join(b, memberToken);

    const arrived = await a.expect('peer_joined');
    assert.equal(arrived.peer.username, 'second');

    b.close();
    const left = await a.expect('peer_left');
    assert.equal(left.userId, arrived.peer.userId);
});

test('consuming across channels is refused, not trusted', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const general = h.channels.find((x) => x.isDefault);
    const away = h.channels.find((x) => x.kind === 'afk');

    const a = await h.connect();
    await join(a, h.adminToken, general.id);

    const memberToken = await h.makeMember('elsewhere');
    const b = await h.connect();
    const bJoined = await join(b, memberToken, away.id);

    await a.send('createTransport', { direction: 'recv' });
    await a.expect('transportCreated');

    // A forged cid must not grant access to media from a room you are not in.
    a.send('consume', { cid: bJoined.self.cid, slot: 'audio', rtpCapabilities: { codecs: [], headerExtensions: [] } });

    assert.equal((await a.expect('error')).code, 'wrong_channel');
});

test('a channel that forbids voice refuses a voice producer server-side', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const away = h.channels.find((x) => x.kind === 'afk');
    assert.equal(away.allowVoice, false);

    const c = await h.connect();
    await join(c, h.adminToken, away.id);
    c.send('createTransport', { direction: 'send' });
    await c.expect('transportCreated');

    // Hiding the mic button is not enough; a modified client must be stopped here.
    c.send('produce', { slot: 'audio', kind: 'audio', rtpParameters: {} });
    assert.equal((await c.expect('error')).code, 'voice_not_allowed');
});

test('an invalid producer slot is refused', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);
    c.send('createTransport', { direction: 'send' });
    await c.expect('transportCreated');

    c.send('produce', { slot: 'not-a-slot', kind: 'audio', rtpParameters: {} });
    assert.equal((await c.expect('error')).code, 'bad_slot');
});

test('moving channels reports the new channel and its peers', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const away = h.channels.find((x) => x.kind === 'afk');
    const c = await h.connect();
    await join(c, h.adminToken);

    c.send('move', { channelId: away.id });
    const moved = await c.expect('moved');

    assert.equal(moved.channel.id, away.id);
    assert.ok(moved.rtpCapabilities, 'given capabilities for the new router');
});

test('mute is broadcast, and deafening implies muting', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect();
    await join(a, h.adminToken);
    const memberToken = await h.makeMember('listener');
    const b = await h.connect();
    await join(b, memberToken);
    await a.expect('peer_joined');

    b.send('setMute', { muted: false, deafened: true });

    const own = await b.expect('muteChanged');
    assert.equal(own.deafened, true);
    // Being audible while hearing nobody would be a strange state to allow.
    assert.equal(own.muted, true);

    const seen = await a.expect('peer_mute_changed');
    assert.equal(seen.deafened, true);
});

test('a flood is cut off rather than served', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);

    // The previous server had no WebSocket rate limiting at all.
    for (let i = 0; i < 400; i += 1) c.send('ping', { t: i });

    const err = await c.expect((m) => m.type === 'error' && m.code === 'rate_limited', 8000);
    assert.equal(err.code, 'rate_limited');
});

test('ICE can be restarted in place, without recreating the transport', async (t) => {
    // The cheap rung of the recovery ladder. Users were silently losing one direction of
    // audio — send and receive are separate transports — and the only remedy the client
    // had was a full teardown and rebuild: a new DTLS handshake, new consumers, and a
    // permission-shaped pause. Restarting ICE repairs the path while every producer and
    // consumer on it stays exactly where it is.
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);
    c.send('createTransport', { direction: 'send' });
    const created = await c.expect('transportCreated');

    c.send('restartIce', { direction: 'send' });
    const restarted = await c.expect('iceRestarted');

    assert.equal(restarted.direction, 'send');
    assert.equal(restarted.id, created.id, 'the SAME transport — that is the whole point');
    assert.ok(restarted.iceParameters?.usernameFragment, 'fresh credentials to signal onward');
    assert.notEqual(
        restarted.iceParameters.usernameFragment,
        created.iceParameters.usernameFragment,
        'credentials that did not change would restart nothing',
    );
});

test('restarting ICE on a transport that does not exist is an error, not a crash', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.connect();
    await join(c, h.adminToken);
    c.send('restartIce', { direction: 'recv' });

    assert.equal((await c.expect('error')).code, 'no_transport');
});
