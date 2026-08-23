# Changelog

All notable changes to Weave Server are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The server serves the most recent entries to clients through `GET /api/changelog`,
so write them for the people using Weave, not only for developers.

## [Unreleased]

### Fixed
- Moving between channels served by different SFU workers silently stranded a peer's media.
  A transport belongs to the router that created it, so the peer arrived in the new room
  still apparently producing, on a router with nobody on it — unable to be heard, unable to
  hear, and with no error raised anywhere. The move now closes the peer's transports and
  producers when the worker changes and sets `mediaReset` on the `moved` frame so the client
  rebuilds. No effect on a single-worker server, which is the default.

### Added
- Initial modular server: core (config, logging, migrations, HTTP, WebSocket, auth,
  users, channels, peers, SFU, settings, admin) with features loaded as removable modules.
