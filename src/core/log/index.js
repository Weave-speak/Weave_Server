// Logging.
//
// Two audiences, one call site. A self-hoster reading `journalctl` needs prose; a
// maintainer reading a bug report needs structure. So every log line carries BOTH a
// stable `evt` name you can grep for and a `msg` a human can read, and pino fans that
// out to a pretty console stream and a rotating JSON file.
//
// Redaction is layered deliberately. pino's `redact` handles known field paths, the
// serialisers handle known object shapes, and `scrub()` is the last line for free-text
// that might carry a token. Any one of the three alone has been enough to leak in
// other projects; the combination is what makes a diagnostic bundle safe to paste.

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

/**
 * Field paths pino removes wherever they appear. Deliberately broad: it is far cheaper
 * to redact a field nobody was going to log than to discover a token in a bug report.
 */
const REDACT_PATHS = [
    'password', 'newPassword', 'new_password',
    'passwordHash', 'password_hash',
    'recoveryPhrase', 'recovery_phrase', 'secretPhrase', 'secret_phrase',
    'token', 'joinToken', 'join_token', 'sessionToken', 'session_token',
    'setupToken', 'setup_token', 'inviteCode', 'invite_code',
    'authorization', 'cookie', 'setCookie', 'set-cookie',
    'totpSecret', 'totp_secret', 'recoveryCodes',
    '*.password', '*.passwordHash', '*.password_hash',
    '*.token', '*.sessionToken', '*.session_token',
    '*.recoveryPhrase', '*.recovery_phrase', '*.secretPhrase', '*.secret_phrase',
    'req.headers.authorization', 'req.headers.cookie',
];

/** Anything shaped like a credential, wherever it appears in free text. */
const SECRET_SHAPES = [
    /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g,             // GitHub tokens
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g, // JWT / base64 JSON
    /\b[A-Fa-f0-9]{64}\b/g,                          // 32-byte hex — session ids, hashes
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/** Replace credential-shaped substrings in free text. */
export function scrub(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]');
    return out;
}

/**
 * Truncate an address so logs stay useful for diagnosis without being a record of who
 * was where. IPv4 keeps two octets, IPv6 keeps the routing prefix.
 */
export function truncateIp(ip) {
    if (typeof ip !== 'string' || !ip) return null;
    const clean = ip.replace(/^::ffff:/, '');
    if (clean.includes(':')) {
        const parts = clean.split(':').filter(Boolean);
        return `${parts.slice(0, 2).join(':')}::/32`;
    }
    const octets = clean.split('.');
    if (octets.length !== 4) return null;
    return `${octets[0]}.${octets[1]}.x.x`;
}

/**
 * Short, unambiguous, quotable id. Crockford base32 — no I, L, O or U, so nobody
 * misreads it over voice chat, which is the entire point: a user reads this out of
 * their connection panel and a maintainer greps both sides of the logs for it.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newCorrelationId(bytes = crypto.getRandomValues(new Uint8Array(6))) {
    return Array.from(bytes, (b) => CROCKFORD[b % 32]).join('');
}

export function createLogger(cfg) {
    fs.mkdirSync(cfg.logDir, { recursive: true });

    const redactIps = cfg.redactIps !== false;

    const serializers = {
        err: pino.stdSerializers.err,
        ip: (value) => (redactIps ? truncateIp(value) : value),
        // Never let a whole request object through; name the few fields worth having.
        req: (req) => ({
            method: req.method,
            url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
            ip: redactIps ? truncateIp(req.ip) : req.ip,
        }),
    };

    const targets = [
        {
            target: 'pino-pretty',
            level: cfg.logLevel,
            options: {
                colorize: true,
                translateTime: 'yyyy-mm-dd HH:MM:ss',
                ignore: 'pid,hostname',
                // `evt` leads the line so the console reads as a sequence of named events.
                messageFormat: '{evt}  {msg}',
                singleLine: false,
            },
        },
        {
            target: 'pino-roll',
            level: cfg.logLevel,
            options: {
                file: path.join(cfg.logDir, 'weave.log'),
                frequency: 'daily',
                size: '20m',
                // 7 rotated files plus the active one. On a Pi that is a bounded amount
                // of disk, which the previous implementation notably was not.
                limit: { count: 7 },
                mkdir: true,
                dateFormat: 'yyyy-MM-dd',
            },
        },
    ];

    return pino({
        level: cfg.logLevel,
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        serializers,
        base: undefined, // drop pid/hostname; neither helps and hostname identifies a machine
        timestamp: pino.stdTimeFunctions.isoTime,
        transport: { targets },
    });
}

/**
 * A logger that discards everything, for tests and for the CLI paths that must not
 * write to a server's log directory.
 */
export function createNullLogger() {
    return pino({ level: 'silent' });
}
