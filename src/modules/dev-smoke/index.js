// Developer smoke test.
//
// A bare page that logs in, joins a channel, sends a microphone and plays back everyone
// else. It exists to answer one question that nothing else can answer — does audio
// actually flow end to end through this deployment — and it is the thing you open after
// installing on a new box to prove the media port is genuinely reachable.
//
// It is NOT the Weave client and must not grow into one. It ships disabled: a page that
// serves an unauthenticated login form is not something a production server should
// expose by default, and it is the first module precisely because "off unless you turn
// it on" is the property worth proving.

import fs from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = path.join(import.meta.dirname, 'public');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

export function register(ctx) {
    ctx.log.warn(
        { evt: 'devsmoke.enabled' },
        'Developer smoke test is enabled at /dev/smoke — turn it off on a production server',
    );

    const serve = (relative) => ({ res, log }) => {
        // Resolve then contain: a request path never reaches this, but the guard is what
        // keeps that true if someone later makes the filename dynamic.
        const file = path.resolve(PUBLIC_DIR, relative);
        if (!file.startsWith(PUBLIC_DIR + path.sep)) {
            res.writeHead(403).end('Forbidden');
            return;
        }
        if (!fs.existsSync(file)) {
            log.error({ evt: 'devsmoke.missing', file },
                'Smoke asset missing — run `npm run build:smoke`');
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end('Smoke assets are not built. Run: npm run build:smoke');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            // Never cached: this is a diagnostic, and a stale copy while debugging a
            // deployment would waste more time than it saves.
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
    };

    ctx.http.route('GET', '/dev/smoke', serve('smoke.html'), { auth: 'none' });
    ctx.http.route('GET', '/dev/mediasoup-client.js', serve('mediasoup-client.js'), { auth: 'none' });

    ctx.admin.panel({ id: 'smoke', label: 'Smoke test', order: 900 });
}
