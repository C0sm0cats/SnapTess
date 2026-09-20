import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function appAliases(id) {
    const aliases = [id];
    if (id.endsWith('.desktop')) aliases.push(id.slice(0, -8));
    if (id === 'onlyoffice-desktopeditors.desktop') aliases.push('ONLYOFFICE');
    return aliases;
}

function setAppRule(settings, key, ids, enabled) {
    const matching = new Set(ids);
    const values = settings.get_strv(key).filter(id => !matching.has(id));
    if (enabled) values.push(ids[0]);
    settings.set_strv(key, values);
}

export default class SnapTessPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(660, 720);
        const page = new Adw.PreferencesPage({title: 'SnapTess', icon_name: 'view-grid-symbolic'});
        window.add(page);
        const appearance = new Adw.PreferencesGroup({title: 'Make room', description: 'Fine-tune the space around your windows.'});
        page.add(appearance);
        for (const [key, title] of [['gap', 'Window spacing'], ['padding', 'Screen edge spacing']]) {
            const row = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1, page_increment: 4})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); appearance.add(row);
        }
        const ratio = new Adw.SpinRow({title: 'Focus column width', subtitle: 'Fraction of the available width', digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0.25, upper: 0.75, step_increment: 0.05})});
        settings.bind('master-ratio', ratio, 'value', Gio.SettingsBindFlags.DEFAULT); appearance.add(ratio);
        const behavior = new Adw.PreferencesGroup({title: 'Keep your flow'}); page.add(behavior);
        for (const [key, title] of [['active-border', 'Highlight the focused window'], ['animations', 'Animate placement guides'],
            ['compact-minimize', 'Close gaps when minimizing'], ['compact-close', 'Close gaps when closing']]) {
            const row = new Adw.SwitchRow({title}); settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT); behavior.add(row);
        }
        const applications = new Adw.PreferencesPage({title: 'Applications', icon_name: 'application-x-executable-symbolic'});
        window.add(applications);
        const appGroup = new Adw.PreferencesGroup({title: 'Application rules',
            description: 'Search an application, then choose how SnapTess handles its windows.'});
        applications.add(appGroup);
        const search = new Adw.EntryRow({title: 'Search applications'});
        appGroup.add(search);
        const configuredGroup = new Adw.PreferencesGroup({title: 'Configured applications',
            description: 'Applications with at least one SnapTess rule enabled.'});
        const availableGroup = new Adw.PreferencesGroup({title: 'Other applications'});
        applications.add(configuredGroup);
        applications.add(availableGroup);
        const selected = new Set([...settings.get_strv('excluded-apps'), ...settings.get_strv('scaled-apps')]);
        const appInfos = Gio.AppInfo.get_all().filter(info => {
            const id = info.get_id();
            return id && (info.should_show() || appAliases(id).some(alias => selected.has(alias)));
        });
        appInfos.sort((a, b) => {
            const chosen = info => appAliases(info.get_id()).some(alias => selected.has(alias));
            return Number(chosen(b)) - Number(chosen(a)) || a.get_display_name().localeCompare(b.get_display_name());
        });
        const listed = new Set();
        const searchable = [];
        const refreshGroups = () => {
            configuredGroup.visible = searchable.some(item => item.configured && item.row.visible);
            availableGroup.visible = searchable.some(item => !item.configured && item.row.visible);
        };
        const addApp = (id, name, icon = null, custom = false) => {
            const ids = custom ? [id] : appAliases(id);
            ids.forEach(alias => listed.add(alias));
            const row = new Adw.ExpanderRow({title: name, subtitle: custom ? `${id} · Saved app ID` : id});
            if (icon) row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));
            let item;
            for (const [key, title, subtitle] of [
                ['excluded-apps', 'Always floating', 'Keep its windows outside the tiled grid'],
                ['scaled-apps', 'Allow scale-to-fit', 'Fit constrained windows; XWayland clicks may be offset'],
            ]) {
                const toggle = new Adw.SwitchRow({title, subtitle});
                toggle.active = ids.some(alias => settings.get_strv(key).includes(alias));
                toggle.connect('notify::active', () => {
                    setAppRule(settings, key, ids, toggle.active);
                    const configured = ids.some(alias =>
                        settings.get_strv('excluded-apps').includes(alias) ||
                        settings.get_strv('scaled-apps').includes(alias));
                    if (configured !== item.configured) {
                        (item.configured ? configuredGroup : availableGroup).remove(row);
                        (configured ? configuredGroup : availableGroup).add(row);
                        item.configured = configured;
                    }
                    refreshGroups();
                });
                row.add_row(toggle);
            }
            item = {row, text: `${name} ${id}`.toLocaleLowerCase(),
                configured: ids.some(alias => selected.has(alias))};
            (item.configured ? configuredGroup : availableGroup).add(row);
            searchable.push(item);
        };
        for (const info of appInfos) addApp(info.get_id(), info.get_display_name(), info.get_icon());
        for (const id of selected) if (!listed.has(id)) addApp(id, id, null, true);
        const noResults = new Adw.ActionRow({title: 'No matching applications', visible: searchable.length === 0});
        appGroup.add(noResults);
        refreshGroups();
        search.connect('notify::text', () => {
            const query = search.text.trim().toLocaleLowerCase();
            let matches = 0;
            for (const item of searchable) {
                item.row.visible = !query || item.text.includes(query);
                if (item.row.visible) matches++;
            }
            noResults.visible = matches === 0;
            refreshGroups();
        });
        const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard shortcuts', description: 'GTK accelerator notation, e.g. <Control><Alt>t. Leave blank to disable.'});
        page.add(shortcuts);
        for (const [key, title] of [['toggle', 'Toggle tiling'], ['retile', 'Arrange again'], ['studio', 'Open Layout Studio'],
            ['floating', 'Float focused window'], ['swap', 'Swap mode'], ['undo', 'Undo'],
            ['space-1', 'Monitor space 1'], ['space-2', 'Monitor space 2'], ['space-3', 'Monitor space 3'], ['stop', 'Stop and restore']]) {
            const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] ?? '', show_apply_button: true});
            row.connect('apply', () => {
                const value = row.text.trim();
                const [valid, keyval, mods] = Gtk.accelerator_parse(value);
                if (value && (!valid || !Gtk.accelerator_valid(keyval, mods) || !(mods &
                    (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)))) {
                    row.add_css_class('error'); window.add_toast(new Adw.Toast({title: 'Use a valid shortcut with Ctrl, Alt or Super.'})); return;
                }
                row.remove_css_class('error'); settings.set_strv(key, value ? [value] : []);
            });
            shortcuts.add(row);
        }
        const info = new Adw.PreferencesGroup({title: 'Three spaces, per display',
            description: 'SnapTess parks inactive-space windows by minimizing them. Stopping restores your windows. GNOME workspaces remain separate. Configure other tilers to avoid competing shortcuts and placements.'});
        page.add(info);
    }
}
