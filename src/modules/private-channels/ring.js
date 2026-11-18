// The huddle ring: a private room going from empty to occupied rings its other members.
//
// A huddle is something you start for people, and until now they only found out by
// happening to look at the sidebar. So the first person into an empty private room rings
// everyone else on its member list, on every device they have — over the socket for an
// open app, by push for a phone whose app is asleep — for as long as a call rings.
//
// What counts as starting one is narrow on purpose, because a ring that fires when nobody
// meant to start anything is the fastest way to have people switch it off:
//
//   - a person ARRIVING: a move or a fresh join. A resumed join is a dropped line coming
//     back, and the room never stood empty from anyone else's point of view.
//   - into a private room that is not a system room. A DM call is private and system,
//     and rings by its own rules in the dm module.
//   - that was empty. Somebody joining a huddle already going is joining, not starting.
//     Counted in PEOPLE, not connections: one person's second device arriving beside
//     their first is not a start, and their phone taking over from their laptop is not
//     the room emptying.
//   - at most once per room per cooldown, so stepping out for a drink and back in does
//     not ring everyone twice.
//
// Every ring carries a `callId`, for the same reason a DM call does: one ring reaches a
// person over the socket and by push, and "stop ringing" must name which ring it means.

import crypto from 'node:crypto';
import { getChannel, listMembers, isMember } from '../../core/channels/index.js';
import { HOOKS } from '../../core/hooks/index.js';

export const RING_MS = 45_000;
const MISSED_TTL_S = 24 * 60 * 60;
const COOLDOWN_MAX_MINUTES = 120;

