// Chat decoupled from presence, the way Discord works: you stand in one voice room and
// read or write in any text channel. These tests pin the three properties that make that
// real — writing somewhere you are not standing, hearing about it from wherever you
// stand, and the per-account unread/mention state that badges are made of.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-browse-'));
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
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const guest = await call('POST', '/api/auth/register', {
        body: { inviteCode: invite.body.invite.code, username: 'guest', password: 'a-long-enough-password' },
    });
    assert.equal(guest.status, 201, JSON.stringify(guest.body));

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
        const joined = await expect('joined');
        const send = (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload }));
        return { ws, expect, send, joined };
    };

    return {
        app, base, call,
        adminToken: admin.body.token,
        guestToken: guest.body.token,
        connect,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

test('text channels are read from anywhere and written from anywhere, never stood in', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    // The server says so up front.
    const info = await h.call('GET', '/api/server-info');
    assert.ok(info.body.features.includes('chat.browse'), info.body.features.join(','));

    const made = await h.call('POST', '/api/channels', {
        token: h.adminToken, body: { name: 'notes', kind: 'text' },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const notes = made.body.channel;

    const a = await h.connect(h.adminToken);   // admin stands in General
    const b = await h.connect(h.guestToken);   // guest stands in General too

    // Standing in a text channel is refused — there is nothing there to stand on.
    a.send('move', { channelId: notes.id });
    const refusal = await a.expect('error');
    assert.equal(refusal.code, 'text_channel', JSON.stringify(refusal));

    // Writing into it from a voice room works, and the broadcast reaches someone who is
    // ALSO not in it — that broadcast is what unread badges are made of.
    a.send('text-chat:send', { channelId: notes.id, body: 'hello @guest, from the general room' });
    await a.expect('text-chat:accepted');
    const heard = await b.expect('text-chat:message');
    assert.equal(heard.message.channelId, notes.id);
    assert.deepEqual(heard.message.mentions, ['guest'], 'the server resolved the mention');

    // The guest's account now owes one unread and one mention in that channel.
    const before = await h.call('GET', '/api/chat/reads', { token: h.guestToken });
    const forNotes = before.body.channels.find((c) => c.channelId === notes.id);
    assert.equal(forNotes.unread, 1, JSON.stringify(before.body));
    assert.equal(forNotes.mentions, 1);

    // Acking the read clears both, account-wide.
    b.send('text-chat:read', { channelId: notes.id, createdAt: heard.message.createdAt, id: heard.message.id });
    await new Promise((r) => setTimeout(r, 150));
    const after = await h.call('GET', '/api/chat/reads', { token: h.guestToken });
    const cleared = after.body.channels.find((c) => c.channelId === notes.id);
    assert.equal(cleared.unread, 0);
    assert.equal(cleared.mentions, 0);

    // A stale ack cannot resurrect the badge.
    b.send('text-chat:read', { channelId: notes.id, createdAt: heard.message.createdAt - 5000, id: 'older' });
    await new Promise((r) => setTimeout(r, 150));
    const still = await h.call('GET', '/api/chat/reads', { token: h.guestToken });
    assert.equal(still.body.channels.find((c) => c.channelId === notes.id).unread, 0);
});

test('a client that names no channel still lands in its own room', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const a = await h.connect(h.adminToken);
    const general = a.joined.channel;

    a.send('text-chat:send', { body: 'plain old message' });
    await a.expect('text-chat:accepted');
    const page = await h.call('GET', `/api/chat/${general.id}/messages`, { token: h.adminToken });
    assert.equal(page.body.messages.at(-1).body, 'plain old message');
});
