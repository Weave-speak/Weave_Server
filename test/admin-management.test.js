// The admin console's management surface, end to end against a running server.
//
// The behaviours that must hold are the human-visible ones: a reset user is kicked to
// the login screen NOW and asked for a new password NEXT time; a banned user cannot get
// back in; the wipe destroys every row, cuts every connection, and re-arms first-run —
// while the server itself survives.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-adm-'));
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

    const tokenFile = path.join(dir, 'data', 'setup-token');
    const code = fs.readFileSync(tokenFile, 'utf8').trim();
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
        const closed = { code: null, reason: null };
        const closeWaiters = [];
        ws.on('close', (c, r) => {
            closed.code = c;
            closed.reason = String(r);
            closeWaiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(closed); });
        });
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
        const expectClose = (ms = 5000) => {
            if (closed.code !== null) return Promise.resolve(closed);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
                closeWaiters.push({ resolve, timer });
            });
        };
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: 1 }));
        await expect('joined');
        return {
            ws, expect, expectClose,
            send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
        };
    };

    return {
        app, call, mint, connect, tokenFile,
        setupCode: code,
        adminId: admin.body.user.id,
        adminToken: admin.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

test('a graceful reset kicks the user out now and asks for a new password next time', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const live = await h.connect(kes.token);

    // No password in the body: the graceful form.
    const reset = await h.call('POST', `/api/admin/members/${kes.user.id}/reset-password`, {
        token: h.adminToken, body: {},
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.mustReset, true);

    // Kicked to the login screen: the live socket is cut and the old session is dead.
    const cut = await live.expectClose();
    assert.equal(cut.code, 4003);
    const stale = await h.call('GET', '/api/channels', { token: kes.token });
    assert.equal(stale.status, 401, 'the old session no longer works');

    // Signing in with the OLD password succeeds as proof — but yields a ticket, not a session.
    const attempt = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(attempt.status, 200);
    assert.equal(attempt.body.resetRequired, true);
    assert.ok(attempt.body.ticket);
    assert.ok(!attempt.body.token, 'no session until a new password is chosen');

    // A too-short replacement is refused, burning the single-use ticket.
    const weak = await h.call('POST', '/api/auth/complete-reset', {
        body: { ticket: attempt.body.ticket, password: 'short' },
    });
    assert.equal(weak.status, 400);
    const reuse = await h.call('POST', '/api/auth/complete-reset', {
        body: { ticket: attempt.body.ticket, password: 'a-brand-new-password' },
    });
    assert.equal(reuse.status, 401, 'a ticket is single-use — the failed try burned it');

    // Sign in again for a fresh ticket, then complete properly.
    const again = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(again.body.resetRequired, true);
    const finished = await h.call('POST', '/api/auth/complete-reset', {
        body: { ticket: again.body.ticket, password: 'a-brand-new-password' },
    });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.ok(finished.body.token);

    // The old password is gone; the new one signs in normally, no reset demanded.
    const old = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(old.status, 401);
    const fresh = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-brand-new-password' },
    });
    assert.equal(fresh.status, 200);
    assert.ok(fresh.body.token);
    assert.ok(!fresh.body.resetRequired);
});

test('ban cuts the user off entirely; unban lets them back in', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const live = await h.connect(kes.token);

    const ban = await h.call('POST', `/api/admin/members/${kes.user.id}/ban`, {
        token: h.adminToken, body: { banned: true },
    });
    assert.equal(ban.status, 200);
    const cut = await live.expectClose();
    assert.equal(cut.code, 4004);

    const refused = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(refused.status, 401, 'a banned account reads exactly like a wrong password');

    // The console shows the flag; you cannot ban yourself.
    const members = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    assert.equal(members.body.members.find((m) => m.username === 'kestrel').banned, true);
    const self = await h.call('POST', `/api/admin/members/${h.adminId}/ban`, {
        token: h.adminToken, body: { banned: true },
    });
    assert.equal(self.status, 400);

    const unban = await h.call('POST', `/api/admin/members/${kes.user.id}/ban`, {
        token: h.adminToken, body: { banned: false },
    });
    assert.equal(unban.status, 200);
    const back = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(back.status, 200);
});

