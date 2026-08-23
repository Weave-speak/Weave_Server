// The admin console's API.
//
// This surface is powerful — a generic table browser with edit and delete, over the same
// database that holds every password hash. So most of what is tested here is what it
// REFUSES to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-admin-'));
    let httpPort;
    let mediaPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        mediaPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(mediaPort),
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
            redirect: 'manual',
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed, headers: res.headers, text };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: {
            code,
            username: 'admin',
            password: 'a-long-enough-password',
            recoveryPhrase: 'three brass hinges on a door',
        },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    const invite = await call('POST', '/api/invites', { token: admin.body.token, body: { maxUses: 1 } });
    const member = await call('POST', '/api/auth/register', {
        body: {
            inviteCode: invite.body.invite.code,
            username: 'ordinary',
            password: 'another-long-password',
        },
    });
    assert.equal(member.status, 201, JSON.stringify(member.body));

    return {
        app, call,
        adminToken: admin.body.token,
        memberToken: member.body.token,
        cleanup: async () => {
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test('every admin route refuses an ordinary member', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const routes = [
        ['GET', '/api/admin/overview'],
        ['GET', '/api/admin/tables'],
        ['GET', '/api/admin/tables/users'],
        ['GET', '/api/admin/members'],
        ['GET', '/api/admin/peers'],
        ['GET', '/api/admin/audit'],
        ['GET', '/api/admin/logs'],
        ['GET', '/api/admin/settings'],
    ];

    for (const [method, url] of routes) {
        const asMember = await h.call(method, url, { token: h.memberToken });
        const anonymous = await h.call(method, url);
        assert.equal(asMember.status, 403, `${url} should be 403 for a member`);
        assert.equal(anonymous.status, 401, `${url} should be 401 for anonymous`);
    }
});

test('password and recovery hashes never reach the browser', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/admin/tables/users', { token: h.adminToken });
    assert.equal(res.status, 200);

    // The columns are still described, so the console can show that something is there.
    const secret = res.body.columns.filter((c) => c.secret).map((c) => c.name);
    assert.deepEqual(secret.sort(), ['password_hash', 'recovery_hash']);

    for (const row of res.body.rows) {
        assert.equal(row.password_hash, null);
        assert.equal(row.recovery_hash, null);
    }
    // The blunt check: no argon2 string anywhere in the payload, however it got there.
    assert.ok(!res.text.includes('$argon2'), 'no hash appears in the response at all');
});

test('session token hashes are not browsable either', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/admin/tables/sessions', { token: h.adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.columns.find((c) => c.name === 'token_hash')?.secret, 'marked secret');
    for (const row of res.body.rows) assert.equal(row.token_hash, null);
});

test('a secret column cannot be written through the table editor', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const users = await h.call('GET', '/api/admin/tables/users', { token: h.adminToken });
    const rowid = users.body.rows[0]._rowid;

    const res = await h.call('PUT', `/api/admin/tables/users/${rowid}`, {
        token: h.adminToken,
        body: { password_hash: 'anything-i-like' },
    });

    // Refused loudly, not ignored quietly: silently dropping it would let someone believe
    // they had set a password when they had not.
    assert.equal(res.status, 403);
    assert.match(res.body.message, /cannot be edited here/);
});

test('an ordinary column can be edited', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const before = await h.call('GET', '/api/admin/tables/channels', { token: h.adminToken });
    const row = before.body.rows[0];

    const res = await h.call('PUT', `/api/admin/tables/channels/${row._rowid}`, {
        token: h.adminToken, body: { name: 'Renamed Room' },
    });
    assert.equal(res.status, 200);

    const after = await h.call('GET', '/api/admin/tables/channels', { token: h.adminToken });
    assert.equal(after.body.rows.find((r) => r._rowid === row._rowid).name, 'Renamed Room');
});

test('an unknown table is refused rather than interpolated', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // The table name never becomes SQL: it is matched against the real schema first.
    for (const name of ['nope', 'users; DROP TABLE users', 'sqlite_master', '_migrations']) {
        const res = await h.call('GET', `/api/admin/tables/${encodeURIComponent(name)}`, { token: h.adminToken });
        assert.equal(res.status, 404, `${name} should be refused`);
    }

    // And the real table is still there.
    const users = await h.call('GET', '/api/admin/tables/users', { token: h.adminToken });
    assert.equal(users.status, 200);
});

test('search is parameterised, not concatenated', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', "/api/admin/tables/users?q=%25'%20OR%201%3D1%20--", { token: h.adminToken });
    assert.equal(res.status, 200);
    // A quote in the search term is a search term, not syntax.
    assert.equal(res.body.rows.length, 0);
});

test('the overview reports how the media address was decided', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/admin/overview', { token: h.adminToken });
    assert.equal(res.status, 200);

    assert.equal(res.body.media.announcedSource, 'configured');
    assert.equal(res.body.media.ports.length, 1);
    assert.equal(res.body.database.healthy, true);
    assert.ok(res.body.counts.users >= 2);
});

test('resetting a password signs that account out everywhere', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    assert.equal((await h.call('GET', '/api/me', { token: h.memberToken })).status, 200);

    const members = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    const target = members.body.members.find((m) => m.username === 'ordinary');

    const res = await h.call('POST', `/api/admin/members/${target.id}/reset-password`, {
        token: h.adminToken, body: { password: 'a-fresh-long-password' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.sessionsRevoked >= 1);

    assert.equal((await h.call('GET', '/api/me', { token: h.memberToken })).status, 401);
});

test('an administrator cannot remove their own access', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const me = await h.call('GET', '/api/me', { token: h.adminToken });
    const res = await h.call('POST', `/api/admin/members/${me.body.user.id}/admin`, {
        token: h.adminToken, body: { isAdmin: false },
    });

    // The classic way to lock yourself out of your own server.
    assert.equal(res.status, 400);
    assert.match(res.body.message, /your own administrator access/);
});

test('the members view blends stored accounts with live presence', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/admin/members', { token: h.adminToken });
    assert.equal(res.status, 200);

    for (const m of res.body.members) {
        // Nobody is connected in this test, so everyone is offline — the point is that
        // the field exists and is derived, not stored.
        assert.equal(m.state, 'offline');
        assert.equal(m.channelId, null);
        assert.ok('lastSeenAt' in m, 'last seen is selected, not silently missing');
    }
});

test('the console is served, and cannot be used to read outside itself', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const page = await h.call('GET', '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    // The admin panel is the page where an injected script would do most damage.
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    for (const attempt of ['..%2fpackage.json', '..%2F..%2Fpackage.json', '%2e%2e%2fpackage.json']) {
        const res = await h.call('GET', `/admin/${attempt}`);
        assert.ok(res.status === 403 || res.status === 404, `${attempt} -> ${res.status}`);
        assert.ok(!res.text.includes('"name": "weave-server"'), 'package.json must not be readable');
    }
});

test('HEAD is answered by the GET route', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Proxies and health checks use HEAD; falling through to 405 makes a healthy server
    // look broken to anything in front of it.
    assert.equal((await h.call('HEAD', '/healthz')).status, 200);
    assert.equal((await h.call('HEAD', '/admin')).status, 200);
});
