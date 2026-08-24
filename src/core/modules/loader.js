// The module loader.
//
// Weave's requirement is that every feature can be added or removed at will. That is
// only true if two things hold, and this file is what enforces them:
//
//   1. Everything a module registers is REVOCABLE. A module hands back routes, WS
//      handlers, hooks, settings and admin panels through a scoped context; the loader
//      records each registration and can undo all of them. If any registration were
//      irreversible, "disable" would really mean "restart".
//   2. Nothing reaches around the contract. Modules get a context, not the app. The
//      core never imports a module, and modules never import each other — they talk
//      through hooks and settings only.
//
// Disable is not destroy. Disabling unregisters behaviour and leaves data alone, so a
// module can come back later with its tables intact.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from '../../db/migrate.js';

export class ModuleError extends Error {}

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function validateManifest(manifest, dir) {
    const problems = [];
    if (!ID_RE.test(manifest.id ?? '')) {
        problems.push('id must be lowercase letters, digits and hyphens, 2-32 chars');
    }
    if (!manifest.name) problems.push('name is required');
    if (!manifest.version) problems.push('version is required');
    if (manifest.requires && !Array.isArray(manifest.requires)) {
        problems.push('requires must be an array of module ids');
    }
    if (manifest.features && !(Array.isArray(manifest.features)
        && manifest.features.every((f) => typeof f === 'string'))) {
        problems.push('features must be an array of strings');
    }
    if (problems.length) {
        throw new ModuleError(`Invalid module.json in ${dir}:\n  - ${problems.join('\n  - ')}`);
    }
    return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        requires: manifest.requires ?? [],
        // Capability strings surfaced in /api/server-info while the module is enabled,
        // so a client can ask for a behaviour by name instead of sniffing versions.
        features: manifest.features ?? [],
        defaultEnabled: manifest.defaultEnabled !== false,
        dir,
    };
}

/**
 * Order modules so every dependency loads before its dependents. Throws on a missing
 * dependency or a cycle rather than loading in a broken order and failing later
 * somewhere confusing.
 */
export function resolveOrder(manifests) {
    const byId = new Map(manifests.map((m) => [m.id, m]));
    const state = new Map(); // id -> 'visiting' | 'done'
    const ordered = [];

    const visit = (id, trail) => {
        if (state.get(id) === 'done') return;
        if (state.get(id) === 'visiting') {
            throw new ModuleError(`Circular module dependency: ${[...trail, id].join(' -> ')}`);
        }
        const m = byId.get(id);
        if (!m) {
            throw new ModuleError(
                `Module "${trail.at(-1)}" requires "${id}", which is not installed`,
            );
        }
        state.set(id, 'visiting');
        for (const dep of m.requires) visit(dep, [...trail, id]);
        state.set(id, 'done');
        ordered.push(m);
    };

    for (const m of manifests) visit(m.id, []);
    return ordered;
}

export class ModuleHost {
    #deps;
    #manifests = new Map();
    #active = new Map(); // id -> { manifest, disposers: [] }
    #log;

    constructor(deps) {
        this.#deps = deps;
        this.#log = deps.log.child({ mod: 'loader' });
    }

