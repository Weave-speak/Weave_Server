// Bubbles, ported from the previous server: an administrator's photo bubbles, a few of
// which float at a time, each with a conversation that belongs to no channel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';
import { pickActive } from '../src/modules/bubbles/index.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-bubbles-'));
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
    const call = async (method, url, { body, token, raw } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
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

    const makeMember = async (username) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: { maxUses: 1 } });
        const reg = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username, password: 'another-long-password' },
        });
        assert.equal(reg.status, 201, JSON.stringify(reg.body));
        return reg.body.token;
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
            if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); } else inbox.push(msg);
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
        ws.send(JSON.stringify({ type: 'join', token, protocol: { min: 1, max: 1 } }));
        await expect('joined');
        return { ws, inbox, expect, send: (t, p = {}) => ws.send(JSON.stringify({ type: t, ...p })) };
    };

    return {
        call, connect, makeMember, token: admin.body.token,
        cleanup: async () => {
            for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

const pngBytes = () => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
]);

// ── which float ──────────────────────────────────────────────────────────────

test('a rotation floats between none and the most allowed, never a bubble twice', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const sizes = new Set();
    for (let i = 0; i < 400; i += 1) {
        const picked = pickActive(ids, 4);
        assert.ok(picked.length <= 4);
        assert.equal(new Set(picked).size, picked.length, 'no duplicates');
        assert.ok(picked.every((id) => ids.includes(id)));
        sizes.add(picked.length);
    }
    // Sometimes none, sometimes the most — the web app's surprise, not furniture.
    assert.ok(sizes.has(0) && sizes.has(4), `saw sizes ${[...sizes]}`);
    assert.deepEqual(pickActive(['a'], 4, () => 0.99), ['a'], 'never more than exist');
    assert.deepEqual(pickActive(ids, 0), []);
});

// ── end to end ───────────────────────────────────────────────────────────────

test('an administrator makes a bubble, and everybody hears about it', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const info = await h.call('GET', '/api/server-info');
    assert.ok(info.body.features.includes('bubbles'));

    const watcher = await h.connect(await h.makeMember('watcher'));
    const made = await h.call('POST', '/api/bubbles?name=Holiday', { token: h.token, raw: pngBytes() });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await watcher.expect('bubbles:created')).bubble.name, 'Holiday');
    // A new bubble gets its chance to float straight away.
    assert.ok(Array.isArray((await watcher.expect('bubbles:active')).ids));

    const photo = await h.call('GET', made.body.bubble.photo, { token: h.token });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
});

test('only an administrator makes one, and only from a real image', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const member = await h.makeMember('member');
    assert.equal((await h.call('POST', '/api/bubbles?name=X', { token: member, raw: pngBytes() })).status, 403);
    assert.equal((await h.call('POST', '/api/bubbles?name=X', { token: h.token, raw: Buffer.from('not an image at all') })).status, 415);
    assert.equal((await h.call('POST', '/api/bubbles', { token: h.token, raw: pngBytes() })).status, 400, 'a name is required');
});

test('talking in a bubble reaches everyone, and is unread only to the others', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const made = await h.call('POST', '/api/bubbles?name=Cats', { token: h.token, raw: pngBytes() });
    const id = made.body.bubble.id;

    const otherToken = await h.makeMember('other');
    const speaker = await h.connect(h.token);
    const other = await h.connect(otherToken);

    speaker.send('bubbles:send', { bubbleId: id, body: 'look at this one' });
    const heard = await other.expect('bubbles:message');
    assert.equal(heard.message.body, 'look at this one');
    assert.equal(heard.message.bubbleId, id);
    await speaker.expect('bubbles:accepted');

    const mine = (await h.call('GET', '/api/bubbles', { token: h.token })).body.bubbles.find((b) => b.id === id);
    const theirs = (await h.call('GET', '/api/bubbles', { token: otherToken })).body.bubbles.find((b) => b.id === id);
    assert.equal(mine.unread, false, 'your own words are never news to you');
    assert.equal(theirs.unread, true);

    other.send('bubbles:read', { bubbleId: id, id: heard.message.id });
    // A round trip, so the read has landed before it is checked.
    other.send('ping', { t: Date.now() });
    await other.expect('pong');
    const after = (await h.call('GET', '/api/bubbles', { token: otherToken })).body.bubbles.find((b) => b.id === id);
    assert.equal(after.unread, false);

    const history = await h.call('GET', `/api/bubbles/${id}/messages`, { token: otherToken });
    assert.deepEqual(history.body.messages.map((m) => m.body), ['look at this one']);
});

test('clearing empties a bubble; deleting removes it, for everyone', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const made = await h.call('POST', '/api/bubbles?name=Temp', { token: h.token, raw: pngBytes() });
    const id = made.body.bubble.id;
    const a = await h.connect(h.token);
    a.send('bubbles:send', { bubbleId: id, body: 'soon gone' });
    await a.expect('bubbles:message');

    assert.equal((await h.call('POST', `/api/bubbles/${id}/clear`, { token: h.token })).status, 200);
    assert.equal((await a.expect('bubbles:cleared')).id, id);
    assert.deepEqual((await h.call('GET', `/api/bubbles/${id}/messages`, { token: h.token })).body.messages, []);
    assert.ok((await h.call('GET', '/api/bubbles', { token: h.token })).body.bubbles.some((b) => b.id === id),
        'clearing keeps the bubble');

    assert.equal((await h.call('DELETE', `/api/bubbles/${id}`, { token: h.token })).status, 200);
    assert.equal((await a.expect('bubbles:deleted')).id, id);
    assert.equal((await h.call('GET', `/api/bubbles/${id}/photo`, { token: h.token })).status, 404);

    a.send('bubbles:send', { bubbleId: id, body: 'too late' });
    assert.equal((await a.expect('error')).code, 'no_bubble');
});
