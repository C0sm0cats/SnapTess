#!/usr/bin/env bash
# Publish the merged main branch as a GitHub release: scripts/release.sh NOTES_FILE
# Refuses a version that is already released, so a release cannot ship
# without new version numbers (tests/version.test.js keeps package.json,
# metadata.json and RUNTIME_REVISION in step).
set -euo pipefail
cd "$(dirname "$0")/.."
notes=${1:?usage: scripts/release.sh NOTES_FILE}
git_() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
version=v$(node -p 'require("./package.json").version')
git_ fetch -q origin
[ "$(git_ rev-parse --abbrev-ref HEAD)" = main ] || { echo "Not on main." >&2; exit 1; }
[ -z "$(git_ status --porcelain)" ] || { echo "Uncommitted changes." >&2; exit 1; }
[ "$(git_ rev-parse HEAD)" = "$(git_ rev-parse origin/main)" ] || { echo "main is not origin/main." >&2; exit 1; }
if git_ rev-parse -q --verify "refs/tags/$version" >/dev/null ||
    git_ ls-remote --exit-code --tags origin "refs/tags/$version" >/dev/null 2>&1; then
    echo "$version is already released: bump package.json, metadata.json and RUNTIME_REVISION first." >&2
    exit 1
fi
npm test >/dev/null
bash scripts/build.sh
git_ tag "$version"
git_ push -q origin "$version"
gh release create "$version" --title "$version" --notes-file "$notes" dist/snaptess@c0sm0cats.github.io.shell-extension.zip
