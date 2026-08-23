// The feature modules, exercised against a running server.
//
// The point of these is not only that each feature works, but that each one is genuinely
// detachable: disabling a module has to remove its HTTP routes and its WebSocket message
// types, and leave everything else running.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { start } from '../src/index.js';

async function freePort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
}

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-mod-'));
    const httpPort = await freePort();
    const mediaPort = await freePort();

    const app = await start({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_HTTP_BIND: '127.0.0.1',
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
        WEAVE_DATA_DIR: path.join(dir, 'data'),
        WEAVE_LOG_DIR: path.join(dir, 'logs'),
        WEAVE_LOG_LEVEL: 'silent',
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const call = async (method, url, { body, token, raw, contentType } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(contentType ? { 'Content-Type': contentType } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: raw ?? (body ? JSON.stringify(body) : undefined),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed, headers: res.headers };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    const channels = (await call('GET', '/api/channels', { token: admin.body.token })).body.channels;

    const sockets = [];
    const connect = async (token, channelId) => {
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
        ws.send(JSON.stringify({ type: 'join', token, channelId, protocol: { min: 1, max: 1 } }));
        const joined = await expect('joined');
        return { ws, expect, joined, send: (t, p = {}) => ws.send(JSON.stringify({ type: t, ...p })) };
    };

    return {
        app, call, connect, channels, token: admin.body.token,
        cleanup: async () => {
            for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** A buffer whose leading bytes are a real PNG signature. */
const pngBytes = () => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
]);

// ── text chat ────────────────────────────────────────────────────────────────

test('a message is broadcast to the channel and stored', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect(h.token);
    a.send('text-chat:send', { body: 'hello everyone' });

    const accepted = await a.expect('text-chat:accepted');
    assert.ok(accepted.id);

    const history = await h.call('GET', `/api/chat/${a.joined.channel.id}/messages`, { token: h.token });
    assert.equal(history.status, 200);
    assert.equal(history.body.messages.at(-1).body, 'hello everyone');
    // Denormalised, so history still renders for someone who has since left.
    assert.equal(history.body.messages.at(-1).authorName, 'admin');
});

test('an over-long message is refused rather than silently truncated', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect(h.token);
    a.send('text-chat:send', { body: 'x'.repeat(5000) });

    const err = await a.expect('error');
    assert.equal(err.code, 'too_long');
});

test('a channel with text disabled refuses messages', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const away = h.channels.find((c) => c.kind === 'afk');
    assert.equal(away.allowText, false);

    const a = await h.connect(h.token, away.id);
    a.send('text-chat:send', { body: 'anyone there' });

    const err = await a.expect('error');
    assert.equal(err.code, 'text_not_allowed');
});

test('history pages backwards without skipping or repeating', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect(h.token);
    for (let i = 0; i < 12; i += 1) {
        a.send('text-chat:send', { body: `message ${i}` });
        await a.expect('text-chat:accepted');
    }

    const first = await h.call('GET', `/api/chat/${a.joined.channel.id}/messages?limit=5`, { token: h.token });
    assert.equal(first.body.messages.length, 5);

    const second = await h.call('GET',
        `/api/chat/${a.joined.channel.id}/messages?limit=5`
        + `&before=${first.body.nextBefore}&beforeId=${first.body.nextBeforeId}`,
        { token: h.token });

    const idsA = first.body.messages.map((m) => m.id);
    const idsB = second.body.messages.map((m) => m.id);
    assert.equal(idsB.length, 5);
    // A cursor rather than an offset, so pages cannot overlap as new messages arrive.
    assert.equal(idsA.filter((id) => idsB.includes(id)).length, 0);
});

