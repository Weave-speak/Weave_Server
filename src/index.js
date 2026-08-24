// Boot.
//
// Order matters and is deliberate: config must be valid before we log, the database
// must be migrated before anything reads it, and the core must be fully wired before a
// single module loads — because a module registers against the core's registries and
// must never find a half-built one.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from './core/config/index.js';
import { createLogger } from './core/log/index.js';
import { openDatabase, migrateCore, migrationStatus } from './db/index.js';
import { Settings } from './core/settings/index.js';
import { HookBus, HOOKS } from './core/hooks/index.js';
import { Router } from './core/http/router.js';
import { createHttpServer } from './core/http/server.js';
import { WsRegistry } from './core/ws/registry.js';
import { createWsServer } from './core/ws/server.js';
import { AdminRegistry } from './core/admin/registry.js';
import { ModuleHost } from './core/modules/loader.js';
import { createAuth, purgeExpiredSessions } from './core/auth/index.js';
import { SetupState } from './core/setup/index.js';
import { ensureDefaults, listChannels, visibleChannels } from './core/channels/index.js';
import { registerCoreRoutes } from './core/http/routes/index.js';
import { createSfu } from './core/sfu/index.js';
import { PeerRegistry } from './core/peers/index.js';
import { registerCoreWsHandlers } from './core/ws/handlers/core.js';
import { movePeer } from './core/peers/move.js';
import { getChannel } from './core/channels/index.js';
import { PROTOCOL, CORE_FEATURES } from './protocol/index.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export async function start(env = process.env) {
    // ── Config ───────────────────────────────────────────────────────────────
    let config;
    try {
        config = loadConfig(env);
    } catch (err) {
        if (err instanceof ConfigError) {
            // Before the logger exists, so this goes straight to stderr. A config error
            // must be readable by someone who has just run the installer.
            process.stderr.write(`\n${err.message}\n\nRun \`weave doctor\` for the full list of settings.\n\n`);
            process.exit(78); // EX_CONFIG
        }
        throw err;
    }

    const log = createLogger(config);
    for (const warning of config.warnings) log.warn({ evt: 'config.warning' }, warning);

    log.info(
        { evt: 'server.starting', version: pkg.version, node: process.version, exposure: config.exposure },
        `Weave ${pkg.version} starting on Node ${process.version}`,
    );

    // ── Storage ──────────────────────────────────────────────────────────────
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = openDatabase(config, log);
    migrateCore(db, log);
    purgeExpiredSessions(db);
    ensureDefaults(db, log);

    // ── Core services ────────────────────────────────────────────────────────
    const settings = new Settings(db, log);
    const hooks = new HookBus(log);
    const router = new Router(log);
    const wsRegistry = new WsRegistry(log);
    const admin = new AdminRegistry();
    const auth = createAuth({ db, config, log });
    const setup = new SetupState({ db, config, log });

    // ── Media ────────────────────────────────────────────────────────────────
    const sfu = await createSfu({ config, log, hooks });
    const peers = new PeerRegistry(log);

    const ws = createWsServer({
        registry: wsRegistry,
        log,
        config,
        onDisconnect: (sock) => {
            const peer = peers.remove(sock.cid);
            if (!peer) return;
            // Closing the transports above stops the media; this tells EVERYONE — every
            // sidebar shows every room, and a roomless reader going offline has to
            // disappear from the members list too, which a room-scoped frame never did.
            ws.broadcast('peer_left', { cid: peer.cid, userId: peer.userId },
                (other) => Boolean(peers.get(other.cid)));
            hooks.emit(HOOKS.PEER_LEAVE, { peer });
        },
    });

    // Small shims so the module context can grant HTTP/WS registration without handing
    // a module the registry itself.
    const httpFacade = { register: (...args) => router.register(...args) };
    const wsFacade = {
        register: (...args) => wsRegistry.register(...args),
        send: ws.send,
        broadcast: ws.broadcast,
    };

    // ── Core routes ──────────────────────────────────────────────────────────
    // Registered under the 'core' owner, which is never disabled.

    // Unauthenticated by design: a client must be able to discover what this server is
    // and whether it can talk to it BEFORE it commits to logging in.
    router.register('core', 'GET', '/api/server-info', ({ json }) => {
        json(200, {
            product: 'weave',
            version: pkg.version,
            protocol: { min: PROTOCOL.MIN, max: PROTOCOL.MAX },
            instance: { name: config.instanceName, registration: 'invite_only' },
            features: [
                ...CORE_FEATURES,
                ...moduleHost.enabled.map((id) => `module.${id}`),
                // A module may announce finer-grained capabilities, so a client can ask
                // "does this server broadcast chat anywhere" instead of guessing from
                // version numbers.
                ...moduleHost.enabled.flatMap((id) => moduleHost.manifestOf?.(id)?.features ?? []),
            ],
            setupRequired: countAdmins() === 0,
        });
    }, { auth: 'none' });

    router.register('core', 'GET', '/healthz', ({ json }) => {
        json(200, { ok: true, version: pkg.version, uptime: Math.floor(process.uptime()) });
    }, { auth: 'none' });

    // ── Modules ──────────────────────────────────────────────────────────────
    const moduleActions = {
        /** Move a peer, using the same path as a self-initiated or admin move. */
        movePeer(cid, channelId, reason = 'module') {
            const peer = peers.get(cid);
            const channel = getChannel(db, channelId);
            if (!peer || !channel) return false;
            return movePeer({ db, peer, channel, peers, sfu, ws, hooks, reason }).moved;
        },
        listChannels: () => listChannels(db),
        /** Re-send every connected client ITS view of the channel list. */
        announceChannels() {
            for (const peer of peers.all) {
                ws.send(peer.ws, 'channels', { channels: visibleChannels(db, peer.userId) });
            }
        },
    };

    const moduleHost = new ModuleHost({
        config, log, db, settings, hooks, admin, peers, actions: moduleActions,
        http: httpFacade,
        ws: wsFacade,
    });

    registerCoreRoutes({ router, db, config, log, auth, setup, hooks, moduleHost, sfu, peers, settings, ws: wsFacade });
    registerCoreWsHandlers({ registry: wsRegistry, peers, sfu, db, auth, log, hooks, ws });

    moduleHost.discover(path.join(import.meta.dirname, 'modules'));
    await moduleHost.loadAll();

    function countAdmins() {
        return db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_disabled = 0').get().n;
    }

    // ── Listen ───────────────────────────────────────────────────────────────
    const server = createHttpServer({
        config, log, router, auth,
        onUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head),
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.httpPort, config.httpBind, resolve);
    });

    log.info(
        {
            evt: 'server.ready',
            port: config.httpPort,
            bind: config.httpBind,
            modules: moduleHost.enabled,
            routes: router.routes.length,
            mediaPorts: sfu.ports,
            announcedAddress: sfu.announcedAddress,
        },
        `Listening on ${config.httpBind}:${config.httpPort} with ${moduleHost.enabled.length} module(s); `
        + `media on ${sfu.announcedAddress} UDP+TCP ${sfu.ports.join(', ')}`,
    );

    // Prints the setup banner if this server has no administrator yet.
    setup.begin({
        httpPort: config.httpPort,
        httpBind: config.httpBind,
        instanceName: config.instanceName,
        version: pkg.version,
        quiet: config.logLevel === 'silent',
    });

    hooks.emit(HOOKS.SERVER_READY, { config, version: pkg.version });

    // ── Shutdown ─────────────────────────────────────────────────────────────
    let stopping = false;
    async function stop(signal) {
        if (stopping) return;
        stopping = true;
        log.info({ evt: 'server.stopping', signal }, `Shutting down (${signal})`);

        hooks.emit(HOOKS.SERVER_STOPPING, {});
        await ws.close();
        await sfu.close();
        await new Promise((resolve) => server.close(resolve));
        // WAL means an unclean exit is survivable, but closing properly checkpoints it.
        db.close();

        log.info({ evt: 'server.stopped' }, 'Stopped cleanly');
        // Last, and after the final line: closing the transport ends logging entirely.
        await log.closeTransport?.();
    }

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            stop(signal).then(
                () => {
                    // Deliberately NOT process.exit(). pino writes through a worker
                    // thread, and exiting explicitly kills it mid-flush — which silently
                    // discards the shutdown log lines, i.e. precisely the ones you need
                    // when a service failed to stop cleanly. Everything above has been
                    // closed, so the event loop drains and Node exits on its own once
                    // the transport has written.
                    //
                    // The watchdog is unref'd: it cannot hold the process open by
                    // itself, but it still fires if something else is stuck, so a hung
                    // handle turns into a bounded shutdown instead of a hang.
                    setTimeout(() => {
                        log.error({ evt: 'server.stop_timeout' }, 'Shutdown did not complete in 5s; forcing exit');
                        process.exit(1);
                    }, 5000).unref();
                },
                (err) => {
                    log.error({ evt: 'server.stop_failed', err }, 'Shutdown failed');
                    process.exitCode = 1;
                },
            );
        });
    }

    // The old server had neither of these, so an unexpected throw took the process down
    // with no record of why.
    process.on('unhandledRejection', (err) => {
        log.error({ evt: 'process.unhandled_rejection', err }, 'Unhandled promise rejection');
    });
    process.on('uncaughtException', (err) => {
        log.fatal({ evt: 'process.uncaught_exception', err }, 'Uncaught exception — exiting');
        // Here we do want out, but flush first: a crash whose explanation was dropped on
        // the way to disk is a crash you get to debug twice.
        log.flush?.();
        stop('uncaughtException').finally(() => {
            setTimeout(() => process.exit(1), 1000).unref();
            process.exitCode = 1;
        });
    });

    return {
        config, log, db, settings, hooks, router, wsRegistry, admin, moduleHost, auth, setup,
        sfu, peers, server, ws,
        migrations: migrationStatus(db),
        stop,
    };
}

/**
 * Is this file the program's entry point?
 *
 * Only auto-start when run directly, so tests can import and drive this. Both halves of
 * the comparison are load-bearing, and both have already been wrong once.
 *
 * `pathToFileURL`, because hand-building "file://" + a path gets the slash count wrong on
 * Windows — file://D:/x rather than file:///D:/x — and the guard silently never fires.
 *
  * `fs.realpathSync`, because the installed layout puts the code behind a symlink:
 * /opt/weave/current -> releases/<version>, so that an upgrade is a symlink flip and a
 * rollback is one flip back. Node resolves symlinks for `import.meta.url` but leaves
 * `process.argv[1]` exactly as written, so the two disagree, the process starts, does
 * nothing, and exits 0. systemd reports that as "Deactivated successfully".
 */
function isEntryPoint() {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
    } catch {
        // A path that cannot be resolved is not one we were started from.
        return false;
    }
}

if (isEntryPoint()) {
    start().catch((err) => {
        process.stderr.write(`Failed to start: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
