// Bubbles.
//
// Ported from the previous server, where they were a favourite: an administrator makes a
// bubble — a photo and a name — and a few at a time drift over everybody's chat. Clicking
// one opens a small conversation that belongs to the bubble rather than to any channel, so
// it is the same wherever you are standing and whoever you are with.
//
// Two things are kept apart, as they were before:
//
//   WHAT EXISTS is stored: the bubbles, their messages, who has read what.
//   WHAT IS FLOATING is not. A random handful is chosen on a timer and told to everybody;
//   it is rebuilt on every start, because nothing about "which were up" is worth keeping.
//
// The photo is this module's own file, not an upload. Uploads are swept after a retention
// period, and a bubble is meant to outlive every message in it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../../core/http/server.js';
import { sniffImage, IMAGE_REFUSAL } from '../../core/media/image-type.js';
import { cleanAttachment } from '../../core/media/attachment.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_BUBBLES = 60;
const NAME_MAX = 60;
const MAX_BODY = 2000;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;

/**
 * Which bubbles float this time: a random number of them, from none up to `max`, chosen at
 * random. "Sometimes none" is deliberate and is the web app's behaviour — a bubble is a
 * surprise, and a surprise that is always there is furniture.
 *
 * A partial Fisher–Yates rather than the previous server's sort-by-random, which is biased
 * towards the original order.
 */
