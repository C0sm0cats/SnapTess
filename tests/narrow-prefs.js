// Opens SnapTess Preferences at the narrowest Adwaita width inside the
// headless Shell and checks the keyboard shortcut rows, then again once
// tests/narrow-prefs-shell.js has widened the window. Prints its progress
// on stderr, unbuffered, for the Shell test.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const {default: Preferences} = await import('../prefs.js');
Adw.init();
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const [, bytes] = root.get_child('metadata.json').load_contents(null);
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), dir: root, path: root.get_path()};
const prefs = new Preferences(metadata);
const settings = prefs.getSettings();
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
window.set_default_size(360, 700);

const descendants = widget => {
    const found = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) found.push(...descendants(child));
    return found;
};
const shortcutRows = () => descendants(window).filter(widget => widget instanceof Adw.ActionRow &&
    descendants(widget).some(child => child instanceof Gtk.ShortcutLabel)).map(row => {
    const parts = descendants(row);
    return {row, title: parts.find(child => child instanceof Gtk.Label && child.has_css_class('title')),
        keys: parts.find(child => child instanceof Gtk.ShortcutLabel)};
});
// A wrapped line that starts inside a word: "Arran|ge again".
const midWordBreaks = label => {
    const text = label.get_text();
    return label.get_layout().get_lines_readonly().slice(1).map(line => line.start_index)
        .filter(start => start > 0 && text[start - 1] !== ' ' && text[start] !== ' ')
        .map(start => `${text.slice(0, start)}|${text.slice(start)}`);
};
const label = accelerator => {
    const [valid, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return accelerator && valid ? Gtk.accelerator_get_label(keyval, mods) : 'Off';
};
const settle = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const check = narrow => {
    const rows = shortcutRows();
    if (rows.length !== 16) throw new Error(`Expected 16 shortcut rows, got ${rows.length}`);
    const problems = [];
    for (const {row, title, keys} of rows) {
        const breaks = midWordBreaks(title);
        if (breaks.length) problems.push(`${row.title} breaks mid-word (${breaks.join(', ')}) at ${window.get_width()} px`);
        const [, natural] = keys.measure(Gtk.Orientation.VERTICAL, -1);
        if (keys.get_mapped() && keys.get_height() > natural + 1)
            problems.push(`${row.title} key caps stretched to ${keys.get_height()} px for ${natural}`);
        if (narrow && (keys.get_mapped() || row.subtitle !== label(keys.accelerator)))
            problems.push(`${row.title} keeps its key caps or lacks the "${label(keys.accelerator)}" subtitle (${row.subtitle})`);
        if (!narrow && (!keys.get_mapped() || row.subtitle))
            problems.push(`${row.title} hides its key caps or keeps the subtitle ${row.subtitle} at ${window.get_width()} px`);
    }
    if (problems.length) throw new Error(problems.join('; '));
};

let failure = null;
const steps = async () => {
    for (let n = 0; n < 100 && !window.get_mapped(); n++) await settle(100);
    await settle(800);
    if (window.get_width() > 400) throw new Error(`Preferences opened ${window.get_width()} px wide, not narrow`);
    check(true);
    // The subtitle follows a shortcut changed while the window is narrow.
    const studio = shortcutRows().find(({row}) => row.title === 'Open Layout Studio').row;
    settings.set_strv('studio', ['<Control><Alt>k']); await settle(100);
    if (studio.subtitle !== label('<Control><Alt>k')) throw new Error(`Changed shortcut shows ${studio.subtitle}`);
    settings.set_strv('studio', []); await settle(100);
    if (studio.subtitle !== 'Off') throw new Error(`Disabled shortcut shows ${studio.subtitle}`);
    settings.reset('studio');
    printerr('SNAPTESS_NARROW_PREFS_READY');
    for (let n = 0; n < 200 && window.get_width() < 600; n++) await settle(100);
    if (window.get_width() < 600) throw new Error(`Preferences were not widened (${window.get_width()} px)`);
    await settle(800);
    check(false);
    printerr('SNAPTESS_NARROW_PREFS_PASSED');
};
window.present();
// Awaited at the top level, so gjs keeps its own loop running (and its
// promise jobs) until the checks finish.
await Promise.race([steps(), settle(60000).then(() => { throw new Error('Timed out'); })])
    .catch(error => { failure = error; });
window.destroy();
if (failure) {
    printerr(`SNAPTESS_NARROW_PREFS_FAILED: ${failure.message}`);
    System.exit(1);
}
