// The huddle ring: a private room going from empty to occupied rings its other members.
//
// Driven through the real loader with stand-in peers (module-harness.js), with time
// mocked, since a ring lasts 45 seconds and a cooldown five minutes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleHarness } from './module-harness.js';
import { createChannel, addMember } from '../src/core/channels/index.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

async function setup(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
    const h = await moduleHarness('private-channels');
    t.after(() => h.stop());
    const huddle = createChannel(h.db, { name: 'Planning', private: true, createdBy: 'u-ana', kind: 'both' });
    for (const id of ['u-ana', 'u-kes', 'u-moth']) addMember(h.db, huddle.id, id, 'u-ana');
    // A DM call's room: private AND system. It rings by the dm module's rules, never these.
    const callRoom = createChannel(h.db, { name: 'Private call', private: true, system: true, kind: 'both' });
    for (const id of ['u-ana', 'u-kes']) addMember(h.db, callRoom.id, id, 'u-ana');

    const ana = h.connect('u-ana', h.general.id);
    const kes = h.connect('u-kes', h.general.id);
    const moth = h.connect('u-moth', null);
    const zed = h.connect('u-zed', h.general.id);   // not a member
    return { h, huddle, callRoom, ana, kes, moth, zed };
}

test('the first person into an empty huddle rings every other member, by socket and by push', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);

    const [toKes] = s.kes.frames('private-channels:ring');
    assert.ok(toKes, 'a member hears the ring');
    assert.match(toKes.callId, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(toKes, {
        channelId: s.huddle.id,
        callId: toKes.callId,
        name: 'Planning',
        from: { username: 'ana', displayName: 'Ana' },
        ringMs: 45_000,
        expiresAt: NOW + 45_000,
    });
    assert.deepEqual(s.moth.frames('private-channels:ring'), [toKes], 'a member standing nowhere too');
    assert.deepEqual(s.zed.frames('private-channels:ring'), [], 'a non-member hears nothing');
    assert.deepEqual(s.ana.frames('private-channels:ring'), [], 'nor does the one who started it');

    assert.deepEqual(s.h.pushes.map((p) => p.userId).sort(), ['u-kes', 'u-moth']);
    assert.deepEqual(s.h.pushesFor('u-kes')[0], {
        userId: 'u-kes',
        payload: {
            v: 1, kind: 'ring', callId: toKes.callId,
            call: { type: 'huddle', channelId: s.huddle.id, name: 'Planning' },
            from: { username: 'ana', displayName: 'Ana' },
            expiresAt: NOW + 45_000,
        },
        opts: { ttl: 45, urgency: 'high', topic: toKes.callId },
    });
});

test('signing in straight into an empty huddle starts it too', async (t) => {
    const s = await setup(t);
    s.h.connect('u-ana', s.huddle.id);
    assert.equal(s.kes.frames('private-channels:ring').length, 1);
});

test('joining a huddle already going answers your ring and starts nothing', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    const { callId } = s.kes.frames('private-channels:ring')[0];
    s.kes.move(s.huddle.id);

    assert.deepEqual(s.kes.frames('private-channels:ring_cancel'),
        [{ callId, channelId: s.huddle.id, reason: 'answered' }]);
    const cancel = s.h.pushesFor('u-kes').at(-1);
    assert.equal(cancel.payload.kind, 'ring_cancel');
    assert.equal(cancel.payload.reason, 'answered');
    assert.equal(s.moth.frames('private-channels:ring').length, 1, 'nobody is rung twice');
    assert.deepEqual(s.moth.frames('private-channels:ring_cancel'), [], 'and the others keep ringing');
});

test('system rooms, resumed joins and a lonely huddle never ring', async (t) => {
    const s = await setup(t);
    s.ana.move(s.callRoom.id);
    assert.deepEqual(s.kes.frames('private-channels:ring'), [], 'a DM call room rings by its own rules');

    s.h.connect('u-kes', s.huddle.id, { resumed: true });
    assert.deepEqual(s.moth.frames('private-channels:ring'), [], 'a dropped line coming back is not a start');

    const solo = createChannel(s.h.db, { name: 'Just me', private: true, createdBy: 'u-zed', kind: 'both' });
    addMember(s.h.db, solo.id, 'u-zed', 'u-zed');
    s.zed.move(solo.id);
    assert.equal(s.h.pushes.length, 0, 'nobody else to ring');
});

test('a public room never rings', async (t) => {
    const s = await setup(t);
    const lounge = createChannel(s.h.db, { name: 'Lounge' });
    s.ana.move(lounge.id);
    assert.equal(s.h.pushes.length, 0);
});

