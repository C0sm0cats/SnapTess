import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {layout, PRESETS, capacity, fitMinimumSize, frameScalePivot, nearestSlot, directionalSlot, reconcileSlots,
    activePinnedSlots, reserveAppSlots} from './lib/layout.js';
import {Studio} from './lib/studio.js';
import {WindowBorder} from './lib/window-border.js';
import {radiusFromPixels, radiusStyle, visualFrameRect} from './lib/window-radius.js';

const RUNTIME_REVISION = 32;
const RESTORE_STABILIZE_MS = 1400;
const RESTORE_QUIET_MS = 120;
const MAX_RESTORE_MOVES = 8;
const MAX_SIZE_REPAIRS = 2;
const SIZE_REJECTION_GRACE_MS = 1800;
const SIZE_MISMATCH_STABLE_MS = 600;

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
        this.radiusReadbackReady = false;
        this.drag = null;
        this.swapMode = false;
        this.loadProfiles();
        this.loadSavedLayouts();
        this.deletedLayouts = [];
        this.pendingLayoutApps = new Map();
        this.indicator = new PanelMenu.Button(0.0, 'SnapTess');
        this.icon = new Gio.FileIcon({file: this.dir.get_child('icons/snaptess-symbolic.svg')});
        this.indicator.add_child(new St.Icon({gicon: this.icon, style_class: 'system-status-icon'}));
        Main.panel.addToStatusArea(this.uuid, this.indicator);
        this.statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'snaptess-panel-status'});
        this.indicator.menu.addMenuItem(this.statusItem);
        this.switchItem = new PopupMenu.PopupSwitchMenuItem('Arrange windows', false);
        this.switchItem.connect('toggled', (_item, value) => this.setRunning(value));
        this.indicator.menu.addMenuItem(this.switchItem);
        this.studioItem = this.indicator.menu.addAction('Layout Studio…', () => this.openStudio());
        this.arrangeItem = this.indicator.menu.addAction('Arrange again', () => { this.checkpoint(); this.tile(true); });
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.floatItem = this.indicator.menu.addAction('Float / tile focused window', () => this.toggleFloating());
        this.swapItem = this.indicator.menu.addAction('Swap mode · arrows · Enter accept · Esc cancel', () => this.toggleSwap());
        this.undoItem = this.indicator.menu.addAction('Undo last arrangement', () => this.undo());
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.spaceMenu = new PopupMenu.PopupSubMenuMenuItem('Monitor spaces');
        for (let i = 0; i < 3; i++)
            this.spaceMenu.menu.addAction(`Space ${i + 1}`, () => this.switchSpace(i));
        this.indicator.menu.addMenuItem(this.spaceMenu);
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.indicator.menu.addAction('Preferences', () => this.openPreferences());
        this.stopItem = this.indicator.menu.addAction('Stop and restore windows', () => this.setRunning(false));
        this.indicator.menu.connect('open-state-changed', (_menu, open) => { if (open) this.updateMenuSensitivity(); });
        this.border = new WindowBorder();
        this.preview = new St.Widget({
            style_class: 'snaptess-preview',
            style: 'background-color: transparent; background-image: none; border: 2px solid #8ce8c3; border-radius: 16px;',
            reactive: false,
            visible: false,
        });
        this.previewLabel = new St.Label({style_class: 'snaptess-preview-label', reactive: false, visible: false});
        this.swapFromGuide = new St.Widget({style_class: 'snaptess-swap-guide source', reactive: false, visible: false});
        this.swapToGuide = new St.Widget({style_class: 'snaptess-swap-guide target', reactive: false, visible: false});
        this.swapArrow = new St.Label({style_class: 'snaptess-swap-arrow', reactive: false, visible: false});
        this.windowActions = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-window-actions', reactive: true, visible: false, width: 44, height: 176});
        this.windowActionTooltip = new St.Label({style_class: 'snaptess-window-action-tooltip',
            reactive: false, visible: false});
        this.windowActionHandle = new St.Button({style_class: 'snaptess-window-action-handle',
            accessible_name: 'Show window actions', reactive: true, can_focus: true,
            visible: false, width: 12, height: 48});
        this.windowActionHandle.connect('enter-event', () => this.showWindowActions());
        this.windowActionHandle.connect('clicked', () => this.showWindowActions());
        const actionButton = (name, icon, callback, style = '') => {
            const actor = new St.Button({style_class: `snaptess-window-action ${style}`.trim(),
                accessible_name: name, can_focus: true, reactive: true, width: 36, height: 36,
                child: new St.Icon({icon_name: icon, icon_size: 17})});
            actor.connect('clicked', callback);
            actor._snaptessTooltip = name;
            actor.connect('enter-event', () => this.showWindowActionTooltip(actor));
            actor.connect('leave-event', () => this.windowActionTooltip.hide());
            this.windowActions.add_child(actor);
            return actor;
        };
        this.floatAction = actionButton('Float or tile window', 'window-pop-out-symbolic', () => {
            this.toggleFloating();
        });
        this.minimizeAction = actionButton('Minimize window', 'window-minimize-symbolic', () => {
            const w = global.display.focus_window;
            if (this.records.has(w)) w.minimize();
            this.hideWindowActions();
        });
        this.maximizeAction = actionButton('Maximize or restore window', 'window-maximize-symbolic', () => {
            const w = global.display.focus_window;
            if (!this.records.has(w)) return;
            if (w.get_maximize_flags()) w.unmaximize(); else w.maximize();
            this.hideWindowActions();
            if (global.display.focus_window === w) this.queueWindowActions(w, 180);
        });
        this.closeAction = actionButton('Close window', 'window-close-symbolic', () => {
            const w = global.display.focus_window;
            if (this.records.has(w)) w.delete(global.get_current_time());
            this.hideWindowActions();
        }, 'danger');
        this.windowActions.connect('enter-event', () => { this.cancel(this.actionsTimer); this.actionsTimer = 0; });
        this.windowActions.connect('leave-event', () => this.scheduleWindowActionsHide(350));
        // Keep the focus outline with window content. Shell chrome (panel,
        // Dash-to-Dock, OSDs) must always paint above it.
        global.window_group.add_child(this.border);
        global.window_group.add_child(this.windowActionHandle);
        global.window_group.add_child(this.windowActions);
        global.window_group.add_child(this.windowActionTooltip);
        this.motionGuides = new Set();
        this.spaceTransitions = new Set();
        this.dragSourceGuide = new St.Widget({style_class: 'snaptess-drag-zone source', reactive: false, visible: false});
        this.dragTargetGuide = new St.Widget({style_class: 'snaptess-drag-zone target', reactive: false, visible: false});
        this.dragFlow = new St.BoxLayout({style_class: 'snaptess-drag-flow', reactive: false, visible: false});
        Main.layoutManager.addChrome(this.preview);
        Main.layoutManager.addChrome(this.previewLabel);
        Main.layoutManager.addChrome(this.swapFromGuide);
        Main.layoutManager.addChrome(this.swapToGuide);
        Main.layoutManager.addChrome(this.swapArrow);
        Main.layoutManager.addChrome(this.dragSourceGuide);
        Main.layoutManager.addChrome(this.dragTargetGuide);
        Main.layoutManager.addChrome(this.dragFlow);
        try {
            this.interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this.connect(this.interfaceSettings, 'changed::accent-color', () => this.updateBorder());
        } catch { this.interfaceSettings = null; }
        try {
            this.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => {
                for (const w of this.records.keys()) this.invalidateWindowRadius(w);
                this.updateBorder();
            });
        } catch { /* theme context may not expose a change signal */ }
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
            for (const delay of [160, 500, 1200]) this.later(delay, () => {
                if (!this.records.has(w)) return;
                if (!this.claimLayoutWindow(w)) this.schedule(true);
            });
        });
        this.connect(global.display, 'notify::focus-window', () => this.focusChanged());
        this.connect(global.display, 'restacked', () => this.windowsRestacked());
        this.connect(global.stage, 'captured-event', (_stage, event) => {
            if (event.type() !== Clutter.EventType.MOTION || this.windowActions.visible) return Clutter.EVENT_PROPAGATE;
            const w = global.display.focus_window, record = this.records.get(w);
            if (!this.running || !record || this.drag || this.studio || Main.overview.visible || w.minimized ||
                w.fullscreen)
                return Clutter.EVENT_PROPAGATE;
            const rect = this.windowActionsRect(w, record);
            const [x, y] = event.get_coords();
            if (x >= rect.x + rect.width - 48 && x <= rect.x + rect.width + 2 && y >= rect.y && y <= rect.y + rect.height)
                this.showWindowActions();
            return Clutter.EVENT_PROPAGATE;
        });
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
            if (key === 'saved-layouts') { this.loadSavedLayouts(); return; }
            this.schedule(true);
        });
        for (const actor of global.get_window_actors()) this.track(actor.meta_window);
        this.updatePanelStatus();
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
        // GNOME marks windows on secondary displays as spanning workspaces when
        // workspaces are primary-display-only; they are still ordinary windows.
        return w && w.get_window_type() === Meta.WindowType.NORMAL && !w.is_override_redirect() &&
            !w.skip_taskbar && (!w.is_on_all_workspaces() ||
                w.get_monitor() !== Main.layoutManager.primaryIndex);
    }

    appId(w) {
        return Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? w.get_wm_class() ?? '';
    }

    matchesAppRule(w, key) {
        const normalize = value => typeof value === 'string'
            ? value.trim().replace(/\.desktop$/i, '').toLowerCase() : '';
        const identifiers = new Set([this.appId(w), w.get_wm_class?.()].map(normalize).filter(Boolean));
        return this.settings.get_strv(key).some(value => identifiers.has(normalize(value)));
    }

    isSpecialWindow(w) {
        return Boolean(w?.fullscreen || w?.get_maximize_flags?.());
    }

    track(w) {
        if (!this.eligible(w) || this.records.has(w)) return;
        const record = {original: null, floating: false, space: this.activeSpace(w.get_monitor(), w.get_workspace()),
            parked: false, restoreParked: false, signals: [], monitor: w.get_monitor(), tileRect: null,
            visualScale: 1, scaleTimer: 0,
            backingRect: null, scaleMinimum: null, scaleNegotiated: false, placementMoves: 0, placing: false, restoreStarted: false, restoreMoves: 0,
            sizeRepairs: 0, sizeRejectUntil: 0, mismatchSize: null, mismatchSince: 0, repairResetTimer: 0,
            windowRadius: null, radiusDirty: true, radiusAttempts: 0, radiusPending: false,
            radiusTimer: 0, radiusTimerDelay: 0,
            radiusFallbackTimer: 0, radiusFallbackReady: false,
            radiusMonitor: w.get_monitor(), radiusGeneration: 0, radiusActorSignal: 0,
            borderActorSignals: [],
            traceUntil: 0, traceSignals: [], traceTimer: 0, requestSequence: 0, effectActor: null, effectSignal: 0, specialState: this.isSpecialWindow(w),
            restorePending: false, restoreTimer: 0, settleTimer: 0, restoreUntil: 0, restoreQuietUntil: 0};
        this.records.set(w, record);
        this.watchWindowEffects(w);
        const actor = this.windowActor(w);
        if (actor) {
            try { record.radiusActorSignal = actor.connect('first-frame', () => this.invalidateWindowRadius(w)); }
            catch { /* existing actors may not expose first-frame */ }
            for (const property of ['x', 'y', 'width', 'height', 'scale-x', 'scale-y',
                'translation-x', 'translation-y'])
                record.borderActorSignals.push(actor.connect(`notify::${property}`, () => {
                    if (global.display.focus_window === w) {
                        this.updateBorder(); this.updateWindowActionsPosition(w);
                    }
                }));
        }
        const watch = (signal, fn) => record.signals.push(w.connect(signal, fn));
        watch('unmanaged', () => {
            this.stopWindowTrace(record);
            this.cancel(record.scaleTimer); record.scaleTimer = 0;
            this.cancel(record.repairResetTimer); record.repairResetTimer = 0;
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            this.cancel(record.radiusTimer); record.radiusTimer = 0;
            this.cancel(record.radiusFallbackTimer); record.radiusFallbackTimer = 0;
            if (actor && record.radiusActorSignal) actor.disconnect(record.radiusActorSignal);
            if (actor) for (const id of record.borderActorSignals) actor.disconnect(id);
            this.disconnectWindowEffects(record);
            if (record.motionGuide) { this.motionGuides.delete(record.motionGuide); record.motionGuide.destroy(); }
            for (const id of record.signals) w.disconnect(id);
            this.records.delete(w);
            if (this.drag?.window === w) this.drag = null;
            if (this.swapWindow === w) this.exitSwap(false);
            this.schedule(this.settings.get_boolean('compact-close'));
        });
        watch('notify::minimized', () => {
            if (this.busy) return;
            if (record.restoreParked && !w.minimized) record.restoreParked = false;
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
            if (record.placementMoves) this.scheduleRepairBudgetReset(w);
            const monitor = w.get_monitor();
            if (!this.busy && !this.drag && !record.placing && !record.restorePending &&
                (!this.running || record.floating || !record.tileRect) && record.monitor !== monitor) {
                record.monitor = monitor;
                record.space = this.activeSpace(monitor);
                this.schedule(true);
            }
            if (record.restorePending && Date.now() >= record.restoreQuietUntil && !record.placing && !this.busy && !this.drag)
                this.queueWindowRestore(w, 80);
            if (this.running && record.tileRect && !record.floating && !record.placing && !this.busy && !this.drag)
                this.scheduleWindowScale(w);
            if (record.radiusMonitor !== monitor) this.invalidateWindowRadius(w);
            else if (record.radiusAttempts >= 3 && !record.radiusPending && !record.radiusTimer)
                this.invalidateWindowRadius(w);
            if (global.display.focus_window === w) {
                this.updateBorder(); this.updateWindowActionsPosition(w);
            }
        });
        watch('size-changed', () => {
            this.traceWindow(w, 'size-changed');
            this.invalidateWindowRadius(w);
            if (record.restorePending && Date.now() >= record.restoreQuietUntil && !record.placing && !this.busy && !this.drag)
                this.queueWindowRestore(w, 80);
            if (this.running && record.tileRect && !record.floating) this.scheduleWindowScale(w);
            if (global.display.focus_window === w) {
                this.updateBorder(); this.updateWindowActionsPosition(w);
            }
        });
        if (actor?.visible && !w.minimized)
            this.queueWindowRadius(w, Math.min(1200, 240 + (this.records.size - 1) * 80));
    }

    specialWindowChanged(w, record) {
        const special = this.isSpecialWindow(w);
        if (special) {
            if (w.fullscreen && (global.display.focus_window === w || this.actionWindow === w))
                this.hideWindowActions();
            record.specialState = true;
            record.restorePending = false;
            record.restoreUntil = 0;
            record.restoreQuietUntil = 0;
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            this.resetWindowScale(w);
            if (!w.fullscreen && global.display.focus_window === w) {
                this.updateWindowActionsPosition(w);
                if (!this.windowActions.visible && !this.windowActionHandle.visible)
                    this.queueWindowActions(w);
            }
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
            if (global.display.focus_window === w) this.queueWindowActions(w, 180);
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
        this.updateWindowActionsPosition(w);
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
            if (positionOnly) {
                w.move_frame(true, rect.x, rect.y);
            } else {
                // Match Tiling Assistant's native Wayland placement path. A user
                // operation avoids Mutter's monitor clamping; moving first also
                // handles clients that otherwise resize without changing origin.
                w.move_frame(true, rect.x, rect.y);
                w.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
            }
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
    loadSavedLayouts() {
        try {
            const layouts = JSON.parse(this.settings.get_string('saved-layouts'));
            this.savedLayouts = Array.isArray(layouts) ? layouts.filter(item =>
                typeof item?.id === 'string' && typeof item.name === 'string' &&
                PRESETS.some(([id]) => id === item.preset) &&
                Number.isInteger(item.slotCount) && item.slotCount > 0 && item.slotCount <= 30 &&
                (item.preset === 'auto' || item.slotCount <= capacity(item.preset)) &&
                Array.isArray(item.pinned) && item.pinned.length <= item.slotCount &&
                item.pinned.every(id => id === null || typeof id === 'string')) : [];
        } catch { this.savedLayouts = []; }
    }
    saveLayout(name, preset, windows, pins) {
        name = name.trim().slice(0, 60);
        if (!name || this.savedLayouts.some(layout => layout.name.toLowerCase() === name.toLowerCase())) return false;
        const slotCount = Math.max(windows.length, pins.length, capacity(preset), 1);
        if (slotCount > 30 || (preset !== 'auto' && slotCount > capacity(preset))) return false;
        const pinned = Array.from({length: slotCount}, (_, i) => windows[i]
            ? this.appId(windows[i]) || pins[i] || null : pins[i] || null);
        const id = GLib.uuid_string_random();
        this.savedLayouts.push({id, name, preset, slotCount, pinned});
        this.settings.set_string('saved-layouts', JSON.stringify(this.savedLayouts));
        this.deletedLayouts?.splice(0);
        return id;
    }
    deleteSavedLayout(id) {
        const index = this.savedLayouts.findIndex(layout => layout.id === id);
        if (index < 0) return false;
        const [layout] = this.savedLayouts.splice(index, 1);
        this.deletedLayouts.push({layout, index});
        if (this.deletedLayouts.length > 10) this.deletedLayouts.shift();
        this.settings.set_string('saved-layouts', JSON.stringify(this.savedLayouts));
        return true;
    }
    undoDeletedSavedLayout() {
        const deleted = this.deletedLayouts.pop();
        if (!deleted) return null;
        const layout = {...deleted.layout};
        if (this.savedLayouts.some(item => item.id === layout.id)) layout.id = GLib.uuid_string_random();
        if (this.savedLayouts.some(item => item.name.toLowerCase() === layout.name.toLowerCase())) {
            const base = layout.name.slice(0, 48);
            let name = `${base} (restored)`, suffix = 2;
            while (this.savedLayouts.some(item => item.name.toLowerCase() === name.toLowerCase()))
                name = `${base} (restored ${suffix++})`;
            layout.name = name;
        }
        this.savedLayouts.splice(Math.min(deleted.index, this.savedLayouts.length), 0, layout);
        this.settings.set_string('saved-layouts', JSON.stringify(this.savedLayouts));
        return layout;
    }
    layoutCandidates(monitor, space) {
        return this.windows(monitor, space, true);
    }
    savedLayoutPlan(layout, monitor, space) {
        const candidates = this.layoutCandidates(monitor, space), used = new Set();
        const normalize = id => (id ?? '').replace(/\.desktop$/i, '').toLowerCase();
        const slots = layout.pinned.map(id => {
            if (!id) return null;
            const found = candidates.find(w => !used.has(w) && normalize(this.appId(w)) === normalize(id));
            if (found) used.add(found);
            return found ?? null;
        });
        while (slots.length < layout.slotCount) slots.push(null);
        const missing = [...new Set(layout.pinned.filter((id, i) => id && !slots[i]))];
        return {slots, missing, extras: candidates.filter(w => !used.has(w) &&
            (!w.minimized || this.records.get(w)?.parked || this.records.get(w)?.restoreParked))};
    }
    restoreSavedLayout(id, monitor, space) {
        const layout = this.savedLayouts.find(item => item.id === id);
        if (!layout) return false;
        const workspace = global.workspace_manager.get_active_workspace();
        const {slots, missing, extras} = this.savedLayoutPlan(layout, monitor, space);
        this.applyProfiles([{monitor, space, preset: layout.preset, windows: slots,
            pinned: [...layout.pinned], slotCount: layout.slotCount, parkUnused: extras}], {monitor, space});
        const appSystem = Shell.AppSystem.get_default();
        const unavailable = [];
        for (const appId of missing) {
            const key = appId.toLowerCase().replace(/\.desktop$/i, '');
            if (this.pendingLayoutApps.has(key)) {
                Object.assign(this.pendingLayoutApps.get(key), {monitor, space, workspace});
                continue;
            }
            const app = appSystem.lookup_app(appId) ?? appSystem.lookup_app(`${appId}.desktop`);
            const info = app?.get_app_info?.();
            if (!info) { unavailable.push(appId); continue; }
            const pending = {monitor, space, workspace};
            this.pendingLayoutApps.set(key, pending);
            try {
                if (!info.launch([], null)) {
                    this.pendingLayoutApps.delete(key); unavailable.push(appId);
                }
            } catch (error) {
                this.pendingLayoutApps.delete(key); unavailable.push(appId);
                console.warn(`[SnapTess] Could not launch ${appId}: ${error}`);
            }
            this.later(12000, () => {
                if (this.pendingLayoutApps.get(key) !== pending) return;
                this.pendingLayoutApps.delete(key);
                Main.notify('SnapTess', `${appId} did not open a window. Its tile remains reserved.`);
            });
        }
        if (unavailable.length) Main.notify('SnapTess', `Could not open: ${unavailable.join(', ')}. Their tiles remain reserved.`);
        return true;
    }
    claimLayoutWindow(w) {
        const key = this.appId(w).toLowerCase().replace(/\.desktop$/i, '');
        const pending = this.pendingLayoutApps.get(key);
        if (!pending || w.get_workspace() !== pending.workspace || !this.eligible(w)) return false;
        this.pendingLayoutApps.delete(key);
        const r = this.records.get(w);
        r.space = pending.space; r.floating = false; r.restoreParked = false;
        if (w.get_monitor() !== pending.monitor) w.move_to_monitor(pending.monitor);
        r.parked = this.activeSpace(pending.monitor) !== pending.space;
        if (r.parked) w.minimize();
        this.schedule(true);
        return true;
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
        return [...this.records].filter(([w, r]) => this.eligible(w) && w.get_monitor() === monitor &&
            w.get_workspace() === workspace && r.space === space && !r.floating &&
            !this.matchesAppRule(w, 'excluded-apps') && (includeMinimized || !w.minimized)).map(([w]) => w);
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
            records: new Map([...this.records].map(([w, r]) => [w, {floating: r.floating, space: r.space,
                parked: r.parked, restoreParked: r.restoreParked}])),
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

    setRunning(value, silent = false) {
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
                    if (r.parked || r.restoreParked) { w.unminimize(); r.parked = false; r.restoreParked = false; }
                    if (r.original) this.restore(w, r.original);
                    r.scaleMinimum = null;
                    r.original = null; r.space = 0;
                }
            } finally { this.busy = false; }
            this.groups.clear(); this.spaces.clear(); this.history = [];
        }
        this.updatePanelStatus();
    }

    schedule(compact) {
        if (!this.running || this.busy) return;
        this.pendingCompact ||= compact;
        this.cancel(this.pending);
        this.pending = this.later(110, () => {
            this.pending = 0;
            const value = this.pendingCompact; this.pendingCompact = false;
            this.tile(value, false, false);
        });
    }

    tile(compact = true, releaseMaximized = false, motionGuides = true) {
        if (!this.running || this.busy || this.drag) return;
        this.busy = true;
        try {
            for (let monitor = 0; monitor < Main.layoutManager.monitors.length; monitor++) {
                const windows = this.windows(monitor);
                if (!releaseMaximized && windows.some(w => w.fullscreen || w.get_maximize_flags())) continue;
                const key = this.key(monitor);
                const existingGroup = this.groups.get(key);
                let previous = existingGroup;
                if (!previous) {
                    const order = this.profiles[this.profileKey(monitor)]?.apps ?? [];
                    previous = [...windows].sort((a, b) => {
                        const rank = w => { const i = order.indexOf(this.appId(w)); return i < 0 ? 999 : i; };
                        return rank(a) - rank(b);
                    });
                }
                const profile = this.profiles[this.profileKey(monitor)];
                const savedPins = profile?.pinned;
                // An explicit drag/swap may temporarily move a live pinned window.
                // Reserve its saved slot again only when that window is absent or reopens.
                const pinned = activePinnedSlots(existingGroup, windows, savedPins, w => this.appId(w));
                const slots = reserveAppSlots(reconcileSlots(previous, windows, compact), pinned,
                    w => this.appId(w), compact);
                if (profile?.slotCount) {
                    while (slots.length < profile.slotCount) slots.push(null);
                }
                this.groups.set(key, slots);
                const rects = layout(this.area(monitor), slots.length, this.options(monitor));
                slots.forEach((w, i) => {
                    if (!w || w.fullscreen) return;
                    const record = this.records.get(w);
                    record.original ??= this.snapshot(w);
                    if (releaseMaximized) w.unmaximize();
                    this.place(w, rects[i], false, false, motionGuides);
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
                if (!record.windowRadius && global.display.focus_window === w) this.invalidateWindowRadius(w);
                if (global.display.focus_window === w) {
                    this.updateBorder(); this.updateWindowActionsPosition(w);
                }
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
    scalesApp(w) {
        return this.matchesAppRule(w, 'scaled-apps');
    }
    scheduleRepairBudgetReset(w) {
        const record = this.records.get(w);
        if (!record) return;
        this.cancel(record.repairResetTimer);
        record.repairResetTimer = this.later(RESTORE_STABILIZE_MS, () => {
            record.repairResetTimer = 0;
            record.placementMoves = 0;
        });
    }
    minimumSize(w) {
        if (typeof w.get_min_size !== 'function') return {width: 0, height: 0};
        try {
            const [known, width, height] = w.get_min_size();
            return known ? {width: Math.max(0, width), height: Math.max(0, height)} : {width: 0, height: 0};
        } catch { return {width: 0, height: 0}; }
    }
    applyWindowScale(w, actor, scale, target) {
        const frame = w.get_frame_rect();
        const buffer = typeof w.get_buffer_rect === 'function' ? w.get_buffer_rect() : frame;
        const pivot = frameScalePivot(frame, buffer, actor.get_width?.(), actor.get_height?.());
        actor.set_pivot_point(pivot.x, pivot.y);
        actor.set_scale(scale, scale);
        actor.translation_x = target.x - frame.x;
        actor.translation_y = target.y - frame.y;
    }
    correctWindowScale(w) {
        const record = this.records.get(w), actor = this.windowActor(w);
        if (!record?.tileRect || !actor || record.floating || w.minimized || w.fullscreen || w.get_maximize_flags()) return;
        if (!this.running || this.busy || record.placing || this.drag || global.display.is_grabbed()) return;
        if (this.windowEffectActive(actor)) return; // effects-completed resumes us
        if (record.restorePending && !record.restoreStarted) return;
        const frame = w.get_frame_rect(), target = record.tileRect;
        const scaled = this.scalesApp(w);
        if (scaled && !record.scaleNegotiated) {
            const reported = this.scalesApp(w) ? this.minimumSize(w) : null;
            if (reported?.width || reported?.height) record.scaleMinimum = reported;
            else record.scaleMinimum ??= {width: frame.width, height: frame.height};
            const fitted = fitMinimumSize(target, record.scaleMinimum.width, record.scaleMinimum.height);
            record.scaleNegotiated = fitted.scale < 0.999;
            record.backingRect = {...fitted.frame};
            if (fitted.scale < 0.999 &&
                (Math.abs(frame.width - fitted.frame.width) > 1 || Math.abs(frame.height - fitted.frame.height) > 1)) {
                this.requestWindowGeometry(w, 'backing-fit', fitted.frame);
                this.scheduleWindowScale(w, 120);
                return;
            }
        }
        // Ordinary client commits may move a window after its initial configure.
        // Repair position without renegotiating size, with a finite per-placement budget.
        if (!record.restorePending && record.restoreMoves < MAX_RESTORE_MOVES &&
            record.placementMoves < MAX_RESTORE_MOVES &&
            (Math.abs(frame.x - target.x) > 1 || Math.abs(frame.y - target.y) > 1)) {
            record.placementMoves++;
            this.requestWindowGeometry(w, 'tile-position', target, true);
            this.scheduleRepairBudgetReset(w);
        }
        const actual = w.get_frame_rect();
        const sizeMismatch = Math.abs(actual.width - record.backingRect.width) > 1 ||
            Math.abs(actual.height - record.backingRect.height) > 1;
        if (!record.restorePending && !scaled && sizeMismatch) {
            const size = `${actual.width}:${actual.height}`;
            if (record.mismatchSize !== size) {
                record.mismatchSize = size;
                record.mismatchSince = Date.now();
            }
            if (record.sizeRepairs < MAX_SIZE_REPAIRS) {
                record.sizeRepairs++;
                this.requestWindowGeometry(w, 'tile-size', record.backingRect);
                this.scheduleWindowScale(w, record.sizeRepairs === 1 ? 400 : 120);
                return;
            }
            if (Date.now() < record.sizeRejectUntil ||
                Date.now() - record.mismatchSince < SIZE_MISMATCH_STABLE_MS) {
                this.scheduleWindowScale(w, 250);
                return;
            }
            // An unlisted client rejected its tile. Leave it native-sized and
            // float it rather than silently enabling compositor scaling.
            record.floating = true;
            this.resetWindowScale(w, true);
            if (record.original) {
                this.busy = true;
                try { this.restore(w, {...record.original, minimized: false}); }
                finally { this.busy = false; }
            }
            this.schedule(true);
            return;
        }
        if (!sizeMismatch) { record.mismatchSize = null; record.mismatchSince = 0; }
        if (scaled) {
            const scale = Math.max(0.05, Math.min(1,
                target.width / Math.max(1, actual.width), target.height / Math.max(1, actual.height)));
            this.applyWindowScale(w, actor, scale, target);
            record.visualScale = scale;
            this.traceWindow(w, 'apply-exception-scale');
        } else {
            actor.set_pivot_point(0, 0);
            actor.set_scale(1, 1);
            actor.translation_x = 0;
            actor.translation_y = 0;
            record.visualScale = 1;
            this.traceWindow(w, 'enforce-native-scale');
        }
        if (global.display.focus_window === w) this.updateBorder();
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
    place(w, rect, restoring = false, force = false, motionGuides = true) {
        if (!rect || this.isSpecialWindow(w)) return;
        this.watchWindowEffects(w);
        const actor = this.windowActor(w), record = this.records.get(w);
        if (!record) return;
        const previousTile = record.tileRect ? {...record.tileRect} : null;
        const reusable = !force && !restoring && !record.restorePending && !record.specialState &&
            record.tileRect && record.backingRect &&
            ['x', 'y', 'width', 'height'].every(key => Math.abs(record.tileRect[key] - rect[key]) <= 1);
        if (!restoring) {
            record.placementMoves = 0;
            record.restoreMoves = 0;
            record.sizeRepairs = 0;
            record.sizeRejectUntil = Date.now() + SIZE_REJECTION_GRACE_MS;
            record.mismatchSize = null;
            record.mismatchSince = 0;
            this.cancel(record.repairResetTimer); record.repairResetTimer = 0;
            // Explicit arrangement (including a manual drop) owns a new target.
            this.cancel(record.restoreTimer); record.restoreTimer = 0;
            this.cancel(record.settleTimer); record.settleTimer = 0;
            record.restorePending = false;
            record.restoreUntil = 0;
            record.restoreQuietUntil = 0;
        }
        if (reusable) {
            if (actor) {
                if (this.scalesApp(w) && record.visualScale < 0.999)
                    this.applyWindowScale(w, actor, record.visualScale, rect);
                this.scheduleWindowScale(w, 0);
            }
            return;
        }
        if (motionGuides && !restoring && previousTile) this.animatePlacement(w, previousTile, rect);
        const scaled = this.scalesApp(w);
        const preserveScale = scaled && actor && record.visualScale < 0.999;
        if (!preserveScale) this.resetWindowScale(w);
        record.tileRect = {...rect};
        const configuredMinimum = this.scalesApp(w) ? this.minimumSize(w) : null;
        const minimum = configuredMinimum?.width || configuredMinimum?.height
            ? configuredMinimum : record.scaleMinimum ?? {width: 0, height: 0};
        const fitted = scaled ? fitMinimumSize(rect, minimum.width, minimum.height) : {frame: rect, scale: 1};
        record.backingRect = {...fitted.frame};
        record.scaleNegotiated = !scaled;
        const currentFrame = w.get_frame_rect();
        const interimScale = preserveScale ? Math.max(0.05, Math.min(fitted.scale,
            rect.width / Math.max(1, currentFrame.width), rect.height / Math.max(1, currentFrame.height))) : 1;
        if (preserveScale) {
            this.applyWindowScale(w, actor, interimScale, rect);
            record.visualScale = interimScale;
        }
        const sameBackingSize = preserveScale &&
            Math.abs(currentFrame.width - record.backingRect.width) <= 1 &&
            Math.abs(currentFrame.height - record.backingRect.height) <= 1;
        this.requestWindowGeometry(w, restoring ? 'restore' : 'place', record.backingRect, sameBackingSize);
        if (preserveScale) this.applyWindowScale(w, actor, interimScale, rect);
        if (actor) this.scheduleWindowScale(w);
    }
    accentColor() {
        const colors = {blue: '#62a0ea', teal: '#5bc8af', green: '#57e389', yellow: '#f8e45c',
            orange: '#ffbe6f', red: '#ed333b', pink: '#f66151', purple: '#c061cb', slate: '#99c1f1'};
        try { return colors[this.interfaceSettings?.get_string('accent-color')] ?? '#8ce8c3'; }
        catch { return '#8ce8c3'; }
    }
    updateMenuSensitivity() {
        const w = global.display.focus_window, record = this.records.get(w);
        const usable = Boolean(this.running && record && !w.minimized && !this.isSpecialWindow(w));
        this.arrangeItem?.setSensitive(this.running);
        this.floatItem?.setSensitive(usable);
        const slots = usable && !record.floating ? this.groups.get(this.key(w.get_monitor())) ?? [] : [];
        this.swapItem?.setSensitive(slots.filter(Boolean).length > 1);
        this.undoItem?.setSensitive(this.running && this.history.length > 0);
        this.spaceMenu?.setSensitive(this.running);
        this.stopItem?.setSensitive(this.running);
    }
    updatePanelStatus() {
        if (!this.statusItem) return;
        const monitor = this.currentMonitor(), space = this.activeSpace(monitor);
        const preset = this.options(monitor, space).preset;
        this.statusItem.label.text = `${this.running ? 'Active' : 'Paused'}  ·  ${preset}  ·  Space ${space + 1}`;
        this.updateMenuSensitivity();
    }
    hideSwapGuides() {
        this.cancel(this.swapGuideTimer); this.swapGuideTimer = 0;
        this.swapFromGuide.hide(); this.swapToGuide.hide(); this.swapArrow.hide();
        this.swapFromWindow = null; this.swapToWindow = null;
    }
    hideGuides() {
        this.border.hide(); this.preview.hide(); this.previewLabel.hide(); this.hideSwapGuides();
        this.previewWindow = null;
        this.hideDragGuides(); this.hideWindowActions();
    }
    showSwapGuides(from, to, direction, sourceWindow = null, targetWindow = null) {
        this.hideSwapGuides();
        this.showRect(this.swapFromGuide, from); this.showRect(this.swapToGuide, to);
        this.swapFromWindow = sourceWindow; this.swapToWindow = targetWindow;
        this.setGuideRadius(this.swapFromGuide, sourceWindow, 14);
        this.setGuideRadius(this.swapToGuide, targetWindow, 14);
        const arrows = {left: '←', right: '→', up: '↑', down: '↓'};
        this.swapArrow.text = arrows[direction] ?? '↔';
        this.swapArrow.set_position(Math.round((from.x + from.width / 2 + to.x + to.width / 2) / 2 - 18),
            Math.round((from.y + from.height / 2 + to.y + to.height / 2) / 2 - 18));
        this.swapArrow.show();
        if (this.settings.get_boolean('animations')) {
            this.swapArrow.set_scale(0.7, 0.7);
            this.swapArrow.ease({scale_x: 1.15, scale_y: 1.15, duration: 130,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this.swapGuideTimer = this.later(420, () => {
            this.swapGuideTimer = 0;
            for (const actor of [this.swapFromGuide, this.swapToGuide, this.swapArrow]) {
                if (this.settings.get_boolean('animations'))
                    actor.ease({opacity: 0, duration: 140, onComplete: () => { actor.hide(); actor.opacity = 255; }});
                else actor.hide();
            }
        });
    }
    showRect(actor, rect) {
        const appearing = !actor.visible;
        actor.set_position(rect.x, rect.y); actor.set_size(rect.width, rect.height); actor.show();
        if (appearing && this.settings.get_boolean('animations')) {
            actor.opacity = 0;
            actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (appearing) actor.opacity = 255;
    }
    invalidateWindowRadius(w) {
        const record = this.records.get(w);
        if (!record) return;
        const hadRadius = Boolean(record.windowRadius);
        this.cancel(record.radiusTimer); record.radiusTimer = 0;
        record.radiusGeneration++;
        record.radiusDirty = true;
        // Keep failed attempts across repeated geometry notifications, or a
        // client that never yields pixels can postpone the fallback forever.
        if (hadRadius) {
            record.radiusAttempts = 0;
            record.radiusFallbackReady = false;
            this.cancel(record.radiusFallbackTimer); record.radiusFallbackTimer = 0;
        }
        record.radiusPending = false;
        record.radiusMonitor = w.get_monitor();
        if (this.running && !w.minimized && global.display.focus_window !== w)
            this.queueWindowRadius(w, hadRadius ? 120 : 240);
        if (this.running && global.display.focus_window === w) this.updateBorder();
    }
    queueWindowRadius(w, delay = 0) {
        const record = this.records.get(w);
        if (!record || !record.radiusDirty || record.radiusPending || record.radiusAttempts >= 3) return;
        if (record.radiusTimer) {
            if (record.radiusTimerDelay <= delay) return;
            this.cancel(record.radiusTimer);
            record.radiusTimer = 0;
        }
        const generation = record.radiusGeneration;
        record.radiusTimerDelay = delay;
        record.radiusTimer = this.later(delay, () => {
            record.radiusTimer = 0;
            if (this.records.get(w) !== record || generation !== record.radiusGeneration) return;
            record.radiusPending = true;
            record.radiusAttempts++;
            this.measureWindowRadius(w).then(radius => {
                if (this.records.get(w) !== record || generation !== record.radiusGeneration) return;
                record.radiusPending = false;
                if (radius) {
                    record.windowRadius = radius;
                    record.radiusDirty = false;
                    this.cancel(record.radiusFallbackTimer); record.radiusFallbackTimer = 0;
                    record.radiusFallbackReady = false;
                    this.updateBorder();
                    for (const [guide, window, fallback] of [
                        [this.swapFromGuide, this.swapFromWindow, 14],
                        [this.swapToGuide, this.swapToWindow, 14],
                        [this.dragSourceGuide, this.dragSourceWindow, 14],
                        [this.dragTargetGuide, this.dragTargetWindow, 14],
                        [this.preview, this.previewWindow, 16],
                    ]) if (window === w && guide.visible) this.setGuideRadius(guide, w, fallback);
                } else {
                    this.queueWindowRadius(w, 500);
                    if (record.radiusAttempts >= 3) this.updateBorder();
                }
            }).catch(error => {
                if (this.records.get(w) !== record || generation !== record.radiusGeneration) return;
                record.radiusPending = false;
                console.debug(`[SnapTess] window radius fallback: ${error.message ?? error}`);
                this.queueWindowRadius(w, 500);
                if (record.radiusAttempts >= 3) this.updateBorder();
            });
        });
    }
    async measureWindowRadius(w) {
        const actor = this.windowActor(w), frame = this.visualWindowRect(w);
        if (!actor?.visible || frame.width < 3 || frame.height < 2 || this.windowEffectActive(actor)) return null;
        const width = Math.min(256, Math.max(3, Math.floor(frame.width / 2)));
        const height = Math.round(frame.height);
        const content = actor.paint_to_content(new Mtk.Rectangle({
            x: Math.round(frame.x), y: Math.round(frame.y), width, height,
        }));
        const texture = content?.get_texture?.();
        if (!texture) return null;
        if (!this.radiusReadbackReady) {
            Gio._promisify(Shell.Screenshot, 'composite_to_stream');
            this.radiusReadbackReady = true;
        }
        const stream = Gio.MemoryOutputStream.new_resizable();
        try {
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture, 0, 0, width, height, 1, null, 0, 0, 1, stream);
            const radius = radiusFromPixels(pixbuf.get_pixels(), pixbuf.get_rowstride(),
                pixbuf.get_n_channels(), pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_has_alpha());
            if (!radius) return null;
            const scale = actor.get_scale()[0] || 1;
            return {top: radius.top / scale, bottom: radius.bottom / scale};
        } finally { stream.close(null); }
    }
    setGuideRadius(guide, w, fallback) {
        const record = this.records.get(w);
        if (record && !record.windowRadius) this.queueWindowRadius(w);
        guide.set_style(`border-radius: ${radiusStyle(record?.windowRadius, fallback, record?.visualScale ?? 1)};`);
    }
    visualWindowRect(w) {
        const frame = w.get_frame_rect(), actor = this.windowActor(w);
        if (!actor) return frame;
        const [scaleX, scaleY] = actor.get_scale();
        const pivot = actor.get_pivot_point();
        return visualFrameRect(frame, {x: actor.x, y: actor.y, width: actor.width, height: actor.height,
            scaleX, scaleY, pivotX: Array.isArray(pivot) ? pivot[0] : pivot.x,
            pivotY: Array.isArray(pivot) ? pivot[1] : pivot.y,
            translationX: actor.translation_x, translationY: actor.translation_y});
    }
    borderMonitorScale(w) {
        const themeScale = St.ThemeContext.get_for_stage(global.stage).get_scale_factor();
        return themeScale === 1 ? global.display.get_monitor_scale(w.get_monitor()) : themeScale;
    }
    animatePlacement(w, from, to) {
        if (!this.settings.get_boolean('animations') ||
            ['x', 'y', 'width', 'height'].every(key => Math.abs(from[key] - to[key]) <= 2)) return;
        const record = this.records.get(w);
        if (record?.motionGuide) { this.motionGuides.delete(record.motionGuide); record.motionGuide.destroy(); }
        const app = Shell.WindowTracker.get_default().get_window_app(w);
        const guide = new St.BoxLayout({style_class: 'snaptess-motion-guide', reactive: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.setGuideRadius(guide, w, 14);
        guide.add_child(app?.create_icon_texture(24) ??
            new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 24}));
        guide.add_child(new St.Label({text: app?.get_name() ?? 'Window'}));
        guide.set_position(from.x, from.y); guide.set_size(from.width, from.height);
        global.window_group.add_child(guide);
        this.motionGuides.add(guide);
        if (record) record.motionGuide = guide;
        guide.ease({x: to.x, y: to.y, width: to.width, height: to.height, opacity: 80,
            duration: 230, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => {
                this.motionGuides.delete(guide);
                if (record?.motionGuide === guide) record.motionGuide = null;
                guide.destroy();
            }});
    }
    hideDragGuides() {
        this.dragSourceGuide?.hide(); this.dragTargetGuide?.hide(); this.dragFlow?.hide();
        this.dragSourceWindow = null; this.dragTargetWindow = null;
        this.dragFlowKey = null;
    }
    showDragGuides(w, targetWindow, source, target) {
        if (!source) return;
        this.showRect(this.dragSourceGuide, source);
        this.showRect(this.dragTargetGuide, target);
        this.dragSourceWindow = w; this.dragTargetWindow = targetWindow;
        this.setGuideRadius(this.dragSourceGuide, w, 14);
        this.setGuideRadius(this.dragTargetGuide, targetWindow, 14);
        const key = `${target.x}:${target.y}:${targetWindow ? this.appId(targetWindow) : 'free'}`;
        if (this.dragFlowKey !== key) {
            this.dragFlowKey = key;
            this.dragFlow.destroy_all_children();
            const sourceApp = Shell.WindowTracker.get_default().get_window_app(w);
            const targetApp = targetWindow ? Shell.WindowTracker.get_default().get_window_app(targetWindow) : null;
            this.dragFlow.add_child(sourceApp?.create_icon_texture(22) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 22}));
            this.dragFlow.add_child(new St.Label({text: targetWindow ? '⇄' : '→'}));
            if (targetWindow) this.dragFlow.add_child(targetApp?.create_icon_texture(22) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 22}));
            else this.dragFlow.add_child(new St.Icon({icon_name: 'view-grid-symbolic', icon_size: 22}));
        }
        this.dragFlow.set_position(Math.round(target.x + target.width / 2 - 42), target.y + target.height - 54);
        this.dragFlow.show();
    }
    updateBorder() {
        const w = global.display.focus_window;
        const record = this.records.get(w);
        if (!this.running || this.drag?.started || this.studio || Main.overview.visible || !record || record.floating ||
            w.minimized || w.fullscreen || w.get_maximize_flags() || !this.settings.get_boolean('active-border') ||
            !this.windows(w.get_monitor()).includes(w)) {
            this.border.hide(); return;
        }
        if (record.radiusDirty) this.queueWindowRadius(w, record.windowRadius ? 120 : 0);
        if (!record.windowRadius) {
            if (record.radiusAttempts < 3 && !record.radiusFallbackReady && !record.radiusFallbackTimer) {
                record.radiusFallbackTimer = this.later(1400, () => {
                    record.radiusFallbackTimer = 0;
                    record.radiusFallbackReady = true;
                    this.updateBorder();
                });
            }
            if (!record.radiusFallbackReady &&
                (record.radiusPending || record.radiusTimer || record.radiusAttempts < 3)) {
                this.border.hide();
                return;
            }
        }
        const borderColor = this.swapMode ? '#62a0ea' : this.accentColor();
        const scale = this.windowActor(w)?.get_scale()?.[0] ?? 1;
        this.border.setOutline(borderColor, record.windowRadius, scale);
        this.border.setFrame(this.visualWindowRect(w), this.borderMonitorScale(w));
        this.stackWindowOverlays(w);
    }
    stackWindowOverlays(w) {
        const windowActor = this.windowActor(w);
        if (windowActor?.get_parent() !== global.window_group) return;
        global.window_group.set_child_above_sibling(this.border, windowActor);
        global.window_group.set_child_above_sibling(this.windowActionHandle, this.border);
        global.window_group.set_child_above_sibling(this.windowActions, this.windowActionHandle);
        global.window_group.set_child_above_sibling(this.windowActionTooltip, this.windowActions);
    }
    windowsRestacked() {
        const w = global.display.focus_window;
        this.updateBorder(); this.stackWindowOverlays(w);
        // Some Qt and terminal clients raise their actor without producing the
        // focus notification used by the normal path.
        if (w && w !== this.actionWindow && !this.windowActions.visible && !this.windowActionHandle.visible)
            this.queueWindowActions(w);
    }
    scheduleWindowActionsHide(delay = 1600) {
        this.cancel(this.actionsTimer);
        this.actionsTimer = this.later(delay, () => {
            this.actionsTimer = 0; this.transitionWindowActionsToHandle();
        });
    }
    transitionWindowActionsToHandle() {
        this.windowActionTooltip.hide();
        this.windowActions.remove_all_transitions();
        if (!this.windowActions.visible || !this.settings.get_boolean('animations')) {
            this.windowActions.hide(); this.showWindowActionHandle(); return;
        }
        this.windowActions.ease({opacity: 0, translation_x: 8, duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => {
                this.windowActions.hide(); this.windowActions.opacity = 255; this.windowActions.translation_x = 0;
                this.showWindowActionHandle(true);
            }});
    }
    queueWindowActions(w, delay = 140) {
        if (this.actionsShowTimer && this.pendingActionWindow === w) return;
        this.cancel(this.actionsShowTimer);
        this.pendingActionWindow = w;
        this.actionsShowTimer = this.later(delay, () => {
            this.actionsShowTimer = 0;
            this.pendingActionWindow = null;
            if (global.display.focus_window === w) this.showWindowActions();
        });
    }
    hideWindowActions() {
        this.cancel(this.actionsShowTimer); this.actionsShowTimer = 0;
        this.pendingActionWindow = null;
        this.cancel(this.actionsTimer); this.actionsTimer = 0;
        this.windowActions.remove_all_transitions(); this.windowActionHandle.remove_all_transitions();
        this.windowActions.hide(); this.windowActions.opacity = 255; this.windowActions.translation_x = 0;
        this.windowActionHandle.hide(); this.windowActionTooltip.hide();
    }
    windowActionsRect(w, record) {
        return record.floating || record.restorePending || w.get_maximize_flags()
            ? this.visualWindowRect(w) : record.tileRect ?? w.get_frame_rect();
    }
    updateWindowActionsPosition(w) {
        if (global.display.focus_window !== w || this.actionWindow !== w) return;
        if (!this.windowActions.visible && !this.windowActionHandle.visible) return;
        const record = this.records.get(w);
        if (!record) return;
        const rect = this.windowActionsRect(w, record);
        if (this.windowActions.visible) {
            this.windowActions.set_position(rect.x + Math.max(4, rect.width - 52),
                rect.y + Math.max(8, Math.round((rect.height - 176) / 2)));
            this.windowActionTooltip.hide();
        }
        if (this.windowActionHandle.visible)
            this.windowActionHandle.set_position(rect.x + Math.max(2, rect.width - 14),
                rect.y + Math.max(8, Math.round((rect.height - 48) / 2)));
    }
    showWindowActionHandle(animate = false) {
        const w = global.display.focus_window, record = this.records.get(w);
        if (!this.running || !record || this.drag || this.studio || Main.overview.visible || w.minimized ||
            w.fullscreen) {
            this.windowActionHandle.hide(); return;
        }
        const rect = this.windowActionsRect(w, record);
        this.actionWindow = w;
        this.windowActionHandle.set_position(rect.x + Math.max(2, rect.width - 14),
            rect.y + Math.max(8, Math.round((rect.height - 48) / 2)));
        this.stackWindowOverlays(w);
        this.windowActionHandle.show();
        if (animate && this.settings.get_boolean('animations')) {
            this.windowActionHandle.opacity = 0;
            this.windowActionHandle.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else this.windowActionHandle.opacity = 255;
    }
    showWindowActionTooltip(button) {
        this.cancel(this.actionsTimer); this.actionsTimer = 0;
        const text = button._snaptessTooltip;
        if (!text || !this.windowActions.visible) return;
        this.windowActionTooltip.text = text;
        this.windowActionTooltip.show();
        const [, width] = this.windowActionTooltip.get_preferred_width(-1);
        const [, height] = this.windowActionTooltip.get_preferred_height(width);
        const [x, y] = button.get_transformed_position();
        this.windowActionTooltip.set_position(Math.round(x - width - 8), Math.round(y + (button.height - height) / 2));
        this.stackWindowOverlays(global.display.focus_window);
    }
    showWindowActions() {
        const w = global.display.focus_window, record = this.records.get(w);
        if (!this.running || !record || this.drag || this.studio || Main.overview.visible || w.minimized ||
            w.fullscreen) {
            this.hideWindowActions(); return;
        }
        const rect = this.windowActionsRect(w, record);
        this.actionWindow = w;
        this.windowActionHandle.remove_all_transitions();
        this.windowActionHandle.hide();
        const height = 176;
        this.windowActions.set_position(rect.x + Math.max(4, rect.width - 52),
            rect.y + Math.max(8, Math.round((rect.height - height) / 2)));
        this.floatAction[record.floating ? 'add_style_class_name' : 'remove_style_class_name']('selected');
        this.floatAction.child.icon_name = record.floating ? 'view-grid-symbolic' : 'window-pop-out-symbolic';
        this.floatAction._snaptessTooltip = record.floating ? 'Tile window' : 'Float window';
        this.maximizeAction.child.icon_name = w.get_maximize_flags() ? 'window-restore-symbolic' : 'window-maximize-symbolic';
        this.maximizeAction._snaptessTooltip = w.get_maximize_flags() ? 'Restore window' : 'Maximize window';
        this.stackWindowOverlays(w);
        const appearing = !this.windowActions.visible;
        this.windowActions.remove_all_transitions();
        this.windowActions.show();
        if (appearing && this.settings.get_boolean('animations')) {
            this.windowActions.opacity = 0;
            this.windowActions.translation_x = 8;
            this.windowActions.ease({opacity: 255, translation_x: 0, duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this.scheduleWindowActionsHide();
    }
    focusChanged() {
        if (this.drag && !global.display.is_grabbed()) this.grabEnd();
        else {
            this.updateBorder();
            const w = global.display.focus_window;
            if (w) this.queueWindowActions(w);
        }
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
        this.hideWindowActions();
        if (global.display.focus_window === w) this.showWindowActionHandle();
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
        this.showSwapGuides(rects[from], rects[to], direction, w, slots[to]);
        if (!this.swapChanged) {
            this.checkpoint();
            this.swapChanged = true;
        }
        [slots[from], slots[to]] = [slots[to], slots[from]];
        this.tile(false);
    }

    createSpaceTransition(monitor, oldSpace, newSpace, outgoing, incoming) {
        const geometry = Main.layoutManager.monitors[monitor];
        if (!geometry) return null;
        for (const previous of this.spaceTransitions) previous.destroy();
        this.spaceTransitions.clear();
        const layer = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: false,
            width: global.stage.width, height: global.stage.height});
        const backdrop = new St.Widget({style_class: 'snaptess-space-backdrop', reactive: false});
        backdrop.set_position(geometry.x, geometry.y); backdrop.set_size(geometry.width, geometry.height);
        layer.add_child(backdrop);
        const direction = newSpace > oldSpace ? 1 : -1;
        const shift = Math.round(geometry.width * 0.16);
        const clones = [];
        const addClone = (w, entering) => {
            const actor = this.windowActor(w), record = this.records.get(w);
            if (!actor || !record) return;
            const rect = record.tileRect ?? w.get_frame_rect();
            const clone = new Clutter.Clone({source: actor, reactive: false});
            clone.set_position(rect.x + (entering ? direction * shift : 0), rect.y);
            clone.set_size(rect.width, rect.height);
            clone.opacity = entering ? 0 : 255;
            layer.add_child(clone);
            clones.push({clone, rect, entering});
        };
        outgoing.forEach(w => addClone(w, false));
        incoming.forEach(w => addClone(w, true));
        const osdLabel = new St.Label({text: `SPACE ${newSpace + 1}`, style_class: 'snaptess-space-osd-label'});
        osdLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        osdLabel.clutter_text.single_line_mode = true;
        osdLabel.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        const osd = new St.Bin({style_class: 'snaptess-space-osd', reactive: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            child: osdLabel});
        osd.set_position(Math.round(geometry.x + geometry.width / 2 - 140),
            Math.round(geometry.y + geometry.height / 2 - 43));
        osd.set_size(280, 86); layer.add_child(osd);
        global.window_group.add_child(layer);
        this.spaceTransitions.add(layer);
        return {layer, backdrop, osd, clones, direction, shift};
    }
    playSpaceTransition(transition) {
        if (!transition) return;
        const {layer, backdrop, osd, clones, direction, shift} = transition;
        const animated = this.settings.get_boolean('animations');
        const duration = animated ? 230 : 0;
        if (animated) {
            backdrop.opacity = 0;
            backdrop.ease({opacity: 238, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            osd.opacity = 0; osd.set_scale(0.92, 0.92);
            osd.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        for (const {clone, rect, entering} of clones) {
            clone.ease({x: entering ? rect.x : rect.x - direction * shift, opacity: entering ? 255 : 0,
                duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this.later(animated ? 260 : 700, () => {
            if (!this.spaceTransitions.has(layer)) return;
            backdrop.ease({opacity: 0, duration: animated ? 120 : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            for (const {clone} of clones) clone.ease({opacity: 0, duration: animated ? 120 : 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        this.later(animated ? 1050 : 1200, () => {
            if (!this.spaceTransitions.has(layer)) return;
            const finish = () => { this.spaceTransitions.delete(layer); layer.destroy(); };
            if (animated) osd.ease({opacity: 0, scale_x: 0.96, scale_y: 0.96, duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: finish});
            else finish();
        });
    }

    switchSpace(space, monitor = this.currentMonitor()) {
        if (!this.running || space === this.activeSpace(monitor)) return;
        this.exitSwap(); this.hideGuides();
        const old = this.activeSpace(monitor), workspace = global.workspace_manager.get_active_workspace();
        const outgoing = [], incoming = [];
        for (const [w, r] of this.records) {
            if (w.get_monitor() !== monitor || w.get_workspace() !== workspace) continue;
            if (r.space === old && !w.minimized) outgoing.push(w);
            if (r.space === space && r.parked) incoming.push(w);
        }
        const transition = this.createSpaceTransition(monitor, old, space, outgoing, incoming);
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
        this.updatePanelStatus();
        this.playSpaceTransition(transition);
    }

    grabBegin(w, op) {
        if (!this.running || !this.records.has(w) || this.records.get(w).floating ||
            this.matchesAppRule(w, 'excluded-apps') ||
            ![Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING].includes(op)) return;
        const record = this.records.get(w);
        this.cancel(record.restoreTimer); record.restoreTimer = 0;
        this.cancel(record.settleTimer); record.settleTimer = 0;
        record.restorePending = false;
        this.traceWindow(w, 'grab-begin');
        const [startX, startY] = global.get_pointer();
        this.drag = {window: w, monitor: w.get_monitor(), target: null,
            checkpoint: this.captureCheckpoint(), startX, startY,
            started: op === Meta.GrabOp.KEYBOARD_MOVING};
        const tick = () => {
            if (!this.drag) return;
            if (!global.display.is_grabbed()) {
                this.grabEnd();
                return;
            }
            const [x, y] = global.get_pointer();
            if (!this.drag.started) {
                if ((x - startX) ** 2 + (y - startY) ** 2 < 64) {
                    this.dragTimer = this.later(32, tick);
                    return;
                }
                this.drag.started = true;
            }
            this.border.hide(); this.hideWindowActions();
            const monitor = Main.layoutManager.monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
            if (monitor >= 0) {
                let slots = [...(this.groups.get(this.key(monitor)) ?? this.windows(monitor))];
                if (!slots.includes(w)) slots.push(w);
                const rects = layout(this.area(monitor), slots.length, this.options(monitor));
                const index = nearestSlot(rects, x, y);
                if (index >= 0) {
                    const destination = rects[index];
                    const visualWindow = this.windows(monitor).find(candidate => {
                        if (candidate === w) return false;
                        const tile = this.records.get(candidate)?.tileRect;
                        return tile && ['x', 'y', 'width', 'height'].every(key => Math.abs(tile[key] - destination[key]) <= 2);
                    });
                    const targetWindow = visualWindow ?? slots[index];
                    this.drag.target = {monitor, index, window: targetWindow};
                    this.showRect(this.preview, rects[index]);
                    this.previewWindow = targetWindow;
                    this.setGuideRadius(this.preview, targetWindow, 16);
                    const from = slots.indexOf(w);
                    const sourceRect = this.records.get(w)?.tileRect ?? (from >= 0 ? rects[from] : null);
                    if (targetWindow === w) this.hideDragGuides();
                    else this.showDragGuides(w, targetWindow, sourceRect, destination);
                    let arrow = '';
                    if (from >= 0 && from !== index) {
                        const a = rects[from], b = rects[index];
                        const dx = b.x - a.x, dy = b.y - a.y;
                        arrow = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? ' →' : ' ←') : (dy > 0 ? ' ↓' : ' ↑');
                    }
                    if (targetWindow === w) {
                        this.previewLabel.hide();
                    } else {
                        const action = targetWindow
                            ? `Swap with ${this.appId(targetWindow).replace(/\.desktop$/, '')}`
                            : 'Move to free tile';
                        this.previewLabel.text = `Tile ${String(index + 1).padStart(2, '0')}${arrow} · ${action}`;
                        this.previewLabel.set_position(rects[index].x + 12, rects[index].y + 12);
                        this.previewLabel.show();
                    }
                }
            } else {
                this.drag.target = null; this.preview.hide(); this.previewLabel.hide(); this.hideDragGuides();
            }
            this.dragTimer = this.later(32, tick);
        };
        tick();
    }
    grabEnd() {
        if (!this.drag) return;
        this.cancel(this.dragTimer); this.dragTimer = 0;
        const {window: w, target, monitor: source, checkpoint, startX, startY, started} = this.drag;
        this.drag = null; this.preview.hide(); this.previewLabel.hide(); this.hideDragGuides();
        if (!this.records.has(w)) return;
        if (started === false) {
            const [x, y] = global.get_pointer();
            if ((x - startX) ** 2 + (y - startY) ** 2 >= 64) this.tile(true);
            else this.updateBorder();
            this.queueWindowActions(w);
            return;
        }
        if (target) {
            const key = this.key(target.monitor);
            const slots = [...(this.groups.get(key) ?? this.windows(target.monitor))];
            if (source === target.monitor) {
                const from = slots.indexOf(w);
                const visualIndex = target.window ? slots.indexOf(target.window) : -1;
                const destinationIndex = visualIndex >= 0 ? visualIndex : target.index;
                if (from === destinationIndex) {
                    this.place(w, this.records.get(w).tileRect);
                    this.updateBorder();
                    this.queueWindowActions(w);
                    return;
                }
                if (from >= 0) {
                    this.pushCheckpoint(checkpoint);
                    [slots[from], slots[destinationIndex]] = [slots[destinationIndex], slots[from]];
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
        this.queueWindowActions(w);
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
        this.applyProfiles([{monitor, space, preset, windows}]);
    }

    applyProfiles(changes, focus = changes.at(-1)) {
        if (!changes.length) return;
        if (!this.running) this.setRunning(true);
        this.checkpoint();
        this.switchSpace(focus.space, focus.monitor);
        const workspace = global.workspace_manager.get_active_workspace();
        const claimed = new Set();
        const plans = changes.map(change => ({...change, slots: change.windows.map(w => {
            if (!w || !this.records.has(w) || w.get_workspace() !== workspace || claimed.has(w)) return null;
            claimed.add(w); return w;
        })}));
        this.busy = true;
        try {
            for (const [key, group] of this.groups)
                if (key.startsWith(`${this.workspaceIndex()}:`))
                    this.groups.set(key, group.filter(w => !claimed.has(w)));
            for (const {monitor, space, preset, slots, pinned = [], slotCount, parkUnused = []} of plans) {
                for (const w of parkUnused) {
                    if (!this.records.has(w)) continue;
                    const r = this.records.get(w);
                    r.restoreParked = true;
                    if (!w.minimized) w.minimize();
                }
                for (const w of slots) {
                    if (!w) continue;
                    const r = this.records.get(w); r.original ??= this.snapshot(w);
                    r.floating = false; r.space = space; r.monitor = monitor; r.restoreParked = false;
                    w.move_to_monitor(monitor);
                    if (w.get_monitor() !== monitor) {
                        // A secondary-display window may be workspace-sticky, so
                        // Mutter can ignore move_to_monitor until its frame moves.
                        const area = this.area(monitor);
                        w.move_frame(true, area.x + 12, area.y + 12);
                    }
                    r.parked = this.activeSpace(monitor) !== space;
                    if (r.parked) w.minimize(); else w.unminimize();
                }
                this.groups.set(this.key(monitor, space), slots);
                this.profiles[this.profileKey(monitor, space)] = {
                    preset, apps: slots.filter(Boolean).map(w => this.appId(w)), pinned,
                    ...(slotCount ? {slotCount} : {}),
                };
            }
        } finally { this.busy = false; }
        this.settings.set_string('profiles', JSON.stringify(this.profiles));
        this.tile(true, true);
        this.updatePanelStatus();
        this.deletedLayouts?.splice(0);
    }

    disable() {
        this.pendingLayoutApps.clear();
        this.studio?.dialog.destroy(); this.studio = null;
        this.setRunning(false, true);
        this.exitSwap();
        for (const name of Object.keys(this.bindings)) Main.wm.removeKeybinding(name);
        for (const id of this.sources) GLib.Source.remove(id);
        this.sources.clear();
        for (const [object, id] of this.connections) object.disconnect(id);
        for (const [w, r] of this.records) {
            this.stopWindowTrace(r);
            this.disconnectWindowEffects(r);
            this.cancel(r.radiusTimer);
            this.cancel(r.radiusFallbackTimer);
            const actor = this.windowActor(w);
            if (actor && r.radiusActorSignal) actor.disconnect(r.radiusActorSignal);
            if (actor) for (const id of r.borderActorSignals) actor.disconnect(id);
            for (const id of r.signals) w.disconnect(id);
        }
        this.records.clear();
        for (const guide of this.motionGuides) guide.destroy();
        this.motionGuides.clear();
        for (const transition of this.spaceTransitions) transition.destroy();
        this.spaceTransitions.clear();
        this.border.destroy();
        this.windowActionHandle.destroy();
        this.windowActions.destroy();
        this.windowActionTooltip.destroy();
        Main.layoutManager.removeChrome(this.preview); this.preview.destroy();
        Main.layoutManager.removeChrome(this.previewLabel); this.previewLabel.destroy();
        Main.layoutManager.removeChrome(this.swapFromGuide); this.swapFromGuide.destroy();
        Main.layoutManager.removeChrome(this.swapToGuide); this.swapToGuide.destroy();
        Main.layoutManager.removeChrome(this.swapArrow); this.swapArrow.destroy();
        Main.layoutManager.removeChrome(this.dragSourceGuide); this.dragSourceGuide.destroy();
        Main.layoutManager.removeChrome(this.dragTargetGuide); this.dragTargetGuide.destroy();
        Main.layoutManager.removeChrome(this.dragFlow); this.dragFlow.destroy();
        this.indicator.destroy();
        this.settings = null;
    }
}
