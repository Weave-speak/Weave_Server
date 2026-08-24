// Direct messages.
//
// The left rail of the client: private one-to-one threads that exist once either person
// opens one and then follow the account. Storage is the Telegram model, decided early —
// server-side like everything else, not end-to-end — so the honest promise is "only the
// two of you can READ this", enforced here on every route and every frame, never in the
// client.
//
// Deliberately reuses the shapes the channels proved: the same (created_at, id) compound
// cursor for history, the same forward-only read markers for badges. A client that can
// page one can page the other.

import crypto from 'node:crypto';
import { createChannel, deleteChannel, addMember } from '../../core/channels/index.js';
import { HOOKS } from '../../core/hooks/index.js';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

export function register(ctx) {
    ctx.db.migrate();

    ctx.settings.define('maxLength', {
        type: 'number', integer: true, min: 100, max: 4000,
        label: 'Maximum message length',
        help: 'Characters. Longer messages are rejected rather than silently truncated.',
    }, 2000);

    const db = ctx.db.handle;

    /* ── statements ─────────────────────────────────────────────────────────── */

    const findThread = db.prepare('SELECT * FROM dm_threads WHERE user_a = ? AND user_b = ?');
    const threadById = db.prepare('SELECT * FROM dm_threads WHERE id = ?');
    const insertThread = db.prepare(`
        INSERT INTO dm_threads (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)`);
    const threadsOf = db.prepare(`
        SELECT * FROM dm_threads WHERE user_a = ? OR user_b = ?
        ORDER BY COALESCE(last_message_at, created_at) DESC`);
    const touchThread = db.prepare('UPDATE dm_threads SET last_message_at = ? WHERE id = ?');

    const userById = db.prepare(
        'SELECT id, username, display_name AS displayName, avatar, is_disabled AS isDisabled FROM users WHERE id = ?');

    const insertMessage = db.prepare(`
        INSERT INTO dm_messages (id, thread_id, author_id, author_name, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const page = db.prepare(`
        SELECT id, thread_id AS threadId, author_id AS authorId, author_name AS authorName,
               body, created_at AS createdAt
        FROM dm_messages
        WHERE thread_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`);
    const lastMessage = db.prepare(`
        SELECT body, author_id AS authorId, created_at AS createdAt FROM dm_messages
        WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`);

    const upsertRead = db.prepare(`
        INSERT INTO dm_reads (user_id, thread_id, last_created_at, last_id)
        VALUES (@userId, @threadId, @createdAt, @id)
        ON CONFLICT (user_id, thread_id) DO UPDATE SET
            last_created_at = excluded.last_created_at,
            last_id = excluded.last_id
        WHERE excluded.last_created_at > dm_reads.last_created_at
           OR (excluded.last_created_at = dm_reads.last_created_at
               AND excluded.last_id > dm_reads.last_id)`);
    const readOf = db.prepare('SELECT last_created_at AS lastCreatedAt, last_id AS lastId FROM dm_reads WHERE user_id = ? AND thread_id = ?');
    const unreadIn = db.prepare(`
        SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM dm_messages m
            WHERE m.thread_id = @threadId
              AND m.author_id != @userId
              AND (m.created_at > @afterAt OR (m.created_at = @afterAt AND m.id > @afterId))
            LIMIT 100
        )`);

    /* ── helpers ────────────────────────────────────────────────────────────── */

    /** The canonical pair: order-independent, so one pair can only ever be one thread. */
    const pairOf = (u1, u2) => (u1 < u2 ? [u1, u2] : [u2, u1]);

    const isParty = (thread, userId) => thread.user_a === userId || thread.user_b === userId;
    const otherOf = (thread, userId) => (thread.user_a === userId ? thread.user_b : thread.user_a);

    /** Whether the other person is signed in anywhere, for the rail's presence dot. */
    const presenceOf = (userId) => (ctx.peers.forUser(userId).length ? 'online' : 'offline');

    const threadView = (thread, userId) => {
        const other = userById.get(otherOf(thread, userId));
        const mark = readOf.get(userId, thread.id);
        const last = lastMessage.get(thread.id);
        return {
            id: thread.id,
            other: other ? {
                id: other.id,
                username: other.username,
                displayName: other.displayName,
                avatar: other.avatar,
                presence: presenceOf(other.id),
            } : null,
            lastMessageAt: thread.last_message_at ?? null,
            // A one-line preview for the rail tooltip; the thread itself is paged.
            preview: last ? { body: last.body.slice(0, 120), mine: last.authorId === userId } : null,
            unread: unreadIn.get({
                threadId: thread.id,
                userId,
                afterAt: mark?.lastCreatedAt ?? 0,
                afterId: mark?.lastId ?? '',
            }).n,
        };
    };

    /* ── the rail ───────────────────────────────────────────────────────────── */

    ctx.http.route('GET', '/api/dm/threads', ({ session, json }) => {
        const threads = threadsOf.all(session.userId, session.userId)
            .map((t) => threadView(t, session.userId))
            // A partner whose account was deleted leaves a thread with nobody on the
            // other end; hiding it beats rendering a ghost.
            .filter((t) => t.other);
        json(200, { threads });
    });

    ctx.http.route('POST', '/api/dm/threads', ({ session, body, json }) => {
        const target = userById.get(String(body?.userId ?? ''));
        if (!target || target.isDisabled) {
            return json(404, { error: 'no_user', message: 'No such person.' });
        }
        if (target.id === session.userId) {
            return json(400, { error: 'self', message: 'That would just be a diary.' });
        }

        const [a, b] = pairOf(session.userId, target.id);
        let thread = findThread.get(a, b);
        let created = false;
        if (!thread) {
            insertThread.run(crypto.randomUUID(), a, b, Date.now());
            thread = findThread.get(a, b);
            created = true;
        }
        json(created ? 201 : 200, { thread: threadView(thread, session.userId) });
    }, { maxBytes: 1_000 });

    /* ── history ────────────────────────────────────────────────────────────── */

    ctx.http.route('GET', '/api/dm/threads/:id/messages', ({ session, params, query, json }) => {
        const thread = threadById.get(params.id);
        if (!thread || !isParty(thread, session.userId)) {
            // The same answer for "no such thread" and "not yours": a 404 that differs
            // by case would confirm which thread ids exist.
            return json(404, { error: 'no_thread', message: 'No such thread.' });
        }
        const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.limit) || PAGE_DEFAULT));
        const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
        const beforeId = query.beforeId ?? '￿';

        const rows = page.all(thread.id, before, before, beforeId, limit);
        const oldest = rows.at(-1);
        json(200, {
            messages: rows.reverse(),
            nextBefore: rows.length === limit ? oldest.createdAt : null,
            nextBeforeId: rows.length === limit ? oldest.id : null,
        });
    });

    /* ── live ───────────────────────────────────────────────────────────────── */

    /** Deliver a frame to every connection both participants hold. */
    const toParties = (thread, type, payload) => {
        for (const userId of [thread.user_a, thread.user_b]) {
            for (const peer of ctx.peers.forUser(userId)) {
                ctx.ws.send(peer.ws, type, payload);
            }
        }
    };

    ctx.ws.on('send', ({ ws, msg, send, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return fail(ws, 'not_joined', 'Sign in first.');

        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) {
            return fail(ws, 'no_thread', 'No such thread.');
        }

        const limit = ctx.settings.get('maxLength');
        const body = String(msg.body ?? '').trim();
        if (!body) return fail(ws, 'empty', 'Nothing to send.');
        if (body.length > limit) {
            return fail(ws, 'too_long', `Messages are limited to ${limit} characters.`);
        }

        const record = {
            id: crypto.randomUUID(),
            threadId: thread.id,
            authorId: peer.userId,
            authorName: peer.displayName ?? peer.username,
            body,
            createdAt: Date.now(),
        };
        const write = db.transaction(() => {
            insertMessage.run(record.id, record.threadId, record.authorId,
                record.authorName, record.body, record.createdAt);
            touchThread.run(record.createdAt, thread.id);
        });
        write();

        send('accepted', { id: record.id, createdAt: record.createdAt });
        toParties(thread, 'message', { message: record });
    });

    /* ── calls ──────────────────────────────────────────────────────────────
     *
     * A DM call is a HIDDEN SYSTEM ROOM: private (occupants masked from everyone
     * else), system (listed to no one, not even its two members — their clients know
     * it by the call state instead), members exactly the pair. Everything else rides
     * proven machinery: the move guards, the SFU router per channel, the client's
     * stage — which is what makes camera and screen share work in calls for free.
     */

    const RING_MS = 45_000;
    const calls = new Map();   // threadId -> { channelId, state: 'ringing'|'live', ringTimer }

    const toUser = (userId, type, payload) => {
        for (const peer of ctx.peers.forUser(userId)) ctx.ws.send(peer.ws, type, payload);
    };

    const endCall = (threadId, reason) => {
        const call = calls.get(threadId);
        if (!call) return;
        calls.delete(threadId);
        clearTimeout(call.ringTimer);
        const thread = threadById.get(threadId);
        if (thread) {
            for (const userId of [thread.user_a, thread.user_b]) {
                toUser(userId, 'call_ended', { threadId, reason });
            }
        }
        // The room dies once nobody is standing in it; clients leave on call_ended.
        const sweep = () => {
            if (ctx.peers.inChannel(call.channelId).length === 0) {
                try { deleteChannel(ctx.db.handle, call.channelId); } catch { /* already gone */ }
                return true;
            }
            return false;
        };
        if (!sweep()) {
            const timer = setInterval(() => { if (sweep()) clearInterval(timer); }, 2000);
            timer.unref?.();
        }
    };

    ctx.ws.on('call', ({ ws, msg, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) return fail(ws, 'no_thread', 'No such thread.');

        const existing = calls.get(thread.id);
        if (existing) {
            // Joining a call that is already ringing or live is answering it.
            ctx.actions.movePeer(peer.cid, existing.channelId, 'dm-call');
            if (existing.state === 'ringing') {
                existing.state = 'live';
                clearTimeout(existing.ringTimer);
                for (const userId of [thread.user_a, thread.user_b]) {
                    toUser(userId, 'call_live', { threadId: thread.id });
                }
            }
            return;
        }

        const channel = createChannel(db, {
            name: 'Private call',
            kind: 'both',
            private: true,
            system: true,
            createdBy: peer.userId,
        });
        addMember(db, channel.id, thread.user_a, peer.userId);
        addMember(db, channel.id, thread.user_b, peer.userId);

        const ringTimer = setTimeout(() => endCall(thread.id, 'no_answer'), RING_MS);
        ringTimer.unref?.();
        calls.set(thread.id, { channelId: channel.id, state: 'ringing', ringTimer });

        ctx.actions.movePeer(peer.cid, channel.id, 'dm-call');
        toUser(otherOf(thread, peer.userId), 'ring', {
            threadId: thread.id,
            from: { username: peer.username, displayName: peer.displayName ?? peer.username },
        });
        ctx.log.info({ evt: 'dm.call', from: peer.username }, `${peer.username} started a private call`);
    });

    ctx.ws.on('accept', ({ ws, msg, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        const call = thread && calls.get(thread.id);
        if (!thread || !call || !isParty(thread, peer.userId)) return fail(ws, 'no_call', 'That call is over.');

        clearTimeout(call.ringTimer);
        call.state = 'live';
        ctx.actions.movePeer(peer.cid, call.channelId, 'dm-call');
        for (const userId of [thread.user_a, thread.user_b]) {
            toUser(userId, 'call_live', { threadId: thread.id });
        }
    });

    ctx.ws.on('decline', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        const thread = peer && threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) return;
        if (calls.get(thread.id)?.state === 'ringing') endCall(thread.id, 'declined');
    });

    // A live call whose room loses a participant is over; the other side is told rather
    // than left talking to a router. Ringing calls keep their lone caller waiting.
    const watch = ({ peer, from }) => {
        for (const [threadId, call] of calls) {
            if (call.state !== 'live') continue;
            if (from === call.channelId || peer?.channelId === call.channelId) {
                const inside = ctx.peers.inChannel(call.channelId).length;
                if (inside <= 1) endCall(threadId, 'left');
            }
        }
    };
    ctx.hooks.on(HOOKS.PEER_MOVE, watch);
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => watch({ peer, from: peer?.channelId }));

    ctx.onUnload(() => {
        for (const threadId of [...calls.keys()]) endCall(threadId, 'server');
    });

    ctx.ws.on('read', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) return;
        const createdAt = Number(msg.createdAt);
        const id = String(msg.id ?? '');
        if (!Number.isFinite(createdAt) || !id) return;
        upsertRead.run({ userId: peer.userId, threadId: thread.id, createdAt, id });
    });
}
