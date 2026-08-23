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

export async function createSfu({ config, log }) {
    const sfuLog = log.child({ mod: 'sfu' });
    const { address: announcedAddress, source } = resolveAnnouncedAddress(config, sfuLog);

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

        const listenInfos = [
            {
                protocol: 'udp',
                ip: '0.0.0.0',
                announcedAddress,
                port,
                // Also advertise this machine's own address, so clients on the same LAN
                // can reach it directly instead of hairpinning out through the router
                // and back — many consumer routers cannot do that at all.
                exposeInternalIp: true,
            },
            {
                // Same port number on TCP. This is the fallback for networks that block
                // UDP outright, and it costs one extra firewall rule rather than a
                // separate port to remember.
                protocol: 'tcp',
                ip: '0.0.0.0',
                announcedAddress,
                port,
                exposeInternalIp: true,
            },
        ];

        const webRtcServer = await worker.createWebRtcServer({ listenInfos });
        const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

        workers.push({ index, port, worker, webRtcServer, router, channels: new Set() });
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
