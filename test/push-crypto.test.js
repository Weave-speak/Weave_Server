// Web Push encryption and VAPID, byte for byte.
//
// The crypto is hand-written against node:crypto (see webpush.js for why), so it is held
// to the RFC's own worked example rather than to a round trip through itself: a round trip
// passes just as happily with the HKDF info strings misspelt on both sides, and a phone
// would then fail to decrypt every ring with no error anywhere a person could see.
//
// The keys below are RFC 8291 Appendix A's published example keys, not secrets.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    encrypt, deriveContentKeys, vapidAuthorization, generateVapidKeys, buildPushRequest,
    fromB64u, toB64u, isP256PublicKey, MAX_PAYLOAD_BYTES,
} from '../src/core/push/webpush.js';

// RFC 8291 Appendix A.
const RFC = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', // gitleaks:allow (RFC 8291 example key)
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', // gitleaks:allow (RFC 8291 example key)
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    authSecret: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow (RFC 8291 example value)
    cek: 'oIhVW04MRdy2XN9CiKLxTg',
    nonce: '4h_95klXJ5E_qnoN',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The receiving side, written out independently of webpush.js, for round trips. */
function decrypt(body, { uaPrivate, authSecret }) {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const sealed = body.subarray(21 + idlen);
    const ua = crypto.createECDH('prime256v1');
    ua.setPrivateKey(uaPrivate);
    const { cek, nonce } = deriveContentKeys({
        ecdhSecret: ua.computeSecret(asPublic), authSecret, uaPublic: ua.getPublicKey(), asPublic, salt,
    });
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    assert.equal(padded.at(-1), 2, 'a single record ends in the last-record delimiter');
    return { rs, text: padded.subarray(0, -1).toString('utf8') };
}

test('RFC 8291 Appendix A: the same inputs give the published message, byte for byte', () => {
    const body = encrypt(RFC.plaintext, { p256dh: fromB64u(RFC.uaPublic), auth: fromB64u(RFC.authSecret) }, {
        salt: fromB64u(RFC.salt), asPrivateKey: fromB64u(RFC.asPrivate),
    });
    assert.equal(toB64u(body), RFC.body);
});

test('RFC 8291 Appendix A: the content key and nonce match the published intermediates', () => {
    const as = crypto.createECDH('prime256v1');
    as.setPrivateKey(fromB64u(RFC.asPrivate));
    assert.equal(toB64u(as.getPublicKey()), RFC.asPublic, 'the example key pair is the one we think it is');
    const { cek, nonce } = deriveContentKeys({
        ecdhSecret: as.computeSecret(fromB64u(RFC.uaPublic)),
        authSecret: fromB64u(RFC.authSecret),
        uaPublic: fromB64u(RFC.uaPublic),
        asPublic: as.getPublicKey(),
        salt: fromB64u(RFC.salt),
    });
    assert.equal(toB64u(cek), RFC.cek);
    assert.equal(toB64u(nonce), RFC.nonce);
});

test('the user agent can read the RFC message, and a fresh one of ours', () => {
    const keys = { uaPrivate: fromB64u(RFC.uaPrivate), authSecret: fromB64u(RFC.authSecret) };
    assert.deepEqual(decrypt(fromB64u(RFC.body), keys), { rs: 4096, text: RFC.plaintext });

    const payload = JSON.stringify({ v: 1, kind: 'ring', callId: 'abc' });
    const sub = { p256dh: fromB64u(RFC.uaPublic), auth: fromB64u(RFC.authSecret) };
    const one = encrypt(payload, sub);
    const two = encrypt(payload, sub);
    assert.equal(decrypt(one, keys).text, payload);
    assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16), 'a fresh salt every message');
    assert.notDeepEqual(one.subarray(21, 86), two.subarray(21, 86), 'and a fresh sender key');
});

test('a payload one record cannot carry is refused, not truncated', () => {
    const sub = { p256dh: fromB64u(RFC.uaPublic), auth: fromB64u(RFC.authSecret) };
    assert.equal(encrypt('x'.repeat(MAX_PAYLOAD_BYTES), sub).length, 4096);
    assert.throws(() => encrypt('x'.repeat(MAX_PAYLOAD_BYTES + 1), sub), RangeError);
});

