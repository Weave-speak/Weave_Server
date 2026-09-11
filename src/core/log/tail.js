// Reading the end of the log.
//
// Two callers want this: the administration console's log view, and a bug report, which
// attaches what the server was doing at the moment somebody said it went wrong. They want
// the same thing, so they read it the same way rather than each growing their own version.
//
// The window matters. The previous server loaded a 5 MB log into memory to take a 256 KB
// tail, every time somebody opened the log view — on a Pi, with the media worker on the
// same chip. This seeks to the end instead and reads only what it needs.

import fs from 'node:fs';
import path from 'node:path';

/** As much of the end of the file as is ever worth reading in one go. */
const WINDOW_BYTES = 512 * 1024;

/** The rolled files, newest first. pino-roll appends a date and an index to the base name. */
export function logFiles(logDir) {
    if (!logDir || !fs.existsSync(logDir)) return [];
    return fs.readdirSync(logDir).filter((f) => f.startsWith('weave.log')).sort().reverse();
}

/**
 * The last `lines` log entries, parsed where they are JSON.
 *
 * @returns {{entries: object[], file: string|null, truncated: boolean}}
 */
export function tailLog(logDir, lines = 300) {
    const wanted = Math.min(2000, Math.max(1, Number(lines) || 300));
    const files = logFiles(logDir);
    if (!files.length) return { entries: [], file: null, truncated: false };

    const file = path.join(logDir, files[0]);
    const { size } = fs.statSync(file);
    const window = Math.min(size, WINDOW_BYTES);
    const buffer = Buffer.alloc(window);

    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, window, size - window);
    } finally {
        fs.closeSync(fd);
    }

    const entries = buffer.toString('utf8')
        .split('\n')
        // A partial first line is expected when reading from an offset.
        .slice(1)
        .filter(Boolean)
        .slice(-wanted)
        .map((line) => { try { return JSON.parse(line); } catch { return { msg: line }; } });

    return { entries, file: files[0], truncated: size > window };
}
