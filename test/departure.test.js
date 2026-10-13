// What a closed socket costs the peer standing on it.
//
// The evening this exists for: nine people, one after another, had their socket closed
// under them and were back less than two seconds later — as somebody new. The server had
// removed each peer the instant its socket closed, so the resume key they came back with
// claimed nothing, every transport was rebuilt, the room heard them leave and arrive, and
// a screen share being watched ended twice. The media had never been in trouble: it does
// not ride the socket at all.
//
// The real registry, a fake clock, and sockets that are only ever objects — no worker, no
// database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerRegistry } from '../src/core/peers/index.js';
import { createDeparture, RESUME_GRACE_MS } from '../src/core/peers/departure.js';

const quiet = { info: () => {}, warn: () => {} };

const socket = (cid) => ({
    cid,
    closedWith: null,
    close(code, reason) { this.closedWith = { code, reason }; },
    log: quiet,
});

const session = (userId, username = userId) => ({
    userId, username, displayName: username, avatar: null, isAdmin: false,
});

const closable = () => {
    const it = { closed: false, close() { it.closed = true; } };
    return it;
};

/** A clock the test advances, running any timer that has come due. */
function fakeClock() {
    let t = 1_000_000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: t + ms }); return seq; },
        clearTimer: (id) => { timers.delete(id); },
        advance(ms) {
            t += ms;
            for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at > t) continue;
                timers.delete(id);
                timer.fn();
            }
        },
        get pending() { return timers.size; },
    };
}

function harness() {
    const clock = fakeClock();
    const peers = new PeerRegistry(quiet);
    const ended = [];
    peers.onEnd = (peer, reason) => ended.push({ cid: peer.cid, reason });
    const departure = createDeparture({
        peers, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });

    /** Somebody standing in the hall, sending something, on a socket of their own. */
    function stand(cid = 'AAA', userId = 'u-chris') {
        const sock = socket(cid);
        const peer = peers.add(sock, session(userId), 'hall', 1);
        peer.transports.set('send', closable());
        return { sock, peer };
    }

    return { clock, peers, ended, departure, stand };
}

test('a dropped socket holds the peer, and the client claims it back intact', () => {
    const { clock, peers, ended, departure, stand } = harness();
    const { sock, peer } = stand();

    assert.equal(departure.onSocketClosed(sock, 1006), 'detached');

    // Still standing, still sending: from every other screen, nothing happened.
    assert.equal(peers.get('AAA'), peer);
    assert.equal(peer.transports.get('send').closed, false);
    assert.deepEqual(ended, []);

    // The client is back a second later with the key it was given.
    clock.advance(1_000);
    const claimed = peers.claim(peer.resumeKey, 'u-chris');
    assert.equal(claimed, peer, 'the key still claims the peer it was issued for');
    peers.rebind(claimed, socket('BBB'));

    assert.equal(peer.detached, null);
    assert.equal(clock.pending, 0, 'the timer that would have ended it is gone');
    clock.advance(RESUME_GRACE_MS * 2);
    assert.deepEqual(ended, [], 'and nothing ends it later');
});

test('nobody coming back ends the peer once, when the grace runs out', () => {
    const { clock, peers, ended, departure, stand } = harness();
    const { sock, peer } = stand();
    const key = peer.resumeKey;

    departure.onSocketClosed(sock, 1006);

    clock.advance(RESUME_GRACE_MS - 1);
    assert.equal(peers.get('AAA'), peer, 'still claimable a moment before the end');

    clock.advance(1);
    assert.deepEqual(ended, [{ cid: 'AAA', reason: 'expired' }]);
    assert.equal(peers.get('AAA'), undefined);
    assert.equal(peer.transports.get('send').closed, true, 'ending a peer stops its media');
    assert.equal(peers.claim(key, 'u-chris'), null, 'and a late key is a fresh join');

    clock.advance(RESUME_GRACE_MS);
    assert.equal(ended.length, 1, 'announced once, not once per timer');
});

test('the closes that mean "coming back" wait like a drop does', () => {
    // 4001 is the client abandoning a socket whose heartbeat went unanswered, on its way to
    // a new one. 1008 is our own rate limit, after which it returns on purpose.
    for (const code of [1006, 4001, 1008]) {
        const { departure, stand, ended } = harness();
        const { sock } = stand();
        assert.equal(departure.onSocketClosed(sock, code), 'detached', `code ${code}`);
        assert.deepEqual(ended, []);
    }
});

