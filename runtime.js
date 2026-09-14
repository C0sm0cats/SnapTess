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
import {layout, fitMinimumSize, frameScalePivot, nearestSlot, directionalSlot, reconcileSlots} from './lib/layout.js';
import {Studio} from './lib/studio.js';

const RUNTIME_REVISION = 8;
const RESTORE_STABILIZE_MS = 1400;
const RESTORE_QUIET_MS = 120;
const MAX_RESTORE_MOVES = 8;

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
        this.indicator.menu.addAction('Swap mode · arrows · Enter accept · Esc cancel', () => this.toggleSwap());
        this.indicator.menu.addAction('Undo last arrangement', () => this.undo());
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.spaceMenu = new PopupMenu.PopupSubMenuMenuItem('Monitor spaces');
        for (let i = 0; i < 3; i++)
            this.spaceMenu.menu.addAction(`Space ${i + 1}`, () => this.switchSpace(i));
        this.indicator.menu.addMenuItem(this.spaceMenu);
        this.indicator.menu.addAction('Preferences', () => this.openPreferences());
        this.indicator.menu.addAction('Stop and restore windows', () => this.setRunning(false));
        this.border = new St.Widget({style_class: 'snaptess-border', reactive: false, visible: false});
        this.preview = new St.Widget({
            style_class: 'snaptess-preview',
            style: 'background-color: transparent; background-image: none; border: 2px solid #8ce8c3; border-radius: 16px;',
            reactive: false,
            visible: false,
        });
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
        this.writeRuntimeStatus();
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

    writeRuntimeStatus() {
        try {
            const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'snaptess']);
            GLib.mkdir_with_parents(dir, 0o700);
            GLib.file_set_contents(GLib.build_filenamev([dir, 'runtime-status.json']), JSON.stringify({
                extension_version: this.metadata.version ?? null,
                runtime_revision: RUNTIME_REVISION,
                runtime_uri: import.meta.url,
                loaded_at: new Date().toISOString(),
            }, null, 2));
        } catch (error) {
            console.error(`[SnapTess] cannot write runtime status: ${error.stack ?? error}`);
        }
    }

    eligible(w) {
        return w && w.get_window_type() === Meta.WindowType.NORMAL && !w.is_override_redirect() &&
            !w.skip_taskbar && !w.is_on_all_workspaces();
    }

    appId(w) {
        return Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? w.get_wm_class() ?? '';
    }

    isSpecialWindow(w) {
        return Boolean(w?.fullscreen || w?.get_maximize_flags?.());
    }

    track(w) {
        if (!this.eligible(w) || this.records.has(w)) return;
        const record = {original: null, floating: false, space: this.activeSpace(w.get_monitor(), w.get_workspace()),
            parked: false, signals: [], monitor: w.get_monitor(), tileRect: null, visualScale: 1, scaleTimer: 0,
            backingRect: null, scaleNegotiated: false, placementMoves: 0, placing: false, restoreStarted: false, restoreMoves: 0,
            traceUntil: 0, traceSignals: [], traceTimer: 0, requestSequence: 0, effectActor: null, effectSignal: 0, specialState: this.isSpecialWindow(w),
            restorePending: false, restoreTimer: 0, settleTimer: 0, restoreUntil: 0, restoreQuietUntil: 0};
        this.records.set(w, record);
        this.watchWindowEffects(w);
        const watch = (signal, fn) => record.signals.push(w.connect(signal, fn));
        watch('unmanaged', () => {
            this.stopWindowTrace(record);
            this.cancel(record.scaleTimer); record.scaleTimer = 0;
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            this.disconnectWindowEffects(record);
            for (const id of record.signals) w.disconnect(id);
            this.records.delete(w);
            if (this.drag?.window === w) this.drag = null;
            if (this.swapWindow === w) this.exitSwap(false);
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
            if (record.parked && !w.minimized) {
                record.parked = false;
                record.space = this.activeSpace(w.get_monitor());
            }
            this.schedule(this.settings.get_boolean('compact-minimize'));
        });
        for (const signal of ['notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen']) watch(signal, () => {
                this.startWindowTrace(w, record);
                this.traceWindow(w, signal);
                this.specialWindowChanged(w, record);
            });
        watch('workspace-changed', () => {
            if (!this.busy) {
                record.space = this.activeSpace(w.get_monitor(), w.get_workspace());
                this.schedule(true);
            }
        });
        watch('position-changed', () => {
            this.traceWindow(w, 'position-changed');
            const monitor = w.get_monitor();
            if (!this.busy && !this.drag && !record.placing && !record.restorePending && record.monitor !== monitor) {
                record.monitor = monitor;
                record.space = this.activeSpace(monitor);
                this.schedule(true);
            }
            if (record.restorePending && Date.now() >= record.restoreQuietUntil && !record.placing && !this.busy && !this.drag)
                this.queueWindowRestore(w, 80);
            if (this.running && record.tileRect && !record.floating && !record.placing && !this.busy && !this.drag)
                this.scheduleWindowScale(w);
            if (global.display.focus_window === w) this.updateBorder();
        });
        watch('size-changed', () => {
            this.traceWindow(w, 'size-changed');
            if (record.restorePending && Date.now() >= record.restoreQuietUntil && !record.placing && !this.busy && !this.drag)
                this.queueWindowRestore(w, 80);
            if (this.running && record.tileRect && !record.floating) this.scheduleWindowScale(w);
            if (global.display.focus_window === w) this.updateBorder();
        });
    }

    specialWindowChanged(w, record) {
        const special = this.isSpecialWindow(w);
        if (special) {
            record.specialState = true;
            record.restorePending = false;
            record.restoreUntil = 0;
            record.restoreQuietUntil = 0;
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            this.resetWindowScale(w);
            return;
        }
        if (record.specialState) {
            record.specialState = false;
            record.restorePending = true;
            record.restoreStarted = false;
            record.restoreMoves = 0;
            record.restoreUntil = Date.now() + RESTORE_STABILIZE_MS;
            record.restoreQuietUntil = 0;
            this.cancel(record.settleTimer);
            record.settleTimer = this.later(RESTORE_STABILIZE_MS, () => {
                record.settleTimer = 0;
                this.finishWindowRestore(w);
            });
            this.queueWindowRestore(w, 180);
            return;
        }
        // Both maximize properties notify for one transition. The second
        // notification must not schedule a full tile()/place() during restore.
    }

    queueWindowRestore(w, delay = 120) {
        const record = this.records.get(w);
        if (!record?.restorePending) return;
        this.cancel(record.restoreTimer);
        record.restoreTimer = this.later(delay, () => {
            if (!this.records.has(w)) return;
            record.restoreTimer = 0;
            this.restoreWindowPlacement(w);
        });
    }

    restoreWindowPlacement(w) {
        const record = this.records.get(w);
        if (!this.running || !record?.restorePending || !record.tileRect || record.floating || w.minimized ||
            this.isSpecialWindow(w)) return;
        if (Date.now() > record.restoreUntil) {
            this.finishWindowRestore(w);
            return;
        }
        if (this.drag?.window === w || global.display.is_grabbed()) {
            this.queueWindowRestore(w, 120);
            return;
        }
        if (this.windowEffectActive(this.windowActor(w))) return;
        record.restoreQuietUntil = Date.now() + RESTORE_QUIET_MS;
        if (!record.restoreStarted) {
            record.restoreStarted = true;
            // Reuse the pre-maximize backing size, never the transient maximized
            // frame. Later commits may update the visual fit, not this request.
            this.place(w, record.tileRect, true);
        } else {
            this.restoreWindowPosition(w, record);
            this.scheduleWindowScale(w, 0);
        }
    }

    finishWindowRestore(w) {
        const record = this.records.get(w);
        if (!record?.restorePending) return;
        this.cancel(record.restoreTimer); record.restoreTimer = 0;
        this.cancel(record.settleTimer); record.settleTimer = 0;
        if (!this.running || !record.tileRect || record.floating || w.minimized || this.isSpecialWindow(w) ||
            this.drag?.window === w || global.display.is_grabbed()) {
            record.restorePending = false;
            return;
        }
        // Completion resumes through effects-completed, even for long effects.
        if (this.windowEffectActive(this.windowActor(w))) return;
        // Never end the transaction by restarting size negotiation.
        if (!record.restoreStarted) {
            record.restoreStarted = true;
            this.place(w, record.tileRect, true);
        } else {
            this.restoreWindowPosition(w, record);
        }
        record.restorePending = false;
        record.restoreUntil = 0;
        record.restoreQuietUntil = 0;
        this.traceWindow(w, 'restore-finished');
        this.scheduleWindowScale(w, 0);
    }

    restoreWindowPosition(w, record) {
        const frame = w.get_frame_rect(), target = record.tileRect;
        if (Math.abs(frame.x - target.x) <= 1 && Math.abs(frame.y - target.y) <= 1) return;
        // Keep position repair separate from backing-size negotiation.
        // A client that also rejects moves must not create an unlimited echo loop.
        if (record.restoreMoves >= MAX_RESTORE_MOVES) return;
        record.restoreMoves++;
        this.requestWindowGeometry(w, 'restore-position', target, true);
    }

    windowEffectActive(actor) {
        // GNOME Shell 50 freezes the actor before installing transitions. Its
        // animation info covers that gap; effects-completed follows its cleanup.
        return Boolean(actor && (actor.__animationInfo ||
            ['scale-x', 'scale-y', 'translation-x', 'translation-y', 'x', 'y']
                .some(name => actor.get_transition?.(name))));
    }

    requestWindowGeometry(w, reason, rect, positionOnly = false) {
        const record = this.records.get(w);
        if (!record) return;
        record.requestSequence++;
        record.placing = true;
        this.traceWindow(w, `request:${reason}`, {requested: {...rect}, positionOnly});
        try {
            if (positionOnly) w.move_frame(false, rect.x, rect.y);
            else w.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        } finally {
            record.placing = false;
            this.traceWindow(w, `returned:${reason}`);
        }
    }

    startWindowTrace(w, record) {
        // Opt in for one WM_CLASS (or '*') at runtime; no filesystem polling.
        // Checked only on maximize/fullscreen notifications, before handling them.
        try {
            const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'snaptess', 'trace-restore']);
            const [ok, data] = GLib.file_get_contents(path);
            const filter = ok ? new TextDecoder().decode(data).trim() : '';
            if (filter !== '*' && filter !== w.get_wm_class()) return;
        } catch { return; }
        record.traceUntil = Date.now() + 10000;
        this.cancel(record.traceTimer);
        record.traceTimer = this.later(10000, () => this.stopWindowTrace(record));
        const actor = this.windowActor(w);
        if (!actor || record.traceSignals.length) return;
        for (const property of ['x', 'y', 'width', 'height', 'scale-x', 'scale-y',
            'translation-x', 'translation-y', 'pivot-point']) {
            const id = actor.connect(`notify::${property}`, () => this.traceWindow(w, `actor:${property}`));
            record.traceSignals.push([actor, id]);
        }
    }

    stopWindowTrace(record) {
        this.cancel(record.traceTimer); record.traceTimer = 0;
        record.traceUntil = 0;
        for (const [actor, id] of record.traceSignals) {
            try { actor.disconnect(id); } catch { /* actor disposed */ }
        }
        record.traceSignals = [];
    }

    traceWindow(w, event, detail = {}) {
        const r = this.records.get(w);
        if (!r || Date.now() >= r.traceUntil) return;
        const actor = this.windowActor(w);
        const rect = value => value ? {x: value.x, y: value.y, width: value.width, height: value.height} : null;
        console.log(`[SnapTess:restore] ${JSON.stringify({
            timestamp: new Date().toISOString(), monotonic_us: GLib.get_monotonic_time(),
            window: w.get_stable_sequence(), wmClass: w.get_wm_class(), clientType: w.get_client_type?.(),
            event, frame_rect: rect(w.get_frame_rect()), buffer_rect: rect(w.get_buffer_rect?.()),
            tileRect: r.tileRect, backingRect: r.backingRect,
            actor: actor ? {x: actor.x, y: actor.y, width: actor.width, height: actor.height,
                scale: actor.get_scale(), translation: [actor.translation_x, actor.translation_y],
                pivot: actor.get_pivot_point(), effectActive: this.windowEffectActive(actor)} : null,
            fullscreen: w.fullscreen, maximize_flags: w.get_maximize_flags(),
            is_grabbed: global.display.is_grabbed(), restorePending: r.restorePending,
            stabilization: {started: r.restoreStarted, until: r.restoreUntil,
                quietUntil: r.restoreQuietUntil, moves: r.restoreMoves},
            scaleNegotiated: r.scaleNegotiated, inSnapTessRequest: r.placing,
            requestSequence: r.requestSequence, ...detail,
        })}`);
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
    captureCheckpoint() {
        if (!this.running) return;
        return {windows: new Map([...this.records.keys()].map(w => [w, this.snapshot(w)])),
            groups: new Map([...this.groups].map(([k, g]) => [k, [...g]])),
            records: new Map([...this.records].map(([w, r]) => [w, {floating: r.floating, space: r.space, parked: r.parked}])),
            spaces: new Map([...this.spaces].map(([w, m]) => [w, new Map(m)])),
            profiles: JSON.stringify(this.profiles)};
    }
    pushCheckpoint(state) {
        if (!state) return;
        this.history.push(state);
        if (this.history.length > 10) this.history.shift();
    }
    checkpoint() { this.pushCheckpoint(this.captureCheckpoint()); }
    restore(w, state) {
        if (w.fullscreen) return;
        this.resetWindowScale(w, true);
        w.unmaximize();
        if (state.monitor < Main.layoutManager.monitors.length) w.move_to_monitor(state.monitor);
        if (state.tileRect && !state.maximized) this.place(w, state.tileRect);
        else this.requestWindowGeometry(w, 'original-state', state);
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
            this.exitSwap(false); this.drag = null; this.hideGuides();
            this.busy = true;
            try {
                for (const [w, r] of this.records) {
                    this.cancel(r.restoreTimer); r.restoreTimer = 0;
                    this.cancel(r.settleTimer); r.settleTimer = 0;
                    r.restorePending = false; r.restoreUntil = 0; r.restoreQuietUntil = 0;
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
        try {
            return w?.get_compositor_private?.() ??
                global.get_window_actors().find(actor => actor.meta_window === w) ?? null;
        } catch {
            return global.get_window_actors().find(actor => actor.meta_window === w) ?? null;
        }
    }
    disconnectWindowEffects(record) {
        if (!record) return;
        const actor = record.effectActor, id = record.effectSignal;
        record.effectActor = null;
        record.effectSignal = 0;
        if (actor && id) {
            try { actor.disconnect(id); } catch { /* actor may already be disposed */ }
        }
    }
    watchWindowEffects(w) {
        const record = this.records.get(w);
        if (!record || record.effectSignal) return;
        const actor = this.windowActor(w);
        if (!actor) return;
        try {
            record.effectActor = actor;
            record.effectSignal = actor.connect('effects-completed', () => {
                this.traceWindow(w, 'effects-completed');
                if (!this.running || this.records.get(w) !== record || !record.tileRect || record.floating) return;
                if (record.restorePending && !this.isSpecialWindow(w)) this.queueWindowRestore(w, 0);
                else this.scheduleWindowScale(w, 0);
            });
        } catch {
            record.effectActor = null;
            record.effectSignal = 0;
        }
    }
    resetWindowScale(w, clearTarget = false) {
        const actor = this.windowActor(w);
        const record = this.records.get(w);
        if (record) {
            this.cancel(record.scaleTimer); record.scaleTimer = 0;
        }
        if (actor && !this.windowEffectActive(actor)) {
            actor.set_pivot_point(0, 0);
            actor.set_scale(1, 1);
            actor.translation_x = 0;
            actor.translation_y = 0;
        }
        if (record) {
            record.visualScale = 1;
            if (clearTarget) {
                record.tileRect = null;
                record.backingRect = null;
                record.scaleNegotiated = false;
            }
            this.traceWindow(w, 'reset-scale');
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
    applyWindowScale(w, actor, scale, target) {
        let pivot = {x: 0, y: 0};
        let frame = null;
        try {
            frame = w.get_frame_rect();
            const buffer = typeof w.get_buffer_rect === 'function' ? w.get_buffer_rect() : frame;
            pivot = frameScalePivot(frame, buffer, actor.get_width?.(), actor.get_height?.());
        } catch { /* fall back to the actor origin */ }
        actor.set_pivot_point(pivot.x, pivot.y);
        actor.set_scale(scale, scale);
        // Mutter keeps an oversized backing window inside the work area, so a
        // right/bottom tile request can be clamped before compositor scaling.
        // Translate the scaled actor from the committed frame to its visual slot.
        actor.translation_x = frame && target ? target.x - frame.x : 0;
        actor.translation_y = frame && target ? target.y - frame.y : 0;
    }
    correctWindowScale(w) {
        const record = this.records.get(w), actor = this.windowActor(w);
        if (!record?.tileRect || !actor || record.floating || w.minimized || w.fullscreen || w.get_maximize_flags()) return;
        if (!this.running || this.busy || record.placing || this.drag || global.display.is_grabbed()) return;
        if (this.windowEffectActive(actor)) return; // effects-completed resumes us
        if (record.restorePending && !record.restoreStarted) return;
        const frame = w.get_frame_rect(), target = record.tileRect;
        // One measured-size negotiation per explicit placement. A committed frame
        // is an observation, not a new minimum constraint. Feeding each reply back
        // into fitMinimumSize creates a configure/commit feedback loop.
        if (!record.scaleNegotiated) {
            const fitted = fitMinimumSize(target, frame.width, frame.height);
            // A normal-sized observation does not consume the one fallback:
            // minimum constraints may only surface in a later client commit.
            record.scaleNegotiated = fitted.scale < 0.999; // before requesting
            record.backingRect = {...fitted.frame};
            if (fitted.scale < 0.999 &&
                (Math.abs(frame.width - fitted.frame.width) > 1 ||
                 Math.abs(frame.height - fitted.frame.height) > 1)) {
                this.requestWindowGeometry(w, 'backing-fit', fitted.frame);
                this.scheduleWindowScale(w, 120);
                return;
            }
        }
        // Ordinary client commits may move a window after its initial configure.
        // Repair position without renegotiating size, with a finite per-placement budget.
        if (!record.restorePending && record.monitor === w.get_monitor() &&
            record.placementMoves + record.restoreMoves < MAX_RESTORE_MOVES &&
            (Math.abs(frame.x - target.x) > 1 || Math.abs(frame.y - target.y) > 1)) {
            record.placementMoves++;
            this.requestWindowGeometry(w, 'tile-position', target, true);
        }
        const actual = w.get_frame_rect();
        const scale = Math.max(0.05, Math.min(1,
            target.width / Math.max(1, actual.width), target.height / Math.max(1, actual.height)));
        this.applyWindowScale(w, actor, scale, target);
        record.visualScale = scale;
        this.traceWindow(w, 'apply-scale');
    }
    scheduleWindowScale(w, delay = 90) {
        const record = this.records.get(w);
        if (!record) return;
        this.cancel(record.scaleTimer);
        record.scaleTimer = this.later(delay, () => {
            if (!this.records.has(w)) return;
            record.scaleTimer = 0;
            this.correctWindowScale(w);
        });
    }
    validateTransformsAfterGrab() {
        // Mutter can finish a grab after the geometry signals and leave an old
        // actor transform behind. Recheck after its short and long effects settle.
        for (const delay of [180, 650, 1400]) this.later(delay, () => {
            if (!this.running || this.drag || global.display.is_grabbed()) return;
            for (const [w, record] of this.records) {
                if (record.tileRect && !record.floating && !w.minimized && !this.isSpecialWindow(w))
                    this.scheduleWindowScale(w, 0);
            }
        });
    }
    place(w, rect, restoring = false, force = false) {
        if (!rect || this.isSpecialWindow(w)) return;
        this.watchWindowEffects(w);
        const actor = this.windowActor(w), record = this.records.get(w);
        if (!record) return;
        const reusable = !force && !restoring && !record.restorePending && !record.specialState &&
            record.tileRect && record.backingRect &&
            ['x', 'y', 'width', 'height'].every(key => Math.abs(record.tileRect[key] - rect[key]) <= 1);
        if (!restoring) {
            record.placementMoves = 0;
            record.restoreMoves = 0;
            // Explicit arrangement (including a manual drop) owns a new target.
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            record.restorePending = false;
            record.restoreUntil = 0;
            record.restoreQuietUntil = 0;
        }
        if (reusable) {
            if (actor) this.scheduleWindowScale(w, 0);
            return;
        }
        const movingSameSize = !force && !restoring && !record.restorePending &&
            record.tileRect && record.backingRect && record.visualScale < 0.999 &&
            Math.abs(record.tileRect.width - rect.width) <= 1 &&
            Math.abs(record.tileRect.height - rect.height) <= 1;
        if (movingSameSize) {
            record.tileRect = {...rect};
            record.backingRect = {...record.backingRect, x: rect.x, y: rect.y};
            record.scaleNegotiated = true;
            if (actor) this.applyWindowScale(w, actor, record.visualScale, rect);
            this.requestWindowGeometry(w, 'place', record.backingRect);
            if (actor) this.scheduleWindowScale(w);
            return;
        }
        const previousBacking = restoring ? record.backingRect : null;
        this.resetWindowScale(w);
        const minimum = actor ? this.minimumSize(w) : {width: 0, height: 0};
        // Keep a stable application viewport while the tile grid changes. This
        // makes the compositor scale dynamic without letting the client reflow
        // its entire interface at every slot size.
        if (record.original) {
            minimum.width = Math.max(minimum.width, record.original.width);
            minimum.height = Math.max(minimum.height, record.original.height);
        }
        const fitted = fitMinimumSize(rect, minimum.width, minimum.height);
        // Publish the target and transaction state before move_resize_frame can
        // emit signals. Restores preserve the previous backing-size decision.
        record.tileRect = {...rect};
        record.backingRect = previousBacking ? {...previousBacking, x: rect.x, y: rect.y} : {...fitted.frame};
        record.scaleNegotiated = restoring && Boolean(previousBacking);
        this.requestWindowGeometry(w, restoring ? 'restore' : 'place', record.backingRect);
        if (actor) this.scheduleWindowScale(w);
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
    focusChanged() {
        if (this.drag && !global.display.is_grabbed()) this.grabEnd();
        else this.updateBorder();
    }

    toggleFloating() {
        const w = global.display.focus_window, record = this.records.get(w);
        if (!record || !this.running) return;
        this.checkpoint(); record.floating = !record.floating;
        if (record.floating && record.original) {
            this.busy = true;
            try { this.restore(w, {...record.original, minimized: false}); } finally { this.busy = false; }
        }
        this.tile(true);
        this.validateTransformsAfterGrab();
    }

    toggleSwap() {
        if (this.swapMode) { this.exitSwap(true); return; }
        const w = global.display.focus_window, record = this.records.get(w);
        if (!this.running || !record || record.floating || w.minimized || w.fullscreen || w.get_maximize_flags()) return;
        const key = this.key(w.get_monitor());
        const slots = this.groups.get(key) ?? [];
        if (!slots.includes(w) || slots.filter(Boolean).length < 2) return;

        this.swapMode = true;
        this.swapWindow = w;
        this.swapKey = key;
        this.swapOriginal = [...slots];
        this.swapHistory = [...this.history];
        this.swapChanged = false;
        this.swapActor = new St.Widget({reactive: true, can_focus: true, width: 1, height: 1});
        Main.uiGroup.add_child(this.swapActor);
        this.swapGrab = Main.pushModal(this.swapActor, {actionMode: Shell.ActionMode.NORMAL});
        this.swapActor.grab_key_focus();
        this.swapActor.connect('key-press-event', (_a, e) => {
            const keySymbol = e.get_key_symbol();
            if (keySymbol === Clutter.KEY_Escape) {
                this.exitSwap(false);
                return Clutter.EVENT_STOP;
            }
            if (keySymbol === Clutter.KEY_Return || keySymbol === Clutter.KEY_KP_Enter) {
                this.exitSwap(true);
                return Clutter.EVENT_STOP;
            }
            const direction = new Map([[Clutter.KEY_Left, 'left'], [Clutter.KEY_Right, 'right'],
                [Clutter.KEY_Up, 'up'], [Clutter.KEY_Down, 'down']]).get(keySymbol);
            if (direction) this.swapDirection(direction);
            return Clutter.EVENT_STOP;
        });
        this.updateBorder();
    }
    exitSwap(commit = true) {
        if (!commit && this.swapMode && this.swapChanged && this.swapKey) {
            const original = (this.swapOriginal ?? []).map(w => w && this.records.has(w) ? w : null);
            this.groups.set(this.swapKey, original);
            this.history = this.swapHistory ?? this.history;
            this.tile(false);
        }
        if (this.swapGrab) Main.popModal(this.swapGrab);
        this.swapGrab = null;
        this.swapActor?.destroy();
        this.swapActor = null;
        this.swapMode = false;
        this.swapWindow = null;
        this.swapKey = null;
        this.swapOriginal = null;
        this.swapHistory = null;
        this.swapChanged = false;
        this.updateBorder();
    }
    swapDirection(direction) {
        const w = this.swapWindow;
        if (!this.records.has(w) || !this.swapKey) { this.exitSwap(false); return; }
        const slots = this.groups.get(this.swapKey) ?? [];
        const from = slots.indexOf(w);
        if (from < 0) { this.exitSwap(false); return; }
        const rects = layout(this.area(w.get_monitor()), slots.length, this.options(w.get_monitor()));
        const to = directionalSlot(rects, from, direction);
        if (to < 0) return;
        if (!this.swapChanged) {
            this.checkpoint();
            this.swapChanged = true;
        }
        [slots[from], slots[to]] = [slots[to], slots[from]];
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
        const record = this.records.get(w);
        this.cancel(record.restoreTimer); record.restoreTimer = 0;
        this.cancel(record.settleTimer); record.settleTimer = 0;
        record.restorePending = false;
        this.traceWindow(w, 'grab-begin');
        this.drag = {window: w, monitor: w.get_monitor(), target: null,
            checkpoint: this.captureCheckpoint()};
        this.border.hide();
        const tick = () => {
            if (!this.drag) return;
            if (!global.display.is_grabbed()) {
                this.grabEnd();
                return;
            }
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
        const {window: w, target, monitor: source, checkpoint} = this.drag;
        this.drag = null; this.preview.hide();
        if (!this.records.has(w)) return;
        if (target) {
            const key = this.key(target.monitor);
            const slots = [...(this.groups.get(key) ?? this.windows(target.monitor))];
            if (source === target.monitor) {
                const from = slots.indexOf(w);
                if (from === target.index) {
                    this.place(w, this.records.get(w).tileRect);
                    this.updateBorder();
                    return;
                }
                if (from >= 0) {
                    this.pushCheckpoint(checkpoint);
                    [slots[from], slots[target.index]] = [slots[target.index], slots[from]];
                }
            } else {
                this.pushCheckpoint(checkpoint);
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
        this.exitSwap(false);
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
        for (const [w, r] of this.records) {
            this.stopWindowTrace(r);
            this.disconnectWindowEffects(r);
            for (const id of r.signals) w.disconnect(id);
        }
        this.records.clear();
        Main.layoutManager.removeChrome(this.border); this.border.destroy();
        Main.layoutManager.removeChrome(this.preview); this.preview.destroy();
        this.indicator.destroy();
        this.settings = null;
    }
}
