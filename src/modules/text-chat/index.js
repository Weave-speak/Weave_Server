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
import { getChannel } from '../../core/channels/index.js';
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
        if (!peer) return fail(ws, 'not_joined', 'Join a channel first.');

        const channel = getChannel(db, peer.channelId);
        if (!channel) return fail(ws, 'no_channel', 'You are not in a channel.');
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

        insert.run(record.id, record.channelId, record.userId,
            record.authorName, record.avatar, record.body, record.createdAt);

        send('accepted', { id: record.id, createdAt: record.createdAt });
        broadcast('message', { message: record }, (sock) => {
            const other = ctx.peers.get(sock.cid);
            return other && other.channelId === channel.id;
        });

        ctx.hooks.emit(HOOKS.MESSAGE_SEND, { peer, channel, message: record });
    });

    // ── history ──────────────────────────────────────────────────────────────
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
