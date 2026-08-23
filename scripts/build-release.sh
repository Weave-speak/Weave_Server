#!/usr/bin/env bash
#
# Build a release tarball for one architecture.
#
#   ./scripts/build-release.sh --arch arm64 [--node 24.14.0] [--out dist]
#
# The result is a directory that needs nothing from the target machine: the application,
# its dependencies already built for that architecture, and a pinned Node runtime.
#
# Bundling dependencies is the single biggest reliability win in the whole install path.
# It removes npm, the registry, GitHub egress and the mediasoup kernel-version lookup from
# a stranger's first five minutes, makes an install work behind a firewall or offline, and
# means the bytes that were tested are the bytes that ship.
#
# Must be run on Linux: `npm ci` compiles and downloads for the platform it runs on, so a
# tarball built on Windows or macOS would carry the wrong binaries.

set -euo pipefail

ARCH=""
NODE_VERSION="24.14.0"
OUT="dist"

while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="$2"; shift 2 ;;
        --node) NODE_VERSION="$2"; shift 2 ;;
        --out)  OUT="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ "$(uname -s)" = "Linux" ] || {
    echo "Release tarballs must be built on Linux: npm ci fetches native binaries for the" >&2
    echo "platform it runs on, so building elsewhere would ship the wrong ones." >&2
    exit 1
}

if [ -z "$ARCH" ]; then
    case "$(uname -m)" in
        x86_64|amd64)  ARCH=x64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
fi

VERSION="$(node -p 'require("./package.json").version')"
NAME="weave-server-${VERSION}-linux-${ARCH}"
STAGE="$OUT/$NAME"

echo "Building $NAME (Node $NODE_VERSION)"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# ── Application ──────────────────────────────────────────────────────────────

# Explicit list rather than an exclude list. A new directory of local junk should not
# silently end up in a release because nobody remembered to exclude it.
for item in src admin deploy package.json package-lock.json LICENSE NOTICE README.md CHANGELOG.md SECURITY.md install.sh uninstall.sh docs; do
    [ -e "$item" ] && cp -R "$item" "$STAGE/"
done
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"

# ── Runtime ──────────────────────────────────────────────────────────────────

echo "Fetching Node $NODE_VERSION for linux-$ARCH"
NODE_TAR="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}" -o "$OUT/$NODE_TAR"

# Verify against the signed checksum file rather than trusting the download.
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$OUT/SHASUMS256.txt"
( cd "$OUT" && grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c - ) \
    || { echo "Node download failed its checksum. Refusing to build." >&2; exit 1; }

mkdir -p "$STAGE/runtime"
tar -xJf "$OUT/$NODE_TAR" -C "$STAGE/runtime" --strip-components=1
rm -f "$OUT/$NODE_TAR" "$OUT/SHASUMS256.txt"

"$STAGE/runtime/bin/node" -v >/dev/null || {
    echo "The bundled runtime does not execute here — expected when cross-building." >&2
}

# ── Dependencies ─────────────────────────────────────────────────────────────

# Installed BY the bundled runtime, not by whatever Node the build machine happens to
# have. mediasoup and better-sqlite3 both declare node>=22 and pick their prebuilt
# binaries based on the running interpreter, so installing with an older system Node
# produces a tarball whose dependencies do not match the runtime shipped beside them.
# Debian 13 ships Node 20, which is exactly this trap.
echo "Installing production dependencies with the bundled Node"
NODE_BIN="$ROOT/$STAGE/runtime/bin"
( cd "$STAGE" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" ci --omit=dev --no-audit --no-fund )

# mediasoup downloads a prebuilt worker on install. If that silently failed the tarball
# would look complete and the server would not start, so check rather than hope.
WORKER="$STAGE/node_modules/mediasoup/worker/out/Release/mediasoup-worker"
[ -x "$WORKER" ] || {
    echo "mediasoup-worker is missing from the build. The tarball would not run." >&2
    exit 1
}
echo "  mediasoup worker: $(file -b "$WORKER" 2>/dev/null | cut -c1-60)"


# Only now: npm and npx are not used at runtime, and the headers and docs are several
# megabytes on a Pi's SD card.
rm -rf "$STAGE/runtime/lib/node_modules/npm" \n       "$STAGE/runtime/bin/npm" "$STAGE/runtime/bin/npx" "$STAGE/runtime/bin/corepack" \n       "$STAGE/runtime/share" "$STAGE/runtime/include"

# ── Package ──────────────────────────────────────────────────────────────────

echo "Creating tarball"
( cd "$OUT" && tar -czf "$NAME.tar.gz" "$NAME" )
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

SIZE="$(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
echo
echo "  $OUT/$NAME.tar.gz  ($SIZE)"
echo "  $OUT/$NAME.tar.gz.sha256"
echo
echo "To install on a target machine:"
echo "  tar -xzf $NAME.tar.gz && cd $NAME && sudo ./install.sh"
echo
