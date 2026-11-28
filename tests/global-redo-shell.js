import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Global redo: ${message}`); };
const pause = () => Scripting.sleep(350);
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: global-redo-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry.stateObj.runtime;
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.setRunning(true); await pause();
    const w = [...app.records.keys()][0]; w.activate(global.get_current_time()); await pause();
    const keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const chord = async key => {
        for (const symbol of [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, key])
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
        await Scripting.sleep(70);
        for (const symbol of [key, Clutter.KEY_Alt_L, Clutter.KEY_Control_L])
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
        await pause();
    };
    assert(app.settings.get_strv('redo')[0] === '<Control><Alt>y' && app.bindings.redo,
        'Redo has a registered Ctrl+Alt+Y binding');
    app.toggleFloating(); await pause();
    assert(app.records.get(w).floating, 'manual arrangement changes floating membership');
    await chord(Clutter.KEY_z);
    assert(!app.records.get(w).floating && app.redoItem.sensitive, 'Ctrl+Alt+Z enables Redo');
    await chord(Clutter.KEY_y);
    assert(app.records.get(w).floating && !app.redoItem.sensitive, 'Ctrl+Alt+Y restores the manual arrangement');
    await chord(Clutter.KEY_z);
    app.redoItem.emit('activate', null); await pause();
    assert(app.records.get(w).floating, 'panel menu also restores the arrangement');
    await chord(Clutter.KEY_z);
    app.toggleFloating(); await pause();
    assert(!app.redoHistory.length && !app.redoItem.sensitive, 'a new manual arrangement clears Redo');
    app.setRunning(false); await pause();
    assert(!app.history.length && !app.redoHistory.length && !app.redoItem.sensitive,
        'stopping clears and disables both histories');
    app.setRunning(true); await pause();
    const monitor = app.currentMonitor();
    for (const [key, space] of [[Clutter.KEY_2, 1], [Clutter.KEY_3, 2], [Clutter.KEY_1, 0]]) {
        await chord(key);
        assert(app.activeSpace(monitor) === space, `Ctrl+Alt+${space + 1} opens Space ${space + 1}`);
    }
    await chord(Clutter.KEY_q);
    assert(!app.running, 'Ctrl+Alt+Q stops tiling');
    await chord(Clutter.KEY_t);
    assert(app.running, 'Ctrl+Alt+T starts tiling');
    await chord(Clutter.KEY_t);
    assert(!app.running, 'Ctrl+Alt+T stops tiling again');
    await Main.extensionManager.disableExtension(entry.uuid); await pause();
    await Main.extensionManager.enableExtension(entry.uuid);
    for (let n = 0; n < 30 && (!entry.stateObj?.runtime || entry.stateObj.runtime === app); n++)
        await Scripting.sleep(100);
    const reloaded = entry.stateObj.runtime;
    await Scripting.sleep(1000); // The first press right after enable can be missed; let the bindings settle.
    assert(reloaded && reloaded !== app && !reloaded.running, 'enable loads a new stopped runtime');
    await chord(Clutter.KEY_t);
    assert(reloaded.running, 'shortcuts reach the runtime after disable and enable');
    await chord(Clutter.KEY_t);
    assert(!reloaded.running, 'Ctrl+Alt+T stops the new runtime');
    console.log('SNAPTESS_GLOBAL_REDO_TESTS_PASSED');
}
