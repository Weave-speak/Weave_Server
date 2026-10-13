// What a closed socket means for the peer that was standing on it.
//
// A socket closing is not a person leaving. The transports under a peer are ICE/DTLS over
// UDP straight to this machine, while the socket rides the reverse proxy or tunnel — two
// different roads — so the common failure is the socket dying while every stream it set
// up is still flowing. Removing the peer at that moment is what turned each blip into a
// rebuild: transports closed, a screen share ended for everyone watching it, a departure
// and an arrival announced to the room, and the client back a second later as somebody
// new. The log from 2026-10-12 shows it nine times in one evening, each one a 1006 and a
// `peer.joined` under a fresh cid less than two seconds later.
//
// The resume key was meant to prevent exactly that, but it could only claim a peer that
// was still standing, and nothing kept one standing. It worked when the server had not yet
// noticed the old socket was dead — a silent stall the client caught first — and never
// when the close was visible on both sides at once.
//
// So a close that does not SAY the person is going now holds the peer for a grace window,
// and a client presenting the peer's resume key within it takes the peer back with nothing
// rebuilt and nothing announced. Kept apart from index.js, with its timers injected, so the
// rule can be tested without a worker, a database or a socket.

/**
 * How long a peer whose socket dropped can still be claimed back.
 *
 * Long enough for a reconnect after a visible close (the client's first retry lands inside
 * a second) and for a tunnel restarting under everybody at once. The cost is that somebody
 * whose machine really did die stays listed, silent, for this long — still shorter than
 * the heartbeat sweep has always taken to notice a socket that simply went quiet.
 */
export const RESUME_GRACE_MS = 60_000;

/**
 * Closes that leave the door open.
 *
 * 1006 says nothing at all: no close frame arrived, which is what a network fault, a tunnel
 * dropping the stream and the heartbeat sweep's terminate() all look like from here. 4001
 * is the client abandoning a socket whose heartbeat went unanswered, on its way to a new
 * one. 1008 is our own rate limit, after which the client deliberately comes back.
 *
 * Everything else is a close frame somebody CHOSE to send — a leave (4000), the app quitting
 * or reloading (1001), a plain close — and a person who chose to go should be gone at once,
 * not listed for another minute. Closes the server makes on an account's behalf (a kick, a
 * revoked session, a wipe) never wait for this at all: they end the peer where they are
 * made, because the close handshake to a dead client would otherwise come back as a 1006.
 */
const RESUMABLE = new Set([1006, 4001, 1008]);

/**
 * @param {object} deps
 * @param {import('./index.js').PeerRegistry} deps.peers
 */
export function createDeparture({
    peers,
    graceMs = RESUME_GRACE_MS,
    now = () => Date.now(),
    // Unref'd: a peer nobody came back for must never be what keeps the process alive.
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer = (t) => clearTimeout(t),
}) {
    const pending = new Set();

    return {
        /**
         * Decide what a closed socket costs its peer, and act on it.
         *
         * @returns {'gone'|'superseded'|'ended'|'detached'} for the log and the tests
         */
        onSocketClosed(sock, code) {
            const peer = peers.get(sock.cid);
            // Already ended — by a kick, a revoke, a wipe — before its socket finished closing.
            if (!peer) return 'gone';
            // A resume moved the peer onto a newer socket. This close is the old one going,
            // and reading it as a departure would tear down the very transports the resume
            // just saved.
            if (peer.ws !== sock) return 'superseded';

            if (!RESUMABLE.has(code)) {
                peers.end(peer.cid, 'closed');
                return 'ended';
            }

            // The mark is compared by identity when the timer fires. A resume clears it and a
            // later drop sets a new one, and an older timer must not end a peer that has come
            // back and dropped again since.
            const mark = { at: now(), cancel: null };
            const timer = setTimer(() => {
                pending.delete(timer);
                if (peers.get(peer.cid) === peer && peer.detached === mark) peers.end(peer.cid, 'expired');
            }, graceMs);
            pending.add(timer);
            mark.cancel = () => { clearTimer(timer); pending.delete(timer); };
            peer.detached = mark;

            sock.log?.info({ evt: 'peer.detached', code, graceMs },
                `Connection lost (${code}); holding ${peer.username}'s place for ${Math.round(graceMs / 1000)}s`);
            return 'detached';
        },

        /** Nothing may fire into a server that is shutting down. */
        stop() {
            for (const timer of pending) clearTimer(timer);
            pending.clear();
        },
    };
}
