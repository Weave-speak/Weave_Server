// Moving a peer between channels.
//
// Extracted because there is more than one way to be moved — you pick a channel, an
// administrator moves you, or a module decides you have gone idle — and every one of
// them must do the same things in the same order. The previous server had this logic
// inline in one handler, so an admin-initiated move and a self-initiated move drifted
// apart and behaved differently.

import { PeerRegistry, SLOTS } from './index.js';
import { viewFor } from './visibility.js';
import { getChannel, touchOccupancy } from '../channels/index.js';
import { HOOKS } from '../hooks/index.js';

/**
 * Move `peer` into `channel`.
 *
 * `reason` reaches the client so it can say something true — "you were moved by an
 * administrator" and "you were moved for being idle" are different messages, and the
 * previous server showed the admin one for both.
 */
/** Moves a person makes themselves. Arriving that way takes the account's voice. */
const CHOSEN_MOVES = new Set(['self', 'dm-call']);

export function movePeer({ db, peer, channel, peers, sfu, ws, hooks, reason = 'self', by = null }) {
    const from = peer.channelId;
    if (from === channel.id) return { moved: false, channel };

    const toChannel = (channelId, type, payload, exceptCid = null) =>
        ws.broadcast(type, payload, (sock) => {
            const other = peers.get(sock.cid);
            return other && other.channelId === channelId && other.cid !== exceptCid;
        });

    // Consumers belong to the old channel's router and cannot follow. Closing them is
    // also what stops a moved peer continuing to receive media from a room they have
    // left, which matters when the move was not their idea.
    for (const consumer of peer.consumers.values()) {
        try { consumer.close(); } catch { /* already closed */ }
    }
    peer.consumers.clear();

    // A channel that forbids voice closes the producer server-side. Hiding a mic button
    // in a client is a suggestion, not a control.
    if (!channel.allowVoice) {
        const audio = peer.producers.get(SLOTS.AUDIO);
        if (audio) {
            audio.close();
            peer.producers.delete(SLOTS.AUDIO);
        }
    }

    // A transport belongs to the router that created it, and a router belongs to one
    // worker. Channels on the SAME worker share a router, so a move between them keeps
    // every transport and producer valid — which is every move when there is one worker,
    // and one worker is the default.
    //
    // Across workers it is a different story, and a quiet one. The peer's send transport
    // still lives on the old router, so their producer stays there too: they arrive in the
    // new room apparently fine, still "producing", and nobody can hear them. Their recv
    // transport is on the old router as well, so they hear nobody either. No error is
    // raised anywhere, because nothing has technically failed — the media is simply on a
    // router with no one on it.
    //
    // So when the worker changes, the media path is torn down and the client is told to
    // build a new one. A rebuild costs a second or two of silence; the alternative costs
    // the whole call, silently.
    const mediaReset = from !== null
        && sfu.workerIndexFor(from) !== sfu.workerIndexFor(channel.id);
    if (mediaReset) {
        for (const producer of peer.producers.values()) {
            try { producer.close(); } catch { /* already closed */ }
        }
        peer.producers.clear();

        for (const transport of peer.transports.values()) {
            try { transport.close(); } catch { /* already closed */ }
        }
        peer.transports.clear();
    }

    // The old room's clients drop their consumers of this peer on this frame; everyone
    // else merely files the departure. Global, because every sidebar shows every room.
    if (from !== null) {
        toChannel(from, 'peer_left', { cid: peer.cid, userId: peer.userId, moved: true }, peer.cid);
    }
    peer.channelId = channel.id;

    ws.send(peer.ws, 'moved', {
        channel,
        reason,
        by,
        // The client rebuilds its transports and re-produces when this is set. It is false
        // for every move on a single-worker server, which is the common case.
        mediaReset,
        rtpCapabilities: sfu.rtpCapabilities(channel.id),
        peers: peers.channelSnapshot(channel.id, peer.cid),
    });

    // Everyone refiles the mover — masked per recipient, so stepping INTO a private
    // room looks to a non-member like stepping out of sight.
    const view = PeerRegistry.publicView(peer);
    for (const other of peers.all) {
        if (other.cid === peer.cid) continue;
        ws.send(other.ws, 'peer_joined', { peer: viewFor(db, view, other.userId) });
    }
    if (channel.private) touchOccupancy(db, channel.id);
    if (from) {
        const fromChannel = getChannel(db, from);
        if (fromChannel?.private) touchOccupancy(db, from);
    }
    hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: channel.id, reason });

    // Picking a room on this device, or answering a call on it, is choosing where to be
    // heard — so the account's other connections step out. An administrator's move and the
    // idle sweep are not the person's choice and take nobody else with them.
    if (CHOSEN_MOVES.has(reason)) standDownOthers({ db, peer, peers, ws, hooks });

    return { moved: true, channel };
}

