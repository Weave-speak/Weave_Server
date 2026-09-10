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

import { randomBytes } from 'node:crypto';

export const SLOTS = Object.freeze({
    AUDIO: 'audio',
    SCREEN: 'screen',
    WEBCAM: 'webcam',
    SCREEN_AUDIO: 'screen-audio',
});

const VALID_SLOTS = new Set(Object.values(SLOTS));
export const isValidSlot = (slot) => VALID_SLOTS.has(slot);

/** Long enough that guessing is not a strategy, short enough to sit in a JSON frame. */
const newResumeKey = () => randomBytes(18).toString('base64url');

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
            // Declared, not derived. The roster separately works out "away" from standing
            // in an AFK channel; this is what the person themselves said.
            status: session.status ?? 'online',
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
            // Reported by the client on its heartbeat where the platform can see OS input
            // at all. Null means "this client cannot tell us", which is not the same as
            // zero and must not be read as activity.
            idleMs: null,
            idleReportedAt: null,
            transports: new Map(),  // 'send' | 'recv' -> transport
            producers: new Map(),   // slot -> producer
            consumers: new Map(),   // consumerId -> consumer
            // The bearer secret that lets a RETURNING socket claim this peer instead of
            // building a new one. It never leaves publicView, and it is rotated on every
            // use: a key that has been spent cannot be replayed by anything that saw it.
            resumeKey: newResumeKey(),
        };
        this.#peers.set(ws.cid, peer);
        return peer;
    }

    get(cid) {
        return this.#peers.get(cid);
    }

    /**
     * The peer this resume key belongs to, if it is still standing.
     *
     * The account is checked as well as the key. A key is a bearer secret, and without
     * this a leaked one would be an account takeover rather than a reconnection.
     */
    claim(key, userId) {
        if (!key || typeof key !== 'string') return null;
        for (const peer of this.#peers.values()) {
            if (peer.resumeKey === key && peer.userId === userId) return peer;
        }
        return null;
    }

    /**
     * Move a standing peer onto a new socket.
     *
     * The cid deliberately does NOT change. It is the name every other client's roster
     * uses, the name in every consumer's appData, and the name this client knows itself
     * by — so keeping it is what makes a reconnection invisible to the room rather than a
     * departure and an arrival. The transports, producers and consumers are untouched:
     * they are ICE/DTLS over UDP and never depended on the socket that asked for them.
     */
    rebind(peer, ws) {
        ws.cid = peer.cid;
        peer.ws = ws;
        peer.resumeKey = newResumeKey();
        return peer.resumeKey;
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
            status: peer.status,
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
