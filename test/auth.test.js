// End-to-end auth: first-run setup, login, invites, registration, recovery.
//
// These drive the real HTTP server over a real socket against a real SQLite file,
// because the things most likely to break here — cookie flags, status codes, the
// single-use invite race, rate limiting — are exactly the things a mocked test would
// assert into existence rather than verify.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-auth-'));

    // Ports are chosen inside the builder so a retry gets fresh ones rather than the pair
    // that just lost a race. The media port is set explicitly because the default is a
    // fixed number, which every test file would otherwise fight over.
    let port;
    let mediaPort;

    const app = await startWithRetry(async () => {
        port = await freePort();
        mediaPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(port),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(mediaPort),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        };
    });

    const base = `http://127.0.0.1:${port}`;
    const call = async (method, url, { body, token, cookie } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    };

    // The token is written to the data directory precisely so an admin who scrolled past
    // the banner can recover it; reading it here exercises that path too.
    const setupCode = () => fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();

    return {
        app, call, setupCode,
        cleanup: async () => {
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Complete first-run setup and return the admin's bearer token. */
async function bootstrapAdmin(h, overrides = {}) {
    const res = await h.call('POST', '/api/setup', {
        body: {
            code: h.setupCode(),
            username: 'rootadmin',
            displayName: 'Root Admin',
            password: 'a-long-enough-password',
            recoveryPhrase: 'seven jealous otters argue loudly',
            ...overrides,
        },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.token;
}

test('a fresh server reports that setup is required', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/server-info');
    assert.equal(res.status, 200);
    assert.equal(res.body.setupRequired, true);
    assert.equal(res.body.instance.registration, 'invite_only');
    // Range, not a single number — clients negotiate an overlap rather than demanding equality.
    assert.equal(typeof res.body.protocol.min, 'number');
    assert.equal(typeof res.body.protocol.max, 'number');
});

test('setup rejects a wrong code and accepts the right one', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const bad = await h.call('POST', '/api/setup', {
        body: { code: 'WRON-GCOD-EWRO-NGCO', username: 'x', password: 'a-long-enough-password' },
    });
    assert.equal(bad.status, 401);

    const token = await bootstrapAdmin(h);
    assert.ok(token, 'setup returns a session token');

    const info = await h.call('GET', '/api/server-info');
    assert.equal(info.body.setupRequired, false);
});

test('setup cannot be run twice', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    // 410 Gone, not 401: the window is closed permanently, and saying so is more useful
    // than implying a better code might work.
    const again = await h.call('POST', '/api/setup', {
        body: { code: 'ANYT-HING-ATAL-LNOW', username: 'sneaky', password: 'a-long-enough-password' },
    });
    assert.equal(again.status, 410);
});

test('the setup token file is removed once setup completes', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const codePath = () => { try { return h.setupCode(); } catch { return null; } };

    assert.ok(codePath(), 'token file exists before setup');
    await bootstrapAdmin(h);
    assert.equal(codePath(), null, 'token file removed after setup');
});

test('login is rejected for a wrong password and gives nothing away', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const wrongPass = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'not-the-password' },
    });
    const noSuchUser = await h.call('POST', '/api/auth/login', {
        body: { username: 'ghost', password: 'not-the-password' },
    });

    assert.equal(wrongPass.status, 401);
    assert.equal(noSuchUser.status, 401);
    // Identical wording: distinguishing them is a free account-enumeration oracle.
    assert.equal(wrongPass.body.message, noSuchUser.body.message);
});

test('login succeeds and the token identifies the user', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-long-enough-password' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.isAdmin, true);

    const me = await h.call('GET', '/api/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'rootadmin');
});

test('usernames are case-insensitive for login', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'RootAdmin', password: 'a-long-enough-password' },
    });
    assert.equal(login.status, 200, 'a name read aloud and retyped must still work');
});

test('the admin panel login sets an HttpOnly cookie and returns no token', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const res = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-long-enough-password', forAdminPanel: true },
    });
    assert.equal(res.status, 200);

    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'a cookie is set');
    assert.match(cookie, /HttpOnly/, 'script must not be able to read it');
    assert.match(cookie, /SameSite=Strict/, 'must not be sent cross-site');
    assert.equal(res.body.token, undefined, 'token must not also be in the body');
});

test('protected routes reject an anonymous caller', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    // The previous server returned the live roster to anyone, on any method.
    assert.equal((await h.call('GET', '/api/users')).status, 401);
    assert.equal((await h.call('GET', '/api/me')).status, 401);
});

