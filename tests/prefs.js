import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const {default: Preferences} = await import('../prefs.js');
Adw.init();
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const [, bytes] = root.get_child('metadata.json').load_contents(null);
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), dir: root, path: root.get_path()};
const prefs = new Preferences(metadata);
const settings = prefs.getSettings();
const installedApps = Gio.AppInfo.get_all().filter(info => info.should_show() && info.get_id()?.endsWith('.desktop'));
const appInfo = installedApps.find(info => info.get_startup_wm_class?.()) ?? installedApps[0];
if (!appInfo) throw new Error('No installed desktop application available for preferences test');
const appId = appInfo.get_id(), legacyId = appId.slice(0, -8);
const startupAlias = appInfo.get_startup_wm_class?.();
settings.set_strv('scaled-apps', [legacyId, appId, ...(startupAlias ? [startupAlias] : []), 'custom-test.window']);
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
const entries = [], apps = [], groups = [], rows = [], spins = [], previews = [], resetButtons = [], shortcutLabels = [], recordButtons = [];
function visit(widget) {
    if (widget instanceof Adw.EntryRow) entries.push(widget);
    if (widget instanceof Adw.ExpanderRow) apps.push(widget);
    if (widget instanceof Adw.PreferencesGroup) groups.push(widget);
    if (widget instanceof Adw.ActionRow) rows.push(widget);
    if (widget instanceof Adw.SpinRow) spins.push(widget);
    if (widget instanceof Gtk.DrawingArea && widget.tooltip_text?.includes('Live layout of the active')) previews.push(widget);
    if (widget instanceof Gtk.Button && widget.tooltip_text?.startsWith('Reset ')) resetButtons.push(widget);
    if (widget instanceof Gtk.ShortcutLabel) shortcutLabels.push(widget);
    if (widget instanceof Gtk.Button && widget.tooltip_text?.startsWith('Record ')) recordButtons.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
}
visit(window);
if (entries.length !== 11) throw new Error(`Expected search and 10 shortcut rows, got ${entries.length}`);
if (previews.length !== 1 || resetButtons.length !== 7 || shortcutLabels.length !== 10 || recordButtons.length !== 10)
    throw new Error('Live layout preview or native shortcut controls are missing');
if (previews[0].get_content_width() !== 220 || previews[0].get_content_height() !== 116)
    throw new Error('Focus layout preview has no usable geometry');
const previewRow = rows.find(row => row.title === 'Current space preview');
if (!previewRow) throw new Error('Current space preview row is missing');
settings.set_string('preview-state', JSON.stringify({running: true, workspace: 1, monitor: 0, space: 2,
    preset: 'auto', count: 3, occupied: [0, 2], focused: 0, width: 1920, height: 1080}));
if (!previewRow.subtitle.includes('Workspace 2 · Display 1 · Space 3 · Focus'))
    throw new Error('Preview did not follow the active space and layout');
settings.reset('preview-state');
if (!previewRow.subtitle.includes('Start arranging windows')) throw new Error('Paused preview remained visible');
for (const [key, title, changed] of [['gap', 'Window spacing', 19], ['padding', 'Screen edge spacing', 21]]) {
    const button = resetButtons.find(item => item.tooltip_text === `Reset ${title} to default`);
    settings.set_int(key, changed);
    if (!button.visible) throw new Error(`${title} reset did not appear`);
    button.emit('clicked');
    if (settings.get_int(key) !== settings.get_default_value(key).get_int32() || button.visible)
        throw new Error(`${title} did not reset independently`);
}
for (const [key, title] of [['active-border', 'Highlight the focused window'],
    ['animations', 'Animate placement guides'], ['compact-minimize', 'Close gaps when minimizing'],
    ['compact-close', 'Close gaps when closing']]) {
    const button = resetButtons.find(item => item.tooltip_text === `Reset ${title} to default`);
    settings.set_boolean(key, !settings.get_default_value(key).get_boolean());
    if (!button.visible) throw new Error(`${title} reset did not appear`);
    button.emit('clicked');
    if (settings.get_boolean(key) !== settings.get_default_value(key).get_boolean() || button.visible)
        throw new Error(`${title} did not reset independently`);
}
const ratio = spins.find(row => row.title === 'Focus column width');
if (!ratio || ratio.value !== Math.round(settings.get_double('master-ratio') * 100))
    throw new Error('Focus ratio is not presented as a percentage');
