#!/usr/bin/env bash
#
# Weave installer.
#
# Read this before you run it. It is deliberately linear and commented so that you can,
# and so that "curl | bash" is a choice you make with your eyes open rather than the only
# option offered.
#
# What it does:
#   · creates a system user `weave` that owns nothing but its own data
#   · unpacks this release into /opt/weave/releases/<version> and points a symlink at it
#   · creates /var/lib/weave for the database, uploads and backups
#   · writes /etc/weave/weave.env, which is the only file you will normally edit
#   · installs and starts a systemd service
#
# What it does NOT do:
#   · touch your firewall or your router — you forward the media port yourself
#   · install a reverse proxy or obtain a certificate
#   · phone home, collect anything, or add an apt source
#
# Re-running it upgrades in place: a new release directory, a symlink flip, a restart.
# Your data and your settings are never overwritten.

set -euo pipefail

WEAVE_USER="${WEAVE_USER:-weave}"
PREFIX="${WEAVE_PREFIX:-/opt/weave}"
DATA_DIR="${WEAVE_DATA_DIR:-/var/lib/weave}"
CONF_DIR="${WEAVE_CONF_DIR:-/etc/weave}"
ENV_FILE="$CONF_DIR/weave.env"
UNIT=/etc/systemd/system/weave.service

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()   { printf '\033[31m\n%s\033[0m\n\n' "$*" >&2; exit 1; }

# ── Preconditions ────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "Run this with sudo. It creates a system user and a systemd service."

command -v systemctl >/dev/null 2>&1 \
  || die "This installer targets systemd. For anything else, run the server directly:
  node src/index.js   (see deploy/docker/ for a container instead)"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  # armv7 is deliberately unsupported: Node's own armv7 builds are experimental, and
  # mediasoup ships no prebuilt worker for it, so it would mean a C++ build on a Pi.
  *) die "Unsupported architecture: $ARCH. Weave supports x86_64 and arm64." ;;
esac

VERSION="$(node -e 'process.stdout.write(require("'"$SRC"'/package.json").version)' 2>/dev/null \
  || grep -m1 '"version"' "$SRC/package.json" | sed 's/.*: *"\(.*\)".*/\1/')"
[ -n "$VERSION" ] || die "Could not read the version from package.json. Is this a complete release?"

RELEASE_DIR="$PREFIX/releases/$VERSION"

bold ""
bold "Weave $VERSION  ($ARCH)"
bold "───────────────────────────────"

# ── Runtime ──────────────────────────────────────────────────────────────────
#
# A release tarball bundles its own Node so the target box needs nothing. Installing from
# a source checkout uses whatever Node you have, provided it is new enough — mediasoup and
# better-sqlite3 both require 22 or later, and neither ships a prebuilt for anything older.

if [ -x "$SRC/runtime/bin/node" ]; then
  NODE="$SRC/runtime/bin/node"
  info "Runtime: bundled Node $("$NODE" -v)"
else
  command -v node >/dev/null 2>&1 \
    || die "No bundled runtime and no system Node.
Either install Node 22+ or use a release tarball, which brings its own."
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] \
    || die "Node $(node -v) is too old. mediasoup and better-sqlite3 both need Node 22 or later."
  NODE="$(command -v node)"
  info "Runtime: system Node $(node -v)"
  warn "This is a source install. Upgrades will not be automatic."
fi

[ -d "$SRC/node_modules" ] \
  || die "Dependencies are missing. In a source checkout run:  npm ci --omit=dev"

# ── User ─────────────────────────────────────────────────────────────────────

if id "$WEAVE_USER" >/dev/null 2>&1; then
  info "User:    $WEAVE_USER (exists)"
else
  # No login shell and no home directory: this account exists to own a data directory,
  # nothing else.
  useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$WEAVE_USER"
  info "User:    $WEAVE_USER (created)"
fi

# ── Directories ──────────────────────────────────────────────────────────────

mkdir -p "$RELEASE_DIR" "$DATA_DIR" "$CONF_DIR"

info "Copying files to $RELEASE_DIR"
# Deliberately excluded: the local data and logs of whatever built this, plus git and test
# material. Copying a developer's database into a fresh install would be a memorable bug.
tar -C "$SRC" \
    --exclude=.git --exclude=data --exclude=logs --exclude=test \
    --exclude=.smoke --exclude='*.log' \
    -cf - . | tar -C "$RELEASE_DIR" -xf -

ln -sfn "$RELEASE_DIR" "$PREFIX/current"

# The service account owns its data, and only its data. /opt/weave stays root-owned and
# the unit mounts it read-only, so a running Weave cannot rewrite its own code.
chown -R root:root "$PREFIX"
chown -R "$WEAVE_USER:$WEAVE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ── Configuration ────────────────────────────────────────────────────────────

