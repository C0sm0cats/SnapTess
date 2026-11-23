#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# A release must carry new version numbers: refuse to pack a version that
# is already tagged, locally or on GitHub (tests/version.test.js keeps the
# three numbers in step).
version=$(node -p 'require("./package.json").version')
git_() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
if git_ rev-parse -q --verify "refs/tags/v$version" >/dev/null ||
    git_ ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1; then
    echo "v$version is already released: bump package.json, metadata.json and RUNTIME_REVISION first." >&2
    exit 1
fi
mkdir -p dist
glib-compile-schemas --strict schemas
gnome-extensions pack --force --out-dir=dist --extra-source=runtime.js --extra-source=lib --extra-source=icons --extra-source=LICENSE --extra-source=package.json .
