import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {layout, PRESETS, capacity} from './layout.js';

function button(label, action, style = 'snaptess-chip') {
    const actor = new St.Button({label, style_class: style, can_focus: true, reactive: true});
    actor.connect('clicked', action);
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
        this.dirtyContexts = new Set();
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
        this.modifiedBadge = new St.Label({text: 'MODIFIED', style_class: 'snaptess-modified-badge', visible: false});
        header.add_child(this.modifiedBadge);
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
        for (const [label, style] of [['Active', 'active'], ['Selected', 'selected'], ['Scaled', 'scaled'], ['Floating', 'floating'], ['Empty', 'empty']]) {
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
        this.dialog.setButtons([
            {label: 'Cancel', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Reset profile', action: () => this.reset()},
            {label: 'Apply arrangement', default: true, action: () => this.apply()},
        ]);
        this.dialog.connect('destroy', () => this.presetMenu?.destroy());
        this.render();
    }
    get draft() {
        const key = `${this.monitor}:${this.space}`;
        if (!this.drafts.has(key)) {
            const windows = this.extension.windows(this.monitor, this.space, true)
                .filter(w => !w.minimized || this.extension.records.get(w).parked);
            const existing = this.extension.groups.get(this.extension.key(this.monitor, this.space)) ?? [];
            const ordered = existing.filter(w => windows.includes(w));
            ordered.push(...windows.filter(w => !ordered.includes(w)));
            this.drafts.set(key, ordered);
        }
        return this.drafts.get(key);
    }
    changeContext(monitor, space) {
        this.monitor = monitor; this.space = space; this.selected = -1;
        this.preset = this.extension.options(monitor, space).preset;
        this.animateCanvas = true;
        this.render();
    }
    contextKey() { return `${this.monitor}:${this.space}`; }
    markDirty() { this.dirtyContexts.add(this.contextKey()); }
    choosePreset(id) {
        this.preset = id; this.selected = -1; this.markDirty(); this.animateCanvas = true;
        this.presetMenu?.close(); this.render();
    }
    render() {
        this.context.destroy_all_children(); this.presets.destroy_all_children(); this.canvas.destroy_all_children();
        Main.layoutManager.monitors.forEach((_m, i) => {
            const b = button(`Display ${i + 1}`, () => this.changeContext(i, this.extension.activeSpace(i)));
            if (this.monitor === i) b.add_style_class_name('selected');
            this.context.add_child(b);
        });
        this.context.add_child(new St.Widget({x_expand: true}));
        for (let i = 0; i < 3; i++) {
            const b = button(`Space ${i + 1}`, () => this.changeContext(this.monitor, i));
            if (this.space === i) b.add_style_class_name('selected');
            this.context.add_child(b);
        }
        this.modifiedBadge.visible = this.dirtyContexts.has(this.contextKey());
        this.previewButton.label = this.showPreviews ? 'Hide previews' : 'Window previews';
        this.previewButton[this.showPreviews ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        if (this.width < 820) {
            const currentName = PRESETS.find(([id]) => id === this.preset)?.[1] ?? 'Auto';
            this.presetButton = button(`Layout · ${currentName}`, () => this.presetMenu.toggle());
            this.presets.add_child(this.presetButton);
            this.presetMenu?.destroy();
            this.presetMenu = new PopupMenu.PopupMenu(this.presetButton, 0.5, St.Side.TOP);
            Main.uiGroup.add_child(this.presetMenu.actor);
            for (const [id, name] of PRESETS)
                this.presetMenu.addAction(name, () => this.choosePreset(id));
        } else {
            this.presetMenu?.destroy(); this.presetMenu = null;
            for (const [id, name] of PRESETS) {
                const b = button(name, () => this.choosePreset(id));
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
        const windows = this.draft;
        this.libraryButton.label = this.showLibrary ? 'Back to layout' : 'Add windows…';
        if (this.showLibrary) { this.renderLibrary(height); return; }
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
                    this.selected = index; card.add_style_class_name('dragging');
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
                content.add_child(new St.Label({text: 'Open a window here', style_class: 'snaptess-empty'}));
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
        this.hint.text = windows.length ? `${windows.length} windows · capacity ${count} · Drag to swap, or select two cards. Changes apply only when you confirm.` :
            'This space is empty. Apply to switch here, then open an application.';
    }
    renderLibrary(height) {
        const scroll = new St.ScrollView({width: this.width, height, hscrollbar_policy: St.PolicyType.NEVER});
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'snaptess-library'});
        scroll.set_child(list); this.canvas.add_child(scroll);
        const workspace = global.workspace_manager.get_active_workspace();
        const available = [...this.extension.records.keys()].filter(w => w.get_workspace() === workspace && !this.draft.includes(w));
        for (const w of available) {
            const r = this.extension.records.get(w);
            const state = r.floating ? ' · Floating' : r.visualScale < 0.999 ? ` · Scaled ${Math.round(r.visualScale * 100)}%` : '';
            const label = `${w.get_title() ?? 'Window'}  ·  Display ${w.get_monitor() + 1} / Space ${r.space + 1}${state}`;
            const row = button(label, () => {
                for (const draft of this.drafts.values()) {
                    const index = draft.indexOf(w); if (index >= 0) draft.splice(index, 1);
                }
                this.draft.push(w); this.markDirty(); this.showLibrary = false; this.render();
            }, 'snaptess-library-row');
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
        if (this.selected < 0) { this.selected = index; this.render(); return; }
        const from = this.selected; this.selected = -1;
        [this.draft[from], this.draft[index]] = [this.draft[index], this.draft[from]];
        this.markDirty();
        this.animateSlots = new Set([from, index]);
        this.render();
    }
    drop(source, index) {
        if (source.studio !== this || !this.draft[index]) return false;
        [this.draft[source.index], this.draft[index]] = [this.draft[index], this.draft[source.index]];
        this.selected = -1;
        this.markDirty();
        this.animateSlots = new Set([source.index, index]);
        // Do not destroy the drag source during DND's drop callback.
        this.extension.later(0, () => { if (this.extension.studio === this) this.render(); });
        return true;
    }
    reset() {
        this.preset = 'auto'; this.selected = -1;
        this.drafts.delete(`${this.monitor}:${this.space}`);
        this.markDirty(); this.animateCanvas = true;
        this.render();
    }
    apply() {
        this.extension.applyProfile(this.monitor, this.space, this.preset, this.draft);
        this.dirtyContexts.delete(this.contextKey());
        this.dialog.close();
    }
}
