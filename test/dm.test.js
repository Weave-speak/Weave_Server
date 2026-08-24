// Direct messages, against a running server.
//
// The property that matters most is the boundary: a thread is readable and writable by its
// two participants and NOBODY else — not other members, not by guessing ids. Everything
// else (pagination shape, read markers, the pair being canonical) reuses contracts the
// channels already proved, tested here only where DMs differ.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-dm-'));
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
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: 1 }));
        await expect('joined');
        return {
            ws, expect,
            send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
            never: (type, ms = 700) => new Promise((resolve, reject) => setTimeout(() => {
                const hit = inbox.find((m) => m.type === type);
                return hit ? reject(new Error(`should not have received ${type}`)) : resolve();
            }, ms)),
        };
    };

    return {
        app, call, mint, connect,
        adminId: admin.body.user.id,
        adminToken: admin.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

test('a thread is a pair: same pair, same thread, whoever opens it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const first = await h.call('POST', '/api/dm/threads', {
        token: h.adminToken, body: { userId: kes.user.id },
    });
    assert.equal(first.status, 201);
    const second = await h.call('POST', '/api/dm/threads', {
        token: kes.token, body: { userId: h.adminId },
    });
    assert.equal(second.status, 200, 'opening it from the other side finds the same thread');
    assert.equal(second.body.thread.id, first.body.thread.id);

    const diary = await h.call('POST', '/api/dm/threads', {
        token: h.adminToken, body: { userId: h.adminId },
    });
    assert.equal(diary.status, 400, 'no threads with yourself');
});

test('messages flow between the two, and only the two', async (t) => {
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

    a.send('dm:send', { threadId: thread.id, body: 'a quiet word' });
    await a.expect('dm:accepted');
    const got = await b.expect('dm:message');
    assert.equal(got.message.body, 'a quiet word');
    await outsider.never('dm:message');

    // The outsider can neither write into it nor read its history.
    outsider.send('dm:send', { threadId: thread.id, body: 'let me in' });
    const refused = await outsider.expect('error');
    assert.equal(refused.code, 'no_thread');
    const peek = await h.call('GET', `/api/dm/threads/${thread.id}/messages`, { token: moth.token });
    assert.equal(peek.status, 404, 'not yours reads exactly like not real');

    // The participants CAN read it, newest page first, same contract as channels.
    const mine = await h.call('GET', `/api/dm/threads/${thread.id}/messages`, { token: kes.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.messages.at(-1).body, 'a quiet word');
});

test('the rail answers with unread counts, and reading clears them', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const thread = (await h.call('POST', '/api/dm/threads', {
        token: h.adminToken, body: { userId: kes.user.id },
    })).body.thread;

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);
    a.send('dm:send', { threadId: thread.id, body: 'one' });
    a.send('dm:send', { threadId: thread.id, body: 'two' });
    const last = (await b.expect('dm:message'), await b.expect('dm:message'));

    const before = await h.call('GET', '/api/dm/threads', { token: kes.token });
    assert.equal(before.body.threads[0].unread, 2);
    assert.equal(before.body.threads[0].other.username, 'admin');
    assert.equal(before.body.threads[0].other.presence, 'online');
    assert.equal(before.body.threads[0].preview.body, 'two');

    // Your own messages never count against you.
    const senders = await h.call('GET', '/api/dm/threads', { token: h.adminToken });
    assert.equal(senders.body.threads[0].unread, 0);

    b.send('dm:read', { threadId: thread.id, createdAt: last.message.createdAt, id: last.message.id });
    await new Promise((r) => setTimeout(r, 150));
    const after = await h.call('GET', '/api/dm/threads', { token: kes.token });
    assert.equal(after.body.threads[0].unread, 0);
});

test('a call is a hidden room: ring, accept, talk, end — invisible throughout', async (t) => {
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

    // A rings; A is moved into the call room; B hears the ring.
    a.send('dm:call', { threadId: thread.id });
    const ring = await b.expect('dm:ring');
    assert.equal(ring.from.username, 'admin');
    const aMoved = await a.expect('moved');
    assert.equal(aMoved.channel.system, true);
    assert.equal(aMoved.channel.private, true);

    // The room is listed to NOBODY — not the participants, not the outsider.
    for (const [who, token] of [['caller', h.adminToken], ['callee', kes.token], ['outsider', moth.token]]) {
        const channels = (await h.call('GET', '/api/channels', { token })).body.channels;
        assert.ok(!channels.some((c) => c.id === aMoved.channel.id), `${who} must not see the call room listed`);
    }
    // And the outsider reads the caller as merely online, nowhere.
    const seen = await outsider.expect('peer_joined');
    assert.equal(seen.peer.username, 'admin');
    assert.equal(seen.peer.channelId, null, 'the mask holds for call rooms');

    // B accepts: both stand together, both told live.
    b.send('dm:accept', { threadId: thread.id });
    const bMoved = await b.expect('moved');
    assert.equal(bMoved.channel.id, aMoved.channel.id);
    await a.expect('dm:call_live');
    await b.expect('dm:call_live');
    const together = bMoved.peers.find((p) => p.username === 'admin');
    assert.equal(together.channelId, aMoved.channel.id, 'members see each other in the call');

    // B hangs up (leaves): A is told the call ended, and the room dies once empty.
    b.send('leave');
    await b.expect('left');
    const ended = await a.expect('dm:call_ended');
    assert.equal(ended.reason, 'left');
    a.send('leave');
    await a.expect('left');
    await new Promise((r) => setTimeout(r, 2600));
    const after = await h.call('GET', '/api/channels', { token: h.adminToken });
    assert.ok(!after.body.channels.some((c) => c.id === aMoved.channel.id), 'the room is gone');
});

test('a declined ring ends cleanly for both sides', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const thread = (await h.call('POST', '/api/dm/threads', {
        token: h.adminToken, body: { userId: kes.user.id },
    })).body.thread;

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);
    a.send('dm:call', { threadId: thread.id });
    await b.expect('dm:ring');
    await a.expect('moved');
    b.send('dm:decline', { threadId: thread.id });
    const ended = await a.expect('dm:call_ended');
    assert.equal(ended.reason, 'declined');
    await b.expect('dm:call_ended');
});
