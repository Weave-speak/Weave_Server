// Moderation: the record of who an administrator has silenced or ejected.
//
// The only thing in the server that touches the `moderation` table. Everything else asks
// these functions, because "is this person still muted?" has exactly one correct answer
// and three places that need it — the join handler, the produce handler, and the sweep
// that lifts an expiry. Spreading that predicate across them is how they drift.
//
// A restriction is IN FORCE when nothing has lifted it and it has not run out. Both halves
// matter: an administrator lifting a timed mute early must take effect immediately, and a
// mute nobody lifts must stop on its own rather than outliving the reason for it.

import crypto from 'node:crypto';

/** How long a kicked account is refused a reconnect. */
export const KICK_COOLDOWN_MS = 60_000;

export const ACTIONS = Object.freeze({ MUTE: 'mute', KICK: 'kick' });

const ACTIVE = `
    lifted_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)
`;

const shape = (row) => (row ? {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    reason: row.reason,
    byUserId: row.by_user_id,
    at: row.at,
    expiresAt: row.expires_at,
} : null);

/** The restriction of this kind currently in force for an account, or null. */
function active(db, userId, action, now = Date.now()) {
    return shape(db.prepare(`
        SELECT * FROM moderation
        WHERE user_id = ? AND action = ? AND ${ACTIVE}
        -- The one that ends LAST wins, so stacking a longer mute over a shorter one
        -- extends it rather than being masked by the one that happens to be found first.
        ORDER BY expires_at IS NULL DESC, expires_at DESC
        LIMIT 1
    `).get(userId, action, now));
}

export const activeMute = (db, userId, now = Date.now()) => active(db, userId, ACTIONS.MUTE, now);
export const activeKick = (db, userId, now = Date.now()) => active(db, userId, ACTIONS.KICK, now);

/**
 * Silence an account.
 *
 * `minutes: null` means until an administrator lifts it — the form the word "irreversible"
 * describes. Any existing mute is lifted first so the newest decision is the only one in
 * force; without that, shortening a mute would silently do nothing.
 */
export function mute(db, { userId, byUserId = null, minutes = null, reason = null, now = Date.now() }) {
    const expiresAt = minutes == null ? null : now + Math.round(minutes * 60_000);
    const record = db.transaction(() => {
        db.prepare(`UPDATE moderation SET lifted_at = ?, lifted_by = ?
                    WHERE user_id = ? AND action = ? AND ${ACTIVE}`)
            .run(now, byUserId, userId, ACTIONS.MUTE, now);
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO moderation (id, user_id, action, reason, by_user_id, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, userId, ACTIONS.MUTE, reason, byUserId, expiresAt);
        return db.prepare('SELECT * FROM moderation WHERE id = ?').get(id);
    })();
    return shape(record);
}

/** Lift every mute in force for an account. Returns how many were actually lifted. */
export function unmute(db, { userId, byUserId = null, now = Date.now() }) {
    return db.prepare(`UPDATE moderation SET lifted_at = ?, lifted_by = ?
                       WHERE user_id = ? AND action = ? AND ${ACTIVE}`)
        .run(now, byUserId, userId, ACTIONS.MUTE, now).changes;
}

/** Record a kick, which is also what makes the cooldown enforceable at the next join. */
export function recordKick(db, {
    userId, byUserId = null, reason = null, cooldownMs = KICK_COOLDOWN_MS, now = Date.now(),
}) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO moderation (id, user_id, action, reason, by_user_id, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, userId, ACTIONS.KICK, reason, byUserId, now + cooldownMs);
    return shape(db.prepare('SELECT * FROM moderation WHERE id = ?').get(id));
}

/**
 * Mutes that have run out but are not marked lifted yet.
 *
 * Expiry is evaluated in the query rather than stored as a flag, so this is only about
 * the SIDE EFFECT — un-pausing a producer for someone still connected. A peer who was
 * offline when their mute ran out needs nothing done to them.
 */
export function expiredMutes(db, now = Date.now()) {
    return db.prepare(`
        SELECT DISTINCT user_id AS userId FROM moderation
        WHERE action = ? AND lifted_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(ACTIONS.MUTE, now).map((r) => r.userId);
}

/** Mark expired mutes as settled, so the sweep does not keep finding the same rows. */
export function settleExpired(db, now = Date.now()) {
    return db.prepare(`UPDATE moderation SET lifted_at = expires_at
                       WHERE action = ? AND lifted_at IS NULL
                         AND expires_at IS NOT NULL AND expires_at <= ?`)
        .run(ACTIONS.MUTE, now).changes;
}
