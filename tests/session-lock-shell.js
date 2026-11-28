import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Session lock: ${message}`); };
const pause = () => Scripting.sleep(400);
const frame = w => { const r = w.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(','); };
// ScreenShield pushes this mode when the session locks and pops it on unlock;
// ExtensionManager follows these session mode changes.
const lock = async () => { Main.sessionMode.pushMode('unlock-dialog'); await pause(); };
const unlock = async () => { Main.sessionMode.popMode('unlock-dialog'); await pause(); };
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: session-lock-shell.js');
    await Scripting.sleep(1000); Main.overview.hide(); await pause();
    const uuid = 'snaptess@c0sm0cats.github.io';
    const entry = Main.extensionManager.lookup(uuid);
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const loader = entry.stateObj, app = loader.runtime;
    assert(app, 'runtime loaded');
    for (let i = 0; i < 2; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const first = [...app.records.keys()];
    assert(first.length === 2, `two windows tracked, got ${first.length}`);
    app.setRunning(true); await pause();
    app.switchSpace(1, 0); await pause();
    for (let i = 0; i < 2; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await Scripting.sleep(800);
    const second = [...app.records.keys()].filter(w => !first.includes(w));
    assert(second.length === 2, `two windows opened in Space 2, got ${second.length}`);
    app.applyProfile(0, 1, 'split', second); await pause();
    assert(first.every(w => w.minimized) && second.every(w => !w.minimized), 'Space 1 windows parked before locking');
    const geometry = second.map(frame), history = app.history.length;
    assert(history > 0, 'arrangement history recorded before locking');
    app.openStudio(); await pause();
    assert(app.studio, 'Studio open before locking');

    await lock();
    assert(entry.state === ExtensionState.ACTIVE, `extension stays enabled while locked (state ${entry.state})`);
    assert(loader.runtime === app && app.running, 'tiling keeps running while locked');
    assert(!app.indicator.container.visible, 'panel indicator hidden on the lock screen');
    assert(!app.studio && !app.layoutSwitcher && !app.swapMode, 'dialogs closed on the lock screen');
    assert(!app.border.visible && !app.windowActionHandle.visible, 'window overlays hidden on the lock screen');
    await unlock();
    assert(entry.state === ExtensionState.ACTIVE && loader.runtime === app && app.running, 'tiling still running after unlock');
    assert(app.indicator.container.visible, 'panel indicator shown again after unlock');
    assert(first.every(w => w.minimized) && second.every(w => !w.minimized), 'Spaces kept across the lock');
    assert(second.every((w, i) => frame(w) === geometry[i]),
        `tiles kept across the lock: ${second.map(frame).join(' ')} vs ${geometry.join(' ')}`);
    assert(app.activeSpace(0) === 1 && app.history.length === history, 'active Space and Undo kept across the lock');

    // An in-place reload requested while locked (scripts/install.sh) keeps
    // the new runtime off the lock screen.
    await lock();
    const request = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'snaptess', 'reload-request']);
    GLib.file_set_contents(`${request}.tmp`, `${GLib.get_real_time()}`);
    GLib.rename(`${request}.tmp`, request);
    for (let n = 0; n < 50 && (!loader.runtime || loader.runtime === app); n++) await Scripting.sleep(100);
    const reloaded = loader.runtime;
    assert(reloaded && reloaded !== app, 'reload while locked swaps the runtime');
    assert(!reloaded.indicator.container.visible, 'reloaded runtime keeps its indicator off the lock screen');
    await unlock();
    assert(reloaded.indicator.container.visible, 'reloaded runtime shows its indicator after unlock');
    await Scripting.destroyTestWindows();
    console.log('SNAPTESS_SESSION_LOCK_TESTS_PASSED');
}
