// `weave doctor` — check a server before blaming it.
//
// The guiding rule is that a check which cannot fail is worse than no check, because it
// teaches people to trust a green tick that means nothing. So every check here can
// genuinely report a problem, and the one thing this cannot honestly determine — whether
// an unsolicited inbound packet would actually arrive — is stated as a limitation rather
// than dressed up as a pass.

import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, EXPOSURE } from '../core/config/index.js';
import { openDatabase, checkIntegrity, migrationStatus } from '../db/index.js';
import { createNullLogger } from '../core/log/index.js';
import { countAdmins } from '../core/users/index.js';
import { discoverMapping } from '../net/stun.js';

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

const check = (level, title, detail, fix) => ({ level, title, detail, fix });

/** Private, loopback and link-local ranges — an announced address in one of these
 *  cannot be reached from the internet. */
function isPrivateAddress(addr) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
    const [a, b] = addr.split('.').map(Number);
    return a === 10
        || a === 127
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 169 && b === 254)
        || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT
}

function canBindTcp(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', (err) => resolve({ ok: false, code: err.code }));
        srv.listen(port, host, () => srv.close(() => resolve({ ok: true })));
    });
}

function canBindUdp(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', (err) => { try { sock.close(); } catch { /* closing */ } resolve({ ok: false, code: err.code }); });
        sock.bind(port, host, () => sock.close(() => resolve({ ok: true })));
    });
}

/** Is something already listening here, and is that something us? */
async function probeHttp(port, host) {
    const target = host === '0.0.0.0' ? '127.0.0.1' : host;
    try {
        const res = await fetch(`http://${target}:${port}/healthz`, {
            signal: AbortSignal.timeout(1500),
        });
        const body = await res.json();
        return { running: true, version: body.version, uptime: body.uptime };
    } catch {
        return { running: false };
    }
}

