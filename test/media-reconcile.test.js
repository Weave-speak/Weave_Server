// Reconciling "everyone in a voice channel hears everyone else".
//
// Written against the real failure: one person inaudible to one other person, with a
// clean journal and a healthy-looking room, because consuming is event-driven and a
// client that misses an event never learns it missed anything.
//
// The repair is easy; the restraint is what needs pinning. A nudge sent too eagerly is a
// duplicate-consume race, and a nudge sent for a video slot would fire constantly now
// that video is opt-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { watchRoomMedia } from '../src/core/sfu/media-reconcile.js';

const peer = (cid, username, channelId, { produces = [], consumes = [] } = {}) => ({
    cid,
    username,
    userId: `u-${cid}`,
    channelId,
    ws: `sock-${cid}`,
    producers: new Map(produces.map((slot) => [slot, { id: `prod-${cid}-${slot}`, kind: 'audio', closed: false }])),
    consumers: new Map(consumes.map((spec, i) => [
        `c${i}`, { closed: false, appData: { fromCid: spec.from, slot: spec.slot } },
    ])),
});

function harness(all) {
    const sent = [];
    const logged = [];
    let tick = null;
    const stop = watchRoomMedia({
        peers: { all },
        ws: { send: (sock, type, payload) => sent.push({ sock, type, payload }) },
        log: {
            warn: (o, m) => logged.push({ ...o, m }),
            error: (o, m) => logged.push({ ...o, m }),
        },
        setTimer: (fn) => { tick = fn; return { unref() {} }; },
        clearTimer: () => { tick = null; },
    });
    return { sent, logged, stop, run: () => tick?.() };
}

test('a gap must persist across two passes before anything is sent', () => {
    // brille produces audio; claude consumes nothing.
    const h = harness([
        peer('A', 'claude', 'room-1'),
        peer('B', 'brille', 'room-1', { produces: ['audio'] }),
    ]);

    h.run();
    assert.equal(h.sent.length, 0, 'a client mid-setup is not yet a fault');

    h.run();
    assert.equal(h.sent.length, 1, 'still missing a pass later — now it is');
    assert.equal(h.sent[0].sock, 'sock-A');
    assert.equal(h.sent[0].type, 'producer_new');
    assert.equal(h.sent[0].payload.cid, 'B');
    assert.equal(h.sent[0].payload.slot, 'audio');
    assert.equal(h.sent[0].payload.producerId, 'prod-B-audio');
    assert.ok(h.logged.some((l) => l.evt === 'sfu.consumer_missing' && l.listener === 'claude'));
    h.stop();
});

test('a gap that closes itself is never repaired', () => {
    const listener = peer('A', 'claude', 'room-1');
    const speaker = peer('B', 'brille', 'room-1', { produces: ['audio'] });
    const h = harness([listener, speaker]);

    h.run();                       // first sighting
    // The client's own event handling gets there first, as it normally does.
    listener.consumers.set('c9', { closed: false, appData: { fromCid: 'B', slot: 'audio' } });
    h.run();

    assert.equal(h.sent.length, 0, 'the ordinary path winning is the ordinary case');
    h.stop();
});

test('a room where everyone already hears everyone is silent', () => {
    const h = harness([
        peer('A', 'claude', 'room-1', { produces: ['audio'], consumes: [{ from: 'B', slot: 'audio' }] }),
        peer('B', 'brille', 'room-1', { produces: ['audio'], consumes: [{ from: 'A', slot: 'audio' }] }),
    ]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 0);
    h.stop();
});

test('video is never reconciled — opt-in means a missing consumer is normal', () => {
    const h = harness([
        peer('A', 'claude', 'room-1'),
        peer('B', 'brille', 'room-1', { produces: ['screen', 'webcam'] }),
    ]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 0, 'nobody is nudged to watch a stream they did not ask for');
    h.stop();
});

test('peers in different channels are never crossed', () => {
    const h = harness([
        peer('A', 'claude', 'room-1'),
        peer('B', 'brille', 'room-2', { produces: ['audio'] }),
    ]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 0);
    h.stop();
});

test('somebody standing nowhere is neither nudged nor counted', () => {
    const h = harness([
        peer('A', 'claude', null),
        peer('B', 'brille', 'room-1', { produces: ['audio'] }),
    ]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 0);
    h.stop();
});

test('a closed producer is not something to be missing', () => {
    const speaker = peer('B', 'brille', 'room-1', { produces: ['audio'] });
    speaker.producers.get('audio').closed = true;
    const h = harness([peer('A', 'claude', 'room-1'), speaker]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 0);
    h.stop();
});

test('a closed consumer does not count as hearing someone', () => {
    const listener = peer('A', 'claude', 'room-1', { consumes: [{ from: 'B', slot: 'audio' }] });
    listener.consumers.get('c0').closed = true;
    const h = harness([listener, peer('B', 'brille', 'room-1', { produces: ['audio'] })]);
    h.run();
    h.run();
    assert.equal(h.sent.length, 1, 'a dead consumer is exactly as deaf as no consumer');
    h.stop();
});

test('the one-way case from the field: repaired in one direction only', () => {
    // claude hears brille; brille does NOT hear claude. Only brille should be nudged.
    const h = harness([
        peer('A', 'claude', 'room-1', { produces: ['audio'], consumes: [{ from: 'B', slot: 'audio' }] }),
        peer('B', 'brille', 'room-1', { produces: ['audio'] }),
    ]);
    h.run();
    h.run();

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].sock, 'sock-B', 'the deaf one');
    assert.equal(h.sent[0].payload.cid, 'A', 'told about the one they cannot hear');
    h.stop();
});
