// Configuration is a declared schema, not a scattering of process.env reads.
//
// Every setting is defined once, with its parser, default, documentation and an
// optional check. That single definition drives four things: the parsed config
// object, `weave doctor`, the admin UI's read-only environment view, and the
// generated .env.example. When those drift apart people misconfigure servers, so
// they are not allowed to drift apart.

import path from 'node:path';

export class ConfigError extends Error {}

const asInt = (raw, key) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new ConfigError(`${key} must be a whole number, got "${raw}"`);
    return n;
};

const asBool = (raw, key) => {
    const v = String(raw).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    throw new ConfigError(`${key} must be true or false, got "${raw}"`);
};

const asList = (raw) => String(raw).split(',').map((s) => s.trim()).filter(Boolean);

const asPort = (raw, key) => {
    const n = asInt(raw, key);
    if (n < 1 || n > 65535) throw new ConfigError(`${key} must be between 1 and 65535, got ${n}`);
    if (n < 1024) throw new ConfigError(`${key} is ${n}; ports below 1024 need root, which Weave does not run as`);
    return n;
};

/**
 * Exposure posture. This is the single most consequential setting, because it decides
 * whether session cookies get the Secure flag. Guessing it produces either a server
 * nobody can reach or one that ships credentials in clear text, so setup asks outright.
 */
export const EXPOSURE = Object.freeze({
    LOOPBACK: 'loopback', // reachable only from the machine itself
    LAN: 'lan',           // reachable on a trusted local network, likely plain HTTP
    PUBLIC: 'public',     // reachable from the internet, must be behind TLS
});

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

export const SCHEMA = [
    {
        key: 'WEAVE_HTTP_PORT', name: 'httpPort', parse: asPort, default: 3000,
        doc: 'TCP port for HTTP and the signalling WebSocket. Put TLS in front of it for public servers.',
    },
    {
        key: 'WEAVE_HTTP_BIND', name: 'httpBind', parse: String, default: '0.0.0.0',
        doc: 'Address to bind HTTP to. Use 127.0.0.1 when a reverse proxy on the same host is the only client.',
    },
    {
        key: 'WEAVE_MEDIA_PORT', name: 'mediaPort', parse: asPort, default: 44444,
        doc: 'First port carrying WebRTC media, on UDP and TCP. Forward BOTH protocols from your router. This does NOT go through your reverse proxy. With the default single worker this is the only media port you need.',
    },
    {
        key: 'WEAVE_ANNOUNCED_ADDRESS', name: 'announcedAddress', parse: String, default: null,
        doc: 'Public hostname or IP clients should send media to. Unset means auto-detect at boot. Getting this wrong is the most common cause of "connected but silent".',
    },
    {
        key: 'WEAVE_LOCAL_ANNOUNCED_ADDRESS', name: 'localAnnouncedAddress', parse: String, default: null,
        doc: 'Optional second media address for clients on the same LAN, for routers that cannot hairpin.',
    },
    {
        key: 'WEAVE_EXPOSURE', name: 'exposure', parse: String, default: EXPOSURE.LOOPBACK,
        doc: `How this server is reachable: ${Object.values(EXPOSURE).join(', ')}. Decides cookie security policy.`,
        check: (v) => Object.values(EXPOSURE).includes(v) || `must be one of ${Object.values(EXPOSURE).join(', ')}`,
    },
    {
        key: 'WEAVE_BEHIND_TLS', name: 'behindTls', parse: asBool, default: null,
        doc: 'Set true when a reverse proxy terminates HTTPS in front of Weave. Defaults to true for public exposure.',
    },
    {
        key: 'WEAVE_TRUSTED_PROXIES', name: 'trustedProxies', parse: asList, default: [],
        doc: 'Proxy addresses whose forwarded-IP headers may be believed. Empty means trust none, because a header trusted unconditionally lets any client forge its address and defeat every per-IP rate limit.',
    },
    {
        key: 'WEAVE_DATA_DIR', name: 'dataDir', parse: String, default: './data',
        doc: 'Database, uploads and backups live here. Back this directory up.',
    },
    {
        key: 'WEAVE_LOG_DIR', name: 'logDir', parse: String, default: './logs',
        doc: 'Rotated log files. Also written to stdout for journald.',
    },
    {
        key: 'WEAVE_LOG_LEVEL', name: 'logLevel', parse: String, default: 'info',
        doc: `One of: ${LOG_LEVELS.join(', ')}.`,
        check: (v) => LOG_LEVELS.includes(v) || `must be one of ${LOG_LEVELS.join(', ')}`,
    },
    {
        key: 'WEAVE_LOG_REDACT_IPS', name: 'redactIps', parse: asBool, default: true,
        doc: 'Truncate IP addresses in logs and diagnostic bundles. On by default; turn off only while debugging.',
    },
    {
        key: 'WEAVE_SFU_WORKERS', name: 'sfuWorkers', parse: asInt, default: 1,
        doc: 'Number of mediasoup workers. Each is one CPU core of media capacity AND one extra media port (WEAVE_MEDIA_PORT + index), which you must also forward. Raise this only when one core is genuinely the bottleneck.',
        check: (v) => (v > 0 && v <= 32) || 'must be between 1 and 32',
    },
    {
        key: 'WEAVE_SFU_LOG_LEVEL', name: 'sfuLogLevel', parse: String, default: 'warn',
        doc: 'Log level for the mediasoup workers, separately from the rest of the server. The media subsystem is far chattier; raise this to debug only while diagnosing a quality problem, and the bandwidth-estimate and stream-score lines become visible.',
        check: (v) => ['debug', 'warn', 'error', 'none'].includes(v) || 'must be one of debug, warn, error, none',
    },
    {
        key: 'WEAVE_OPUS_BITRATE', name: 'opusBitrate', parse: asInt, default: null,
        doc: 'Target bitrate for each voice stream, in bits per second. UNSET by default, which lets the browser choose — around 32000 mono. Setting 64000 matches the Discord default channel and is audibly clearer; 96000-128000 is better again on a good uplink. It is declared in the router codec parameters, so it reaches every client encoder including ones too old to ask. Change it, restart, and listen: it needs no rebuild and no client update.',
        check: (v) => v === null || (v >= 8000 && v <= 512000) || 'must be between 8000 and 512000',
    },
    {
        key: 'WEAVE_MAX_INCOMING_BITRATE', name: 'maxIncomingBitrate', parse: asInt, default: 8000000,
        doc: 'Ceiling on what ONE participant may send this server, in bits per second, across all their streams at once. Lower it if your upload is thin: a screen share capped below its preset is better than one that saturates the link and takes the voice with it.',
        check: (v) => (v >= 100000 && v <= 100000000) || 'must be between 100000 and 100000000',
    },
    {
        key: 'WEAVE_MAX_OUTGOING_BITRATE', name: 'maxOutgoingBitrate', parse: asInt, default: null,
        doc: 'Optional ceiling on what this server sends to any one participant, in bits per second. Unset means let congestion control decide per path, which is right unless your total upload — rather than any single path — is the constraint.',
    },
    {
        key: 'WEAVE_DISABLED_MODULES', name: 'disabledModules', parse: asList, default: [],
        doc: 'Module ids to leave unloaded at boot, comma separated. The admin panel is the normal way to do this.',
    },
    {
        key: 'WEAVE_INSTANCE_NAME', name: 'instanceName', parse: String, default: 'Weave',
        doc: 'Display name shown to clients before they log in.',
    },
];

