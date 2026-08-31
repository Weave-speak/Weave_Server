// Making a moderation record true of the live server.
//
// Shared between the WebSocket handler (an administrator acting now) and the sweep (an
// expiry running out later), because they must do exactly the same things in the same
// order. The previous server's equivalent had the admin path and the timer path written
// separately, and they gradually stopped matching — see the note at the top of
// peers/move.js for the same lesson learned the same way.

import { SLOTS } from '../peers/index.js';

export function createEnforcer({ peers, ws }) {
    /**
     * Apply — or lift — an administrative mute across every connection an account holds.
     *
     * Per USER, not per connection: the roster shows one row per person, so silencing the
     * laptop while the phone keeps talking would look, from every other client, like the
     * mute simply did not work.
     *
     * Lifting does NOT un-pause someone who has also muted themselves. The two are
     * independent, and only the person themselves can lift theirs.
     */
    return async function applyForceMute(userId, forceMuted, until = null) {
        for (const peer of peers.forUser(userId)) {
            peer.forceMuted = forceMuted;
            peer.forceMutedUntil = forceMuted ? until : null;

            const audio = peer.producers.get(SLOTS.AUDIO);
            if (!audio) continue;
            if (forceMuted) await audio.pause();
            else if (!peer.muted) await audio.resume();
        }
        // Broadcast even when nobody by that id is connected: an administrator watching
        // the roster is owed the mark appearing, and a mute applied to an offline account
        // is still a fact about them.
        ws.broadcast('peer_force_muted', { userId, forceMuted, until });
    };
}
