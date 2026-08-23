// Static file serving for the admin console.
//
// Small and deliberately boring. The one thing that matters is containment: every
// resolved path is checked to be inside the root before anything is read, because a
// traversal here reads the database file that sits next to it.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './server.js';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
};

/**
 * A tight Content-Security-Policy for the console.
 *
 * The admin panel is authenticated with a cookie and can edit the database, so it is
 * exactly the page where an injected script would do the most damage. No inline script,
 * nothing loaded from anywhere else, and no framing.
 */
const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
].join('; ');

export function registerAdminStatic({ router, log }) {
    const root = path.resolve(import.meta.dirname, '..', '..', '..', 'admin');

    const serve = (relative, res) => {
        const file = path.resolve(root, relative);

        // Resolve first, then contain. Checking the raw request string instead would miss
        // encodings, and `..` inside a resolved path is exactly what this must catch.
        if (file !== root && !file.startsWith(root + path.sep)) {
            throw new HttpError(403, 'Forbidden.');
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new HttpError(404, 'Not found.');
        }

        const ext = path.extname(file);
        res.writeHead(200, {
            'Content-Type': TYPES[ext] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': CSP,
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY',
            // Never cached. An admin debugging their own server should not have to guess
            // whether they are looking at a stale console.
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
    };

    if (!fs.existsSync(root)) {
        log.warn({ evt: 'admin.missing', root },
            'The admin console directory is missing; /admin will return 404');
    }

    // The console is a single page with hash routing, so every /admin path that is not a
    // real file serves the shell and lets the page work out what to show.
    for (const pattern of ['/admin', '/admin/setup', '/admin/login']) {
        router.register('core', 'GET', pattern, ({ res }) => serve('index.html', res), { auth: 'none' });
    }

    router.register('core', 'GET', '/admin/:file', ({ params, res }) => {
        serve(params.file, res);
    }, { auth: 'none' });
}
