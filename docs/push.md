# Rings and push

How a call reaches somebody: over their open socket if the app is running, and by
[Web Push](https://www.rfc-editor.org/rfc/rfc8030) if it is not. This page is the wire
contract a client is built against. Everything on it is additive: a server without
`push.webpush` in `features[]` has none of the push routes, and older clients ignore the
new fields.

| Feature flag | Means |
|---|---|
| `push.webpush` | `/api/push/*` exist, rings reach closed phones, registered phones stay signed in 30 idle days |
| `dm.calls.ids` | DM call frames carry `callId`; `POST /api/dm/threads/:id/call/decline` exists (`dm` 1.1.0) |
| `channels.private.ring` | Huddles ring their members (`private-channels` 1.1.0) |

## What the server needs

Nothing to configure. The server makes its push key (VAPID, RFC 8292) on the first start
after migration `012_push` and keeps it in the database; changing it would stop every
registered phone ringing until it registered again, so it is never rotated by accident.

It does need to reach the phone's push distributor over **outbound HTTPS** — `ntfy.sh`, or
wherever a member's own ntfy runs. A server that cannot reach it still rings open apps; it
logs `push.failed` with the distributor's origin for each ring that did not go through.
A delivery gives up after 5 seconds and never follows a redirect.

`WEAVE_PUBLIC_URL`, when it is an `https://` address, is sent to the distributor as the
contact for whoever runs it. Unset, no contact is sent.

## Registering a device

All three need a client (Bearer) session. The admin console's cookie session cannot
register (403). If push could not start, all three answer 503.

| Route | Body | Answer |
|---|---|---|
| `GET /api/push/key` | — | `{ publicKey }`: the server's key, base64url, the 65-byte uncompressed P-256 point. Subscribe with this. |
| `PUT /api/push/subscription` | `{ endpoint, keys: { p256dh, auth } }` | `{ ok: true }`, or 400 with a `message` saying what is wrong |
| `DELETE /api/push/subscription` | — | `{ ok: true, removed }` |

The body is the shape of a browser's `PushSubscription.toJSON()`.

- `endpoint` must be `https`, without credentials. On a server with `WEAVE_EXPOSURE=public`
  it may not be `localhost` or a loopback, private, shared or link-local IP literal; on a
  LAN or loopback server those are allowed, since a member's own ntfy beside the server is
  the ordinary case there.
- `p256dh` is the device's P-256 public key (65 bytes, uncompressed, on the curve) and
  `auth` its 16-byte secret, both base64url (padded standard base64 is accepted too).

A subscription belongs to the **session** that registered it — one per session, replaced by
the next `PUT`. An account keeps at most ten; the least recently delivered goes first. The
same endpoint registered from a new session moves there rather than ringing twice.

### Staying signed in

An ordinary session lapses after **12 idle hours**. That would sign out a phone left closed
overnight, and with it its subscription, so it would silently stop ringing. So `PUT` gives
the session a **30-day** idle window instead, as a messaging app stays signed in, and the
session keeps sliding on it while the phone uses it.

The window belongs to having a subscription. `DELETE`, or losing the subscription any other
way (the distributor answering `404`/`410`, the endpoint moving to a new session, the
per-account cap), puts the session back on 12 hours measured from its last use. Signing out,
being signed out from another device or by an administrator, and disabling the account all
delete the session, and the subscription with it. Rings go only to live sessions of accounts
that are not disabled.

Register again whenever the distributor hands the app a new endpoint.

## Push messages

Encrypted with `aes128gcm` (RFC 8291), so only the device can read them. The decrypted body
is JSON:

```json
{
  "v": 1,
  "kind": "ring",
  "callId": "Q2FsbElkMTIzNDU2Nzg5MA",
  "call": { "type": "dm", "threadId": "…" },
  "from": { "username": "ana", "displayName": "Ana" },
  "expiresAt": 1795435245000
}
```

| Field | |
|---|---|
| `v` | Payload version, `1`. |
| `kind` | `ring`, `ring_cancel` or `missed`. |
| `callId` | 22 base64url characters (`randomBytes(16)`), short enough to be the push `Topic`. The same id as on the socket frames; de-duplicate by it. |
| `call` | `{ type: 'dm', threadId }` or `{ type: 'huddle', channelId, name }`. |
| `from` | Who is calling: the caller, or whoever started the huddle. |
| `expiresAt` | When the ring stops by itself (ms since the epoch, server clock). |
| `reason` | On `ring_cancel` and `missed` only: see below. |

| `kind` | Sent when | `TTL` | `Urgency` |
|---|---|---|---|
| `ring` | A call or huddle starts ringing this person | seconds left in the ring (45) | `high` |
| `ring_cancel` | The ring stopped and it was not missed: `answered` (on any of their devices), `declined`, `server` (shutting down), or `cancelled` for a huddle whose room was deleted | seconds left in the ring | `high` |
| `missed` | Nobody answered (`no_answer`), or the caller hung up / the huddle emptied while it rang (`cancelled`) | 86400 | `normal` |

All three carry `Topic: <callId>`, so a distributor still holding a ring for an offline
phone replaces it with the cancel or the missed call instead of delivering both.

Only the person being rung gets pushes. A DM caller's app is open by definition and is told
over its socket.

## DM calls (`dm` module)

Existing frames, with `callId` added:

| Frame | Direction | Payload |
|---|---|---|
| `dm:call` | client → server | `{ threadId }` |
| `dm:ring` | server → callee | `{ threadId, callId, from, expiresAt }` |
| `dm:accept` | client → server | `{ threadId, callId? }` |
| `dm:decline` | client → server | `{ threadId, callId? }` — from the callee a decline, from the caller a cancel |
| `dm:call_live` | server → both | `{ threadId, callId }` |
| `dm:call_ended` | server → both | `{ threadId, callId, reason }` |

`reason` is `no_answer`, `declined`, `cancelled` (the caller hung up while it rang: pressed
cancel, left the room, or signed off), `left` (a live call down to one) or `server`.

`callId` on `dm:accept` and `dm:decline` is optional, for older clients, but honoured when
sent: a stale answer or decline for a ring that has since been replaced finds no call.

**`POST /api/dm/threads/:id/call/decline`**, body `{ callId }` (required), does what
`dm:decline` does, for a phone declining from its notification with no app running.

- Either person in the thread: `200 { ok: true, ended }`. `ended` is false when the call was
  already answered, over, or replaced by a newer one; declining twice is fine.
- Anyone else, or no such thread: `404 { error: 'no_thread' }`.
- No `callId`: `400 { error: 'no_call_id' }`.

## Huddle rings (`private-channels` module)

The first person into an EMPTY private room — by moving there or by signing in straight into
it — rings every other member. Empty is counted in people, not connections: somebody's
second device arriving beside their first starts nothing. Never a system room (a DM call),
never a resumed join (a dropped line coming back), never more than once per room per
cooldown.

| Frame | Direction | Payload |
|---|---|---|
| `private-channels:ring` | server → each other member | `{ channelId, callId, name, from, ringMs, expiresAt }` |
| `private-channels:ring_cancel` | server → that member | `{ callId, channelId, reason }` |
| `private-channels:decline` | client → server | `{ channelId, callId }` (`callId` honoured when sent) |

`ringMs` is how long it rings (45000), which needs no agreement between clocks; `expiresAt`
is the same moment on the server's clock, as the push carries it.

Answering is moving into the room; there is no accept frame. `ring_cancel` reasons:
`answered`, `declined`, `cancelled` (the room emptied while it rang — the starter left while
still alone — or the room was deleted), `no_answer` (45 s passed) and `server`. When
`cancelled` or `no_answer` ends the whole ring, everyone who neither came nor declined also
gets a `missed` push — except for a deleted room, where there is nothing to join.

**`POST /api/private-channels/:id/ring/decline`**, body `{ callId }` (required): a member
gets `200 { ok: true, ended }`, idempotent as above; a non-member or no such room
`404 { error: 'no_room' }`; no `callId` `400 { error: 'no_call_id' }`.

Settings, under Private rooms: `ringMembers` (**Ring members when a huddle starts**, on) and
`ringCooldownMinutes` (**Ring a huddle at most once every (minutes)**, 0–120, default 5; 0
rings every time).

## For module authors

`ctx.push` is `{ available, toUser(userId, payload, { ttl, urgency, topic }) }`. `toUser`
never throws or rejects; without push it resolves `{ sent: 0 }`. A module names an account
and a payload and never sees an endpoint, a key, or which devices exist.
