// The SFU: mediasoup workers, routers and transports.
//
// Weave is a selective forwarding unit, not a mesh. Everyone sends one upstream to the
// server and the server forwards. An eight-person call therefore costs each participant
// one upload instead of seven, which is the whole reason a Raspberry Pi can host it.
//
// Two design points that differ from the previous server:
//
// ONE PORT PER WORKER, not a 101-port range. A `WebRtcServer` consolidates every
// transport onto a single port, so a self-hoster forwards one rule instead of a range,
// and — because the port is now a fixed known number — it can actually be tested.
// Workers cannot share a port: `udpReusePort` exists but is meant for multicast plain
// transport, and under SO_REUSEPORT the kernel hashes packets to whichever socket it
// likes, which for ICE means traffic can land on a worker that does not own the
// transport. So worker N owns port `mediaPort + N`.
//
// TCP IS ENABLED. mediasoup defaults `enableTcp` to false, so the previous server had
// no fallback at all: a user on a UDP-blocking network (corporate, hotel, some mobile
// carriers) simply failed, with nothing to diagnose. ICE-TCP on the same port number is
// slower but it works, and the connection panel can then say something true.

import os from 'node:os';
import dgram from 'node:dgram';
import mediasoup from 'mediasoup';

/**
 * Codec list.
 *
 * H264 is offered before VP8 deliberately: most phones and many laptops have a hardware
 * H264 encoder and will burn noticeably less battery using it. Opus carries in-band FEC
 * so a lost packet can often be reconstructed from the next one, which matters far more
 * for perceived call quality than bitrate does.
 */
export const MEDIA_CODECS = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1, minptime: 10 },
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
        },
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 },
    },
];

/**
 * Work out what address to hand clients for media.
 *
 * This is the single most common thing to get wrong, and getting it wrong produces the
 * worst symptom: everything connects, nobody hears anything. So the resolution order is
 * explicit and every fallback is logged.
 *
 * No network call is made here — a server should not reach out to a third party during
 * boot just to learn its own address. `weave doctor` probes on demand instead.
 */
/**
 * The address this machine is actually reachable on from its own network.
 *
 * Picked by asking the routing table which local address would be used to reach the
 * internet — NOT by taking the first non-internal interface, because this box also runs
 * Docker and would happily hand out a `172.x` bridge address that no client can reach.
 * No packet is sent: connect() on a UDP socket only fixes the local end.
 */
export function detectLocalAddress() {
    return new Promise((resolve) => {
        let settled = false;
        const socket = dgram.createSocket('udp4');
        const finish = (value) => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch { /* never opened */ }
            resolve(value);
        };
        // Never let a boot hang on this: without an answer the server still starts, it
        // just cannot offer clients on its own network a direct path.
        const timer = setTimeout(() => finish(null), 500);
        socket.on('error', () => { clearTimeout(timer); finish(null); });
        // connect() on a UDP socket sends nothing — it asks the routing table which local
        // address WOULD be used, and binds that end. The destination is TEST-NET-3, which
        // is reserved for documentation and routed nowhere.
        socket.connect(53, '203.0.113.1', () => {
            clearTimeout(timer);
            const address = socket.address()?.address ?? null;
            finish(address && address !== '0.0.0.0' ? address : null);
        });
    });
}

export function resolveAnnouncedAddress(config, log) {
    if (config.announcedAddress) {
        return { address: config.announcedAddress, source: 'configured' };
    }

    const candidates = Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address);

    if (candidates.length) {
        const address = candidates[0];
        log.warn(
            { evt: 'sfu.announced_guessed', address, candidates },
            `WEAVE_ANNOUNCED_ADDRESS is not set; guessing ${address}. Clients outside this `
            + 'network will connect and then hear nothing. Set it to your public hostname or IP.',
        );
        return { address, source: 'guessed' };
    }

    log.error(
        { evt: 'sfu.announced_missing' },
        'No non-loopback address found and WEAVE_ANNOUNCED_ADDRESS is not set. '
        + 'Media will only work from this machine.',
    );
    return { address: '127.0.0.1', source: 'loopback' };
}

