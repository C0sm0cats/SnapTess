#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
# A private bus and temporary XDG directories isolate this from your desktop.
echo 'Running GNOME Shell 50 integration and GTK preferences tests'
timeout 55s dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
    --extension dist/snaptess@c0sm0cats.github.io.shell-extension.zip tests/shell.js
