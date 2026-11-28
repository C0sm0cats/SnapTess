// Opens SnapTess Preferences inside the headless Shell and starts recording
// the Layout Studio shortcut once the window is focused. Spawned by
// tests/shortcut-recorder-shell.js; shares its GSettings backend.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const {default: Preferences} = await import('../prefs.js');
Adw.init();
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const [, bytes] = root.get_child('metadata.json').load_contents(null);
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), dir: root, path: root.get_path()};
const prefs = new Preferences(metadata);
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
let recordButton = null;
const visit = widget => {
    if (widget instanceof Gtk.Button && widget.tooltip_text === 'Record open layout studio') recordButton = widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
};
visit(window);
if (!recordButton) throw new Error('No Layout Studio recorder');
const loop = new GLib.MainLoop(null, false);
let armed = false;
window.connect('notify::is-active', () => {
    if (armed || !window.is_active) return;
    armed = true;
    recordButton.emit('clicked');
});
window.connect('destroy', () => loop.quit());
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
window.present();
loop.run();