test('the members list knows who invited whom; removal erases the account', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const members = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    const row = members.body.members.find((m) => m.username === 'kestrel');
    assert.equal(row.invitedBy, 'admin');
    assert.equal(members.body.members.find((m) => m.username === 'admin').invitedBy, null,
        'the first admin walked in through setup, invited by nobody');

    const gone = await h.call('DELETE', `/api/admin/members/${kes.user.id}`, { token: h.adminToken });
    assert.equal(gone.status, 200);
    const after = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    assert.ok(!after.body.members.some((m) => m.username === 'kestrel'));
    const dead = await h.call('GET', '/api/channels', { token: kes.token });
    assert.equal(dead.status, 401, 'their session died with the account');
});

test('clearing a channel empties its history for everyone, admins only', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const channels = (await h.call('GET', '/api/channels', { token: h.adminToken })).body.channels;
    const room = channels.find((c) => c.allowText);

    const a = await h.connect(h.adminToken);
    const b = await h.connect(kes.token);
    a.send('text-chat:send', { channelId: room.id, body: 'soon to vanish' });
    await a.expect('text-chat:accepted');
    await b.expect('text-chat:message');

    // Not an admin? Not a chance.
    const denied = await h.call('DELETE', `/api/chat/${room.id}/messages`, { token: kes.token });
    assert.equal(denied.status, 403);

    const cleared = await h.call('DELETE', `/api/chat/${room.id}/messages`, { token: h.adminToken });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.removed, 1);

    // Every open client is told to drop what it is showing, and history reads empty.
    const heard = await b.expect('text-chat:cleared');
    assert.equal(heard.channelId, room.id);
    const history = await h.call('GET', `/api/chat/${room.id}/messages`, { token: h.adminToken });
    assert.equal(history.body.messages.length, 0);
});

test('the wipe: one exact confirmation, then everything is gone and setup re-arms', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const live = await h.connect(kes.token);

    // The confirmation is the instance's exact name — anything else is refused.
    const wrong = await h.call('POST', '/api/admin/wipe', {
        token: h.adminToken, body: { confirm: 'weave' },
    });
    assert.equal(wrong.status, 400);

    const boom = await h.call('POST', '/api/admin/wipe', {
        token: h.adminToken, body: { confirm: 'Weave' },
    });
    assert.equal(boom.status, 200, JSON.stringify(boom.body));

    // Every connection dies, including the bystander's.
    const cut = await live.expectClose();
    assert.equal(cut.code, 4005);

    // Every credential is void — even the admin who pressed the button.
    await new Promise((r) => setTimeout(r, 300));
    const admin = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    assert.equal(admin.status, 401, 'the admin destroyed their own account too');
    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(login.status, 401);
    const kesLogin = await h.call('POST', '/api/auth/login', {
        body: { username: 'kestrel', password: 'a-long-enough-password' },
    });
    assert.equal(kesLogin.status, 401);

    // The server survives, back at first run: setup required, a fresh token on disk,
    // and the default channels reseeded for whoever builds it up again.
    const info = await h.call('GET', '/api/server-info');
    assert.equal(info.status, 200, 'the server itself remains');
    assert.equal(info.body.setupRequired, true);
    const rearmed = fs.readFileSync(h.tokenFile, 'utf8').trim();
    assert.ok(rearmed && rearmed !== h.setupCode, 'a fresh setup code was issued');

    const reborn = await h.call('POST', '/api/setup', {
        body: { code: rearmed, username: 'phoenix', password: 'a-long-enough-password' },
    });
    assert.equal(reborn.status, 201, JSON.stringify(reborn.body));
    const channels = await h.call('GET', '/api/channels', { token: reborn.body.token });
    assert.ok(channels.body.channels.length > 0, 'default channels are back');
});
