# Contributing to Weave Server

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line:

```bash
git commit -s -m "Add a thing"
```

This certifies the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or have the right to submit it, and that you are contributing
it under this project's licence (AGPL-3.0-or-later). CI rejects unsigned commits.

## Before you start

Open an issue for anything larger than a bug fix. A short conversation beforehand is much
cheaper than a rejected pull request.

## Architecture in one paragraph

The **core** — config, logging, migrations, HTTP, WebSocket, auth, users, channels, peers,
the SFU, settings and the admin shell — is not optional and is where correctness lives.
Everything else is a **module** under `src/modules/<id>/` that can be switched off without
breaking the rest. If you are adding a feature, you are almost certainly adding a module.
Read [docs/modules.md](docs/modules.md) first.

Two rules that keep this honest:

- **The core never imports a module.** If the core needs to know something happened, that is
  a hook, not an import.
- **Modules never import each other.** They communicate through hooks and settings. Declare
  hard dependencies in `requires[]` and the loader will enforce them.

## Style

Match the surrounding code. It is plain modern JavaScript with ES modules — no TypeScript,
no transpiler, no framework. Prefer clarity to cleverness; this is a codebase people will
read while trying to fix their own server at midnight.

Comments explain **why**, not what. A comment that restates the code is noise; a comment
recording the bug that made a line necessary is worth its weight.

## Logging

Use `ctx.log`, never `console.log`. Every line takes an `evt` (a stable, greppable event
name) and a human-readable `msg`. Levels: `error` means someone must act, `warn` means
something is wrong but handled, `info` is a notable state change, `debug` is for
diagnosis.

**Never log** a password, hash, token, recovery phrase, session id, or message content.
Truncate IP addresses. If you are unsure, leave it out.

## Tests

`npm test` runs the Node test runner. Anything touching auth, sessions, invites, the
migration runner or the module loader needs a test. Media paths are hard to unit-test —
cover what you can and describe the manual check in the pull request.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Never commit

Real hostnames, IP addresses, tokens, or anything identifying a specific deployment —
including in comments, examples and test fixtures. Use `example.com`, `203.0.113.10`
(TEST-NET-3) and obvious placeholders. CI runs a secret scan, but it is a backstop, not a
substitute for care.
