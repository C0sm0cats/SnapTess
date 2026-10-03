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
    const keyboard = Clutter.get_default_backend().get_default_seat()
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
    console.log('SNAPTESS_GLOBAL_REDO_TESTS_PASSED');
}
