// Moving a peer between channels.
//
// Extracted because there is more than one way to be moved — you pick a channel, an
// administrator moves you, or a module decides you have gone idle — and every one of
// them must do the same things in the same order. The previous server had this logic
// inline in one handler, so an admin-initiated move and a self-initiated move drifted
// apart and behaved differently.

import { PeerRegistry, SLOTS } from './index.js';
import { HOOKS } from '../hooks/index.js';

/**
 * Move `peer` into `channel`.
 *
 * `reason` reaches the client so it can say something true — "you were moved by an
 * administrator" and "you were moved for being idle" are different messages, and the
 * previous server showed the admin one for both.
 */
export function movePeer({ peer, channel, peers, sfu, ws, hooks, reason = 'self', by = null }) {
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

    toChannel(from, 'peer_left', { cid: peer.cid, userId: peer.userId, moved: true }, peer.cid);
    peer.channelId = channel.id;

    ws.send(peer.ws, 'moved', {
        channel,
        reason,
        by,
        rtpCapabilities: sfu.rtpCapabilities(channel.id),
        peers: peers.channelSnapshot(channel.id, peer.cid),
    });

    toChannel(channel.id, 'peer_joined', { peer: PeerRegistry.publicView(peer) }, peer.cid);
    hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: channel.id, reason });

    return { moved: true, channel };
}
