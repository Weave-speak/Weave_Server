// Watching the announced media address.
//
// This exists because of a real outage: the ISP moved the WAN address, every client kept
// sending audio to an IP that was no longer ours, and nothing anywhere reported a
// problem. The behaviours that matter are all about restraint — it must fire when the
// address genuinely moves, and stay silent for every other reason, because the cost of a
// false alarm is every client in the building rebuilding its media for nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { watchAnnouncedAddress } from '../src/core/sfu/address-watch.js';

/** A watcher driven by hand: no timers, no DNS, no network. */
function harness({ answers = [], announcedAddress = 'weave.example.org' } = {}) {
    const sent = [];
    const logged = [];
    let tick = null;
    let queue = [...answers];

    const stop = watchAnnouncedAddress({
        announcedAddress,
        intervalMs: 1000,
        resolve: async () => {
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next ?? [];
        },
        setTimer: (fn) => { tick = fn; return { unref() {} }; },
        clearTimer: () => { tick = null; },
        log: {
            info: (o, m) => logged.push({ level: 'info', ...o, m }),
            warn: (o, m) => logged.push({ level: 'warn', ...o, m }),
        },
        peers: {
            all: [
                { cid: 'a', ws: 'sock-a', channelId: 'room-1' },
                { cid: 'b', ws: 'sock-b', channelId: 'room-1' },
                { cid: 'c', ws: 'sock-c', channelId: null },   // standing nowhere
            ],
        },
        sfu: { routerFor: (id) => ({ rtpCapabilities: { codecs: [`caps-for-${id}`] } }) },
        ws: { send: (sock, type, payload) => sent.push({ sock, type, payload }) },
    });

    // The watcher resolves once immediately; let that settle before any assertion.
    const settle = () => new Promise((r) => setImmediate(r));
    return { sent, logged, stop, settle, run: async () => { await tick?.(); await settle(); } };
}

test('the first resolution is learned, never announced as a change', async () => {
    const h = harness({ answers: [['203.0.113.10']] });
    await h.settle();

    assert.equal(h.sent.length, 0, 'nobody is asked to rebuild just because the server started');
    assert.ok(h.logged.some((l) => l.evt === 'sfu.announced_resolved'));
    h.stop();
});

test('a moved address tells everyone IN A CHANNEL to rebuild, with capabilities', async () => {
    const h = harness({ answers: [['203.0.113.10'], ['198.51.100.7']] });
    await h.settle();
    await h.run();

    assert.equal(h.sent.length, 2, 'both peers in a channel, and not the one standing nowhere');
    assert.deepEqual(h.sent.map((s) => s.sock).sort(), ['sock-a', 'sock-b']);
    for (const frame of h.sent) {
        assert.equal(frame.type, 'media_reset');
        assert.equal(frame.payload.reason, 'announced_address_changed');
        // Capabilities ride along so the client can rebuild without a round trip — and
        // without them the client deliberately refuses to tear anything down.
        assert.deepEqual(frame.payload.rtpCapabilities, { codecs: ['caps-for-room-1'] });
    }
    const moved = h.logged.find((l) => l.evt === 'sfu.announced_changed');
    assert.equal(moved.from, '203.0.113.10');
    assert.equal(moved.to, '198.51.100.7');
    h.stop();
});

test('an unchanged address is silent, however many times it is checked', async () => {
    const h = harness({ answers: [['203.0.113.10'], ['203.0.113.10'], ['203.0.113.10']] });
    await h.settle();
    await h.run();
    await h.run();

    assert.equal(h.sent.length, 0);
    h.stop();
});

test('a DNS failure is not a change — an outage must not order a rebuild', async () => {
    const h = harness({ answers: [['203.0.113.10'], new Error('ESERVFAIL'), ['203.0.113.10']] });
    await h.settle();
    await h.run();

    assert.equal(h.sent.length, 0, 'a failed lookup leaves media exactly as it is');
    assert.ok(h.logged.some((l) => l.evt === 'sfu.announced_unresolved'));

    // And once it answers again with the SAME address, still nothing to do.
    await h.run();
    assert.equal(h.sent.length, 0);
    h.stop();
});

test('multiple A records only count as a change when the SET changes', async () => {
    const h = harness({
        answers: [
            ['203.0.113.10', '203.0.113.11'],
            ['203.0.113.11', '203.0.113.10'],   // same set, different order
            ['203.0.113.12', '203.0.113.10'],   // genuinely different
        ],
    });
    await h.settle();
    await h.run();
    assert.equal(h.sent.length, 0, 'reordered records are not a move');

    await h.run();
    assert.equal(h.sent.length, 2, 'a different set is');
    h.stop();
});

test('a literal IP is never watched at all', async () => {
    let timerMade = false;
    const stop = watchAnnouncedAddress({
        announcedAddress: '203.0.113.10',
        log: { info() {}, warn() {} },
        peers: { all: [] },
        sfu: { routerFor: () => null },
        ws: { send() {} },
        resolve: async () => { throw new Error('should never resolve a literal IP'); },
        setTimer: () => { timerMade = true; return { unref() {} }; },
        clearTimer: () => {},
    });
    assert.equal(timerMade, false, 'no timer, no DNS traffic, nothing to re-resolve');
    stop();
});

test('no announced address at all is equally inert', () => {
    let timerMade = false;
    const stop = watchAnnouncedAddress({
        announcedAddress: null,
        log: { info() {}, warn() {} },
        peers: { all: [] },
        sfu: { routerFor: () => null },
        ws: { send() {} },
        setTimer: () => { timerMade = true; return { unref() {} }; },
        clearTimer: () => {},
    });
    assert.equal(timerMade, false);
    stop();
});
