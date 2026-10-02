import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {layout, PRESETS, capacity, activePinnedSlots, reserveAppSlots, sortedSavedLayouts, autoLayout, validCustomTiles, splitCustomTile, mergeCustomTiles, moveCustomEdge, setCustomTileValue} from './layout.js';

function button(label, action, style = 'snaptess-chip') {
    const actor = new St.Button({label, style_class: style, can_focus: true, reactive: true});
    actor.connect('clicked', action);
    return actor;
}

function contextButton(label, action, dirty) {
    const actor = button('', action);
    const content = new St.BoxLayout({style_class: 'snaptess-context-label'});
    content.add_child(new St.Label({text: label}));
    if (dirty) content.add_child(new St.Widget({style_class: 'snaptess-dirty-dot'}));
    actor.set_child(content);
    return actor;
}

export class Studio {
    constructor(extension) {
        this.extension = extension;
        this.monitor = extension.currentMonitor();
        this.space = extension.activeSpace(this.monitor);
        this.preset = extension.options(this.monitor).preset;
        this.selected = -1;
        this.drafts = new Map();
        this.draftPresets = new Map();
        this.draftPins = new Map();
        this.draftTiles = new Map();
        this.dirtyContexts = new Set();
        this.undoStack = [];
        this.showLibrary = false;
        this.showPreviews = false;
        this.showSavedChooser = false;
        this.previewSavedId = null;
        this.creatingNew = false;
        this.newLayout = null;
        this.newUndoStack = [];
        this.dialog = new ModalDialog.ModalDialog({styleClass: 'snaptess-studio'});
        const screen = Main.layoutManager.monitors[this.monitor];
        this.width = Math.min(1040, Math.floor(screen.width * 0.9));
        this.dialog.contentLayout.set_width(this.width);
        const header = new St.BoxLayout({style_class: 'snaptess-header'});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        titles.add_child(new St.Label({text: 'SNAPTESS', style_class: 'snaptess-eyebrow'}));
        titles.add_child(new St.Label({text: 'A place for every window.', style_class: 'snaptess-title'}));
        header.add_child(titles);
        this.undoButton = button('Undo', () => this.undo());
        this.undoButton.hide();
        header.add_child(this.undoButton);
        this.previewButton = button('Window previews', () => { this.showPreviews = !this.showPreviews; this.render(); });
        header.add_child(this.previewButton);
        this.libraryButton = button('Add windows…', () => {
            this.previewSavedId = null; this.showSavedChooser = false;
            this.showLibrary = !this.showLibrary; this.render();
        });
        header.add_child(this.libraryButton);
        header.add_child(new St.Icon({gicon: extension.icon, icon_size: 36, style_class: 'snaptess-brand'}));
        this.dialog.contentLayout.add_child(header);
        this.context = new St.BoxLayout({style_class: 'snaptess-toolbar'});
        this.dialog.contentLayout.add_child(this.context);
        this.savedSection = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-saved-section'});
        this.dialog.contentLayout.add_child(this.savedSection);
        this.savedHeader = new St.BoxLayout({style_class: 'snaptess-saved-header'});
        this.savedHeader.add_child(new St.Label({text: 'LAYOUTS', style_class: 'snaptess-saved-title', width: 84}));
        this.currentViewButton = button('Current space', () => {
            this.creatingNew = false; this.previewSavedId = null;
            this.showSavedChooser = false; this.showLibrary = false; this.nameRow.hide(); this.render();
        });
        this.savedHeader.add_child(this.currentViewButton);
        this.newViewButton = button('New layout', () => this.openNewLayout());
        this.savedHeader.add_child(this.newViewButton);
        this.savedPicker = button('Saved layouts ▾', () => {
            this.creatingNew = false; this.showSavedChooser = !this.showSavedChooser;
            this.nameRow.hide(); this.render();
        });
        this.savedHeader.add_child(this.savedPicker);
        this.savedHeader.add_child(new St.Widget({x_expand: true}));
        this.savedSection.add_child(this.savedHeader);
        this.nameRow = new St.BoxLayout({style_class: 'snaptess-saved-name-row', visible: false});
        this.nameEntry = new St.Entry({hint_text: 'Layout name', can_focus: true, x_expand: true});
        this.nameEntry.clutter_text.connect('activate', () => this.saveNamedLayout());
        this.nameEntry.clutter_text.connect('text-changed', () => this.replaceRow.hide());
        this.nameRow.add_child(this.nameEntry);
        this.nameRow.add_child(button('Save', () => this.saveNamedLayout(), 'snaptess-chip selected'));
        this.nameRow.add_child(button('Cancel', () => {
            const saved = this.extension.savedLayouts.find(item => item.id === this.editingSavedId);
            this.nameEntry.set_text(saved?.name ?? '');
            this.nameRow.hide(); this.replaceRow.hide(); this.render();
        }));
        this.savedSection.add_child(this.nameRow);
        this.replaceRow = new St.BoxLayout({style_class: 'snaptess-saved-replace', visible: false});
        this.replaceLabel = new St.Label({style_class: 'snaptess-saved-replace-label', x_expand: true});
        this.replaceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.replaceRow.add_child(this.replaceLabel);
        this.cancelReplaceButton = button('Cancel', () => {
            this.replaceRow.hide(); this.nameRow.hide(); this.nameEntry.set_text(''); this.render();
        });
        this.cancelReplaceButton.accessible_name = 'Cancel saving this layout';
        this.replaceRow.add_child(this.cancelReplaceButton);
        this.replaceRow.add_child(button('Change name', () => {
            this.replaceRow.hide(); this.nameEntry.grab_key_focus();
        }));
        this.replaceButton = button('Replace layout', () => {
            if (!this.replaceRow.visible) return;
            const name = this.nameEntry.get_text().trim().slice(0, 60);
            const existing = this.extension.savedLayouts.find(item => item.name.toLowerCase() === name.toLowerCase());
            if (existing) this.saveNamedLayout(existing.id);
        }, 'snaptess-chip danger');
        this.replaceRow.add_child(this.replaceButton);
        this.savedSection.add_child(this.replaceRow);
        this.savedActions = new St.BoxLayout({style_class: 'snaptess-saved-actions', visible: false});
        this.savedSummary = new St.Label({style_class: 'snaptess-saved-summary', x_expand: true});
        this.savedSummary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.savedSummary.clutter_text.single_line_mode = true;
        this.savedActions.add_child(this.savedSummary);
        this.undoDeleteButton = button('Undo delete', () => {
            const restored = this.extension.undoDeletedSavedLayout();
            if (restored) { this.previewSavedId = restored.id; this.render(); }
        });
        this.savedActions.add_child(this.undoDeleteButton);
        this.renameButton = button('Rename layout', () => {
            const saved = this.extension.savedLayouts.find(item => item.id === this.previewSavedId);
            if (!saved) return;
            this.renamingSavedId = saved.id;
            this.renameEntry.set_text(saved.name);
            this.renameError.hide();
            this.renameRow.show();
            this.renameEntry.grab_key_focus();
        });
        this.savedActions.add_child(this.renameButton);
        this.editButton = button('Edit layout', () => this.editSavedLayout());
        this.savedActions.add_child(this.editButton);
        this.deleteButton = button('Delete layout', () => {
            if (!this.previewSavedId) return;
            this.extension.deleteSavedLayout(this.previewSavedId);
            this.previewSavedId = null; this.renamingSavedId = null; this.render();
        }, 'snaptess-chip danger');
        this.savedActions.add_child(this.deleteButton);
        this.savedSection.add_child(this.savedActions);
        this.renameRow = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-saved-rename', visible: false});
        const renameControls = new St.BoxLayout({style_class: 'snaptess-saved-rename-controls'});
        this.renameEntry = new St.Entry({hint_text: 'Layout name', can_focus: true, x_expand: true});
        this.renameEntry.clutter_text.connect('activate', () => this.renameSelectedLayout());
        this.renameEntry.clutter_text.connect('text-changed', () => this.renameError.hide());
        renameControls.add_child(this.renameEntry);
        this.renameSaveButton = button('Save name', () => this.renameSelectedLayout(), 'snaptess-chip selected');
        renameControls.add_child(this.renameSaveButton);
        this.renameCancelButton = button('Cancel', () => this.cancelRename());
        renameControls.add_child(this.renameCancelButton);
        this.renameRow.add_child(renameControls);
        this.renameError = new St.Label({style_class: 'snaptess-saved-rename-error', visible: false});
        this.renameRow.add_child(this.renameError);
        this.savedSection.add_child(this.renameRow);
        this.savedChooser = new St.ScrollView({style_class: 'snaptess-saved-chooser', visible: false,
            reactive: true, hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this.savedChooserList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-saved-chooser-list'});
        this.savedChooser.set_child(this.savedChooserList);
        this.dialog.contentLayout.add_child(this.savedChooser);
        this.layoutToolbar = new St.BoxLayout({style_class: 'snaptess-layout-toolbar'});
        this.modeControls = new St.BoxLayout({style_class: 'snaptess-mode-controls'});
        this.modeControls.add_child(new St.Label({text: 'MODE', width: 56, style_class: 'snaptess-saved-title',
            y_align: Clutter.ActorAlign.CENTER}));
        this.automaticButton = button('Adaptive layout', () => this.choosePreset('auto'));
        this.automaticButton.accessible_name = 'Adaptive layout: chooses the layout based on the number of windows';
        this.modeControls.add_child(this.automaticButton);
        this.layoutToolbar.add_child(this.modeControls);
        this.layoutToolbar.add_child(new St.Label({text: 'LAYOUT', width: 74, style_class: 'snaptess-saved-title',
            y_align: Clutter.ActorAlign.CENTER}));
        this.presets = new St.BoxLayout({style_class: 'snaptess-presets'});
        this.layoutToolbar.add_child(this.presets);
        this.dialog.contentLayout.add_child(this.layoutToolbar);
        this.presetStatus = new St.Label({style_class: 'snaptess-preset-status', visible: false});
        this.presetStatus.clutter_text.line_wrap = true;
        this.presetStatus.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.dialog.contentLayout.add_child(this.presetStatus);
        this.legend = new St.BoxLayout({style_class: 'snaptess-legend'});
        for (const [label, style] of [['Active', 'active'], ['Selected', 'selected'], ['Scaled', 'scaled'],
            ['Floating', 'floating'], ['Pinned', 'pinned'], ['Empty', 'empty']]) {
            const item = new St.BoxLayout({style_class: `snaptess-legend-item ${style}`});
            item.add_child(new St.Widget({style_class: 'snaptess-legend-dot'}));
            item.add_child(new St.Label({text: label}));
            this.legend.add_child(item);
        }
        this.dialog.contentLayout.add_child(this.legend);
        this.customControls = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-custom-controls', visible: false});
        this.dialog.contentLayout.add_child(this.customControls);
        this.canvas = new St.Widget({layout_manager: new Clutter.FixedLayout(), style_class: 'snaptess-canvas'});
        this.dialog.contentLayout.add_child(this.canvas);
        this.hint = new St.Label({style_class: 'snaptess-hint'});
        this.dialog.contentLayout.add_child(this.hint);
        this.pinButton = button('Pin this app to this tile', () => this.togglePin());
        this.pinButton.visible = false;
        this.dialog.contentLayout.add_child(this.pinButton);
        this.removeAppButton = button('Clear this tile', () => this.clearNewTile());
        this.removeAppButton.visible = false;
        this.dialog.contentLayout.add_child(this.removeAppButton);
        this.dialog.connect('destroy', () => { this.presetMenu?.destroy(); this.stopCustomDrag(); });
        this.render();
    }
    saveCurrentLayout() { this.saveNamedLayout(); }
    cancelRename() {
        this.renamingSavedId = null;
        this.renameRow.hide();
        this.renameError.hide();
    }
    renameSelectedLayout() {
        const id = this.renamingSavedId;
        if (!id || id !== this.previewSavedId) return;
        const name = this.renameEntry.get_text().trim().slice(0, 60);
        if (!name) {
            this.renameError.text = 'Enter a layout name.';
            this.renameError.show();
            return;
        }
        if (!this.extension.renameSavedLayout(id, name)) {
            this.renameError.text = 'A layout with this name already exists.';
            this.renameError.show();
            return;
        }
        this.cancelRename();
        this.render();
    }
    openNewLayout() {
        this.editingSavedId = null; this.mergeChoosing = false; this.mergePending = null;
        this.newLayout ??= {preset: '2x2', apps: Array(4).fill(null),
            pinned: Array(4).fill(null), selected: -1};
        this.creatingNew = true; this.previewSavedId = null;
        this.showSavedChooser = false; this.showLibrary = false; this.nameRow.hide(); this.render();
    }
    saveNamedLayout(replaceId = this.editingSavedId ?? null) {
        const name = this.nameEntry.get_text().trim().slice(0, 60);
        const existing = this.extension.savedLayouts.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (existing && existing.id !== replaceId) {
            this.replaceLabel.text = `“${existing.name}” already exists. Replace it?`;
            this.replaceRow.show();
            if (this.creatingNew && this.newLayout.preset === 'custom') this.render();
            return;
        }
        const id = this.creatingNew
            ? this.extension.saveNewLayout(name, this.newLayout.preset, this.newLayout.apps,
                this.newLayout.pinned, replaceId, this.newLayout.tiles)
            : this.extension.saveLayout(name, this.preset, this.draft, this.pins, replaceId, this.draftTiles.get(this.contextKey()));
        if (!id) {
            this.nameEntry.set_hint_text('Enter a layout name');
            return;
        }
        this.nameEntry.set_text(''); this.nameRow.hide(); this.replaceRow.hide();
        if (this.creatingNew) { this.creatingNew = false; this.newLayout = null; this.newUndoStack = []; this.editingSavedId = null; }
        this.previewSavedId = id; this.showSavedChooser = false; this.render();
    }
    renderSavedLayouts() {
        this.savedChooserList.destroy_all_children();
        const layouts = this.extension.savedLayouts;
        const saved = layouts.find(item => item.id === this.previewSavedId);
        if (!saved) this.previewSavedId = null;
        if (!saved || this.showSavedChooser || this.creatingNew || this.renamingSavedId !== saved.id)
            this.cancelRename();
        this.currentViewButton[saved || this.showSavedChooser || this.creatingNew
            ? 'remove_style_class_name' : 'add_style_class_name']('selected');
        this.newViewButton[this.creatingNew ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        this.savedPicker[saved || this.showSavedChooser
            ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        this.savedPicker.label = saved ? `Saved · ${saved.name.length > 20
            ? `${saved.name.slice(0, 19)}…` : saved.name} ▾` : `Saved layouts · ${layouts.length} ▾`;
        this.savedPicker.accessible_name = saved ? `Saved layout: ${saved.name}` : 'Choose a saved layout';
        this.savedPicker.reactive = layouts.length > 0;
        this.savedPicker.can_focus = layouts.length > 0;
        const groupedLayouts = sortedSavedLayouts(layouts).sort((a, b) =>
            Number(b.preset === 'custom') - Number(a.preset === 'custom'));
        let section = null;
        for (const item of groupedLayouts) {
            const title = item.preset === 'custom' ? 'Custom layouts' : 'Preset layouts';
            if (title !== section) {
                this.savedChooserList.add_child(new St.Label({text: title,
                    style_class: 'snaptess-saved-group-title'}));
                section = title;
            }
            const row = button('', () => {
                this.creatingNew = false; this.previewSavedId = item.id; this.showSavedChooser = false;
                this.showLibrary = false; this.nameRow.hide(); this.render();
            }, 'snaptess-saved-row');
            const content = new St.BoxLayout({style_class: 'snaptess-saved-row-content'});
            const name = new St.Label({text: item.name, style_class: 'snaptess-saved-row-name', x_expand: true});
            name.set_width(Math.max(100, this.width - 190));
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            name.clutter_text.single_line_mode = true;
            content.add_child(name);
            const preset = PRESETS.find(([id]) => id === item.preset)?.[1] ?? (item.preset === 'custom' ? 'Custom' : item.preset);
            const metadata = new St.BoxLayout({style_class: 'snaptess-saved-row-metadata'});
            metadata.add_child(new St.Label({text: `${item.slotCount} TILES`,
                style_class: 'snaptess-saved-row-count'}));
            if (!['custom', 'auto'].includes(item.preset)) metadata.add_child(new St.Label({text: preset,
                style_class: 'snaptess-saved-row-meta'}));
            content.add_child(metadata);
            row.set_child(content);
            row.accessible_name = `Preview ${item.name}`;
            if (item.id === saved?.id) row.add_style_class_name('selected');
            this.savedChooserList.add_child(row);
        }
        const lastDeleted = this.extension.deletedLayouts.at(-1)?.layout;
        this.undoDeleteButton.visible = Boolean(lastDeleted);
        if (lastDeleted) {
            this.undoDeleteButton.label = `Undo delete · ${lastDeleted.name.length > 18
                ? `${lastDeleted.name.slice(0, 17)}…` : lastDeleted.name}`;
            this.undoDeleteButton.accessible_name = `Undo delete ${lastDeleted.name}`;
        }
        this.editButton.visible = Boolean(saved) && !this.showSavedChooser;
        this.renameButton.visible = Boolean(saved) && !this.showSavedChooser;
        this.deleteButton.visible = Boolean(saved) && !this.showSavedChooser;
        this.savedActions.visible = Boolean(saved || lastDeleted) && !this.showSavedChooser;
        if (saved && !this.showSavedChooser) {
            const plan = this.extension.savedLayoutPlan(saved, this.monitor, this.space);
            this.savedSummary.text = `PREVIEW · ${plan.slots.filter(Boolean).length} reuse · ${plan.missing.length} open · ${plan.extras.length} minimize`;
        } else if (lastDeleted) this.savedSummary.text = `Deleted “${lastDeleted.name}”`;
        return saved;
    }
    renderSavedPreview(saved, height) {
        const rects = layout({x: 0, y: 0, width: this.width, height}, saved.slotCount,
            {preset: saved.preset, tiles: saved.tiles, gap: 8, padding: 10, ratio: this.extension.settings.get_double('master-ratio')});
        rects.forEach((rect, index) => {
            const id = (saved.apps ?? saved.pinned)[index];
            const card = new St.Button({style_class: `snaptess-slot snaptess-saved-slot${id ? '' : ' empty'}`,
                reactive: false, can_focus: false});
            card.set_position(rect.x, rect.y); card.set_size(rect.width, rect.height);
            const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'snaptess-slot-content', x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Label({text: String(index + 1).padStart(2, '0'), style_class: 'snaptess-slot-number'}));
            const app = id ? Shell.AppSystem.get_default().lookup_app(id) : null;
            if (id) content.add_child(app?.create_icon_texture(32) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 32}));
            const label = new St.Label({text: id ? app?.get_name() ?? id.replace(/\.desktop$/i, '') : 'Empty',
                style_class: id ? 'snaptess-app-name' : 'snaptess-empty'});
            label.set_width(Math.max(30, rect.width - 28));
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.single_line_mode = true;
            content.add_child(label);
            if (saved.pinned[index]) {
                const badges = new St.BoxLayout({style_class: 'snaptess-state-badges',
                    x_align: Clutter.ActorAlign.CENTER});
                badges.add_child(new St.Label({text: 'PINNED',
                    style_class: 'snaptess-pinned-badge'}));
                content.add_child(badges);
            }
            card.set_child(content);
            this.canvas.add_child(card);
        });
        this.hint.text = 'Saved layout preview only. Restore reuses matching windows, opens missing apps and minimizes extras. Unsaved Studio edits are not included.';
    }
    draftFor(monitor, space) {
        const key = `${monitor}:${space}`;
        if (!this.drafts.has(key)) {
            const windows = this.extension.windows(monitor, space, true)
                .filter(w => !w.minimized || this.extension.records.get(w).parked);
            const previous = this.extension.groups.get(this.extension.key(monitor, space));
            const existing = previous ?? [];
            const ordered = existing.filter(w => windows.includes(w));
            ordered.push(...windows.filter(w => !ordered.includes(w)));
            const profile = this.extension.profiles[this.extension.profileKey(monitor, space)];
            if (!this.draftTiles.has(key) && profile?.tiles) this.draftTiles.set(key, profile.tiles.map(t => ({...t})));
            const pinned = this.draftPins.get(key) ?? (Array.isArray(profile?.pinned) ? [...profile.pinned] : []);
            this.draftPins.set(key, pinned);
            const activePins = activePinnedSlots(previous, windows, pinned, w => this.extension.appId(w));
            this.drafts.set(key, reserveAppSlots(ordered, activePins, w => this.extension.appId(w)));
        }
        return this.drafts.get(key);
    }
    get draft() { return this.draftFor(this.monitor, this.space); }
    get pins() { this.draftFor(this.monitor, this.space); return this.draftPins.get(this.contextKey()); }
    changeContext(monitor, space) {
        this.draftPresets.set(this.contextKey(), this.preset);
        this.monitor = monitor; this.space = space; this.selected = -1;
        this.preset = this.draftPresets.get(this.contextKey()) ?? this.extension.options(monitor, space).preset;
        this.animateCanvas = true;
        this.render();
    }
    contextKey() { return `${this.monitor}:${this.space}`; }
    markDirty() { this.dirtyContexts.add(this.contextKey()); }
    saveUndo() {
        this.undoStack.push({monitor: this.monitor, space: this.space, preset: this.preset,
            selected: this.selected, drafts: new Map([...this.drafts].map(([key, draft]) => [key, [...draft]])),
            draftPresets: new Map(this.draftPresets),
            draftTiles: new Map([...this.draftTiles].map(([key, tiles]) => [key, tiles.map(t => ({...t}))])),
            draftPins: new Map([...this.draftPins].map(([key, pins]) => [key, [...pins]])),
            dirtyContexts: new Set(this.dirtyContexts)});
        if (this.undoStack.length > 20) this.undoStack.shift();
    }
    undo() {
        if (this.creatingNew) {
            const draft = this.newUndoStack.pop();
            if (!draft) return;
            this.newLayout = draft; this.mergeChoosing = false; this.mergePending = null; this.showLibrary = false; this.render();
            return;
        }
        const state = this.undoStack.pop();
        if (!state) return;
        Object.assign(this, state);
        this.showLibrary = false;
        this.showSavedChooser = false;
        this.animateCanvas = true;
        this.render();
    }
    choosePreset(id) {
        if (this.creatingNew) {
            if (id === 'custom') {
                if (this.newLayout.preset === 'custom') { this.presetMenu?.close(); return; }
                this.saveNewUndo();
                const draft = this.newLayout;
                // Start blank layouts with one full tile; preserve assigned apps
                // when converting a populated preset to custom geometry.
                const sourcePreset = draft.preset === 'auto' ? autoLayout(draft.apps.length) : draft.preset;
                const count = draft.apps.some(Boolean) ? capacity(sourcePreset) : 1;
                draft.tiles = layout({x: 0, y: 0, width: 10000, height: 10000}, count,
                    {preset: count === 1 ? 'full' : sourcePreset, gap: 0, padding: 0,
                        ratio: this.extension.settings.get_double('master-ratio')})
                    .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v / 10000])));
                draft.preset = 'custom'; draft.apps.length = count; draft.pinned.length = count;
                for (let i = 0; i < count; i++) { draft.apps[i] ??= null; draft.pinned[i] ??= null; }
                draft.selected = 0; this.showLibrary = false; this.mergeChoosing = false;
                this.presetMenu?.close(); this.render(); return;
            }
            const draft = this.newLayout, count = capacity(id);
            if (id === 'auto' || !count) return;
            if (this.presetUnavailable(id)) { this.showPresetUnavailable(id); return; }
            if (id === draft.preset) { this.presetMenu?.close(); return; }
            this.saveNewUndo();
            draft.preset = id; delete draft.tiles; this.mergeChoosing = false; this.mergePending = null; draft.apps.length = count; draft.pinned.length = count;
            for (let i = 0; i < count; i++) {
                draft.apps[i] ??= null; draft.pinned[i] ??= null;
            }
            draft.selected = -1; this.showLibrary = false; this.animateCanvas = true;
            this.presetMenu?.close(); this.render();
            return;
        }
        if (this.presetUnavailable(id)) { this.showPresetUnavailable(id); return; }
        if (id === this.preset) { this.presetMenu?.close(); return; }
        this.saveUndo();
        this.preset = id; this.draftPresets.set(this.contextKey(), id);
        this.selected = -1; this.markDirty(); this.animateCanvas = true;
        this.presetMenu?.close(); this.render();
    }
    requiredPresetSlots() {
        if (!this.creatingNew) return this.draft.length;
        return this.newLayout.apps.reduce((last, app, index) => app ? index + 1 : last, 0);
    }
    presetUnavailable(id) {
        return id !== 'auto' && id !== 'custom' && capacity(id) < this.requiredPresetSlots();
    }
    showPresetUnavailable(id) {
        const name = PRESETS.find(([preset]) => preset === id)?.[1] ?? id;
        const required = this.requiredPresetSlots();
        const count = capacity(id);
        this.presetStatus.text = `${name} has ${count} ${count === 1 ? 'tile' : 'tiles'}; this draft needs ${required}.`;
        this.presetStatus.visible = true;
        this.presetStatus.add_style_class_name('warning');
        this.presetMenu?.close();
    }
    togglePin() {
        if (this.creatingNew) {
            const draft = this.newLayout, index = draft.selected, id = draft.apps[index];
            if (!id) return;
            this.saveNewUndo();
            draft.pinned[index] = draft.pinned[index] === id ? null : id;
            this.render();
            return;
        }
        const w = this.draft[this.selected];
        if (!w) return;
        this.saveUndo();
        const id = this.extension.appId(w), active = this.pins[this.selected] === id;
        for (let i = 0; i < this.pins.length; i++) if (this.pins[i] === id) this.pins[i] = null;
        if (!active) this.pins[this.selected] = id;
        this.markDirty(); this.render();
    }
    updatePinButton() {
        if (this.creatingNew) {
            const {apps, pinned, selected} = this.newLayout;
            const id = apps[selected];
            this.pinButton.visible = Boolean(id);
            this.pinButton.label = pinned[selected] === id ? 'Unpin this app' : 'Pin this app to this tile';
            this.pinButton[pinned[selected] === id ? 'add_style_class_name' : 'remove_style_class_name']('selected');
            this.removeAppButton.visible = Boolean(id);
            return;
        }
        this.removeAppButton.hide();
        const selectedWindow = this.draft[this.selected];
        this.pinButton.visible = Boolean(selectedWindow);
        this.pinButton.remove_style_class_name('selected');
        if (!selectedWindow) return;
        const pinned = this.pins[this.selected] === this.extension.appId(selectedWindow);
        this.pinButton.label = pinned ? 'Unpin this app from this tile' : 'Pin this app to this tile';
        if (pinned) this.pinButton.add_style_class_name('selected');
    }
    saveNewUndo() {
        const draft = this.newLayout;
        this.newUndoStack.push({preset: draft.preset, apps: [...draft.apps],
            pinned: [...draft.pinned], selected: draft.selected,
            ...(draft.tiles ? {tiles: draft.tiles.map(t => ({...t}))} : {})});
        if (this.newUndoStack.length > 20) this.newUndoStack.shift();
    }
    clearNewTile() {
        if (!this.creatingNew || this.newLayout.selected < 0) return;
        const index = this.newLayout.selected;
        if (!this.newLayout.apps[index]) return;
        this.saveNewUndo();
        this.newLayout.apps[index] = null; this.newLayout.pinned[index] = null;
        this.render();
    }
    render() {
        this.stopCustomDrag(); this.rendering = true;
        try { this.renderContent(); } finally { this.rendering = false; }
    }
    renderContent() {
        if (!this.nameRow.visible) this.replaceRow.hide();
        this.context.destroy_all_children(); this.presets.destroy_all_children(); this.canvas.destroy_all_children();
        this.customControls.visible = false;
        const windows = this.creatingNew ? [] : this.draft;
        Main.layoutManager.monitors.forEach((_m, i) => {
            const b = contextButton(`Display ${i + 1}`, () => this.changeContext(i, this.extension.activeSpace(i)),
                [...this.dirtyContexts].some(key => key.startsWith(`${i}:`)));
            if (this.monitor === i) b.add_style_class_name('selected');
            this.context.add_child(b);
        });
        this.context.add_child(new St.Widget({x_expand: true}));
        for (let i = 0; i < 3; i++) {
            const b = contextButton(`Space ${i + 1}`, () => this.changeContext(this.monitor, i),
                this.dirtyContexts.has(`${this.monitor}:${i}`));
            if (this.space === i) b.add_style_class_name('selected');
            this.context.add_child(b);
        }
        this.context.visible = !this.creatingNew;
        this.undoButton.visible = (this.creatingNew ? this.newUndoStack.length : this.undoStack.length) > 0 &&
            !this.showSavedChooser;
        const saved = this.renderSavedLayouts();
        this.dialog.setButtons(this.showSavedChooser ? [
            {label: 'Close', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Back to layout', action: () => { this.showSavedChooser = false; this.render(); }},
        ] : saved ? [
            {label: 'Close', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Back to current space', action: () => { this.previewSavedId = null; this.render(); }},
            {label: 'Restore in this space', default: true, action: () => {
                this.dialog.close(); this.extension.restoreSavedLayout(saved.id, this.monitor, this.space);
            }},
        ] : this.creatingNew ? [
            {label: 'Back to current space', key: Clutter.KEY_Escape, action: () => {
                this.creatingNew = false; this.showLibrary = false; this.nameRow.hide(); this.render();
            }},
            {label: this.editingSavedId ? 'Save changes…' : 'Save layout…', default: true, action: () => {
                if (this.nameRow.visible) this.saveNamedLayout();
                else { this.nameRow.show(); this.render(); this.nameEntry.grab_key_focus(); }
            }},
        ] : [
            {label: 'Cancel', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Reset space layout', action: () => this.reset()},
            {label: 'Save layout…', action: () => {
                this.nameRow.visible = !this.nameRow.visible;
                this.render();
                if (this.nameRow.visible) this.nameEntry.grab_key_focus();
            }},
            {label: 'Apply arrangement', default: true, action: () => this.apply()},
        ]);
        if (!saved && !this.showSavedChooser && !this.creatingNew) {
            const save = this.dialog.buttonLayout.get_children().find(actor => actor.label === 'Save layout…');
            const content = new St.BoxLayout({style_class: 'snaptess-save-action', x_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Icon({icon_name: 'document-save-symbolic', icon_size: 16}));
            content.add_child(new St.Label({text: 'Save layout…'}));
            save.set_child(content);
            save.accessible_name = 'Save current draft as a named layout';
        }
        this.presets.visible = !saved && !this.showSavedChooser;
        this.layoutToolbar.visible = this.presets.visible;
        this.modeControls.visible = !this.creatingNew || this.newLayout.preset === 'auto';
        this.automaticButton.reactive = !this.creatingNew;
        this.automaticButton.can_focus = this.automaticButton.reactive;
        this.automaticButton[(this.creatingNew ? this.newLayout.preset : this.preset) === 'auto'
            ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        const required = this.requiredPresetSlots();
        const smallest = PRESETS.find(([id]) => id !== 'auto' && capacity(id) >= required);
        this.presetStatus.visible = this.presets.visible &&
            (!this.creatingNew || this.newLayout.preset !== 'custom');
        const selectedLayout = this.creatingNew ? this.newLayout.preset : this.preset;
        const behavior = selectedLayout === 'auto'
            ? 'Chooses the layout based on the number of windows.'
            : 'Keeps this layout. Temporarily switches to a larger layout when needed, then returns when the windows fit again.';
        this.presetStatus.set_width(this.width);
        this.presetStatus.text = behavior + (required > 1 ?
            ` · ${required} tiles needed · ${smallest ? `${smallest[1]} or larger` : 'use Adaptive layout for this space'}` : '');
        this.presetStatus.remove_style_class_name('warning');
        this.legend.visible = !saved && !this.showSavedChooser && !this.creatingNew;
        this.previewButton.visible = !this.showSavedChooser && !this.creatingNew;
        this.libraryButton.visible = !this.showSavedChooser &&
            (!this.creatingNew || this.newLayout.selected >= 0);
        this.previewButton.label = this.showPreviews ? 'Hide previews' : 'Window previews';
        this.previewButton[this.showPreviews ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        if (this.width < 820) {
            const selectedPreset = this.creatingNew ? this.newLayout.preset : this.preset;
            const currentName = PRESETS.find(([id]) => id === selectedPreset)?.[1] ?? 'Custom';
            this.presetButton = button(selectedPreset === 'auto' ? 'Choose fixed layout…' : currentName,
                () => this.presetMenu.toggle());
            this.presets.add_child(this.presetButton);
            this.presetMenu?.destroy();
            this.presetMenu = new PopupMenu.PopupMenu(this.presetButton, 0.5, St.Side.TOP);
            Main.uiGroup.add_child(this.presetMenu.actor);
            for (const [id, name] of (this.creatingNew ? [...PRESETS, ['custom', 'Custom']] : PRESETS)) {
                if (id === 'auto') continue;
                const item = this.presetMenu.addAction(name, () => this.choosePreset(id));
                if (this.presetUnavailable(id)) item.add_style_class_name('unavailable');
            }
        } else {
            this.presetMenu?.destroy(); this.presetMenu = null;
            for (const [id, name] of (this.creatingNew ? [...PRESETS, ['custom', 'Custom']] : PRESETS)) {
                if (id === 'auto') continue;
                const b = button(name, () => this.choosePreset(id));
                if (this.presetUnavailable(id)) {
                    b.add_style_class_name('unavailable');
                    b.accessible_name = `${name}: ${capacity(id)} tiles; this draft needs ${required}`;
                }
                if (id === (this.creatingNew ? this.newLayout.preset : this.preset))
                    b.add_style_class_name('selected');
                this.presets.add_child(b);
            }
        }
        const area = this.extension.area(this.monitor);
        const height = Math.min(480, Math.round(this.width * area.height / area.width),
            Math.max(120, Main.layoutManager.primaryMonitor.height - 500 -
                (this.width < 820 && this.presetStatus.visible ? 18 : 0) -
                (this.creatingNew && this.newLayout.preset === 'custom' ?
                    (this.nameRow.visible ? 50 : 0) + (this.replaceRow.visible ? 50 : 0) : 0)));
        this.canvas.set_size(this.width, height);
        this.canvas.visible = !this.showSavedChooser;
        this.hint.visible = !this.showSavedChooser;
        this.savedChooser.set_size(this.width, Math.min(340,
            Math.max(180, Main.layoutManager.primaryMonitor.height - 380)));
        this.savedChooser.visible = this.showSavedChooser;
        if (this.animateCanvas && this.extension.settings.get_boolean('animations')) {
            this.canvas.opacity = 80;
            this.canvas.ease({opacity: 255, duration: this.extension.visualDuration(170), mode: this.extension.visualMode()});
        }
        this.animateCanvas = false;
        if (this.showSavedChooser) { this.pinButton.hide(); this.removeAppButton.hide(); return; }
        this.libraryButton.label = this.showLibrary ? 'Back to layout' :
            this.creatingNew ? 'Choose app…' : 'Add windows…';
        this.libraryButton.reactive = !this.creatingNew || this.newLayout.selected >= 0;
        this.libraryButton.can_focus = this.libraryButton.reactive;
        if (this.showLibrary) {
            this.pinButton.hide(); this.removeAppButton.hide();
            if (this.creatingNew) this.renderNewAppLibrary(height);
            else this.renderLibrary(height);
            return;
        }
        if (saved) { this.pinButton.hide(); this.removeAppButton.hide(); this.renderSavedPreview(saved, height); return; }
        if (this.creatingNew) { this.renderNewLayout(height); return; }
        const count = Math.max(windows.length, capacity(this.preset, this.draftTiles.get(this.contextKey())), 1);
        const rects = layout({x: 0, y: 0, width: this.width, height}, count,
            {preset: this.preset, tiles: this.draftTiles.get(this.contextKey()), gap: 8, padding: 10, ratio: this.extension.settings.get_double('master-ratio')});
        rects.forEach((rect, index) => {
            const w = windows[index];
            const dense = rect.height < 56;
            const card = button('', () => this.select(index), 'snaptess-slot');
            card.set_position(rect.x, rect.y); card.set_size(rect.width, rect.height);
            if (this.selected === index) card.add_style_class_name('selected');
            const content = new St.BoxLayout({orientation: dense ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
                style_class: 'snaptess-slot-content', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            if (dense) content.add_style_class_name('dense');
            else if (rect.height < 130) content.add_style_class_name('compact');
            const numberLabel = new St.Label({text: String(index + 1).padStart(2, '0'), style_class: 'snaptess-slot-number'});
            content.add_child(numberLabel);
            if (w) {
                const app = this.extension.windowApp(w);
                const compact = rect.width < 170 || rect.height < 170;
                const minimal = rect.width < 120 || rect.height < 88;
                const actor = this.extension.windowActor(w);
                const previewHeading = this.showPreviews && actor && minimal && !dense;
                card.accessible_name = `Tile ${index + 1}: ${app?.get_name() ?? w.get_title() ?? 'Application'}`;
                if (this.showPreviews && actor && rect.width >= 90 && rect.height >= 32) {
                    const clone = new Clutter.Clone({source: actor, reactive: false});
                    const maxWidth = Math.min(rect.width - 30, dense ? 36 : compact ? 110 : 170);
                    const maxHeight = dense ? Math.min(24, rect.height - 20) :
                        Math.max(1, Math.min(rect.height - (previewHeading ? 50 : 78), compact ? 45 : 70));
                    const scale = Math.min(maxWidth / Math.max(1, actor.width),
                        maxHeight / Math.max(1, actor.height));
                    clone.set_size(Math.max(1, actor.width * scale), Math.max(1, actor.height * scale));
                    content.add_child(clone);
                } else if (dense) content.add_child(app?.create_icon_texture(16) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 16}));
                else if (!minimal) content.add_child(app?.create_icon_texture(compact ? 26 : 36) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: compact ? 26 : 36}));
                const appLabel = new St.Label({text: app?.get_name() ?? 'Application', style_class: 'snaptess-app-name'});
                appLabel.set_width(Math.max(30, rect.width - (dense ? this.showPreviews ? 94 : 74 : previewHeading ? 54 : 28)));
                appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                appLabel.clutter_text.single_line_mode = true;
                if (previewHeading) {
                    content.remove_child(numberLabel);
                    const heading = new St.BoxLayout({style_class: 'snaptess-preview-heading'});
                    heading.add_child(numberLabel); heading.add_child(appLabel);
                    content.insert_child_at_index(heading, 0);
                } else content.add_child(appLabel);
                const label = new St.Label({text: w.get_title() ?? 'Window', style_class: 'snaptess-window-title'});
                label.set_width(Math.max(30, rect.width - 36));
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.clutter_text.single_line_mode = true;
                if (!compact && !dense) content.add_child(label);
                const badges = new St.BoxLayout({style_class: 'snaptess-state-badges'});
                if (w === global.display.focus_window)
                    badges.add_child(new St.Label({text: 'ACTIVE', style_class: 'snaptess-active-badge'}));
                const record = this.extension.records.get(w);
                if (record?.visualScale < 0.999) {
                    badges.add_child(new St.Label({text: `${Math.round(record.visualScale * 100)}%`,
                        style_class: 'snaptess-scale-badge'}));
                }
                if (this.pins[index] === this.extension.appId(w)) {
                    if (!minimal) badges.add_child(new St.Label({text: 'PINNED', style_class: 'snaptess-pinned-badge'}));
                }
                if (badges.get_n_children() && !dense) content.add_child(badges); else badges.destroy();
                card._delegate = {index, studio: this, getDragActor: () => {
                    const ghost = new St.BoxLayout({style_class: 'snaptess-drag-ghost'});
                    ghost.add_child(app?.create_icon_texture(24) ?? new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 24}));
                    ghost.add_child(new St.Label({text: app?.get_name() ?? w.get_title() ?? 'Window'}));
                    return ghost;
                }, getDragActorSource: () => card,
                    handleDragOver: source => {
                        if (source.studio !== this) return DND.DragMotionResult.NO_DROP;
                        this.clearDropPreviews(card);
                        if (source.index === index) return DND.DragMotionResult.NO_DROP;
                        card.add_style_class_name('drop-target');
                        if (!card._dropPreview) {
                            card._dropHidden = content.get_children();
                            for (const child of card._dropHidden) child.hide();
                            const sourceWindow = this.draft[source.index];
                            const sourceApp = this.extension.windowApp(sourceWindow);
                            card._dropPreview = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                style_class: 'snaptess-drop-preview', x_align: Clutter.ActorAlign.CENTER});
                            card._dropPreview.add_child(sourceApp?.create_icon_texture(28) ??
                                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 28}));
                            const previewName = new St.Label({text: sourceApp?.get_name() ?? 'Window',
                                style_class: 'snaptess-drop-name'});
                            previewName.set_width(Math.max(50, rect.width - 42));
                            previewName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                            previewName.clutter_text.single_line_mode = true;
                            card._dropPreview.add_child(previewName);
                            card._dropPreview.add_child(new St.Label({text: 'DROP HERE', style_class: 'snaptess-drop-caption'}));
                            content.add_child(card._dropPreview);
                        }
                        return DND.DragMotionResult.MOVE_DROP;
                    },
                    handleDragOut: () => this.clearDropPreview(card),
                    acceptDrop: source => { this.clearDropPreviews(); return this.drop(source, index); }};
                const draggable = DND.makeDraggable(card);
                draggable.connect('drag-begin', () => {
                    this.selected = index; this.updatePinButton(); card.add_style_class_name('dragging');
                    for (const child of content.get_children()) child.opacity = 20;
                    card._sourcePlaceholder = new St.Label({text: 'SOURCE', style_class: 'snaptess-source-placeholder'});
                    content.add_child(card._sourcePlaceholder);
                });
                draggable.connect('drag-end', () => {
                    this.clearDropPreviews();
                    card.remove_style_class_name('dragging');
                    card._sourcePlaceholder?.destroy(); card._sourcePlaceholder = null;
                    for (const child of content.get_children()) child.opacity = 255;
                });
            } else {
                card.add_style_class_name('empty');
                const id = this.pins[index];
                if (id) {
                    content.add_style_class_name('reserved');
                    const appSystem = Shell.AppSystem.get_default();
                    const app = appSystem.lookup_app(id) ?? appSystem.lookup_app(`${id}.desktop`);
                    const name = app?.get_name() ?? id.replace(/\.desktop$/i, '');
                    const size = rect.height < 100 || rect.width < 130 ? 20 : 30;
                    const icon = app?.create_icon_texture(size) ??
                        new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: size});
                    icon.add_style_class_name('snaptess-reserved-icon');
                    icon.set_size(dense ? 16 : size, dense ? 16 : size);
                    if (!dense || rect.height >= 30) content.add_child(new St.Bin({child: icon,
                        x_align: Clutter.ActorAlign.CENTER, height: dense ? 16 : size}));
                    else icon.destroy();
                    const appLabel = new St.Label({text: name, style_class: 'snaptess-reserved-name'});
                    appLabel.set_width(Math.max(30, rect.width - (dense ? 74 : 28)));
                    appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    appLabel.clutter_text.single_line_mode = true;
                    content.add_child(appLabel);
                    const state = this.extension.pinnedSlotState(id, this.monitor, this.space, index).state;
                    const status = state === 'CLOSED' && !app?.get_app_info?.() ? 'UNAVAILABLE' : state;
                    const badge = new St.Label({text: `PINNED · ${status}`,
                        style_class: 'snaptess-reserved-status'});
                    badge.set_width(Math.max(30, rect.width - 28));
                    badge.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    badge.clutter_text.single_line_mode = true;
                    if (!dense) content.add_child(badge);
                    card.accessible_name = `Tile ${index + 1}: ${name}, pinned, ${status.toLowerCase()}`;
                } else {
                    const emptyLabel = new St.Label({text: dense ? 'Empty' : 'Open a window here',
                        style_class: 'snaptess-empty'});
                    emptyLabel.set_width(Math.max(30, rect.width - (dense ? 54 : 24)));
                    emptyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    emptyLabel.clutter_text.single_line_mode = true;
                    content.add_child(emptyLabel);
                    card.accessible_name = `Tile ${index + 1}: empty`;
                }
                card._delegate = {handleDragOver: () => DND.DragMotionResult.NO_DROP, acceptDrop: () => false};
            }
            card.set_child(content);
            this.canvas.add_child(card);
            if (this.animateSlots?.has(index) && this.extension.settings.get_boolean('animations')) {
                card.set_pivot_point(0.5, 0.5); card.set_scale(0.94, 0.94); card.opacity = 120;
                card.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: this.extension.visualDuration(150),
                    mode: this.extension.visualMode()});
            }
        });
        this.animateSlots = null;
        this.updatePinButton();
        const windowCount = windows.filter(Boolean).length;
        this.hint.text = windowCount ? `${windowCount} windows · ${count} tiles · Drag to swap or select a tile to pin. Apply to confirm.` :
            'This space is empty. Apply to switch here, then open an application.';
        if (windows.length > 1) {
            const incompatible = this.preset !== 'auto' && capacity(this.preset) < windows.length;
            if (incompatible) this.hint.text +=
                ` ${PRESETS.find(([id]) => id === this.preset)?.[1] ?? this.preset} cannot fit ${windows.length} tiles; Auto is shown.`;
        }
    }
    renderNewLayout(height) {
        const draft = this.newLayout, count = draft.preset === 'auto' ? draft.apps.length : capacity(draft.preset, draft.tiles);
        this.customCards = []; this.customHandles = []; this.customHeight = height;
        const rects = layout({x: 0, y: 0, width: this.width, height}, count,
            {preset: draft.preset, tiles: draft.tiles, gap: 8, padding: 10,
                ratio: this.extension.settings.get_double('master-ratio')});
        rects.forEach((rect, index) => {
            const id = draft.apps[index], app = id && Shell.AppSystem.get_default().lookup_app(id);
            const tiny = rect.width < 75 || rect.height < 35;
            const dense = rect.height < 56;
            const card = button('', () => {
                if (draft.preset === 'custom' && this.mergeChoosing) { this.requestCustomMerge(index); return; }
                draft.selected = index; this.showLibrary = draft.preset !== 'custom' && !id; this.render();
            }, `snaptess-slot snaptess-new-slot${id ? '' : ' empty'}`);
            card.set_position(rect.x, rect.y); card.set_size(rect.width, rect.height);
            if (draft.selected === index) card.add_style_class_name('selected');
            const content = new St.BoxLayout({orientation: dense ? Clutter.Orientation.HORIZONTAL :
                Clutter.Orientation.VERTICAL, style_class: 'snaptess-slot-content',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            if (dense) content.add_style_class_name('dense');
            else if (rect.height < 130) content.add_style_class_name('compact');
            content.add_child(new St.Label({text: String(index + 1).padStart(2, '0'),
                style_class: 'snaptess-slot-number'}));
            if (id && !tiny) {
                const size = dense ? 16 : rect.width < 170 || rect.height < 130 ? 24 : 32;
                content.add_child(app?.create_icon_texture(size) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: size}));
            }
            const name = id ? app?.get_name() ?? id.replace(/\.desktop$/i, '') :
                dense ? 'Empty' : 'Choose an app';
            const mergeTarget = draft.preset === 'custom' && this.mergeChoosing &&
                Boolean(mergeCustomTiles(draft.tiles, draft.selected, index));
            const label = new St.Label({text: mergeTarget ? 'Click to merge' : name,
                style_class: id ? 'snaptess-app-name' : 'snaptess-empty'});
            label.set_width(Math.max(30, rect.width - (dense ? 74 : 28)));
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.single_line_mode = true;
            if (!tiny) content.add_child(label);
            if (draft.pinned[index] === id && id && !dense && !tiny) {
                const badges = new St.BoxLayout({style_class: 'snaptess-state-badges'});
                badges.add_child(new St.Label({text: 'PINNED', style_class: 'snaptess-pinned-badge'}));
                content.add_child(badges);
            }
            card.accessible_name = `Tile ${index + 1}: ${name}${draft.pinned[index] ? ', pinned' : ''}${mergeTarget ? ', click to merge with the selected tile' : ''}`;
            card.set_child(content); this.canvas.add_child(card); this.customCards.push(card);
        });
        if (draft.preset === 'custom') { this.renderCustomControls(); this.addCustomHandles(); }
        this.updatePinButton();
        this.hint.text = `${this.editingSavedId ? `EDIT · ${this.extension.savedLayouts.find(l => l.id === this.editingSavedId)?.name ?? 'Layout'}` : 'NEW LAYOUT'} · ${draft.apps.filter(Boolean).length} apps · ${count} tiles · ` +
            (draft.preset === 'custom' ? this.mergePending ? 'Choose which app to keep in the merged tile.' :
                this.mergeChoosing ? `Click an amber tile to merge it with tile ${draft.selected + 1}.` :
                'Merge: 1. Select a tile → 2. Merge tiles → 3. Click its neighbor. Drag green dividers to resize.' :
                'Choose a tile to assign an installed app. Saving does not change your desktop.');
    }
    editSavedLayout() {
        const saved = this.extension.savedLayouts.find(item => item.id === this.previewSavedId);
        if (!saved) return;
        this.newLayout = {preset: saved.preset, apps: Array.from({length: saved.slotCount}, (_, i) =>
            (saved.apps ?? saved.pinned)[i] ?? null),
            pinned: Array.from({length: saved.slotCount}, (_, i) => saved.pinned[i] ?? null), selected: 0,
            ...(saved.tiles ? {tiles: saved.tiles.map(t => ({...t}))} : {})};
        this.editingSavedId = saved.id; this.newUndoStack = [];
        this.mergeChoosing = false; this.mergePending = null;
        this.creatingNew = true; this.previewSavedId = null;
        this.showSavedChooser = false; this.showLibrary = false;
        this.nameEntry.set_text(saved.name); this.nameRow.hide(); this.render();
    }
    splitCustom(axis) {
        const draft = this.newLayout, index = draft.selected;
        const tiles = splitCustomTile(draft.tiles, index, axis);
        if (!tiles) return;
        this.saveNewUndo(); draft.tiles = tiles;
        draft.apps.splice(index + 1, 0, null); draft.pinned.splice(index + 1, 0, null);
        this.mergeChoosing = false; this.mergePending = null; this.render();
    }
    requestCustomMerge(second) {
        const draft = this.newLayout, first = draft.selected;
        const result = mergeCustomTiles(draft.tiles, first, second);
        if (!result) return;
        if (draft.apps[first] && draft.apps[second] && draft.apps[first] !== draft.apps[second]) {
            this.mergePending = {first, second}; this.render(); return;
        }
        this.finishCustomMerge(first, second, draft.apps[first] ? first : second);
    }
    finishCustomMerge(first, second, keep) {
        const draft = this.newLayout, result = mergeCustomTiles(draft.tiles, first, second);
        if (!result) return;
        this.saveNewUndo();
        const app = draft.apps[keep], pin = draft.pinned[keep];
        draft.tiles = result.tiles;
        draft.apps[result.index] = app; draft.pinned[result.index] = pin;
        draft.apps.splice(result.removed, 1); draft.pinned.splice(result.removed, 1);
        draft.selected = result.index;
        this.mergeChoosing = false; this.mergePending = null; this.render();
    }
    renderCustomControls() {
        this.customControls.destroy_all_children(); this.customControls.show();
        const draft = this.newLayout, index = draft.selected, tile = draft.tiles[index];
        const actions = new St.BoxLayout({style_class: 'snaptess-custom-actions'});
        actions.add_child(new St.Label({text: tile ? `Tile ${index + 1}` : 'Select a tile',
            style_class: 'snaptess-custom-title'}));
        for (const [axis, label] of [['vertical', 'Split vertically'], ['horizontal', 'Split horizontally']]) {
            const split = button(label, () => this.splitCustom(axis));
            split.reactive = Boolean(tile && splitCustomTile(draft.tiles, index, axis));
            split.can_focus = split.reactive;
            actions.add_child(split);
        }
        const neighbors = tile ? draft.tiles.map((_, i) => i).filter(i => mergeCustomTiles(draft.tiles, index, i)) : [];
        const merge = button(this.mergeChoosing ? 'Cancel merge' : 'Merge tiles', () => {
            this.mergeChoosing = !this.mergeChoosing; this.mergePending = null; this.render();
        });
        merge.reactive = neighbors.length > 0; merge.can_focus = merge.reactive;
        if (this.mergeChoosing) merge.add_style_class_name('selected');
        actions.add_child(merge); this.customControls.add_child(actions);
        if (this.mergePending) {
            const choice = new St.BoxLayout({style_class: 'snaptess-custom-actions'});
            choice.add_child(new St.Label({text: 'Merged tile: keep which app?', style_class: 'snaptess-custom-title'}));
            for (const keep of [this.mergePending.first, this.mergePending.second]) {
                const name = Shell.AppSystem.get_default().lookup_app(draft.apps[keep])?.get_name() ??
                    draft.apps[keep].replace(/\.desktop$/i, '');
                const keepButton = button(`Keep ${name.length > 24 ? `${name.slice(0, 23)}…` : name}`, () => {
                    const {first, second} = this.mergePending;
                    this.finishCustomMerge(first, second, keep);
                });
                keepButton.accessible_name = `Keep ${name} in the merged tile`;
                choice.add_child(keepButton);
            }
            this.customControls.add_child(choice); return;
        }
        if (this.mergeChoosing) {
            this.customControls.add_child(new St.Label({text: `Click an orange tile to merge it with tile ${index + 1}.`,
                style_class: 'snaptess-preset-status warning'}));
            for (const neighbor of neighbors) this.customCards[neighbor]?.add_style_class_name('merge-target');
            return;
        }
        if (!tile) return;
        const values = new St.BoxLayout({style_class: 'snaptess-custom-values'});
        this.customEntries = new Map();
        for (const [field, label] of [['x', 'X'], ['y', 'Y'], ['width', 'Width'], ['height', 'Height']]) {
            const group = new St.BoxLayout({style_class: 'snaptess-custom-value'});
            group.add_child(new St.Label({text: label, style_class: 'snaptess-custom-title'}));
            const fixed = field === 'x' ? tile.x === 0 : field === 'y' ? tile.y === 0 :
                field === 'width' ? tile.width === 1 : tile.height === 1;
            const entry = new St.Entry({text: String(Number((tile[field] * 100).toFixed(2))),
                can_focus: !fixed, reactive: !fixed, style_class: `snaptess-custom-entry${fixed ? ' fixed' : ''}`});
            entry.clutter_text.set_editable(!fixed);
            entry.accessible_name = `${label} in percent for tile ${index + 1}${fixed ? ', fixed outer edge' : ''}`;
            const commit = () => {
                if (this.rendering || this.newLayout !== draft || draft.selected !== index) return;
                const text = entry.get_text().trim().replace(',', '.');
                const value = text === '' ? NaN : Number(text) / 100;
                const tiles = setCustomTileValue(draft.tiles, index, field, value);
                if (!tiles) { entry.set_text(String(Number((draft.tiles[index][field] * 100).toFixed(2)))); return; }
                if (JSON.stringify(tiles) !== JSON.stringify(draft.tiles)) {
                    this.saveNewUndo(); draft.tiles = tiles;
                }
                this.refreshCustomPreview(); this.refreshCustomValues();
                this.undoButton.visible = this.newUndoStack.length > 0;
            };
            entry.clutter_text.connect('activate', commit);
            entry.connect('key-focus-out', commit);
            group.add_child(entry); group.add_child(new St.Label({text: '%', style_class: 'snaptess-custom-title'}));
            values.add_child(group); this.customEntries.set(field, entry);
        }
        this.customControls.add_child(values);
    }
    refreshCustomValues() {
        const tile = this.newLayout.tiles[this.newLayout.selected];
        if (tile) for (const [field, entry] of this.customEntries ?? [])
            entry.set_text(String(Number((tile[field] * 100).toFixed(2))));
    }
    customPreviewRects() {
        return layout({x: 0, y: 0, width: this.width, height: this.customHeight}, this.newLayout.tiles.length,
            {preset: 'custom', tiles: this.newLayout.tiles, gap: 8, padding: 10});
    }
    addCustomHandles() {
        if (this.mergeChoosing) return;
        for (const [index, tile] of this.newLayout.tiles.entries()) {
            for (const edge of ['E', 'S']) {
                if ((edge === 'E' ? tile.x + tile.width : tile.y + tile.height) >= 1 - 1e-7) continue;
                const handle = new St.Widget({reactive: true, can_focus: false,
                    style_class: 'snaptess-custom-divider'});
                handle.accessible_name = `Drag ${edge === 'E' ? 'right' : 'bottom'} divider of tile ${index + 1}`;
                handle.connect('button-press-event', (_actor, event) => {
                    if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                    this.startCustomDrag(index, edge, event.get_coords()); return Clutter.EVENT_STOP;
                });
                this.canvas.add_child(handle); this.customHandles.push({handle, index, edge});
            }
        }
        this.refreshCustomPreview();
    }
    refreshCustomPreview() {
        const rects = this.customPreviewRects();
        rects.forEach((r, i) => { this.customCards[i]?.set_position(r.x, r.y); this.customCards[i]?.set_size(r.width, r.height); });
        for (const {handle, index, edge} of this.customHandles) {
            const r = rects[index];
            if (edge === 'E') {
                handle.set_position(r.x + r.width + 1, r.y + Math.max(0, (r.height - 36) / 2));
                handle.set_size(6, Math.min(36, r.height));
            } else {
                handle.set_position(r.x + Math.max(0, (r.width - 36) / 2), r.y + r.height + 1);
                handle.set_size(Math.min(36, r.width), 6);
            }
        }
    }
    startCustomDrag(index, edge, pointer) {
        this.stopCustomDrag(); this.saveNewUndo();
        this.customDrag = {index, edge, pointer, tiles: this.newLayout.tiles.map(t => ({...t}))};
        // Modal grabs restrict event propagation to the dialog subtree.
        this.customDragSignal = this.dialog.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.MOTION) {
                const drag = this.customDrag, [x, y] = event.get_coords();
                const [width, height] = this.canvas.get_transformed_size();
                const delta = drag.edge === 'E' ? (x - drag.pointer[0]) / Math.max(1, width - 20) :
                    (y - drag.pointer[1]) / Math.max(1, height - 20);
                const tiles = moveCustomEdge(drag.tiles, drag.index, drag.edge, delta);
                if (tiles) this.newLayout.tiles = tiles;
                this.refreshCustomPreview(); this.refreshCustomValues();
                return Clutter.EVENT_STOP;
            }
            if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this.newLayout.tiles = this.customDrag.tiles; this.newUndoStack.pop();
                this.stopCustomDrag(); this.refreshCustomPreview(); this.refreshCustomValues();
                return Clutter.EVENT_STOP;
            }
            if (event.type() === Clutter.EventType.BUTTON_RELEASE) {
                if (JSON.stringify(this.newLayout.tiles) === JSON.stringify(this.customDrag.tiles)) this.newUndoStack.pop();
                this.stopCustomDrag(); this.undoButton.visible = this.newUndoStack.length > 0;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
    stopCustomDrag() {
        if (this.customDragSignal) this.dialog.disconnect(this.customDragSignal);
        this.customDragSignal = 0; this.customDrag = null;
    }
    assignNewApp(id) {
        const draft = this.newLayout, index = draft?.selected;
        if (!this.creatingNew || index < 0 || index >= draft.apps.length) return;
        if (draft.apps[index] !== id) {
            this.saveNewUndo();
            const previous = draft.apps.indexOf(id);
            const wasPinned = previous >= 0 && draft.pinned[previous] === id;
            if (previous >= 0) {
                draft.apps[previous] = null; draft.pinned[previous] = null;
            }
            draft.apps[index] = id; draft.pinned[index] = wasPinned ? id : null;
        }
        this.showLibrary = false; this.render();
    }
    renderNewAppLibrary(height) {
        const selected = this.newLayout.selected;
        const container = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-app-catalog', width: this.width, height});
        const search = new St.Entry({hint_text: 'Search installed apps', can_focus: true,
            style_class: 'snaptess-app-search'});
        container.add_child(search);
        const scroll = new St.ScrollView({height: Math.max(80, height - 48),
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-library'});
        scroll.set_child(list); container.add_child(scroll); this.canvas.add_child(container);
        const system = Shell.AppSystem.get_default();
        const installed = system.get_installed().filter(info =>
            info.get_id()?.endsWith('.desktop') && info.should_show()).sort((a, b) =>
            a.get_name().localeCompare(b.get_name()));
        const rows = [];
        for (const info of installed) {
            const id = info.get_id(), name = info.get_name();
            const row = button('', () => this.assignNewApp(id), 'snaptess-library-row');
            const content = new St.BoxLayout({style_class: 'snaptess-library-row-content'});
            content.add_child(system.lookup_app(id)?.create_icon_texture(30) ??
                new St.Icon({gicon: info.get_icon(), icon_size: 30}));
            const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                style_class: 'snaptess-library-row-labels'});
            labels.add_child(new St.Label({text: name, style_class: 'snaptess-library-title'}));
            labels.add_child(new St.Label({text: id, style_class: 'snaptess-library-meta'}));
            content.add_child(labels); row.set_child(content);
            row.accessible_name = `Assign ${name} (${id}) to tile ${selected + 1}`;
            list.add_child(row); rows.push({row, query: `${name} ${id}`.toLowerCase()});
        }
        search.clutter_text.connect('text-changed', () => {
            const query = search.get_text().trim().toLowerCase();
            for (const item of rows) item.row.visible = item.query.includes(query);
        });
        search.grab_key_focus();
        this.hint.text = `Choose an installed app for tile ${selected + 1}. This will not launch it.`;
    }
    renderLibrary(height) {
        const scroll = new St.ScrollView({width: this.width, height, hscrollbar_policy: St.PolicyType.NEVER});
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'snaptess-library'});
        scroll.set_child(list); this.canvas.add_child(scroll);
        const workspace = global.workspace_manager.get_active_workspace();
        const available = [...this.extension.records.keys()].filter(w => w.get_workspace() === workspace && !this.draft.includes(w));
        for (const w of available) {
            const r = this.extension.records.get(w);
            const state = r.floating ? 'Floating' : r.visualScale < 0.999 ? `Scaled ${Math.round(r.visualScale * 100)}%` : '';
            const row = button('', () => {
                this.saveUndo();
                const sourceKey = `${w.get_monitor()}:${r.space}`;
                this.draftFor(w.get_monitor(), r.space);
                for (const [key, draft] of this.drafts) {
                    const index = draft.indexOf(w);
                    if (index < 0) continue;
                    draft.splice(index, 1);
                    this.draftPins.get(key).splice(index, 1);
                    this.dirtyContexts.add(key);
                }
                const pinIndex = this.pins.indexOf(this.extension.appId(w));
                if (pinIndex >= 0 && !this.draft[pinIndex]) this.draft[pinIndex] = w;
                else this.draft.push(w);
                if (sourceKey !== this.contextKey()) this.dirtyContexts.add(sourceKey);
                this.markDirty(); this.showLibrary = false; this.render();
            }, 'snaptess-library-row');
            const app = this.extension.windowApp(w);
            const content = new St.BoxLayout({style_class: 'snaptess-library-row-content'});
            content.add_child(app?.create_icon_texture(30) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 30}));
            const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                style_class: 'snaptess-library-row-labels'});
            const title = new St.Label({text: w.get_title() ?? app?.get_name() ?? 'Window',
                style_class: 'snaptess-library-title', x_expand: true});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            title.clutter_text.single_line_mode = true;
            labels.add_child(title);
            labels.add_child(new St.Label({text: `Display ${w.get_monitor() + 1} · Space ${r.space + 1}${state ? ` · ${state}` : ''}`,
                style_class: 'snaptess-library-meta'}));
            content.add_child(labels); row.set_child(content);
            if (r.floating) row.add_style_class_name('floating');
            if (r.visualScale < 0.999) row.add_style_class_name('scaled');
            list.add_child(row);
        }
        if (!available.length) list.add_child(new St.Label({text: 'All windows are already in this layout.', style_class: 'snaptess-hint'}));
        this.hint.text = 'Choose a window to move into this layout. Nothing moves until you apply.';
    }
    clearDropPreviews(except = null) {
        for (const card of this.canvas.get_children()) {
            if (card !== except) this.clearDropPreview(card);
        }
    }
    clearDropPreview(card) {
        if (!card?._dropPreview) return;
        card.remove_style_class_name('drop-target');
        card._dropPreview.destroy(); card._dropPreview = null;
        for (const child of card._dropHidden ?? []) child.show();
        card._dropHidden = null;
    }
    select(index) {
        if (!this.draft[index]) return;
        this.selected = this.selected === index ? -1 : index;
        this.render();
    }
    drop(source, index) {
        if (source.studio !== this || source.index === index || !this.draft[index]) return false;
        this.saveUndo();
        [this.draft[source.index], this.draft[index]] = [this.draft[index], this.draft[source.index]];
        [this.pins[source.index], this.pins[index]] = [this.pins[index], this.pins[source.index]];
        this.selected = index;
        this.markDirty();
        this.animateSlots = new Set([source.index, index]);
        // Do not destroy the drag source during DND's drop callback.
        this.extension.later(0, () => { if (this.extension.studio === this) this.render(); });
        return true;
    }
    reset() {
        this.saveUndo();
        this.preset = 'auto'; this.selected = -1;
        this.draftPresets.set(this.contextKey(), 'auto');
        this.draftTiles.delete(this.contextKey());
        this.draftPins.set(this.contextKey(), []);
        this.drafts.delete(this.contextKey());
        this.markDirty(); this.animateCanvas = true;
        this.render();
    }
    apply() {
        this.draftPresets.set(this.contextKey(), this.preset);
        const keys = new Set([...this.dirtyContexts, this.contextKey()]);
        const changes = [...keys].map(key => {
            const [monitor, space] = key.split(':').map(Number);
            return {monitor, space, preset: this.draftPresets.get(key) ?? this.extension.options(monitor, space).preset,
                windows: this.draftFor(monitor, space), pinned: [...this.draftPins.get(key)],
                tiles: this.draftTiles.get(key)};
        });
        this.extension.applyProfiles(changes, {monitor: this.monitor, space: this.space});
        this.dirtyContexts.clear();
        this.dialog.close();
    }
}
