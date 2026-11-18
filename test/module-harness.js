// One module, loaded by the real loader, with no media server.
//
// The socket-level suites (dm.test.js and friends) start the whole server, which needs
// mediasoup's worker binary. This loads a single module through the real ModuleHost —
// so the context it is handed, push included, is the real one — against a real database,
// with stand-ins only where media would be: peers that are plain records, sockets that
// record frames, a push service that records what it was asked to send, and a move that
// does what movePeer does to the hooks.
//
// Not a test itself; node --test runs it, finds no tests, and moves on, as with helpers.js.

import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { migrateCore } from '../src/db/index.js';
import { Settings } from '../src/core/settings/index.js';
import { HookBus, HOOKS } from '../src/core/hooks/index.js';
import { ModuleHost } from '../src/core/modules/loader.js';
import { createChannel, getChannel } from '../src/core/channels/index.js';

export const quiet = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return quiet; } };

export const USERS = [
    ['u-ana', 'ana', 'Ana'],
    ['u-kes', 'kes', 'Kes'],
    ['u-moth', 'moth', 'Moth'],
    ['u-zed', 'zed', 'Zed'],
];

export async function moduleHarness(moduleId, { push = true, pushImpl = null } = {}) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateCore(db, quiet);
    const addUser = db.prepare(`INSERT INTO users (id, username, username_lower, display_name, password_hash)
                                VALUES (?, ?, ?, ?, 'not-a-real-hash')`);
    for (const [id, username, displayName] of USERS) addUser.run(id, username, username, displayName);
    const general = createChannel(db, { name: 'General', isDefault: true });

    const settings = new Settings(db, quiet);
    const hooks = new HookBus(quiet);

    const peers = new Map();   // cid -> { cid, userId, username, displayName, channelId, ws }
    const peerView = {
        get: (cid) => peers.get(cid),
        inChannel: (channelId, exceptCid = null) => [...peers.values()]
            .filter((p) => p.channelId === channelId && p.cid !== exceptCid),
        forUser: (userId) => [...peers.values()].filter((p) => p.userId === userId),
        get count() { return peers.size; },
        get all() { return [...peers.values()]; },
    };

    const frames = [];         // [cid, type, payload]
    const wsHandlers = new Map();
    const routes = new Map();
    const pushes = [];

    const ws = {
        register(owner, type, handler) {
            const name = owner === 'core' ? type : `${owner}:${type}`;
            wsHandlers.set(name, handler);
            return () => wsHandlers.delete(name);
        },
        send(sock, type, payload = {}) {
            if (!sock || sock.closed) return false;
            frames.push([sock.cid, type, payload]);
            return true;
        },
        broadcast(type, payload, filter = () => true) {
            for (const peer of peers.values()) if (filter(peer.ws)) ws.send(peer.ws, type, payload);
        },
    };
    const http = {
        register(_owner, method, pattern, handler) {
            const key = `${method.toUpperCase()} ${pattern}`;
            routes.set(key, handler);
            return () => routes.delete(key);
        },
    };

    // movePeer's effect on the world a module can see: where the peer stands, then the hook.
    const movePeer = (cid, channelId, reason = 'module') => {
        const peer = peers.get(cid);
        if (!peer || !getChannel(db, channelId) || peer.channelId === channelId) return false;
        const from = peer.channelId;
        peer.channelId = channelId;
        frames.push([cid, 'moved', { channel: getChannel(db, channelId), reason }]);
        hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: channelId, reason });
        return true;
    };

    const config = {
        disabledModules: [],
        dataDir: os.tmpdir(), uploadsDir: os.tmpdir(), logDir: os.tmpdir(),
    };
    const host = new ModuleHost({
        config, log: quiet, db, settings, hooks,
        admin: { register: () => () => {} },
        peers: peerView,
        actions: { movePeer, listChannels: () => [], announceChannels: () => {} },
        ...(pushImpl ? { push: pushImpl } : push ? {
            push: {
                toUser: async (userId, payload, opts) => {
                    pushes.push({ userId, payload, opts });
                    return { sent: 1, gone: 0, failed: 0 };
                },
            },
        } : {}),
        http, ws,
    });
    const installed = host.discover(path.join(import.meta.dirname, '..', 'src', 'modules'));
    config.disabledModules = installed.map((m) => m.id).filter((id) => id !== moduleId);
    await host.loadAll();

    let next = 0;
    const connect = (userId, channelId = null, { resumed = false } = {}) => {
        const [, username, displayName] = USERS.find(([id]) => id === userId);
        const sock = { cid: `c${++next}`, closed: false };
        const peer = { cid: sock.cid, userId, username, displayName, channelId, ws: sock };
        peers.set(sock.cid, peer);
        hooks.emit(HOOKS.PEER_JOIN, { peer, channel: channelId ? getChannel(db, channelId) : null, ...(resumed ? { resumed } : {}) });
        return client(peer);
    };

    const client = (peer) => ({
        peer,
        cid: peer.cid,
        move: (channelId) => movePeer(peer.cid, channelId, 'self'),
        /** Stand nowhere, as the Leave button does. */
        standNowhere: () => {
            const from = peer.channelId;
            peer.channelId = null;
            hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: null, reason: 'left' });
        },
        /** Sign off: out of the registry first, then the hook — as PeerRegistry.end does. */
        signOff: () => {
            peers.delete(peer.cid);
            peer.ws.closed = true;
            hooks.emit(HOOKS.PEER_LEAVE, { peer });
        },
        send: (type, msg = {}) => wsHandlers.get(type)({
            ws: peer.ws,
            msg: { type, ...msg },
            send: (t, p) => ws.send(peer.ws, t, p),
            fail: (sock, code, message) => ws.send(sock, 'error', { code, message }),
        }),
        frames: (type) => frames.filter(([cid, t]) => cid === peer.cid && t === type).map(([, , p]) => p),
    });

    const route = async (method, pattern, { userId, params = {}, body = null } = {}) => {
        const handler = routes.get(`${method} ${pattern}`);
        if (!handler) throw new Error(`no route ${method} ${pattern}`);
        const user = USERS.find(([id]) => id === userId);
        let result;
        await handler({
            session: { userId, username: user?.[1], displayName: user?.[2], kind: 'client' },
            params, body, query: {},
            json: (status, data) => { result = { status, body: data }; },
        });
        return result;
    };

    return {
        db, settings, hooks, host, general, pushes, frames, routes,
        connect, route,
        pushesFor: (userId) => pushes.filter((p) => p.userId === userId),
        stop: () => host.stopAll(),
    };
}
