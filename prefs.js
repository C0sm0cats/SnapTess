import {paddingOptions} from './lib/appearance.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {layout, autoLayout, capacity, PRESETS} from './lib/layout.js';
import {makeArchive, mergeArchive} from './lib/archive.js';

function appAliases(id, startupWmClass = null) {
    const aliases = [id];
    if (id.endsWith('.desktop')) aliases.push(id.slice(0, -8));
    if (startupWmClass && !aliases.includes(startupWmClass)) aliases.push(startupWmClass);
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
            const update = () => { button.sensitive = !settings.get_value(key).equal(settings.get_default_value(key)); };
            const changed = settings.connect(`changed::${key}`, update);
            window.connect('destroy', () => settings.disconnect(changed));
            row.add_prefix(button);
            update();
        };
        const watch = (key, callback) => {
            const id = settings.connect(`changed::${key}`, callback);
            window.connect('destroy', () => settings.disconnect(id));
            callback();
        };
        const addSwitch = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            addReset(row, key); group.add(row); return row;
        };
        const addSpin = (group, key, title, lower, upper, subtitle = '') => {
            const row = new Adw.SpinRow({title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 4})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            addReset(row, key); group.add(row); return row;
        };
        const addChoice = (group, key, title, choices) => {
            const row = new Adw.ComboRow({title,
                model: Gtk.StringList.new(choices.map(([, label]) => label))});
            watch(key, () => { row.selected = Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key))); });
            row.connect('notify::selected', () => {
                if (choices[row.selected]) settings.set_string(key, choices[row.selected][0]);
            });
            addReset(row, key); group.add(row); return row;
        };
        let commonPaddingRow;
        for (const [key, title] of [['gap', 'Window spacing'], ['padding', 'Screen edge spacing']]) {
            const row = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1, page_increment: 4})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); addReset(row, key); appearance.add(row);
            if (key === 'padding') commonPaddingRow = row;
        }
        addSwitch(appearance, 'independent-padding', 'Separate screen edges',
            'Set a different margin on each side');
        const edgeRows = ['top', 'right', 'bottom', 'left'].map(edge =>
            addSpin(appearance, `padding-${edge}`, `${edge[0].toUpperCase()}${edge.slice(1)} edge spacing`, 0, 64));
        watch('independent-padding', () => {
            const enabled = settings.get_boolean('independent-padding');
            if (enabled) for (const edge of ['top', 'right', 'bottom', 'left']) {
                if (settings.get_user_value(`padding-${edge}`) === null)
                    settings.set_int(`padding-${edge}`, settings.get_int('padding'));
            }
            edgeRows.forEach(row => { row.visible = enabled; });
            // The common margin is retained when switching back.
            commonPaddingRow.sensitive = !enabled;
        });
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
                padding: paddingOptions(settings, factor),
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
            else if ((['gap', 'padding', 'independent-padding', 'master-ratio'].includes(key) || key.startsWith('padding-'))) preview.queue_draw();
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
        const focusGroup = new Adw.PreferencesGroup({title: 'Focus outline',
            description: 'Customize the outline around the focused tiled window.'});
        page.add(focusGroup);
        addSwitch(focusGroup, 'border-custom-color', 'Custom focus color', 'Off: follow the GNOME accent color');
        const colorRow = new Adw.ActionRow({title: 'Focus color'});
        const picker = new Gtk.ColorDialogButton({valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog({with_alpha: false})});
        let syncingColor = false;
        watch('border-color', () => {
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string('border-color'))) rgba.parse('#3584e4');
            syncingColor = true; picker.rgba = rgba; syncingColor = false;
        });
        picker.connect('notify::rgba', () => {
            if (syncingColor) return;
            const rgba = picker.rgba;
            const hex = [rgba.red, rgba.green, rgba.blue].map(value =>
                Math.round(value * 255).toString(16).padStart(2, '0')).join('');
            settings.set_string('border-color', `#${hex}`);
        });
        colorRow.add_suffix(picker); addReset(colorRow, 'border-color'); focusGroup.add(colorRow);
        watch('border-custom-color', () => { colorRow.sensitive = settings.get_boolean('border-custom-color'); });
        addSpin(focusGroup, 'border-width', 'Outline thickness', 1, 6, 'Pixels');
        addChoice(focusGroup, 'border-style', 'Outline style', [['outline', 'Outline'], ['halo', 'Subtle halo']]);
        watch('active-border', () => { focusGroup.sensitive = settings.get_boolean('active-border'); });
        const animationGroup = new Adw.PreferencesGroup({title: 'Animations',
            description: 'Adjust guides, focus effects and space transitions. Window placement stays immediate.'});
        page.add(animationGroup);
        addChoice(animationGroup, 'animation-speed', 'Animation speed',
            [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow'], ['custom', 'Custom']]);
        const durationRow = addSpin(animationGroup, 'animation-duration', 'Animation duration', 40, 500,
            'Base duration in milliseconds; longer transitions scale proportionally');
        watch('animation-speed', () => { durationRow.visible = settings.get_string('animation-speed') === 'custom'; });
        addChoice(animationGroup, 'animation-curve', 'Animation curve',
            [['ease-out', 'Ease out'], ['linear', 'Linear'], ['ease-in-out', 'Ease in and out']]);
        watch('animations', () => { animationGroup.sensitive = settings.get_boolean('animations'); });
        const archiveGroup = new Adw.PreferencesGroup({title: 'Back up and share',
            description: 'Export named layouts and per-space profiles to a JSON file. Import adds new items without replacing your existing ones.'});
        page.add(archiveGroup);
        const archiveAction = (title, subtitle, buttonLabel, callback) => {
            const row = new Adw.ActionRow({title, subtitle});
            const action = new Gtk.Button({label: buttonLabel, valign: Gtk.Align.CENTER});
            action.connect('clicked', callback);
            row.add_suffix(action);
            row.activatable_widget = action;
            archiveGroup.add(row);
        };
        const fileError = error => {
            if (!error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED) &&
                !error.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED))
                window.add_toast(new Adw.Toast({title: error.message || String(error)}));
        };
        archiveAction('Export layouts and profiles', 'Save a portable SnapTess JSON file', 'Export…', () => {
            const chooser = new Gtk.FileDialog({title: 'Export SnapTess layouts',
                initial_name: 'snaptess-layouts.json'});
            chooser.save(window, null, (_chooser, result) => {
                try {
                    const file = chooser.save_finish(result);
                    const layouts = JSON.parse(settings.get_string('saved-layouts'));
                    const profiles = JSON.parse(settings.get_string('profiles'));
                    const bytes = new TextEncoder().encode(makeArchive(layouts, profiles));
                    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
                    window.add_toast(new Adw.Toast({title: `Exported ${layouts.length} layouts and ${Object.keys(profiles).length} profiles` }));
                } catch (error) { fileError(error); }
            });
        });
        archiveAction('Import layouts and profiles', 'Add layouts; keep existing profiles when their space already exists', 'Import…', () => {
            const chooser = new Gtk.FileDialog({title: 'Import SnapTess layouts'});
            const filter = new Gtk.FileFilter();
            filter.set_name('JSON files'); filter.add_pattern('*.json');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter); chooser.set_filters(filters);
            chooser.open(window, null, (_chooser, result) => {
                try {
                    const file = chooser.open_finish(result);
                    const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
                    if (size > 1024 * 1024) throw new Error('The file is too large (maximum 1 MB).');
                    const [, bytes] = file.load_contents(null);
                    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
                    const currentLayouts = JSON.parse(settings.get_string('saved-layouts'));
                    const currentProfiles = JSON.parse(settings.get_string('profiles'));
                    const merged = mergeArchive(text, currentLayouts, currentProfiles, () => GLib.uuid_string_random());
                    if (merged.addedLayouts) settings.set_string('saved-layouts', JSON.stringify(merged.layouts));
                    if (merged.addedProfiles) settings.set_string('profiles', JSON.stringify(merged.profiles));
                    window.add_toast(new Adw.Toast({title:
                        `Imported ${merged.addedLayouts} layouts and ${merged.addedProfiles} profiles`}));
                } catch (error) { fileError(error); }
            });
        });
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
            return id && (info.should_show() ||
                appAliases(id, info.get_startup_wm_class?.()).some(alias => selected.has(alias)));
        });
        appInfos.sort((a, b) => {
            const chosen = info => appAliases(info.get_id(), info.get_startup_wm_class?.())
                .some(alias => selected.has(alias));
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
        const addApp = (id, name, icon = null, custom = false, startupWmClass = null) => {
            const ids = custom ? [id] : appAliases(id, startupWmClass);
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
        for (const info of appInfos) addApp(info.get_id(), info.get_display_name(), info.get_icon(),
            false, info.get_startup_wm_class?.());
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
            description: 'Record a combination or use the pencil to edit it. Clear it to disable.'});
        page.add(shortcuts);
        for (const [key, title] of [['toggle', 'Toggle tiling'], ['retile', 'Arrange again'], ['studio', 'Open Layout Studio'],
            ['layout-switcher', 'Change layout'],
            ['floating', 'Float focused window'], ['swap', 'Swap mode'], ['undo', 'Undo'],
            ['focus-left', 'Focus window to the left'], ['focus-right', 'Focus window to the right'],
            ['focus-up', 'Focus window above'], ['focus-down', 'Focus window below'],
            ['space-1', 'Monitor space 1'], ['space-2', 'Monitor space 2'], ['space-3', 'Monitor space 3'], ['stop', 'Stop and restore']]) {
            const row = new Adw.ActionRow({title});
            const shortcutLabel = new Gtk.ShortcutLabel({accelerator: settings.get_strv(key)[0] ?? '', disabled_text: 'Off'});
            row.add_suffix(shortcutLabel);
            const entry = new Gtk.Entry({text: shortcutLabel.accelerator, width_chars: 28,
                placeholder_text: 'Clear to disable', hexpand: true});
            const applyButton = new Gtk.Button({icon_name: 'object-select-symbolic', tooltip_text: 'Apply shortcut'});
            const editor = new Gtk.Box({spacing: 6, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
            editor.append(entry); editor.append(applyButton);
            const popover = new Gtk.Popover({child: editor});
            const editButton = new Gtk.MenuButton({icon_name: 'document-edit-symbolic',
                valign: Gtk.Align.CENTER, tooltip_text: `Edit ${title.toLowerCase()}`, popover});
            row.add_suffix(editButton);
            const recordButton = new Gtk.Button({icon_name: 'media-record-symbolic',
                valign: Gtk.Align.CENTER, tooltip_text: `Record ${title.toLowerCase()}`});
            row.add_suffix(recordButton);
            const applyShortcut = value => {
                value = value.trim();
                const [valid, keyval, mods] = Gtk.accelerator_parse(value);
                if (value && (!valid || !Gtk.accelerator_valid(keyval, mods) || !(mods &
                    (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)))) {
                    entry.add_css_class('error'); window.add_toast(new Adw.Toast({title: 'Use a valid shortcut with Ctrl, Alt or Super.'})); return false;
                }
                entry.remove_css_class('error'); settings.set_strv(key, value ? [value] : []);
                shortcutLabel.accelerator = value;
                entry.text = value;
                return true;
            };
            const applyEdit = () => { if (applyShortcut(entry.text)) popover.popdown(); };
            entry.connect('activate', applyEdit);
            applyButton.connect('clicked', applyEdit);
            const changed = settings.connect(`changed::${key}`, () => {
                shortcutLabel.accelerator = settings.get_strv(key)[0] ?? '';
            });
            window.connect('destroy', () => settings.disconnect(changed));
            let recording = false;
            const finishRecording = () => {
                recording = false;
                recordButton.icon_name = 'media-record-symbolic';
            };
            popover.connect('notify::visible', () => {
                if (!popover.visible) return;
                finishRecording();
                entry.text = settings.get_strv(key)[0] ?? '';
                entry.remove_css_class('error');
                entry.grab_focus();
            });
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
                    applyShortcut(''); finishRecording(); return true;
                }
                const mods = state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK |
                    Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.SHIFT_MASK);
                if (!Gtk.accelerator_valid(keyval, mods) || !(mods &
                    (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)))
                    return true;
                applyShortcut(Gtk.accelerator_name(keyval, mods));
                finishRecording(); return true;
            });
            recordButton.add_controller(controller);
            shortcuts.add(row);
        }
        const info = new Adw.PreferencesGroup({title: 'Three spaces, per display',
            description: 'SnapTess parks inactive-space windows by minimizing them. Stopping restores your windows. GNOME workspaces remain separate. Configure other tilers to avoid competing shortcuts and placements.'});
        page.add(info);
    }
}
