import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Shortcut recorder: ${message}`); };
const pause = () => Scripting.sleep(400);
// While Preferences records a shortcut, SnapTess shortcuts must reach the
// recorder instead of running their action on the desktop.
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: shortcut-recorder-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.setRunning(true); await pause();
    // Preferences only gets the keyboard focus once the seat has a keyboard.
    const keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const recording = () => { try { return app.settings.get_boolean('shortcut-recording'); } catch { return false; } };
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    launcher.setenv('GI_TYPELIB_PATH', '/usr/lib/gnome-shell/girepository-1.0', true);
    launcher.setenv('LD_LIBRARY_PATH', '/usr/lib/gnome-shell', true);
    const helper = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('shortcut-recorder-prefs.js').get_path();
    const child = launcher.spawnv(['gjs', '-m', helper]);
    const exited = new Promise(resolve => child.wait_async(null, () => resolve()));
    let prefsWindow = null;
    for (let n = 0; n < 100 && !prefsWindow; n++) {
        await Scripting.sleep(100);
        const focused = global.display.focus_window;
        if (focused?.title === 'SnapTess Preferences' && app.records.has(focused)) prefsWindow = focused;
    }
    assert(prefsWindow, 'Preferences window opened, focused and tiled');
    for (let n = 0; n < 30 && !recording(); n++) await Scripting.sleep(100);
    await pause();
    const chord = async key => {
        for (const symbol of [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, key])
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
        await Scripting.sleep(70);
        for (const symbol of [key, Clutter.KEY_Alt_L, Clutter.KEY_Control_L])
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
        await pause();
    };
    try {
        assert(recording(), 'recording suspends SnapTess shortcuts');
        await chord(Clutter.KEY_f);
        assert(!app.records.get(prefsWindow)?.floating, 'Ctrl+Alt+F while recording does not float Preferences');
        assert(!recording(), 'the recorder received Ctrl+Alt+F and stopped');
        await chord(Clutter.KEY_f);
        assert(app.records.get(prefsWindow)?.floating, 'Ctrl+Alt+F works again once recording stops');
    } finally {
        prefsWindow.delete(global.get_current_time());
        await Promise.race([exited, Scripting.sleep(5000)]);
        child.force_exit();
    }
    // A Preferences process that disappears while recording must not leave
    // the shortcuts suspended.
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const [other, w] = [...app.records.keys()];
    other.activate(global.get_current_time()); await pause();
    app.settings.set_boolean('shortcut-recording', true); await pause();
    assert(app.shortcutsSuspended, 'a recording state written by Preferences suspends the shortcuts');
    w.activate(global.get_current_time()); await pause();
    assert(!recording(), 'the focus leaving the recording window resumes the shortcuts');
    const wasFloating = app.records.get(w).floating;
    await chord(Clutter.KEY_f);
    assert(app.records.get(w).floating !== wasFloating, 'Ctrl+Alt+F works after the focus left');
    await Scripting.destroyTestWindows();
    console.log('SNAPTESS_TEST_PASSED');
}
