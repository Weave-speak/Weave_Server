// Invite codes.
//
// Registration is invite-only and has no open mode, so this is the sole path to an
// account. That makes two properties matter more than they otherwise would:
//
//   - Redemption must be ATOMIC. Two people racing the same single-use code must not
//     both get an account. The claim and the user creation happen in one transaction,
//     and the claim is a conditional UPDATE rather than a read-then-write.
//   - Codes must be unguessable and unambiguous. They get read aloud, typed from a
//     photo, and pasted from chat.

import crypto from 'node:crypto';

export class InviteError extends Error {}

// Crockford-style: no I, L, O or U. Removes 1/l/I and 0/O confusion, and cannot
// accidentally spell anything.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUPS = 4;
const GROUP_LEN = 4;

/** ~78 bits of entropy, formatted XXXX-XXXX-XXXX-XXXX. */
export function generateCode() {
    const bytes = crypto.randomBytes(GROUPS * GROUP_LEN);
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
    return Array.from({ length: GROUPS }, (_, i) =>
        chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN).join('')).join('-');
}

/** Accept what people actually paste: any case, spaces or hyphens, or neither. */
export function normaliseCode(raw) {
    const stripped = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (stripped.length !== GROUPS * GROUP_LEN) return null;
    return Array.from({ length: GROUPS }, (_, i) =>
        stripped.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN)).join('-');
}

export function createInvite(db, { createdBy, maxUses = 1, expiresInHours = 24 * 7, note = null }) {
    if (maxUses < 1 || maxUses > 100) {
        throw new InviteError('An invite can be used between 1 and 100 times.');
    }

    // Retry on the astronomically unlikely collision rather than failing the request.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateCode();
        try {
            db.prepare(`
                INSERT INTO invites (code, created_by, expires_at, max_uses, note)
                VALUES (?, ?, ?, ?, ?)
            `).run(
                code,
                createdBy,
                expiresInHours ? Date.now() + expiresInHours * 3600_000 : null,
                maxUses,
                note,
            );
            return getInvite(db, code);
        } catch (err) {
            if (!String(err.message).includes('UNIQUE')) throw err;
        }
    }
    throw new InviteError('Could not generate a unique invite code. Try again.');
}

export function getInvite(db, code) {
    const normalised = normaliseCode(code);
    if (!normalised) return null;
    return db.prepare(`
        SELECT code, created_by AS createdBy, created_at AS createdAt,
               expires_at AS expiresAt, max_uses AS maxUses, uses, note
        FROM invites WHERE code = ?
    `).get(normalised) ?? null;
}

/** Why a code cannot be used, or null if it can. Phrased for the person redeeming it. */
export function checkInvite(db, code) {
    const invite = getInvite(db, code);
    if (!invite) return { ok: false, reason: 'That invite code is not valid.' };
    if (invite.expiresAt && invite.expiresAt < Date.now()) {
        return { ok: false, reason: 'That invite code has expired. Ask for a new one.' };
    }
    if (invite.uses >= invite.maxUses) {
        return { ok: false, reason: 'That invite code has already been used.' };
    }
    return { ok: true, invite };
}

/**
 * Claim a code and create the account as ONE transaction.
 *
 * The claim is `UPDATE ... WHERE uses < max_uses`, so SQLite itself resolves the race:
 * the loser's UPDATE matches zero rows and the whole transaction rolls back, taking the
 * half-created user with it. A read-then-write would let two racing registrations both
 * see a free slot.
 */
export function redeemInvite(db, code, createUserFn) {
    const normalised = normaliseCode(code);
    if (!normalised) throw new InviteError('That invite code is not valid.');

    const claim = db.transaction(() => {
        const result = db.prepare(`
            UPDATE invites SET uses = uses + 1
            WHERE code = ?
              AND uses < max_uses
              AND (expires_at IS NULL OR expires_at > ?)
        `).run(normalised, Date.now());

        if (result.changes === 0) {
            const invite = getInvite(db, normalised);
            if (!invite) throw new InviteError('That invite code is not valid.');
            if (invite.expiresAt && invite.expiresAt < Date.now()) {
                throw new InviteError('That invite code has expired. Ask for a new one.');
            }
            throw new InviteError('That invite code has already been used.');
        }

        const user = createUserFn();
        db.prepare('INSERT INTO invite_redemptions (code, user_id) VALUES (?, ?)')
            .run(normalised, user.id);
        return user;
    });

    return claim();
}

export function listInvites(db) {
    return db.prepare(`
        SELECT i.code, i.created_at AS createdAt, i.expires_at AS expiresAt,
               i.max_uses AS maxUses, i.uses, i.note,
               u.username AS createdByName
        FROM invites i
        LEFT JOIN users u ON u.id = i.created_by
        ORDER BY i.created_at DESC
        LIMIT 200
    `).all();
}

export function revokeInvite(db, code) {
    const normalised = normaliseCode(code);
    if (!normalised) return false;
    return db.prepare('DELETE FROM invites WHERE code = ?').run(normalised).changes > 0;
}
