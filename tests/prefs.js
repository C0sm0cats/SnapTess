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
const settings = prefs.getSettings();
const appInfo = Gio.AppInfo.get_all().find(info => info.should_show() && info.get_id()?.endsWith('.desktop'));
if (!appInfo) throw new Error('No installed desktop application available for preferences test');
const appId = appInfo.get_id(), legacyId = appId.slice(0, -8);
settings.set_strv('scaled-apps', [legacyId, appId, 'custom-test.window']);
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
const entries = [], apps = [];
function visit(widget) {
    if (widget instanceof Adw.EntryRow) entries.push(widget);
    if (widget instanceof Adw.ExpanderRow) apps.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
}
visit(window);
if (entries.length !== 11) throw new Error(`Expected search and 10 shortcut rows, got ${entries.length}`);
const toggle = entries.find(row => row.title === 'Toggle tiling');
const search = entries.find(row => row.title === 'Search applications');
const appRow = apps.find(row => row.subtitle === appId);
if (!appRow) throw new Error(`Installed application ${appId} is missing from selector`);
if (!apps.some(row => row.subtitle.includes('custom-test.window')))
    throw new Error('Previously configured custom app ID was lost');
const switches = [];
for (let child = appRow.get_first_child(); child; child = child.get_next_sibling()) {
    const visitSwitches = widget => {
        if (widget instanceof Adw.SwitchRow) switches.push(widget);
        for (let nested = widget.get_first_child(); nested; nested = nested.get_next_sibling()) visitSwitches(nested);
    };
    visitSwitches(child);
}
const scaled = switches.find(row => row.title === 'Allow scale-to-fit');
const floating = switches.find(row => row.title === 'Always floating');
if (!scaled?.active || !floating) throw new Error('Application rules are missing or did not load');
scaled.active = false;
if (settings.get_strv('scaled-apps').join(',') !== 'custom-test.window')
    throw new Error('Disabling scale-to-fit did not clear both app ID aliases');
scaled.active = true;
if (settings.get_strv('scaled-apps').join(',') !== `custom-test.window,${appId}`)
    throw new Error('Enabling scale-to-fit did not save the canonical app ID');
floating.active = true;
if (!settings.get_strv('excluded-apps').includes(appId)) throw new Error('Always floating was not saved');
floating.active = false;
if (settings.get_strv('excluded-apps').includes(appId)) throw new Error('Always floating was not cleared');
search.text = 'not-an-installed-app';
if (appRow.visible) throw new Error('Application search did not filter rows');
search.text = appInfo.get_display_name();
if (!appRow.visible) throw new Error('Application search did not restore matching row');
const original = settings.get_strv('toggle')[0];
toggle.text = 'invalid-shortcut'; toggle.emit('apply');
if (settings.get_strv('toggle')[0] !== original) throw new Error('Invalid accelerator was saved');
toggle.text = '<Super>t'; toggle.emit('apply');
if (settings.get_strv('toggle')[0] !== '<Super>t') throw new Error('Valid accelerator was not saved');
toggle.text = ''; toggle.emit('apply');
if (settings.get_strv('toggle').length !== 0) throw new Error('Shortcut could not be disabled');
window.destroy();
print('SNAPTESS_PREFS_TESTS_PASSED');
