// A minimal STUN client (RFC 5389), used only by `weave doctor`.
//
// Why this exists at all: the single most common way to misconfigure a self-hosted SFU is
// to announce an address or port that is not the one the outside world would actually
// reach, and the symptom is the worst possible one — everything connects and then nobody
// hears anything.
//
// A STUN binding request sent FROM the media port reveals how the outside world sees that
// exact socket. If the reflexive port differs from the local one, the NAT is remapping and
// the announced port is wrong. If the reflexive address differs from what is announced,
// the announced address is wrong. Both are real, detectable misconfigurations.
//
// What this CANNOT do is prove inbound reachability. A STUN response only proves that a
// packet we sent got out and a reply came back on the same mapping. Whether an unsolicited
// inbound packet would arrive depends on the router's forwarding rules, which nothing
// inside this network can answer honestly. `doctor` says so rather than implying otherwise.

import dgram from 'node:dgram';
import crypto from 'node:crypto';

const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAGIC_COOKIE = 0x2112a442;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

/** Public STUN servers, tried in order. Chosen for being long-lived and unauthenticated. */
export const DEFAULT_STUN_SERVERS = [
    { host: 'stun.l.google.com', port: 19302 },
    { host: 'stun.cloudflare.com', port: 3478 },
];

function buildRequest(transactionId) {
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(BINDING_REQUEST, 0);
    msg.writeUInt16BE(0, 2); // no attributes
    msg.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(msg, 8);
    return msg;
}

function parseResponse(buf, transactionId) {
    if (buf.length < 20) return null;
    if (buf.readUInt16BE(0) !== BINDING_SUCCESS) return null;
    if (buf.readUInt32BE(4) !== MAGIC_COOKIE) return null;
    if (!buf.subarray(8, 20).equals(transactionId)) return null;

    const length = buf.readUInt16BE(2);
    let offset = 20;
    const end = Math.min(buf.length, 20 + length);

    while (offset + 4 <= end) {
        const type = buf.readUInt16BE(offset);
        const len = buf.readUInt16BE(offset + 2);
        const value = buf.subarray(offset + 4, offset + 4 + len);

        if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) {
            // family is value[1]; 0x01 is IPv4, which is all we care about here.
            if (value.length >= 8 && value[1] === 0x01) {
                const xor = type === ATTR_XOR_MAPPED_ADDRESS;
                const port = value.readUInt16BE(2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
                const raw = value.readUInt32BE(4) ^ (xor ? MAGIC_COOKIE : 0);
                const address = [raw >>> 24, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff].join('.');
                return { address, port };
            }
        }

        // Attributes are padded to a 4-byte boundary.
        offset += 4 + len + ((4 - (len % 4)) % 4);
    }
    return null;
}

/**
 * Ask a STUN server how it sees us.
 *
 * `localPort` matters: binding to the media port is the whole point, because it reveals
 * the mapping for the port clients will actually be told to use. Binding to an ephemeral
 * port would answer a question nobody asked.
 */
export function stunLookup({
    host, port = 3478, localPort = 0, timeoutMs = 2500,
} = {}) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const transactionId = crypto.randomBytes(12);
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closing */ }
            resolve(result);
        };

        const timer = setTimeout(
            () => finish({ ok: false, reason: `No reply from ${host}:${port} within ${timeoutMs}ms` }),
            timeoutMs,
        );

        socket.on('error', (err) => finish({ ok: false, reason: err.message }));

        socket.on('message', (buf) => {
            const mapped = parseResponse(buf, transactionId);
            if (!mapped) return; // not ours, or not a success response — keep waiting
            finish({ ok: true, ...mapped, localPort: socket.address().port, via: `${host}:${port}` });
        });

        socket.bind(localPort, () => {
            socket.send(buildRequest(transactionId), port, host, (err) => {
                if (err) finish({ ok: false, reason: err.message });
            });
        });
    });
}

/** Try each server in turn; the first that answers wins. */
export async function discoverMapping({ localPort = 0, servers = DEFAULT_STUN_SERVERS, timeoutMs = 2500 } = {}) {
    const failures = [];
    for (const server of servers) {
        const result = await stunLookup({ ...server, localPort, timeoutMs });
        if (result.ok) return result;
        failures.push(`${server.host}: ${result.reason}`);
    }
    return { ok: false, reason: failures.join('; ') };
}
