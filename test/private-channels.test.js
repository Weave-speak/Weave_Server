// Private rooms, against a running server.
//
// The property under test is the boundary: occupants invisible to non-members on every
// surface a peer can appear on — the fresh-join roster, live upserts, the members API —
// and the doors held shut: no joining, no text, membership only through a member. The
// lifecycle (the 2-hour reaper) is exercised by planting an old empty room and forcing a
// sweep, because nobody wants a 2-hour test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-private-'));
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
    const mint = async (name) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username: name, password: 'a-long-enough-password' },
        });
        assert.equal(user.status, 201);
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
        const joined = await expect('joined');
        return { ws, expect, joined, send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })) };
    };

    return {
        app, dir, call, mint, connect,
        adminToken: admin.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

test('a member starts a huddle; every surface keeps its secret from outsiders', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const moth = await h.mint('moth');

    const info = await h.call('GET', '/api/server-info');
    assert.ok(info.body.features.includes('channels.private'));

    // A NON-admin creates it — huddles are everyone's.
    const made = await h.call('POST', '/api/channels', {
        token: kes.token, body: { name: 'the-plot', private: true },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const room = made.body.channel;
    assert.equal(room.private, true);
    assert.equal(room.allowText, false, 'no text in private rooms, ever');
    assert.equal(room.member, true);

    // But not a public one.
    const publicTry = await h.call('POST', '/api/channels', {
        token: kes.token, body: { name: 'sneaky-public' },
    });
    assert.equal(publicTry.status, 403);

    // The maker stands inside.
    const a = await h.connect(kes.token);
    a.send('move', { channelId: room.id });
    await a.expect('moved');

    // A fresh outsider: the room is listed (a visible locked door), membership false,
    // and the maker READS AS ROOMLESS on the join roster.
    const list = await h.call('GET', '/api/channels', { token: moth.token });
    const seen = list.body.channels.find((c) => c.id === room.id);
    assert.equal(seen.private, true);
    assert.equal(seen.member, false);

    const b = await h.connect(moth.token);
    const masked = b.joined.peers.find((p) => p.username === 'kestrel');
    assert.equal(masked.channelId, null, 'the occupant is invisible as an occupant');

    // The doors: no joining, no text, no member list.
    b.send('move', { channelId: room.id });
    const refusal = await b.expect('error');
    assert.equal(refusal.code, 'not_a_member');
    b.send('text-chat:send', { channelId: room.id, body: 'knock knock' });
    const noText = await b.expect('error');
    assert.equal(noText.code, 'text_not_allowed');
    const peek = await h.call('GET', `/api/channels/${room.id}/members`, { token: moth.token });
    assert.equal(peek.status, 404, 'not a member reads exactly like not real');

    // A member lets them in; the same doors now open.
    const add = await h.call('POST', `/api/channels/${room.id}/members`, {
        token: kes.token, body: { userId: moth.user.id },
    });
    assert.equal(add.status, 200);
    const fresh = await b.expect('channels');
    assert.equal(fresh.channels.find((c) => c.id === room.id).member, true,
        'the sidebar learns about the new membership at once');
    b.send('move', { channelId: room.id });
    const entered = await b.expect('moved');
    assert.equal(entered.channel.id, room.id);
    const together = entered.peers.find((p) => p.username === 'kestrel');
    assert.equal(together.channelId, room.id, 'members see each other where they really are');
});

test('an empty huddle past the window is reaped; an occupied one never is', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const made = await h.call('POST', '/api/channels', {
        token: kes.token, body: { name: 'stale-plot', private: true },
    });
    const staying = await h.call('POST', '/api/channels', {
        token: kes.token, body: { name: 'live-plot', private: true },
    });

    // Somebody is IN live-plot; stale-plot stands empty. Age both stamps past any window.
    const a = await h.connect(kes.token);
    a.send('move', { channelId: staying.body.channel.id });
    await a.expect('moved');

    const db = new Database(path.join(h.dir, 'data', 'weave.db'));
    db.prepare('UPDATE channels SET last_occupied_at = ? WHERE private = 1')
        .run(Date.now() - 8 * 60 * 60 * 1000);
    db.close();

    // The sweep runs at module registration: bounce the module.
    await h.call('POST', '/api/admin/modules/private-channels/disable', { token: h.adminToken });
    await h.call('POST', '/api/admin/modules/private-channels/enable', { token: h.adminToken });

    const after = await h.call('GET', '/api/channels', { token: kes.token });
    const names = after.body.channels.map((c) => c.name);
    assert.ok(!names.includes('stale-plot'), 'the empty room is gone');
    assert.ok(names.includes('live-plot'), 'the occupied room survives, whatever its stamp says');
});