test('a close somebody chose ends the peer at once', () => {
    // A leave, the app quitting or reloading, a plain close with or without a status. Being
    // listed for another minute after deliberately going is a lie told to the whole room.
    for (const code of [1000, 1001, 1005, 4000]) {
        const { clock, departure, stand, ended, peers } = harness();
        const { sock } = stand();
        assert.equal(departure.onSocketClosed(sock, code), 'ended', `code ${code}`);
        assert.deepEqual(ended, [{ cid: 'AAA', reason: 'closed' }]);
        assert.equal(peers.get('AAA'), undefined);
        assert.equal(clock.pending, 0);
    }
});

test('the old socket closing after a resume is not a departure', () => {
    const { clock, peers, ended, departure, stand } = harness();
    const { sock: old, peer } = stand();

    peers.rebind(peer, socket('BBB'));

    // The resumed socket answers to the same cid, so only the socket identity tells the
    // two apart. Reading this as the peer leaving would close the transports just saved.
    assert.equal(departure.onSocketClosed(old, 1006), 'superseded');
    assert.equal(peers.get('AAA'), peer);
    assert.equal(peer.detached, null);
    assert.equal(clock.pending, 0);
    assert.deepEqual(ended, []);
});

test('an older timer cannot end a peer that came back and dropped again', () => {
    const { clock, peers, ended, departure, stand } = harness();
    const { sock, peer } = stand();

    departure.onSocketClosed(sock, 1006);
    clock.advance(RESUME_GRACE_MS / 2);

    const second = socket('BBB');
    peers.rebind(peer, second);
    departure.onSocketClosed(second, 1006);

    // Where the first drop's timer would have fired had the resume not cancelled it.
    clock.advance(RESUME_GRACE_MS / 2);
    assert.equal(peers.get('AAA'), peer, 'the second drop gets a whole grace of its own');

    clock.advance(RESUME_GRACE_MS / 2);
    assert.deepEqual(ended, [{ cid: 'AAA', reason: 'expired' }]);
});

test('a kick or revoke of a held peer ends it now, not when its grace runs out', () => {
    const { clock, peers, ended, departure, stand } = harness();
    const { sock } = stand();

    departure.onSocketClosed(sock, 1006);
    // Its socket is already gone, so closing it does nothing; the old code relied on that
    // close to remove the peer, and would have left the person listed for the full window.
    const closed = peers.closeForUser('u-chris', { code: 4006, reason: 'kicked' });

    assert.equal(closed, 1);
    assert.deepEqual(ended, [{ cid: 'AAA', reason: 'kicked' }]);
    assert.equal(peers.get('AAA'), undefined);
    assert.equal(clock.pending, 0);
});

test('a server-side close ends a live peer at once, whatever its close event says later', () => {
    // A kicked client whose line is dead never answers the close frame, and the handshake
    // ends thirty seconds later as a 1006 — the code that means "hold this peer". Ending
    // it where the close is made is what keeps a kick from turning into a reprieve.
    const { clock, peers, ended, departure, stand } = harness();
    const { sock } = stand();

    peers.closeForUser('u-chris', { code: 4007, reason: 'session revoked' });
    assert.deepEqual(sock.closedWith, { code: 4007, reason: 'session revoked' });
    assert.deepEqual(ended, [{ cid: 'AAA', reason: 'session revoked' }]);

    assert.equal(departure.onSocketClosed(sock, 1006), 'gone');
    assert.equal(clock.pending, 0);
    assert.equal(ended.length, 1);
});

test('stopping cancels every pending grace, so nothing fires into a closed server', () => {
    const { clock, ended, departure, stand } = harness();
    departure.onSocketClosed(stand('AAA', 'u-chris').sock, 1006);
    departure.onSocketClosed(stand('BBB', 'u-sinister').sock, 1006);
    assert.equal(clock.pending, 2);

    departure.stop();
    assert.equal(clock.pending, 0);
    clock.advance(RESUME_GRACE_MS * 2);
    assert.deepEqual(ended, []);
});
