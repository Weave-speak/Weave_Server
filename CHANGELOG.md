# Changelog

All notable changes to Weave Server are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The server serves the most recent entries to clients through `GET /api/changelog`,
so write them for the people using Weave, not only for developers.

## [0.1.27] - 2026-09-01

### Changed
- **A signed-in tester is no longer rate-limited like an anonymous reporter.** A stream-quality
  report marks a MOMENT, not a whole stream, so even a slight lag is worth recording — and the
  six-per-hour cap that guards the anonymous endpoint would have thrown most of them away. A
  signed-in account now has its own generous per-account window; the strict per-address limit
  stays for posts with no token.

## [0.1.26] - 2026-09-01

### Fixed
- **You can no longer receive your own stream.** The server refused nothing when a peer asked
  to consume its own producer, so a streamer could end up subscribed to their own
  screen-audio — hearing their share played back, and, because that capture is the machine's
  whole output mix, feeding a loop that re-captured what it had just played. It is refused
  outright now, whatever a client asks for.

### Changed
- **A tester or administrator grant now reaches the account immediately.** Granting or
  removing a role tells that account's live sessions, so the controls it unlocks appear or
  vanish in place rather than waiting for the next sign-in.

## [0.1.25] - 2026-09-01

### Added
- **A "tester" flag, granted and revoked from user management.** It is an ordinary account
  with one thing switched on — the in-app stream-quality reporting controls — and it is kept
  separate from administrator on purpose, so you can hand someone the diagnostics without
  handing them the keys to the server. It defaults off for every existing account, so nothing
  changes for anyone until you grant it.

## [0.1.24] - 2026-09-01

### Added
- **A stream-quality report now arrives with the server's own load beside it.** When a
  client says a screen share looked bad, the hardest thing to tell from either end has
  always been whether the fault was the sender, the viewer, or the machine between them.
  The server now stamps each report it receives with its load at that instant — load per
  core, event-loop lag, memory — which is the one thing neither end of a call can measure
  about the box in the middle. The admin overview gains the same signal live: what the
  single media worker's core is actually doing, so a saturated media core stops being
  invisible until somebody complains.

## [0.1.23] - 2026-09-01

### Changed
- **Voice is carried at 96 kb/s now, rather than at whatever the browser picks.** Left to
  itself a browser settles around 32 kb/s, which is where Opus starts discarding the top
  octave of speech — most of what people mean by "muffled", and a good part of what they
  mean by "I can barely hear them".

  0.1.18 made this a switch and shipped it off, on purpose: four client releases in a row
  had tried to improve voice quality by reasoning about it and each made something worse,
  so an unproven number belonged behind something an operator could turn on and listen to
  rather than baked into a release. It is on now for a different reason than the one that
  turned it off. 96 kb/s is not a fresh guess — it is what the Weave web app has run on for
  months against the same kind of SFU and the same codec, and that is the client people
  point at when they say voice sounds better over there.

  None of this is less reversible than it was. `WEAVE_OPUS_BITRATE=64000` and a restart
  suits a thinner uplink, clearing it entirely hands the decision back to the browser, and
  either takes effect for everybody without a single client updating: the router's codec
  parameters are what configure a browser's encoder.

  The router still declares nothing else about anyone's encoder. Silence suppression and
  playback rate stay the client's own business, set per stream by whoever chose them,
  because a router parameter reaches people who never asked for it.

## [0.1.22] - 2026-08-31

### Security
- **An invite link could be made to point somewhere else.** The invite page builds a
  `weave://` link containing this server's address, and that address is where the person
  clicking it connects and types their password. It was taken from the `X-Forwarded-Host`
  header — which a proxy sets honestly, but which anybody able to reach the server directly
  can simply send themselves. The page would then look entirely correct and point at
  somewhere it should not, hosted by the very server the invitee had been told to trust.

  The header is no longer used. Where a server sits behind a proxy or a tunnel, set the new
  `WEAVE_PUBLIC_URL` to its outside address; otherwise the address comes from the visitor's
  own request, which is whatever they typed into their address bar and therefore cannot be
  chosen for them by somebody else.

  Anyone running behind a tunnel should set `WEAVE_PUBLIC_URL` — see
  `docs/configuration.md`. Without it, invite links still work, but they will say whatever
  hostname the visitor arrived on.

