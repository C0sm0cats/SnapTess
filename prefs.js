import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
        const excluded = new Adw.EntryRow({title: 'Floating app IDs (comma separated)', text: settings.get_strv('excluded-apps').join(', '), show_apply_button: true});
        excluded.connect('apply', () => settings.set_strv('excluded-apps', excluded.text.split(',').map(s => s.trim()).filter(Boolean)));
        behavior.add(excluded);
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
