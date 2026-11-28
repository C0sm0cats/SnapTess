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
    const display = app.currentMonitor();
    app.applyQuickPreset(display, app.activeSpace(display), 'auto'); await pause();
    app.toggleFloating(); await pause();
    assert(app.records.get(w).floating, 'manual arrangement changes floating membership');
    await chord(Clutter.KEY_z);
    assert(!app.records.get(w).floating && app.redoItem.sensitive, 'Ctrl+Alt+Z enables Redo');
    const steps = app.history.length;
    await chord(Clutter.KEY_r);
    assert(app.redoItem.sensitive && app.redoHistory.length === 1 && app.history.length === steps,
        'Ctrl+Alt+R without a change keeps Redo and adds no Undo step');
    app.applyQuickPreset(display, app.activeSpace(display), 'auto'); await pause();
    assert(app.redoItem.sensitive && app.redoHistory.length === 1 && app.history.length === steps,
        'Arrange open windows without a change keeps Redo and adds no Undo step');
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
    const press = async key => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        await Scripting.sleep(70);
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
        await pause();
    };
    const slots = () => app.groups.get(app.key(monitor)) ?? [];
    w.activate(global.get_current_time()); await pause();
    if (app.records.get(w).floating) { app.toggleFloating(); await pause(); }
    const left = slots()[0];
    assert(left && slots().filter(Boolean).length === 2, 'swap test starts with two tiled windows');
    left.activate(global.get_current_time()); await pause();
    const swapStep = async (keys, index, message) => {
        app.toggleSwap(); await pause();
        assert(app.swapMode, `${message}: Ctrl+Alt+S enters swap mode`);
        for (const key of keys) await (key === Clutter.KEY_s ? chord(key) : press(key));
        assert(!app.swapMode && slots().indexOf(left) === index, message);
    };
    app.toggleSwap(); await pause();
    await press(Clutter.KEY_Right);
    assert(app.swapMode && slots().indexOf(left) === 1, 'Right moves the window right in swap mode');
    await press(Clutter.KEY_Escape);
    assert(!app.swapMode && slots().indexOf(left) === 0, 'Escape cancels the swap');
    await swapStep([Clutter.KEY_Right, Clutter.KEY_Return], 1, 'Enter keeps the swap');
    await swapStep([Clutter.KEY_Left, Clutter.KEY_s], 0, 'Ctrl+Alt+S again keeps the swap');
    app.toggleSwap(); await pause();
    await press(Clutter.KEY_Right);
    await press(Clutter.KEY_Super_L); await Scripting.sleep(700);
    assert(Main.overview.visible && !app.swapMode && slots().indexOf(left) === 1,
        'Super leaves swap mode, keeps the swap and opens the overview');
    await press(Clutter.KEY_Escape); await Scripting.sleep(700);
    assert(!Main.overview.visible, 'Escape closes the overview opened from swap mode');
    await press(Clutter.KEY_Left);
    assert(slots().indexOf(left) === 1, 'arrow keys no longer move the window after the overview');
    left.activate(global.get_current_time()); await pause();
    // Each palette button runs its own action on the focused window.
    const click = async (window, button) => {
        window.activate(global.get_current_time()); await pause();
        button.emit('clicked', 1); await pause();
    };
    await click(left, app.floatAction);
    assert(app.records.get(left).floating, 'the float button floats the tiled window');
    await click(left, app.floatAction);
    assert(!app.records.get(left).floating && slots().includes(left), 'the float button tiles it again');
    await click(left, app.maximizeAction);
    assert(left.get_maximize_flags() && app.records.get(left).userSpecial,
        'the maximize button maximizes the window as a user request');
    await click(left, app.maximizeAction);
    assert(!left.get_maximize_flags(), 'the maximize button restores the window');
    await click(left, app.minimizeAction);
    assert(left.minimized && app.records.has(left), 'the minimize button minimizes without closing');
    left.unminimize(); await pause();
    const before = new Set(app.records.keys());
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const doomed = [...app.records.keys()].find(window => !before.has(window));
    assert(doomed, 'a third window is tracked for the close button');
    await click(doomed, app.closeAction);
    for (let n = 0; n < 20 && app.records.has(doomed); n++) await Scripting.sleep(100);
    assert(!app.records.has(doomed) && app.records.has(left), 'the close button closes only the focused window');
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