export async function runDoctor({ env = process.env, stun = false, log = console } = {}) {
    const results = [];
    const add = (r) => { results.push(r); return r; };

    // ── configuration ────────────────────────────────────────────────────────
    let config;
    try {
        config = loadConfig(env);
        add(check(OK, 'Configuration', 'All settings parsed and validated.'));
        for (const warning of config.warnings) add(check(WARN, 'Configuration', warning));
    } catch (err) {
        add(check(FAIL, 'Configuration',
            err instanceof ConfigError ? err.message : String(err),
            'Fix the settings above and run doctor again. Nothing else can be checked until this passes.'));
        return { results, config: null };
    }

    // ── runtime ──────────────────────────────────────────────────────────────
    const major = Number(process.versions.node.split('.')[0]);
    add(major >= 22
        ? check(OK, 'Node runtime', `Node ${process.version}.`)
        : check(FAIL, 'Node runtime', `Node ${process.version} is too old.`,
            'mediasoup and better-sqlite3 both require Node 22 or later. The installer bundles its own runtime; if you are running from source, upgrade Node.'));

    // ── storage ──────────────────────────────────────────────────────────────
    try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        const probe = path.join(config.dataDir, '.doctor-write-test');
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        add(check(OK, 'Data directory', `${config.dataDir} exists and is writable.`));
    } catch (err) {
        add(check(FAIL, 'Data directory', `Cannot write to ${config.dataDir}: ${err.message}`,
            `Create it and give the service account ownership: sudo mkdir -p ${config.dataDir} && sudo chown weave:weave ${config.dataDir}`));
    }

    try {
        const stat = fs.statfsSync?.(config.dataDir);
        if (stat) {
            const freeMb = Math.floor((stat.bavail * stat.bsize) / 1048576);
            add(freeMb < 200
                ? check(WARN, 'Disk space', `Only ${freeMb} MB free where the database lives.`,
                    'Uploads and logs both grow here. Free some space or move WEAVE_DATA_DIR.')
                : check(OK, 'Disk space', `${(freeMb / 1024).toFixed(1)} GB free.`));
        }
    } catch { /* statfs is not available everywhere; not worth failing over */ }

    // ── database ─────────────────────────────────────────────────────────────
    let adminCount = null;
    if (fs.existsSync(config.dbPath)) {
        try {
            const db = openDatabase(config, createNullLogger());
            const integrity = checkIntegrity(db);
            const migrations = migrationStatus(db);
            adminCount = countAdmins(db);
            db.close();

            add(integrity.ok
                ? check(OK, 'Database', `Integrity check passed. Schema: ${migrations.map((m) => `${m.namespace}@${m.version}`).join(', ') || 'none'}.`)
                : check(FAIL, 'Database', `Integrity check failed: ${integrity.detail}`,
                    'Restore the most recent backup from the backups directory.'));

            add(adminCount > 0
                ? check(OK, 'Administrator', `${adminCount} administrator account(s).`)
                : check(WARN, 'Administrator', 'No administrator exists yet.',
                    'Start the server and follow the first-run setup banner it prints.'));
        } catch (err) {
            add(check(FAIL, 'Database', `Could not open ${config.dbPath}: ${err.message}`));
        }
    } else {
        add(check(OK, 'Database', 'No database yet — it will be created on first start.'));
    }

    // ── HTTP port ────────────────────────────────────────────────────────────
    const http = await probeHttp(config.httpPort, config.httpBind);
    if (http.running) {
        add(check(OK, 'HTTP port', `Weave ${http.version} is already serving on ${config.httpBind}:${config.httpPort} (up ${http.uptime}s).`));
    } else {
        const bind = await canBindTcp(config.httpPort, config.httpBind);
        add(bind.ok
            ? check(OK, 'HTTP port', `TCP ${config.httpPort} is free.`)
            : check(FAIL, 'HTTP port', `Cannot bind TCP ${config.httpPort}: ${bind.code}.`,
                bind.code === 'EADDRINUSE'
                    ? 'Something else is using this port, and it is not Weave. Stop it or set WEAVE_HTTP_PORT.'
                    : 'Check the bind address in WEAVE_HTTP_BIND.'));
    }

    // ── media ports ──────────────────────────────────────────────────────────
    // Only meaningful when the server is not running; if it is, it holds these itself.
    if (!http.running) {
        for (const port of config.mediaPorts) {
            const [udp, tcp] = await Promise.all([canBindUdp(port), canBindTcp(port)]);
            if (udp.ok && tcp.ok) {
                add(check(OK, `Media port ${port}`, 'Free on both UDP and TCP.'));
            } else {
                add(check(FAIL, `Media port ${port}`,
                    `UDP ${udp.ok ? 'free' : udp.code}, TCP ${tcp.ok ? 'free' : tcp.code}.`,
                    'Weave needs this port on BOTH protocols. Stop whatever holds it, or set WEAVE_MEDIA_PORT.'));
            }
        }
    } else {
        add(check(OK, 'Media ports', `${config.mediaPorts.join(', ')} — held by the running server.`));
    }

    // ── announced address ────────────────────────────────────────────────────
    // The most consequential setting, so it gets the most attention.
    if (!config.announcedAddress) {
        const guess = Object.values(os.networkInterfaces()).flat()
            .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
        add(check(WARN, 'Announced address', `Not set. The server will guess, probably ${guess[0] ?? '127.0.0.1'}.`,
            'Set WEAVE_ANNOUNCED_ADDRESS to the hostname or IP your users reach you on. Guessing picks the first interface, which on a machine with a VPN is usually the wrong one.'));
    } else {
        let resolved = null;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(config.announcedAddress)) {
            resolved = [config.announcedAddress];
        } else {
            try {
                resolved = await dns.resolve4(config.announcedAddress);
            } catch (err) {
                add(check(FAIL, 'Announced address', `${config.announcedAddress} does not resolve: ${err.code ?? err.message}`,
                    'Clients will be told to send media to a name that does not exist. Fix the DNS record, or use an IP address.'));
            }
        }

        if (resolved?.length) {
            const priv = resolved.filter(isPrivateAddress);
            if (config.exposure === EXPOSURE.PUBLIC && priv.length) {
                add(check(FAIL, 'Announced address',
                    `${config.announcedAddress} resolves to a private address (${priv.join(', ')}) but this server is marked public.`,
                    'Anyone outside your network will connect and hear nothing. Point it at your public address.'));
            } else {
                add(check(OK, 'Announced address', `${config.announcedAddress} → ${resolved.join(', ')}.`));
            }
        }
    }

    // ── the outside view ─────────────────────────────────────────────────────
    if (stun) {
        const port = config.mediaPorts[0];
        const mapping = http.running
            // The server holds the media port, so we cannot bind it. An ephemeral port
            // still reveals the public address; it cannot reveal port preservation.
            ? await discoverMapping({ localPort: 0 })
            : await discoverMapping({ localPort: port });

        if (!mapping.ok) {
            add(check(WARN, 'Outside view', `Could not reach a STUN server: ${mapping.reason}`,
                'Outbound UDP may be blocked here. This check is optional; the rest still stands.'));
        } else {
            add(check(OK, 'Outside view', `The internet sees this machine as ${mapping.address}:${mapping.port} (via ${mapping.via}).`));

            if (config.announcedAddress && !isPrivateAddress(config.announcedAddress)) {
                try {
                    const announced = /^\d+\.\d+\.\d+\.\d+$/.test(config.announcedAddress)
                        ? [config.announcedAddress]
                        : await dns.resolve4(config.announcedAddress);
                    add(announced.includes(mapping.address)
                        ? check(OK, 'Announced address matches', `${config.announcedAddress} matches what the internet sees.`)
                        : check(FAIL, 'Announced address mismatch',
                            `You announce ${config.announcedAddress} (${announced.join(', ')}) but the internet sees ${mapping.address}.`,
                            'Clients will send media to the wrong place. If your IP is dynamic, use a dynamic-DNS hostname and keep it updated.'));
                } catch { /* the resolve failure was already reported above */ }
            }

            if (!http.running && mapping.localPort === port && mapping.port !== port) {
                add(check(WARN, 'Port remapping',
                    `Your router mapped local port ${port} to public port ${mapping.port}.`,
                    `Weave announces ${port}, so clients would send to the wrong port. Configure a 1:1 port forward rather than a remapping one.`));
            }
        }
    }

    // ── exposure ─────────────────────────────────────────────────────────────
    if (config.exposure === EXPOSURE.PUBLIC && !config.behindTls) {
        add(check(FAIL, 'TLS', 'Marked public but not behind TLS.',
            'Session cookies cannot be marked Secure, so credentials would travel in clear text.'));
    } else if (config.behindTls && config.trustedProxies.length === 0) {
        add(check(WARN, 'Trusted proxies', 'Running behind a proxy with WEAVE_TRUSTED_PROXIES empty.',
            'Forwarded IP headers are ignored, so every client looks like the proxy to rate limiting. Set it to your proxy address.'));
    } else {
        add(check(OK, 'Exposure', `${config.exposure}${config.behindTls ? ', behind TLS' : ''}.`));
    }

    return { results, config, serverRunning: http.running };
}

