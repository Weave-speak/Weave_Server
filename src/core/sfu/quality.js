// Whether the media anyone is actually receiving is any good.
//
// Until this existed the server had no quality signal at all: no consumer scores, no
// bandwidth estimate, no packet counters. Object existence was the only thing it knew, so
// "the call sounds terrible" could only ever be answered with a guess, and a regression
// in the codec parameters or the rate limits would have been invisible until somebody
// complained loudly enough to be believed.
//
// Scores are PUSHED by the mediasoup worker and cached on the JS object, so subscribing
// costs nothing per sample. Polling getStats() instead would be a round trip per consumer
// per interval, which on a Raspberry Pi carrying every channel on one core is a tax worth
// refusing.

/** Consumer score, 0–10. Below this and the receiver is losing packets they can hear. */
export const POOR_SCORE = 6;

/**
 * How many consecutive bad samples before it is worth saying.
 *
 * The same two-strike restraint the media reconciler uses, for the same reason: a
 * consumer that has existed for four hundred milliseconds is legitimately bad, and a
 * server that cried about every one of those would train everyone to ignore it.
 */
export const STRIKES = 2;

/**
 * Decide whether a run of scores is worth reporting.
 *
 * Pure, and separated from the subscription, so the judgement can be tested exhaustively
 * without a worker, a router or a port.
 *
 * @param {number[]} history most recent scores last
 * @returns {boolean} true on the sample that crosses the threshold, and not again
 */
export function isNewlyPoor(history, { poor = POOR_SCORE, strikes = STRIKES } = {}) {
    if (history.length < strikes) return false;
    const recent = history.slice(-strikes);
    if (!recent.every((score) => score < poor)) return false;
    // Only the crossing is reported. Without this a consumer that stays bad for a minute
    // would log thirty identical lines and bury whatever came next.
    const before = history.at(-strikes - 1);
    return before === undefined || before >= poor;
}

/**
 * Watch one router's consumers. Returns a stop function.
 *
 * `observe` is called for every consumer as it is created; the watch keeps no registry of
 * its own, because a consumer that has closed should stop being interesting the moment it
 * does, and mediasoup already emits that.
 */
export function watchQuality({ log, hooks = null } = {}) {
    const histories = new WeakMap();
    let worstSeen = 10;
    let poorNow = 0;

    return {
        /**
         * @param {object} consumer a mediasoup Consumer
         * @param {{listener: string, speaker: string, slot: string}} meta for the log line
         */
        observe(consumer, meta) {
            histories.set(consumer, []);

            consumer.on('score', ({ score }) => {
                const history = histories.get(consumer);
                if (!history) return;
                history.push(score);
                // Bounded: only the last few samples decide anything, and a consumer open
                // for an hour must not accumulate an hour of numbers.
                if (history.length > STRIKES + 1) history.shift();

                if (score < worstSeen) worstSeen = score;

                if (isNewlyPoor(history)) {
                    poorNow += 1;
                    log.warn({
                        evt: 'consumer.poor', score, slot: meta.slot,
                        listener: meta.listener, speaker: meta.speaker,
                    }, `${meta.listener} is receiving ${meta.speaker}'s ${meta.slot} badly (score ${score})`);
                    hooks?.emit?.('media:poor', { ...meta, score });
                }
            });

            consumer.observer.on('close', () => histories.delete(consumer));
        },

        /** A rollup for the admin overview, which already renders a `media` block. */
        snapshot() {
            return { worstConsumerScore: worstSeen, poorEvents: poorNow };
        },

        /** Forget what has been seen, so the next window reports itself honestly. */
        reset() {
            worstSeen = 10;
            poorNow = 0;
        },
    };
}
