// Claiming a peer back after the socket under it died.
//
// A peer is one WebSocket, which made a reconnection a brand-new peer: a fresh cid, no
// transports, no producers, and — from every other screen in the room — somebody leaving
// and arriving again. The media never needed any of that. Transports are ICE/DTLS over
// UDP and outlive the socket that asked for them, so a returning client can be given the
// peer it already had.
//
// The registry is where that has to be right, so it is tested here on its own: no server,
// no worker, no socket.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerRegistry } from '../src/core/peers/index.js';

const socket = (cid) => ({ cid });
const session = (userId, username = userId) => ({
    userId, username, displayName: username, avatar: null, isAdmin: false,
});

const registry = () => new PeerRegistry({ info: () => {}, warn: () => {} });

test('every peer gets its own key, and it never leaves the server', () => {
    const peers = registry();
    const a = peers.add(socket('AAA'), session('u-chris'), 'hall', 1);
    const b = peers.add(socket('BBB'), session('u-sinister'), 'hall', 1);

    assert.ok(a.resumeKey?.length >= 20, 'long enough that guessing is not a strategy');
    assert.notEqual(a.resumeKey, b.resumeKey);
    // A bearer secret in the roster would be handed to everyone in the room.
    assert.equal('resumeKey' in PeerRegistry.publicView(a), false);
});

test('a key only claims the account it was issued to', () => {
    const peers = registry();
    const chris = peers.add(socket('AAA'), session('u-chris'), 'hall', 1);

    assert.equal(peers.claim(chris.resumeKey, 'u-chris'), chris);
    // Otherwise a leaked key would be an account takeover rather than a reconnection.
    assert.equal(peers.claim(chris.resumeKey, 'u-sinister'), null);
});

test('nothing claims a peer by accident', () => {
    const peers = registry();
    peers.add(socket('AAA'), session('u-chris'), 'hall', 1);

    for (const nonsense of [undefined, null, '', 0, {}, []]) {
        assert.equal(peers.claim(nonsense, 'u-chris'), null);
    }
    assert.equal(peers.claim('a-key-nobody-issued', 'u-chris'), null);
});

test('rebinding keeps the peer and everything on it, and only moves the socket', () => {
    const peers = registry();
    const first = socket('AAA');
    const peer = peers.add(first, session('u-chris'), 'hall', 1);

    // Whatever the peer was holding when the line dropped.
    peer.transports.set('send', { id: 't-send' });
    peer.producers.set('screen', { id: 'p-screen', kind: 'video', paused: false });
    const spent = peer.resumeKey;

    const second = socket('BBB');
    const issued = peers.rebind(peer, second);

    // The cid is the name every other client's roster, and every consumer's appData,
    // already uses. Changing it here would be the departure this exists to avoid.
    assert.equal(peer.cid, 'AAA');
    assert.equal(second.cid, 'AAA', 'the new socket answers to the peer, not the other way round');
    assert.equal(peers.get('AAA'), peer);
    assert.equal(peers.count, 1, 'one peer, not two');
    assert.equal(peer.ws, second);

    assert.equal(peer.transports.get('send').id, 't-send');
    assert.equal(peer.producers.get('screen').id, 'p-screen');

    // Single use: a key that has been spent cannot be replayed by anything that saw it.
    assert.notEqual(issued, spent);
    assert.equal(peer.resumeKey, issued);
    assert.equal(peers.claim(spent, 'u-chris'), null);
    assert.equal(peers.claim(issued, 'u-chris'), peer);
});

test('a peer that has been removed cannot be claimed back', () => {
    const peers = registry();
    const peer = peers.add(socket('AAA'), session('u-chris'), 'hall', 1);
    const key = peer.resumeKey;

    peers.remove('AAA');

    // An outage longer than the server's grace ends the peer, and the honest answer to a
    // key for something that no longer exists is a fresh join.
    assert.equal(peers.claim(key, 'u-chris'), null);
});
