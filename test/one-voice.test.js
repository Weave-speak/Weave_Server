// One account, one voice.
//
// Somebody signed in on two devices used to stand in the room on both: two microphones the
// room heard at once, and two mute states, so muting on the phone left the laptop live and
// an unmute on the laptop could not undo a mute made on the phone. Now the connection that
// most recently chose to be somewhere is the one heard. The others stay signed in, standing
// nowhere, and are told why.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-standing-'));
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
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201);
    const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
    const guest = await call('POST', '/api/auth/register', {
        body: { inviteCode: invite.body.invite.code, username: 'guest', password: 'a-long-enough-password' },
    });

    const sockets = [];
    const connect = async (token, joinExtra = {}) => {
        const ws = new WebSocket(`ws://127.0.0.1:${httpPort}`);
        sockets.push(ws);
        const inbox = [];
        const waiters = [];
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            const i = waiters.findIndex((w) => w.type === msg.type);
            if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); }
            else inbox.push(msg);
        });
        const expect = (type, ms = 5000) => {
            const found = inbox.findIndex((m) => m.type === type);
            if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}; saw ${inbox.map((m) => m.type)}`)), ms);
                waiters.push({ type, resolve, timer });
            });
        };
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: 1, ...joinExtra }));
        const joined = await expect('joined');
        return { ws, expect, joined, send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })) };
    };

    return {
        app, call, connect,
        adminToken: admin.body.token,
        guestToken: guest.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}


/** Resolves if nothing of `type` arrives within `ms` — a frame that must NOT come. */
const nothing = async (client, type, ms = 600) => {
    await assert.rejects(client.expect(type, ms), /timeout/, `no ${type} was expected`);
};

test('a second device taking voice stands the first one down, and leaves it signed in', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const laptop = await h.connect(h.guestToken);
    const general = laptop.joined.channel;
    assert.ok(general, 'the laptop is in a room');

    const phone = await h.connect(h.guestToken);
    assert.equal(phone.joined.channel.id, general.id, 'the newest device takes voice');
    assert.equal(phone.joined.elsewhere, undefined);

    const left = await laptop.expect('left');
    assert.equal(left.channel, null);
    assert.equal(left.reason, 'elsewhere', 'so the laptop can say why, and offer it back');
    assert.equal(laptop.ws.readyState, WebSocket.OPEN, 'still signed in: chat still works');

    // Everyone else sees the person once: in the room on the phone, nowhere on the laptop.
    const watcher = await h.connect(h.adminToken);
    const guests = watcher.joined.peers.filter((p) => p.username === 'guest');
    assert.equal(guests.length, 2);
    assert.deepEqual(guests.map((p) => p.channelId).filter(Boolean), [general.id]);
});

test('choosing a room on the stood-down device takes voice back', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const laptop = await h.connect(h.guestToken);
    const general = laptop.joined.channel;
    const phone = await h.connect(h.guestToken);
    await laptop.expect('left');

    laptop.send('move', { channelId: general.id });
    assert.equal((await laptop.expect('moved')).channel.id, general.id);
    const left = await phone.expect('left');
    assert.equal(left.reason, 'elsewhere');
});

test('an automatic reconnect does not take voice from the device that has it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const laptop = await h.connect(h.guestToken);
    // After an outage every device reconnects in whatever order its network allows; the
    // one in a pocket must not win by being slower.
    const phone = await h.connect(h.guestToken, { reconnect: true, channelId: laptop.joined.channel.id });
    assert.equal(phone.joined.channel, null, 'it arrives standing nowhere');
    assert.equal(phone.joined.elsewhere, true, 'and is told why');
    await nothing(laptop, 'left');

    // With nobody else in voice, a reconnect goes back where it was, as it always did.
    const solo = await launch();
    t.after(() => solo.stop());
    const only = await solo.connect(solo.guestToken, { reconnect: true });
    assert.ok(only.joined.channel, 'nothing to defer to, so it stands where it asked');
    assert.equal(only.joined.elsewhere, undefined);
});

test('arriving to read, not to talk, takes nothing from anyone', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const laptop = await h.connect(h.guestToken);
    const phone = await h.connect(h.guestToken, { autoJoin: false });
    assert.equal(phone.joined.channel, null);
    await nothing(laptop, 'left');
});

test('leaving is unchanged: no reason, because it was the person\'s own', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const a = await h.connect(h.guestToken);
    a.send('leave');
    const left = await a.expect('left');
    assert.equal(left.channel, null);
    assert.equal(left.reason, undefined);
});

test('two different people are never stood down by each other', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const guest = await h.connect(h.guestToken);
    await h.connect(h.adminToken);
    await nothing(guest, 'left');
});
