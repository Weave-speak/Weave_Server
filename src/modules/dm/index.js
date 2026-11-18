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
import { cleanAttachment } from '../../core/media/attachment.js';

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
        INSERT INTO dm_messages (id, thread_id, author_id, author_name, body, created_at, attachment)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const page = db.prepare(`
        SELECT id, thread_id AS threadId, author_id AS authorId, author_name AS authorName,
               body, created_at AS createdAt, attachment
        FROM dm_messages
        WHERE thread_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`);
    const lastMessage = db.prepare(`
        SELECT body, author_id AS authorId, created_at AS createdAt FROM dm_messages
        WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);

    // Markers are the acked message's ROWID — see chat_reads for the whole argument.
    const upsertRead = db.prepare(`
        INSERT INTO dm_reads (user_id, thread_id, last_created_at, last_id, last_seq)
        VALUES (@userId, @threadId, @createdAt, @id, @seq)
        ON CONFLICT (user_id, thread_id) DO UPDATE SET
            last_created_at = MAX(dm_reads.last_created_at, excluded.last_created_at),
            last_id = CASE WHEN excluded.last_seq > dm_reads.last_seq THEN excluded.last_id ELSE dm_reads.last_id END,
            last_seq = MAX(dm_reads.last_seq, excluded.last_seq)`);
    const seqOf = db.prepare('SELECT rowid AS seq, thread_id AS threadId FROM dm_messages WHERE id = ?');
    const readOf = db.prepare('SELECT last_created_at AS lastCreatedAt, last_id AS lastId, last_seq AS lastSeq FROM dm_reads WHERE user_id = ? AND thread_id = ?');
    const unreadIn = db.prepare(`
        SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM dm_messages m
            WHERE m.thread_id = @threadId
              AND m.author_id != @userId
              AND m.rowid > @afterSeq
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
                afterSeq: mark?.lastSeq ?? 0,
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
            messages: rows.reverse().map((r) => ({
                ...r, attachment: r.attachment ? JSON.parse(r.attachment) : null,
            })),
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

    // Typing, DM edition: relayed only to the one person it could concern, throttled
    // exactly like the channel version, stored nowhere. The receiver expires it.
    const lastTyping = new Map();   // cid -> last relayed at
    ctx.ws.on('typing', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) return;
        const now = Date.now();
        if (now - (lastTyping.get(ws.cid) ?? 0) < 4_000) return;
        lastTyping.set(ws.cid, now);
        for (const other of ctx.peers.forUser(otherOf(thread, peer.userId))) {
            ctx.ws.send(other.ws, 'typing', { threadId: thread.id, username: peer.username });
        }
    });

    ctx.ws.on('send', ({ ws, msg, send, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return fail(ws, 'not_joined', 'Sign in first.');

        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) {
            return fail(ws, 'no_thread', 'No such thread.');
        }

        const limit = ctx.settings.get('maxLength');
        const body = String(msg.body ?? '').trim();
        const attachment = cleanAttachment(msg.attachment);
        if (!body && !attachment) return fail(ws, 'empty', 'Nothing to send.');
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
            attachment,
        };
        const write = db.transaction(() => {
            insertMessage.run(record.id, record.threadId, record.authorId,
                record.authorName, record.body, record.createdAt,
                attachment ? JSON.stringify(attachment) : null);
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
     *
     * The ring also goes by push, so a phone whose app is asleep rings too. Every call
     * carries a `callId` for that: the same ring reaches one device over the socket AND
     * by push, and a phone told "cancel" must know which ring it means — a thread can be
     * rung, hung up and rung again faster than a push service delivers.
     */

    const RING_MS = 45_000;
    /** A missed call is worth hearing about a day late; a ring is not worth a second late. */
    const MISSED_TTL_S = 24 * 60 * 60;
    // threadId -> { callId, callerId, calleeId, channelId, state: 'ringing'|'live', ringTimer,
    //              startedAt, expiresAt, from }
    const calls = new Map();

    // 128 bits in base64url is 22 characters, inside RFC 8030's 32-character Topic, so the
    // id can double as the push topic that lets a cancel replace its own held ring.
    const newCallId = () => crypto.randomBytes(16).toString('base64url');

    const toUser = (userId, type, payload) => {
        for (const peer of ctx.peers.forUser(userId)) ctx.ws.send(peer.ws, type, payload);
    };

    /**
     * Tell the callee's devices, by push, what became of a ring. Only ever the callee: the
     * caller's app is open by definition, and is told over its socket.
     */
    const pushToCallee = (call, threadId, kind, reason) => {
        const payload = {
            v: 1,
            kind,
            callId: call.callId,
            call: { type: 'dm', threadId },
            from: call.from,
            expiresAt: call.expiresAt,
            ...(reason ? { reason } : {}),
        };
        // A ring and its cancel are worth nothing once the ring would have stopped anyway, and
        // a cancel is as urgent as the ring it stops. The topic is shared by all three, so
        // a push service still holding the ring for an offline phone replaces it.
        const opts = kind === 'missed'
            ? { ttl: MISSED_TTL_S, urgency: 'normal', topic: call.callId }
            : { ttl: Math.max(1, Math.ceil((call.expiresAt - Date.now()) / 1000)), urgency: 'high', topic: call.callId };
        ctx.push.toUser(call.calleeId, payload, opts).catch(() => {});
    };

    /**
     * The call is (still) live. Sent again when it already is, because a second device of
     * the callee's joining needs its own `call_live` to know it is in a call.
     */
    const goLive = (thread, call) => {
        const answering = call.state === 'ringing';
        clearTimeout(call.ringTimer);
        call.state = 'live';
        for (const userId of [thread.user_a, thread.user_b]) {
            toUser(userId, 'call_live', { threadId: thread.id, callId: call.callId });
        }
        // Answered — possibly on this very phone, possibly on the callee's laptop. Either
        // way every other device of theirs must stop ringing.
        if (answering) pushToCallee(call, thread.id, 'ring_cancel', 'answered');
    };

    const endCall = (threadId, reason) => {
        const call = calls.get(threadId);
        if (!call) return;
        calls.delete(threadId);
        clearTimeout(call.ringTimer);
        const thread = threadById.get(threadId);
        if (thread) {
            for (const userId of [thread.user_a, thread.user_b]) {
                toUser(userId, 'call_ended', { threadId, callId: call.callId, reason });
            }
        }
        // A ring that ended without an answer reaches the callee's sleeping devices too. A
        // refusal only needs the ringing stopped; nobody answered and nobody refused is a
        // missed call, which is the one the phone keeps for later with a Call back.
        if (call.state === 'ringing') {
            const missed = reason === 'no_answer' || reason === 'cancelled';
            pushToCallee(call, threadId, missed ? 'missed' : 'ring_cancel', reason);
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

    /**
     * The ringing call a decline from `userId` may end, or null.
     *
     * `callId` is optional, for clients that predate it, but honoured when given: a phone
     * declining from a notification can be late, and a stale decline must not hang up a
     * NEW call on the same thread.
     */
    const ringingFor = (threadId, userId, callId) => {
        const thread = threadById.get(String(threadId ?? ''));
        if (!thread || !isParty(thread, userId)) return null;
        const call = calls.get(thread.id);
        if (!call || call.state !== 'ringing') return null;
        if (callId !== undefined && callId !== null && String(callId) !== call.callId) return null;
        return { thread, call };
    };

    /** The caller hanging up is a cancel; the callee refusing is a decline. */
    const decline = ({ thread, call }, userId) => {
        endCall(thread.id, userId === call.callerId ? 'cancelled' : 'declined');
    };

    ctx.ws.on('call', ({ ws, msg, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        if (!thread || !isParty(thread, peer.userId)) return fail(ws, 'no_thread', 'No such thread.');

        const existing = calls.get(thread.id);
        if (existing) {
            // Joining a call that is already ringing or live is answering it — when the
            // callee does it. The caller doing it from a second device is only moving the
            // call to that device; it must not mark the call answered and stop the ring.
            ctx.actions.movePeer(peer.cid, existing.channelId, 'dm-call');
            if (existing.state === 'ringing' && peer.userId === existing.calleeId) goLive(thread, existing);
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

        const startedAt = Date.now();
        const expiresAt = startedAt + RING_MS;
        const ringTimer = setTimeout(() => endCall(thread.id, 'no_answer'), RING_MS);
        ringTimer.unref?.();
        const call = {
            callId: newCallId(),
            callerId: peer.userId,
            calleeId: otherOf(thread, peer.userId),
            channelId: channel.id,
            state: 'ringing',
            ringTimer,
            startedAt,
            expiresAt,
            from: { username: peer.username, displayName: peer.displayName ?? peer.username },
        };
        calls.set(thread.id, call);

        if (!ctx.actions.movePeer(peer.cid, channel.id, 'dm-call')) {
            // Nobody to ring on behalf of: unwind before the callee hears anything.
            calls.delete(thread.id);
            clearTimeout(ringTimer);
            try { deleteChannel(db, channel.id); } catch { /* already gone */ }
            return fail(ws, 'call_failed', 'The call could not be started.');
        }
        toUser(call.calleeId, 'ring', {
            threadId: thread.id,
            callId: call.callId,
            from: call.from,
            expiresAt,
        });
        pushToCallee(call, thread.id, 'ring');
        ctx.log.info({ evt: 'dm.call', from: peer.username }, `${peer.username} started a private call`);
    });

    ctx.ws.on('accept', ({ ws, msg, fail }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const thread = threadById.get(String(msg.threadId ?? ''));
        const call = thread && calls.get(thread.id);
        const stale = call && msg.callId !== undefined && msg.callId !== null && String(msg.callId) !== call.callId;
        if (!thread || !call || stale || !isParty(thread, peer.userId)) return fail(ws, 'no_call', 'That call is over.');

        ctx.actions.movePeer(peer.cid, call.channelId, 'dm-call');
        // The caller's own second device accepting is moving the call there, not answering.
        if (call.state === 'live' || peer.userId === call.calleeId) goLive(thread, call);
    });

    ctx.ws.on('decline', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const ringing = ringingFor(msg.threadId, peer.userId, msg.callId);
        if (ringing) decline(ringing, peer.userId);
    });

    // Declining from a phone's notification, with no app running to hold a socket. The
    // phone's background half has a session token and nothing else, so this is plain HTTP.
    //
    // Idempotent for the two people in the thread: a decline that arrives after the call
    // was answered, ended, or replaced by a newer one is not an error — the phone only
    // wants the ringing gone — so it answers `ended: false`. The callId is required here,
    // unlike on the socket: this route's only caller is a notification, which always has
    // one, and a decline without it could end a call the person never saw. Anyone else
    // gets the same 404 as a thread that does not exist.
    ctx.http.route('POST', '/api/dm/threads/:id/call/decline', ({ session, params, body, json }) => {
        const thread = threadById.get(params.id);
        if (!thread || !isParty(thread, session.userId)) {
            return json(404, { error: 'no_thread', message: 'No such thread.' });
        }
        const callId = typeof body?.callId === 'string' ? body.callId : '';
        if (!callId) return json(400, { error: 'no_call_id', message: 'Name the call to decline.' });
        const ringing = ringingFor(thread.id, session.userId, callId);
        if (ringing) decline(ringing, session.userId);
        json(200, { ok: true, ended: Boolean(ringing) });
    }, { maxBytes: 1_000 });

    /**
     * A call whose room has emptied out of the side that was in it is over.
     *
     * Live: down to one, the other side is told rather than left talking to a router.
     * Ringing: the caller is the only one inside, so the room emptying means they hung up
     * — moved away, left voice, or signed off. That used to be skipped, which left the
     * callee ringing for the rest of 45 seconds into an empty room; answering then put
     * them in it alone.
     */
    const watch = ({ peer, from }) => {
        for (const [threadId, call] of calls) {
            if (from !== call.channelId && peer?.channelId !== call.channelId) continue;
            const inside = ctx.peers.inChannel(call.channelId).length;
            if (call.state === 'live' && inside <= 1) endCall(threadId, 'left');
            else if (call.state === 'ringing' && inside === 0) endCall(threadId, 'cancelled');
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
        const seen = seqOf.get(id);
        if (!seen || seen.threadId !== thread.id) return;
        upsertRead.run({ userId: peer.userId, threadId: thread.id, createdAt, id, seq: seen.seq });
    });
}
