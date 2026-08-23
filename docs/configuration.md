# Configuration

Every setting is an environment variable, read once at startup. On an installed server
they live in `/etc/weave/weave.env`; restart after editing.

The authoritative list is the code — `src/core/config/index.js` declares each setting with
its parser, default and documentation, and that one declaration drives the parsed config,
`weave doctor`, and the admin console's environment view. To see it, with the values
currently in effect:

```bash
weave config
```

This page covers the ones that decide whether anything works.

## The two that actually matter

### `WEAVE_MEDIA_PORT`

The single port carrying all WebRTC media, on **UDP and TCP**.

Forward both protocols from your router to this machine. Media does **not** go through
your reverse proxy — audio and video travel directly between each participant and this
server, and only HTTP and the signalling WebSocket go through a proxy or tunnel.

TCP is enabled on the same port number as a fallback for people on networks that block
UDP. It is slower, and it is the difference between a bad call and no call.

### `WEAVE_ANNOUNCED_ADDRESS`

The hostname or IP that clients are told to send media to.

Leave it unset and the server guesses from its own network interfaces. The guess picks
the first non-loopback address, which on a machine with a VPN is usually the VPN's — so
it warns loudly when it has to.

Getting this wrong produces the worst symptom there is: **everything connects and nobody
hears anything**. If your address is dynamic, use a dynamic-DNS hostname and keep it
updated; `announcedAddress` accepts a hostname.

Check it with:

```bash
weave doctor --stun
```

That asks a STUN server how the internet actually sees this machine and compares it with
what you announce. It also catches a router that remaps the port, which breaks media in a
way nothing else will tell you about.

## Exposure

`WEAVE_EXPOSURE` is one of `loopback`, `lan` or `public`, and it decides cookie security
policy.

`public` **requires** TLS in front (`WEAVE_BEHIND_TLS=true`). The server refuses to start
otherwise, because session cookies could not be marked `Secure` and credentials would
travel in clear text.

`WEAVE_TRUSTED_PROXIES` lists the proxy addresses whose forwarded-IP headers may be
believed. Empty means trust none. This matters: a header trusted unconditionally lets any
client forge its own address and walk straight through every per-IP rate limit.

## Workers and ports

`WEAVE_SFU_WORKERS` defaults to 1. Each worker is one CPU core of media capacity **and one
additional port** — worker *N* uses `WEAVE_MEDIA_PORT + N`, and you must forward those too.

Workers cannot share a port. `udpReusePort` exists in mediasoup but is meant for multicast
plain transport; under `SO_REUSEPORT` the kernel hashes incoming packets to whichever
socket it likes, which for ICE means traffic can arrive at a worker that does not own the
transport. Raise the worker count only when one core is genuinely the bottleneck.

## Storage

`WEAVE_DATA_DIR` holds the database, uploads and backups. Back up this directory.

```bash
weave backup           # consistent database snapshot
```

That uses SQLite's own backup API rather than copying the file, because copying a WAL
database while it is being written produces a result that looks fine until you restore it.
Uploads are not in that snapshot — `tar` the whole data directory for everything.
