# Weave Server

Self-hosted voice, video and text chat for small groups. One server, one command to
install, and a browser admin panel to run it.

Weave is a **selective forwarding unit (SFU)** built on [mediasoup](https://mediasoup.org).
Media is relayed by your server, not peer-to-peer, so an eight-person call costs each
participant one upload stream instead of seven.

> **Status: early development.** Not yet recommended for production use.

## What it does

- **Voice channels** with a noise gate, per-user volume, and priority speaker
- **Screen sharing** with system audio, and webcam — both at once, watch several at a time
- **Text chat** with image upload and link previews
- **Invite-only registration** — no open sign-up, no email required
- **Modular features** — every non-essential feature can be switched off in the admin panel

## Requirements

| | |
|---|---|
| OS | Debian 12/13 or Ubuntu 22.04+, `amd64` or `arm64` |
| Node | 22 or later (the installer supplies its own) |
| RAM | 512 MB minimum, 1 GB recommended |
| Network | One TCP port for HTTP/WebSocket, one UDP+TCP port for media |

A Raspberry Pi 5 comfortably runs a group of a dozen people.

## Install

No release has been published yet, so install from a checkout:

```bash
git clone https://github.com/Weave-speak/Weave_Server.git
cd Weave_Server
npm ci --omit=dev
less install.sh          # read it before you run it
sudo ./install.sh
```

Release tarballs will bundle their dependencies and a pinned Node runtime, so a target
machine needs nothing at all — see `scripts/build-release.sh`.

The installer prints a URL and a one-time setup code. Open the URL, enter the code, and
create your administrator account. There is no default password, ever.

## The one thing people get wrong

**Media does not go through your reverse proxy.** Only HTTP and the WebSocket do.

WebRTC audio and video travel over UDP directly between each participant and your server.
If you put Weave behind nginx, Caddy or a tunnel, that handles the web traffic — but you
must **also** forward the media port (UDP *and* TCP) from your router to the server, and
set `WEAVE_ANNOUNCED_ADDRESS` to a hostname or IP that resolves to it from the outside.

`weave doctor` checks this for you and tells you exactly what is wrong.

## Documentation

- [Configuration](docs/configuration.md)
- [Admin console placeholders](docs/placeholders.md) — screens that exist but are not built yet
- [Modules](docs/modules.md) — how features are added and removed
- [Operating a server](docs/operations.md)
- [Contributing](CONTRIBUTING.md)

## Licence

[AGPL-3.0-or-later](LICENSE). If you run a modified Weave server for other people, you
must offer them the source of your modifications.