    /** Read every `module.json` under `dir`. Does not load anything. */
    discover(dir) {
        if (!fs.existsSync(dir)) return [];

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const modDir = path.join(dir, entry.name);
            const manifestPath = path.join(modDir, 'module.json');
            if (!fs.existsSync(manifestPath)) continue;

            let parsed;
            try {
                parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch (err) {
                throw new ModuleError(`Could not parse ${manifestPath}: ${err.message}`);
            }
            const manifest = validateManifest(parsed, modDir);
            if (manifest.id !== entry.name) {
                throw new ModuleError(
                    `Module id "${manifest.id}" does not match its directory "${entry.name}". `
                    + 'They must match so a module can be found by id.',
                );
            }
            this.#manifests.set(manifest.id, manifest);
        }

        this.#log.debug(
            { evt: 'module.discovered', count: this.#manifests.size, ids: [...this.#manifests.keys()] },
            `Discovered ${this.#manifests.size} module(s)`,
        );
        return [...this.#manifests.values()];
    }

    /** Whether a module should be running, given config and stored admin choices. */
    #shouldEnable(manifest) {
        if (this.#deps.config.disabledModules.includes(manifest.id)) return false;
        const stored = this.#deps.settings.get(`module.${manifest.id}.enabled`);
        return stored ?? manifest.defaultEnabled;
    }

    async loadAll() {
        const wanted = [...this.#manifests.values()].filter((m) => this.#shouldEnable(m));

        // A module whose dependency is disabled cannot run either. Say so plainly rather
        // than failing later with a missing hook.
        const wantedIds = new Set(wanted.map((m) => m.id));
        const runnable = wanted.filter((m) => {
            const missing = m.requires.filter((r) => !wantedIds.has(r));
            if (missing.length) {
                this.#log.warn(
                    { evt: 'module.skipped', module: m.id, missing },
                    `Skipping "${m.id}": requires disabled module(s) ${missing.join(', ')}`,
                );
                return false;
            }
            return true;
        });

        for (const manifest of resolveOrder(runnable)) {
            await this.#activate(manifest);
        }
        return this.enabled;
    }

    async #activate(manifest) {
        if (this.#active.has(manifest.id)) return;

        const disposers = [];
        const ctx = this.#buildContext(manifest, disposers);

        const entry = path.join(manifest.dir, 'index.js');
        if (!fs.existsSync(entry)) {
            throw new ModuleError(`Module "${manifest.id}" has no index.js`);
        }

        // Cache-busted so a disable/enable cycle picks up an edited module in dev.
        const mod = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
        if (typeof mod.register !== 'function') {
            throw new ModuleError(`Module "${manifest.id}" must export a register(ctx) function`);
        }

        try {
            await mod.register(ctx);
        } catch (err) {
            // Undo anything that registered before the failure, so a half-loaded module
            // never leaves live routes behind.
            for (const dispose of disposers.reverse()) {
                try { dispose(); } catch { /* best effort during failure cleanup */ }
            }
            throw new ModuleError(`Module "${manifest.id}" failed to register: ${err.message}`, { cause: err });
        }

        this.#active.set(manifest.id, { manifest, disposers });
        this.#log.info(
            { evt: 'module.enabled', module: manifest.id, version: manifest.version },
            `Enabled module ${manifest.id} v${manifest.version}`,
        );
    }

    /**
     * The contract. A module may only touch what this hands it, and every grant records
     * a disposer so the whole registration can be rolled back.
     */
    #buildContext(manifest, disposers) {
        const { id } = manifest;
        const { http, ws, hooks, settings, admin, db, log, peers, config } = this.#deps;
        const track = (dispose) => { disposers.push(dispose); };

