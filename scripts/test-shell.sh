#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
# A private bus and temporary XDG directories isolate this from your desktop.
echo 'Running GNOME Shell 50 integration and GTK preferences tests'
# Match the deterministic background used by local headless validation.
export SHELL_BACKGROUND_IMAGE="${SHELL_BACKGROUND_IMAGE:-$PWD/docs/snaptess-overview-blurred.png}"
perf_helper=''
for candidate in /usr/libexec/gnome-shell-perf-helper /usr/lib/gnome-shell-perf-helper; do
    if [[ -x "$candidate" ]]; then perf_helper="$candidate"; break; fi
done
if [[ -z "$perf_helper" ]]; then
    echo 'GNOME Shell PerfHelper is required for the headless test' >&2
    exit 1
fi
test_data_home="$(mktemp -d)"
cleanup() {
    # Let private-bus services finish shutting down before removing their sockets.
    sleep 0.5
    # The document portal may leave a FUSE mount in the private runtime directory.
    if mountpoint -q "$test_data_home/runtime/doc"; then
        fusermount3 -u "$test_data_home/runtime/doc" 2>/dev/null || true
    fi
    rm -rf -- "$test_data_home"
}
trap cleanup EXIT
mkdir -p "$test_data_home/dbus-1/services" "$test_data_home/runtime"
chmod 700 "$test_data_home/runtime"
# scripting.js also starts PerfHelper directly; keep its test windows alive
# for the full integration run, not just the helper's default idle period.
printf '[D-BUS Service]\nName=org.gnome.Shell.PerfHelper\nExec=%s --idle-timeout=120\n' "$perf_helper" > \
    "$test_data_home/dbus-1/services/org.gnome.Shell.PerfHelper.service"
monitor_args=()
if [[ "${SNAPTESS_TWO_MONITORS:-0}" == 1 ]]; then monitor_args=(--wrap "$PWD/scripts/two-monitors.sh"); fi
test_log="$test_data_home/shell-test.log"
set +e
GNOME_SHELL_BUILDDIR="$PWD/scripts" SNAPTESS_PERF_HELPER="$perf_helper" \
XDG_DATA_HOME="$test_data_home" XDG_RUNTIME_DIR="$test_data_home/runtime" timeout 90s dbus-run-session -- \
    gnome-shell-test-tool --headless --disable-animations \
    "${monitor_args[@]}" \
    --extension dist/snaptess@c0sm0cats.github.io.shell-extension.zip "${1:-tests/shell.js}" 2>&1 | tee "$test_log"
test_status=${PIPESTATUS[0]}
set -e
if [[ "$test_status" == 124 ]] && ! grep -q 'SNAPTESS_TEST_STARTED:' "$test_log"; then
    echo 'GNOME startup timed out before the test fixture started.' >&2
    if [[ "${SNAPTESS_STARTUP_RETRY:-0}" == 0 ]]; then
        echo 'Retrying startup once with a fresh private desktop session.' >&2
        cleanup
        trap - EXIT
        export SNAPTESS_STARTUP_RETRY=1
        exec bash "$0" "$@"
    fi
elif [[ "$test_status" == 124 ]]; then
    echo 'Test execution timed out after the fixture started; no automatic retry.' >&2
elif [[ "$test_status" != 0 ]]; then
    echo "GNOME test failed with exit code $test_status; no automatic retry." >&2
fi
exit "$test_status"