test('an ordinary member cannot reach admin routes', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const adminToken = await bootstrapAdmin(h);

    const invite = await h.call('POST', '/api/invites', { token: adminToken, body: { maxUses: 1 } });
    const reg = await h.call('POST', '/api/auth/register', {
        body: {
            inviteCode: invite.body.invite.code,
            username: 'member',
            password: 'another-long-password',
            recoveryPhrase: 'four quiet lanterns drift seaward',
        },
    });
    assert.equal(reg.status, 201);

    const denied = await h.call('POST', '/api/channels', {
        token: reg.body.token, body: { name: 'Sneaky' },
    });
    assert.equal(denied.status, 403);
});

test('an invite works once and then refuses', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const adminToken = await bootstrapAdmin(h);

    const invite = await h.call('POST', '/api/invites', { token: adminToken, body: { maxUses: 1 } });
    const code = invite.body.invite.code;
    assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/, 'grouped and unambiguous');

    const first = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: code, username: 'firstuser', password: 'another-long-password' },
    });
    assert.equal(first.status, 201);

    const second = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: code, username: 'seconduser', password: 'another-long-password' },
    });
    assert.equal(second.status, 403);
    assert.match(second.body.message, /already been used/);
});

test('an invite code is accepted however the user pastes it', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const adminToken = await bootstrapAdmin(h);

    const invite = await h.call('POST', '/api/invites', { token: adminToken, body: { maxUses: 1 } });
    const messy = `  ${invite.body.invite.code.toLowerCase().replace(/-/g, ' ')}  `;

    const res = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: messy, username: 'pasteduser', password: 'another-long-password' },
    });
    assert.equal(res.status, 201, 'lowercase, spaces instead of hyphens, stray whitespace');
});

test('registration without a valid invite is refused', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const res = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', username: 'nobody', password: 'another-long-password' },
    });
    assert.equal(res.status, 403, 'invite-only means invite-only');
});

test('a duplicate username is refused regardless of case', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const adminToken = await bootstrapAdmin(h);

    const invite = await h.call('POST', '/api/invites', { token: adminToken, body: { maxUses: 5 } });
    const res = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: invite.body.invite.code, username: 'RootADMIN', password: 'another-long-password' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /already taken/);
});

test('a short password is refused with a usable message', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const adminToken = await bootstrapAdmin(h);

    const invite = await h.call('POST', '/api/invites', { token: adminToken, body: { maxUses: 1 } });
    const res = await h.call('POST', '/api/auth/register', {
        body: { inviteCode: invite.body.invite.code, username: 'shorty', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.detail.field, 'password', 'the client can highlight the right box');
});

test('recovery sets a new password and revokes existing sessions', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const oldToken = await bootstrapAdmin(h);

    assert.equal((await h.call('GET', '/api/me', { token: oldToken })).status, 200);

    const recovered = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin',
            recoveryPhrase: 'seven jealous otters argue loudly',
            newPassword: 'a-brand-new-long-password',
        },
    });
    assert.equal(recovered.status, 200);

    // If the password needed recovering, every existing session is exactly what you
    // want gone.
    assert.equal((await h.call('GET', '/api/me', { token: oldToken })).status, 401,
        'old session revoked');

    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-brand-new-long-password' },
    });
    assert.equal(login.status, 200, 'new password works');
});

test('recovery refuses a wrong phrase', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    await bootstrapAdmin(h);

    const res = await h.call('POST', '/api/auth/recover', {
        body: { username: 'rootadmin', recoveryPhrase: 'not the phrase at all', newPassword: 'x'.repeat(12) },
    });
    assert.equal(res.status, 401);
});

test('logout revokes the token it was called with', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const token = await bootstrapAdmin(h);

    assert.equal((await h.call('POST', '/api/auth/logout', { token })).status, 200);
    assert.equal((await h.call('GET', '/api/me', { token })).status, 401);
});

test('a fresh server has usable default channels', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const token = await bootstrapAdmin(h);

    const res = await h.call('GET', '/api/channels', { token });
    assert.equal(res.status, 200);
    assert.ok(res.body.channels.length >= 1);

    const def = res.body.channels.find((c) => c.isDefault);
    assert.ok(def, 'exactly somewhere for a new client to land');

    // Capabilities are explicit columns, not inferred from a name — so renaming this
    // channel cannot change how it behaves.
    const away = res.body.channels.find((c) => c.kind === 'afk');
    assert.equal(away.allowVoice, false);
    assert.equal(away.allowText, false);
});

test('a server always keeps at least one channel', async (t) => {
    const h = await launch();
    t.after(h.cleanup);
    const token = await bootstrapAdmin(h);

    const { body } = await h.call('GET', '/api/channels', { token });
    let remaining = body.channels.length;
    let lastStatus = null;

    for (const channel of body.channels) {
        lastStatus = (await h.call('DELETE', `/api/channels/${channel.id}`, { token })).status;
        if (lastStatus === 200) remaining -= 1;
    }

    assert.equal(remaining, 1, 'the final channel cannot be deleted');
    assert.equal(lastStatus, 400);
});