/** Render a report. Returns the process exit code. */
export function printReport({ results, config, serverRunning }, { stun = false } = {}) {
    const glyph = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
    const colour = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' };
    const reset = '\x1b[0m';
    const tty = process.stdout.isTTY;
    const paint = (level, text) => (tty ? `${colour[level]}${text}${reset}` : text);

    process.stdout.write('\nWeave doctor\n════════════\n\n');

    for (const r of results) {
        process.stdout.write(`[${paint(r.level, glyph[r.level])}] ${r.title}\n`);
        process.stdout.write(`         ${r.detail}\n`);
        if (r.fix && r.level !== OK) process.stdout.write(`         → ${r.fix}\n`);
        process.stdout.write('\n');
    }

    const fails = results.filter((r) => r.level === FAIL).length;
    const warns = results.filter((r) => r.level === WARN).length;

    // Said plainly, every time. A server cannot test its own inbound path, and implying
    // otherwise is how people end up trusting a green report and a silent call.
    process.stdout.write('What this cannot tell you\n─────────────────────────\n');
    process.stdout.write(
        '  Whether an unsolicited inbound packet actually reaches this machine. That depends\n'
        + '  on your router, and nothing running inside your network can answer it honestly.\n'
        + `  To find out, enable the dev-smoke module and open it from OUTSIDE this network\n`
        + '  — a phone on mobile data is the easiest way — then check that audio flows.\n',
    );
    if (!stun) {
        process.stdout.write('\n  Re-run with --stun to also check how the internet sees this machine.\n');
    }
    process.stdout.write('\n');

    if (fails) {
        process.stdout.write(paint('fail', `${fails} problem(s) must be fixed before this server will work.\n\n`));
        return 1;
    }
    if (warns) {
        process.stdout.write(paint('warn', `${warns} thing(s) worth attention, but nothing blocking.\n\n`));
        return 0;
    }
    process.stdout.write(paint('ok', 'Everything checked out.\n\n'));
    return 0;
}
