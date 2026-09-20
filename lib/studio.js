import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {layout, PRESETS, capacity, activePinnedSlots, reserveAppSlots} from './layout.js';

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
        this.dirtyContexts = new Set();
        this.undoStack = [];
        this.showLibrary = false;
        this.showPreviews = false;
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
        this.libraryButton = button('Add windows…', () => { this.showLibrary = !this.showLibrary; this.render(); });
        header.add_child(this.libraryButton);
        header.add_child(new St.Icon({gicon: extension.icon, icon_size: 36, style_class: 'snaptess-brand'}));
        this.dialog.contentLayout.add_child(header);
        this.context = new St.BoxLayout({style_class: 'snaptess-toolbar'});
        this.dialog.contentLayout.add_child(this.context);
        this.presets = new St.BoxLayout({style_class: 'snaptess-presets'});
        this.dialog.contentLayout.add_child(this.presets);
        this.legend = new St.BoxLayout({style_class: 'snaptess-legend'});
        for (const [label, style] of [['Active', 'active'], ['Selected', 'selected'], ['Scaled', 'scaled'],
            ['Floating', 'floating'], ['Pinned', 'pinned'], ['Empty', 'empty']]) {
            const item = new St.BoxLayout({style_class: `snaptess-legend-item ${style}`});
            item.add_child(new St.Widget({style_class: 'snaptess-legend-dot'}));
            item.add_child(new St.Label({text: label}));
            this.legend.add_child(item);
        }
        this.dialog.contentLayout.add_child(this.legend);
        this.canvas = new St.Widget({layout_manager: new Clutter.FixedLayout(), style_class: 'snaptess-canvas'});
        this.dialog.contentLayout.add_child(this.canvas);
        this.hint = new St.Label({style_class: 'snaptess-hint'});
        this.dialog.contentLayout.add_child(this.hint);
        this.pinButton = button('Pin this app to this tile', () => this.togglePin());
        this.pinButton.visible = false;
        this.dialog.contentLayout.add_child(this.pinButton);
        this.dialog.setButtons([
            {label: 'Cancel', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Reset profile', action: () => this.reset()},
            {label: 'Apply arrangement', default: true, action: () => this.apply()},
        ]);
        this.dialog.connect('destroy', () => this.presetMenu?.destroy());
        this.render();
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
            draftPins: new Map([...this.draftPins].map(([key, pins]) => [key, [...pins]])),
            dirtyContexts: new Set(this.dirtyContexts)});
        if (this.undoStack.length > 20) this.undoStack.shift();
    }
    undo() {
        const state = this.undoStack.pop();
        if (!state) return;
        Object.assign(this, state);
        this.showLibrary = false;
        this.animateCanvas = true;
        this.render();
    }
    choosePreset(id) {
        if (id !== 'auto' && capacity(id) < this.draft.length) return;
        if (id === this.preset) { this.presetMenu?.close(); return; }
        this.saveUndo();
        this.preset = id; this.draftPresets.set(this.contextKey(), id);
        this.selected = -1; this.markDirty(); this.animateCanvas = true;
        this.presetMenu?.close(); this.render();
    }
    togglePin() {
        const w = this.draft[this.selected];
        if (!w) return;
        this.saveUndo();
        const id = this.extension.appId(w), active = this.pins[this.selected] === id;
        for (let i = 0; i < this.pins.length; i++) if (this.pins[i] === id) this.pins[i] = null;
        if (!active) this.pins[this.selected] = id;
        this.markDirty(); this.render();
    }
    updatePinButton() {
        const selectedWindow = this.draft[this.selected];
        this.pinButton.visible = Boolean(selectedWindow);
        this.pinButton.remove_style_class_name('selected');
        if (!selectedWindow) return;
        const pinned = this.pins[this.selected] === this.extension.appId(selectedWindow);
        this.pinButton.label = pinned ? 'Unpin this app from this tile' : 'Pin this app to this tile';
        if (pinned) this.pinButton.add_style_class_name('selected');
    }
    render() {
        this.context.destroy_all_children(); this.presets.destroy_all_children(); this.canvas.destroy_all_children();
        const windows = this.draft;
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
        this.undoButton.visible = this.undoStack.length > 0;
        this.previewButton.label = this.showPreviews ? 'Hide previews' : 'Window previews';
        this.previewButton[this.showPreviews ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        if (this.width < 820) {
            const currentName = PRESETS.find(([id]) => id === this.preset)?.[1] ?? 'Auto';
            this.presetButton = button(`Layout · ${currentName}`, () => this.presetMenu.toggle());
            this.presets.add_child(this.presetButton);
            this.presetMenu?.destroy();
            this.presetMenu = new PopupMenu.PopupMenu(this.presetButton, 0.5, St.Side.TOP);
            Main.uiGroup.add_child(this.presetMenu.actor);
            for (const [id, name] of PRESETS) {
                const item = this.presetMenu.addAction(name, () => this.choosePreset(id));
                item.setSensitive(id === 'auto' || capacity(id) >= windows.length);
            }
        } else {
            this.presetMenu?.destroy(); this.presetMenu = null;
            for (const [id, name] of PRESETS) {
                const b = button(name, () => this.choosePreset(id));
                if (id !== 'auto' && capacity(id) < windows.length) {
                    b.reactive = false; b.can_focus = false;
                    b.add_style_class_name('unavailable');
                }
                if (id === this.preset) b.add_style_class_name('selected');
                this.presets.add_child(b);
            }
        }
        const area = this.extension.area(this.monitor);
        const height = Math.min(480, Math.round(this.width * area.height / area.width),
            Math.floor(Main.layoutManager.primaryMonitor.height * 0.52));
        this.canvas.set_size(this.width, height);
        if (this.animateCanvas && this.extension.settings.get_boolean('animations')) {
            this.canvas.opacity = 80;
            this.canvas.ease({opacity: 255, duration: 170, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this.animateCanvas = false;
        this.libraryButton.label = this.showLibrary ? 'Back to layout' : 'Add windows…';
        if (this.showLibrary) { this.pinButton.hide(); this.renderLibrary(height); return; }
        const count = Math.max(windows.length, capacity(this.preset), 1);
        const rects = layout({x: 0, y: 0, width: this.width, height}, count,
            {preset: this.preset, gap: 8, padding: 10, ratio: this.extension.settings.get_double('master-ratio')});
        rects.forEach((rect, index) => {
            const w = windows[index];
            const card = button('', () => this.select(index), 'snaptess-slot');
            card.set_position(rect.x, rect.y); card.set_size(rect.width, rect.height);
            if (this.selected === index) card.add_style_class_name('selected');
            if (w === global.display.focus_window) card.add_style_class_name('active');
            const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'snaptess-slot-content', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Label({text: String(index + 1).padStart(2, '0'), style_class: 'snaptess-slot-number'}));
            if (w) {
                const app = Shell.WindowTracker.get_default().get_window_app(w);
                const compact = rect.width < 170 || rect.height < 170;
                const minimal = rect.width < 120 || rect.height < 88;
                const actor = this.extension.windowActor(w);
                if (this.showPreviews && actor && !minimal) {
                    const clone = new Clutter.Clone({source: actor, reactive: false});
                    clone.set_size(Math.max(48, Math.min(rect.width - 30, compact ? 110 : 170)),
                        rect.height < 130 ? 30 : compact ? 45 : 70);
                    content.add_child(clone);
                } else if (!minimal) content.add_child(app?.create_icon_texture(compact ? 26 : 36) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: compact ? 26 : 36}));
                const appLabel = new St.Label({text: app?.get_name() ?? 'Application', style_class: 'snaptess-app-name'});
                appLabel.set_width(Math.max(30, rect.width - 28));
                appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                appLabel.clutter_text.single_line_mode = true;
                content.add_child(appLabel);
                const label = new St.Label({text: w.get_title() ?? 'Window', style_class: 'snaptess-window-title'});
                label.set_width(Math.max(30, rect.width - 36));
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.clutter_text.single_line_mode = true;
                if (!compact) content.add_child(label);
                if (w === global.display.focus_window && !minimal && !compact)
                    content.add_child(new St.Label({text: 'ACTIVE', style_class: 'snaptess-active-badge'}));
                const record = this.extension.records.get(w);
                if (record?.visualScale < 0.999) {
                    card.add_style_class_name('scaled');
                    content.add_child(new St.Label({text: `${Math.round(record.visualScale * 100)}%`,
                        style_class: 'snaptess-scale-badge'}));
                }
                if (this.pins[index] === this.extension.appId(w)) {
                    card.add_style_class_name('pinned');
                    if (!minimal) content.add_child(new St.Label({text: 'PINNED', style_class: 'snaptess-pinned-badge'}));
                }
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
                            const sourceApp = Shell.WindowTracker.get_default().get_window_app(sourceWindow);
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
                const name = id ? Shell.AppSystem.get_default().lookup_app(id)?.get_name() ??
                    id.replace(/\.desktop$/i, '') : null;
                const emptyLabel = new St.Label({text: name ? `Reserved · ${name}` : 'Open a window here',
                    style_class: 'snaptess-empty'});
                emptyLabel.set_width(Math.max(30, rect.width - 24));
                emptyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                emptyLabel.clutter_text.single_line_mode = true;
                content.add_child(emptyLabel);
                card._delegate = {handleDragOver: () => DND.DragMotionResult.NO_DROP, acceptDrop: () => false};
            }
            card.set_child(content);
            this.canvas.add_child(card);
            if (this.animateSlots?.has(index) && this.extension.settings.get_boolean('animations')) {
                card.set_pivot_point(0.5, 0.5); card.set_scale(0.94, 0.94); card.opacity = 120;
                card.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        });
        this.animateSlots = null;
        this.updatePinButton();
        const windowCount = windows.filter(Boolean).length;
        this.hint.text = windowCount ? `${windowCount} windows · capacity ${count} · Select a tile to manage its pin, or drag to swap. Changes apply only when you confirm.` :
            'This space is empty. Apply to switch here, then open an application.';
        if (windows.length > 1) {
            const incompatible = this.preset !== 'auto' && capacity(this.preset) < windows.length;
            this.hint.text += incompatible
                ? ` ${PRESETS.find(([id]) => id === this.preset)?.[1] ?? this.preset} cannot fit ${windows.length} tiles; Auto is shown.`
                : ` Smaller layouts are unavailable until you move windows or remove reserved tiles.`;
        }
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
            const app = Shell.WindowTracker.get_default().get_window_app(w);
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
                windows: this.draftFor(monitor, space), pinned: [...this.draftPins.get(key)]};
        });
        this.extension.applyProfiles(changes, {monitor: this.monitor, space: this.space});
        this.dirtyContexts.clear();
        this.dialog.close();
    }
}
