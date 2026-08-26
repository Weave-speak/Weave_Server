// Watching the address clients are told to send media to.
//
// On a home line that address is a dynamic IP behind a dynamic-DNS name, and when the
// ISP moves it every client is left sending audio to somebody else's address. Signalling
// is unaffected — it rides an outbound tunnel — so the room looks completely healthy:
// everyone present, chat working, and total silence in both directions.
//
// The clients cannot notice this on their own. Their transports were built against the
// old address and stay there until ICE finally gives up, which on a real network takes
// upwards of twenty seconds per attempt. So the server watches instead, and the moment
// the name points somewhere new it tells everyone to rebuild.
//
// Two details matter, both learned the hard way:
//
//   * `dns.resolve4`, never `dns.lookup`. lookup() goes through the OS resolver and its
//     cache, which on this box was still answering with an address the line had not held
//     for half an hour. resolve4 asks a nameserver.
//
//   * An address that fails to resolve is NOT treated as a change. A DNS blip during an
//     outage would otherwise order every client in the building to rebuild for nothing.

import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Start watching. Returns a stop function.
 *
 * Does nothing at all when the announced address is a literal IP (there is nothing to
 * re-resolve) or when it is missing, so a LAN-only or fixed-address deployment carries
 * no timer and no DNS traffic.
 */
export function watchAnnouncedAddress({
    announcedAddress,
    log,
    peers,
    ws,
    sfu,
    intervalMs = DEFAULT_INTERVAL_MS,
    resolve = (host) => dns.resolve4(host),
    setTimer = setInterval,
    clearTimer = clearInterval,
}) {
    if (!announcedAddress || net.isIP(announcedAddress)) return () => {};

    // What the name pointed at when the current transports were built. Unknown until the
    // first successful resolution, which is deliberately NOT treated as a change.
    let known = null;

    async function check() {
        let addresses;
        try {
            addresses = (await resolve(announcedAddress)).slice().sort();
        } catch (err) {
            log.warn({ evt: 'sfu.announced_unresolved', announcedAddress, err: err?.code ?? String(err) },
                `Could not resolve ${announcedAddress}; leaving media as it is`);
            return;
        }
        if (!addresses.length) return;

        const now = addresses.join(',');
        if (known === null) {
            known = now;
            log.info({ evt: 'sfu.announced_resolved', announcedAddress, addresses },
                `${announcedAddress} currently points at ${now}`);
            return;
        }
        if (now === known) return;

        const previous = known;
        known = now;
        log.warn({ evt: 'sfu.announced_changed', announcedAddress, from: previous, to: now },
            `${announcedAddress} moved from ${previous} to ${now} — telling clients to rebuild media`);

        rebuildEveryone();
    }

    /**
     * Tell every peer standing in a channel to tear its media down and build it again.
     *
     * The frame carries the router's capabilities so a client can rebuild without a
     * round trip. Clients too old to know this frame ignore it and still recover the
     * slow way, which is exactly what they did before this existed.
     */
    function rebuildEveryone() {
        let told = 0;
        for (const peer of peers?.all ?? []) {
            if (!peer.channelId) continue;
            let rtpCapabilities = null;
            try {
                rtpCapabilities = sfu.routerFor(peer.channelId)?.rtpCapabilities ?? null;
            } catch {
                // A channel whose router has gone is not one we can rebuild into; the
                // peer's next move will sort it out.
                continue;
            }
            ws.send(peer.ws, 'media_reset', {
                reason: 'announced_address_changed',
                rtpCapabilities,
            });
            told += 1;
        }
        log.info({ evt: 'sfu.media_reset_sent', peers: told },
            `Asked ${told} peer(s) to rebuild their media path`);
    }

    const timer = setTimer(() => { check().catch(() => {}); }, intervalMs);
    // Never hold the process open for this.
    timer.unref?.();
    // And learn the current address immediately rather than one interval from now.
    check().catch(() => {});

    return () => clearTimer(timer);
}
