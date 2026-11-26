import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Loader reload: ${message}`); };
const readStatus = () => {
    const [, data] = GLib.file_get_contents(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'snaptess', 'runtime-status.json']));
    return JSON.parse(new TextDecoder().decode(data));
};
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: loader-reload-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const uuid = 'snaptess@c0sm0cats.github.io';
    const entry = Main.extensionManager.lookup(uuid);
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const before = entry.stateObj.runtime, state = entry.state;
    assert(before?.running !== undefined, 'runtime loaded at enable');
    assert(readStatus().loader_version === 1, 'status exposes the loader version');
    assert(/^\d+\.\d+\.\d+$/.test(readStatus().release_version ?? ''), 'status exposes the running release version');
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await Scripting.sleep(400);
    const w = [...before.records.keys()][0];
    assert(w, 'window tracked before reload');
    // GNOME restarts the extensions enabled after SnapTess only from a disable
    // of SnapTess itself: a reload must never reach the loader's disable().
    const changes = [];
    const id = Main.extensionManager.connect('extension-state-changed', (_m, ext) => changes.push(ext.uuid));
    let disables = 0;
    const loaderDisable = entry.stateObj.disable;
    entry.stateObj.disable = function () { disables++; return loaderDisable.call(this); };
    const stylesheetBefore = entry.stylesheet;
    const statusBefore = readStatus();
    const request = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'snaptess', 'reload-request']);
    GLib.file_set_contents(`${request}.tmp`, `${GLib.get_real_time()}`);
    GLib.rename(`${request}.tmp`, request);
    const swapped = from => entry.stateObj.runtime && entry.stateObj.runtime !== from;
    for (let n = 0; n < 50 && !swapped(before); n++) await Scripting.sleep(100);
    await Scripting.sleep(300);
    Main.extensionManager.disconnect(id);
    const after = entry.stateObj.runtime;
    assert(after && after !== before, 'request file swaps the runtime');
    assert(changes.length === 0 && disables === 0, `extension never disabled (${changes.join(', ')})`);
    assert(entry.state === state, 'extension stays enabled');
    assert(!GLib.file_test(request, GLib.FileTest.EXISTS), 'request consumed');
    assert(after.records.has(w), 'new runtime tracks the open window');
    assert(!before.records.size, 'old runtime torn down');
    assert(entry.stylesheet?.get_basename() === 'stylesheet.css' && entry.stylesheet !== stylesheetBefore,
        'stylesheet reloaded');
    assert(readStatus().runtime_uri !== statusBefore.runtime_uri && readStatus().loader_version === 1, 'status rewritten');
    // A direct reload works the same way.
    entry.stateObj.reload();
    for (let n = 0; n < 50 && !swapped(after); n++) await Scripting.sleep(100);
    assert(entry.stateObj.runtime && entry.stateObj.runtime !== after, 'direct reload swaps the runtime');
    // A runtime that fails half-way through enable() does not block the next reload.
    const addToStatusArea = Main.panel.addToStatusArea;
    Main.panel.addToStatusArea = () => { throw new Error('injected enable failure'); };
    const healthy = entry.stateObj.runtime;
    entry.stateObj.reload();
    for (let n = 0; n < 50 && !readStatus().error; n++) await Scripting.sleep(100);
    Main.panel.addToStatusArea = addToStatusArea;
    assert(!entry.stateObj.runtime && /injected/.test(readStatus().error), 'failed load reported in status');
    assert(readStatus().loader_version === 1, 'loader version kept after a failed load');
    entry.stateObj.reload();
    for (let n = 0; n < 50 && !swapped(healthy); n++) await Scripting.sleep(100);
    assert(swapped(healthy) && !readStatus().error, 'next reload recovers');
    entry.stateObj.disable = loaderDisable;
    console.log('SNAPTESS_TEST_PASSED: loader-reload-shell.js');
}
