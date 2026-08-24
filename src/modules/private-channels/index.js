// Private rooms: the lifecycle half.
//
// The SECRECY half deliberately lives in core (visibility masking, join guards, the
// no-text rule) so that disabling this module can never expose anyone. What this module
// owns is what makes huddles huddles: anyone may start one, and an empty one does not
// hang around — a room that has stood unoccupied past the window is deleted, roster
// announced, gone.

import { deleteChannel, getChannel } from '../../core/channels/index.js';

const SWEEP_EVERY_MS = 10 * 60 * 1000;

export function register(ctx) {
    ctx.settings.define('idleHours', {
        type: 'number', min: 1, max: 168,
        label: 'Delete after standing empty for (hours)',
        help: 'Measured from the last time anyone was inside. A room in use never expires.',
    }, 2);

    const db = ctx.db.handle;

    const expired = db.prepare(`
        SELECT id, name, last_occupied_at AS lastOccupiedAt FROM channels
        WHERE private = 1 AND COALESCE(last_occupied_at, created_at, 0) < ?`);

    const sweep = () => {
        const cutoff = Date.now() - ctx.settings.get('idleHours') * 60 * 60 * 1000;
        for (const row of expired.all(cutoff)) {
            // Occupancy is the live truth, the timestamp only the trail: a room with
            // people inside is never deleted, however stale its stamp looks.
            if (ctx.peers.inChannel(row.id).length > 0) continue;
            const channel = getChannel(db, row.id);
            if (!channel) continue;
            db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(row.id);
            deleteChannel(db, row.id);
            ctx.log.info({ evt: 'private.expired', channel: row.name },
                `Private room "${row.name}" stood empty past the window and was deleted`);
            ctx.actions.announceChannels?.();
        }
    };

    sweep();
    const timer = setInterval(sweep, SWEEP_EVERY_MS);
    timer.unref?.();
    ctx.onUnload(() => clearInterval(timer));
}
