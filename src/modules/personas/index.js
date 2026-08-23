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

function sniff(buffer) {
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

    // ── the library ──────────────────────────────────────────────────────────
    ctx.http.route('GET', '/api/personas/sounds', ({ json }) => {
        json(200, {
            sounds: db.prepare('SELECT id, name, mime, bytes FROM persona_sounds ORDER BY name').all(),
        });
    });

    ctx.http.route('POST', '/api/personas/sounds', ({ body, query, session, json, log }) => {
        const count = db.prepare('SELECT COUNT(*) AS n FROM persona_sounds').get().n;
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
            INSERT INTO persona_sounds (id, name, extension, mime, bytes, uploaded_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, kind.ext, kind.mime, buffer.length, session.userId, Date.now());

        log.info({ evt: 'persona.sound_added', name }, `${session.username} added the sound "${name}"`);
        json(201, { id, name, mime: kind.mime, bytes: buffer.length });
    }, { auth: 'admin', rawBody: true, maxBytes: MAX_BYTES });

    ctx.http.route('DELETE', '/api/personas/sounds/:id', ({ params, json }) => {
        const row = db.prepare('SELECT extension FROM persona_sounds WHERE id = ?').get(params.id);
        if (!row) throw new HttpError(404, 'No such sound.');

        try { fs.unlinkSync(path.join(dir, `${params.id}.${row.extension}`)); } catch { /* already gone */ }
        db.prepare('DELETE FROM persona_sounds WHERE id = ?').run(params.id);
        // Anyone who had chosen it falls back to silence rather than to a broken URL.
        db.prepare('UPDATE persona_choices SET join_sound = NULL WHERE join_sound = ?').run(params.id);
        db.prepare('UPDATE persona_choices SET leave_sound = NULL WHERE leave_sound = ?').run(params.id);

        json(200, { ok: true });
    }, { auth: 'admin' });

    ctx.http.route('GET', '/api/personas/sounds/:id/audio', ({ params, res }) => {
        const row = db.prepare('SELECT extension, mime FROM persona_sounds WHERE id = ?').get(params.id);
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
    ctx.http.route('GET', '/api/personas/me', ({ session, json }) => {
        const row = db.prepare('SELECT join_sound AS joinSound, leave_sound AS leaveSound FROM persona_choices WHERE user_id = ?')
            .get(session.userId);
        json(200, { joinSound: row?.joinSound ?? null, leaveSound: row?.leaveSound ?? null });
    });

    ctx.http.route('PUT', '/api/personas/me', ({ body, session, json }) => {
        const exists = (id) => id === null
            || db.prepare('SELECT 1 FROM persona_sounds WHERE id = ?').get(id);

        const joinSound = body?.joinSound ?? null;
        const leaveSound = body?.leaveSound ?? null;
        if (!exists(joinSound) || !exists(leaveSound)) {
            throw new HttpError(400, 'That sound is not on this server.');
        }

        db.prepare(`
            INSERT INTO persona_choices (user_id, join_sound, leave_sound) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET join_sound = excluded.join_sound, leave_sound = excluded.leave_sound
        `).run(session.userId, joinSound, leaveSound);

        json(200, { joinSound, leaveSound });
    }, { maxBytes: 1_000 });

    // ── playing ──────────────────────────────────────────────────────────────
    const choice = db.prepare('SELECT join_sound AS joinSound, leave_sound AS leaveSound FROM persona_choices WHERE user_id = ?');

    /**
     * Tell a channel to play a sound.
     *
     * The server sends an id, never audio: the sound is fetched and cached by the client
     * like any other asset, so a busy channel does not push the same file through the
     * signalling socket once per arrival.
     */
    const announce = (peer, which) => {
        if (!ctx.settings.get('enabled')) return;

        const row = choice.get(peer.userId);
        const soundId = which === 'join' ? row?.joinSound : row?.leaveSound;
        if (!soundId) return;

        ctx.ws.broadcast('play', { soundId, which, cid: peer.cid, username: peer.username },
            (sock) => {
                const other = ctx.peers.get(sock.cid);
                // Not to the person arriving or leaving: they know.
                return other && other.channelId === peer.channelId && other.cid !== peer.cid;
            });
    };

    ctx.hooks.on(HOOKS.PEER_JOIN, ({ peer }) => announce(peer, 'join'));
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => announce(peer, 'leave'));

    ctx.admin.panel({ id: 'personas', label: 'Join and leave sounds', order: 50 });
}
