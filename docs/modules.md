# Modules

Weave is a small core plus a set of modules. Every feature that is not strictly necessary
to hold a call is a module, and every module can be switched off on a running server
without restarting it.

The **core** is config, logging, migrations, HTTP, the WebSocket, auth, users, channels,
the peer roster, the SFU, settings and the admin shell. That is the part that has to be
correct.

Everything else — text chat, uploads, away handling, join sounds, slash commands — is a
module under `src/modules/<id>/`.

## Turning things off

System → Modules in the admin console, or:

```bash
WEAVE_DISABLED_MODULES=personas,slash-commands
```

Disabling unregisters a module's HTTP routes, refuses its WebSocket message types, hides
its admin panel and removes its hook listeners. It does **not** touch its data, so
re-enabling restores it intact. Uninstalling is a separate, explicit act.

The server advertises which modules are running in `features[]` on `GET /api/server-info`,
so a client renders what the server actually has rather than showing controls for things
that will fail.

## Writing one

```
src/modules/<id>/
├─ module.json      id, name, version, requires[], defaultEnabled, description
├─ index.js         export function register(ctx)
├─ migrations/      NNN_name.sql — this module's own tables
└─ admin/           optional admin panel
```

`register(ctx)` is the only entry point. A module may only touch what the context hands
it, and every grant records how to undo itself — that is what makes "disable" mean
something.

| | |
|---|---|
| `ctx.http.route(method, path, handler, {auth})` | HTTP routes |
| `ctx.ws.on(type, handler)` | WebSocket types, namespaced as `<id>:<type>` |
| `ctx.db.migrate()` / `ctx.db.handle` | This module's tables, migrated under its own namespace |
| `ctx.settings.define(key, schema, default)` | Typed settings; the admin console renders the form |
| `ctx.hooks.on(event, fn)` / `.emit()` | How modules learn about anything |
| `ctx.peers` | Read-only view of who is connected and where |
| `ctx.actions` | A short named list — currently `movePeer`, `listChannels` |
| `ctx.paths` | `data`, `uploads`, `moduleDir` |
| `ctx.admin.panel({...})` | An admin console section |
| `ctx.onUnload(fn)` | Anything else that needs undoing — timers, watchers |
| `ctx.log` | A child logger tagged with the module id |

### Three rules

**The core never imports a module.** If the core needs to know something happened, that is
a hook. The moment core imports a feature, the feature stops being removable.

**Modules never import each other.** They communicate through hooks and settings. Declare
hard dependencies in `requires[]` and the loader enforces them — it refuses to start on a
missing one, and refuses to disable a module something else depends on.

**Everything must be revocable.** If you register something the context does not cover,
hand the cleanup to `ctx.onUnload`. A module that leaves an interval running after being
disabled is a module that was never really disabled.

### Settings render themselves

Declare a type and a label and a control appears in the admin console. A module ships no
UI for the common case:

```js
ctx.settings.define('retentionDays', {
    type: 'number', integer: true, min: 0, max: 3650,
    label: 'Keep messages for (days)',
    help: 'Older messages are deleted automatically. 0 keeps them forever.',
}, 30);
```

Values are stored per module and survive being disabled, so an administrator's choices
come back with the feature.

### Migrations are namespaced

Each module versions its own tables independently under `module:<id>`, so a module that is
switched off simply does not migrate, and its tables sit untouched until it returns.
Migrations are immutable once released — the runner records a checksum and refuses to
start if one changes underneath it. Add a new migration instead.

## What ships

| Module | Default | What it does |
|---|---|---|
| `text-chat` | on | Messages, history with a cursor, retention |
| `uploads` | on | Image attachments, type decided by magic bytes |
| `afk` | on | Moves idle people to an away channel |
| `slash-commands` | on | `/roll`, `/flip` — their own message type, so they work without chat |
| `personas` | **off** | Join and leave sounds. Ships with an empty library |
| `dev-smoke` | **off** | A page that proves audio flows. For verifying a deployment |
