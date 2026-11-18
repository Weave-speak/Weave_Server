// Web Push, the two halves a sender owns: message encryption (RFC 8291) and the
// application server's identity (VAPID, RFC 8292).
//
// Written against node:crypto rather than taken as a dependency. The protocol is small and
// fixed — one ECDH, two HKDF extracts, one AES-GCM record, one ES256 signature — and the
// usual package for it pulls in an HTTP client, a JWT library and an ASN.1 parser to do
// what is about eighty lines here. A dependency on the path that carries a call to
// somebody's phone is a dependency whose every release has to be read; this file is read
// once and tested against the RFC's own worked example.
//
// What this file does NOT do is send anything. It builds a request; index.js decides who
// it goes to and what to do with the answer. That split is what lets the crypto be tested
// byte for byte with no network and no database.

import crypto from 'node:crypto';

/** One aes128gcm record holds the whole message: Web Push caps a message at 4096 bytes. */
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
// salt(16) + rs(4) + idlen(1) + keyid(65): the header RFC 8291 §4 fixes for Web Push.
const HEADER_BYTES = SALT_BYTES + 4 + 1 + 65;
/** The most plaintext one record can carry: the record, less header, tag and delimiter. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;

/** VAPID tokens may live 24 hours (RFC 8292 §2). Half that leaves room for a slow clock. */
const VAPID_LIFETIME_S = 12 * 60 * 60;

export const URGENCIES = Object.freeze(['very-low', 'low', 'normal', 'high']);

/* ── encoding ──────────────────────────────────────────────────────────────── */

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Decode base64url, accepting the padded standard alphabet too.
 *
 * Browsers hand out keys as base64url, but a key that has been through a Java or Kotlin
 * Base64 encoder on its way here may arrive padded and with `+/`. Refusing those would be
 * pedantry that costs a phone its calls; anything else that is not base64 is refused.
 */
export function fromB64u(text) {
    if (typeof text !== 'string') return null;
    const normal = text.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!B64URL_RE.test(normal)) return null;
    return Buffer.from(normal, 'base64url');
}

export const toB64u = (buf) => Buffer.from(buf).toString('base64url');

/* ── keys ──────────────────────────────────────────────────────────────────── */

/**
 * Whether `raw` is an uncompressed P-256 public key that lies on the curve.
 *
 * Checked when a subscription is stored, not when a ring is sent: a key that cannot be
 * used should be refused to the device that offered it, not discovered by a caller.
 */
export function isP256PublicKey(raw) {
    if (!Buffer.isBuffer(raw) || raw.length !== 65 || raw[0] !== 0x04) return false;
    // The same ECDH every message will do with it: if this throws, so would every ring.
    try {
        const probe = crypto.createECDH('prime256v1');
        probe.generateKeys();
        probe.computeSecret(raw);
        return true;
    } catch {
        return false;
    }
}

/**
 * A fresh VAPID key pair, both halves base64url: the public key as the 65-byte
 * uncompressed point every push service and the UnifiedPush connector expect, the private
 * key as the 32-byte scalar.
 */
export function generateVapidKeys() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { publicKey: toB64u(ecdh.getPublicKey()), privateKey: toB64u(ecdh.getPrivateKey()) };
}

/* ── RFC 8291: message encryption ──────────────────────────────────────────── */

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * The content key and nonce for one message. Exported for the test against RFC 8291
 * Appendix A, which publishes both; everything else should call `encrypt`.
 *
 * Every HKDF here is a single block (L ≤ 32), so HKDF-Expand is one HMAC with a 0x01
 * counter byte — the RFC writes it out that way too.
 */
export function deriveContentKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const prkKey = hmac(authSecret, ecdhSecret);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    return { cek, nonce };
}

/**
 * Encrypt one push message for one subscription. Returns the request body.
 *
 * `p256dh` and `auth` are the subscription's keys as raw Buffers. `fixed` exists only so
 * the test can supply the RFC's salt and sender key; in use both are fresh per message,
 * which is the whole of the scheme's forward secrecy.
 */
export function encrypt(plaintext, { p256dh, auth }, fixed = {}) {
    const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    if (data.length > MAX_PAYLOAD_BYTES) {
        throw new RangeError(`Push payload is ${data.length} bytes; one message carries at most ${MAX_PAYLOAD_BYTES}`);
    }

    const sender = crypto.createECDH('prime256v1');
    if (fixed.asPrivateKey) sender.setPrivateKey(fixed.asPrivateKey);
    else sender.generateKeys();
    const asPublic = sender.getPublicKey();
    const salt = fixed.salt ?? crypto.randomBytes(SALT_BYTES);

    const ecdhSecret = sender.computeSecret(p256dh);
    const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret: auth, uaPublic: p256dh, asPublic, salt });

    // 0x02 marks the last (here, only) record. No padding: the payload's length says
    // "a call" either way, and padding would only spend the 4 KB budget.
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(HEADER_BYTES);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
    header.writeUInt8(asPublic.length, SALT_BYTES + 4);
    asPublic.copy(header, SALT_BYTES + 5);
    return Buffer.concat([header, sealed]);
}

/* ── RFC 8292: VAPID ───────────────────────────────────────────────────────── */

/**
 * The Authorization header value for one push service.
 *
 * The audience is the endpoint's ORIGIN, never its path: the path is the subscription's
 * secret, and a token naming it would hand that secret to anything that logs headers.
 * `subject` is a contact for the push service's operator (mailto: or https:); RFC 8292
 * says SHOULD, so a server with nothing honest to put there sends none rather than an
 * invented address.
 */
export function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = Date.now() }) {
    const pub = fromB64u(publicKey);
    const d = fromB64u(privateKey);
    const key = crypto.createPrivateKey({
        key: {
            kty: 'EC', crv: 'P-256',
            x: toB64u(pub.subarray(1, 33)), y: toB64u(pub.subarray(33, 65)), d: toB64u(d),
        },
        format: 'jwk',
    });

    const header = toB64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = toB64u(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + VAPID_LIFETIME_S,
        ...(subject ? { sub: subject } : {}),
    }));
    const signingInput = `${header}.${claims}`;
    // JOSE wants r||s, not the DER that node:crypto produces by default.
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${signingInput}.${toB64u(signature)}, k=${publicKey}`;
}

/* ── the request ───────────────────────────────────────────────────────────── */

/**
 * Everything `fetch` needs to deliver one message to one subscription.
 *
 * `topic` lets a push service replace a message it is still holding with a newer one of
 * the same topic — a ring superseded by its own cancel never reaches a phone that was
 * offline for both. RFC 8030 limits it to 32 base64url characters, so anything else is
 * dropped rather than sent and refused.
 */
export function buildPushRequest({ subscription, payload, vapid, ttl = 60, urgency = 'normal', topic, now }) {
    const body = encrypt(JSON.stringify(payload), {
        p256dh: fromB64u(subscription.p256dh),
        auth: fromB64u(subscription.auth),
    });
    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.length),
        TTL: String(Math.max(0, Math.floor(ttl))),
        Urgency: URGENCIES.includes(urgency) ? urgency : 'normal',
        Authorization: vapidAuthorization({ endpoint: subscription.endpoint, ...vapid, now }),
    };
    if (typeof topic === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;
    return { url: subscription.endpoint, method: 'POST', headers, body };
}
