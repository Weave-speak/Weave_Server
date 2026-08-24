// Standing is optional, and presence is global.
//
// Three things a Discord-shaped client cannot work without: arriving signed-in but in no
// voice room, leaving a room without leaving the server, and a FRESH connection knowing
// who stands where across every room — not just its own.

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

test('autoJoin false arrives signed in and standing nowhere', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const a = await h.connect(h.adminToken, { autoJoin: false });
    assert.equal(a.joined.channel, null);
    assert.equal(a.joined.self.channelId, null);
    assert.equal(a.joined.rtpCapabilities, undefined, 'no room means no media plumbing');

    // Standing nowhere, they can still pick a room the normal way.
    const rooms = await h.call('GET', '/api/channels', { token: h.adminToken });
    const general = rooms.body.channels.find((c) => c.isDefault);
    a.send('move', { channelId: general.id });
    const moved = await a.expect('moved');
    assert.equal(moved.channel.id, general.id);
});

test('a fresh connection is told about every room, not just its own', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    // The admin makes a second room and stands in it.
    const made = await h.call('POST', '/api/channels', {
        token: h.adminToken, body: { name: 'den', kind: 'both' },
    });
    const a = await h.connect(h.adminToken);
    a.send('move', { channelId: made.body.channel.id });
    await a.expect('moved');

    // A guest connecting FRESH into General must already see the admin in the den.
    const b = await h.connect(h.guestToken);
    const elsewhere = b.joined.peers.find((p) => p.username === 'admin');
    assert.ok(elsewhere, 'the roster covers other rooms');
    assert.equal(elsewhere.channelId, made.body.channel.id);
});

test('leave stands you nowhere: presence stays, the room forgets you', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const a = await h.connect(h.adminToken);
    const b = await h.connect(h.guestToken);
    const general = a.joined.channel;

    a.send('leave');
    const left = await a.expect('left');
    assert.equal(left.channel, null);

    // The other side sees the same person, now roomless — an upsert, not a departure.
    const update = await b.expect('peer_joined');
    assert.equal(update.peer.username, 'admin');
    assert.equal(update.peer.channelId, null);

    // Leaving twice is calm, and coming back works.
    a.send('leave');
    await a.expect('left');
    a.send('move', { channelId: general.id });
    const back = await a.expect('moved');
    assert.equal(back.channel.id, general.id);
});
