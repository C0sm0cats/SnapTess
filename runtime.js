import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {layout, fitMinimumSize, nearestSlot, directionalSlot, reconcileSlots} from './lib/layout.js';
import {Studio} from './lib/studio.js';

export default class SnapTess extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.running = false;
        this.records = new Map();
        this.groups = new Map();
        this.spaces = new Map();
        this.connections = [];
        this.sources = new Set();
        this.history = [];
        this.pendingCompact = false;
        this.busy = false;
        this.drag = null;
        this.swapMode = false;
        this.loadProfiles();
        this.indicator = new PanelMenu.Button(0.0, 'SnapTess');
        this.icon = new Gio.FileIcon({file: this.dir.get_child('icons/snaptess-symbolic.svg')});
        this.indicator.add_child(new St.Icon({gicon: this.icon, style_class: 'system-status-icon'}));
        Main.panel.addToStatusArea(this.uuid, this.indicator);
        this.switchItem = new PopupMenu.PopupSwitchMenuItem('Arrange windows', false);
        this.switchItem.connect('toggled', (_item, value) => this.setRunning(value));
        this.indicator.menu.addMenuItem(this.switchItem);
        this.indicator.menu.addAction('Layout Studio…', () => this.openStudio());
        this.indicator.menu.addAction('Arrange again', () => { this.checkpoint(); this.tile(true); });
        this.indicator.menu.addAction('Float / tile focused window', () => this.toggleFloating());
        this.indicator.menu.addAction('Swap mode · arrows, Esc to finish', () => this.toggleSwap());
        this.indicator.menu.addAction('Undo last arrangement', () => this.undo());
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.spaceMenu = new PopupMenu.PopupSubMenuMenuItem('Monitor spaces');
        for (let i = 0; i < 3; i++)
            this.spaceMenu.menu.addAction(`Space ${i + 1}`, () => this.switchSpace(i));
        this.indicator.menu.addMenuItem(this.spaceMenu);
        this.indicator.menu.addAction('Preferences', () => this.openPreferences());
        this.indicator.menu.addAction('Stop and restore windows', () => this.setRunning(false));
        this.border = new St.Widget({style_class: 'snaptess-border', reactive: false, visible: false});
        this.preview = new St.Widget({style_class: 'snaptess-preview', reactive: false, visible: false});
        Main.layoutManager.addChrome(this.border);
        Main.layoutManager.addChrome(this.preview);
        this.bindings = {
            toggle: () => this.setRunning(!this.running), retile: () => { this.checkpoint(); this.tile(true); },
            studio: () => this.openStudio(), floating: () => this.toggleFloating(),
            swap: () => this.toggleSwap(), undo: () => this.undo(), stop: () => this.setRunning(false),
            'space-1': () => this.switchSpace(0), 'space-2': () => this.switchSpace(1), 'space-3': () => this.switchSpace(2),
        };
        for (const [name, callback] of Object.entries(this.bindings))
            Main.wm.addKeybinding(name, this.settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, callback);
        this.connect(global.display, 'window-created', (_d, w) => {
            this.track(w);
            this.later(160, () => this.schedule(true));
        });
        this.connect(global.display, 'notify::focus-window', () => this.focusChanged());
        this.connect(global.display, 'grab-op-begin', (_d, w, op) => this.grabBegin(w, op));
        this.connect(global.display, 'grab-op-end', () => this.grabEnd());
        this.connect(global.workspace_manager, 'active-workspace-changed', () => {
            this.exitSwap(); this.hideGuides(); this.schedule(true);
        });
        this.connect(Main.layoutManager, 'monitors-changed', () => this.monitorsChanged());
        this.connect(Main.overview, 'showing', () => this.hideGuides());
        this.connect(Main.overview, 'hidden', () => { this.schedule(false); this.updateBorder(); });
        this.connect(this.settings, 'changed', (_s, key) => {
            if (key === 'profiles') this.loadProfiles();
            this.schedule(true);
        });
        for (const actor of global.get_window_actors()) this.track(actor.meta_window);
    }

    connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this.connections.push([object, id]);
        return id;
    }

    later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.sources.delete(id);
            try { callback(); } catch (error) { console.error(`[SnapTess] ${error.stack}`); }
            return GLib.SOURCE_REMOVE;
        });
        this.sources.add(id);
        return id;
    }

    cancel(id) {
        if (id && this.sources.delete(id)) GLib.Source.remove(id);
    }

    eligible(w) {
        return w && w.get_window_type() === Meta.WindowType.NORMAL && !w.is_override_redirect() &&
            !w.skip_taskbar && !w.is_on_all_workspaces();
    }

    appId(w) {
        return Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? w.get_wm_class() ?? '';
    }

    track(w) {
        if (!this.eligible(w) || this.records.has(w)) return;
        const record = {original: null, floating: false, space: this.activeSpace(w.get_monitor(), w.get_workspace()),
            parked: false, signals: [], monitor: w.get_monitor(), tileRect: null, visualScale: 1};
        this.records.set(w, record);
        const watch = (signal, fn) => record.signals.push(w.connect(signal, fn));
        watch('unmanaged', () => {
            for (const id of record.signals) w.disconnect(id);
            this.records.delete(w);
            if (this.drag?.window === w) this.drag = null;
            this.schedule(this.settings.get_boolean('compact-close'));
        });
        watch('notify::minimized', () => {
            if (this.busy) return;
            if (w.minimized && !record.parked) record.minimizeSlots = [...(this.groups.get(this.key(w.get_monitor())) ?? [])];
            else if (!w.minimized && record.minimizeSlots) {
                const before = record.minimizeSlots.filter(item => item && this.records.has(item));
                const current = this.windows(w.get_monitor());
                if (before.length === current.length && before.every(item => current.includes(item)))
                    this.groups.set(this.key(w.get_monitor()), before);
                record.minimizeSlots = null;
            }
            // A parked window activated from the dock joins the current space.
            if (record.parked && !w.minimized) {
                record.parked = false;
                record.space = this.activeSpace(w.get_monitor());
            }
            this.schedule(this.settings.get_boolean('compact-minimize'));
        });
        for (const signal of ['notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen']) watch(signal, () => {
            if (w.fullscreen || w.get_maximize_flags()) this.resetWindowScale(w);
            this.schedule(false);
        });
        watch('workspace-changed', () => {
            if (!this.busy) {
                record.space = this.activeSpace(w.get_monitor(), w.get_workspace());
                this.schedule(true);
            }
        });
        watch('position-changed', () => {
            const monitor = w.get_monitor();
            if (!this.busy && !this.drag && record.monitor !== monitor) {
                record.monitor = monitor;
                record.space = this.activeSpace(monitor);
                this.schedule(true);
            }
            if (global.display.focus_window === w) this.updateBorder();
        });
        watch('size-changed', () => { if (global.display.focus_window === w) this.updateBorder(); });
    }

    activeSpace(monitor, workspace = global.workspace_manager.get_active_workspace()) {
        return this.spaces.get(workspace)?.get(monitor) ?? 0;
    }
    workspaceIndex() { return global.workspace_manager.get_active_workspace_index(); }
    key(monitor, space = this.activeSpace(monitor)) { return `${this.workspaceIndex()}:${monitor}:${space}`; }
    profileKey(monitor, space = this.activeSpace(monitor)) {
        const logical = global.backend.get_monitor_manager().get_logical_monitors().find(m => m.get_number() === monitor);
        const connector = logical?.get_monitors().map(m => m.get_connector()).sort().join('+');
        return `${this.workspaceIndex()}:${connector ?? monitor}:${space}`;
    }
    loadProfiles() {
        try {
            const value = JSON.parse(this.settings.get_string('profiles'));
            this.profiles = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch { this.profiles = {}; }
    }
    options(monitor, space = this.activeSpace(monitor)) {
        return {preset: this.profiles[this.profileKey(monitor, space)]?.preset ?? 'auto',
            gap: this.settings.get_int('gap'), padding: this.settings.get_int('padding'),
            ratio: this.settings.get_double('master-ratio')};
    }
    area(monitor) { return global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor); }
    currentMonitor() { return global.display.focus_window?.get_monitor() ?? global.display.get_current_monitor(); }

    windows(monitor, space = this.activeSpace(monitor), includeMinimized = false) {
        const workspace = global.workspace_manager.get_active_workspace();
        const excluded = this.settings.get_strv('excluded-apps');
        return [...this.records].filter(([w, r]) => this.eligible(w) && w.get_monitor() === monitor &&
            w.get_workspace() === workspace && r.space === space && !r.floating &&
            !excluded.includes(this.appId(w)) && (includeMinimized || !w.minimized)).map(([w]) => w);
    }

    snapshot(w) {
        const r = w.get_frame_rect();
        const tileRect = this.records.get(w)?.tileRect;
        return {x: r.x, y: r.y, width: r.width, height: r.height, monitor: w.get_monitor(),
            maximized: w.get_maximize_flags(), minimized: w.minimized,
            tileRect: tileRect ? {...tileRect} : null};
    }
    checkpoint() {
        if (!this.running) return;
        this.history.push({windows: new Map([...this.records.keys()].map(w => [w, this.snapshot(w)])),
            groups: new Map([...this.groups].map(([k, g]) => [k, [...g]])),
            records: new Map([...this.records].map(([w, r]) => [w, {floating: r.floating, space: r.space, parked: r.parked}])),
            spaces: new Map([...this.spaces].map(([w, m]) => [w, new Map(m)])),
            profiles: JSON.stringify(this.profiles)});
        if (this.history.length > 10) this.history.shift();
    }
    restore(w, state) {
        if (w.fullscreen) return;
        this.resetWindowScale(w, true);
        w.unmaximize();
        if (state.monitor < Main.layoutManager.monitors.length) w.move_to_monitor(state.monitor);
        if (state.tileRect && !state.maximized) this.place(w, state.tileRect);
        else w.move_resize_frame(false, state.x, state.y, state.width, state.height);
        if (state.maximized) w.set_maximize_flags(state.maximized);
        if (state.minimized) w.minimize(); else w.unminimize();
    }
    undo() {
        const state = this.history.pop();
        if (!state) return;
        this.busy = true;
        try {
            this.groups = state.groups; this.spaces = state.spaces;
            for (const [w, record] of state.records) if (this.records.has(w)) Object.assign(this.records.get(w), record);
            this.profiles = JSON.parse(state.profiles);
            this.settings.set_string('profiles', state.profiles);
            for (const [w, rect] of state.windows) if (this.records.has(w)) this.restore(w, rect);
        } finally { this.busy = false; }
        this.updateBorder();
    }

    setRunning(value) {
        if (this.running === value) return;
        this.running = value;
        this.switchItem.setToggleState(value);
        this.indicator[value ? 'add_style_class_name' : 'remove_style_class_name']('snaptess-on');
        if (value) {
            for (const [w, r] of this.records) r.original = this.snapshot(w);
            this.tile(true, true);
        } else {
            this.cancel(this.pending); this.pending = 0;
            this.exitSwap(); this.drag = null; this.hideGuides();
            this.busy = true;
            try {
                for (const [w, r] of this.records) {
                    if (r.parked) { w.unminimize(); r.parked = false; }
                    if (r.original) this.restore(w, r.original);
                    r.original = null; r.space = 0;
                }
            } finally { this.busy = false; }
            this.groups.clear(); this.spaces.clear(); this.history = [];
        }
    }

    schedule(compact) {
        if (!this.running || this.busy) return;
        this.pendingCompact ||= compact;
        this.cancel(this.pending);
        this.pending = this.later(110, () => {
            this.pending = 0;
            const value = this.pendingCompact; this.pendingCompact = false;
            this.tile(value);
        });
    }

    tile(compact = true, releaseMaximized = false) {
        if (!this.running || this.busy || this.drag) return;
        this.busy = true;
        try {
            for (let monitor = 0; monitor < Main.layoutManager.monitors.length; monitor++) {
                const windows = this.windows(monitor);
                // Freeze the entire monitor while a window is maximized/fullscreen.
                if (!releaseMaximized && windows.some(w => w.fullscreen || w.get_maximize_flags())) continue;
                const key = this.key(monitor);
                let previous = this.groups.get(key);
                if (!previous) {
                    const order = this.profiles[this.profileKey(monitor)]?.apps ?? [];
                    previous = [...windows].sort((a, b) => {
                        const rank = w => { const i = order.indexOf(this.appId(w)); return i < 0 ? 999 : i; };
                        return rank(a) - rank(b);
                    });
                }
                const slots = reconcileSlots(previous, windows, compact);
                this.groups.set(key, slots);
                const rects = layout(this.area(monitor), slots.length, this.options(monitor));
                slots.forEach((w, i) => {
                    if (!w || w.fullscreen) return;
                    const record = this.records.get(w);
                    record.original ??= this.snapshot(w);
                    if (releaseMaximized) w.unmaximize();
                    this.place(w, rects[i]);
                });
            }
        } finally { this.busy = false; }
        this.updateBorder();
    }

    windowActor(w) {
        return global.get_window_actors().find(actor => actor.meta_window === w) ?? null;
    }
    resetWindowScale(w, clearTarget = false) {
        const actor = this.windowActor(w);
        if (actor) {
            actor.set_pivot_point(0, 0);
            actor.set_scale(1, 1);
        }
        const record = this.records.get(w);
        if (record) {
            record.visualScale = 1;
            if (clearTarget) record.tileRect = null;
        }
    }
    minimumSize(w) {
        if (typeof w.get_min_size !== 'function') return {width: 0, height: 0};
        try {
            const [known, width, height] = w.get_min_size();
            return known ? {width: Math.max(0, width), height: Math.max(0, height)} : {width: 0, height: 0};
        } catch {
            return {width: 0, height: 0};
        }
    }
    place(w, rect) {
        if (!rect) return;
        const actor = this.windowActor(w);
        this.resetWindowScale(w);
        const minimum = actor ? this.minimumSize(w) : {width: 0, height: 0};
        const fitted = fitMinimumSize(rect, minimum.width, minimum.height);
        w.move_resize_frame(false, fitted.frame.x, fitted.frame.y, fitted.frame.width, fitted.frame.height);
        const record = this.records.get(w);
        if (record) {
            record.tileRect = {...rect};
            record.visualScale = fitted.scale;
        }
        if (actor && fitted.scale < 0.999) {
            actor.set_pivot_point(0, 0);
            actor.set_scale(fitted.scale, fitted.scale);
        }
    }
    hideGuides() { this.border.hide(); this.preview.hide(); }
    showRect(actor, rect) {
        const appearing = !actor.visible;
        actor.set_position(rect.x, rect.y); actor.set_size(rect.width, rect.height); actor.show();
        if (appearing && this.settings.get_boolean('animations')) {
            actor.opacity = 0;
            actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (appearing) actor.opacity = 255;
    }
    updateBorder() {
        const w = global.display.focus_window;
        const record = this.records.get(w);
        if (!this.running || this.drag || this.studio || Main.overview.visible || !record || record.floating ||
            w.minimized || w.fullscreen || w.get_maximize_flags() || !this.settings.get_boolean('active-border') ||
            !this.windows(w.get_monitor()).includes(w)) {
            this.border.hide(); return;
        }
        const borderColor = this.swapMode ? '#ff808b' : '#8ce8c3';
        this.border.set_style(
            `background-color: transparent; background-image: none; border: 2px solid ${borderColor}; border-radius: 12px; box-shadow: none;`,
        );
        this.showRect(this.border, record.tileRect ?? w.get_frame_rect());
    }
    focusChanged() { this.updateBorder(); }

    toggleFloating() {
        const w = global.display.focus_window, record = this.records.get(w);
        if (!record || !this.running) return;
        this.checkpoint(); record.floating = !record.floating;
        if (record.floating && record.original) {
            this.busy = true;
            try { this.restore(w, {...record.original, minimized: false}); } finally { this.busy = false; }
        }
        this.tile(true);
    }

    toggleSwap() {
        if (this.swapMode) { this.exitSwap(); return; }
        if (!this.running || !this.records.has(global.display.focus_window)) return;
        this.swapMode = true;
        this.swapActor = new St.Widget({reactive: true, can_focus: true, width: 1, height: 1});
        Main.uiGroup.add_child(this.swapActor);
        this.swapGrab = Main.pushModal(this.swapActor, {actionMode: Shell.ActionMode.NORMAL});
        this.swapActor.grab_key_focus();
        this.swapWindow = global.display.focus_window;
        this.swapActor.connect('key-press-event', (_a, e) => {
            const key = e.get_key_symbol();
            if (key === Clutter.KEY_Escape || key === Clutter.KEY_Return) this.exitSwap();
            const direction = new Map([[Clutter.KEY_Left, 'left'], [Clutter.KEY_Right, 'right'],
                [Clutter.KEY_Up, 'up'], [Clutter.KEY_Down, 'down']]).get(key);
            if (direction) this.swapDirection(direction);
            return Clutter.EVENT_STOP;
        });
        this.updateBorder();
    }
    exitSwap() {
        if (this.swapGrab) Main.popModal(this.swapGrab);
        this.swapGrab = null;
        this.swapActor?.destroy(); this.swapActor = null; this.swapMode = false; this.swapWindow = null;
        this.updateBorder();
    }
    swapDirection(direction) {
        const w = this.swapWindow;
        if (!this.records.has(w)) { this.exitSwap(); return; }
        const slots = this.groups.get(this.key(w.get_monitor())) ?? [];
        const from = slots.indexOf(w);
        const rects = layout(this.area(w.get_monitor()), slots.length, this.options(w.get_monitor()));
        const to = directionalSlot(rects, from, direction);
        if (to < 0) return;
        this.checkpoint(); [slots[from], slots[to]] = [slots[to], slots[from]];
        this.tile(false);
    }

    switchSpace(space, monitor = this.currentMonitor()) {
        if (!this.running || space === this.activeSpace(monitor)) return;
        this.exitSwap(); this.hideGuides();
        const old = this.activeSpace(monitor), workspace = global.workspace_manager.get_active_workspace();
        this.busy = true;
        try {
            for (const [w, r] of this.records) {
                if (w.get_monitor() !== monitor || w.get_workspace() !== workspace) continue;
                if (r.space === old && !w.minimized) { r.parked = true; w.minimize(); }
                if (r.space === space && r.parked) { r.parked = false; w.unminimize(); }
            }
            if (!this.spaces.has(workspace)) this.spaces.set(workspace, new Map());
            this.spaces.get(workspace).set(monitor, space);
        } finally { this.busy = false; }
        this.spaceMenu.label.text = `Monitor spaces · ${space + 1}`;
        this.tile(false);
    }

    grabBegin(w, op) {
        if (!this.running || !this.records.has(w) || this.records.get(w).floating ||
            ![Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING].includes(op)) return;
        this.checkpoint();
        this.drag = {window: w, monitor: w.get_monitor(), target: null};
        this.border.hide();
        const tick = () => {
            if (!this.drag) return;
            const [x, y] = global.get_pointer();
            const monitor = Main.layoutManager.monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
            if (monitor >= 0) {
                let slots = [...(this.groups.get(this.key(monitor)) ?? this.windows(monitor))];
                if (!slots.includes(w)) slots.push(w);
                const rects = layout(this.area(monitor), slots.length, this.options(monitor));
                const index = nearestSlot(rects, x, y);
                if (index >= 0) {
                    this.drag.target = {monitor, index};
                    this.showRect(this.preview, rects[index]);
                }
            } else { this.drag.target = null; this.preview.hide(); }
            this.dragTimer = this.later(32, tick);
        };
        tick();
    }
    grabEnd() {
        if (!this.drag) return;
        this.cancel(this.dragTimer); this.dragTimer = 0;
        const {window: w, target, monitor: source} = this.drag;
        this.drag = null; this.preview.hide();
        if (!this.records.has(w)) return;
        if (target) {
            const key = this.key(target.monitor);
            const slots = [...(this.groups.get(key) ?? this.windows(target.monitor))];
            if (source === target.monitor) {
                const from = slots.indexOf(w);
                if (from >= 0) [slots[from], slots[target.index]] = [slots[target.index], slots[from]];
            } else {
                this.busy = true;
                try { w.move_to_monitor(target.monitor); } finally { this.busy = false; }
                const r = this.records.get(w); r.monitor = target.monitor; r.space = this.activeSpace(target.monitor);
                const clean = slots.filter(item => item !== w);
                clean.splice(target.index, 0, w);
                slots.splice(0, slots.length, ...clean);
            }
            this.groups.set(key, slots);
        }
        this.tile(true);
    }

    monitorsChanged() {
        if (!this.running) return;
        // Never leave a window parked on a disconnected display.
        this.busy = true;
        try {
            for (const [w, r] of this.records) {
                if (r.parked) { r.parked = false; w.unminimize(); }
                r.monitor = w.get_monitor(); r.space = 0;
            }
            this.spaces.clear(); this.groups.clear();
        } finally { this.busy = false; }
        this.schedule(true);
    }

    openStudio() {
        this.exitSwap();
        if (this.studio) return;
        this.studio = new Studio(this);
        this.studio.dialog.connect('destroy', () => { this.studio = null; this.updateBorder(); });
        this.hideGuides(); this.studio.dialog.open();
    }
    applyProfile(monitor, space, preset, windows) {
        if (!this.running) this.setRunning(true);
        this.checkpoint();
        this.switchSpace(space, monitor);
        const live = windows.filter(w => this.records.has(w));
        this.busy = true;
        try {
            for (const w of live) {
                const r = this.records.get(w); r.original ??= this.snapshot(w);
                r.floating = false; r.parked = false; r.space = space; r.monitor = monitor;
                w.move_to_monitor(monitor); w.unminimize();
            }
        } finally { this.busy = false; }
        this.groups.set(this.key(monitor, space), live);
        this.profiles[this.profileKey(monitor, space)] = {preset, apps: live.map(w => this.appId(w))};
        this.settings.set_string('profiles', JSON.stringify(this.profiles));
        this.tile(true, true);
    }

    disable() {
        this.studio?.dialog.destroy(); this.studio = null;
        this.setRunning(false);
        this.exitSwap();
        for (const name of Object.keys(this.bindings)) Main.wm.removeKeybinding(name);
        for (const id of this.sources) GLib.Source.remove(id);
        this.sources.clear();
        for (const [object, id] of this.connections) object.disconnect(id);
        for (const [w, r] of this.records) for (const id of r.signals) w.disconnect(id);
        this.records.clear();
        Main.layoutManager.removeChrome(this.border); this.border.destroy();
        Main.layoutManager.removeChrome(this.preview); this.preview.destroy();
        this.indicator.destroy();
        this.settings = null;
    }
}