export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
    const cfg = {};
    const problems = [];

    for (const item of SCHEMA) {
        const raw = env[item.key];
        if (raw === undefined || raw === '') {
            cfg[item.name] = typeof item.default === 'function' ? item.default() : item.default;
            continue;
        }
        try {
            const value = item.parse(raw, item.key);
            const verdict = item.check ? item.check(value) : true;
            if (verdict !== true) problems.push(`${item.key}: ${verdict}`);
            cfg[item.name] = value;
        } catch (err) {
            problems.push(err instanceof ConfigError ? err.message : `${item.key}: ${err.message}`);
        }
    }

    if (problems.length) {
        throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    }

    // Derived values.
    cfg.behindTls ??= cfg.exposure === EXPOSURE.PUBLIC;
    cfg.dataDir = path.resolve(cwd, cfg.dataDir);
    cfg.logDir = path.resolve(cwd, cfg.logDir);
    cfg.dbPath = path.join(cfg.dataDir, 'weave.db');
    cfg.uploadsDir = path.join(cfg.dataDir, 'uploads');
    // Deliberately NOT inside uploadsDir. The uploads module sweeps that directory on a
    // retention timer — 30 days by default — so an avatar kept there would quietly stop
    // existing after a month, and the only symptom would be everybody's picture turning
    // back into initials. A profile picture is identity, not an attachment.
    cfg.avatarsDir = path.join(cfg.dataDir, 'avatars');
    cfg.backupsDir = path.join(cfg.dataDir, 'backups');
    cfg.warnings = [];
    // Derived so the installer, `weave doctor` and the admin UI can all state exactly
    // which ports must be forwarded without recomputing the rule.
    cfg.mediaPorts = Array.from({ length: cfg.sfuWorkers }, (_, i) => cfg.mediaPort + i);

    // A public server without TLS would set session cookies without Secure, i.e. ship
    // credentials in clear text across the internet. Refuse to start rather than warn.
    if (cfg.exposure === EXPOSURE.PUBLIC && !cfg.behindTls) {
        throw new ConfigError(
            'WEAVE_EXPOSURE=public requires TLS. Put a reverse proxy in front and set '
            + 'WEAVE_BEHIND_TLS=true, or use WEAVE_EXPOSURE=lan if this really is a trusted network.',
        );
    }

    if (cfg.behindTls && cfg.trustedProxies.length === 0) {
        cfg.warnings.push(
            'WEAVE_TRUSTED_PROXIES is empty while running behind a proxy, so forwarded IP headers '
            + 'are ignored and every client will look like the proxy to rate limiting.',
        );
    }

    return Object.freeze(cfg);
}

/** Drives `weave doctor` and the generated .env.example, so docs cannot drift from code. */
export function describeConfig() {
    return SCHEMA.map(({ key, doc, default: def }) => ({
        key,
        doc,
        default: typeof def === 'function' ? '(detected)' : def,
    }));
}