        return {
            id,
            manifest,
            log: log.child({ mod: id }),

            http: {
                route: (method, routePath, handler, opts = {}) => {
                    const dispose = http.register(id, method, routePath, handler, opts);
                    track(dispose);
                },
            },

            ws: {
                on: (type, handler) => {
                    const dispose = ws.register(id, type, handler);
                    track(dispose);
                },
                // Namespaced to match, so a hook-driven broadcast looks the same on the
                // wire as one sent from a handler.
                send: (sock, type, payload) => ws.send(sock, `${id}:${type}`, payload),
                broadcast: (type, payload, predicate) => ws.broadcast(`${id}:${type}`, payload, predicate),
            },

            hooks: {
                on: (event, fn) => { track(hooks.on(event, fn, id)); },
                emit: (event, payload) => hooks.emit(event, payload),
            },

            // Namespaced: a module migrates its own tables and cannot touch core's ledger
            // for another namespace.
            db: {
                handle: db,
                migrate: (dir = path.join(manifest.dir, 'migrations')) =>
                    migrate(db, `module:${id}`, dir, log.child({ mod: id })),
            },

            settings: {
                define: (key, schema, fallback) => {
                    const dispose = settings.define(`${id}.${key}`, schema, fallback, id);
                    track(dispose);
                },
                get: (key) => settings.get(`${id}.${key}`),
                set: (key, value) => settings.set(`${id}.${key}`, value),
            },

            admin: {
                panel: (panel) => { track(admin.register(id, panel)); },
            },

            // Read-only view of who is connected and where. Modules need this to scope a
            // broadcast to a channel; they are not handed the registry itself, so they
            // cannot add or evict a peer behind the core's back.
            peers: {
                get: (cid) => peers?.get(cid),
                inChannel: (channelId, exceptCid) => peers?.inChannel(channelId, exceptCid) ?? [],
                forUser: (userId) => peers?.forUser(userId) ?? [],
                get count() { return peers?.count ?? 0; },
            },

            // Actions a module may take on the core's behalf. Deliberately a short,
            // named list rather than handing over the registries: a module can move
            // somebody, but it cannot invent a new way for peers to change channel.
            actions: this.#deps.actions ?? {},

            // Where a module may write. Narrow on purpose: a module gets the paths it
            // could legitimately need, not the whole config, so it cannot quietly come to
            // depend on how the server is exposed or which proxies are trusted.
            paths: {
                data: config.dataDir,
                uploads: config.uploadsDir,
                moduleDir: manifest.dir,
            },

            /**
             * Register arbitrary cleanup — timers, watchers, anything the disposers above
             * do not already cover. Without this a module could not be unloaded without
             * leaving an interval running against a server that has moved on.
             */
            onUnload: (fn) => { track(fn); },
        };
    }

    /** Stop a module: undo every registration, leave its data alone. */
    async disable(id) {
        const active = this.#active.get(id);
        if (!active) return false;

        const dependents = [...this.#active.values()]
            .filter((a) => a.manifest.requires.includes(id))
            .map((a) => a.manifest.id);
        if (dependents.length) {
            throw new ModuleError(
                `Cannot disable "${id}": ${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on it. `
                + 'Disable those first.',
            );
        }

        for (const dispose of active.disposers.reverse()) {
            try {
                dispose();
            } catch (err) {
                this.#log.error({ evt: 'module.dispose_failed', module: id, err },
                    `Cleanup step failed while disabling ${id}`);
            }
        }
        this.#deps.hooks.removeOwner(id);
        this.#active.delete(id);
        this.#deps.settings.set(`module.${id}.enabled`, false);

        this.#log.info({ evt: 'module.disabled', module: id }, `Disabled module ${id}`);
        return true;
    }

    async enable(id) {
        const manifest = this.#manifests.get(id);
        if (!manifest) throw new ModuleError(`No module named "${id}" is installed`);
        if (this.#active.has(id)) return false;

        for (const dep of manifest.requires) {
            if (!this.#active.has(dep)) {
                throw new ModuleError(`Cannot enable "${id}": it requires "${dep}", which is not enabled`);
            }
        }

        this.#deps.settings.set(`module.${id}.enabled`, true);
        await this.#activate(manifest);
        return true;
    }

    get enabled() {
        return [...this.#active.keys()].sort();
    }

    /** The manifest of an ACTIVE module, for feature flags and the admin view. */
    manifestOf(id) {
        return this.#active.get(id)?.manifest ?? null;
    }

    /**
     * Declared settings grouped by owner, with current values. This is what lets the
     * admin console render a module's settings form without the module shipping any UI:
     * it declares a type and a label, and a control appears.
     */
    settingsView() {
        return this.#deps.settings.describe();
    }

    setSetting(key, value) {
        return this.#deps.settings.set(key, value);
    }

    /** Everything installed, enabled or not — drives the admin module manager. */
    get installed() {
        return [...this.#manifests.values()].map((m) => ({
            id: m.id,
            name: m.name,
            version: m.version,
            description: m.description,
            requires: m.requires,
            enabled: this.#active.has(m.id),
        })).sort((a, b) => a.id.localeCompare(b.id));
    }
}
