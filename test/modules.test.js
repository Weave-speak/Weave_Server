// The module loader is the load-bearing piece of Weave's "add and remove features at
// will" requirement, so these tests assert the property that makes it real: after a
// module is disabled, NOTHING it registered is still live. A loader that only stops
// calling a module, while leaving its routes and hooks in place, would pass a naive
// test and fail the actual requirement.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { ModuleHost, resolveOrder, ModuleError } from '../src/core/modules/loader.js';
import { HookBus, HOOKS } from '../src/core/hooks/index.js';
import { Router } from '../src/core/http/router.js';
import { WsRegistry } from '../src/core/ws/registry.js';
import { AdminRegistry } from '../src/core/admin/registry.js';
import { Settings } from '../src/core/settings/index.js';
import { createNullLogger } from '../src/core/log/index.js';

/** Write a throwaway module tree so tests exercise real discovery, not a mock. */
function writeModule(root, id, { requires = [], defaultEnabled = true, body } = {}) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({
        id, name: `Test ${id}`, version: '1.0.0', requires, defaultEnabled,
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), body ?? `
        export function register(ctx) {
            ctx.http.route('GET', '/api/${id}/ping', ({ json }) => json(200, { ok: '${id}' }));
            ctx.ws.on('ping', () => {});
            ctx.hooks.on('${HOOKS.PEER_JOIN}', () => {});
            ctx.admin.panel({ id: 'main', label: '${id}' });
            ctx.settings.define('enabled', { type: 'boolean', label: 'On' }, true);
        }
    `);
    return dir;
}

function harness() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-mod-'));
    // Fixture modules live outside the repo, so they do not inherit its "type": "module".
    // Without this Node reparses each one as ESM and warns, which would bury real CI output.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
    const db = new Database(path.join(tmp, 'test.db'));
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

    const log = createNullLogger();
    const router = new Router(log);
    const wsRegistry = new WsRegistry(log);
    const hooks = new HookBus(log);
    const admin = new AdminRegistry();
    const settings = new Settings(db, log);

    const host = new ModuleHost({
        config: { disabledModules: [] },
        log, db, settings, hooks, admin,
        http: { register: (...a) => router.register(...a) },
        ws: { register: (...a) => wsRegistry.register(...a), send() {}, broadcast() {} },
    });

    return { tmp, db, host, router, wsRegistry, hooks, admin, settings,
        cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('loads a discovered module and registers everything it declares', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'alpha');

    h.host.discover(modDir);
    await h.host.loadAll();

    assert.deepEqual(h.host.enabled, ['alpha']);
    assert.ok(h.router.match('GET', '/api/alpha/ping'), 'route should be live');
    // Module WS types are namespaced so two modules can never collide on a name.
    assert.ok(h.wsRegistry.get('alpha:ping'), 'ws type should be namespaced and live');
    assert.equal(h.admin.panels.length, 1);
});

test('disabling a module removes every trace of it', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'alpha');
    h.host.discover(modDir);
    await h.host.loadAll();

    await h.host.disable('alpha');

    // This is the requirement, stated four ways.
    assert.deepEqual(h.host.enabled, [], 'no longer enabled');
    assert.equal(h.router.match('GET', '/api/alpha/ping'), null, 'route unregistered');
    assert.equal(h.wsRegistry.get('alpha:ping'), undefined, 'ws handler unregistered');
    assert.equal(h.admin.panels.length, 0, 'admin panel gone');
    assert.equal(h.hooks.describe().length, 0, 'hook listener gone');
});

test('a disabled module can be re-enabled and works again', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'alpha');
    h.host.discover(modDir);
    await h.host.loadAll();

    await h.host.disable('alpha');
    await h.host.enable('alpha');

    assert.deepEqual(h.host.enabled, ['alpha']);
    assert.ok(h.router.match('GET', '/api/alpha/ping'), 'route live again');
});

test('disable choice survives a restart', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'alpha');
    h.host.discover(modDir);
    await h.host.loadAll();
    await h.host.disable('alpha');

    // Second host over the same settings store, as a restart would be.
    const router2 = new Router(createNullLogger());
    const host2 = new ModuleHost({
        config: { disabledModules: [] },
        log: createNullLogger(),
        db: h.db, settings: h.settings, hooks: new HookBus(), admin: new AdminRegistry(),
        http: { register: (...a) => router2.register(...a) },
        ws: { register: () => () => {}, send() {}, broadcast() {} },
    });
    host2.discover(modDir);
    await host2.loadAll();

    assert.deepEqual(host2.enabled, [], 'stayed disabled across restart');
});

test('a failed register rolls back its partial registrations', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'broken', {
        body: `
            export function register(ctx) {
                ctx.http.route('GET', '/api/broken/ping', () => {});
                throw new Error('deliberate failure after registering');
            }
        `,
    });
    h.host.discover(modDir);

    await assert.rejects(() => h.host.loadAll(), ModuleError);
    // A half-loaded module must not leave a live route behind pointing at dead code.
    assert.equal(h.router.match('GET', '/api/broken/ping'), null, 'partial route rolled back');
    assert.deepEqual(h.host.enabled, []);
});

test('dependencies load before dependents', () => {
    const order = resolveOrder([
        { id: 'c', requires: ['b'] },
        { id: 'a', requires: [] },
        { id: 'b', requires: ['a'] },
    ]).map((m) => m.id);
    assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a dependency cycle is refused rather than loaded in a broken order', () => {
    assert.throws(() => resolveOrder([
        { id: 'a', requires: ['b'] },
        { id: 'b', requires: ['a'] },
    ]), /Circular module dependency/);
});

test('a missing dependency names both modules', () => {
    assert.throws(
        () => resolveOrder([{ id: 'a', requires: ['ghost'] }]),
        /requires "ghost"/,
    );
});

test('a module cannot be disabled while another depends on it', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'base');
    writeModule(modDir, 'dependent', { requires: ['base'] });
    h.host.discover(modDir);
    await h.host.loadAll();

    await assert.rejects(() => h.host.disable('base'), /depends on it/);
    assert.ok(h.host.enabled.includes('base'), 'still enabled after refused disable');
});

test('a module whose dependency is disabled is skipped, not crashed on', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'base', { defaultEnabled: false });
    writeModule(modDir, 'dependent', { requires: ['base'] });
    h.host.discover(modDir);
    await h.host.loadAll();

    assert.deepEqual(h.host.enabled, [], 'neither loaded, and no throw');
});

test('a throwing hook handler cannot break the core', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    writeModule(modDir, 'rude', {
        body: `
            export function register(ctx) {
                ctx.hooks.on('${HOOKS.PEER_JOIN}', () => { throw new Error('module misbehaves'); });
            }
        `,
    });
    h.host.discover(modDir);
    await h.host.loadAll();

    let coreRan = false;
    h.hooks.on(HOOKS.PEER_JOIN, () => { coreRan = true; });

    // One badly-behaved module must not be able to break a join for everyone.
    assert.doesNotThrow(() => h.hooks.emit(HOOKS.PEER_JOIN, {}));
    assert.equal(coreRan, true, 'other handlers still ran');
});

test('module id must match its directory', async (t) => {
    const h = harness();
    t.after(h.cleanup);

    const modDir = path.join(h.tmp, 'modules');
    const dir = writeModule(modDir, 'alpha');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
    manifest.id = 'somethingelse';
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));

    assert.throws(() => h.host.discover(modDir), /does not match its directory/);
});
