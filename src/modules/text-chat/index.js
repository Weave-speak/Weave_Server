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

    // The marker is the acked message's ROWID — insertion order, the order frames were
    // delivered in. MAX() keeps it forward-only: a stale tab acking old history cannot
    // resurrect a badge. created_at/id are still stored for the "jump to last read" UI.
    const upsertRead = db.prepare(`
        INSERT INTO chat_reads (user_id, channel_id, last_created_at, last_id, last_seq)
        VALUES (@userId, @channelId, @createdAt, @id, @seq)
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
            last_created_at = MAX(chat_reads.last_created_at, excluded.last_created_at),
            last_id = CASE WHEN excluded.last_seq > chat_reads.last_seq THEN excluded.last_id ELSE chat_reads.last_id END,
            last_seq = MAX(chat_reads.last_seq, excluded.last_seq)
    `);
    const seqOf = db.prepare('SELECT rowid AS seq, channel_id AS channelId FROM chat_messages WHERE id = ?');

    // Unread and unseen-mention counts for every text-capable channel, one round trip.
    // COUNT is capped in SQL so a year of history in a never-opened channel costs a
    // 100-row scan, not a full one.
    const unreadFor = db.prepare(`
        SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM chat_messages m
            WHERE m.channel_id = @channelId AND m.rowid > @afterSeq
            LIMIT 100
        )
    `);
    const mentionsFor = db.prepare(`
        SELECT COUNT(*) AS n FROM chat_mentions x
        JOIN chat_messages m ON m.id = x.message_id
        WHERE x.user_id = @userId AND x.channel_id = @channelId
          AND m.rowid > @afterSeq
    `);
    const readsOf = db.prepare('SELECT channel_id AS channelId, last_created_at AS lastCreatedAt, last_id AS lastId, last_seq AS lastSeq FROM chat_reads WHERE user_id = ?');

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
        // The id names the message; ITS insertion order is the marker. An id the server
        // has never seen marks nothing, exactly like before.
        const seen = seqOf.get(id);
        if (!seen || seen.channelId !== channel.id) return;
        upsertRead.run({ userId: peer.userId, channelId: channel.id, createdAt, id, seq: seen.seq });
    });

    // ── typing ───────────────────────────────────────────────────────────────
    // The shape every messenger converged on: throttled fire-and-forget pings, relayed
    // and forgotten. Nothing is stored, nothing is acknowledged, and the RECEIVER owns
    // expiry — Discord's window is ~10s, Telegram's 5; ours relays at most every 4s and
    // clients let it lapse at 8. A lost ping costs one flicker, never a stuck banner.
    const lastTyping = new Map();   // cid -> last relayed at
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => lastTyping.delete(peer?.cid));

    ctx.ws.on('typing', ({ ws, msg, broadcast }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const channel = getChannel(db, msg.channelId);
        if (!channel?.allowText || channel.private) return;
        const now = Date.now();
        if (now - (lastTyping.get(ws.cid) ?? 0) < 4_000) return;
        lastTyping.set(ws.cid, now);
        broadcast('typing', { channelId: channel.id, username: peer.username },
            (sock) => sock.cid !== ws.cid);
    });

    ctx.http.route('GET', '/api/chat/reads', ({ session, json }) => {
        const markers = new Map(readsOf.all(session.userId).map((r) => [r.channelId, r]));
        const channels = listChannels(db)
            .filter((c) => c.allowText)
            .map((c) => {
                const mark = markers.get(c.id) ?? null;
                const afterSeq = mark?.lastSeq ?? 0;
                const unread = unreadFor.get({ channelId: c.id, afterSeq }).n;
                const mentions = mentionsFor.get({ userId: session.userId, channelId: c.id, afterSeq }).n;
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

    // An admin empties a channel: history, mentions and read markers all go, because a
    // read marker pointing into deleted history is a badge that can never clear. The
    // broadcast tells every open client to drop what it is showing.
    ctx.http.route('DELETE', '/api/chat/:channelId/messages', ({ params, session, json }) => {
        const channel = getChannel(db, params.channelId);
        if (!channel) return json(404, { error: 'No such channel.' });

        let removed = 0;
        const clearAll = db.transaction(() => {
            db.prepare('DELETE FROM chat_mentions WHERE channel_id = ?').run(channel.id);
            db.prepare('DELETE FROM chat_reads WHERE channel_id = ?').run(channel.id);
            removed = db.prepare('DELETE FROM chat_messages WHERE channel_id = ?').run(channel.id).changes;
        });
        clearAll();

        ctx.ws.broadcast('cleared', { channelId: channel.id });
        ctx.log.warn({ evt: 'chat.cleared', channel: channel.name, count: removed, by: session.username },
            `${session.username} cleared ${removed} message(s) from #${channel.name}`);
        json(200, { ok: true, removed });
    }, { auth: 'admin' });

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