export function registerHuddleRing(ctx) {
    ctx.settings.define('ringMembers', {
        type: 'boolean',
        label: 'Ring members when a huddle starts',
        help: 'The first person into an empty private room rings its other members, including on phones with the app closed.',
    }, true);

    ctx.settings.define('ringCooldownMinutes', {
        type: 'number', integer: true, min: 0, max: COOLDOWN_MAX_MINUTES,
        label: 'Ring a huddle at most once every (minutes)',
        help: 'Per room. Leaving and coming straight back does not ring everyone again. 0 rings every time.',
    }, 5);

    const db = ctx.db.handle;

    // channelId -> { callId, channelId, name, starterId, from, expiresAt, timer, pending: Set<userId> }
    const rings = new Map();
    // channelId -> when it last rang. In memory: a restart forgetting a cooldown costs, at
    // worst, one extra ring. Pruned as it goes (see forget), because nothing announces a
    // room being deleted: CHANNEL_DESTROY is declared but never emitted.
    const lastRang = new Map();

    /** Drop cooldowns that can no longer matter: past the longest cooldown, or for a room that is gone. */
    const forget = (now) => {
        for (const [channelId, at] of lastRang) {
            if (now - at >= COOLDOWN_MAX_MINUTES * 60 * 1000 || !getChannel(db, channelId)) lastRang.delete(channelId);
        }
    };

    /** Distinct people in a room, and how many connections `userId` has in it. */
    const occupancy = (channelId, userId) => {
        const inside = ctx.peers.inChannel(channelId);
        return {
            people: new Set(inside.map((p) => p.userId)).size,
            mine: inside.filter((p) => p.userId === userId).length,
        };
    };

    const toDevices = (userId, type, payload) => {
        for (const peer of ctx.peers.forUser(userId)) ctx.ws.send(peer.ws, type, payload);
    };

    const pushTo = (ring, userId, kind, reason) => {
        const payload = {
            v: 1,
            kind,
            callId: ring.callId,
            call: { type: 'huddle', channelId: ring.channelId, name: ring.name },
            from: ring.from,
            expiresAt: ring.expiresAt,
            ...(reason ? { reason } : {}),
        };
        // Same shape as a DM call's: a ring and its cancel expire with the ring and share a
        // topic, so a push service holding the ring for an offline phone replaces it.
        const opts = kind === 'missed'
            ? { ttl: MISSED_TTL_S, urgency: 'normal', topic: ring.callId }
            : { ttl: Math.max(1, Math.ceil((ring.expiresAt - Date.now()) / 1000)), urgency: 'high', topic: ring.callId };
        ctx.push.toUser(userId, payload, opts).catch(() => {});
    };

    /** One member's ring is over, for `reason`: every device of theirs stops. */
    const settle = (ring, userId, reason) => {
        if (!ring.pending.delete(userId)) return false;
        toDevices(userId, 'ring_cancel', { callId: ring.callId, channelId: ring.channelId, reason });
        pushTo(ring, userId, 'ring_cancel', reason);
        return true;
    };

    /**
     * The whole ring is over. Whoever neither came nor declined missed it — unless the
     * server is stopping, or the room itself is gone (an administrator deleted it), since
     * a missed call offers Join and there would be nothing to join.
     */
    const endRing = (channelId, reason) => {
        const ring = rings.get(channelId);
        if (!ring) return;
        rings.delete(channelId);
        clearTimeout(ring.timer);
        const roomGone = !getChannel(db, channelId);
        const why = roomGone ? 'cancelled' : reason;
        const kind = roomGone || reason === 'server' ? 'ring_cancel' : 'missed';
        for (const userId of ring.pending) {
            toDevices(userId, 'ring_cancel', { callId: ring.callId, channelId, reason: why });
            pushTo(ring, userId, kind, why);
        }
        ring.pending.clear();
        ctx.log.debug({ evt: 'private.ring_ended', reason }, `Huddle ring ended (${reason})`);
    };

    const startRing = (peer, channel) => {
        if (!ctx.settings.get('ringMembers')) return;
        if (rings.has(channel.id)) return;
        const now = Date.now();
        forget(now);
        const cooldownMs = ctx.settings.get('ringCooldownMinutes') * 60 * 1000;
        const last = lastRang.get(channel.id);
        if (last !== undefined && now - last < cooldownMs) return;

        const members = listMembers(db, channel.id).map((m) => m.id).filter((id) => id !== peer.userId);
        if (members.length === 0) return;

        const expiresAt = now + RING_MS;
        const ring = {
            callId: crypto.randomBytes(16).toString('base64url'),
            channelId: channel.id,
            name: channel.name,
            starterId: peer.userId,
            from: { username: peer.username, displayName: peer.displayName ?? peer.username },
            expiresAt,
            pending: new Set(members),
            timer: setTimeout(() => endRing(channel.id, 'no_answer'), RING_MS),
        };
        ring.timer.unref?.();
        rings.set(channel.id, ring);
        lastRang.set(channel.id, now);

        for (const userId of members) {
            // `ringMs` is the duration, which needs no agreement between clocks; `expiresAt`
            // is the same moment on the server's clock, as the push payload carries it.
            toDevices(userId, 'ring', {
                channelId: channel.id, callId: ring.callId, name: channel.name, from: ring.from,
                ringMs: RING_MS, expiresAt,
            });
            pushTo(ring, userId, 'ring');
        }
        ctx.log.info({ evt: 'private.ring', channel: channel.name, from: peer.username, members: members.length },
            `${peer.username} started a huddle in "${channel.name}"; ringing ${members.length} member(s)`);
    };

    /** `peer` has just arrived in `channelId`. */
    const arrived = (peer, channelId) => {
        if (!peer || !channelId) return;
        const ring = rings.get(channelId);
        // Coming in is answering — on whichever device, so all of them stop.
        if (ring) { settle(ring, peer.userId, 'answered'); return; }

        const channel = getChannel(db, channelId);
        if (!channel?.private || channel.system) return;
        // Empty until now: this person is the only one inside, on this one connection.
        const { people, mine } = occupancy(channelId, peer.userId);
        if (people !== 1 || mine !== 1) return;
        startRing(peer, channel);
    };

    /**
     * A room a ring is for has emptied: the starter left while still alone, or everyone
     * who came has gone again. Nobody is left to answer to, so it is cancelled for all.
     */
    const departed = (channelId) => {
        if (!channelId || !rings.has(channelId)) return;
        if (occupancy(channelId, null).people === 0) endRing(channelId, 'cancelled');
    };

    ctx.hooks.on(HOOKS.PEER_MOVE, ({ peer, from, to }) => {
        departed(from);
        arrived(peer, to);
    });
    ctx.hooks.on(HOOKS.PEER_JOIN, ({ peer, channel, resumed }) => {
        if (resumed) return;
        arrived(peer, channel?.id ?? null);
    });
    // The peer is out of the registry by the time this fires, still naming the room it was in.
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => departed(peer?.channelId ?? null));

    /**
     * `userId` declines the ring for `channelId`. `callId` is optional but honoured, so a
     * decline from a stale notification cannot stop a newer ring of the same room.
     */
    const decline = (userId, channelId, callId) => {
        const ring = rings.get(String(channelId ?? ''));
        if (!ring) return false;
        if (callId !== undefined && callId !== null && String(callId) !== ring.callId) return false;
        return settle(ring, userId, 'declined');
    };

    ctx.ws.on('decline', ({ ws, msg }) => {
        const peer = ctx.peers.get(ws.cid);
        if (peer) decline(peer.userId, msg.channelId, msg.callId);
    });

    // Declining from a phone's notification, with no app running to hold a socket. Shaped
    // like the DM call's: idempotent for a member (`ended` says whether it stopped a ring),
    // the callId required because a notification always has one, and the same 404 for "no
    // such room" and "not yours", since a difference would say which private rooms exist.
    ctx.http.route('POST', '/api/private-channels/:id/ring/decline', ({ session, params, body, json }) => {
        if (!isMember(db, params.id, session.userId)) {
            return json(404, { error: 'no_room', message: 'No such room.' });
        }
        const callId = typeof body?.callId === 'string' ? body.callId : '';
        if (!callId) return json(400, { error: 'no_call_id', message: 'Name the ring to decline.' });
        json(200, { ok: true, ended: decline(session.userId, params.id, callId) });
    }, { maxBytes: 1_000 });

    ctx.onUnload(() => {
        for (const channelId of [...rings.keys()]) endRing(channelId, 'server');
    });
}
