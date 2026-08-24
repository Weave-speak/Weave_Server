// Text chat.
//
// Deliberately narrow: messages, history, retention. Reactions, replies, threads and
// search are separate concerns and will be separate modules, so a server that wants
// plain chat is not carrying machinery it never uses.
//
// Whether a channel accepts text is a property of the channel, checked here the same way
// for every channel. There is no special-cased "the AFK room" — that was how the
// previous server did it, which tied behaviour to a name someone might rename.

import crypto from 'node:crypto';
import { getChannel, listChannels } from '../../core/channels/index.js';
import { HOOKS } from '../../core/hooks/index.js';

const MAX_BODY = 4000;
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

export function register(ctx) {
    ctx.db.migrate();

    ctx.settings.define('retentionDays', {
        type: 'number', integer: true, min: 0, max: 3650,
        label: 'Keep messages for (days)',
        help: 'Older messages are deleted automatically. 0 keeps them forever.',
    }, 30);

    ctx.settings.define('maxLength', {
        type: 'number', integer: true, min: 100, max: MAX_BODY,
        label: 'Maximum message length',
        help: 'Characters. Longer messages are rejected rather than silently truncated.',
    }, 2000);

    const db = ctx.db.handle;

    const insert = db.prepare(`
        INSERT INTO chat_messages (id, channel_id, user_id, author_name, avatar, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMention = db.prepare(`
        INSERT OR IGNORE INTO chat_mentions (message_id, channel_id, user_id, created_at)
        VALUES (?, ?, ?, ?)
    `);

    const userByName = db.prepare(
        'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE');

    /** Every existing account the body names as @username. Unknown names are just text. */
    const resolveMentions = (body) => {
        const seen = new Map();
        for (const match of body.matchAll(/(^|\s)@([A-Za-z0-9._-]{1,32})/g)) {
            const user = userByName.get(match[2]);
            if (user) seen.set(user.id, user);
        }
        return [...seen.values()];
    };

    const upsertRead = db.prepare(`
        INSERT INTO chat_reads (user_id, channel_id, last_created_at, last_id)
        VALUES (@userId, @channelId, @createdAt, @id)
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
            last_created_at = excluded.last_created_at,
            last_id = excluded.last_id
        WHERE excluded.last_created_at > chat_reads.last_created_at
           OR (excluded.last_created_at = chat_reads.last_created_at
               AND excluded.last_id > chat_reads.last_id)
    `);

    // Unread and unseen-mention counts for every text-capable channel, one round trip.
    // COUNT is capped in SQL so a year of history in a never-opened channel costs a
    // 100-row scan, not a full one.
    const unreadFor = db.prepare(`
        SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM chat_messages m
            WHERE m.channel_id = @channelId
              AND (m.created_at > @afterAt OR (m.created_at = @afterAt AND m.id > @afterId))
            LIMIT 100
        )
    `);
    const mentionsFor = db.prepare(`
        SELECT COUNT(*) AS n FROM chat_mentions
        WHERE user_id = @userId AND channel_id = @channelId
          AND created_at > @afterAt
    `);
    const readsOf = db.prepare('SELECT channel_id AS channelId, last_created_at AS lastCreatedAt, last_id AS lastId FROM chat_reads WHERE user_id = ?');

    // The cursor is (created_at, id), not created_at alone.
    //
    // Timestamps are millisecond resolution, so several messages routinely share one.
    // With a bare `created_at < ?` cursor those ties are ordered arbitrarily, and paging
    // backwards then silently skips some messages and shows others twice. The id breaks
    // the tie deterministically, which is the difference between history that is merely
    // usually right and history that is always right.
    const page = db.prepare(`
        SELECT id, channel_id AS channelId, user_id AS userId, author_name AS authorName,
               avatar, body, created_at AS createdAt, edited_at AS editedAt
        FROM chat_messages
        WHERE channel_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `);

    // ── sending ──────────────────────────────────────────────────────────────
    ctx.ws.on('send', ({ ws, msg, send, fail, broadcast }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return fail(ws, 'not_joined', 'Sign in first.');

        // The target is named in the message, not inferred from where the sender stands.
        // Reading and writing are decoupled from voice presence — you sit in one voice
        // room and talk in any text channel, the way every chat app since IRC has worked.
        // Omitting channelId falls back to the sender's own room, which keeps old
        // clients working unchanged.
        const channel = getChannel(db, msg.channelId ?? peer.channelId);
        if (!channel) return fail(ws, 'no_channel', 'No such channel.');
        if (!channel.allowText) {
            return fail(ws, 'text_not_allowed', `Text chat is not enabled in ${channel.name}.`);
        }

        const limit = ctx.settings.get('maxLength');
        const body = String(msg.body ?? '').trim();
        if (!body) return fail(ws, 'empty', 'Nothing to send.');
        if (body.length > limit) {
            // Refusing beats truncating: silently cutting someone off mid-sentence and
            // sending it anyway is worse than telling them.
            return fail(ws, 'too_long', `Messages are limited to ${limit} characters.`);
        }

        const record = {
            id: crypto.randomUUID(),
            channelId: channel.id,
            userId: peer.userId,
            authorName: peer.displayName ?? peer.username,
            avatar: peer.avatar ?? null,
            body,
            createdAt: Date.now(),
        };

        // Who this message names, resolved NOW against the people who exist now. The
        // mention rows are what unread bells are computed from, and resolving at insert
        // means a renamed account never retroactively changes who was addressed.
        const mentioned = resolveMentions(body);

        const writeAll = db.transaction(() => {
            insert.run(record.id, record.channelId, record.userId,
                record.authorName, record.avatar, record.body, record.createdAt);
            for (const user of mentioned) {
                insertMention.run(record.id, record.channelId, user.id, record.createdAt);
            }
        });
        writeAll();
        record.mentions = mentioned.map((u) => u.username);

        send('accepted', { id: record.id, createdAt: record.createdAt });
        // Everyone signed in hears about it, wherever they stand: the badge on a channel
        // you are not looking at is made of exactly these frames. Private channels carry
        // no text at all, so there is nothing here to scope.
        broadcast('message', { message: record });

        ctx.hooks.emit(HOOKS.MESSAGE_SEND, { peer, channel, message: record });
    });

    // ── history ──────────────────────────────────────────────────────────────
    // ── read markers ─────────────────────────────────────────────────────────
    // "What have I not seen" is server state, so a badge cleared here is cleared on
    // every device the account signs into.

    ctx.ws.on('read', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const channel = getChannel(db, msg.channelId);
        if (!channel) return;
        const createdAt = Number(msg.createdAt);
        const id = String(msg.id ?? '');
        if (!Number.isFinite(createdAt) || !id) return;
        // Forward-only by the WHERE clause: a stale tab acking an old message cannot
        // resurrect a badge someone already cleared.
        upsertRead.run({ userId: peer.userId, channelId: channel.id, createdAt, id });
    });

    ctx.http.route('GET', '/api/chat/reads', ({ session, json }) => {
        const markers = new Map(readsOf.all(session.userId).map((r) => [r.channelId, r]));
        const channels = listChannels(db)
            .filter((c) => c.allowText)
            .map((c) => {
                const mark = markers.get(c.id) ?? null;
                const afterAt = mark?.lastCreatedAt ?? 0;
                const afterId = mark?.lastId ?? '';
                const unread = unreadFor.get({ channelId: c.id, afterAt, afterId }).n;
                const mentions = mentionsFor.get({ userId: session.userId, channelId: c.id, afterAt }).n;
                return {
                    channelId: c.id,
                    unread,
                    unreadCapped: unread >= 100,
                    mentions,
                    lastReadAt: mark?.lastCreatedAt ?? null,
                };
            });
        json(200, { channels });
    });

    ctx.http.route('GET', '/api/chat/:channelId/messages', ({ params, query, json }) => {
        const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.limit) || PAGE_DEFAULT));
        // A cursor rather than an OFFSET: an offset page shifts under you as new messages
        // arrive, so scrolling back would repeat some and skip others.
        const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
        // High sentinel so the first page, which has no id cursor yet, includes every
        // message sharing the newest timestamp.
        const beforeId = query.beforeId ?? '￿';

        const rows = page.all(params.channelId, before, before, beforeId, limit);
        const oldest = rows.at(-1);

        json(200, {
            messages: rows.reverse(),
            // Only meaningful when a full page came back; otherwise there is no more.
            nextBefore: rows.length === limit ? oldest.createdAt : null,
            nextBeforeId: rows.length === limit ? oldest.id : null,
        });
    });

    // ── retention ────────────────────────────────────────────────────────────
    const sweep = () => {
        const days = ctx.settings.get('retentionDays');
        if (!days) return;
        const cutoff = Date.now() - days * 86_400_000;
        const { changes } = db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(cutoff);
        if (changes) {
            ctx.log.info({ evt: 'chat.pruned', count: changes, days },
                `Removed ${changes} message(s) older than ${days} days`);
        }
    };

    sweep();
    const timer = setInterval(sweep, 6 * 3600_000);
    // Never let a housekeeping timer be the reason the process will not exit.
    timer.unref();
    ctx.onUnload(() => clearInterval(timer));

    ctx.admin.panel({ id: 'chat', label: 'Text chat', order: 20 });
}
