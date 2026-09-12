import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
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
        this.showLibrary = false;
        this.dialog = new ModalDialog.ModalDialog({styleClass: 'snaptess-studio'});
        const screen = Main.layoutManager.monitors[this.monitor];
        this.width = Math.min(880, Math.floor(screen.width * 0.82));
        this.dialog.contentLayout.set_width(this.width);
        const header = new St.BoxLayout({style_class: 'snaptess-header'});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        titles.add_child(new St.Label({text: 'SNAPTESS', style_class: 'snaptess-eyebrow'}));
        titles.add_child(new St.Label({text: 'A place for every window.', style_class: 'snaptess-title'}));
        header.add_child(titles);
        this.libraryButton = button('Add windows…', () => { this.showLibrary = !this.showLibrary; this.render(); });
        header.add_child(this.libraryButton);
        header.add_child(new St.Icon({gicon: extension.icon, icon_size: 36, style_class: 'snaptess-brand'}));
        this.dialog.contentLayout.add_child(header);
        this.context = new St.BoxLayout({style_class: 'snaptess-toolbar'});
        this.dialog.contentLayout.add_child(this.context);
        this.presets = new St.BoxLayout({style_class: 'snaptess-presets'});
        this.dialog.contentLayout.add_child(this.presets);
        this.canvas = new St.Widget({layout_manager: new Clutter.FixedLayout(), style_class: 'snaptess-canvas'});
        this.dialog.contentLayout.add_child(this.canvas);
        this.hint = new St.Label({style_class: 'snaptess-hint'});
        this.dialog.contentLayout.add_child(this.hint);
        this.dialog.setButtons([
            {label: 'Cancel', key: Clutter.KEY_Escape, action: () => this.dialog.close()},
            {label: 'Reset profile', action: () => this.reset()},
            {label: 'Apply arrangement', default: true, action: () => this.apply()},
        ]);
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
        this.render();
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
        for (const [id, name] of PRESETS) {
            const b = button(name, () => { this.preset = id; this.selected = -1; this.render(); });
            if (id === this.preset) b.add_style_class_name('selected');
            this.presets.add_child(b);
        }
        const area = this.extension.area(this.monitor);
        const height = Math.min(350, Math.round(this.width * area.height / area.width),
            Math.floor(Main.layoutManager.primaryMonitor.height * 0.42));
        this.canvas.set_size(this.width, height);
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
            const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'snaptess-slot-content', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Label({text: String(index + 1).padStart(2, '0'), style_class: 'snaptess-slot-number'}));
            if (w) {
                const app = Shell.WindowTracker.get_default().get_window_app(w);
                if (rect.height > 110) content.add_child(app?.create_icon_texture(32) ?? new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 32}));
                const label = new St.Label({text: w.get_title() ?? 'Window', style_class: 'snaptess-window-title'});
                label.set_width(Math.max(30, rect.width - 36));
                content.add_child(label);
                card._delegate = {index, studio: this, getDragActor: () => new St.Label({
                    text: w.get_title() ?? 'Window', style_class: 'snaptess-drag-label'}), getDragActorSource: () => card,
                    handleDragOver: source => source.studio === this ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP,
                    acceptDrop: source => this.drop(source, index)};
                const draggable = DND.makeDraggable(card);
                draggable.connect('drag-begin', () => { this.selected = index; });
            } else {
                content.add_child(new St.Label({text: 'Open a window here', style_class: 'snaptess-empty'}));
                card._delegate = {handleDragOver: () => DND.DragMotionResult.NO_DROP, acceptDrop: () => false};
            }
            card.set_child(content);
            this.canvas.add_child(card);
        });
        this.hint.text = windows.length ? `${windows.length} windows · Drag to swap, or select two cards. Changes apply only when you confirm.` :
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
            const label = `${w.get_title() ?? 'Window'}  ·  Display ${w.get_monitor() + 1} / Space ${r.space + 1}`;
            const row = button(label, () => {
                for (const draft of this.drafts.values()) {
                    const index = draft.indexOf(w); if (index >= 0) draft.splice(index, 1);
                }
                this.draft.push(w); this.showLibrary = false; this.render();
            }, 'snaptess-library-row');
            list.add_child(row);
        }
        if (!available.length) list.add_child(new St.Label({text: 'All windows are already in this layout.', style_class: 'snaptess-hint'}));
        this.hint.text = 'Choose a window to move into this layout. Nothing moves until you apply.';
    }
    select(index) {
        if (!this.draft[index]) return;
        if (this.selected < 0) { this.selected = index; this.render(); return; }
        const from = this.selected; this.selected = -1;
        [this.draft[from], this.draft[index]] = [this.draft[index], this.draft[from]];
        this.render();
    }
    drop(source, index) {
        if (source.studio !== this || !this.draft[index]) return false;
        [this.draft[source.index], this.draft[index]] = [this.draft[index], this.draft[source.index]];
        this.selected = -1;
        // Do not destroy the drag source during DND's drop callback.
        this.extension.later(0, () => { if (this.extension.studio === this) this.render(); });
        return true;
    }
    reset() {
        this.preset = 'auto'; this.selected = -1;
        this.drafts.delete(`${this.monitor}:${this.space}`);
        this.render();
    }
    apply() {
        this.extension.applyProfile(this.monitor, this.space, this.preset, this.draft);
        this.dialog.close();
    }
}
