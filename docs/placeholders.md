# Placeholders

Screens in the admin console that exist in the navigation but have no functionality
behind them yet. They are listed here so the set is countable and nothing quietly looks
finished when it is not.

Each one renders a conspicuous "Not built yet" panel in the console saying what it will
need and what to use instead today. The same list lives in `admin/app.js` as the
`PLACEHOLDERS` object — that is the source of truth, and this file describes it.

| Screen | Where | Status |
|---|---|---|
| Roles & Permissions | Community | Placeholder |
| Timeouts | Moderation | Placeholder |
| Bug Reports | Moderation | Placeholder |
| Bubbles | Customise | Placeholder |
| Diagnostics | System | Placeholder |

---

## Roles & Permissions

**Why it is empty.** The server has exactly two levels of access: administrator, or not.
That is the `is_admin` column on `users`, checked by `auth.resolve` for HTTP routes and by
the WebSocket registry for message types.

**What it needs**

- Named roles with per-channel permissions, replacing the single flag.
- A permission model the **WebSocket handlers** can check, not only the HTTP routes. This
  is the part that is easy to get wrong: gating the admin API without gating `adminMove`
  would leave the actual capability reachable.
- Assignment UI, and a rule that the last administrator cannot be demoted. The
  self-demotion guard already exists in `POST /api/admin/members/:id/admin`; a role system
  needs the same protection generalised.

**Use instead.** Members → select someone → **Toggle admin** grants full access.

---

## Timeouts

**Why it is empty.** Moderation beyond deleting an account has not been built. There is no
kick, no ban, and no temporary restriction.

**What it needs**

- Kick (disconnect the socket), ban (block the account), timeout (temporary mute or block).
- A moderation table with an expiry column, and a sweep that lifts expired entries —
  the same shape as the AFK module's sweep.
- **Enforcement in the join handler**, so a banned account cannot simply reconnect.
  Disconnecting someone without blocking the reconnect is theatre.

**Use instead.** Members → **Delete** removes an account permanently.

---

## Bug Reports

**Why it is empty.** These are client-submitted diagnostic bundles, and there is no client
yet to submit them.

**What it needs**

- A client-side "report a problem" action gathering recent logs and a `getStats` snapshot.
- **Redaction before anything leaves the reporter's machine**, previewed by them first.
  The previous server wrote whole console dumps to disk named after real users; those
  files are exactly what this must not recreate.
- Storage with retention, and a download that streams rather than buffering the file.

**Use instead.** System → **Logs** shows the server side of any incident. Every WebSocket
connection carries a six-character incident id that appears on both client and server log
lines, so a user can quote it and you can `grep` for it.

---

## Bubbles

**Why it is empty.** Not ported from the previous server.

**What it needs**

- A `bubbles` module with its own tables and a rotation timer.
- Admin CRUD, plus a "clear messages" action distinct from deleting the bubble.
- Client rendering — which is a client concern, and there is no client yet.

**Use instead.** Nothing. The feature is absent rather than half-present, which is the
honest state for it.

---

## Diagnostics

**Why it is empty.** Reachability testing needs something outside your network to answer,
and a server cannot honestly test its own inbound path alone.

**What it needs**

- An inbound UDP probe. A server binding a port and then connecting to itself proves
  nothing about whether a router forwards it.
- A per-connection view driven by `WebRtcTransport.iceSelectedTuple`, which is the
  server-side ground truth for whether a peer got direct UDP or fell back to TCP. That
  data already exists on every transport; nothing reads it yet.
- A downloadable support bundle with redaction applied.

**Use instead.** System → **Overview** reports the announced media address and, crucially,
**whether it was configured or guessed**. A guessed address is the most common cause of a
call that connects and then stays silent, so it raises a banner rather than sitting in a
table.

---

## Deviations from the supplied design

Two, both deliberate:

**`FULL_NAME` became `USERNAME`.** The design showed a full name beside a display name.
Weave deliberately does not store real names any more — the previous server used a legal
name as the login identifier, which made the field you most want kept private the one
typed into a login box on a shared screen. Identity is a username; `display_name` is
unchanged.

**A `System` navigation group was added.** The design covered Data, Community, Moderation
and Customise. First-run setup, module management, settings, logs and diagnostics had
nowhere to live, so they are grouped under System in the same visual language.
