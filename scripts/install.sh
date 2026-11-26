#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
UUID="snaptess@c0sm0cats.github.io"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA_HOME/gnome-shell/extensions/$UUID"
STATUS_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/snaptess"
STATUS="$STATUS_DIR/runtime-status.json"
REQUEST="$STATUS_DIR/reload-request"

glib-compile-schemas --strict schemas

source_loader_version() {
    sed -n 's/^export const LOADER_VERSION = \([0-9][0-9]*\);$/\1/p' extension.js
}

status_field() {
    [[ -f "$STATUS" ]] || return 0
    command -v node >/dev/null || { echo "node is required to read $STATUS" >&2; exit 1; }
    node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
        if (v !== undefined && v !== null) console.log(v); } catch {}' "$STATUS" "$1"
}

# Never disable the extension: GNOME Shell would also restart every extension
# enabled after it. The running loader reloads SnapTess in place instead.
if [[ "$(readlink "$DEST" 2>/dev/null)" != "$ROOT" && "$(readlink "$DEST" 2>/dev/null)" != "$ROOT/" ]]; then
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    ln -s "$ROOT" "$DEST"
fi
echo "SnapTess installed from: $ROOT"

if ! gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "GNOME Shell has not discovered this loader yet. Log out/in once, then enable the extension."
    exit 0
fi
if ! gnome-extensions info "$UUID" | grep -qE ': (ACTIVE|ENABLED)$'; then
    gnome-extensions enable "$UUID" || true
    echo "SnapTess enabled."
    exit 0
fi

running=$(status_field loader_version)
if [[ -z "$running" || "$running" != "$(source_loader_version)" ]]; then
    echo "New SnapTess loader (v$(source_loader_version)), running: v${running:-0}. Log out and back in once to activate it;"
    echo "later updates then reload in place without touching other extensions."
    exit 0
fi

before=$(status_field loaded_at)
mkdir -p "$STATUS_DIR"
date +%s%N > "$REQUEST.tmp" && mv "$REQUEST.tmp" "$REQUEST"
for _ in $(seq 50); do
    sleep 0.1
    after=$(status_field loaded_at)
    if [[ -n "$after" && "$after" != "$before" ]]; then
        if [[ -n "$(status_field error)" ]]; then
            echo "SnapTess reload failed: $(status_field error). Fix it and run this script again." >&2
            exit 1
        fi
        echo "SnapTess reloaded in place: runtime revision $(status_field runtime_revision), loader v$running."
        exit 0
    fi
done
echo "Reload requested, but SnapTess did not confirm within 5 s. Check: journalctl --user -b | grep SnapTess" >&2
exit 1
