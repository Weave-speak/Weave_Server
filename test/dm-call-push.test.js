// DM calls: the call id, the push that rings a closed app, and how every ring ends.
//
// dm.test.js drives calls over real sockets and needs mediasoup's worker; this drives the
// same module through the real loader with stand-in peers (module-harness.js), so the
// ring's lifecycle is checked wherever the tests run. Time is mocked: a ring lasts 45
// seconds, and nobody should wait that long to learn it ended.

import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleHarness } from './module-harness.js';
import { getChannel } from '../src/core/channels/index.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const CALL_ID = /^[A-Za-z0-9_-]{22}$/;

async function setup(t, opts) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
    const h = await moduleHarness('dm', opts);
    t.after(() => h.stop());
    const { body } = await h.route('POST', '/api/dm/threads', { userId: 'u-ana', body: { userId: 'u-kes' } });
    const thread = body.thread;
    const ana = h.connect('u-ana', h.general.id);
    const kes = h.connect('u-kes', h.general.id);
    return { h, thread, ana, kes };
}

/** Ana calls Kes; returns the ring Kes's socket heard. */
function ring({ ana, kes, thread }) {
    ana.send('dm:call', { threadId: thread.id });
    const [heard] = kes.frames('dm:ring');
    assert.ok(heard, 'the callee hears a ring');
    return heard;
}

test('a ring carries a call id and an expiry, and rings the callee by push too', async (t) => {
    const s = await setup(t);
    const heard = ring(s);

    assert.match(heard.callId, CALL_ID, 'a call id that can double as a push Topic');
    assert.equal(heard.expiresAt, NOW + 45_000);
    assert.equal(heard.threadId, s.thread.id);
    assert.deepEqual(heard.from, { username: 'ana', displayName: 'Ana' });

    assert.deepEqual(s.h.pushes, [{
        userId: 'u-kes',
        payload: {
            v: 1, kind: 'ring', callId: heard.callId,
            call: { type: 'dm', threadId: s.thread.id },
            from: { username: 'ana', displayName: 'Ana' },
            expiresAt: NOW + 45_000,
        },
        opts: { ttl: 45, urgency: 'high', topic: heard.callId },
    }], 'only the callee, urgent, for as long as it rings');
});

test('answering tells both sides the call is live, and stops the callee ringing elsewhere', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    s.kes.send('dm:accept', { threadId: s.thread.id, callId });

    for (const side of [s.ana, s.kes]) {
        assert.deepEqual(side.frames('dm:call_live'), [{ threadId: s.thread.id, callId }]);
    }
    const cancel = s.h.pushesFor('u-kes').at(-1);
    assert.equal(cancel.payload.kind, 'ring_cancel');
    assert.equal(cancel.payload.reason, 'answered');
    assert.equal(cancel.payload.callId, callId);
    assert.deepEqual(cancel.opts, { ttl: 45, urgency: 'high', topic: callId });

    t.mock.timers.tick(46_000);
    assert.deepEqual(s.ana.frames('dm:call_ended'), [], 'the ring timer died with the ring');
});

test('declining over the socket ends the ring, and stops the callee\'s other devices', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    s.kes.send('dm:decline', { threadId: s.thread.id });

    assert.deepEqual(s.ana.frames('dm:call_ended'), [{ threadId: s.thread.id, callId, reason: 'declined' }]);
    const last = s.h.pushesFor('u-kes').at(-1);
    assert.equal(last.payload.kind, 'ring_cancel');
    assert.equal(last.payload.reason, 'declined');
});

test('the caller hanging up during the ring ends it as cancelled — the callee no longer rings into an empty room', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    const room = s.ana.frames('moved')[0].channel.id;

    s.ana.move(s.h.general.id);

    for (const side of [s.ana, s.kes]) {
        assert.deepEqual(side.frames('dm:call_ended'), [{ threadId: s.thread.id, callId, reason: 'cancelled' }]);
    }
    const missed = s.h.pushesFor('u-kes').at(-1);
    assert.equal(missed.payload.kind, 'missed');
    assert.equal(missed.payload.reason, 'cancelled');
    assert.deepEqual(missed.opts, { ttl: 86_400, urgency: 'normal', topic: callId });
    assert.equal(getChannel(s.h.db, room), null, 'the empty call room is gone');

    s.kes.send('dm:accept', { threadId: s.thread.id, callId });
    assert.equal(s.kes.frames('error').at(-1)?.code, 'no_call', 'answering afterwards finds no call');
});

