#!/usr/bin/env bash
#
# Weave uninstaller.
#
# An installer without a clean uninstall is a trap, so this removes exactly what
# install.sh created and nothing else.
#
# Your data is KEPT by default. The database, uploads and backups stay in /var/lib/weave
# and the settings stay in /etc/weave, so reinstalling picks up where you left off.
# Removing those is a separate, explicit choice: pass --purge, and confirm it.

set -euo pipefail

WEAVE_USER="${WEAVE_USER:-weave}"
PREFIX="${WEAVE_PREFIX:-/opt/weave}"
DATA_DIR="${WEAVE_DATA_DIR:-/var/lib/weave}"
CONF_DIR="${WEAVE_CONF_DIR:-/etc/weave}"
UNIT=/etc/systemd/system/weave.service

PURGE=false
[ "${1:-}" = "--purge" ] && PURGE=true

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m\n%s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

bold ""
bold "Uninstalling Weave"
bold "──────────────────"

if systemctl list-unit-files 2>/dev/null | grep -q '^weave.service'; then
    systemctl disable --now weave >/dev/null 2>&1 || true
    info "Service stopped and disabled"
fi

rm -f "$UNIT"
systemctl daemon-reload 2>/dev/null || true
rm -f /usr/local/bin/weave
rm -rf "$PREFIX"
info "Removed $PREFIX, the service and the weave command"

if [ "$PURGE" = true ]; then
    bold ""
    warn "--purge will permanently delete:"
    warn "    $DATA_DIR   (database, uploads, backups)"
    warn "    $CONF_DIR   (settings)"
    warn "There is no undo. Take a backup first if you are unsure:  weave backup"
    bold ""
    # Typed in full, deliberately. A y/n prompt is too easy to answer by reflex when the
    # thing on the other side is everyone's accounts and message history.
    printf '  Type DELETE to confirm: '
    read -r CONFIRM
    if [ "$CONFIRM" = "DELETE" ]; then
        rm -rf "$DATA_DIR" "$CONF_DIR"
        userdel "$WEAVE_USER" 2>/dev/null || true
        info "Data, settings and the $WEAVE_USER account removed"
    else
        warn "Not confirmed — data and settings were kept"
    fi
else
    bold ""
    info "Kept: $DATA_DIR (database, uploads, backups)"
    info "Kept: $CONF_DIR (settings)"
    info "Kept: the $WEAVE_USER account, which owns them"
    info ""
    info "Reinstalling will pick these up. To remove them too:  sudo ./uninstall.sh --purge"
fi

bold ""
bold "Done"
bold ""
