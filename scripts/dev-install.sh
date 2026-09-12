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

echo "SnapTess development link: $DEST -> $ROOT"
echo "Source edits are now visible directly to GNOME Shell."

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" || true
else
    echo "GNOME Shell has not discovered SnapTess yet. Log out/in once, then enable it."
fi

echo "After the one-time loader migration, reload future JS changes with: ./scripts/dev-reload.sh"