test('the caller signing off, or pressing cancel, during the ring is a cancel too', async (t) => {
    for (const hangUp of [
        (s) => s.ana.signOff(),
        (s) => s.ana.standNowhere(),
        (s) => s.ana.send('dm:decline', { threadId: s.thread.id }),
    ]) {
        const s = await setup(t);
        const { callId } = ring(s);
        hangUp(s);
        assert.deepEqual(s.kes.frames('dm:call_ended'), [{ threadId: s.thread.id, callId, reason: 'cancelled' }]);
        assert.equal(s.h.pushesFor('u-kes').at(-1).payload.kind, 'missed');
        t.mock.timers.reset();
    }
});

test('nobody answering is a missed call', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    t.mock.timers.tick(44_999);
    assert.deepEqual(s.kes.frames('dm:call_ended'), []);
    t.mock.timers.tick(1);
    assert.deepEqual(s.kes.frames('dm:call_ended'), [{ threadId: s.thread.id, callId, reason: 'no_answer' }]);
    const missed = s.h.pushesFor('u-kes').at(-1);
    assert.equal(missed.payload.kind, 'missed');
    assert.equal(missed.payload.reason, 'no_answer');
    assert.equal(missed.opts.ttl, 86_400);
});

test('POST /api/dm/threads/:id/call/decline: a phone declining with no app running', async (t) => {
    const s = await setup(t);
    const decline = (userId, body, id = s.thread.id) => s.h.route('POST', '/api/dm/threads/:id/call/decline',
        { userId, params: { id }, body });
    const { callId } = ring(s);

    assert.equal((await decline('u-moth', { callId })).status, 404, 'not a party: the same answer as no thread');
    assert.equal((await decline('u-kes', { callId }, 'no-such-thread')).status, 404);
    assert.equal((await decline('u-kes', {})).status, 400, 'the call must be named');
    assert.deepEqual(await decline('u-kes', { callId: 'AAAAAAAAAAAAAAAAAAAAAA' }),
        { status: 200, body: { ok: true, ended: false } }, 'a stale decline is answered, and ends nothing');
    assert.deepEqual(s.ana.frames('dm:call_ended'), [], 'the ring went on');

    assert.deepEqual(await decline('u-kes', { callId }), { status: 200, body: { ok: true, ended: true } });
    assert.deepEqual(s.ana.frames('dm:call_ended'), [{ threadId: s.thread.id, callId, reason: 'declined' }]);
    assert.equal(s.h.pushesFor('u-kes').at(-1).payload.kind, 'ring_cancel');

    assert.deepEqual(await decline('u-kes', { callId }), { status: 200, body: { ok: true, ended: false } },
        'idempotent: a second decline is fine');
});

test('the caller declining from a notification is a cancel', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    const res = await s.h.route('POST', '/api/dm/threads/:id/call/decline',
        { userId: 'u-ana', params: { id: s.thread.id }, body: { callId } });
    assert.deepEqual(res.body, { ok: true, ended: true });
    assert.equal(s.kes.frames('dm:call_ended').at(-1).reason, 'cancelled');
});

test('the caller\'s second device joining does not answer the call', async (t) => {
    const s = await setup(t);
    const { callId } = ring(s);
    const anaPhone = s.h.connect('u-ana', null);
    anaPhone.send('dm:call', { threadId: s.thread.id });

    assert.equal(anaPhone.frames('moved').length, 1, 'the phone is moved into the call');
    assert.deepEqual(s.kes.frames('dm:call_live'), [], 'but the call is still ringing');
    assert.equal(s.h.pushesFor('u-kes').length, 1, 'and nothing told the callee to stop');

    s.kes.send('dm:accept', { threadId: s.thread.id });
    assert.deepEqual(s.kes.frames('dm:call_live'), [{ threadId: s.thread.id, callId }]);
});

test('a live call ending is not a missed call: no push for it', async (t) => {
    const s = await setup(t);
    ring(s);
    s.kes.send('dm:accept', { threadId: s.thread.id });
    const pushed = s.h.pushes.length;
    s.kes.move(s.h.general.id);
    assert.equal(s.ana.frames('dm:call_ended').at(-1).reason, 'left');
    assert.equal(s.h.pushes.length, pushed);
});

test('without push, a ring still rings an open app', async (t) => {
    const s = await setup(t, { push: false });
    const heard = ring(s);
    assert.match(heard.callId, CALL_ID);
    s.kes.send('dm:decline', { threadId: s.thread.id });
    assert.equal(s.ana.frames('dm:call_ended').at(-1).reason, 'declined');
});

test('a push service that throws or rejects cannot break a call', async (t) => {
    for (const pushImpl of [
        { toUser() { throw new Error('boom'); } },
        { toUser: async () => { throw new Error('boom'); } },
    ]) {
        const s = await setup(t, { pushImpl });
        const heard = ring(s);
        assert.match(heard.callId, CALL_ID, 'the socket ring still went out');
        s.kes.send('dm:accept', { threadId: s.thread.id });
        assert.equal(s.ana.frames('dm:call_live').length, 1);
        t.mock.timers.reset();
    }
});