test('declining over the socket or from a notification stops that member only', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    const { callId } = s.kes.frames('private-channels:ring')[0];

    s.moth.send('private-channels:decline', { channelId: s.huddle.id });
    assert.deepEqual(s.moth.frames('private-channels:ring_cancel'),
        [{ callId, channelId: s.huddle.id, reason: 'declined' }]);
    assert.equal(s.h.pushesFor('u-moth').at(-1).payload.kind, 'ring_cancel');
    assert.deepEqual(s.kes.frames('private-channels:ring_cancel'), [], 'kes is still being rung');

    const decline = (userId, body) => s.h.route('POST', '/api/private-channels/:id/ring/decline',
        { userId, params: { id: s.huddle.id }, body });
    assert.equal((await decline('u-zed', { callId })).status, 404, 'not a member: no such room');
    assert.equal((await decline('u-kes', {})).status, 400, 'the ring must be named');
    assert.deepEqual(await decline('u-kes', { callId: 'AAAAAAAAAAAAAAAAAAAAAA' }),
        { status: 200, body: { ok: true, ended: false } }, 'a stale callId ends nothing');
    assert.deepEqual(await decline('u-kes', { callId }), { status: 200, body: { ok: true, ended: true } });
    assert.equal(s.kes.frames('private-channels:ring_cancel').at(-1).reason, 'declined');
    assert.deepEqual(await decline('u-kes', { callId }), { status: 200, body: { ok: true, ended: false } },
        'idempotent: once is enough, twice is fine');

    t.mock.timers.tick(45_000);
    assert.equal(s.h.pushes.filter((p) => p.payload.kind === 'missed').length, 0,
        'whoever declined did not miss anything');
});

test('the starter leaving while still alone cancels the ring for everyone, as a missed call', async (t) => {
    for (const leave of [(s) => s.ana.move(s.h.general.id), (s) => s.ana.standNowhere(), (s) => s.ana.signOff()]) {
        const s = await setup(t);
        s.ana.move(s.huddle.id);
        const { callId } = s.kes.frames('private-channels:ring')[0];
        leave(s);
        for (const member of [s.kes, s.moth]) {
            assert.deepEqual(member.frames('private-channels:ring_cancel'),
                [{ callId, channelId: s.huddle.id, reason: 'cancelled' }]);
        }
        for (const userId of ['u-kes', 'u-moth']) {
            const last = s.h.pushesFor(userId).at(-1);
            assert.equal(last.payload.kind, 'missed');
            assert.equal(last.payload.reason, 'cancelled');
            assert.deepEqual(last.opts, { ttl: 86_400, urgency: 'normal', topic: callId });
        }
        t.mock.timers.reset();
    }
});

test('the starter leaving once someone came keeps ringing the rest', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    s.kes.move(s.huddle.id);
    s.ana.move(s.h.general.id);
    assert.deepEqual(s.moth.frames('private-channels:ring_cancel'), []);
});

test('when the ring runs out, whoever neither came nor declined missed it', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    const { callId } = s.kes.frames('private-channels:ring')[0];
    s.kes.move(s.huddle.id);

    t.mock.timers.tick(45_000);
    assert.deepEqual(s.moth.frames('private-channels:ring_cancel'),
        [{ callId, channelId: s.huddle.id, reason: 'no_answer' }]);
    const missed = s.h.pushesFor('u-moth').at(-1);
    assert.equal(missed.payload.kind, 'missed');
    assert.equal(missed.payload.reason, 'no_answer');
    assert.deepEqual(missed.payload.call, { type: 'huddle', channelId: s.huddle.id, name: 'Planning' });
    assert.ok(!s.h.pushesFor('u-kes').some((p) => p.payload.kind === 'missed'), 'kes came');
});

test('a room rings at most once per cooldown; the setting can shorten it or switch rings off', async (t) => {
    const s = await setup(t);
    const rings = () => s.kes.frames('private-channels:ring').length;
    const startAgain = () => { s.ana.move(s.h.general.id); s.ana.move(s.huddle.id); };

    s.ana.move(s.huddle.id);
    assert.equal(rings(), 1);
    startAgain();
    assert.equal(rings(), 1, 'stepping out and back in does not ring everyone again');

    t.mock.timers.tick(5 * 60 * 1000);
    startAgain();
    assert.equal(rings(), 2, 'after the cooldown it rings again');

    s.h.settings.set('private-channels.ringCooldownMinutes', 0);
    startAgain();
    assert.equal(rings(), 3, 'no cooldown: every start rings');

    s.h.settings.set('private-channels.ringMembers', false);
    startAgain();
    assert.equal(rings(), 3, 'switched off: nothing rings');
});

test('people, not connections: a second device of the person already inside starts nothing', async (t) => {
    const s = await setup(t);
    s.h.settings.set('private-channels.ringCooldownMinutes', 0);
    s.ana.move(s.huddle.id);
    t.mock.timers.tick(45_000);                     // that ring runs out
    const before = s.kes.frames('private-channels:ring').length;

    s.h.connect('u-ana', s.huddle.id);   // her phone opens into the room her laptop is in
    assert.equal(s.kes.frames('private-channels:ring').length, before, 'Ana was already there');
});

test('a room deleted while it rings stops ringing, without a missed call to Join', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    s.h.db.prepare('DELETE FROM channels WHERE id = ?').run(s.huddle.id);
    t.mock.timers.tick(45_000);
    assert.equal(s.kes.frames('private-channels:ring_cancel').at(-1).reason, 'cancelled');
    assert.ok(!s.h.pushes.some((p) => p.payload.kind === 'missed'));
});

test('stopping the server ends a ring without calling it missed', async (t) => {
    const s = await setup(t);
    s.ana.move(s.huddle.id);
    s.h.stop();
    assert.equal(s.kes.frames('private-channels:ring_cancel').at(-1).reason, 'server');
    assert.equal(s.h.pushesFor('u-kes').at(-1).payload.kind, 'ring_cancel');
});
