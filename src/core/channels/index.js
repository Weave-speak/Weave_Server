// Channels.
//
// Channels are DATA. The previous client compiled them into a hardcoded array, so
// renaming a room or adding one meant shipping a new client to everybody — and the
// server decided "is this the AFK channel?" by string-matching an id prefix, which tied
// behaviour to a name someone might reasonably want to change.
//
// Here capabilities are explicit columns. A channel that does not allow voice is not
// special-cased anywhere; it simply has allow_voice = 0, and the enforcement is the
// same code path for every channel.

import crypto from 'node:crypto';

export class ChannelError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
    }
}

export const KINDS = Object.freeze(['voice', 'text', 'both', 'afk']);
const NAME_MAX = 40;

const COLUMNS = `
    id, name, kind, position,
    allow_voice AS allowVoice, allow_text AS allowText, allow_video AS allowVideo,
    is_default AS isDefault, created_at AS createdAt,
    private, created_by AS createdBy, last_occupied_at AS lastOccupiedAt
`;

const toChannel = (row) => (row ? {
    ...row,
    allowVoice: row.allowVoice === 1,
    allowText: row.allowText === 1,
    allowVideo: row.allowVideo === 1,
    isDefault: row.isDefault === 1,
    private: row.private === 1,
} : null);

function validateName(name) {
    const value = String(name ?? '').trim();
    if (!value) throw new ChannelError('A channel needs a name.', 'name');
    if (value.length > NAME_MAX) {
        throw new ChannelError(`Channel names must be ${NAME_MAX} characters or fewer.`, 'name');
    }
    return value;
}

/**
 * Seed a brand-new server with something usable.
 *
 * Deliberately generic. A public project must not ship one group's private in-jokes as
 * defaults, and an administrator renames these in seconds.
 */
export function ensureDefaults(db, log) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
    if (existing > 0) return [];

    const defaults = [
        { name: 'General', kind: 'both', position: 0, allowVoice: true, allowText: true, allowVideo: true, isDefault: true },
        // No voice and no text by design: somewhere to be present without being heard.
        // Video stays allowed so a running screen share is not killed by going away.
        { name: 'Away', kind: 'afk', position: 100, allowVoice: false, allowText: false, allowVideo: true, isDefault: false },
    ];

    const created = defaults.map((c) => createChannel(db, c));
    log?.info({ evt: 'channels.seeded', count: created.length },
        `Created default channels: ${created.map((c) => c.name).join(', ')}`);
    return created;
}

