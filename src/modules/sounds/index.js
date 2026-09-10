// Join and leave sounds.
//
// The previous server shipped a library of these baked into the image. Almost all of it
// was game audio, film lines and voice clips nobody had the right to redistribute, plus
// two files that had no business in a public repository at all. So the MECHANISM is here
// and the LIBRARY is not: a fresh server has no sounds, and an administrator uploads
// whatever their group actually has the right to use.
//
// Sounds are stored and served by this module rather than borrowed from the uploads
// module, so neither depends on the other and turning either off leaves the other whole.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../../core/http/server.js';
import { HOOKS } from '../../core/hooks/index.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SOUNDS = 100;

/** Container sniffing, same reasoning as uploads: the declared type is a claim. */
const SIGNATURES = [
    { ext: 'ogg', mime: 'audio/ogg', test: (b) => b.subarray(0, 4).toString('ascii') === 'OggS' },
    { ext: 'mp3', mime: 'audio/mpeg', test: (b) => b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
    { ext: 'wav', mime: 'audio/wav', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE' },
];

export function sniff(buffer) {
    if (buffer.length < 12) return null;
    for (const sig of SIGNATURES) {
        try {
            if (sig.test(buffer)) return sig;
        } catch {
            // Truncated or malformed simply is not a match.
        }
    }
    return null;
}

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;

    const dir = path.join(ctx.paths.data, 'sounds');
    fs.mkdirSync(dir, { recursive: true });

    ctx.settings.define('enabled', {
        type: 'boolean',
        label: 'Play join and leave sounds',
        help: 'Individual people can still choose to have no sound.',
    }, true);
    // Applied to anyone with no personal choice — new accounts, and the entire
    // server the first time this module is ever turned on. An empty string means
    // "no default configured", not the id of a real sound.
    ctx.settings.define('defaultJoinSound', {
        type: 'string',
        label: 'Default join sound',
        help: 'Used for anyone who has not chosen one.',
    }, '');
    ctx.settings.define('defaultLeaveSound', {
        type: 'string',
        label: 'Default leave sound',
        help: 'Used for anyone who has not chosen one.',
    }, '');

    // ── the library ──────────────────────────────────────────────────────────
    ctx.http.route('GET', '/api/sounds', ({ json }) => {
        json(200, {
            sounds: db.prepare('SELECT id, name, mime, bytes FROM sounds ORDER BY name').all(),
            defaults: {
                joinSound: ctx.settings.get('defaultJoinSound') || null,
                leaveSound: ctx.settings.get('defaultLeaveSound') || null,
            },
        });
    });

    ctx.http.route('POST', '/api/sounds', ({ body, query, session, json, log }) => {
        const count = db.prepare('SELECT COUNT(*) AS n FROM sounds').get().n;
        if (count >= MAX_SOUNDS) {
            throw new HttpError(409, `This server already has the maximum of ${MAX_SOUNDS} sounds.`);
        }

        const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        const kind = sniff(buffer);
        if (!kind) throw new HttpError(415, 'That does not look like an OGG, MP3 or WAV file.');

        const name = String(query.name ?? 'Untitled').trim().slice(0, 60) || 'Untitled';
        const id = crypto.randomUUID();
        fs.writeFileSync(path.join(dir, `${id}.${kind.ext}`), buffer);

        db.prepare(`
            INSERT INTO sounds (id, name, extension, mime, bytes, uploaded_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, kind.ext, kind.mime, buffer.length, session.userId, Date.now());

        log.info({ evt: 'sound.added', name }, `${session.username} added the sound "${name}"`);
        json(201, { id, name, mime: kind.mime, bytes: buffer.length });
    }, { auth: 'admin', rawBody: true, maxBytes: MAX_BYTES });

    ctx.http.route('DELETE', '/api/sounds/:id', ({ params, json }) => {
        const row = db.prepare('SELECT extension FROM sounds WHERE id = ?').get(params.id);
        if (!row) throw new HttpError(404, 'No such sound.');

        try { fs.unlinkSync(path.join(dir, `${params.id}.${row.extension}`)); } catch { /* already gone */ }
        db.prepare('DELETE FROM sounds WHERE id = ?').run(params.id);
        // Anyone who had chosen it falls back to silence rather than to a broken URL.
        db.prepare('UPDATE sound_choices SET join_sound = NULL WHERE join_sound = ?').run(params.id);
        db.prepare('UPDATE sound_choices SET leave_sound = NULL WHERE leave_sound = ?').run(params.id);
        // A deleted default is no default, not a dangling id nobody can hear.
        if (ctx.settings.get('defaultJoinSound') === params.id) ctx.settings.set('defaultJoinSound', '');
        if (ctx.settings.get('defaultLeaveSound') === params.id) ctx.settings.set('defaultLeaveSound', '');

        json(200, { ok: true });
    }, { auth: 'admin' });

    ctx.http.route('PUT', '/api/sounds/:id/default', ({ params, body, json }) => {
        const which = body?.which === 'leave' ? 'leave' : body?.which === 'join' ? 'join' : null;
        if (!which) throw new HttpError(400, 'which must be "join" or "leave".');
        if (!db.prepare('SELECT 1 FROM sounds WHERE id = ?').get(params.id)) {
            throw new HttpError(404, 'No such sound.');
        }
        ctx.settings.set(which === 'join' ? 'defaultJoinSound' : 'defaultLeaveSound', params.id);
        json(200, { which, soundId: params.id });
    }, { auth: 'admin' });

    ctx.http.route('GET', '/api/sounds/:id/audio', ({ params, res }) => {
        const row = db.prepare('SELECT extension, mime FROM sounds WHERE id = ?').get(params.id);
        if (!row) throw new HttpError(404, 'No such sound.');

        const file = path.resolve(dir, `${params.id}.${row.extension}`);
        if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
            throw new HttpError(404, 'No such sound.');
        }

        res.writeHead(200, {
            'Content-Type': row.mime,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=86400',
        });
        fs.createReadStream(file).pipe(res);
    });

    // ── individual choices ───────────────────────────────────────────────────
    ctx.http.route('GET', '/api/sounds/me', ({ session, json }) => {
        const row = db.prepare('SELECT join_sound AS joinSound, leave_sound AS leaveSound FROM sound_choices WHERE user_id = ?')
            .get(session.userId);
        // No personal choice falls back to whatever an admin has set as the default,
        // rather than to null — "new accounts and accounts that don't have a sound"
        // get the default dynamically, with nothing to migrate if it changes later.
        json(200, {
            joinSound: row?.joinSound ?? (ctx.settings.get('defaultJoinSound') || null),
            leaveSound: row?.leaveSound ?? (ctx.settings.get('defaultLeaveSound') || null),
        });
    });

    ctx.http.route('PUT', '/api/sounds/me', ({ body, session, json }) => {
        const exists = (id) => id === null
            || db.prepare('SELECT 1 FROM sounds WHERE id = ?').get(id);

        const joinSound = body?.joinSound ?? null;
        const leaveSound = body?.leaveSound ?? null;
        if (!exists(joinSound) || !exists(leaveSound)) {
            throw new HttpError(400, 'That sound is not on this server.');
        }

        db.prepare(`
            INSERT INTO sound_choices (user_id, join_sound, leave_sound) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET join_sound = excluded.join_sound, leave_sound = excluded.leave_sound
        `).run(session.userId, joinSound, leaveSound);

        json(200, { joinSound, leaveSound });
    }, { maxBytes: 1_000 });

    // ── playing ──────────────────────────────────────────────────────────────
    const choice = db.prepare('SELECT join_sound AS joinSound, leave_sound AS leaveSound FROM sound_choices WHERE user_id = ?');

    /**
     * Whether this account has another connection standing in the same room.
     *
     * The one thing a sound must never do is describe something that did not happen. An
     * account is allowed two connections — a desktop and a phone, or a reconnection
     * overlapping the socket it replaced — and in every one of those cases the person
     * neither arrived nor left, so nothing should be heard.
     */
    const elsewhereInRoom = (peer) => ctx.peers.forUser(peer.userId)
        .some((other) => other.cid !== peer.cid && other.channelId === peer.channelId);

    /**
     * Tell a channel to play a sound.
     *
     * The server sends an id, never audio: the sound is fetched and cached by the client
     * like any other asset, so a busy channel does not push the same file through the
     * signalling socket once per arrival.
     */
    const announce = (peer, which) => {
        if (!ctx.settings.get('enabled')) return;
        if (elsewhereInRoom(peer)) return;

        const row = choice.get(peer.userId);
        const personal = which === 'join' ? row?.joinSound : row?.leaveSound;
        const soundId = personal ?? (ctx.settings.get(which === 'join' ? 'defaultJoinSound' : 'defaultLeaveSound') || null);
        if (!soundId) return;

        ctx.ws.broadcast('play', { soundId, which, cid: peer.cid, username: peer.username },
            (sock) => {
                const other = ctx.peers.get(sock.cid);
                // Not to the person arriving or leaving: they know.
                return other && other.channelId === peer.channelId && other.cid !== peer.cid;
            });
    };

    // A resume is a line coming back, not a person walking in. Announcing it is exactly
    // the noise that made a flaky connection sound like somebody pacing in and out.
    ctx.hooks.on(HOOKS.PEER_JOIN, ({ peer, resumed }) => { if (!resumed) announce(peer, 'join'); });
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => announce(peer, 'leave'));

    ctx.admin.panel({ id: 'sounds', label: 'Join and leave sounds', order: 50 });
}
