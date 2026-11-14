// Lifting timed mutes when their time runs out.
//
// Expiry is evaluated in SQL on every read, so a mute is already out of force the moment
// it passes — a client connecting a second later is not muted. What the sweep is for is
// the side effect on somebody who is ALREADY connected: their audio producer is paused,
// and nothing un-pauses it unless something goes looking.
//
// The same shape as watchAnnouncedAddress and watchRoomMedia: a function that returns its
// own stop handle, wired in src/index.js and torn down with the server.

import { expiredMutes, settleExpired } from './index.js';

/**
 * Five seconds.
 *
 * It was half a minute, on the reasoning that a mute overstaying by that much was not worth
 * a busier timer — true while the shortest mute was five minutes, not once thirty seconds
 * became a choice: a 30 s mute could have lasted a full minute. The query is one indexed
 * scan of a table that holds a handful of rows, so running it more often costs nothing.
 */
const DEFAULT_INTERVAL_MS = 5_000;

export function watchMuteExpiry({
    db,
    log,
    applyForceMute,
    intervalMs = DEFAULT_INTERVAL_MS,
    setTimer = setInterval,
    clearTimer = clearInterval,
    now = () => Date.now(),
}) {
    async function sweep() {
        const at = now();
        const users = expiredMutes(db, at);
        if (!users.length) return;

        // Marked settled first. If un-pausing throws for one peer, the row must not be
        // found again on every subsequent sweep for the rest of the server's life.
        settleExpired(db, at);
        for (const userId of users) {
            try {
                await applyForceMute(userId, false);
            } catch (err) {
                log.warn({ evt: 'moderation.lift_failed', userId, err: String(err) },
                    'A server mute expired but the producer could not be resumed');
            }
        }
        log.info({ evt: 'moderation.expired', count: users.length },
            `Lifted ${users.length} expired server mute(s)`);
    }

    const timer = setTimer(() => { sweep().catch(() => {}); }, intervalMs);
    // Never hold the process open for this.
    timer.unref?.();
    // A mute that expired while the server was down is lifted at startup, not one
    // interval later.
    sweep().catch(() => {});

    return () => clearTimer(timer);
}