## [0.1.21] - 2026-08-31

### Changed
- **Being moved to the away room now depends on whether you are at your computer, not on
  whether you have been talking.** Until now the only thing this server could measure was
  silence on your microphone, which called somebody working quietly in another window
  "away" while they sat right there.

  The desktop app reports how long the keyboard and mouse have gone untouched — across
  every application, not just Weave — and that is used where it is available. Talking still
  counts too: whichever happened more recently is what the server goes by, because either
  one means somebody is there.

  Nothing changes for people using Weave in a browser. A web page cannot see input to other
  windows, so those clients say nothing and are judged on microphone silence exactly as
  before. This needs the desktop client at **0.1.49** or newer; against anything older the
  server simply carries on as it did.

- Someone watching a screen share in Weave is treated as present, however long they go
  without touching anything. A video playing in a different application still cannot be
  seen — to the operating system that looks the same as an empty chair — so a generous
  timeout remains the thing protecting you there.

- Having no working microphone no longer exempts you outright. It did because there was
  nothing to measure; where your keyboard can be seen, there now is.

- The away setting is called "Move after (minutes of inactivity)" rather than "minutes of
  silence", because that is now what it means.

## [0.1.20] - 2026-08-31

### Added
- **A profile picture.** Settings → My Profile has an upload button, and the picture you
  choose is cropped in a circular frame before it is sent — drag it to pick what sits
  inside the circle. It appears wherever you do: the room list, the bottom bar, every
  message you have sent.

  The cropping happens on your own machine and only the finished square is uploaded, so
  the picture stored is exactly the one you framed rather than a server's later guess at
  it. What arrives is checked by its own bytes, not by what it was called — a file that
  says it is a PNG and is not is refused.

- **A status you set yourself.** Online or Away, chosen behind your own name in the bottom
  bar rather than buried in settings. It is stored on your account, so it survives closing
  the app, and everybody else sees it on the dot beside your name.

  This is a separate thing from being moved to the away room. That happens on a timer when
  your microphone has been quiet, and it is about where you are; a status is about whether
  you want to be disturbed. Neither one overwrites the other any more — being moved for
  going quiet will not undo a status you chose on purpose.

### Changed
- The dot beside somebody's name in a room now means something. It used to say only
  "connected", which everybody listed under a room is by definition; it now carries what
  that person has said about themselves.

- Profile pictures are stored apart from message attachments, and are not affected by the
  uploads retention setting. An attachment can be cleaned up after a month; a face should
  not quietly disappear.

## [0.1.19] - 2026-08-31

### Added
- **Server mute.** An administrator can silence somebody, and unlike the mute button in
  your own bar, the person it is applied to cannot lift it. Pick five minutes, an hour, or
  until you lift it yourself. It is stored rather than remembered, so signing out and back
  in does not clear it, and it is applied to the account rather than to one connection —
  somebody signed in on two machines is muted on both. Your microphone button says who
  muted you and until when, rather than quietly doing nothing.

- **Kick.** Closes every connection an account holds and holds the door shut for a minute.
  The minute is the point: a client reconnects on its own and remembers the room it was in,
  so a kick that only cut the connection would have put the person back where they were
  about a second later. They return signed in and standing in no room.

- **An administrator can move somebody into a channel.** The ability had been in the server
  since signalling was written and no client had ever been able to ask for it. Drag a person
  in the sidebar onto a room.

### Fixed
- Moving somebody as an administrator now refuses the same things you are refused when you
  move yourself: into a text channel, which is a place you read rather than stand, and into
  a private room they are not a member of. It also moves every connection they hold rather
  than one, so nobody is left audible in the room they were moved out of.

- Administrative actions are written to the audit log. Until now nothing done over the live
  connection was recorded there — including moving somebody between rooms, which has been
  possible for as long as the server has existed.

## [0.1.18] - 2026-08-30