/**
 * Take `peer` out of its room without taking it off the server: media closes, presence
 * stays, and the client is told with the same `left` frame the Leave button gets.
 *
 * Returns false when the peer was standing nowhere already. `reason` other than 'left'
 * rides on the frame, so the client can say why it is out of the room.
 */
export function standNowhere({ db, peer, peers, ws, hooks, reason = 'left' }) {
    const from = peer.channelId;
    if (from === null) return false;

    // The same teardown a cross-worker move does: transports close, which closes
    // producers and fires producerclose on every consumer elsewhere — the normal path.
    for (const consumer of peer.consumers.values()) {
        try { consumer.close(); } catch { /* already closed */ }
    }
    peer.consumers.clear();
    for (const producer of peer.producers.values()) {
        try { producer.close(); } catch { /* already closed */ }
    }
    peer.producers.clear();
    for (const transport of peer.transports.values()) {
        try { transport.close(); } catch { /* already closed */ }
    }
    peer.transports.clear();

    // The room being left is told the way movePeer tells it, and before the upsert, so
    // its clients drop whatever they hold of this peer and then refile them as standing
    // nowhere. Each consumer's own closure notice is not that: it only reaches a listener
    // the server still has a consumer for. A listener whose client held a stale one —
    // the server's side long gone — was told nothing at all, so "Leave the room" and
    // straight back in, the first thing anybody tries, changed nothing for exactly the
    // listeners it was meant to fix.
    ws.broadcast('peer_left', { cid: peer.cid, userId: peer.userId, moved: true }, (sock) => {
        const other = peers.get(sock.cid);
        return other && other.channelId === from && other.cid !== peer.cid;
    });

    const fromChannel = getChannel(db, from);
    // Logged because its absence read as something else: a timeline showing somebody
    // "moved to General from nowhere", with no departure anywhere before it.
    peer.ws?.log?.info({ evt: 'peer.left_room', from: fromChannel?.name ?? from, reason },
        `${peer.username} left ${fromChannel?.name ?? 'the room'}${reason === 'elsewhere' ? ' for another device' : ''}`);

    peer.channelId = null;
    ws.send(peer.ws, 'left', { channel: null, ...(reason !== 'left' ? { reason } : {}) });

    // An upsert everyone understands: the same peer, now standing nowhere.
    const view = PeerRegistry.publicView(peer);
    for (const other of peers.all) {
        if (other.cid === peer.cid) continue;
        ws.send(other.ws, 'peer_joined', { peer: viewFor(db, view, other.userId) });
    }
    if (fromChannel?.private) touchOccupancy(db, from);
    hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: null, reason });
    return true;
}

/**
 * One account, one voice: every connection `peer`'s account holds, except `peer`, stands
 * nowhere.
 *
 * Somebody signed in on a laptop and a phone used to be in the room twice — two
 * microphones the room heard at once, and two mute states, so muting on one device left
 * the other one live. The connection that most recently chose to be somewhere is the one
 * that is heard; the others stay signed in, reading, and are told why (`left`, reason
 * 'elsewhere'), so their client can offer to bring voice back to them.
 */
export function standDownOthers({ db, peer, peers, ws, hooks }) {
    let stood = 0;
    for (const other of peers.forUser(peer.userId)) {
        if (other.cid === peer.cid) continue;
        if (standNowhere({ db, peer: other, peers, ws, hooks, reason: 'elsewhere' })) stood += 1;
    }
    return stood;
}
