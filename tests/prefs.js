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
const entries = [];
function visit(widget) {
    if (widget instanceof Adw.EntryRow) entries.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
}
visit(window);
if (entries.length !== 12) throw new Error(`Expected 12 entry rows, got ${entries.length}`);
const toggle = entries.find(row => row.title === 'Toggle tiling');
const settings = prefs.getSettings();
const scaled = entries.find(row => row.title === 'Scale-to-fit app IDs (comma separated)');
scaled.text = 'discord, discord.desktop'; scaled.emit('apply');
if (settings.get_strv('scaled-apps').join(',') !== 'discord,discord.desktop')
    throw new Error('Scale-to-fit app IDs were not saved');
const original = settings.get_strv('toggle')[0];
toggle.text = 'invalid-shortcut'; toggle.emit('apply');
if (settings.get_strv('toggle')[0] !== original) throw new Error('Invalid accelerator was saved');
toggle.text = '<Super>t'; toggle.emit('apply');
if (settings.get_strv('toggle')[0] !== '<Super>t') throw new Error('Valid accelerator was not saved');
toggle.text = ''; toggle.emit('apply');
if (settings.get_strv('toggle').length !== 0) throw new Error('Shortcut could not be disabled');
window.destroy();
print('SNAPTESS_PREFS_TESTS_PASSED');