test('history is stable when many messages share one millisecond', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect(h.token);
    const channel = a.joined.channel.id;

    // Force the exact condition the cursor has to survive. Timestamps are millisecond
    // resolution, so a burst of messages genuinely does land on the same value in
    // production — this just makes it deterministic instead of waiting for bad luck.
    const stamp = Date.now();
    const insert = h.app.db.prepare(`
        INSERT INTO chat_messages (id, channel_id, user_id, author_name, body, created_at)
        VALUES (?, ?, 'u', 'tester', ?, ?)
    `);
    for (let i = 0; i < 10; i += 1) {
        insert.run(`tie-${String(i).padStart(2, '0')}`, channel, `tied ${i}`, stamp);
    }

    const seen = [];
    let before = null;
    let beforeId = null;

    for (let pageNo = 0; pageNo < 5; pageNo += 1) {
        const qs = `limit=3${before ? `&before=${before}&beforeId=${beforeId}` : ''}`;
        const res = await h.call('GET', `/api/chat/${channel}/messages?${qs}`, { token: h.token });
        seen.push(...res.body.messages.map((m) => m.id));
        if (!res.body.nextBefore) break;
        before = res.body.nextBefore;
        beforeId = res.body.nextBeforeId;
    }

    const tied = seen.filter((id) => id.startsWith('tie-'));
    assert.equal(new Set(tied).size, tied.length, 'no message appears on two pages');
    assert.equal(new Set(tied).size, 10, 'no message is skipped between pages');
});

// ── uploads ──────────────────────────────────────────────────────────────────

test('an image is accepted and served back', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const up = await h.call('POST', '/api/uploads', {
        token: h.token, raw: pngBytes(), contentType: 'application/octet-stream',
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.mime, 'image/png');

    const fetched = await h.call('GET', up.body.url, { token: h.token });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'image/png');
    assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
});

test('a non-image is refused whatever it claims to be', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Declares itself an image; is not one. The declaration is never consulted.
    const res = await h.call('POST', '/api/uploads', {
        token: h.token,
        raw: Buffer.from('<?php system($_GET["c"]); ?>            '),
        contentType: 'image/png',
    });
    assert.equal(res.status, 415);
});

test('uploads are not readable without signing in', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const up = await h.call('POST', '/api/uploads', {
        token: h.token, raw: pngBytes(), contentType: 'application/octet-stream',
    });
    // The previous server served these to anyone who had the URL.
    assert.equal((await h.call('GET', up.body.url)).status, 401);
});

// ── afk ──────────────────────────────────────────────────────────────────────

test('the away opt-out is stored per account', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    assert.equal((await h.call('GET', '/api/afk/opt-out', { token: h.token })).body.optedOut, false);

    await h.call('POST', '/api/afk/opt-out', { token: h.token, body: { optedOut: true } });
    assert.equal((await h.call('GET', '/api/afk/opt-out', { token: h.token })).body.optedOut, true);
});

// ── detachability ────────────────────────────────────────────────────────────

test('disabling a module removes its routes and message types, leaving the rest', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Both live to begin with.
    assert.equal((await h.call('GET', '/api/afk/opt-out', { token: h.token })).status, 200);
    const before = await h.call('GET', '/api/server-info');
    assert.ok(before.body.features.includes('module.text-chat'));

    const off = await h.call('POST', '/api/admin/modules/text-chat/disable', { token: h.token });
    assert.equal(off.status, 200);

    // Its route is gone...
    const chan = h.channels[0].id;
    assert.equal((await h.call('GET', `/api/chat/${chan}/messages`, { token: h.token })).status, 404);

    // ...its message type is refused explicitly...
    const a = await h.connect(h.token);
    a.send('text-chat:send', { body: 'still there?' });
    assert.equal((await a.expect('error')).code, 'unknown_type');

    // ...it stops being advertised...
    const after = await h.call('GET', '/api/server-info');
    assert.ok(!after.body.features.includes('module.text-chat'));

    // ...and everything else carries on.
    assert.equal((await h.call('GET', '/api/afk/opt-out', { token: h.token })).status, 200);
    assert.equal((await h.call('GET', '/healthz')).status, 200);
});

test('re-enabling a module restores it with its data intact', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const a = await h.connect(h.token);
    a.send('text-chat:send', { body: 'written before the module was turned off' });
    await a.expect('text-chat:accepted');
    const chan = a.joined.channel.id;

    await h.call('POST', '/api/admin/modules/text-chat/disable', { token: h.token });
    await h.call('POST', '/api/admin/modules/text-chat/enable', { token: h.token });

    const history = await h.call('GET', `/api/chat/${chan}/messages`, { token: h.token });
    assert.equal(history.status, 200);
    // Disable is not destroy: the tables were left alone.
    assert.equal(history.body.messages.at(-1).body, 'written before the module was turned off');
});
