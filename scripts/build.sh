#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
glib-compile-schemas --strict schemas
gnome-extensions pack --force --out-dir=dist --extra-source=lib --extra-source=icons --extra-source=LICENSE .
