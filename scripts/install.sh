#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
gnome-extensions install --force dist/snaptess@c0sm0cats.github.io.shell-extension.zip
if gnome-extensions info snaptess@c0sm0cats.github.io >/dev/null 2>&1; then
    gnome-extensions enable snaptess@c0sm0cats.github.io
else
    echo 'Installed. Log out and back in, then run: gnome-extensions enable snaptess@c0sm0cats.github.io'
fi
