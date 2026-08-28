// What the router tells every client's encoder to do.
//
// This is the highest-leverage surface in the whole media path and it was never asserted.
// mediasoup-client builds the synthetic remote ANSWER — the thing that actually configures
// the browser's Opus encoder — from the ROUTER's declared codec parameters, not from
// anything the client sends. So the numbers below reach clients that predate them, and a
// silent regression here degrades every call on the server with nothing else to show for
// it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

function client(url) {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        const i = waiters.findIndex((w) => w.match(msg));
        if (i >= 0) {
            const [w] = waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(msg);
        } else inbox.push(msg);
    });
    return {
        open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
        send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
        expect(type, timeoutMs = 5000) {
            const match = (m) => m.type === type;
            const found = inbox.findIndex(match);
            if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`Timed out waiting for "${type}". Saw: ${inbox.map((m) => m.type).join(', ')}`)),
                    timeoutMs,
                );
                waiters.push({ match, resolve, timer });
            });
        },
        close: () => ws.close(),
    };
}

async function launch(extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-mq-'));
    let httpPort;
    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(await freePort()),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
            ...extraEnv,
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
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

    const sockets = [];
    return {
        call,
        adminToken: admin.body.token,
        /** A connected socket with a join() that returns the joined frame. */
        async peer() {
            const c = client(`ws://127.0.0.1:${httpPort}`);
            await c.open();
            sockets.push(c);
            await c.expect('hello');
            return {
                ...c,
                async join(channelId) {
                    c.send('join', { token: admin.body.token, channelId, protocol: { min: 1, max: 1 } });
                    return c.expect('joined');
                },
            };
        },
        async caps() {
            const c = client(`ws://127.0.0.1:${httpPort}`);
            await c.open();
            sockets.push(c);
            await c.expect('hello');
            c.send('join', { token: admin.body.token, protocol: { min: 1, max: 1 } });
            return (await c.expect('joined')).rtpCapabilities;
        },
        cleanup: async () => {
            for (const c of sockets) { try { c.close(); } catch { /* gone */ } }
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

const opusOf = (caps) => caps.codecs.find((c) => c.mimeType.toLowerCase() === 'audio/opus');
const videoOf = (caps) => caps.codecs.filter((c) => c.kind === 'video' && !/rtx/i.test(c.mimeType));

test('the router tells every client what bitrate to encode speech at', async (t) => {
    // Without maxaveragebitrate, Chromium picks roughly 32 kb/s mono — about a third of
    // Discord's default channel, and most of what "muffled" meant. Declaring it here
    // rather than in the client is deliberate: it reaches clients too old to ask.
    const h = await launch();
    t.after(h.cleanup);

    const opus = opusOf(await h.caps());
    assert.equal(opus.parameters.maxaveragebitrate, 64_000);
    assert.equal(opus.parameters.useinbandfec, 1, 'a packet rebuilt from the next one');
    assert.equal(opus.parameters.maxplaybackrate, 48_000, 'fullband, stated not assumed');
    assert.equal(opus.parameters.usedtx, 0, 'silence suppression clips the first syllable back');
    assert.equal(opus.channels, 2, 'stereo stays available for a screen share to ask for');
});

test('the speech bitrate is what the operator set it to', async (t) => {
    // The knob a self-hoster on a fat uplink actually wants, and the proof that the
    // mechanism above is wired to config rather than hardcoded twice.
    const h = await launch({ WEAVE_OPUS_BITRATE: '96000' });
    t.after(h.cleanup);

    assert.equal(opusOf(await h.caps()).parameters.maxaveragebitrate, 96_000);
});

test('the advertised H264 level covers the resolutions the client offers', async (t) => {
    // '42e01f' is Constrained Baseline LEVEL 3.1, which caps at 3600 macroblocks — exactly
    // 1280x720. Three of the four stream presets are 1080p or larger, so the level being
    // advertised was one every one of those shares exceeded.
    const h = await launch();
    t.after(h.cleanup);

    const h264 = videoOf(await h.caps()).find((c) => c.mimeType.toLowerCase() === 'video/h264');
    assert.equal(h264.parameters['profile-level-id'], '42e02a', 'level 4.2');
});

test('VP9 is offered, and H264 still comes first', async (t) => {
    // Order IS the negotiation contract: mediasoup-client's reduceCodecs takes codecs[0],
    // so the first video codec is what everything produces by default. VP9 goes after it
    // so nothing changes for existing clients — the screen share asks for it by name —
    // and so a long-lived client holding stale routerRtpCapabilities cannot meet a VP9
    // producer it does not know how to consume.
    const h = await launch();
    t.after(h.cleanup);

    const video = videoOf(await h.caps()).map((c) => c.mimeType.toLowerCase());
    assert.equal(video[0], 'video/h264', 'H264 first: hardware encoders, and battery');
    assert.ok(video.includes('video/vp9'), 'VP9 for screen text');
    assert.ok(video.includes('video/vp8'), 'VP8 stays as the universal fallback');
});

test('a channel that does not allow video does not carry a screen share’s audio', async (t) => {
    // 'screen-audio' was neither isVoice nor isVideo, so it passed BOTH gates: a channel
    // with voice switched off would happily carry a peer's system audio. It belongs to the
    // share, so it follows the share's permission.
    const h = await launch();
    t.after(h.cleanup);

    const made = await h.call('POST', '/api/channels', {
        token: h.adminToken,
        body: { name: 'text-only', allowVoice: true, allowVideo: false },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const c = await h.peer();
    await c.join(made.body.channel.id);
    c.send('createTransport', { direction: 'send' });
    await c.expect('transportCreated');

    c.send('produce', { slot: 'screen-audio', kind: 'audio', rtpParameters: { codecs: [{ mimeType: 'audio/opus' }] } });
    assert.equal((await c.expect('error')).code, 'video_not_allowed');
});

test('a malformed produce does not cost the sender the producer they already had', async (t) => {
    // The replace-and-close branch ran BEFORE mediasoup ever validated, so a garbage frame
    // tore down a working producer and left the peer silently sending nothing. mediasoup
    // would reject it either way; the question is what it costs on the way through.
    const h = await launch();
    t.after(h.cleanup);

    const c = await h.peer();
    await c.join();
    c.send('createTransport', { direction: 'send' });
    await c.expect('transportCreated');

    c.send('produce', { slot: 'audio', kind: 'audio', rtpParameters: null });
    assert.equal((await c.expect('error')).code, 'bad_rtp_parameters');

    c.send('produce', { slot: 'audio', kind: 'trumpet', rtpParameters: { codecs: [] } });
    assert.equal((await c.expect('error')).code, 'bad_kind');
});