### Changed
- The server no longer tells your browser how to encode your voice. 0.1.17 declared a
  bitrate, a playback rate and a silence-suppression setting, and those declarations
  configure the encoder in every connected client — including ones that never asked. Four
  client releases in a row tried to improve voice quality and each made something worse,
  so this goes back to what shipped before any of it: the server declares error correction
  and nothing else, and leaves Opus to make its own decisions about bandwidth when a
  connection tightens.

- Raising the voice bitrate is still available and still worth having — without it browsers
  settle around 32 kb/s, where speech starts losing its top octave. It is now `WEAVE_OPUS_BITRATE`,
  unset by default. Set it, restart, and listen; unset it again if it sounds wrong. It takes
  effect for every client without anybody updating anything, because the router's codec
  parameters are what configure a browser's encoder.

## [0.1.17] - 2026-08-28

### Fixed
- Moving between channels served by different SFU workers silently stranded a peer's media.
  A transport belongs to the router that created it, so the peer arrived in the new room
  still apparently producing, on a router with nobody on it — unable to be heard, unable to
  hear, and with no error raised anywhere. The move now closes the peer's transports and
  producers when the worker changes and sets `mediaReset` on the `moved` frame so the client
  rebuilds. No effect on a single-worker server, which is the default.
- Voice was being encoded at roughly a third of the bitrate it should have been. Nothing
  told Opus what to aim for, so browsers fell back to about 32 kb/s — the point where speech
  starts losing its top octave, which is most of what people meant by "muffled". The router
  now states 64 kb/s, matching a default Discord voice channel, and `WEAVE_OPUS_BITRATE`
  raises it. This reaches clients that are too old to ask for it: the figure the server
  publishes is what configures the browser's encoder.
- A screen share could not be watched at the resolution it offered. The server advertised
  H.264 at a level that tops out at 1280x720, while the client offered 1080p30, 1080p60 and
  full-resolution shares — so three of the four settings exceeded the level being published.
- Sharing your screen in a channel with voice switched off still carried your system audio.
  Screen audio belongs to the share, and now follows the same permission the share does.
- A malformed `produce` message closed the producer the sender already had. The replacement
  path ran before the new stream was ever validated, so a bad frame cost someone their live
  microphone instead of costing them an error.
- A transport whose DTLS handshake failed was left open and occupying its slot. Only a
  clean close was handled, so the peer went on holding a connection that carried nothing.
- When a transport died, the producers and consumers on it were forgotten silently. Other
  people's rosters kept listing streams that no longer existed, and a listener whose
  consumers were dropped had no way to learn of it — which left them permanently unable to
  hear one particular person until they reconnected.
- `WEAVE_LOCAL_ANNOUNCED_ADDRESS` was documented but read by nothing, so operators whose
  machine also runs Docker or a VPN had no way to correct a wrong guess, and clients on the
  same network were sent the long way round through the router.

### Added
- VP9 is now offered alongside H.264 and VP8. It is markedly better on screen text, and it
  carries several quality layers in one stream, so one viewer on a poor connection no
  longer drags a share down for everyone. H.264 is still offered first, so nothing changes
  for existing clients.
- ICE can be restarted in place. A connection whose network path dies — a router changing
  its mind about your address, a laptop moving between networks — used to be repairable
  only by tearing down the whole media path and rebuilding it. It is now repaired while
  every stream on it stays where it is. Advertised as `media.ice-restart`.
- Media quality is now measured. Poor reception is reported by name in the log, and the
  admin overview carries a rollup, so a bad call can be diagnosed rather than guessed at.
  `WEAVE_SFU_LOG_LEVEL` turns on the bandwidth and per-stream detail behind it.
- `WEAVE_MAX_INCOMING_BITRATE` and `WEAVE_MAX_OUTGOING_BITRATE` cap what one participant
  may send this server and what it sends back, for hosts on a thin domestic uplink.

### Added
- Initial modular server: core (config, logging, migrations, HTTP, WebSocket, auth,
  users, channels, peers, SFU, settings, admin) with features loaded as removable modules.
