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
import { viewFor, snapshotFor } from '../../peers/visibility.js';
import { getChannel, defaultChannel, isMember, touchOccupancy } from '../../channels/index.js';
import { negotiate, ProtocolMismatchError } from '../../../protocol/index.js';
import { touchLastSeen } from '../../users/index.js';
import { HOOKS } from '../../hooks/index.js';

/** Deliberate leave, so others are told at once instead of after the grace window. */
export const LEAVE_CLOSE_CODE = 4000;

export function registerCoreWsHandlers({ registry, peers, sfu, db, auth, log, hooks, ws: wsServer }) {
    /**
     * Announce a peer to every OTHER connection, masked per recipient: members of a
     * private room see where they stand, everyone else sees them roomless.
     */
    const announcePeer = (peer, type = 'peer_joined') => {
        const view = PeerRegistry.publicView(peer);
        for (const other of peers.all) {
            if (other.cid === peer.cid) continue;
            wsServer.send(other.ws, type, { peer: viewFor(db, view, other.userId) });
        }
    };

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
        // A remembered private room is only re-entered by someone still on its list.
        let requested = msg.channelId ? getChannel(db, msg.channelId) : null;
        if (requested?.private && !isMember(db, requested.id, session.userId)) requested = null;
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
            // to find out. Masked per viewer: private rooms keep their secret.
            peers: snapshotFor(db, peers.snapshot(ws.cid), session.userId),
            ...(channel ? { rtpCapabilities: sfu.rtpCapabilities(channel.id) } : {}),
        });

        // Everyone hears about an arrival, wherever they stand — the frame carries the
        // channel, so every sidebar files them correctly. Masked per recipient.
        announcePeer(peer);
        if (channel?.private) touchOccupancy(db, channel.id);
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
        announcePeer(peer);
        const fromChannel = getChannel(db, from);
        if (fromChannel?.private) touchOccupancy(db, from);
        hooks.emit(HOOKS.PEER_MOVE, { peer, from, to: null, reason: 'left' });
    });

    // ── heartbeat ────────────────────────────────────────────────────────────
    // Browsers never surface protocol ping/pong to JS, so the client sends its own and
    // this answers. A reply also proves the path is alive in both directions, which a
    // half-open socket through a tunnel otherwise hides.
    registry.register('core', 'ping', ({ ws, send, msg }) => {
        // The pong carries the room's producer truth. A ping only arrives over a
        // provably healthy connection, which makes it the one reliable moment to
        // reconcile — the previous production server learned this the hard way: a
        // producer_new swallowed by a half-dead socket left one person silently unable
        // to hear one other person until somebody rejoined. Client-side healing that
        // reconciles against the client's own bookkeeping cannot recover from a missed
        // frame, because the bookkeeping missed it too. This snapshot is the server's
        // memory, not the client's.
        const peer = peers.get(ws.cid);
        const roomTruth = peer?.channelId
            ? peers.inChannel(peer.channelId, ws.cid).map((p) => ({
                cid: p.cid,
                producers: [...p.producers.entries()].map(([slot, producer]) => ({
                    slot, id: producer.id, kind: producer.kind, paused: producer.paused,
                })),
            }))
            : null;
        send('pong', { t: msg.t ?? null, ...(roomTruth ? { producers: roomTruth } : {}) });
    }, { auth: 'none' });

    // ── transports ───────────────────────────────────────────────────────────
    /**
     * The peer's transport for a direction, treating a CLOSED one as absent.
     *
     * mediasoup keeps a closed transport object perfectly inspectable, so a stale map
     * entry answers `has()` truthfully and every guard built on it silently means the
     * opposite of what it reads. Asking "is there a usable transport" is the only
     * question any caller here actually has.
     */
    const liveTransport = (peer, direction) => {
        const transport = peer.transports.get(direction);
        if (!transport) return null;
        if (transport.closed) {
            peer.transports.delete(direction);
            return null;
        }
        return transport;
    };

    registry.register('core', 'createTransport', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const direction = msg.direction;
        if (direction !== 'send' && direction !== 'recv') {
            return fail(ws, 'bad_direction', 'Transport direction must be "send" or "recv".');
        }
        // Asking for a transport REPLACES whatever this peer had for that direction.
        //
        // The old guard refused with "transport_exists", which protected nothing real: a
        // client only asks when it has no usable transport of its own, and once it has
        // dropped its end, the server's half is unreachable by anyone. Meanwhile the map
        // entry was never deleted — not on close, not on DTLS ending — so after any
        // client-side media rebuild (an ICE failure, a microphone disappearing, a
        // recovery cycle) every subsequent request was refused for as long as the peer
        // stayed in the room. The client could not rebuild and could not consume anyone;
        // two people sat in a room unable to hear each other while the server logged
        // nothing at all, because fail() was silent too. Both halves of that are fixed:
        // this replaces rather than refuses, and fail() now logs.
        const previous = peer.transports.get(direction);
        if (previous) {
            ws.log.info({ evt: 'transport.replaced', direction, closed: previous.closed },
                `Replacing this peer's ${direction} transport`);
            try { previous.close(); } catch { /* already gone */ }
            peer.transports.delete(direction);
        }

        const transport = await sfu.createTransport(peer.channelId, { direction });
        peer.transports.set(direction, transport);

        // The slot frees itself the moment the transport dies, whoever closed it and for
        // whatever reason — DTLS ending, the router going away, an explicit close.
        transport.observer.on('close', () => {
            if (peer.transports.get(direction) === transport) peer.transports.delete(direction);
        });

        transport.on('dtlsstatechange', (state) => {
            // 'failed' as well as 'closed'. Only 'closed' used to be handled, so a DTLS
            // handshake that failed mid-call left an OPEN transport sitting in the peer's
            // slot: liveTransport() handed it back as usable, produce and consume
            // succeeded against it, and the RTP went nowhere. Closing it frees the slot
            // and lets the client rebuild, which is the whole point of noticing.
            if (state === 'failed' || state === 'closed') {
                ws.log.warn({ evt: 'transport.dtls', direction, state }, `DTLS ${state} on ${direction}`);
                transport.close();
            }
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
        const transport = liveTransport(peer, msg.direction);
        if (!transport) return fail(ws, 'no_transport', 'That transport does not exist.');

        await transport.connect({ dtlsParameters: msg.dtlsParameters });
        send('transportConnected', { direction: msg.direction });
    });

    /**
     * Restart ICE on an existing transport, keeping everything that rides on it.
     *
     * The cheap rung of the client's recovery ladder. A transport whose path has died —
     * a NAT rebinding moved the client's UDP mapping, a laptop hopped from wifi to LTE —
     * used to be repairable only by tearing the whole thing down and building another:
     * a fresh DTLS handshake, every consumer recreated, and a second or two of silence.
     * New ICE credentials fix the path in place instead, with every producer and consumer
     * on it untouched.
     *
     * mediasoup's docs say an application SHOULD close a transport whose ICE state has
     * gone 'disconnected', because a consent-timeout is not recoverable. That advice is
     * for an application with nowhere else to go. restartIce() exists precisely to put
     * ICE back to 'new', so we try it first and close second — the docs' advice is the
     * client's next rung, not its first.
     */
    registry.register('core', 'restartIce', async ({ ws, msg, send, fail }) => {
        const peer = peers.get(ws.cid);
        const direction = msg.direction;
        if (direction !== 'send' && direction !== 'recv') {
            return fail(ws, 'bad_direction', 'Transport direction must be "send" or "recv".');
        }

        const transport = liveTransport(peer, direction);
        if (!transport) return fail(ws, 'no_transport', 'That transport does not exist.');

        const iceParameters = await transport.restartIce();
        ws.log.info({ evt: 'transport.ice_restarted', direction }, `ICE restarted on ${direction}`);

        // The id is echoed so the client can prove the transport it holds is the one that
        // was restarted, rather than assuming its own bookkeeping is still in step.
        send('iceRestarted', { direction, id: transport.id, iceParameters });
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
        // SCREEN_AUDIO belongs to the screen share, not to voice. It used to be in neither
        // list, so it passed BOTH gates — a channel with voice switched off would still
        // carry a peer's system audio. Following allowVideo rather than allowVoice is
        // deliberate: the seeded "Away" room keeps video enabled precisely so a running
        // share is not killed by going idle, and the share's audio must survive with it.
        const isVideo = slot === SLOTS.SCREEN || slot === SLOTS.WEBCAM || slot === SLOTS.SCREEN_AUDIO;
        if (isVoice && !channel.allowVoice) {
            return fail(ws, 'voice_not_allowed', `Voice is not enabled in ${channel.name}.`);
        }
        if (isVideo && !channel.allowVideo) {
            return fail(ws, 'video_not_allowed', `Video is not enabled in ${channel.name}.`);
        }

        // Checked BEFORE the replace below. mediasoup would reject these anyway, but by
        // then the replace has already closed a working producer — so a malformed frame
        // cost the sender their live stream instead of costing them an error.
        if (msg.kind !== 'audio' && msg.kind !== 'video') {
            return fail(ws, 'bad_kind', 'kind must be "audio" or "video".');
        }
        if (!msg.rtpParameters || typeof msg.rtpParameters !== 'object'
            || !Array.isArray(msg.rtpParameters.codecs) || msg.rtpParameters.codecs.length === 0) {
            return fail(ws, 'bad_rtp_parameters', 'rtpParameters must carry at least one codec.');
        }

        const transport = liveTransport(peer, 'send');
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
        producer.on('transportclose', () => {
            peer.producers.delete(slot);
            // Announced, not just forgotten. A transport dying used to remove the producer
            // silently, so every other client's roster went on listing a stream that no
            // longer existed — and the reconciler, seeing no producer, skipped the peer
            // entirely rather than reporting them. Whoever was listening deserves to know.
            toChannel(peer.channelId, 'producer_closed',
                { cid: peer.cid, slot, producerId: producer.id }, peer.cid);
        });
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
        const transport = liveTransport(peer, 'recv');
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
        consumer.on('transportclose', () => {
            peer.consumers.delete(consumer.id);
            // Told, not just dropped. Without this the client keeps the consumer in its
            // own map, and consume()'s duplicate guard then refuses to rebuild it — so the
            // server's own reconciler could re-announce the producer for ever and the
            // listener stayed permanently deaf to that one person, with no error anywhere.
            send('consumerClosed', { consumerId: consumer.id, cid: target.cid, slot: msg.slot });
        });
        consumer.on('producerclose', () => {
            peer.consumers.delete(consumer.id);
            send('consumerClosed', { consumerId: consumer.id, cid: target.cid, slot: msg.slot });
        });

        // Scores are reported against NAMES, because "consumer 4f2a scored 3" is a number
        // nobody can act on, and "ada is receiving grace badly" is a thing to go and look
        // at. This is the only place that knows both ends.
        sfu.observeQuality(consumer, {
            listener: peer.username, speaker: target.username, slot: msg.slot,
        });

        // Logged because its ABSENCE is the failure: producing was always visible in the
        // journal while consuming never was, so "everyone is producing, nobody hears
        // anything" looked identical to a perfectly healthy room.
        ws.log.info({
            evt: 'consume.started',
            listener: peer.username,
            speaker: target.username,
            slot: msg.slot,
        }, `${peer.username} is now receiving ${target.username}'s ${msg.slot}`);

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
        if (channel.private && !isMember(db, channel.id, peer.userId)) {
            return fail(ws, 'not_a_member', `${channel.name} is private — a member has to add you.`);
        }
        if (channel.id === peer.channelId) return send('moved', { channel, reason: 'self' });

        const from = peer.channelId;
        movePeer({ db, peer, channel, peers, sfu, ws: wsServer, hooks, reason: 'self' });
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
            db, peer: target, channel, peers, sfu, ws: wsServer, hooks,
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
