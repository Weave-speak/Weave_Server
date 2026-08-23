# Operating a server

## Everyday commands

```bash
sudo systemctl status weave      # is it running
sudo journalctl -u weave -f      # what is it doing
sudo systemctl restart weave     # after editing /etc/weave/weave.env
sudo weave doctor                # check the configuration
sudo weave doctor --stun         # ...and how the internet sees this machine
sudo weave backup                # snapshot the database
```

## When something is wrong

**Start with `weave doctor`.** It checks configuration, storage, database integrity, both
ports on both protocols, and the announced address. It fails on real problems and tells
you what to change.

It cannot tell you whether an unsolicited inbound packet actually reaches this machine —
that depends on your router, and nothing inside your network can answer it honestly. To
find out, enable the `dev-smoke` module in the admin console and open `/dev/smoke` **from
outside your network**; a phone on mobile data is the easiest way. It can send a generated
tone instead of a microphone, so it works from a machine with no audio hardware.

**Every connection has an incident id.** Six characters, shown in the client and stamped on
both client and server log lines. When someone says "it broke last night", ask for that id:

```bash
sudo journalctl -u weave | grep 7K2QX4
```

## Calls connect but nobody hears anything

Almost always the announced address or the port forward.

1. `weave doctor --stun` — does what you announce match what the internet sees?
2. Is `WEAVE_MEDIA_PORT` forwarded on **both UDP and TCP**?
3. Is it a 1:1 forward, not a remapping one? Doctor reports this.

## Locked out

Being able to read the data directory is the authorisation, so no password is needed:

```bash
sudo -u weave weave admin-reset                    # list administrators
sudo -u weave weave admin-reset --user alice       # reset a password
sudo -u weave weave admin-reset --promote bob      # grant access
sudo -u weave weave admin-create --user alice      # when there are none at all
```

If no administrator exists at all, restarting the server prints a fresh first-run setup
code to the journal. That is recoverable by design — an expired code costs a restart, not
a reinstall.

## Upgrading

Re-run the installer from a newer release. It unpacks alongside the current version and
flips a symlink, so your data and settings are untouched and a rollback is one flip back.

## Uninstalling

```bash
sudo ./uninstall.sh            # removes the service and the code, keeps your data
sudo ./uninstall.sh --purge    # also deletes the database, uploads and settings
```

`--purge` requires typing `DELETE` in full. A yes/no prompt is too easy to answer by
reflex when the thing on the other side is everyone's accounts and history.