if [ -f "$ENV_FILE" ]; then
  info "Config:  $ENV_FILE (kept — your settings are not overwritten)"
else
  info "Config:  $ENV_FILE (created)"
  cat > "$ENV_FILE" <<EOF
# Weave configuration.
#
# Run \`weave config\` to see every setting, what it does, and its current value.
# Restart after editing:  sudo systemctl restart weave

# The port for HTTP and the signalling WebSocket. Put a reverse proxy in front of this
# for anything public.
WEAVE_HTTP_PORT=3000
WEAVE_HTTP_BIND=0.0.0.0

# ─────────────────────────────────────────────────────────────────────────────
# THE TWO SETTINGS THAT ACTUALLY DECIDE WHETHER CALLS WORK
# ─────────────────────────────────────────────────────────────────────────────
#
# Media does NOT go through your reverse proxy. Audio and video travel over this port,
# directly between each participant and this machine. You must forward it from your
# router on BOTH UDP and TCP, and announce an address that reaches this machine from
# where your users are.
#
# Getting the address wrong produces the worst symptom there is: everything connects,
# and nobody hears anything.

WEAVE_MEDIA_PORT=44444
WEAVE_ANNOUNCED_ADDRESS=

# How this server is reachable: loopback, lan, or public.
# 'public' requires TLS in front — Weave refuses to start otherwise, because session
# cookies could not be marked Secure and credentials would travel in clear text.
WEAVE_EXPOSURE=lan
# WEAVE_BEHIND_TLS=true
# WEAVE_TRUSTED_PROXIES=127.0.0.1

WEAVE_DATA_DIR=$DATA_DIR
WEAVE_LOG_DIR=$DATA_DIR/logs
WEAVE_LOG_LEVEL=info

# The name people see before they sign in.
WEAVE_INSTANCE_NAME=Weave
EOF
  chown root:"$WEAVE_USER" "$ENV_FILE"
  # Readable by the service, writable only by root.
  chmod 640 "$ENV_FILE"
fi

mkdir -p "$DATA_DIR/logs"
chown -R "$WEAVE_USER:$WEAVE_USER" "$DATA_DIR"

# ── Command ──────────────────────────────────────────────────────────────────

cat > /usr/local/bin/weave <<EOF
#!/usr/bin/env bash
# Loads the same settings the service uses, so \`weave doctor\` checks the real config.
set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
exec "$PREFIX/current/runtime/bin/node" "$PREFIX/current/src/cli/weave.js" "\$@" 2>/dev/null \
  || exec node "$PREFIX/current/src/cli/weave.js" "\$@"
EOF
chmod 755 /usr/local/bin/weave
info "Command: /usr/local/bin/weave"

# ── Service ──────────────────────────────────────────────────────────────────

install -m 644 "$SRC/deploy/weave.service" "$UNIT"
systemctl daemon-reload
info "Service: $UNIT"

# ── Preflight ────────────────────────────────────────────────────────────────

bold ""
bold "Checking the configuration"
bold "──────────────────────────"
set +e
# shellcheck disable=SC1090
( set -a; . "$ENV_FILE"; set +a; "$NODE" "$PREFIX/current/src/cli/weave.js" doctor )
DOCTOR=$?
set -e

if [ $DOCTOR -ne 0 ]; then
  warn "Doctor found problems. Weave is installed but NOT started."
  warn "Edit $ENV_FILE, then:  sudo systemctl start weave"
  bold ""
  exit 0
fi

# ── Start ────────────────────────────────────────────────────────────────────

systemctl enable --now weave >/dev/null 2>&1 || systemctl restart weave
sleep 2

if ! systemctl is-active --quiet weave; then
  die "The service did not start. What it said:
  sudo journalctl -u weave -n 40 --no-pager"
fi

PORT="$(grep -m1 '^WEAVE_HTTP_PORT=' "$ENV_FILE" | cut -d= -f2)"
MEDIA="$(grep -m1 '^WEAVE_MEDIA_PORT=' "$ENV_FILE" | cut -d= -f2)"

bold ""
bold "Weave is running"
bold "────────────────"
info "Admin console:  http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-3000}/admin"
info "Setup code:     printed below, and in $DATA_DIR/setup-token"
info ""
info "Next, and it is the step people skip:"
info "  Forward UDP *and* TCP port ${MEDIA:-44444} from your router to this machine,"
info "  and set WEAVE_ANNOUNCED_ADDRESS in $ENV_FILE to the address your"
info "  users reach you on. Then:  sudo weave doctor --stun"
info ""
info "  Logs:     sudo journalctl -u weave -f"
info "  Restart:  sudo systemctl restart weave"
info "  Check:    sudo weave doctor"
bold ""

journalctl -u weave -n 30 --no-pager 2>/dev/null | grep -A 14 'FIRST-RUN SETUP' || true
