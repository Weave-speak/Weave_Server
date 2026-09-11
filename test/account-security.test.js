// Looking after your own account: the password, the security question, and the list of
// devices it is signed in on.
//
// Until these routes existed the only way to change your own password was to go to the
// sign-in screen and claim you had forgotten it — which signs you out everywhere and reads,
// to an administrator, like an account that got into trouble.
//
// What is actually tested here is the blast radius, because that is the part a mistake would
// make dangerous: the account acted on comes from the SESSION and never from the request, so
// there is no shape of call that reaches somebody else's sessions or somebody else's socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

const PASSWORD = 'a-long-enough-password';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-acct-'));
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
        body: {
            code, username: 'rootadmin', password: PASSWORD,
            securityQuestion: 'first_pet', securityAnswer: 'Biscuit',
        },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    /** A second account, so "somebody else" is a real person rather than a hypothetical. */
    const mint = async (username) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: {
                inviteCode: invite.body.invite.code, username, password: PASSWORD,
                securityQuestion: 'first_pet', securityAnswer: 'Biscuit',
            },
        });
        assert.equal(user.status, 201, JSON.stringify(user.body));
        return user.body;
    };

    /** Sign in again as the same account: a second device, with a session of its own. */
    const secondDevice = async (username, password = PASSWORD) => {
        const res = await call('POST', '/api/auth/login', { body: { username, password } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.token;
    };

    const sockets = [];
    const connect = async (token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${httpPort}`);
        sockets.push(ws);
        const inbox = [];
        const waiters = [];
        const closed = { code: null };
        const closeWaiters = [];
        ws.on('close', (c) => {
            closed.code = c;
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
                const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
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
        ws.send(JSON.stringify({ type: 'join', token, protocol: { min: 1, max: 1 } }));
        const joined = await expect('joined');
        return { ws, joined, cid: joined.self.cid, expect, expectClose, get closedWith() { return closed.code; } };
    };

    return {
        app, call, mint, connect, secondDevice,
        adminToken: admin.body.token,
        cleanup: async () => {
            for (const s of sockets) { try { s.close(); } catch { /* closing anyway */ } }
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test('the wrong current password changes nothing and signs nobody out', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const other = await h.secondDevice('rootadmin');

    const res = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: { currentPassword: 'not-the-right-one', newPassword: 'a-brand-new-long-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.detail?.field, 'currentPassword', 'the client highlights the right box');

    // Nothing happened: the old password still signs in and the other device is still live.
    assert.equal((await h.call('GET', '/api/me', { token: other })).status, 200);
    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: PASSWORD },
    });
    assert.equal(login.status, 200, 'the password was not changed');
});

test('the right one changes it, and signs out every other device but this one', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const other = await h.secondDevice('rootadmin');
    assert.equal((await h.call('GET', '/api/me', { token: other })).status, 200);

    const res = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.sessionsRevoked >= 1, 'the other device was signed out');

    // The point of the whole feature: whoever knew the old password is gone, and the
    // person who did the changing is still where they were.
    assert.equal((await h.call('GET', '/api/me', { token: other })).status, 401);
    assert.equal((await h.call('GET', '/api/me', { token: h.adminToken })).status, 200,
        'signing yourself out for your own good housekeeping would be absurd');

    assert.equal((await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: PASSWORD },
    })).status, 401, 'the old password is finished');
    assert.equal((await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-brand-new-long-password' },
    })).status, 200);
});

test('a password that cannot be used says which box is wrong', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const short = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    assert.equal(short.status, 400);
    assert.equal(short.body.detail?.field, 'newPassword');

    // Reporting success for a change that changed nothing is worse than refusing it.
    const same = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    assert.equal(same.status, 400);
    assert.match(same.body.message, /already your password/);
});

test('none of it is reachable without a session', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    for (const [method, url] of [
        ['POST', '/api/me/password'],
        ['POST', '/api/me/security-question'],
        ['GET', '/api/me/security-question'],
    ]) {
        const res = await h.call(method, url, { body: method === 'GET' ? undefined : {} });
        assert.equal(res.status, 401, `${method} ${url} must not answer a stranger`);
    }
});

test('the security question can be changed, and the new answer is the one that recovers', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Answered truthfully to the account itself, rather than with the decoy the sign-in
    // screen gets — there is nobody to mislead here.
    const before = await h.call('GET', '/api/me/security-question', { token: h.adminToken });
    assert.equal(before.status, 200);
    assert.equal(before.body.question.id, 'first_pet');

    const res = await h.call('POST', '/api/me/security-question', {
        token: h.adminToken,
        body: { questionId: 'childhood_friend', answer: 'Marguerite' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.question.id, 'childhood_friend');
    assert.ok(res.body.question.text, 'the text comes back so the panel need not look it up');

    // Nobody is signed out for tidying up their own recovery.
    assert.equal((await h.call('GET', '/api/me', { token: h.adminToken })).status, 200);

    // The real proof is at the other end: the new answer recovers the account and the old
    // one does not.
    assert.equal((await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin', questionId: 'first_pet', answer: 'Biscuit',
            newPassword: 'should-not-work-at-all',
        },
    })).status, 401, 'the answer it used to accept is finished');

    assert.equal((await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin', questionId: 'childhood_friend', answer: '  marguerite ',
            newPassword: 'a-brand-new-long-password',
        },
    })).status, 200, 'capitals and spacing still do not matter');
});

test('an invalid question or answer is refused with the field named', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const badId = await h.call('POST', '/api/me/security-question', {
        token: h.adminToken, body: { questionId: 'what_is_your_quest', answer: 'The Grail' },
    });
    assert.equal(badId.status, 400);
    assert.equal(badId.body.detail?.field, 'securityQuestion');

    const badAnswer = await h.call('POST', '/api/me/security-question', {
        token: h.adminToken, body: { questionId: 'first_pet', answer: 'x' },
    });
    assert.equal(badAnswer.status, 400);
    assert.equal(badAnswer.body.detail?.field, 'securityAnswer');
});

test('a live device is cut, and the connection that asked is left alone', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const otherToken = await h.secondDevice('rootadmin');
    const mine = await h.connect(h.adminToken);
    const theirs = await h.connect(otherToken);

    const res = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: {
            currentPassword: PASSWORD,
            newPassword: 'a-brand-new-long-password',
            // The client names its own connection, because an HTTP request carries nothing
            // that says which socket belongs to it.
            cid: mine.cid,
        },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.disconnected, 1);

    const cut = await theirs.expectClose();
    // Deliberately NOT 4003: that one tells the client an ADMINISTRATOR reset the password,
    // which would be a lie told to somebody about their own account. This code means
    // nothing in particular, so the client reconnects and is told the truth — the session
    // is gone, sign in again.
    assert.equal(cut.code, 4007);
    assert.equal(mine.closedWith, null, 'the device doing the changing keeps talking');
});

test('no cid reaches another account, whatever is passed', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const sinister = await h.mint('sinister');
    const theirs = await h.connect(sinister.token);
    const mine = await h.connect(h.adminToken);

    // Naming somebody else's connection can only ever SPARE one of your own. The account
    // acted on is the session's, never the request's — this is the assertion that fails if
    // that ever stops being true.
    const res = await h.call('POST', '/api/me/password', {
        token: h.adminToken,
        body: {
            currentPassword: PASSWORD,
            newPassword: 'a-brand-new-long-password',
            cid: theirs.cid,
        },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Awaited first, so the close loop has demonstrably run before anything is asserted
    // about what it did NOT close. Naming theirs spared nothing of ours, so ours went.
    assert.equal((await mine.expectClose()).code, 4007);

    assert.equal((await h.call('GET', '/api/me', { token: sinister.token })).status, 200,
        "another account's session is untouched");
    assert.equal(theirs.closedWith, null, 'and so is their connection');
});

test('the list names every device, and exactly one of them as this one', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    await h.secondDevice('rootadmin');

    const res = await h.call('GET', '/api/me/sessions', { token: h.adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sessions.length, 2);

    const current = res.body.sessions.filter((s) => s.current);
    assert.equal(current.length, 1, 'the row being read is the one thing the reader must be sure of');

    for (const session of res.body.sessions) {
        assert.ok(session.id, 'a handle that is not the token or its hash');
        assert.ok(session.device, 'something a person could recognise');
        assert.ok(session.createdAt);
        // The token and its hash must never appear, whatever else does.
        assert.ok(!('token' in session) && !('tokenHash' in session) && !('token_hash' in session));
    }
});

test('signing out another device ends it at once, not at its convenience', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const otherToken = await h.secondDevice('rootadmin');
    const theirs = await h.connect(otherToken);
    const mine = await h.connect(h.adminToken);

    const list = await h.call('GET', '/api/me/sessions', { token: h.adminToken });
    const other = list.body.sessions.find((s) => !s.current);

    const res = await h.call('DELETE', `/api/me/sessions/${other.id}`, { token: h.adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The token is dead AND the connection it was already holding is closed. Without the
    // second half, a device signed out of the list keeps talking in the room until it
    // happens to reconnect, which is not what anybody means by signing it out.
    assert.equal((await h.call('GET', '/api/me', { token: otherToken })).status, 401);
    assert.equal((await theirs.expectClose()).code, 4007);
    assert.equal(mine.closedWith, null, 'and this device carries on');

    const after = await h.call('GET', '/api/me/sessions', { token: h.adminToken });
    assert.equal(after.body.sessions.length, 1);
});

test('the device you are reading on cannot be signed out from the list', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const list = await h.call('GET', '/api/me/sessions', { token: h.adminToken });
    const self = list.body.sessions.find((s) => s.current);

    // It would leave the app looking signed in until its next request failed. Sign out is
    // a button of its own and does it properly.
    const res = await h.call('DELETE', `/api/me/sessions/${self.id}`, { token: h.adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /this device/i);
    assert.equal((await h.call('GET', '/api/me', { token: h.adminToken })).status, 200);
});

test("one account cannot sign out another account's device", async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const sinister = await h.mint('sinister');
    const theirs = await h.call('GET', '/api/me/sessions', { token: sinister.token });
    const theirSession = theirs.body.sessions[0].id;

    // The account is part of the lookup, not something checked afterwards — so somebody
    // else's id matches no row, which is the same answer as an id that never existed.
    // That is also what stops this being a way to find out whose id it is.
    const res = await h.call('DELETE', `/api/me/sessions/${theirSession}`, { token: h.adminToken });
    assert.equal(res.status, 404);
    assert.equal((await h.call('GET', '/api/me', { token: sinister.token })).status, 200,
        'their session is untouched');
});

test('a session that has already gone says so rather than pretending', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('DELETE', '/api/me/sessions/not-a-real-session-id', { token: h.adminToken });
    assert.equal(res.status, 404);
});

// Last in the file on purpose: the limiter is keyed partly on the client address, which
// every test here shares, so exhausting it earlier would throttle the tests that follow.
test('guessing the current password from inside a session is throttled', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    let throttled = null;
    for (let i = 0; i < 10 && !throttled; i += 1) {
        const res = await h.call('POST', '/api/me/password', {
            token: h.adminToken,
            body: { currentPassword: `guess-${i}`, newPassword: 'a-brand-new-long-password' },
        });
        if (res.status === 429) throttled = res;
        else assert.equal(res.status, 401);
    }

    assert.ok(throttled, 'an unlocked screen must not be an unlimited number of guesses');
    assert.match(throttled.body.message, /Try again in/);
});
