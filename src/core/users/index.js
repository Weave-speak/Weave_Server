// Users, passwords and account recovery.
//
// Identity is a USERNAME, not a real name. The previous server logged people in with
// their legal name, which meant the one field you most want to keep private was also
// the one typed into a login box on a shared screen.
//
// Recovery is a passphrase, hashed exactly like the password. The previous schema
// stored it in clear text and compared it with `!==`, which is both a disclosure risk
// if the database is ever copied and a timing oracle that leaks the phrase character by
// character.

import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

export class UserError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
    }
}

export const LIMITS = Object.freeze({
    USERNAME_MIN: 3,
    USERNAME_MAX: 32,
    DISPLAY_MIN: 1,
    DISPLAY_MAX: 32,
    PASSWORD_MIN: 10,
    PASSWORD_MAX: 200,
    RECOVERY_MIN: 12,
    RECOVERY_MAX: 200,
});

// Letters, digits, underscore, hyphen and dot. No spaces, no leading/trailing
// punctuation: a username gets read aloud and typed back, so it must be unambiguous.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/i;

/**
 * A precomputed hash to verify against when no such account exists.
 *
 * Without this, "no such user" returns in microseconds while a real user costs a full
 * argon2 verification, and the difference is a reliable oracle for enumerating who has
 * an account. Comparing against this makes both paths cost the same.
 */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$'
    + 'AAAAAAAAAAAAAAAAAAAAAA$Ahv4ZBxYBBUZ8CUKNbGnLHEuXlWJvAJoP1MvRHDlQ0A';

export const normalise = (username) => String(username ?? '').trim().toLowerCase();

export function validateUsername(username) {
    const value = String(username ?? '').trim();
    if (value.length < LIMITS.USERNAME_MIN || value.length > LIMITS.USERNAME_MAX) {
        throw new UserError(
            `Username must be between ${LIMITS.USERNAME_MIN} and ${LIMITS.USERNAME_MAX} characters.`,
            'username',
        );
    }
    if (!USERNAME_RE.test(value)) {
        throw new UserError(
            'Username can use letters, digits, dots, hyphens and underscores, and must start and end with a letter or digit.',
            'username',
        );
    }
    return value;
}

export function validatePassword(password) {
    const value = String(password ?? '');
    if (value.length < LIMITS.PASSWORD_MIN) {
        throw new UserError(`Password must be at least ${LIMITS.PASSWORD_MIN} characters.`, 'password');
    }
    if (value.length > LIMITS.PASSWORD_MAX) {
        throw new UserError(`Password must be ${LIMITS.PASSWORD_MAX} characters or fewer.`, 'password');
    }
    return value;
}

export function validateRecovery(phrase) {
    const value = String(phrase ?? '').trim();
    if (value.length < LIMITS.RECOVERY_MIN) {
        throw new UserError(
            `Recovery phrase must be at least ${LIMITS.RECOVERY_MIN} characters. A few unrelated words works well.`,
            'recoveryPhrase',
        );
    }
    if (value.length > LIMITS.RECOVERY_MAX) {
        throw new UserError(`Recovery phrase must be ${LIMITS.RECOVERY_MAX} characters or fewer.`, 'recoveryPhrase');
    }
    return value;
}

export function validateDisplayName(name) {
    const value = String(name ?? '').trim();
    if (value.length < LIMITS.DISPLAY_MIN || value.length > LIMITS.DISPLAY_MAX) {
        throw new UserError(
            `Display name must be between ${LIMITS.DISPLAY_MIN} and ${LIMITS.DISPLAY_MAX} characters.`,
            'displayName',
        );
    }
    return value;
}

// last_seen_at is included because the admin console shows it; without it the column
// rendered as an em-dash for everyone, which looks like "nobody has ever signed in"
// rather than "this field was never selected".
const PUBLIC_COLUMNS = `
    id, username, display_name AS displayName, avatar,
    is_admin AS isAdmin, created_at AS createdAt, last_seen_at AS lastSeenAt
`;

const toUser = (row) => (row ? { ...row, isAdmin: row.isAdmin === 1 } : null);

export async function createUser(db, {
    username, displayName, password, recoveryPhrase, isAdmin = false, avatar = null,
}) {
    const name = validateUsername(username);
    const display = validateDisplayName(displayName || name);
    validatePassword(password);

    const lower = normalise(name);
    const existing = db.prepare('SELECT 1 FROM users WHERE username_lower = ?').get(lower);
    if (existing) {
        throw new UserError('That username is already taken.', 'username');
    }

    const passwordHash = await argonHash(password);
    const recoveryHash = recoveryPhrase ? await argonHash(validateRecovery(recoveryPhrase)) : null;
    const id = crypto.randomUUID();

    db.prepare(`
        INSERT INTO users (id, username, username_lower, display_name, password_hash, recovery_hash, avatar, is_admin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, lower, display, passwordHash, recoveryHash, avatar, isAdmin ? 1 : 0);

    return getUserById(db, id);
}

export function getUserById(db, id) {
    return toUser(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id));
}

export function getUserByUsername(db, username) {
    return toUser(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE username_lower = ?`)
        .get(normalise(username)));
}

/** Verify a password. Returns the user, or null — never says which half was wrong. */
export async function verifyPassword(db, username, password) {
    const row = db.prepare('SELECT id, password_hash, is_disabled FROM users WHERE username_lower = ?')
        .get(normalise(username));

    // Always run a verification, even with no such user, so the two paths cost the same.
    const ok = await argonVerify(row?.password_hash ?? DUMMY_HASH, String(password ?? ''))
        .catch(() => false);

    if (!row || !ok || row.is_disabled) return null;
    return getUserById(db, row.id);
}

export async function verifyRecovery(db, username, phrase) {
    const row = db.prepare('SELECT id, recovery_hash, is_disabled FROM users WHERE username_lower = ?')
        .get(normalise(username));

    const ok = await argonVerify(row?.recovery_hash ?? DUMMY_HASH, String(phrase ?? '').trim())
        .catch(() => false);

    if (!row || !row.recovery_hash || !ok || row.is_disabled) return null;
    return getUserById(db, row.id);
}

export async function setPassword(db, userId, password) {
    const hashed = await argonHash(validatePassword(password));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashed, userId);
}

export async function setRecovery(db, userId, phrase) {
    const hashed = await argonHash(validateRecovery(phrase));
    db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hashed, userId);
}

export function countAdmins(db) {
    return db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_disabled = 0').get().n;
}

export function listUsers(db) {
    return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username_lower`).all().map(toUser);
}

export function touchLastSeen(db, userId) {
    db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
}
