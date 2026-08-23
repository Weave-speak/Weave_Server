// Password recovery by security question.
//
// Weave collects no email address, so there is no reset link to send and a question is the
// only self-service way back in. That makes step one dangerous: "which question does this
// account use?" has to be answerable BEFORE anyone has proved anything, and the obvious
// implementation turns an invite-only server's membership into a public directory.
//
// Most of what is tested here is that it does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';
import { SECURITY_QUESTIONS, decoyQuestionFor, normaliseAnswer } from '../src/core/auth/questions.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-recover-'));
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

    const call = async (method, url, { body, token } = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: {
            code,
            username: 'rootadmin',
            password: 'a-long-enough-password',
            securityQuestion: 'first_pet',
            securityAnswer: 'Biscuit',
        },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    return {
        app, call, adminToken: admin.body.token,
        cleanup: async () => {
            await app.stop('test');
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test('the question list is available before any account exists', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('GET', '/api/auth/questions');
    assert.equal(res.status, 200);
    assert.ok(res.body.questions.length >= 6, 'enough to choose from');

    for (const q of res.body.questions) {
        assert.ok(q.id && q.text, 'each has a stable id and human text');
    }
    // Ids are what get stored. Reordering the list must never move an answer to a
    // different question.
    assert.equal(new Set(res.body.questions.map((q) => q.id)).size, res.body.questions.length);
});

test('an account gets its own question back', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'rootadmin' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.question.id, 'first_pet');
});

test('an unknown username also gets a question, not an error', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const real = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'rootadmin' } });
    const fake = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'nobody-here' } });

    // This is the whole point. An error, a different status, or a missing question would
    // let anyone map the membership of an invite-only server.
    assert.equal(fake.status, real.status);
    assert.ok(fake.body.question.id, 'a question is returned');
    assert.ok(fake.body.question.text, 'with human-readable text');
    assert.deepEqual(Object.keys(fake.body).sort(), Object.keys(real.body).sort(),
        'the two responses are the same shape');
});

test('the question for an unknown username is stable across attempts', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const first = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'ghost' } });
    const second = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'ghost' } });
    const third = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'ghost' } });

    // Asking twice and getting different questions would give the game away as surely as
    // an error would.
    assert.equal(first.body.question.id, second.body.question.id);
    assert.equal(second.body.question.id, third.body.question.id);
});

test('the same username gets different questions on different servers', async (t) => {
    // Otherwise you could confirm an account exists by comparing two Weave servers.
    const a = decoyQuestionFor('someone', 'salt-of-server-a');
    const b = decoyQuestionFor('someone', 'salt-of-server-b');

    const differing = SECURITY_QUESTIONS.filter((q) => q.id !== a.id).length;
    assert.ok(differing > 0, 'there is more than one question to land on');
    // With 8 questions two salts collide 1 in 8 of the time, so assert the mechanism
    // rather than a specific outcome: spread across many salts.
    const spread = new Set(
        Array.from({ length: 40 }, (_, i) => decoyQuestionFor('someone', `salt-${i}`).id),
    );
    assert.ok(spread.size >= 4, `expected a spread of questions, got ${spread.size}`);
    assert.ok(b.id, 'always returns something');
});

test('a correct answer resets the password and signs the account out everywhere', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    assert.equal((await h.call('GET', '/api/me', { token: h.adminToken })).status, 200);

    const res = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin',
            questionId: 'first_pet',
            answer: 'Biscuit',
            newPassword: 'a-brand-new-long-password',
        },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // If the password needed recovering, existing sessions are exactly what you want gone.
    assert.equal((await h.call('GET', '/api/me', { token: h.adminToken })).status, 401);

    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-brand-new-long-password' },
    });
    assert.equal(login.status, 200);
});

test('answers ignore case and surrounding whitespace', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    // Nobody reproduces their own capitalisation months later, and "Biscuit " failing
    // against "biscuit" is a support request rather than a security win.
    const res = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin',
            questionId: 'first_pet',
            answer: '  bIsCuIt  ',
            newPassword: 'another-brand-new-password',
        },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('a wrong answer is refused', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin',
            questionId: 'first_pet',
            answer: 'Rover',
            newPassword: 'should-not-be-set-at-all',
        },
    });
    assert.equal(res.status, 401);

    // And the old password still works, i.e. nothing was half-applied.
    const login = await h.call('POST', '/api/auth/login', {
        body: { username: 'rootadmin', password: 'a-long-enough-password' },
    });
    assert.equal(login.status, 200);
});

test('answering a different question than the one stored fails', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const res = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'rootadmin',
            // Right answer, wrong question.
            questionId: 'first_car',
            answer: 'Biscuit',
            newPassword: 'should-not-be-set-at-all',
        },
    });
    assert.equal(res.status, 401);
});

test('a wrong answer for a real account reads the same as any answer for a fake one', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const realUser = await h.call('POST', '/api/auth/recover', {
        body: { username: 'rootadmin', questionId: 'first_pet', answer: 'wrong', newPassword: 'x'.repeat(12) },
    });
    const fakeUser = await h.call('POST', '/api/auth/recover', {
        body: { username: 'no-such-person', questionId: 'first_pet', answer: 'wrong', newPassword: 'x'.repeat(12) },
    });

    assert.equal(realUser.status, fakeUser.status);
    assert.equal(realUser.body.message, fakeUser.body.message);
});

test('registration accepts a question and the account can then recover', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const invite = await h.call('POST', '/api/invites', { token: h.adminToken, body: { maxUses: 1 } });
    const reg = await h.call('POST', '/api/auth/register', {
        body: {
            inviteCode: invite.body.invite.code,
            username: 'ghostbyte',
            displayName: 'Ghostbyte',
            password: 'another-long-password',
            securityQuestion: 'childhood_nickname',
            securityAnswer: 'Squid',
        },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));

    const q = await h.call('POST', '/api/auth/recovery-question', { body: { username: 'ghostbyte' } });
    assert.equal(q.body.question.id, 'childhood_nickname');

    const reset = await h.call('POST', '/api/auth/recover', {
        body: {
            username: 'ghostbyte',
            questionId: 'childhood_nickname',
            answer: 'squid',
            newPassword: 'yet-another-long-password',
        },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
});

test('an invalid question id is refused at registration', async (t) => {
    const h = await launch();
    t.after(h.cleanup);

    const invite = await h.call('POST', '/api/invites', { token: h.adminToken, body: { maxUses: 1 } });
    const reg = await h.call('POST', '/api/auth/register', {
        body: {
            inviteCode: invite.body.invite.code,
            username: 'sneaky',
            password: 'another-long-password',
            securityQuestion: 'what is my password',
            securityAnswer: 'nice try',
        },
    });
    assert.equal(reg.status, 400);
    assert.equal(reg.body.detail.field, 'securityQuestion');
});

test('answer normalisation collapses the things people get wrong', () => {
    assert.equal(normaliseAnswer('  Biscuit  '), 'biscuit');
    assert.equal(normaliseAnswer('BISCUIT'), 'biscuit');
    assert.equal(normaliseAnswer('Mr   Biscuit'), 'mr biscuit');
    // Accents are preserved: stripping them would quietly widen the answer space.
    assert.equal(normaliseAnswer('Renée'), 'renée');
});
