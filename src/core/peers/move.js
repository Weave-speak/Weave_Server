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
    const mediaReset = sfu.workerIndexFor(from) !== sfu.workerIndexFor(channel.id);
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

    toChannel(from, 'peer_left', { cid: peer.cid, userId: peer.userId, moved: true }, peer.cid);
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

    toChannel(channel.id, 'peer_joined', { peer: PeerRegistry.publicView(peer) }, peer.cid);
    hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: channel.id, reason });

    return { moved: true, channel };
}
