// The invariant nobody was checking: everyone in a voice channel hears everyone else.
//
// Consuming is driven by events — a `producer_new` broadcast when somebody starts
// talking, and the client's own heal on a heartbeat. Both are client-side, so both fail
// the same way: if a client misses the frame, it does not know it missed anything. It
// never asks again, nothing errors, and the room looks perfect from every angle. One
// person is simply inaudible to one other person, for as long as they both stay.
//
// That is precisely how it presented: a producer replaced three times in thirteen seconds
// (two channel moves and a reconnect) and one client left consuming a producer that no
// longer existed, while the server logged a clean, healthy session.
//
// The server is the only party that knows BOTH halves — who is producing and who is
// consuming — so the check belongs here. It is a reconciliation, not an event: it
// compares what should be true against what is true, and repairs the difference.
//
// Deliberately scoped to the AUDIO slot. Video is opt-in (a placeholder until someone
// presses Watch), so a missing video consumer is the normal resting state and flagging it
// would bury the real signal in noise. "Everyone hears everyone" is the invariant that
// actually holds for every member of a voice channel, always.

// Five seconds, checked twice before acting, so a genuine gap is repaired within about
// ten. The pass is a walk over peers already in memory — no I/O, nothing to rate-limit —
// and the grace period only has to outlast a client's normal reaction to producer_new,
// which is well under a second. Ten seconds of silence in a conversation is already
// long; twenty was worse.
const DEFAULT_INTERVAL_MS = 5_000;
const AUDIO_SLOT = 'audio';

/**
 * Start reconciling. Returns a stop function.
 *
 * A gap must be seen TWICE in a row before it is repaired. A client that joined a
 * moment ago, or one midway through building its receive transport, is legitimately
 * missing consumers for a second or two, and nudging it then would be noise at best and
 * a duplicate-consume race at worst.
 */
export function watchRoomMedia({
    peers,
    ws,
    log,
    intervalMs = DEFAULT_INTERVAL_MS,
    setTimer = setInterval,
    clearTimer = clearInterval,
}) {
    // 'listenerCid:speakerCid' seen missing on the previous pass.
    let pending = new Set();

    function pass() {
        const byChannel = new Map();
        for (const peer of peers?.all ?? []) {
            if (!peer.channelId) continue;
            if (!byChannel.has(peer.channelId)) byChannel.set(peer.channelId, []);
            byChannel.get(peer.channelId).push(peer);
        }

        const stillMissing = new Set();
        for (const members of byChannel.values()) {
            if (members.length < 2) continue;

            for (const listener of members) {
                // Every (speaker, slot) this listener already receives.
                const have = new Set();
                for (const consumer of listener.consumers?.values() ?? []) {
                    if (consumer.closed) continue;
                    have.add(`${consumer.appData?.fromCid}:${consumer.appData?.slot}`);
                }

                for (const speaker of members) {
                    if (speaker.cid === listener.cid) continue;
                    const producer = speaker.producers?.get(AUDIO_SLOT);
                    if (!producer || producer.closed) continue;
                    if (have.has(`${speaker.cid}:${AUDIO_SLOT}`)) continue;

                    const key = `${listener.cid}:${speaker.cid}`;
                    stillMissing.add(key);
                    // First sighting is not yet a fault — see the note above.
                    if (!pending.has(key)) continue;

                    log.warn({
                        evt: 'sfu.consumer_missing',
                        listener: listener.username,
                        speaker: speaker.username,
                        channelId: listener.channelId,
                    }, `${listener.username} is not receiving ${speaker.username} — re-announcing`);

                    // The same frame the speaker's own produce would have sent. The
                    // client's consume() already refuses duplicates, so a nudge that
                    // turns out to be unnecessary costs one ignored message.
                    ws.send(listener.ws, 'producer_new', {
                        cid: speaker.cid,
                        userId: speaker.userId,
                        slot: AUDIO_SLOT,
                        producerId: producer.id,
                        kind: producer.kind,
                    });
                }
            }
        }
        pending = stillMissing;
    }

    const timer = setTimer(() => {
        try { pass(); } catch (err) {
            log.error({ evt: 'sfu.reconcile_failed', err }, 'Media reconciliation pass threw');
        }
    }, intervalMs);
    timer.unref?.();

    return () => clearTimer(timer);
}
