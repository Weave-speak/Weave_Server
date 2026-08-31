// Moderation, end to end against a running server.
//
// The two things that make moderation real rather than cosmetic, and both are invisible
// when they are half-built:
//
//   A server mute must survive a refresh. The whole difference between it and self-mute is
//   that the person it is applied to cannot undo it, and reconnecting is the easiest way
//   anybody would try. So the assertion that matters is not "the handler paused the
//   producer" — it is "a FRESH connection is still muted".
//
//   A kick must block the reconnect. The client comes straight back on its own carrying
//   the room it remembers, so a kick that only closes the socket puts the person back
//   where they were about a second later and looks, from every other screen, like nothing
//   happened at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { freePort, startWithRetry } from './helpers.js';

import {
    activeMute, activeKick, mute, unmute, recordKick, expiredMutes, settleExpired,
} from '../src/core/moderation/index.js';
import { createEnforcer } from '../src/core/moderation/enforce.js';
import { watchMuteExpiry } from '../src/core/moderation/sweep.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-mod-'));
    let httpPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(await freePort()),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const call = async (method, url, { body, token } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201);

    const mint = async (name) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username: name, password: 'a-long-enough-password' },
        });
        assert.equal(user.status, 201, JSON.stringify(user.body));
        return user.body;
    };

    const sockets = [];
    /** Connect and join. `expectJoin: false` returns before the join is answered. */
    const connect = async (token, { channelId, expectJoin = true } = {}) => {
        const ws = new WebSocket(`ws://127.0.0.1:${httpPort}`);
        sockets.push(ws);
        const inbox = [];
        const waiters = [];
        const closed = { code: null, reason: null };
        const closeWaiters = [];
        ws.on('close', (c, r) => {
            closed.code = c;
            closed.reason = String(r);
            closeWaiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(closed); });
        });
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            const i = waiters.findIndex((w) => w.type === msg.type);
            if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); }
            else inbox.push(msg);
        });
        const expect = (type, ms = 5000) => {
            const found = inbox.findIndex((m) => m.type === type);
            if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(
                    `timeout waiting for ${type}; saw ${inbox.map((m) => m.type)}`)), ms);
                waiters.push({ type, resolve, timer });
            });
        };
        const expectClose = (ms = 5000) => {
            if (closed.code !== null) return Promise.resolve(closed);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
                closeWaiters.push({ resolve, timer });
            });
        };
        await new Promise((r) => ws.once('open', r));
        await expect('hello');
        ws.send(JSON.stringify({ type: 'join', token, protocol: 1, ...(channelId ? { channelId } : {}) }));
        const joined = expectJoin ? await expect('joined') : null;
        return {
            ws, joined, expect, expectClose,
            send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
        };
    };

    return {
        call, mint, connect,
        dbPath: path.join(dir, 'data', 'weave.db'),
        adminId: admin.body.user.id,
        adminToken: admin.body.token,
        stop: () => { sockets.forEach((s) => { try { s.close(); } catch { /* closing */ } }); return app.stop(); },
    };
}

/** The peer view of somebody else, out of the joined frame's roster. */
const rosterEntry = (joined, userId) => joined.peers.find((p) => p.userId === userId);

// ── the store, on its own ────────────────────────────────────────────────────

function memoryDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE moderation (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT,
            by_user_id TEXT, at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at INTEGER, lifted_at INTEGER, lifted_by TEXT);
    `);
    return db;
}

test('a mute with no duration stays in force; one with a duration stops on its own', () => {
    const db = memoryDb();
    const t0 = 1_000_000;

    mute(db, { userId: 'u1', minutes: null, now: t0 });
    assert.ok(activeMute(db, 'u1', t0 + 10 * 365 * 24 * 3600_000), 'until lifted means until lifted');

    mute(db, { userId: 'u2', minutes: 5, now: t0 });
    assert.ok(activeMute(db, 'u2', t0 + 4 * 60_000), 'still muted four minutes in');
    assert.equal(activeMute(db, 'u2', t0 + 6 * 60_000), null, 'not muted six minutes in');
});

test('re-muting replaces rather than stacks, so shortening a mute actually shortens it', () => {
    const db = memoryDb();
    const t0 = 1_000_000;

    mute(db, { userId: 'u1', minutes: 60, now: t0 });
    mute(db, { userId: 'u1', minutes: 5, now: t0 });

    assert.equal(activeMute(db, 'u1', t0 + 10 * 60_000), null,
        'the hour-long mute was lifted, not left underneath');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM moderation WHERE lifted_at IS NULL').get();
    assert.equal(rows.n, 1);
});

test('an expired mute is reported once and then settled', () => {
    const db = memoryDb();
    const t0 = 1_000_000;
    mute(db, { userId: 'u1', minutes: 1, now: t0 });

    const later = t0 + 2 * 60_000;
    assert.deepEqual(expiredMutes(db, later), ['u1']);
    settleExpired(db, later);
    assert.deepEqual(expiredMutes(db, later), [], 'the sweep does not keep finding the same row');
});

test('unmute lifts it immediately, before the expiry it was given', () => {
    const db = memoryDb();
    const t0 = 1_000_000;
    mute(db, { userId: 'u1', minutes: 60, now: t0 });
    assert.equal(unmute(db, { userId: 'u1', now: t0 + 1000 }), 1);
    assert.equal(activeMute(db, 'u1', t0 + 2000), null);
});

test('a kick is in force for its cooldown and no longer', () => {
    const db = memoryDb();
    const t0 = 1_000_000;
    recordKick(db, { userId: 'u1', cooldownMs: 60_000, now: t0 });
    assert.ok(activeKick(db, 'u1', t0 + 30_000));
    assert.equal(activeKick(db, 'u1', t0 + 61_000), null);
});

// ── the enforcer ─────────────────────────────────────────────────────────────

const fakeProducer = () => {
    const it = { paused: false, pause() { it.paused = true; }, resume() { it.paused = false; } };
    return it;
};

function enforcerHarness(peerOverrides = {}) {
    const audio = fakeProducer();
    const peer = {
        cid: 'c1', userId: 'u1', muted: false, forceMuted: false, forceMutedUntil: null,
        producers: new Map([['audio', audio]]), ...peerOverrides,
    };
    const broadcasts = [];
    const applyForceMute = createEnforcer({
        peers: { forUser: (id) => (id === peer.userId ? [peer] : []) },
        ws: { broadcast: (type, payload) => broadcasts.push({ type, ...payload }) },
    });
    return { peer, audio, broadcasts, applyForceMute };
}

test('a server mute pauses the producer, and lifting it resumes', async () => {
    const h = enforcerHarness();
    await h.applyForceMute('u1', true, 42);
    assert.equal(h.audio.paused, true);
    assert.equal(h.peer.forceMuted, true);
    assert.equal(h.peer.forceMutedUntil, 42);

    await h.applyForceMute('u1', false);
    assert.equal(h.audio.paused, false);
    assert.equal(h.peer.forceMuted, false);
    assert.deepEqual(h.broadcasts.map((b) => b.forceMuted), [true, false]);
});

test('lifting a server mute does not un-mute somebody who also muted themselves', async () => {
    const h = enforcerHarness({ muted: true });
    await h.applyForceMute('u1', true);
    await h.applyForceMute('u1', false);
    assert.equal(h.audio.paused, true, 'their own choice outlives the administrator lifting theirs');
});

test('the sweep lifts what has expired and leaves what has not', async () => {
    const db = memoryDb();
    const t0 = 1_000_000;
    mute(db, { userId: 'expired', minutes: 1, now: t0 });
    mute(db, { userId: 'standing', minutes: null, now: t0 });

    const lifted = [];
    let fire;
    const stop = watchMuteExpiry({
        db,
        log: { info() {}, warn() {} },
        applyForceMute: async (userId, on) => { lifted.push([userId, on]); },
        now: () => t0 + 5 * 60_000,
        setTimer: (fn) => { fire = fn; return { unref() {} }; },
        clearTimer: () => {},
    });
    await fire();
    stop();

    assert.deepEqual(lifted, [['expired', false]], 'only the one that ran out');
    assert.ok(activeMute(db, 'standing', t0 + 6 * 60_000), 'the open-ended one is untouched');
});

// ── over the wire ────────────────────────────────────────────────────────────

test('an ordinary member cannot server-mute or kick anybody', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const wren = await h.mint('wren');

    const live = await h.connect(kes.token);
    live.send('serverMute', { userId: wren.user.id });
    const refused = await live.expect('error');
    assert.equal(refused.code, 'forbidden');

    live.send('kickPeer', { userId: wren.user.id });
    assert.equal((await live.expect('error')).code, 'forbidden');
});

test('a server mute survives the muted person reconnecting', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const admin = await h.connect(h.adminToken);
    const first = await h.connect(kes.token);

    admin.send('serverMute', { userId: kes.user.id, minutes: 60 });
    const changed = await admin.expect('serverMuteChanged');
    assert.equal(changed.forceMuted, true);
    assert.ok(changed.until > Date.now(), 'a timed mute carries when it ends');

    // The live connection is told, and so is everyone else watching the roster.
    const told = await first.expect('peer_force_muted');
    assert.equal(told.forceMuted, true);

    // The assertion this file exists for: a BRAND-NEW connection is still muted. Nothing
    // about the first socket is reused, so this can only come from the database.
    first.ws.close();
    const second = await h.connect(kes.token);
    assert.equal(second.joined.self.forceMuted, true,
        'the very first frame of a fresh connection already says so');
    assert.ok(second.joined.self.forceMutedUntil > Date.now());
});

test('a server-muted person cannot unmute themselves', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const admin = await h.connect(h.adminToken);
    const live = await h.connect(kes.token);

    admin.send('serverMute', { userId: kes.user.id, minutes: null });
    await admin.expect('serverMuteChanged');
    await live.expect('peer_force_muted');

    live.send('setMute', { muted: false, deafened: false });
    const answer = await live.expect('muteChanged');
    assert.equal(answer.forceMuted, true, 'the reply tells them why pressing it did nothing');
});

test('an administrator can lift a server mute, and everyone is told', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const admin = await h.connect(h.adminToken);
    const live = await h.connect(kes.token);

    admin.send('serverMute', { userId: kes.user.id, minutes: null });
    await admin.expect('serverMuteChanged');
    await live.expect('peer_force_muted');

    admin.send('serverMute', { userId: kes.user.id, muted: false });
    assert.equal((await admin.expect('serverMuteChanged')).forceMuted, false);
    assert.equal((await live.expect('peer_force_muted')).forceMuted, false);

    const back = await h.connect(kes.token);
    assert.equal(back.joined.self.forceMuted, false);
});

test('administrators cannot server-mute or kick one another, or themselves', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const other = await h.mint('kestrel');
    await h.call('POST', `/api/admin/members/${other.user.id}/admin`, {
        token: h.adminToken, body: { isAdmin: true },
    });

    const admin = await h.connect(h.adminToken);
    admin.send('serverMute', { userId: other.user.id });
    assert.equal((await admin.expect('error')).code, 'forbidden');

    admin.send('kickPeer', { userId: other.user.id });
    assert.equal((await admin.expect('error')).code, 'forbidden');

    admin.send('serverMute', { userId: h.adminId });
    assert.equal((await admin.expect('error')).code, 'not_yourself');
});

test('a kick cuts the connection AND refuses the reconnect that follows it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const admin = await h.connect(h.adminToken);
    const live = await h.connect(kes.token);

    admin.send('kickPeer', { userId: kes.user.id, reason: 'testing' });
    const done = await admin.expect('kickedPeer');
    assert.equal(done.connections, 1);

    // Told why, then cut — in that order, so the person reads a sentence.
    const why = await live.expect('kicked');
    assert.equal(why.by, 'admin');
    assert.ok(why.retryAfterMs > 0);
    const cut = await live.expectClose();
    assert.equal(cut.code, 4006, 'its own code, not one of the account-is-gone ones');

    // The half that makes it more than theatre: coming straight back is refused.
    const again = await h.connect(kes.token, { expectJoin: false });
    const refused = await again.expect('error');
    assert.equal(refused.code, 'kicked');
    assert.match(refused.message, /rejoin in \d+s/);
    assert.equal((await again.expectClose()).code, 4006);

    // The session itself is untouched — a kick is not a ban.
    const stillValid = await h.call('GET', '/api/channels', { token: kes.token });
    assert.equal(stillValid.status, 200);
});

test('the cooldown lets go, and the kicked person comes back', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');
    const admin = await h.connect(h.adminToken);
    const live = await h.connect(kes.token);

    admin.send('kickPeer', { userId: kes.user.id });
    await admin.expect('kickedPeer');
    await live.expectClose();

    // Reaching into the database beats sleeping out a real cooldown: the behaviour under
    // test is "an expired kick stops being enforced", not how long a minute is.
    const db = new Database(h.dbPath);
    db.prepare("UPDATE moderation SET expires_at = ? WHERE action = 'kick'").run(Date.now() - 1);
    db.close();

    const back = await h.connect(kes.token);
    assert.ok(back.joined.channel, 'and lands in a room again');
});

// ── admin move ───────────────────────────────────────────────────────────────

test('an administrator can move somebody else, and the move says who did it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const rooms = await h.call('GET', '/api/channels', { token: h.adminToken });
    const voice = rooms.body.channels.filter((c) => c.kind !== 'text');
    assert.ok(voice.length >= 2, 'the seeded server has more than one voice room');

    const admin = await h.connect(h.adminToken);
    const live = await h.connect(kes.token, { channelId: voice[0].id });

    const target = voice.find((c) => c.id !== voice[0].id);
    admin.send('adminMove', { userId: kes.user.id, channelId: target.id });

    const moved = await live.expect('moved');
    assert.equal(moved.channel.id, target.id);
    assert.equal(moved.reason, 'admin');
    assert.equal(moved.by, 'admin', 'the moved client can say who, rather than guessing');
    assert.equal((await admin.expect('adminMoved')).userId, kes.user.id);
});

test('an administrator cannot move somebody into a text channel', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    // Seeded rooms are all voice, so the strand this test needs is made here.
    const made = await h.call('POST', '/api/channels', {
        token: h.adminToken, body: { name: 'Notices', kind: 'text' },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const text = made.body.channel;

    const admin = await h.connect(h.adminToken);
    await h.connect(kes.token);

    admin.send('adminMove', { userId: kes.user.id, channelId: text.id });
    assert.equal((await admin.expect('error')).code, 'text_channel',
        'the guard self-move has, which the admin path was missing');
});

test('an administrator cannot move somebody into a private room they are not on', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const made = await h.call('POST', '/api/channels', {
        token: h.adminToken, body: { name: 'Back room', kind: 'voice', private: true },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const admin = await h.connect(h.adminToken);
    await h.connect(kes.token);

    admin.send('adminMove', { userId: kes.user.id, channelId: made.body.channel.id });
    assert.equal((await admin.expect('error')).code, 'not_a_member',
        'membership is the entire point of a private room');
});

test('a move takes every connection the account holds, not just one', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const rooms = await h.call('GET', '/api/channels', { token: h.adminToken });
    const voice = rooms.body.channels.filter((c) => c.kind !== 'text');

    const admin = await h.connect(h.adminToken);
    const laptop = await h.connect(kes.token, { channelId: voice[0].id });
    const phone = await h.connect(kes.token, { channelId: voice[0].id });

    const target = voice.find((c) => c.id !== voice[0].id);
    admin.send('adminMove', { userId: kes.user.id, channelId: target.id });

    assert.equal((await laptop.expect('moved')).channel.id, target.id);
    assert.equal((await phone.expect('moved')).channel.id, target.id,
        'otherwise the row moves in the sidebar while they are still audible in the old room');
});

test('a server mute reaches every connection, and the roster shows it', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const kes = await h.mint('kestrel');

    const admin = await h.connect(h.adminToken);
    await h.connect(kes.token);
    await h.connect(kes.token);

    admin.send('serverMute', { userId: kes.user.id, minutes: 10 });
    await admin.expect('serverMuteChanged');

    const watcher = await h.connect(h.adminToken);
    const seen = rosterEntry(watcher.joined, kes.user.id);
    assert.ok(seen, 'they are in the roster');
    assert.equal(seen.forceMuted, true, 'so every client can mark them differently to self-muted');
});