const originalRatio = settings.get_double('master-ratio');
ratio.value = 65;
if (Math.abs(settings.get_double('master-ratio') - 0.65) > 0.001)
    throw new Error('Focus ratio percentage was not saved as a fraction');
settings.set_double('master-ratio', 0.55);
if (ratio.value !== 55) throw new Error('Focus ratio did not follow an external settings change');
const ratioReset = resetButtons.find(button => button.tooltip_text === 'Reset Focus column width to default');
if (!ratioReset.visible) throw new Error('Focus ratio reset did not appear');
ratioReset.emit('clicked');
if (Math.abs(settings.get_double('master-ratio') - settings.get_default_value('master-ratio').get_double()) > 0.001 || ratioReset.visible)
    throw new Error('Focus ratio did not reset to its default');
settings.set_double('master-ratio', originalRatio);
const toggle = entries.find(row => row.title === 'Toggle tiling');
const search = entries.find(row => row.title === 'Search applications');
const appRow = apps.find(row => row.subtitle === appId);
if (!appRow) throw new Error(`Installed application ${appId} is missing from selector`);
const configuredGroup = groups.find(group => group.title.startsWith('Configured applications ·'));
const availableGroup = groups.find(group => group.title.startsWith('Other applications ·'));
const belongsTo = (widget, group) => {
    for (let parent = widget.get_parent(); parent; parent = parent.get_parent()) if (parent === group) return true;
    return false;
};
if (!configuredGroup || !availableGroup || !belongsTo(appRow, configuredGroup))
    throw new Error('Configured applications are not visually separated');
if (!/· \d+$/.test(configuredGroup.title) || !/· \d+$/.test(availableGroup.title))
    throw new Error('Application section counts are missing');
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
if (!belongsTo(appRow, availableGroup)) throw new Error('Cleared application did not move to Other applications');
scaled.active = true;
if (settings.get_strv('scaled-apps').join(',') !== `custom-test.window,${appId}`)
    throw new Error('Enabling scale-to-fit did not save the canonical app ID');
if (!belongsTo(appRow, configuredGroup)) throw new Error('Configured application did not return to its section');
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
if (!shortcutLabels.some(label => label.accelerator === '<Super>t'))
    throw new Error('Shortcut display did not follow an edited accelerator');
toggle.text = ''; toggle.emit('apply');
if (settings.get_strv('toggle').length !== 0) throw new Error('Shortcut could not be disabled');
recordButtons[0].emit('clicked');
if (recordButtons[0].icon_name !== 'media-playback-stop-symbolic')
    throw new Error('Shortcut recorder did not enter capture mode');
const controllers = recordButtons[0].observe_controllers();
const recorder = Array.from({length: controllers.get_n_items()}, (_, i) => controllers.get_item(i))
    .find(controller => controller instanceof Gtk.EventControllerKey);
if (!recorder) throw new Error('Shortcut recorder has no keyboard controller');
recorder.emit('key-pressed', Gdk.KEY_t, 0, Gdk.ModifierType.CONTROL_MASK);
if (settings.get_strv('toggle')[0] !== '<Control>t')
    throw new Error('Recorded shortcut was not saved');
recordButtons[0].emit('clicked');
recorder.emit('key-pressed', Gdk.KEY_Escape, 0, 0);
if (settings.get_strv('toggle')[0] !== '<Control>t')
    throw new Error('Cancelling shortcut capture changed the saved shortcut');
recordButtons[0].emit('clicked');
recorder.emit('key-pressed', Gdk.KEY_BackSpace, 0, 0);
if (settings.get_strv('toggle').length !== 0)
    throw new Error('Shortcut capture could not disable a binding');
window.destroy();
print('SNAPTESS_PREFS_TESTS_PASSED');
