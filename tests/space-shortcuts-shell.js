import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Space shortcuts: ${message}`); };
const pause = () => Scripting.sleep(400);
// Two displays: the Space shortcuts act on the display the user works on, even
// after a switch empties it and GNOME focuses a window of the other display.
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: space-shortcuts-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    assert(Main.layoutManager.monitors.length > 1, 'two displays (run with SNAPTESS_TWO_MONITORS=1)');
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    for (let i = 0; i < 4; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.setRunning(true); await pause();
    const windows = [...app.records.keys()];
    assert(windows.length === 4, 'four windows tracked');
    const [w0, w1, w2, w3] = windows;
    app.applyProfile(0, 0, 'auto', [w0, w1]); await pause();
    app.applyProfile(1, 0, 'auto', [w2, w3]); await pause();
    assert(w2.get_monitor() === 1 && w3.get_monitor() === 1 && w0.get_monitor() === 0 && w1.get_monitor() === 0,
        'two windows on each display');
    w3.activate(global.get_current_time()); await pause();
    assert(global.display.focus_window === w3, 'display 2 has the focus');
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
    const spaces = () => `${app.activeSpace(0) + 1}/${app.activeSpace(1) + 1}`;
    await chord(Clutter.KEY_2);
    assert(spaces() === '1/2' && w2.minimized && w3.minimized && !w0.minimized && !w1.minimized,
        `Ctrl+Alt+2 empties display 2 only (spaces ${spaces()})`);
    await chord(Clutter.KEY_l);
    assert(app.layoutSwitcher?.monitor === 1 && app.layoutSwitcher.space === 1,
        `Ctrl+Alt+L opens for the emptied display (display ${app.layoutSwitcher?.monitor + 1})`);
    app.layoutSwitcher.dialog.close(); await pause();
    await chord(Clutter.KEY_p);
    assert(app.studio?.monitor === 1 && app.studio.space === 1,
        `Ctrl+Alt+P opens Studio for the emptied display (display ${app.studio?.monitor + 1})`);
    app.studio.dialog.close(); await pause();
    await chord(Clutter.KEY_1);
    assert(spaces() === '1/1' && !w2.minimized && !w3.minimized && !w0.minimized && !w1.minimized,
        `Ctrl+Alt+1 brings display 2 back (spaces ${spaces()})`);
    assert(global.display.focus_window?.get_monitor() === 1, 'the focus returns to display 2');
    await chord(Clutter.KEY_2);
    await chord(Clutter.KEY_2);
    assert(spaces() === '1/2' && !w0.minimized && !w1.minimized,
        `Ctrl+Alt+2 again never empties display 1 (spaces ${spaces()})`);
    w0.activate(global.get_current_time()); await pause();
    w1.activate(global.get_current_time()); await pause();
    await chord(Clutter.KEY_2);
    assert(spaces() === '2/2' && w0.minimized && w1.minimized,
        `after focusing display 1, Ctrl+Alt+2 acts on display 1 (spaces ${spaces()})`);
    app.setRunning(false); await pause();
    await Scripting.destroyTestWindows();
    console.log('SNAPTESS_SPACE_SHORTCUTS_TESTS_PASSED');
}
