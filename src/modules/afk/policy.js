// When is somebody actually away?
//
// Extracted from the module because this is the part that is worth being sure about and
// the part that is awkward to reach through a running server: the sweep needs a channel,
// an away room, a timer and two live peers before it will tell you anything. These are
// plain functions of numbers, so every case — including the ones that only happen at 3am
// on somebody's laptop — can be stated directly.

/**
 * How long an idle report stays believable.
 *
 * The heartbeat carrying it runs every 25 seconds, so this is a few missed beats: long
 * enough to survive a hiccup, short enough that a client which stopped talking cannot keep
 * its owner marked active on the strength of something it said minutes ago. Trusting a
 * last-known figure forever is the one way a self-reported signal is worse than none.
 */
export const REPORT_TTL_MS = 90_000;

/**
 * Milliseconds since this client last saw input, or null if it is not telling us.
 *
 * Null and zero are different answers and must never be conflated. Null is "this client
 * cannot see OS input" — every browser — and it means fall back. Zero is "somebody just
 * moved the mouse".
 *
 * The age of the report is ADDED, because the time since it arrived was also idle: a
 * report of "2 minutes" that landed 30 seconds ago describes someone idle for two and a
 * half.
 */
export function reportedIdleMs(peer, now) {
    if (!peer || !Number.isFinite(peer.idleMs) || !peer.idleReportedAt) return null;
    const age = now - peer.idleReportedAt;
    if (age < 0 || age > REPORT_TTL_MS) return null;
    return peer.idleMs + age;
}

/**
 * The moment this person last gave evidence of existing.
 *
 * The LATER of the two signals, because either one is evidence on its own: somebody
 * talking without touching the mouse is present, and so is somebody typing in silence.
 * Taking the earlier would move whichever half happened to be quiet, which is how a
 * two-signal system ends up worse than either signal alone.
 *
 * @param {number} spoke  when audio was last heard from them
 */
export function activeSince({ peer, spoke, now }) {
    const reported = reportedIdleMs(peer, now);
    if (reported === null) return spoke;
    return Math.max(spoke, now - reported);
}

/**
 * Why this person will not be moved, or null if nothing protects them.
 *
 * @param {Set} optedOut  user ids that have opted out, per account
 */
export function exemptionFor(peer, { optedOut, slots, now }) {
    if (peer.producers.has(slots.SCREEN) || peer.producers.has(slots.WEBCAM)) return 'sharing';
    // Only where silence is the ONLY signal. A listener with no microphone cannot be
    // measured by audio, but their keyboard can be — and keeping the exemption anyway
    // would mean the better signal made the feature apply to fewer people, not more.
    if (!peer.producers.has(slots.AUDIO) && reportedIdleMs(peer, now) === null) {
        return 'no microphone';
    }
    if (optedOut.has(peer.userId)) return 'opted out';
    return null;
}
