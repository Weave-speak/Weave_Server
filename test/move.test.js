// Moving a peer between channels.
//
// The case this file exists for is the quiet one. A transport belongs to the router that
// created it, and a router belongs to one worker. Channels on the same worker share a
// router, so a move between them keeps every transport and producer valid. Across workers
// they do not — and nothing fails. The peer arrives in the new room, still apparently
// producing, on a router with nobody on it. They cannot be heard and cannot hear, and no
// error is raised anywhere, because technically nothing went wrong.
//
// One worker is the default, so this never happens on a typical install. It happens the day
// somebody raises the worker count to use more of their CPU, and then it looks like the
// server is broken rather than the configuration.

import test from 'node:test';
import assert from 'node:assert/strict';

import { movePeer } from '../src/core/peers/move.js';

/** A closable that records whether it was closed. */
const closable = () => {
    const it = { closed: false, close() { it.closed = true; } };
    return it;
};

/**
 * An SFU whose channel-to-worker map the test controls.
 *
 * The real one assigns least-loaded and is deliberately not predictable; here the point is
 * to put two channels on the same worker or on different ones and see what move does.
 */
function fakeSfu(assignment) {
    return {
        workerIndexFor: (channelId) => assignment[channelId] ?? 0,
        rtpCapabilities: () => ({ codecs: [] }),
    };
}

function fakePeer() {
    return {
        cid: 'cid-1',
        userId: 'u-1',
        username: 'ghostbyte',
        displayName: 'Ghostbyte',
        channelId: 'c-a',
        muted: false,
        deafened: false,
        ws: { cid: 'cid-1' },
        producers: new Map([['audio', closable()]]),
        transports: new Map([['send', closable()], ['recv', closable()]]),
        consumers: new Map([['x', closable()]]),
    };
}

function harness({ assignment = {}, allowVoice = true, others = [] } = {}) {
    const sent = [];
    const broadcasts = [];
    return {
        sent,
        broadcasts,
        peer: fakePeer(),
        channel: { id: 'c-b', name: 'The Library', allowVoice },
        sfu: fakeSfu(assignment),
        // `all` feeds the per-recipient announcement; `db` answers the channel lookups
        // the privacy mask and occupancy stamps make. Public channels, so no masking.
        peers: { get: () => null, channelSnapshot: () => [], all: others },
        db: { prepare: () => ({ get: () => undefined, run: () => {} }) },
        ws: {
            send: (sock, type, payload) => sent.push({ sock, type, payload }),
            broadcast: (type, payload) => broadcasts.push({ type, payload }),
        },
        hooks: { emit: () => {} },
    };
}

const moved = (h) => h.sent.find((m) => m.type === 'moved');

test('a move within one worker keeps the media path', () => {
    // Both channels on worker 0 share a router, so the transports and the producer are
    // still valid. Tearing them down would cost a second of silence for no reason, on what
    // is the ONLY kind of move a default single-worker server ever performs.
    const h = harness({ assignment: { 'c-a': 0, 'c-b': 0 } });
    movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks });

    assert.equal(moved(h).payload.mediaReset, false);
    assert.equal(h.peer.transports.size, 2, 'transports survive');
    assert.equal(h.peer.producers.size, 1, 'and so does the producer');
    assert.equal([...h.peer.transports.values()].some((t) => t.closed), false);
});

test('a move across workers tears the media path down', () => {
    const h = harness({ assignment: { 'c-a': 0, 'c-b': 1 } });
    const [send, recv] = [h.peer.transports.get('send'), h.peer.transports.get('recv')];
    const producer = h.peer.producers.get('audio');

    movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks });

    assert.equal(moved(h).payload.mediaReset, true, 'the client must be told to rebuild');
    assert.equal(send.closed, true);
    assert.equal(recv.closed, true);
    assert.equal(producer.closed, true, 'a producer on the old router can never be heard');
    assert.equal(h.peer.transports.size, 0);
    assert.equal(h.peer.producers.size, 0);
});

test('consumers are closed either way', () => {
    // They belong to the old channel's router regardless, and leaving them open would keep
    // feeding a room the peer has left — which matters most when the move was not theirs.
    for (const assignment of [{ 'c-a': 0, 'c-b': 0 }, { 'c-a': 0, 'c-b': 1 }]) {
        const h = harness({ assignment });
        const consumer = h.peer.consumers.get('x');
        movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks });
        assert.equal(consumer.closed, true);
        assert.equal(h.peer.consumers.size, 0);
    }
});

test('a channel that forbids voice closes the microphone, whatever the worker', () => {
    const h = harness({ assignment: { 'c-a': 0, 'c-b': 0 }, allowVoice: false });
    const producer = h.peer.producers.get('audio');
    movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks });

    assert.equal(producer.closed, true);
    assert.equal(h.peer.producers.has('audio'), false);
    // Hiding a mic button in a client is a suggestion; closing the producer is the control.
});

test('moving to the room you are already in does nothing at all', () => {
    const h = harness({ assignment: { 'c-a': 0 } });
    h.channel = { id: 'c-a', name: 'Same', allowVoice: true };

    const result = movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks });

    assert.equal(result.moved, false);
    assert.equal(h.sent.length, 0, 'no frames');
    assert.equal(h.peer.transports.size, 2, 'and certainly no teardown');
});

test('the peer ends up in the new channel and everyone is told', () => {
    // The arrival is no longer a room-scoped broadcast: every connection gets the
    // upsert directly (masked per recipient), so it shows in `sent`, not `broadcasts`.
    const bystander = { cid: 'cid-2', userId: 'u-2', ws: { cid: 'cid-2' } };
    const h = harness({ assignment: { 'c-a': 0, 'c-b': 1 }, others: [bystander] });
    movePeer({ db: h.db, peer: h.peer, channel: h.channel, peers: h.peers, sfu: h.sfu, ws: h.ws, hooks: h.hooks, reason: 'admin', by: 'Kestrel' });

    assert.equal(h.peer.channelId, 'c-b');
    assert.equal(moved(h).payload.reason, 'admin');
    assert.equal(moved(h).payload.by, 'Kestrel');

    const types = h.broadcasts.map((b) => b.type);
    assert.ok(types.includes('peer_left'), 'the old room hears the departure');

    const upsert = h.sent.find((m) => m.type === 'peer_joined');
    assert.ok(upsert, 'every other connection hears the arrival directly');
    assert.equal(upsert.sock, bystander.ws);
    assert.equal(upsert.payload.peer.channelId, 'c-b');
});