test('keys: only uncompressed P-256 points on the curve pass; base64 in either alphabet decodes', () => {
    assert.equal(isP256PublicKey(fromB64u(RFC.uaPublic)), true);
    const offCurve = Buffer.from(fromB64u(RFC.uaPublic));
    offCurve[64] ^= 1;
    assert.equal(isP256PublicKey(offCurve), false, 'a point off the curve');
    assert.equal(isP256PublicKey(fromB64u(RFC.uaPublic).subarray(0, 33)), false, 'a compressed-length key');
    const standard = fromB64u(RFC.uaPublic).toString('base64');
    assert.deepEqual(fromB64u(standard), fromB64u(RFC.uaPublic), 'padded standard base64 is accepted');
    assert.equal(fromB64u('not base64!'), null);
});

test('VAPID: an ES256 token for the endpoint origin, verifiable with the advertised key', () => {
    const keys = generateVapidKeys();
    assert.equal(fromB64u(keys.publicKey).length, 65);
    assert.equal(fromB64u(keys.privateKey).length, 32);

    const now = Date.UTC(2026, 10, 17, 12, 0, 0);
    const header = vapidAuthorization({
        endpoint: 'https://push.example.net/up/secret-path?x=1', ...keys, subject: 'https://weave.example.com', now,
    });
    const match = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
    assert.ok(match, header);
    const [, jwt, k] = match;
    assert.equal(k, keys.publicKey);

    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(fromB64u(h)), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromB64u(c));
    assert.equal(claims.aud, 'https://push.example.net', 'the origin only — never the secret path');
    assert.equal(claims.sub, 'https://weave.example.com');
    assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600, 'expires within 24 hours');
    assert.ok(!jwt.includes('secret-path'));

    const raw = fromB64u(k);
    const pub = crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: toB64u(raw.subarray(1, 33)), y: toB64u(raw.subarray(33)) }, format: 'jwk',
    });
    const signature = fromB64u(s);
    assert.equal(signature.length, 64, 'JOSE r||s, not DER');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, signature));

    const other = generateVapidKeys();
    const otherRaw = fromB64u(other.publicKey);
    const otherPub = crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: toB64u(otherRaw.subarray(1, 33)), y: toB64u(otherRaw.subarray(33)) }, format: 'jwk',
    });
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: otherPub, dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('VAPID: no contact configured sends no sub claim rather than an invented one', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({ endpoint: 'https://push.example.net/x', ...keys, subject: null });
    const claims = JSON.parse(fromB64u(header.split('t=')[1].split('.')[1]));
    assert.equal('sub' in claims, false);
});

test('the request: aes128gcm body, TTL, Urgency, and a Topic only when it is legal', () => {
    const vapid = generateVapidKeys();
    const subscription = { endpoint: 'https://push.example.net/abc', p256dh: RFC.uaPublic, auth: RFC.authSecret };
    const payload = { v: 1, kind: 'ring', callId: 'Q2FsbElkMTIzNDU2Nzg5MA' };

    const req = buildPushRequest({ subscription, payload, vapid, ttl: 45, urgency: 'high', topic: payload.callId });
    assert.equal(req.url, subscription.endpoint);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(req.headers.TTL, '45');
    assert.equal(req.headers.Urgency, 'high');
    assert.equal(req.headers.Topic, payload.callId);
    assert.match(req.headers.Authorization, /^vapid t=.+, k=/);
    const keys = { uaPrivate: fromB64u(RFC.uaPrivate), authSecret: fromB64u(RFC.authSecret) };
    assert.deepEqual(JSON.parse(decrypt(req.body, keys).text), payload);

    const odd = buildPushRequest({ subscription, payload, vapid, urgency: 'shouting', topic: 'has spaces and is far too long to be a topic' });
    assert.equal(odd.headers.Urgency, 'normal');
    assert.equal('Topic' in odd.headers, false);
});
