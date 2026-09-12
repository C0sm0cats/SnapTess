#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
UUID="snaptess@c0sm0cats.github.io"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA_HOME/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict schemas

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$ROOT" "$DEST"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" || true
    echo "SnapTess installed from: $ROOT"
    echo "Future source changes are visible directly; disable/enable the extension to hot-reload them."
else
    echo "SnapTess installed from: $ROOT"
    echo "GNOME Shell has not discovered this loader yet. Log out/in once, then enable the extension."
fi
