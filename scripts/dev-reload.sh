#!/usr/bin/env bash
set -euo pipefail

UUID="snaptess@c0sm0cats.github.io"

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
gnome-extensions enable "$UUID"

echo "SnapTess reloaded without restarting GNOME Shell."
