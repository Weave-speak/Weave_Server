# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Weave-speak/Weave_Server/security/advisories/new)
on this repository. If that is unavailable to you, open a normal issue saying only that
you have a security report and asking for a contact address — no details.

Please include: what you found, how to reproduce it, which version you tested, and what
an attacker could achieve. A working proof of concept helps but is not required.

You will get an acknowledgement within 7 days. We aim to ship a fix or give you a
timeline within 30 days, and we will credit you in the advisory unless you prefer not.

## Supported versions

During initial development, only the latest release receives security fixes.

## Scope

In scope: authentication and session handling, the admin panel, the invite system, the
signalling protocol, media routing, file upload handling, and the installer.

Out of scope: anything requiring physical access to the server or an existing
administrator account; vulnerabilities in a self-hoster's own reverse proxy, OS or
network configuration; and denial of service through sheer traffic volume.

## For people running a server

- Keep the media port forwarded but everything else closed.
- Put the HTTP port behind TLS. Weave will warn you when it is reachable without it.
- The setup token is a credential. It expires after 60 minutes and is regenerated on
  restart; it is not meant to be kept.
