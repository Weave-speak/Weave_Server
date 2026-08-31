// Image uploads.
//
// Files are written under the data directory with a generated name, and the served URL
// carries only that generated id. The uploader's filename is never used on disk or in a
// URL, because it is attacker-controlled text and every path-traversal bug in this class
// begins with trusting it.
//
// The type is decided by sniffing the file's own magic bytes — not the Content-Type
// header, not the extension. Both of those are claims made by the client.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../../core/http/server.js';
// One list of what Weave accepts, shared with avatars. A module may reach into core;
// core may never reach into a module.
import { sniffImage, IMAGE_REFUSAL } from '../../core/media/image-type.js';

const MAX_BYTES = 10 * 1024 * 1024;

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;
    const dir = ctx.paths.uploads;
    fs.mkdirSync(dir, { recursive: true });

    ctx.settings.define('retentionDays', {
        type: 'number',
        integer: true,
        min: 0,
        max: 3650,
        label: 'Keep uploads for (days)',
        help: 'Files older than this are deleted. 0 keeps them forever. Worth matching to your message retention.',
    }, 30);

    ctx.http.route('POST', '/api/uploads', ({ body, session, json, log }) => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        if (!buffer.length) throw new HttpError(400, 'No file was sent.');

        const kind = sniffImage(buffer);
        if (!kind) {
            // Deliberately phrased about what it IS, not what it was called: the
            // extension and the declared type were never consulted.
            throw new HttpError(415, IMAGE_REFUSAL);
        }

        const id = crypto.randomUUID();
        fs.writeFileSync(path.join(dir, `${id}.${kind.ext}`), buffer);

        db.prepare(`
            INSERT INTO uploads (id, user_id, extension, mime, bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, session.userId, kind.ext, kind.mime, buffer.length, Date.now());

        log.info(
            { evt: 'upload.stored', bytes: buffer.length, mime: kind.mime },
            `${session.username} uploaded ${(buffer.length / 1024).toFixed(0)} KB`,
        );

        json(201, { id, url: `/api/uploads/${id}`, mime: kind.mime, bytes: buffer.length });
    }, { rawBody: true, maxBytes: MAX_BYTES });

    // Authenticated. The previous server served uploads to anyone who knew the URL, so
    // every shared image was readable by anyone who ever saw the link.
    ctx.http.route('GET', '/api/uploads/:id', ({ params, res }) => {
        const row = db.prepare('SELECT extension, mime FROM uploads WHERE id = ?').get(params.id);
        if (!row) throw new HttpError(404, 'No such file.');

        // The extension comes from the database, not the URL, so this cannot contain a
        // path. The containment check is here regardless, because that invariant is one
        // refactor away from being untrue.
        const file = path.resolve(dir, `${params.id}.${row.extension}`);
        if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
            throw new HttpError(404, 'No such file.');
        }

        res.writeHead(200, {
            'Content-Type': row.mime,
            'X-Content-Type-Options': 'nosniff',
            // The id is generated per file and never reused, so the bytes behind a URL
            // can never change.
            'Cache-Control': 'private, max-age=31536000, immutable',
            // Belt and braces against a file that is a valid image AND valid HTML.
            'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        fs.createReadStream(file).pipe(res);
    });

    const sweep = () => {
        const days = ctx.settings.get('retentionDays');
        if (!days) return;

        const cutoff = Date.now() - days * 86_400_000;
        const old = db.prepare('SELECT id, extension FROM uploads WHERE created_at < ?').all(cutoff);

        for (const row of old) {
            // File first, then the row. An orphaned row is harmless and gets retried on
            // the next sweep; an orphaned FILE is invisible and never reclaimed.
            try {
                fs.unlinkSync(path.join(dir, `${row.id}.${row.extension}`));
            } catch {
                // Already gone, which is the outcome we wanted anyway.
            }
            db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
        }

        if (old.length) {
            ctx.log.info({ evt: 'upload.pruned', count: old.length },
                `Removed ${old.length} upload(s) older than ${days} days`);
        }
    };

    sweep();
    const timer = setInterval(sweep, 6 * 3600_000);
    // Housekeeping must never be the reason the process will not exit.
    timer.unref();
    ctx.onUnload(() => clearInterval(timer));

    ctx.admin.panel({ id: 'uploads', label: 'Uploads', order: 30 });
}
