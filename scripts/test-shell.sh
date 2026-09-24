#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
# A private bus and temporary XDG directories isolate this from your desktop.
echo 'Running GNOME Shell 50 integration and GTK preferences tests'
perf_helper=''
for candidate in /usr/libexec/gnome-shell-perf-helper /usr/lib/gnome-shell-perf-helper; do
    if [[ -x "$candidate" ]]; then perf_helper="$candidate"; break; fi
done
if [[ -z "$perf_helper" ]]; then
    echo 'GNOME Shell PerfHelper is required for the headless test' >&2
    exit 1
fi
test_data_home="$(mktemp -d)"
trap 'rm -rf -- "$test_data_home"' EXIT
mkdir -p "$test_data_home/dbus-1/services"
# scripting.js also starts PerfHelper directly; keep its test windows alive
# for the full integration run, not just the helper's default idle period.
printf '[D-BUS Service]\nName=org.gnome.Shell.PerfHelper\nExec=%s --idle-timeout=120\n' "$perf_helper" > \
    "$test_data_home/dbus-1/services/org.gnome.Shell.PerfHelper.service"
monitor_args=()
if [[ "${SNAPTESS_TWO_MONITORS:-0}" == 1 ]]; then monitor_args=(--wrap "$PWD/scripts/two-monitors.sh"); fi
GNOME_SHELL_BUILDDIR="$PWD/scripts" SNAPTESS_PERF_HELPER="$perf_helper" \
XDG_DATA_HOME="$test_data_home" timeout 90s dbus-run-session -- \
    gnome-shell-test-tool --headless --disable-animations \
    "${monitor_args[@]}" \
    --extension dist/snaptess@c0sm0cats.github.io.shell-extension.zip tests/shell.js
