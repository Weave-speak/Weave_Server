// The peer roster: who is connected, where they are, and what they are sending.
//
// A "peer" is one live WebSocket with an authenticated session. It is deliberately NOT
// the same thing as a user: the same account may be connected twice, and the roster has
// to survive that without either connection stealing the other's media.
//
// Producer slots are named rather than counted, because "a user's video" is ambiguous
// once someone shares their screen and their camera at the same time. The previous
// server used a single video slot and silently orphaned the first producer when a
// second arrived — an unreachable leak that kept forwarding RTP nobody could see.

export const SLOTS = Object.freeze({
    AUDIO: 'audio',
    SCREEN: 'screen',
    WEBCAM: 'webcam',
    SCREEN_AUDIO: 'screen-audio',
});

const VALID_SLOTS = new Set(Object.values(SLOTS));
export const isValidSlot = (slot) => VALID_SLOTS.has(slot);

export class PeerRegistry {
    #peers = new Map();     // cid -> peer
    #log;

    constructor(log) {
        this.#log = log;
    }

    add(ws, session, channelId, protocol) {
        const peer = {
            cid: ws.cid,
            ws,
            userId: session.userId,
            username: session.username,
            displayName: session.displayName,
            avatar: session.avatar,
            isAdmin: session.isAdmin,
            channelId,
            protocol,
            muted: false,
            deafened: false,
            // Muted BY somebody else. Kept apart from `muted` because they answer
            // different questions: `muted` is a choice this person made and may unmake,
            // forceMuted is a decision they cannot. Collapsing them would leave a client
            // showing an unmute button that silently does nothing.
            forceMuted: false,
            forceMutedUntil: null,
            joinedAt: Date.now(),
            transports: new Map(),  // 'send' | 'recv' -> transport
            producers: new Map(),   // slot -> producer
            consumers: new Map(),   // consumerId -> consumer
        };
        this.#peers.set(ws.cid, peer);
        return peer;
    }

    get(cid) {
        return this.#peers.get(cid);
    }

    /**
     * Tear a peer down completely.
     *
     * Closing the transports is what actually stops media: mediasoup then fires
     * `producerclose` on every consumer elsewhere, so other peers learn about it through
     * the normal path rather than needing a special case here.
     */
    remove(cid) {
        const peer = this.#peers.get(cid);
        if (!peer) return null;

        for (const transport of peer.transports.values()) {
            try { transport.close(); } catch { /* already closed */ }
        }
        this.#peers.delete(cid);
        return peer;
    }

    /** Everyone in a channel, optionally excluding one connection. */
    inChannel(channelId, exceptCid = null) {
        return [...this.#peers.values()]
            .filter((p) => p.channelId === channelId && p.cid !== exceptCid);
    }

    /** Every live connection for one account. Someone may be signed in twice. */
    forUser(userId) {
        return [...this.#peers.values()].filter((p) => p.userId === userId);
    }

    get all() {
        return [...this.#peers.values()];
    }

    get count() {
        return this.#peers.size;
    }

    /** How a peer appears to everyone else. Never leaks the session or the transports. */
    static publicView(peer) {
        return {
            cid: peer.cid,
            userId: peer.userId,
            username: peer.username,
            displayName: peer.displayName,
            avatar: peer.avatar,
            channelId: peer.channelId,
            muted: peer.muted,
            deafened: peer.deafened,
            forceMuted: peer.forceMuted,
            forceMutedUntil: peer.forceMutedUntil,
            producers: [...peer.producers.entries()].map(([slot, producer]) => ({
                slot, id: producer.id, kind: producer.kind, paused: producer.paused,
            })),
        };
    }

    /**
     * Everything a joining peer needs to start consuming in its channel: who is there
     * and what each of them is currently sending.
     */
    channelSnapshot(channelId, exceptCid = null) {
        return this.inChannel(channelId, exceptCid).map((p) => PeerRegistry.publicView(p));
    }

    /** Everyone connected, wherever they stand — the roster a fresh client starts from. */
    snapshot(exceptCid = null) {
        return [...this.all].filter((p) => p.cid !== exceptCid).map((p) => PeerRegistry.publicView(p));
    }
}
