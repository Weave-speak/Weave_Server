# Changelog

All notable changes to Weave Server are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The server serves the most recent entries to clients through `GET /api/changelog`,
so write them for the people using Weave, not only for developers.

## [Unreleased]

### Added
- Initial modular server: core (config, logging, migrations, HTTP, WebSocket, auth,
  users, channels, peers, SFU, settings, admin) with features loaded as removable modules.