export function pickActive(ids, max, random = Math.random) {
    const pool = [...ids];
    const ceiling = Math.max(0, Math.floor(Number(max) || 0));
    const count = Math.min(pool.length, Math.floor(random() * (ceiling + 1)));
    for (let i = 0; i < count; i += 1) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;

    const dir = path.join(ctx.paths.data, 'bubbles');
    fs.mkdirSync(dir, { recursive: true });

    ctx.settings.define('maxActive', {
        type: 'number', integer: true, min: 0, max: 12,
        label: 'Most bubbles floating at once',
        help: 'Each rotation floats a random number up to this — sometimes none, as on the web app.',
    }, 4);
    ctx.settings.define('rotateMinutes', {
        type: 'number', integer: true, min: 1, max: 1440,
        label: 'Minutes between rotations',
        help: 'How often a fresh handful is chosen to float.',
    }, 20);
    ctx.settings.define('retentionDays', {
        type: 'number', integer: true, min: 0, max: 3650,
        label: 'Keep bubble messages for (days)',
        help: '0 keeps them for ever, which is what the web app did.',
    }, 0);

    const photoUrl = (id) => `/api/bubbles/${id}/photo`;

    const byId = db.prepare('SELECT id, name, extension, mime, created_at AS createdAt FROM bubbles WHERE id = ?');
    const allIds = db.prepare('SELECT id FROM bubbles');

    // Unread is "a message after my marker that somebody else wrote": your own words are
    // never news to you, and a marker is insertion order, so a stale device cannot rewind it.
    const listFor = db.prepare(`
        SELECT b.id, b.name, b.created_at AS createdAt,
               (SELECT MAX(m.created_at) FROM bubble_messages m WHERE m.bubble_id = b.id) AS lastMessageAt,
               EXISTS (
                   SELECT 1 FROM bubble_messages m
                   WHERE m.bubble_id = b.id AND m.rowid > COALESCE(r.last_seq, 0)
                     AND (m.user_id IS NULL OR m.user_id != @userId)
               ) AS unread
        FROM bubbles b
        LEFT JOIN bubble_reads r ON r.bubble_id = b.id AND r.user_id = @userId
        ORDER BY b.created_at, b.id
    `);

    const insertMessage = db.prepare(`
        INSERT INTO bubble_messages (id, bubble_id, user_id, author_name, avatar, body, attachment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seqOf = db.prepare('SELECT rowid AS seq, bubble_id AS bubbleId FROM bubble_messages WHERE id = ?');
    const upsertRead = db.prepare(`
        INSERT INTO bubble_reads (user_id, bubble_id, last_seq) VALUES (@userId, @bubbleId, @seq)
        ON CONFLICT (user_id, bubble_id) DO UPDATE SET last_seq = MAX(bubble_reads.last_seq, excluded.last_seq)
    `);
    // The same (created_at, id) cursor as channel history, for the same reason: a bare
    // timestamp is not a total order, and paging on one skips and repeats messages.
    const page = db.prepare(`
        SELECT id, bubble_id AS bubbleId, user_id AS userId, author_name AS authorName,
               avatar, body, attachment, created_at AS createdAt
        FROM bubble_messages
        WHERE bubble_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `);

    const photoFile = (row) => path.join(dir, `${row.id}.${row.extension}`);

    // ── what is floating ─────────────────────────────────────────────────────
    let active = [];
    let rotateTimer = null;

    const rotate = () => {
        active = pickActive(allIds.all().map((r) => r.id), ctx.settings.get('maxActive'));
        ctx.ws.broadcast('active', { ids: active });
    };
    // A chain of timeouts rather than one interval, so a changed rotation time takes effect
    // at the next turn instead of needing the module restarted.
    const schedule = () => {
        clearTimeout(rotateTimer);
        rotateTimer = setTimeout(() => { rotate(); schedule(); }, ctx.settings.get('rotateMinutes') * 60_000);
        rotateTimer.unref?.();
    };
    rotate();
    schedule();
    ctx.onUnload(() => clearTimeout(rotateTimer));

    // ── reading ──────────────────────────────────────────────────────────────
    ctx.http.route('GET', '/api/bubbles', ({ session, json }) => {
        json(200, {
            bubbles: listFor.all({ userId: session.userId }).map((r) => ({
                id: r.id,
                name: r.name,
                photo: photoUrl(r.id),
                createdAt: r.createdAt,
                lastMessageAt: r.lastMessageAt ?? null,
                unread: r.unread === 1,
            })),
            active,
        });
    });

    ctx.http.route('GET', '/api/bubbles/:id/photo', ({ params, res }) => {
        const row = byId.get(params.id);
        if (!row) throw new HttpError(404, 'No such bubble.');
        const file = path.resolve(photoFile(row));
        if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
            throw new HttpError(404, 'No such bubble.');
        }
        res.writeHead(200, {
            'Content-Type': row.mime,
            'X-Content-Type-Options': 'nosniff',
            // A bubble's photo never changes under its id; a new photo is a new bubble.
            'Cache-Control': 'private, max-age=86400',
        });
        fs.createReadStream(file).pipe(res);
    });

    ctx.http.route('GET', '/api/bubbles/:id/messages', ({ params, query, json }) => {
        if (!byId.get(params.id)) throw new HttpError(404, 'No such bubble.');
        const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.limit) || PAGE_DEFAULT));
        const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
        const beforeId = query.beforeId ?? '￿';
        const rows = page.all(params.id, before, before, beforeId, limit)
            .map((r) => ({ ...r, attachment: r.attachment ? JSON.parse(r.attachment) : null }));
        const oldest = rows.at(-1);
        json(200, {
            messages: rows.reverse(),
            nextBefore: rows.length === limit ? oldest.createdAt : null,
            nextBeforeId: rows.length === limit ? oldest.id : null,
        });
    });

    // ── talking in one ───────────────────────────────────────────────────────
    // Everybody signed in hears about it, wherever they stand: a bubble belongs to no room,
    // and its throb on a screen you are not looking at is made of exactly these frames.
    ctx.ws.on('send', ({ ws, msg, send, fail, broadcast }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return fail(ws, 'not_joined', 'Sign in first.');
        const bubble = byId.get(String(msg.bubbleId ?? ''));
        if (!bubble) return fail(ws, 'no_bubble', 'That bubble has gone.');

        const body = String(msg.body ?? '').trim();
        const attachment = cleanAttachment(msg.attachment);
        if (!body && !attachment) return fail(ws, 'empty', 'Nothing to send.');
        if (body.length > MAX_BODY) {
            return fail(ws, 'too_long', `Messages in a bubble are limited to ${MAX_BODY} characters.`);
        }

        const record = {
            id: crypto.randomUUID(),
            bubbleId: bubble.id,
            userId: peer.userId,
            authorName: peer.displayName ?? peer.username,
            avatar: peer.avatar ?? null,
            body,
            attachment,
            createdAt: Date.now(),
        };
        db.transaction(() => {
            const { lastInsertRowid } = insertMessage.run(record.id, record.bubbleId, record.userId,
                record.authorName, record.avatar, record.body,
                attachment ? JSON.stringify(attachment) : null, record.createdAt);
            // What you said yourself is read, on every device you have.
            upsertRead.run({ userId: peer.userId, bubbleId: bubble.id, seq: Number(lastInsertRowid) });
        })();

        send('accepted', { id: record.id, createdAt: record.createdAt });
        broadcast('message', { message: record });
    });

    ctx.ws.on('read', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        // The id names the message; its insertion order is the marker. An id this bubble
        // never had marks nothing.
        const seen = seqOf.get(String(msg.id ?? ''));
        if (!seen || seen.bubbleId !== String(msg.bubbleId ?? '')) return;
        upsertRead.run({ userId: peer.userId, bubbleId: seen.bubbleId, seq: seen.seq });
    });

    // ── an administrator's ───────────────────────────────────────────────────
    ctx.http.route('POST', '/api/bubbles', ({ body, query, session, json, log }) => {
        const name = String(query.name ?? '').trim().slice(0, NAME_MAX);
        if (!name) throw new HttpError(400, 'A bubble needs a name.');
        if (allIds.all().length >= MAX_BUBBLES) {
            throw new HttpError(409, `This server already has the maximum of ${MAX_BUBBLES} bubbles.`);
        }
        const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        const kind = sniffImage(buffer);
        if (!kind) throw new HttpError(415, IMAGE_REFUSAL);

        const id = crypto.randomUUID();
        fs.writeFileSync(path.join(dir, `${id}.${kind.ext}`), buffer);
        db.prepare('INSERT INTO bubbles (id, name, extension, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, name, kind.ext, kind.mime, session.userId, Date.now());

        const bubble = { id, name, photo: photoUrl(id), createdAt: Date.now(), lastMessageAt: null, unread: false };
        ctx.ws.broadcast('created', { bubble });
        // A new bubble gets its chance to float now rather than at the next turn — the web
        // app's choice, so that making one is not followed by twenty minutes of nothing.
        rotate();
        schedule();
        log.info({ evt: 'bubble.created', name }, `${session.username} made the bubble "${name}"`);
        json(201, { bubble });
    }, { auth: 'admin', rawBody: true, maxBytes: MAX_PHOTO_BYTES });

    // Clearing keeps the bubble and empties its conversation: a different decision from
    // deleting it, and the only thing that ever removes bubble messages besides retention.
    ctx.http.route('POST', '/api/bubbles/:id/clear', ({ params, session, json, log }) => {
        const bubble = byId.get(params.id);
        if (!bubble) throw new HttpError(404, 'No such bubble.');
        let removed = 0;
        db.transaction(() => {
            db.prepare('DELETE FROM bubble_reads WHERE bubble_id = ?').run(bubble.id);
            removed = db.prepare('DELETE FROM bubble_messages WHERE bubble_id = ?').run(bubble.id).changes;
        })();
        ctx.ws.broadcast('cleared', { id: bubble.id });
        log.warn({ evt: 'bubble.cleared', name: bubble.name, count: removed },
            `${session.username} cleared ${removed} message(s) from the bubble "${bubble.name}"`);
        json(200, { ok: true, removed });
    }, { auth: 'admin' });

    ctx.http.route('DELETE', '/api/bubbles/:id', ({ params, session, json, log }) => {
        const bubble = byId.get(params.id);
        if (!bubble) throw new HttpError(404, 'No such bubble.');
        db.transaction(() => {
            db.prepare('DELETE FROM bubble_reads WHERE bubble_id = ?').run(bubble.id);
            db.prepare('DELETE FROM bubble_messages WHERE bubble_id = ?').run(bubble.id);
            db.prepare('DELETE FROM bubbles WHERE id = ?').run(bubble.id);
        })();
        try { fs.unlinkSync(photoFile(bubble)); } catch { /* already gone */ }
        active = active.filter((id) => id !== bubble.id);
        ctx.ws.broadcast('deleted', { id: bubble.id });
        log.warn({ evt: 'bubble.deleted', name: bubble.name },
            `${session.username} deleted the bubble "${bubble.name}"`);
        json(200, { ok: true });
    }, { auth: 'admin' });

    // ── retention ────────────────────────────────────────────────────────────
    const sweep = () => {
        const days = ctx.settings.get('retentionDays');
        if (!days) return;
        const { changes } = db.prepare('DELETE FROM bubble_messages WHERE created_at < ?')
            .run(Date.now() - days * 86_400_000);
        if (changes) {
            ctx.log.info({ evt: 'bubbles.pruned', count: changes, days },
                `Removed ${changes} bubble message(s) older than ${days} days`);
        }
    };
    sweep();
    const sweeper = setInterval(sweep, 6 * 3600_000);
    sweeper.unref();
    ctx.onUnload(() => clearInterval(sweeper));

    ctx.admin.panel({ id: 'bubbles', label: 'Bubbles', order: 60 });
}