export async function createSfu({ config, log, hooks }) {
    const sfuLog = log.child({ mod: 'sfu' });
    const { address: announcedAddress, source } = resolveAnnouncedAddress(config, sfuLog);

    // The second candidate: how clients on this machine's own network reach it directly.
    const localAddress = await detectLocalAddress();
    if (localAddress) {
        sfuLog.info({ evt: 'sfu.local_address', localAddress },
            `Clients on this network will be offered ${localAddress} directly`);
    } else {
        sfuLog.warn({ evt: 'sfu.local_address_unknown' },
            "Could not work out this machine's own network address; clients on the same "
            + 'network will have to reach the announced address through the router');
    }

    const workers = [];

    for (let index = 0; index < config.sfuWorkers; index += 1) {
        const port = config.mediaPort + index;

        const worker = await mediasoup.createWorker({
            logLevel: 'warn',
            logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        });

        // A dead worker means every call it was carrying is gone. There is no recovering
        // the media state, so fail loudly and let the service manager restart us rather
        // than limping along serving silence.
        worker.on('died', (err) => {
            sfuLog.fatal({ evt: 'sfu.worker_died', index, err },
                `mediasoup worker ${index} died; exiting so the service manager restarts us`);
            process.exit(1);
        });

        // Bind to the address this machine is really reachable on, not the wildcard.
        //
        // `exposeInternalIp` advertises the BIND address as a second candidate, for
        // clients on the same network as the server. Bound to '0.0.0.0' it did exactly
        // that — and advertised the literal string "0.0.0.0", an address nothing can ever
        // connect to. Every client wasted an ICE check on it, and clients on the SAME LAN
        // as the server were left with no local candidate at all: their only path was out
        // to the announced public address and back in through the router, which many
        // consumer routers cannot do (NAT hairpinning). When that router also cannot
        // hairpin, ICE finds no working path whatsoever and the call connects, shows
        // everyone present, and carries no audio in either direction.
        const bindIp = localAddress ?? '0.0.0.0';
        const exposeInternalIp = bindIp !== '0.0.0.0';

        const listenInfos = [
            {
                protocol: 'udp',
                ip: bindIp,
                announcedAddress,
                port,
                exposeInternalIp,
            },
            {
                // Same port number on TCP. This is the fallback for networks that block
                // UDP outright, and it costs one extra firewall rule rather than a
                // separate port to remember.
                protocol: 'tcp',
                ip: bindIp,
                announcedAddress,
                port,
                exposeInternalIp,
            },
        ];

        const webRtcServer = await worker.createWebRtcServer({ listenInfos });
        const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

        // Real per-packet audio levels, straight off the RTP stream. This is a
        // server-side measurement, so nothing depends on trusting a client to report
        // honestly about itself, and muting genuinely pauses the producer so silence
        // needs no special case.
        //
        // maxEntries is load-bearing rather than tuning: mediasoup defaults it to 1, and
        // at 1 the observer reports only the single loudest speaker per interval and
        // misses everyone else's activity entirely.
        const audioObserver = await router.createAudioLevelObserver({
            maxEntries: 32,
            // Louder than mediasoup's -80 default so a quiet room is not "activity".
            threshold: -65,
            interval: 2000,
        });

        audioObserver.on('volumes', (volumes) => {
            for (const { producer, volume } of volumes) {
                hooks?.emit('mic:activity', {
                    cid: producer.appData?.cid,
                    userId: producer.appData?.userId,
                    producerId: producer.id,
                    volume,
                });
            }
        });

        workers.push({ index, port, worker, webRtcServer, router, audioObserver, channels: new Set() });
        sfuLog.info({ evt: 'sfu.worker_ready', index, port, pid: worker.pid },
            `mediasoup worker ${index} listening on UDP+TCP ${port}`);
    }

    // Which worker serves which channel. Everyone in a channel MUST share a router,
    // because a consumer can only consume a producer on its own router — routing them
    // apart would need pipe transports between workers, which is a lot of complexity to
    // buy nothing at this scale.
    const channelWorker = new Map();

    function workerForChannel(channelId) {
        const existing = channelWorker.get(channelId);
        if (existing !== undefined) return workers[existing];

        // Least-loaded by channel count. Good enough: channels are long-lived and few,
        // so anything cleverer would be guessing at a distribution we can just measure.
        const chosen = workers.reduce((a, b) => (a.channels.size <= b.channels.size ? a : b));
        chosen.channels.add(channelId);
        channelWorker.set(channelId, chosen.index);

        sfuLog.debug({ evt: 'sfu.channel_assigned', channel: channelId, worker: chosen.index },
            `Channel ${channelId} assigned to worker ${chosen.index}`);
        return chosen;
    }

    return {
        announcedAddress,
        announcedSource: source,
        ports: workers.map((w) => w.port),

        /** RTP capabilities a client needs before it can decide what it can send or receive. */
        rtpCapabilities(channelId) {
            return workerForChannel(channelId).router.rtpCapabilities;
        },

        routerFor(channelId) {
            return workerForChannel(channelId).router;
        },

        /**
         * Which worker serves a channel.
         *
         * Needed because a transport belongs to the router that created it, and a router
         * belongs to one worker. Two channels on the same worker share a router, so media
         * survives a move between them; two channels on different workers do not, and a
         * peer moving across that line has to rebuild. Callers need to know which case
         * they are in, and only the SFU knows.
         */
        workerIndexFor(channelId) {
            return workerForChannel(channelId).index;
        },

        async createTransport(channelId) {
            const { router, webRtcServer } = workerForChannel(channelId);

            const transport = await router.createWebRtcTransport({
                webRtcServer,
                enableUdp: true,
                // Off by default in mediasoup. Leaving it off is why a UDP-blocked user
                // previously had no path at all.
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: 8_000_000,
            });

            return transport;
        },

        /**
         * Watch an audio producer for activity. Safe to call for any producer; only
         * audio is accepted by the observer.
         */
        async observeAudio(channelId, producer) {
            if (producer.kind !== 'audio') return;
            const { audioObserver } = workerForChannel(channelId);
            try {
                await audioObserver.addProducer({ producerId: producer.id });
            } catch (err) {
                // Never let observation failure break an otherwise working call.
                sfuLog.warn({ evt: 'sfu.observe_failed', err }, 'Could not observe an audio producer');
            }
        },

        /** Whether a channel can be served at all, for diagnostics. */
        get workerCount() { return workers.length; },

        /** Live picture for the admin panel and `weave doctor`. */
        async stats() {
            return Promise.all(workers.map(async (w) => ({
                index: w.index,
                port: w.port,
                pid: w.worker.pid,
                closed: w.worker.closed,
                channels: w.channels.size,
                resource: await w.worker.getResourceUsage().catch(() => null),
            })));
        },

        releaseChannel(channelId) {
            const index = channelWorker.get(channelId);
            if (index === undefined) return;
            workers[index].channels.delete(channelId);
            channelWorker.delete(channelId);
        },

        async close() {
            for (const w of workers) {
                // Removing the handler first: a worker closing on purpose would otherwise
                // fire 'died' and take the process down during a clean shutdown.
                w.worker.removeAllListeners('died');
                w.worker.close();
            }
            sfuLog.info({ evt: 'sfu.closed' }, 'mediasoup workers closed');
        },
    };
}
