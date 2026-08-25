// Reactions, typing, and the room topic — the light social layer.
//
// The properties that matter: a reaction is a TOGGLE with one row of truth and a small
// broadcast delta; typing is relayed and forgotten (stored nowhere, throttled at the
// server, never echoed to its sender); a topic is a channel property any admin can set
// and every client sees.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-soc-'));
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

    const mint = async (name) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username: name, password: 'a-long-enough-password' },
        });
        assert.equal(user.status, 201, JSON.stringify(user.body));
        return user.body;
    };

    const sockets = [];
    const connect = async (token) => {
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
        const never = (type, ms = 700) => new Promise((resolve, reject) => setTimeout(() => {
            const hit = inbox.find((m) => m.type === type);
            return hit ? reject(new Error(`should not have received ${type}`)) : resolve();
        }, ms));
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: 1 }));
        await expect('joined');
        return {
            ws, expect, never,
            send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
        };
    };

    return {
        app, call, mint, connect,
        adminToken: admin.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

async function seedMessage(h, socket, channelId, body = 'react to this') {
    socket.send('text-chat:send', { channelId, body });
    const ack = await socket.expect('text-chat:accepted');
    return ack.id;
}

test('a reaction is a toggle: on, broadcast, off again, and history aggregates it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const room = (await h.call('GET', '/api/channels', { token: h.adminToken }))
        .body.channels.find((c) => c.allowText);

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);
    const messageId = await seedMessage(h, a, room.id);
    await b.expect('text-chat:message');

    // kestrel reacts: the sender gets an ack, everyone else the delta.
    b.send('reactions:react', { messageId, emoji: '🔥' });
    const ack = await b.expect('reactions:accepted');
    assert.equal(ack.on, true);
    const delta = await a.expect('reactions:changed');
    assert.deepEqual(
        { emoji: delta.emoji, count: delta.count, on: delta.on, username: delta.username },
        { emoji: '🔥', count: 1, on: true, username: 'kestrel' });

    // The admin piles on: count reaches 2. History answers aggregated, with "mine".
    a.send('reactions:react', { messageId, emoji: '🔥' });
    await a.expect('reactions:accepted');
    // The delta goes to EVERYONE, actor included — it carries the count, and one code
    // path updating every client (yourself included) beats two.
    await a.expect('reactions:changed');
    await b.expect('reactions:changed');
    const agg = await h.call('GET', `/api/reactions?messageIds=${messageId}`, { token: kes.token });
    assert.deepEqual(agg.body.reactions[messageId], [{ emoji: '🔥', count: 2, mine: true }]);

    // Toggling again removes exactly one person's reaction.
    b.send('reactions:react', { messageId, emoji: '🔥' });
    const off = await b.expect('reactions:accepted');
    assert.equal(off.on, false);
    const down = await a.expect('reactions:changed');
    assert.equal(down.count, 1);

    // Garbage is refused without touching anything.
    b.send('reactions:react', { messageId, emoji: 'not an emoji' });
    const refused = await b.expect('error');
    assert.equal(refused.code, 'bad_emoji');
    b.send('reactions:react', { messageId: 'no-such-message', emoji: '🔥' });
    const missing = await b.expect('error');
    assert.equal(missing.code, 'no_message');
});

test('a message holds at most twelve distinct emoji', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const room = (await h.call('GET', '/api/channels', { token: h.adminToken }))
        .body.channels.find((c) => c.allowText);
    const a = await h.connect(h.adminToken);
    const messageId = await seedMessage(h, a, room.id);

    const EMOJI = ['😀', '😂', '❤️', '🔥', '👍', '👀', '🎉', '😮', '😢', '💯', '✅', '🚀'];
    for (const e of EMOJI) {
        a.send('reactions:react', { messageId, emoji: e });
        await a.expect('reactions:accepted');
    }
    a.send('reactions:react', { messageId, emoji: '🐟' });
    const full = await a.expect('error');
    assert.equal(full.code, 'too_many');
});

test('typing is relayed to others, throttled, never echoed, and stored nowhere', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const room = (await h.call('GET', '/api/channels', { token: h.adminToken }))
        .body.channels.find((c) => c.allowText);

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);

    a.send('text-chat:typing', { channelId: room.id });
    const seen = await b.expect('text-chat:typing');
    assert.equal(seen.username, 'admin');
    assert.equal(seen.channelId, room.id);
    await a.never('text-chat:typing', 400);   // your own typing is not news to you

    // A burst inside the throttle window relays exactly once.
    a.send('text-chat:typing', { channelId: room.id });
    a.send('text-chat:typing', { channelId: room.id });
    await b.never('text-chat:typing', 700);
});

test('dm typing reaches only the other participant', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const moth = await h.mint('moth');
    const thread = (await h.call('POST', '/api/dm/threads', {
        token: h.adminToken, body: { userId: kes.user.id },
    })).body.thread;

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);
    const outsider = await h.connect(moth.token);

    a.send('dm:typing', { threadId: thread.id });
    const seen = await b.expect('dm:typing');
    assert.equal(seen.threadId, thread.id);
    assert.equal(seen.username, 'admin');
    await outsider.never('dm:typing');

    // An outsider poking a thread relays to nobody.
    outsider.send('dm:typing', { threadId: thread.id });
    await b.never('dm:typing', 600);
});

test('a topic is set by an admin, capped, and visible to everyone', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const room = (await h.call('GET', '/api/channels', { token: h.adminToken }))
        .body.channels.find((c) => c.allowText);

    const set = await h.call('PUT', `/api/channels/${room.id}`, {
        token: h.adminToken, body: { topic: 'plans, chaos, and everything else' },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.channel.topic, 'plans, chaos, and everything else');

    const seen = (await h.call('GET', '/api/channels', { token: kes.token }))
        .body.channels.find((c) => c.id === room.id);
    assert.equal(seen.topic, 'plans, chaos, and everything else');

    const tooLong = await h.call('PUT', `/api/channels/${room.id}`, {
        token: h.adminToken, body: { topic: 'x'.repeat(200) },
    });
    assert.equal(tooLong.status, 400);
    const mortal = await h.call('PUT', `/api/channels/${room.id}`, {
        token: kes.token, body: { topic: 'coup' },
    });
    assert.equal(mortal.status, 403, 'only admins arrange the furniture');
});
