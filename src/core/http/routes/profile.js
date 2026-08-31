// The two things a person owns about themselves: a status, and a picture.
//
// In core rather than in a module because both are IDENTITY. A module can be switched off
// and the server keeps working; a server where switching something off wipes everybody's
// face and reverts their status is not a server anybody would run twice.
//
// The picture is stored under <data>/avatars and deliberately NOT under <data>/uploads:
// the uploads module sweeps that directory on a retention timer, thirty days by default,
// so an avatar kept there would stop existing after a month and the only symptom would be
// everybody's photograph quietly turning back into initials.
//
// Nothing here re-encodes the image. The client crops to a square and sends the result,
// which keeps the Pi from growing a native image dependency for something a canvas does
// in a millisecond — and means the bytes stored are exactly the bytes the person saw in
// the crop frame. The size ceiling is what stops that being abused.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../server.js';
import { getUserById, updateProfile, UserError, STATUSES } from '../../users/index.js';
import { sniffImage, IMAGE_REFUSAL } from '../../media/image-type.js';

/**
 * An avatar is a small square. Two megabytes is generous for one and still refuses
 * somebody pointing a 40-megapixel camera at the endpoint.
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function registerProfileRoutes({ router, db, config, log, peers, ws }) {
    const dir = config.avatarsDir;
    fs.mkdirSync(dir, { recursive: true });

    /**
     * Tell everyone the roster changed for this account.
     *
     * Per USER, because both of these are facts about an account rather than about one
     * connection: somebody signed in twice has one face and one status, and updating only
     * the connection that made the request would show them differently in two places.
     */
    const announce = (user) => {
        for (const peer of peers.forUser(user.id)) {
            peer.avatar = user.avatar;
            peer.status = user.status;
        }
        ws.broadcast('peer_profile_changed', {
            userId: user.id,
            avatar: user.avatar,
            status: user.status,
            displayName: user.displayName,
        });
    };

    // ── status ───────────────────────────────────────────────────────────────
    //
    // Separate from the "away" the roster derives from standing in an AFK channel, and
    // deliberately so: that one answers "where is this person", this one answers "what
    // have they told us". The AFK sweep moves people between rooms and must never
    // overwrite something its owner set on purpose.
    router.register('core', 'PATCH', '/api/me', ({ body, session, json }) => {
        try {
            const user = updateProfile(db, session.userId, {
                ...(body?.status !== undefined ? { status: body.status } : {}),
            });
            announce(user);
            log.info({ evt: 'profile.updated', user: session.username, status: user.status },
                `${session.username} is now ${user.status}`);
            json(200, { user });
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }
    });

    // ── the picture ──────────────────────────────────────────────────────────
    router.register('core', 'POST', '/api/me/avatar', ({ body, session, json }) => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        if (!buffer.length) throw new HttpError(400, 'No image was sent.');

        const kind = sniffImage(buffer);
        // Phrased about what it IS rather than what it was called: neither the filename
        // nor the declared Content-Type was consulted, because both are claims.
        if (!kind) throw new HttpError(415, IMAGE_REFUSAL);

        const previous = getUserById(db, session.userId)?.avatar ?? null;
        const id = `${crypto.randomUUID()}.${kind.ext}`;
        fs.writeFileSync(path.join(dir, id), buffer);

        const user = updateProfile(db, session.userId, { avatar: id });

        // Only after the row points at the new file. The other order leaves an account
        // referencing a picture that has already been deleted, which is worse than an
        // orphan: an orphan wastes a few kilobytes, a dangling reference is a broken image
        // on every message that person ever sent.
        removeAvatarFile(previous);

        announce(user);
        log.info({ evt: 'avatar.set', user: session.username, bytes: buffer.length },
            `${session.username} set a profile picture (${(buffer.length / 1024).toFixed(0)} KB)`);
        json(201, { user, avatar: id, url: `/api/avatars/${id}` });
    }, { rawBody: true, maxBytes: MAX_AVATAR_BYTES });

    router.register('core', 'DELETE', '/api/me/avatar', ({ session, json }) => {
        const previous = getUserById(db, session.userId)?.avatar ?? null;
        const user = updateProfile(db, session.userId, { avatar: null });
        removeAvatarFile(previous);
        announce(user);
        json(200, { user });
    });

    /**
     * Serving a face.
     *
     * Authenticated like uploads are: a roster is not public, and neither is what the
     * people on it look like. The id is generated and never reused, so the bytes behind a
     * URL can never change and it caches forever.
     */
    router.register('core', 'GET', '/api/avatars/:id', ({ params, res }) => {
        const file = resolveAvatar(params.id);
        if (!file) throw new HttpError(404, 'No such picture.');

        res.writeHead(200, {
            'Content-Type': file.mime,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=31536000, immutable',
            // Belt and braces against a file that is a valid image AND valid HTML.
            'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        fs.createReadStream(file.path).pipe(res);
    });

    /**
     * The id from the URL is never trusted to be a path.
     *
     * It is matched against the shape this server generates — a UUID and one of the
     * extensions it stores — and the result is then checked for containment anyway,
     * because that invariant is always one refactor away from being untrue.
     */
    function resolveAvatar(id) {
        if (!/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/i.test(String(id ?? ''))) return null;
        const full = path.resolve(dir, id);
        if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full)) return null;
        const ext = path.extname(full).slice(1).toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
        return mime ? { path: full, mime } : null;
    }

    /** Best effort. A picture that outlives its account costs kilobytes, not correctness. */
    function removeAvatarFile(id) {
        const file = id ? resolveAvatar(id) : null;
        if (!file) return;
        try {
            fs.unlinkSync(file.path);
        } catch {
            // Already gone, which is the outcome we wanted anyway.
        }
    }

    return { STATUSES };
}