export function createChannel(db, {
    name, kind = 'both', position = null,
    allowVoice = true, allowText = true, allowVideo = true, isDefault = false,
    private: isPrivate = false, createdBy = null,
}) {
    const cleanName = validateName(name);
    if (!KINDS.includes(kind)) {
        throw new ChannelError(`Channel kind must be one of: ${KINDS.join(', ')}`, 'kind');
    }
    // No text in private rooms is a RULE, not a default: the occupants are the secret,
    // and a searchable transcript would out-live and out-leak any roster.
    const text = isPrivate ? false : allowText;

    const id = crypto.randomUUID();
    const pos = position ?? ((db.prepare('SELECT MAX(position) AS m FROM channels').get().m ?? -1) + 1);

    const insert = db.transaction(() => {
        // Exactly one default. Enforced here rather than trusted, because "where do new
        // users land" being ambiguous is a confusing failure.
        if (isDefault) db.prepare('UPDATE channels SET is_default = 0').run();

        db.prepare(`
            INSERT INTO channels (id, name, kind, position, allow_voice, allow_text, allow_video, is_default,
                                  private, created_by, last_occupied_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, cleanName, kind, pos,
            allowVoice ? 1 : 0, text ? 1 : 0, allowVideo ? 1 : 0, isDefault ? 1 : 0,
            isPrivate ? 1 : 0, createdBy, isPrivate ? Date.now() : null);

        // The maker is the first member; an empty members list would be a room nobody
        // could ever enter.
        if (isPrivate && createdBy) {
            db.prepare(`
                INSERT OR IGNORE INTO channel_members (channel_id, user_id, added_by, added_at)
                VALUES (?, ?, ?, ?)`).run(id, createdBy, createdBy, Date.now());
        }
    });
    insert();

    return getChannel(db, id);
}

export function getChannel(db, id) {
    return toChannel(db.prepare(`SELECT ${COLUMNS} FROM channels WHERE id = ?`).get(id));
}

export function listChannels(db) {
    return db.prepare(`SELECT ${COLUMNS} FROM channels ORDER BY position, name`).all().map(toChannel);
}

/** Whether this user may know what happens inside this channel. */
export function isMember(db, channelId, userId) {
    if (!userId) return false;
    return Boolean(db.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId));
}

export function addMember(db, channelId, userId, addedBy = null) {
    db.prepare(`
        INSERT OR IGNORE INTO channel_members (channel_id, user_id, added_by, added_at)
        VALUES (?, ?, ?, ?)`).run(channelId, userId, addedBy, Date.now());
}

export function listMembers(db, channelId) {
    return db.prepare(`
        SELECT u.id, u.username, u.display_name AS displayName
        FROM channel_members m JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = ? ORDER BY u.username`).all(channelId);
}

/**
 * The channels THIS user may see, with a membership flag on the private ones.
 *
 * A private room is listed for everyone — a locked door people can see beats a secret
 * corridor — but its name and lock are ALL a non-member gets: the occupant secrecy is
 * enforced where the roster is broadcast, and text is off in private rooms entirely.
 */
export function visibleChannels(db, userId) {
    return listChannels(db).map((c) => (c.private
        ? { ...c, member: isMember(db, c.id, userId) }
        : c));
}

export function touchOccupancy(db, channelId) {
    db.prepare('UPDATE channels SET last_occupied_at = ? WHERE id = ?').run(Date.now(), channelId);
}

/** The channel a client lands in when it does not ask for one. */
export function defaultChannel(db) {
    const explicit = db.prepare(`SELECT ${COLUMNS} FROM channels WHERE is_default = 1 LIMIT 1`).get();
    if (explicit) return toChannel(explicit);
    // A server whose default was deleted should still work.
    return toChannel(db.prepare(`SELECT ${COLUMNS} FROM channels ORDER BY position, name LIMIT 1`).get());
}

export function updateChannel(db, id, changes) {
    const current = getChannel(db, id);
    if (!current) throw new ChannelError('No such channel.');

    const next = {
        name: changes.name !== undefined ? validateName(changes.name) : current.name,
        kind: changes.kind !== undefined ? changes.kind : current.kind,
        position: changes.position !== undefined ? Number(changes.position) : current.position,
        allowVoice: changes.allowVoice !== undefined ? !!changes.allowVoice : current.allowVoice,
        allowText: changes.allowText !== undefined ? !!changes.allowText : current.allowText,
        allowVideo: changes.allowVideo !== undefined ? !!changes.allowVideo : current.allowVideo,
        isDefault: changes.isDefault !== undefined ? !!changes.isDefault : current.isDefault,
    };
    if (!KINDS.includes(next.kind)) {
        throw new ChannelError(`Channel kind must be one of: ${KINDS.join(', ')}`, 'kind');
    }

    const apply = db.transaction(() => {
        if (next.isDefault) db.prepare('UPDATE channels SET is_default = 0').run();
        db.prepare(`
            UPDATE channels
            SET name = ?, kind = ?, position = ?, allow_voice = ?, allow_text = ?, allow_video = ?, is_default = ?
            WHERE id = ?
        `).run(next.name, next.kind, next.position,
            next.allowVoice ? 1 : 0, next.allowText ? 1 : 0, next.allowVideo ? 1 : 0,
            next.isDefault ? 1 : 0, id);
    });
    apply();

    return getChannel(db, id);
}

export function deleteChannel(db, id) {
    const channel = getChannel(db, id);
    if (!channel) return false;

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
    if (remaining <= 1) {
        throw new ChannelError('A server needs at least one channel.');
    }

    db.prepare('DELETE FROM channels WHERE id = ?').run(id);

    // Never leave a server with no default; promote the first remaining channel.
    if (channel.isDefault) {
        const next = db.prepare('SELECT id FROM channels ORDER BY position, name LIMIT 1').get();
        if (next) db.prepare('UPDATE channels SET is_default = 1 WHERE id = ?').run(next.id);
    }
    return true;
}
