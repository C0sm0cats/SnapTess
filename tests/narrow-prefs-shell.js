import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Narrow preferences: ${message}`); };
// SnapTess can tile Preferences into a ~360 px tile: the shortcut names must
// keep whole words there, and the key caps come back once the window widens.
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: narrow-prefs-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    // Tiling stays off so the window keeps the sizes this test gives it.
    app.setRunning(false);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE});
    launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    launcher.setenv('GI_TYPELIB_PATH', '/usr/lib/gnome-shell/girepository-1.0', true);
    launcher.setenv('LD_LIBRARY_PATH', '/usr/lib/gnome-shell', true);
    launcher.setenv('GSETTINGS_BACKEND', 'memory', true);
    const helper = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('narrow-prefs.js').get_path();
    const child = launcher.spawnv(['gjs', '-m', helper]);
    const output = [];
    const stream = new Gio.DataInputStream({base_stream: child.get_stdout_pipe()});
    const readLines = () => stream.read_line_async(0, null, (source, result) => {
        const [line] = source.read_line_finish_utf8(result);
        if (line === null) return;
        output.push(line); console.log(`narrow-prefs: ${line}`); readLines();
    });
    readLines();
    let done = false;
    const exited = new Promise(resolve => child.wait_async(null, () => { done = true; resolve(); }));
    const seen = marker => output.some(line => line.includes(marker));
    try {
        for (let n = 0; n < 150 && !seen('SNAPTESS_NARROW_PREFS_READY') && !done; n++) await Scripting.sleep(100);
        assert(seen('SNAPTESS_NARROW_PREFS_READY'), `narrow window checks: ${output.join(' / ')}`);
        const prefsWindow = global.display.list_all_windows().find(w => w.title === 'SnapTess Preferences');
        assert(prefsWindow, 'Preferences window found');
        const frame = prefsWindow.get_frame_rect();
        prefsWindow.move_resize_frame(false, frame.x, frame.y, 700, frame.height);
        await Promise.race([exited, Scripting.sleep(30000)]);
        assert(done && child.get_exit_status() === 0 && seen('SNAPTESS_NARROW_PREFS_PASSED'),
            `wide window checks: ${output.join(' / ')}`);
        const warnings = output.filter(line => /Adwaita-WARNING|Gtk-CRITICAL/.test(line));
        assert(!warnings.length, `GTK warnings: ${warnings.join(' / ')}`);
    } finally {
        if (!done) child.force_exit();
    }
    console.log('SNAPTESS_TEST_PASSED');
}
