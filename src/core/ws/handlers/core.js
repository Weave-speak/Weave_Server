// Core signalling handlers.
//
// The shape of a call:
//
//   join            authenticate, land in a channel, learn who is there
//   createTransport one to send on, one to receive on
//   connectTransport complete DTLS
//   produce         start sending a track
//   consume         start receiving someone else's track
//   move            change channel — producers are re-scoped, not rebuilt
//
// Channel isolation is enforced server-side at every step. A client asking to consume a
// producer from a channel it is not in is refused rather than trusted, because the
// alternative is that a forged message lets someone listen to a room they were never in.

import { PeerRegistry, SLOTS, isValidSlot } from '../../peers/index.js';
import { movePeer } from '../../peers/move.js';
import { getChannel, defaultChannel } from '../../channels/index.js';
import { negotiate, ProtocolMismatchError } from '../../../protocol/index.js';
import { touchLastSeen } from '../../users/index.js';
import { HOOKS } from '../../hooks/index.js';

/** Deliberate leave, so others are told at once instead of after the grace window. */
export const LEAVE_CLOSE_CODE = 4000;

export function registerCoreWsHandlers({ registry, peers, sfu, db, auth, log, hooks, ws: wsServer }) {
    /** Tell everyone else in a channel about something. */
    const toChannel = (channelId, type, payload, exceptCid = null) =>
        wsServer.broadcast(type, payload, (sock) => {
            const peer = peers.get(sock.cid);
            return peer && peer.channelId === channelId && peer.cid !== exceptCid;
        });

    // ── join ─────────────────────────────────────────────────────────────────
    // The only handler that runs without a session, because it is the one that
    // establishes it. The token travels in the message body rather than a header
    // because browsers cannot set headers on a WebSocket handshake.
    registry.register('core', 'join', async ({ ws, msg, send, fail }) => {
        if (ws.session) return fail(ws, 'already_joined', 'This connection has already joined.');

        const session = auth.resolveToken(msg.token);
        if (!session) {
            return fail(ws, 'unauthenticated', 'Your session has expired. Sign in again.');
        }

        // Agree a protocol version before anything else, so a mismatch is reported as a
        // mismatch rather than as a series of confusing failures later.
        let protocol;
        try {
            protocol = negotiate(msg.protocol?.min ?? 1, msg.protocol?.max ?? 1);
        } catch (err) {
            if (err instanceof ProtocolMismatchError) {
                log.info({ evt: 'ws.protocol_mismatch', cid: ws.cid, detail: err.detail }, err.message);
                return fail(ws, 'protocol_mismatch', err.message, err.detail);
            }
            throw err;
        }

        // Standing anywhere is OPTIONAL: autoJoin false arrives signed in but in no
        // voice room — reading everything, heard by no one — until a room is chosen.
        // A remembered pure-text channel cannot be stood in either way.
        const requested = msg.channelId ? getChannel(db, msg.channelId) : null;
        const wantRoom = msg.autoJoin !== false;
        const channel = wantRoom
            ? ((requested && requested.kind !== 'text' ? requested : null) ?? defaultChannel(db))
            : null;
        if (wantRoom && !channel) {
            return fail(ws, 'no_channels', 'This server has no channels configured.');
        }

        ws.session = session;
        const peer = peers.add(ws, session, channel?.id ?? null, protocol);
        touchLastSeen(db, session.userId);

        ws.log = log.child({ cid: ws.cid, user: session.username });
        ws.log.info({ evt: 'peer.joined', channel: channel?.name ?? '(nowhere)' },
            `${session.username} joined ${channel ? channel.name : 'without a room'}`);

        send('joined', {
            protocol,
            self: PeerRegistry.publicView(peer),
            channel,
            // The WHOLE roster, not one room's: the sidebar shows who is standing where
            // across the server, and a fresh client must not have to wait for movement
            // to find out.
            peers: peers.snapshot(ws.cid),
            ...(channel ? { rtpCapabilities: sfu.rtpCapabilities(channel.id) } : {}),
        });

        // Everyone hears about an arrival, wherever they stand — the frame carries the
        // channel, so every sidebar files them correctly.
        wsServer.broadcast('peer_joined', { peer: PeerRegistry.publicView(peer) },
            (sock) => sock.cid !== ws.cid && peers.get(sock.cid));
        hooks.emit(HOOKS.PEER_JOIN, { peer, channel });
    }, { auth: 'none' });

    // ── leaving a room without leaving the server ────────────────────────────
    // The disconnect button: media closes, presence stays. The peer stands nowhere,
    // reading whatever they like, until they pick a room again.
    registry.register('core', 'leave', ({ ws, send }) => {
        const peer = peers.get(ws.cid);
        if (!peer) return;
        const from = peer.channelId;
        if (from === null) return send('left', { channel: null });

        // The same teardown a cross-worker move does: transports close, which closes
        // producers and fires producerclose on every consumer elsewhere — the normal path.
        for (const consumer of peer.consumers.values()) {
            try { consumer.close(); } catch { /* already closed */ }
        }
        peer.consumers.clear();
        for (const producer of peer.producers.values()) {
            try { producer.close(); } catch { /* already closed */ }
        }
        peer.producers.clear();
        for (const transport of peer.transports.values()) {
            try { transport.close(); } catch { /* already closed */ }
        }
        peer.transports.clear();

        peer.channelId = null;
        send('left', { channel: null });
        // An upsert everyone understands: the same peer, now standing nowhere.
        wsServer.broadcast('peer_joined', { peer: PeerRegistry.publicView(peer) },
            (sock) => sock.cid !== ws.cid && peers.get(sock.cid));
        hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: null, reason: 'left' });
    });

    // ── heartbeat ────────────────────────────────────────────────────────────
    // Browsers never surface protocol ping/pong to JS, so the client sends its own and
    // this answers. A reply also proves the path is alive in both directions, which a
    // half-open socket through a tunnel otherwise hides.
    registry.register('core', 'ping', ({ send, msg }) => {
        send('pong', { t: msg.t ?? null });
    }, { auth: 'none' });

    // ── transports ───────────────────────────────────────────────────────────
    registry.register('core', 'createTransport', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const direction = msg.direction;
        if (direction !== 'send' && direction !== 'recv') {
            return fail(ws, 'bad_direction', 'Transport direction must be "send" or "recv".');
        }
        if (peer.transports.has(direction)) {
            return fail(ws, 'transport_exists', `A ${direction} transport already exists.`);
        }

        const transport = await sfu.createTransport(peer.channelId);
        peer.transports.set(direction, transport);

        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed') transport.close();
        });
        // ICE failure is how a network path dies mid-call. Surfacing it lets the client
        // rebuild rather than sitting in a call that is silently already over.
        transport.on('icestatechange', (state) => {
            if (state === 'disconnected' || state === 'closed') {
                ws.log.warn({ evt: 'transport.ice', direction, state }, `ICE ${state} on ${direction}`);
                send('transportFailed', { direction, state });
            }
        });

        send('transportCreated', {
            direction,
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        });
    });

    registry.register('core', 'connectTransport', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const transport = peer.transports.get(msg.direction);
        if (!transport) return fail(ws, 'no_transport', 'That transport does not exist.');

        await transport.connect({ dtlsParameters: msg.dtlsParameters });
        send('transportConnected', { direction: msg.direction });
    });

    // ── producing ────────────────────────────────────────────────────────────
    registry.register('core', 'produce', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const slot = msg.slot;

        if (!isValidSlot(slot)) {
            return fail(ws, 'bad_slot', `Slot must be one of: ${Object.values(SLOTS).join(', ')}`);
        }

        const channel = getChannel(db, peer.channelId);
        if (!channel) return fail(ws, 'no_channel', 'You are not in a channel.');

        // Capability is a property of the channel, checked the same way for every
        // channel — not a special case keyed off a channel's name.
        const isVoice = slot === SLOTS.AUDIO;
        const isVideo = slot === SLOTS.SCREEN || slot === SLOTS.WEBCAM;
        if (isVoice && !channel.allowVoice) {
            return fail(ws, 'voice_not_allowed', `Voice is not enabled in ${channel.name}.`);
        }
        if (isVideo && !channel.allowVideo) {
            return fail(ws, 'video_not_allowed', `Video is not enabled in ${channel.name}.`);
        }

        const transport = peer.transports.get('send');
        if (!transport) return fail(ws, 'no_transport', 'Create a send transport first.');

        // Re-producing into an occupied slot replaces it. Closing the old producer first
        // is what stops it becoming an unreachable leak still forwarding RTP.
        const existing = peer.producers.get(slot);
        if (existing) {
            existing.close();
            peer.producers.delete(slot);
            toChannel(peer.channelId, 'producer_closed',
                { cid: peer.cid, slot, producerId: existing.id, replaced: true }, ws.cid);
        }

        const producer = await transport.produce({
            kind: msg.kind,
            rtpParameters: msg.rtpParameters,
            appData: { slot, cid: peer.cid, userId: peer.userId },
        });

        peer.producers.set(slot, producer);
        producer.on('transportclose', () => peer.producers.delete(slot));
        await sfu.observeAudio(peer.channelId, producer);

        ws.log.info({ evt: 'producer.new', slot, kind: producer.kind },
            `${peer.username} started sending ${slot}`);

        send('produced', { slot, id: producer.id, kind: producer.kind });
        toChannel(peer.channelId, 'producer_new', {
            cid: peer.cid, userId: peer.userId, slot, producerId: producer.id, kind: producer.kind,
        }, ws.cid);

        hooks.emit(HOOKS.PRODUCER_NEW, { peer, slot, producer });
    });

    registry.register('core', 'closeProducer', ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const slot = msg.slot;
        const producer = peer.producers.get(slot);
        if (!producer) return fail(ws, 'no_producer', 'You are not sending that.');

        producer.close();
        peer.producers.delete(slot);

        ws.log.info({ evt: 'producer.closed', slot }, `${peer.username} stopped sending ${slot}`);
        send('producerClosed', { slot, producerId: producer.id });

        // `stopped: true` marks a DELIBERATE stop. mediasoup also fires producerclose on
        // disconnects and transport teardown, and a client that cannot tell the two apart
        // ends up playing a "stream ended" sound on every network blip.
        toChannel(peer.channelId, 'producer_closed',
            { cid: peer.cid, slot, producerId: producer.id, stopped: true }, ws.cid);

        hooks.emit(HOOKS.PRODUCER_CLOSE, { peer, slot, producerId: producer.id });
    });

    registry.register('core', 'pauseProducer', ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const producer = peer.producers.get(msg.slot);
        if (!producer) return fail(ws, 'no_producer', 'You are not sending that.');

        const paused = msg.paused !== false;
        if (paused) producer.pause(); else producer.resume();

        send('producerPaused', { slot: msg.slot, paused });
        toChannel(peer.channelId, 'producer_paused',
            { cid: peer.cid, slot: msg.slot, paused }, ws.cid);
    });

    // ── consuming ────────────────────────────────────────────────────────────
    registry.register('core', 'consume', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const transport = peer.transports.get('recv');
        if (!transport) return fail(ws, 'no_transport', 'Create a recv transport first.');

        const target = peers.get(msg.cid);
        if (!target) return fail(ws, 'no_peer', 'That person is no longer connected.');

        // The isolation check. Without it, a forged cid lets someone consume media from a
        // channel they are not in.
        if (target.channelId !== peer.channelId) {
            log.warn({ evt: 'consume.cross_channel', by: peer.username, target: target.username },
                `${peer.username} tried to consume across channels`);
            return fail(ws, 'wrong_channel', 'That person is not in your channel.');
        }

        const producer = target.producers.get(msg.slot);
        if (!producer) return fail(ws, 'no_producer', 'They are not sending that.');

        const router = sfu.routerFor(peer.channelId);
        if (!router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) {
            return fail(ws, 'cannot_consume', 'Your device cannot play this stream.');
        }

        const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: msg.rtpCapabilities,
            // Start paused, always. Resuming after the client has attached the track
            // avoids the first packets arriving before there is anywhere to put them,
            // which shows up as a stream that connects but never renders.
            paused: true,
            appData: { slot: msg.slot, fromCid: target.cid },
        });

        peer.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => {
            peer.consumers.delete(consumer.id);
            send('consumerClosed', { consumerId: consumer.id, cid: target.cid, slot: msg.slot });
        });

        send('consumed', {
            consumerId: consumer.id,
            producerId: producer.id,
            cid: target.cid,
            slot: msg.slot,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
        });
    });

    registry.register('core', 'resumeConsumer', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const consumer = peer.consumers.get(msg.consumerId);
        if (!consumer) return fail(ws, 'no_consumer', 'No such stream.');

        await consumer.resume();
        send('consumerResumed', { consumerId: consumer.id });
    });

    registry.register('core', 'closeConsumer', ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const consumer = peer.consumers.get(msg.consumerId);
        if (!consumer) return fail(ws, 'no_consumer', 'No such stream.');

        consumer.close();
        peer.consumers.delete(consumer.id);
        send('consumerClosed', { consumerId: consumer.id });
    });

    // ── moving between channels ──────────────────────────────────────────────
    // The work lives in movePeer so that a self-initiated move, an admin-initiated one
    // and a module-initiated one cannot drift apart. The previous server had this inline
    // in one handler and the other paths gradually stopped matching it.
    registry.register('core', 'move', ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const channel = getChannel(db, msg.channelId);
        if (!channel) return fail(ws, 'no_channel', 'No such channel.');
        // A pure-text channel is a place you READ, not a place you stand. Reading is free
        // to every member from anywhere; moving there would silently pull someone out of
        // the voice room they are actually in.
        if (channel.kind === 'text') {
            return fail(ws, 'text_channel', `${channel.name} is a text channel — open it, no need to move.`);
        }
        if (channel.id === peer.channelId) return send('moved', { channel, reason: 'self' });

        const from = peer.channelId;
        movePeer({ peer, channel, peers, sfu, ws: wsServer, hooks, reason: 'self' });
        ws.log.info({ evt: 'peer.moved', from, to: channel.name },
            `${peer.username} moved to ${channel.name}`);
    });

    // ── admin: move someone else ─────────────────────────────────────────────
    registry.register('core', 'adminMove', ({ ws, msg, send, fail }) => {
        const target = peers.get(msg.cid);
        if (!target) return fail(ws, 'no_peer', 'That person is no longer connected.');

        const channel = getChannel(db, msg.channelId);
        if (!channel) return fail(ws, 'no_channel', 'No such channel.');

        const mover = peers.get(ws.cid);
        movePeer({
            peer: target, channel, peers, sfu, ws: wsServer, hooks,
            // The reason reaches the moved client so it can say something true rather
            // than showing "moved by an administrator" for every kind of move.
            reason: 'admin', by: mover.displayName ?? mover.username,
        });

        ws.log.warn({ evt: 'peer.admin_moved', target: target.username, to: channel.name },
            `${mover.username} moved ${target.username} to ${channel.name}`);
        send('adminMoved', { cid: target.cid, channel });
    }, { auth: 'admin' });

    // ── mute and deafen ──────────────────────────────────────────────────────
    // Broadcast, because "can this person hear me?" is something the room needs to know.
    registry.register('core', 'setMute', ({ ws, msg, send }) => {
        const peer = peers.get(ws.cid);
        peer.muted = msg.muted === true;
        peer.deafened = msg.deafened === true;

        // Deafened implies muted: it would be odd to be heard while hearing nobody.
        if (peer.deafened) peer.muted = true;

        const audio = peer.producers.get(SLOTS.AUDIO);
        if (audio) {
            // Genuinely pause the producer rather than trusting the client to stop
            // sending. This also means no RTP flows, which any activity detection sees
            // as real silence without needing a special case.
            if (peer.muted) audio.pause(); else audio.resume();
        }

        send('muteChanged', { muted: peer.muted, deafened: peer.deafened });
        toChannel(peer.channelId, 'peer_mute_changed',
            { cid: peer.cid, muted: peer.muted, deafened: peer.deafened }, ws.cid);
    });
}
