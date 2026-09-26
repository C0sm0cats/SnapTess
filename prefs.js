import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {layout, autoLayout, capacity, PRESETS} from './lib/layout.js';

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
        const addReset = (row, key) => {
            const button = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: `Reset ${row.title} to default`});
            button.add_css_class('flat');
            button.connect('clicked', () => settings.reset(key));
            const update = () => { button.visible = !settings.get_value(key).equal(settings.get_default_value(key)); };
            const changed = settings.connect(`changed::${key}`, update);
            window.connect('destroy', () => settings.disconnect(changed));
            row.add_suffix(button);
            update();
        };
        for (const [key, title] of [['gap', 'Window spacing'], ['padding', 'Screen edge spacing']]) {
            const row = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1, page_increment: 4})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); addReset(row, key); appearance.add(row);
        }
        const ratio = new Adw.SpinRow({title: 'Focus column width', subtitle: 'Percentage of the available width', digits: 0,
            adjustment: new Gtk.Adjustment({lower: 25, upper: 75, step_increment: 5, page_increment: 5}),
            value: Math.round(settings.get_double('master-ratio') * 100)});
        ratio.connect('notify::value', () => settings.set_double('master-ratio', ratio.value / 100));
        const ratioChanged = settings.connect('changed::master-ratio', () => {
            const value = Math.round(settings.get_double('master-ratio') * 100);
            if (Math.abs(ratio.value - value) > 0.01) ratio.value = value;
        });
        window.connect('destroy', () => settings.disconnect(ratioChanged));
        addReset(ratio, 'master-ratio');
        appearance.add(ratio);
        const previewRow = new Adw.ActionRow({title: 'Current space preview'});
        const preview = new Gtk.DrawingArea({valign: Gtk.Align.CENTER});
        preview.set_content_width(220);
        preview.set_content_height(116);
        preview.set_tooltip_text('Live layout of the active workspace, display and SnapTess space');
        const currentPreview = () => {
            try { return JSON.parse(settings.get_string('preview-state')); } catch { return {}; }
        };
        const updatePreview = () => {
            const state = currentPreview();
            if (state.running) {
                const preset = state.preset === 'auto' || capacity(state.preset) < state.count
                    ? autoLayout(state.count) : state.preset;
                const name = state.count ? PRESETS.find(([id]) => id === preset)?.[1] ?? preset : 'No tiled windows';
                previewRow.subtitle = `Workspace ${state.workspace + 1} · Display ${state.monitor + 1} · Space ${state.space + 1} · ${name}`;
            } else previewRow.subtitle = 'Start arranging windows to see the current layout';
            preview.queue_draw();
        };
        preview.set_draw_func((_area, cr, width, height) => {
            const dark = Adw.StyleManager.get_default().dark;
            cr.setSourceRGBA(...(dark ? [0.12, 0.16, 0.19, 1] : [0.90, 0.93, 0.95, 1]));
            cr.rectangle(0, 0, width, height); cr.fill();
            const state = currentPreview();
            if (!state.running || !state.count || !state.width || !state.height) return;
            const factor = Math.min(width / state.width, height / state.height);
            const scaledWidth = state.width * factor, scaledHeight = state.height * factor;
            const x = Math.round((width - scaledWidth) / 2), y = Math.round((height - scaledHeight) / 2);
            const rects = layout({x, y, width: scaledWidth, height: scaledHeight}, state.count, {
                preset: state.preset, gap: settings.get_int('gap') * factor,
                padding: settings.get_int('padding') * factor,
                ratio: settings.get_double('master-ratio')});
            rects.forEach((rect, index) => {
                const occupied = state.occupied?.includes(index);
                const focused = index === state.focused;
                cr.setSourceRGBA(...(dark
                    ? focused ? [0.29, 0.51, 0.75, 1] : occupied ? [0.37, 0.43, 0.48, 1] : [0.23, 0.27, 0.30, 1]
                    : focused ? [0.26, 0.48, 0.70, 1] : occupied ? [0.68, 0.75, 0.80, 1] : [0.79, 0.83, 0.86, 1]));
                cr.rectangle(rect.x, rect.y, rect.width, rect.height); cr.fill();
            });
        });
        previewRow.add_suffix(preview);
        appearance.add(previewRow);
        const previewChanged = settings.connect('changed', (_s, key) => {
            if (key === 'preview-state') updatePreview();
            else if (['gap', 'padding', 'master-ratio'].includes(key)) preview.queue_draw();
        });
        updatePreview();
        const styleManager = Adw.StyleManager.get_default();
        const themeChanged = styleManager.connect('notify::dark', () => preview.queue_draw());
        window.connect('destroy', () => {
            settings.disconnect(previewChanged);
            styleManager.disconnect(themeChanged);
        });
        const behavior = new Adw.PreferencesGroup({title: 'Keep your flow'}); page.add(behavior);
        for (const [key, title] of [['active-border', 'Highlight the focused window'], ['animations', 'Animate placement guides'],
            ['compact-minimize', 'Close gaps when minimizing'], ['compact-close', 'Close gaps when closing']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            addReset(row, key);
            behavior.add(row);
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
            const configuredCount = searchable.filter(item => item.configured).length;
            configuredGroup.title = `Configured applications · ${configuredCount}`;
            availableGroup.title = `Other applications · ${searchable.length - configuredCount}`;
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
        const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard shortcuts',
            description: 'Record a combination, edit the text, or clear it to disable.'});
        page.add(shortcuts);
        for (const [key, title] of [['toggle', 'Toggle tiling'], ['retile', 'Arrange again'], ['studio', 'Open Layout Studio'],
            ['floating', 'Float focused window'], ['swap', 'Swap mode'], ['undo', 'Undo'],
            ['space-1', 'Monitor space 1'], ['space-2', 'Monitor space 2'], ['space-3', 'Monitor space 3'], ['stop', 'Stop and restore']]) {
            const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] ?? '', show_apply_button: true});
            const shortcutLabel = new Gtk.ShortcutLabel({accelerator: row.text, disabled_text: 'Off'});
            row.add_suffix(shortcutLabel);
            const recordButton = new Gtk.Button({icon_name: 'media-record-symbolic',
                valign: Gtk.Align.CENTER, tooltip_text: `Record ${title.toLowerCase()}`});
            row.add_suffix(recordButton);
            row.connect('apply', () => {
                const value = row.text.trim();
                const [valid, keyval, mods] = Gtk.accelerator_parse(value);
                if (value && (!valid || !Gtk.accelerator_valid(keyval, mods) || !(mods &
                    (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)))) {
                    row.add_css_class('error'); window.add_toast(new Adw.Toast({title: 'Use a valid shortcut with Ctrl, Alt or Super.'})); return;
                }
                row.remove_css_class('error'); settings.set_strv(key, value ? [value] : []);
                shortcutLabel.accelerator = value;
            });
            let recording = false;
            const finishRecording = () => {
                recording = false;
                recordButton.icon_name = 'media-record-symbolic';
            };
            recordButton.connect('clicked', () => {
                recording = true;
                recordButton.icon_name = 'media-playback-stop-symbolic';
                recordButton.grab_focus();
                window.add_toast(new Adw.Toast({title: 'Press a shortcut · Esc cancels · Backspace disables'}));
            });
            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
                if (!recording) return false;
                if (keyval === Gdk.KEY_Escape) { finishRecording(); return true; }
                if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
                    row.text = ''; row.emit('apply'); finishRecording(); return true;
                }
                const mods = state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK |
                    Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.SHIFT_MASK);
                if (!Gtk.accelerator_valid(keyval, mods) || !(mods &
                    (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)))
                    return true;
                row.text = Gtk.accelerator_name(keyval, mods);
                row.emit('apply'); finishRecording(); return true;
            });
            recordButton.add_controller(controller);
            shortcuts.add(row);
        }
        const info = new Adw.PreferencesGroup({title: 'Three spaces, per display',
            description: 'SnapTess parks inactive-space windows by minimizing them. Stopping restores your windows. GNOME workspaces remain separate. Configure other tilers to avoid competing shortcuts and placements.'});
        page.add(info);
    }
}
