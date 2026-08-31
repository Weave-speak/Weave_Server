// The wire contract between server and client.
//
// This file is the source of truth and is vendored into Weave_Client, with a CI check
// that fails if the two copies drift.
//
// TWO INDEPENDENT NUMBERS, and conflating them is a known way to strand users:
//
//   Product version — semver, for humans. Shown in the UI and in bug reports.
//                     NEVER gate behaviour on it.
//   Protocol version — a monotonic integer. This is what negotiation uses.
//
// Negotiation is a RANGE OVERLAP, never an equality check. Equality is what produces
// the failure mode where a slightly newer client flatly refuses a working server.
// Additive changes ship as a feature flag and do not bump the protocol at all.

export const PROTOCOL = Object.freeze({
    /** Oldest protocol this server still speaks. Raise only when dropping support. */
    MIN: 1,
    /** Newest protocol this server speaks. Bump on a breaking wire change. */
    MAX: 1,
});

/**
 * Capabilities advertised to clients. A client renders to what the server actually has,
 * which is what makes disabling a module a real, visible thing rather than a setting
 * that leaves dead UI behind.
 *
 * Core capabilities are listed here. Enabled modules append their own ids.
 */
export const CORE_FEATURES = Object.freeze([
    'auth.invite',
    'auth.recovery',
    'channels.dynamic',
    'media.sfu',
    'media.tcp-fallback',
    // Advertised so a client knows it may try the cheap repair before the expensive one.
    // Against a server without it, the client skips straight to rebuilding the transport,
    // which is exactly what every client did before this existed.
    'media.ice-restart',
    // An administrator can put somebody in a channel. The handler has existed since the
    // signalling was written but was never advertised, so no client ever offered it.
    'peers.admin-move',
    // Server mute and kick. Advertised so a client renders those menu entries only where
    // pressing them will do something — against an older server they are simply absent,
    // rather than present and failing.
    'moderation',
]);

export class ProtocolMismatchError extends Error {
    constructor(message, detail) {
        super(message);
        this.detail = detail;
    }
}

/**
 * Agree a protocol version with a client.
 *
 * Both sides declare a range; we operate at the highest version both understand. The
 * error text is written for the person reading it, because "protocol mismatch" with no
 * numbers has never helped anyone.
 */
export function negotiate(clientMin, clientMax) {
    if (!Number.isInteger(clientMin) || !Number.isInteger(clientMax) || clientMin > clientMax) {
        throw new ProtocolMismatchError(
            'This client sent an invalid protocol range.',
            { clientMin, clientMax, serverMin: PROTOCOL.MIN, serverMax: PROTOCOL.MAX },
        );
    }

    const agreed = Math.min(clientMax, PROTOCOL.MAX);

    if (agreed < Math.max(clientMin, PROTOCOL.MIN)) {
        const clientIsOlder = clientMax < PROTOCOL.MIN;
        throw new ProtocolMismatchError(
            clientIsOlder
                ? 'This app is too old for this server. Update the app and try again.'
                : 'This server is too old for this app. Ask the server administrator to update it.',
            { clientMin, clientMax, serverMin: PROTOCOL.MIN, serverMax: PROTOCOL.MAX },
        );
    }

    return agreed;
}
