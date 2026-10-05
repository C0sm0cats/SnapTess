import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as appearance from '../lib/appearance.js';
import {validSavedLayout} from '../lib/archive.js';
import * as geometry from '../lib/layout.js';
import {radiusStyle, radiusFromPixels, plausibleWindowRadius} from '../lib/window-radius.js';

// Execute the actual runtime methods with asynchronous client commits and a
// deterministic clock. GI imports alone are replaced; no duplicate restore code.
const source = fs.readFileSync(new URL('../runtime.js', import.meta.url), 'utf8')
    .replace(/^import [^;]+;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../runtime.js', import.meta.url).href))
    .replace('export default class SnapTess', 'class SnapTess') + '\nSnapTess;';
function harness(options = {}) {
    let now = 1000, nextId = 1, grabbed = false, monitor = 0, pointer = [150, 80];
    const timers = new Map(), signals = new Map(), actorSignals = new Map();
    const requests = [], scaleWrites = [], userOps = [], launches = [];
    let frame = {x: 100, y: 50, width: 600, height: 400};
    const slot = {...frame};
    const actor = {
        x: 90, y: 36, width: 620, height: 430, __animationInfo: null,
        scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
        connect(name, fn) { actorSignals.set(name, fn); return nextId++; },
        disconnect() {}, get_transition() { return null; },
        get_width() { return this.width; }, get_height() { return this.height; },
        set_pivot_point(x, y) { this.pivot = [x, y]; },
        set_scale(x, y) { scaleWrites.push([x, y]); this.scale_x = x; this.scale_y = y; },
    };
    const workspace = {get_work_area_for_monitor: () => ({x: 0, y: 0, width: 800, height: 600})};
    const shellMain = {layoutManager: {monitors: [{}]}, overview: {visible: false}, notify() {}};
    const shellDisplay = {is_grabbed: () => grabbed, get_current_monitor: () => monitor, focus_window: null};
    const w = {
        fullscreen: false, flags: 0, minimized: false,
        get_frame_rect: () => ({...frame}),
        get_buffer_rect: () => ({x: frame.x - 10, y: frame.y - 14, width: frame.width + 20, height: frame.height + 30}),
        get_compositor_private: () => actor,
        get_maximize_flags() { return this.flags; },
        get_monitor: () => monitor, get_workspace: () => workspace,
        get_window_type: () => 0, is_override_redirect: () => false,
        is_on_all_workspaces: () => false, get_min_size: () => [false, 0, 0],
        connect(name, fn) { signals.set(name, fn); return nextId++; }, disconnect() {},
        move_resize_frame(user, x, y, width, height) {
            userOps.push(user);
            requests.push({type: 'resize', x, y, width, height});
        },
        move_frame(user, x, y) { userOps.push(user); requests.push({type: 'move', x, y}); },
    };
    const Runtime = vm.runInNewContext(source, {
        ...geometry, ...appearance, validSavedLayout, radiusStyle, radiusFromPixels, plausibleWindowRadius, Extension: class {}, console, TextDecoder,
        Date: class extends Date { static now() { return now; } },
        GLib: {SOURCE_CONTINUE: true, SOURCE_REMOVE: false, file_get_contents(path) {
            if (path === `/proc/${options.launchPid ?? 979491}/environ` && options.launchEnvironment)
                return [true, new TextEncoder().encode(options.launchEnvironment)];
            throw new Error('trace disabled');
        },
            file_read_link(path) {
                if (path === `/proc/${options.launchPid ?? 979491}/exe` && options.executablePath)
                    return options.executablePath;
                throw new Error('executable unavailable');
            },
            path_get_basename: path => path.split('/').at(-1),
            uuid_string_random: () => 'saved-layout-id'},
        Main: shellMain,
        Gio: {MemoryOutputStream: {new_resizable: () => ({close() {}})}},
        Shell: {Screenshot: options.screenshot, AppSystem: {get_default: () => ({get_installed: () => options.installedApps ?? [], lookup_app: id =>
            id === 'test.desktop' || id === 'pdf4teachers.desktop'
                ? {get_name: () => id === 'pdf4teachers.desktop' ? 'PDF4Teachers' : 'Test',
                    get_app_info: () => ({launch: () => { launches.push(id); return true; }})} :
                options.installedApps?.find(info => info.get_id() === id)?.app ?? null})},
        WindowTracker: {get_default: () => ({get_window_app: () => options.trackedApp ?? null})}},
        Meta: {LaterType: {BEFORE_REDRAW: 0}, WindowType: {NORMAL: 0}, GrabOp: {MOVING: 1, KEYBOARD_MOVING: 2,
            RESIZING_N: 3, RESIZING_S: 4, RESIZING_E: 5, RESIZING_W: 6,
            RESIZING_NE: 7, RESIZING_NW: 8, RESIZING_SE: 9, RESIZING_SW: 10}},
        Mtk: {Rectangle: class { constructor(rect) { Object.assign(this, rect); } }},
        global: {compositor: {get_laters: () => ({
            add(_phase, callback) {
                const id = nextId++;
                const fn = () => { if (callback()) timers.set(id, {at: now + 16, fn}); };
                timers.set(id, {at: now + 16, fn});
                return id;
            },
            remove(id) { timers.delete(id); },
        })}, display: shellDisplay, get_current_time: () => now, get_pointer: () => pointer,
            workspace_manager: {get_active_workspace: () => workspace, get_active_workspace_index: () => 0}, get_window_actors: () => [actor]},
    });
    const app = new Runtime();
    let previewState = '{}';
    Object.assign(app, {records: new Map(), spaces: new Map(), deferredRetile: new Set(), running: true, busy: false, drag: null,
        settings: {get_strv: () => [], get_boolean: () => false, get_int: () => 12, get_double: () => 0.6,
            get_string: () => previewState, set_string: (_key, value) => { previewState = value; }}});
    app.appId = () => 'test.desktop';
    app.later = (ms, fn) => { const id = nextId++; timers.set(id, {at: now + ms, fn}); return id; };
    app.cancel = id => timers.delete(id);
    app.schedule = () => { throw new Error('state notifications must not schedule a full retile'); };
    app.updateBorder = () => {};
    app.track(w);
    const record = app.records.get(w);
    function advance(ms) {
        const end = now + ms;
        let count = 0;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(++count < 100, 'timer work remains bounded');
            now = next[1].at; timers.delete(next[0]); next[1].fn();
        }
        now = end;
    }
    function commit(rect) {
        const old = frame; frame = {...frame, ...rect};
        if (old.x !== frame.x || old.y !== frame.y) signals.get('position-changed')();
        if (old.width !== frame.width || old.height !== frame.height) signals.get('size-changed')();
        // Mutter syncs the actor after MetaWindow geometry signals.
        Object.assign(actor, {x: frame.x - 10, y: frame.y - 14, width: frame.width + 20, height: frame.height + 30});
    }
    function special(flags, fullscreen = false) {
        w.flags = flags; w.fullscreen = fullscreen;
        signals.get('notify::maximized-horizontally')();
        signals.get('notify::maximized-vertically')();
        signals.get('notify::fullscreen')();
    }
    function effectsDone() { actor.__animationInfo = null; actorSignals.get('effects-completed')(); }
    function settleInitial() {
        app.place(w, slot); advance(150);
        requests.length = 0; scaleWrites.length = 0;
    }
    return {app, w, actor, record, requests, scaleWrites, userOps, launches, slot, timers, advance, commit, special,
        shellMain, shellDisplay, notifyWindow: name => signals.get(name)?.(),
        effectsDone, settleInitial, frame: () => frame, grab: value => { grabbed = value; },
        monitor: value => { monitor = value; }, pointer: (x, y) => { pointer = [x, y]; }};
}

test('directional focus skips unavailable windows without changing geometry, slots or undo', () => {
    const h = harness(), app = h.app;
    const names = ['empty', 'minimized', 'floating', 'parked', 'space', 'monitor', 'workspace', 'excluded', 'maximized', 'closed', 'target'];
    const activations = [];
    const candidates = names.map(name => name === 'empty' ? null : {
        ...h.w, name, minimized: name === 'minimized',
        get_monitor: () => name === 'monitor' ? 1 : 0,
        get_workspace: () => name === 'workspace' ? {} : h.w.get_workspace(),
        get_maximize_flags: () => name === 'maximized' ? 1 : 0,
        activate(time) { activations.push([this.name, time]); h.shellDisplay.focus_window = this; },
    });
    const slots = [h.w, ...candidates];
    for (const w of candidates.filter(w => w && w.name !== 'closed'))
        app.records.set(w, {space: w.name === 'space' ? 1 : 0, floating: w.name === 'floating', parked: w.name === 'parked'});
    app.groups = new Map([['active', slots]]);
    app.key = () => 'active'; app.activeSpace = () => 0;
    app.matchesAppRule = w => w.name === 'excluded';
    app.slotRects = (monitor, count) => {
        assert.equal(monitor, 0); assert.equal(count, slots.length);
        return slots.map((_, i) => ({x:i*110,y:0,width:100,height:100}));
    };
    app.history = [{before:true}];
    const order = [...slots], history = JSON.stringify(app.history);
    h.shellDisplay.focus_window = h.w;
    app.focusDirection('right');
    assert.deepEqual(activations, [['target', 1000]]);
    app.focusDirection('right');
    assert.equal(activations.length, 1, 'no wrap at the edge');
    assert.deepEqual(slots, order);
    assert.equal(JSON.stringify(app.history), history);
    assert.equal(h.requests.length, 0);
});

test('directional focus is inactive outside tiling and during modal interactions', () => {
    const h = harness(), app = h.app;
    app.groups = new Map();
    app.key = () => 'active'; app.activeSpace = () => 0;
    app.slotRects = () => assert.fail('inactive focus navigation must not inspect or rearrange geometry');
    h.shellDisplay.focus_window = h.w;
    for (const [key, value] of [['running', false], ['busy', true], ['drag', {}], ['resizeGrab', {}],
        ['swapMode', true], ['studio', {}], ['layoutSwitcher', {}]]) {
        const previous = app[key]; app[key] = value;
        app.focusDirection('right'); app[key] = previous;
    }
    h.shellMain.overview.visible = true; app.focusDirection('right'); h.shellMain.overview.visible = false;
    h.grab(true); app.focusDirection('right'); h.grab(false);
    h.w.flags = 1; app.focusDirection('right'); h.w.flags = 0;
    h.shellDisplay.focus_window = null; app.focusDirection('right');
    h.shellDisplay.focus_window = {}; app.focusDirection('right');
    h.shellDisplay.focus_window = h.w; app.focusDirection('right');
    assert.equal(h.requests.length, 0);
});

test('resize grab moves its neighbor and persists only the active space', () => {
    const h = harness(), app = h.app;
    const otherActor = {get_width: () => 383, get_height: () => 576,
        set_pivot_point() {}, set_scale(x) { this.scale_x = x; }};
    const other = {get_frame_rect: () => ({x: 405, y: 12, width: 383, height: 576}),
        get_compositor_private: () => otherActor,
        move_resize_frame() { assert.fail('neighbors must not receive native resizes during the grab'); }};
    app.records.set(other, {floating: false});
    app.groups = new Map([['space-0', [h.w, other]]]);
    app.profiles = {};
    app.history = [];
    const setString = app.settings.set_string;
    app.settings.set_string = (key, value) => {
        setString(key, value);
        if (key === 'profiles') app.settingsChanged(key);
    };
    app.key = (_monitor, space = 0) => `space-${space}`;
    app.profileKey = (_monitor, space = 0) => `profile-${space}`;
    app.activeSpace = () => 0;
    app.isSpecialWindow = () => false;
    app.matchesAppRule = () => false;
    app.hideWindowActions = () => {};
    app.queueWindowActions = () => {};
    app.captureCheckpoint = () => ({before: true});
    app.tile = () => assert.fail('releasing a divider must not recalculate the layout');
    const placements = [];
    app.place = (w, rect, _restoring, _force, motionGuides) => {
        assert.equal(motionGuides, false);
        placements.push([w, rect]);
    };
    const base = app.slotRects(0, 2);
    h.commit(base[0]);
    h.grab(true);
    app.grabBegin(h.w, 5);
    assert.equal(app.resizeGrab.window, h.w);
    h.pointer(210, 80); h.advance(32);
    assert.equal(h.frame().width, base[0].width, 'the pointer drives the divider before the client responds');
    assert.equal(otherActor.translation_x, base[1].x + 60 - 405);
    assert.ok(otherActor.scale_x < 1);
    const preview = app.resizeGrab.updated.map(rect => ({...rect}));
    h.pointer(240, 80); // No new preview tick: release must save the last visible geometry.
    h.grab(false);
    app.grabEnd();
    assert.equal(app.history.length, 1);
    assert.deepEqual(placements.map(([, rect]) => rect), preview);
    assert.equal(app.slotRects(0, 2)[0].width, base[0].width + 60);
    assert.deepEqual(app.slotRects(0, 2, 1), base);
    assert.equal(app.profiles['profile-0'].apps.length, 2);
});

test('an external profile change still schedules a retile', () => {
    const h = harness(), scheduled = [];
    h.app.schedule = compact => scheduled.push(compact);
    h.app.settings.set_string('profiles', '{}');
    h.app.settingsChanged('profiles');
    assert.deepEqual(scheduled, [true]);
});

test('a growing neighbor receives native geometry during the grab', () => {
    const h = harness(), app = h.app;
    app.profileKey = () => 'profile';
    app.profiles = {};
    const base = app.slotRects(0, 2);
    let neighborFrame = {...base[1]};
    const nativeRequests = [], nativeMoves = [];
    const actor = {get_width: () => neighborFrame.width, get_height: () => neighborFrame.height,
        set_pivot_point() {}, set_scale(x, y) { this.scale_x = x; this.scale_y = y; }};
    const neighbor = {get_frame_rect: () => ({...neighborFrame}), get_compositor_private: () => actor,
        move_frame(_user, x, y) { nativeMoves.push({x, y}); },
        move_resize_frame(_user, x, y, width, height) {
            nativeRequests.push({x, y, width, height});
        }};
    app.records.set(neighbor, {floating: false, placing: false, traceUntil: 0, requestSequence: 0,
        backingRect: {...base[1]}});
    app.groups = new Map([['space', [h.w, neighbor]]]);
    app.key = () => 'space'; app.activeSpace = () => 0;
    app.isSpecialWindow = () => false; app.matchesAppRule = () => false;
    app.hideWindowActions = () => {}; app.captureCheckpoint = () => ({});
    let guideDestroyed = false;
    app.motionGuides = new Set([{destroy: () => { guideDestroyed = true; }}]);
    h.commit(base[0]); h.grab(true);
    app.grabBegin(h.w, 5);
    assert.equal(guideDestroyed, true);
    h.pointer(90, 80); h.advance(32);
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].x, base[1].x - 60);
    assert.deepEqual(nativeMoves, [{x: nativeRequests[0].x, y: nativeRequests[0].y}],
        'native neighbors move before resizing even during a grab');
    assert.equal(nativeRequests[0].width, base[1].width + 60);
    assert.equal(actor.scale_x * neighborFrame.width, nativeRequests[0].width,
        'preview fills the tile before the asynchronous client commits its new width');
    neighborFrame = {...nativeRequests[0]};
    app.updateLinkedResize();
    assert.equal(actor.scale_x, 1);
    h.advance(32);
    assert.equal(nativeRequests.length, 1, 'an unchanged target is not requested again');
    h.pointer(150, 80); h.advance(32); h.grab(false);
    app.tile = () => assert.fail('releasing a divider must not recalculate the layout');
    const place = app.place.bind(app);
    let restoredNeighbor = false;
    app.place = (w, rect, ...args) => {
        if (w === neighbor) {
            assert.equal(app.records.get(neighbor).backingRect, null,
                'returning to the original divider must request native placement again');
            restoredNeighbor = true;
        }
        return place(w, rect, ...args);
    };
    app.endLinkedResize();
    assert.equal(restoredNeighbor, true);
    assert.equal(app.records.get(neighbor).linkedResizePending, true);
    assert.equal(app.records.get(neighbor).linkedResizeEligible, true,
        'a neighbor touched by live resizing keeps the late-response fallback');
});

test('returning a resize divider to its start does not save a stale change', () => {
    const h = harness(), app = h.app;
    const otherActor = {get_width: () => 383, get_height: () => 576,
        set_pivot_point() {}, set_scale() {}};
    const other = {get_frame_rect: () => ({x: 405, y: 12, width: 383, height: 576}),
        get_compositor_private: () => otherActor};
    app.records.set(other, {floating: false});
    app.groups = new Map([['space-0', [h.w, other]]]);
    app.profiles = {}; app.history = [];
    app.key = () => 'space-0'; app.profileKey = () => 'profile-0';
    app.isSpecialWindow = () => false; app.matchesAppRule = () => false;
    app.hideWindowActions = () => {}; app.queueWindowActions = () => {};
    app.captureCheckpoint = () => ({}); app.tile = () => {};
    const base = app.slotRects(0, 2);
    other.get_frame_rect = () => ({...base[1]});
    h.commit(base[0]); h.grab(true);
    app.grabBegin(h.w, 5);
    h.pointer(190, 80); h.advance(32);
    h.pointer(150, 80); h.advance(32); h.grab(false);
    app.grabEnd();
    assert.equal(app.history.length, 0);
    assert.equal(app.profiles['profile-0'], undefined);
    assert.equal(otherActor.translation_x, 0);
});

test('releasing a blocked exterior border restores native geometry even without a layout change', () => {
    const h = harness(), app = h.app;
    app.groups = new Map([['space-0', [h.w]]]);
    app.profiles = {}; app.history = [];
    app.key = () => 'space-0'; app.profileKey = () => 'profile-0';
    app.isSpecialWindow = () => false; app.matchesAppRule = () => false;
    app.hideWindowActions = () => {}; app.queueWindowActions = () => {};
    app.captureCheckpoint = () => ({});
    const original = app.slotRects(0, 1)[0];
    h.commit(original); h.grab(true);
    app.grabBegin(h.w, 6);
    h.pointer(100, 80);
    h.commit({...original, x: original.x - 50, width: original.width + 50});
    h.advance(16);
    assert.equal(app.resizeGrab.updated, null);
    h.grab(false); app.endLinkedResize();
    assert.equal(h.record.linkedResizeEligible, true);
    assert.equal(h.requests.at(-1).width, original.width);
    assert.equal(h.requests.at(-1).x, original.x);
    assert.equal(h.actor.scale_x * h.frame().width, original.width);
    assert.equal(app.profiles['profile-0'], undefined, 'a blocked drag does not save false proportions');
});

test('a client rejecting a linked resize remains tiled with a visual fit', () => {
    const h = harness(); h.settleInitial();
    const target = {...h.slot, width: 300, height: 250};
    h.record.linkedResizePending = true;
    h.record.visualScale = 0.5;
    h.app.place(h.w, target);
    h.advance(8000);
    assert.equal(h.record.floating, false);
    assert.equal(h.record.linkedResizeScale, true);
    assert.equal(h.record.tileRect.width, target.width);
    assert.ok(h.actor.scale_x < 1);
});

test('release keeps the live linked fit until the native frame arrives', () => {
    for (const targetOf of [
        slot => ({...slot, x: slot.x + 80, width: 300, height: 250}),
        slot => ({...slot, x: slot.x + 80, width: 700, height: 450}),
    ]) {
        const h = harness(); h.settleInitial();
        const target = targetOf(h.slot);
        h.record.linkedResizePending = true;
        h.record.linkedResizeEligible = true;
        h.app.fitLinkedResize(h.w, h.actor, target);
        assert.equal(h.actor.scale_x * h.w.get_frame_rect().width, target.width);
        assert.equal(h.actor.scale_y * h.w.get_frame_rect().height, target.height);
        const visible = {scaleX: h.actor.scale_x, scaleY: h.actor.scale_y,
            x: h.actor.translation_x, y: h.actor.translation_y};
        h.app.place(h.w, target, false, false, false);
        assert.deepEqual({scaleX: h.actor.scale_x, scaleY: h.actor.scale_y,
            x: h.actor.translation_x, y: h.actor.translation_y}, visible);
        h.advance(100);
        assert.deepEqual({scaleX: h.actor.scale_x, scaleY: h.actor.scale_y,
            x: h.actor.translation_x, y: h.actor.translation_y}, visible,
        'asynchronous clients keep their live preview while placement settles');
        h.commit(target); h.advance(16);
        assert.equal(h.actor.scale_x, 1, 'native commits are fitted before the next rendered frame');
        assert.equal(h.actor.scale_y, 1);
        assert.equal(h.actor.translation_x, 0);
    }
});

test('a late resize response cannot float a previously linked neighbor', () => {
    const h = harness(); h.settleInitial();
    h.record.linkedResizeEligible = true;
    h.record.linkedResizePending = true;
    h.app.correctWindowScale(h.w);
    assert.equal(h.record.linkedResizePending, false,
        'a first accepted frame clears the short-lived pending flag');
    h.commit({...h.slot, width: h.slot.width + 100});
    h.advance(8000);
    assert.equal(h.record.floating, false);
    assert.equal(h.record.linkedResizeScale, true);
    assert.ok(h.actor.scale_x < 1);
});

test('dragging past the last available column never shrinks the visible grabbed tile', () => {
    const h = harness(), app = h.app;
    const others = Array.from({length: 3}, () => ({}));
    for (const w of others) app.records.set(w, {floating: false});
    app.groups = new Map([['space', [h.w, ...others]]]);
    app.profiles = {profile: {preset: '4x3', apps: []}};
    app.key = () => 'space'; app.profileKey = () => 'profile';
    app.isSpecialWindow = () => false; app.matchesAppRule = () => false;
    app.hideWindowActions = () => {}; app.captureCheckpoint = () => ({});
    const base = app.slotRects(0, 4), original = base[0];
    h.commit(original); h.grab(true);
    app.grabBegin(h.w, 5);
    h.pointer(1150, 80);
    h.commit({...original, width: original.width + 1000, height: original.height + 150});
    h.advance(16);
    const target = app.resizeGrab.updated[0];
    const firstVisibleWidth = h.frame().width * h.actor.scale_x;
    assert.equal(Math.round(firstVisibleWidth), target.width);
    h.pointer(1350, 80);
    h.commit({...original, width: original.width + 1200, height: original.height + 350});
    h.advance(16);
    assert.equal(app.resizeGrab.updated[0].width, target.width);
    assert.equal(Math.round(h.frame().width * h.actor.scale_x), target.width);
    assert.equal(Math.round(h.frame().height * h.actor.scale_y), target.height);
});

test('Arrange again clears only the focused space resize and keeps its preset', () => {
    const h = harness(), app = h.app;
    app.groups = new Map(); app.history = [];
    app.currentMonitor = () => 0;
    app.profileKey = (_monitor, space = 0) => `profile-${space}`;
    app.profiles = {
        'profile-0': {preset: '2x2', apps: ['test.desktop'], resize: {preset: '2x2', count: 4, offsets: []}},
        'profile-1': {preset: 'split', apps: [], resize: {preset: 'split', count: 2, offsets: []}},
    };
    let tiles = 0;
    app.tile = compact => { assert.equal(compact, true); tiles++; };
    app.arrangeAgain();
    assert.equal(tiles, 1);
    assert.equal(app.profiles['profile-0'].preset, '2x2');
    assert.equal(app.profiles['profile-0'].resize, undefined);
    assert.ok(app.profiles['profile-1'].resize);
    assert.ok(JSON.parse(app.history[0].profiles)['profile-0'].resize, 'Undo retains the prior proportions');
});

test('a titlebar click leaves drag feedback hidden and does not retile', () => {
    const h = harness(); h.settleInitial(); h.grab(true);
    h.app.captureCheckpoint = () => ({});
    let borderHides = 0, actionHides = 0, tiles = 0, borders = 0;
    h.app.border = {hide() { borderHides++; }};
    h.app.hideWindowActions = () => actionHides++;
    h.app.hideDragGuides = () => {};
    h.app.preview = {hide() {}};
    h.app.previewLabel = {hide() {}};
    h.app.tile = () => tiles++;
    h.app.updateBorder = () => borders++;
    h.app.queueWindowActions = () => {};
    h.app.grabBegin(h.w, 1);
    h.pointer(157, 80); h.advance(64);
    assert.equal(h.app.drag.started, false);
    assert.equal(borderHides, 0);
    assert.equal(actionHides, 0);
    h.grab(false); h.app.grabEnd();
    assert.equal(tiles, 0);
    assert.equal(borders, 1);
});

test('drag feedback starts only after pointer movement crosses the threshold', () => {
    const h = harness(); h.settleInitial(); h.grab(true);
    h.app.captureCheckpoint = () => ({});
    let borderHides = 0, actionHides = 0;
    h.app.border = {hide() { borderHides++; }};
    h.app.hideWindowActions = () => actionHides++;
    h.app.hideDragGuides = () => {};
    h.app.preview = {hide() {}};
    h.app.previewLabel = {hide() {}};
    h.app.grabBegin(h.w, 1);
    h.pointer(159, 80); h.advance(32);
    assert.equal(h.app.drag.started, true);
    assert.equal(borderHides, 1);
    assert.equal(actionHides, 1);
});

test('always-floating applications never start tile drag feedback', () => {
    const h = harness(); h.settleInitial(); h.grab(true);
    h.app.appId = () => 'org.gnucash.GnuCash.desktop';
    h.app.settings.get_strv = key => key === 'excluded-apps' ? ['org.gnucash.GnuCash'] : [];
    h.app.grabBegin(h.w, 1);
    h.pointer(200, 140); h.advance(64);
    assert.equal(h.app.drag, null);
    assert.equal(h.timers.size, 0);
});

test('changing a tile invalidates a radius captured for its previous geometry', () => {
    const h = harness(); h.settleInitial();
    h.record.windowRadius = {top: 7, bottom: 7};
    h.record.radiusDirty = false;
    const generation = h.record.radiusGeneration;
    h.app.place(h.w, {...h.slot, width: h.slot.width - 100});
    assert.equal(h.record.radiusGeneration, generation + 1);
    assert.equal(h.record.radiusDirty, true);
});

test('dragging over a vacant pinned tile keeps its card and rejects the drop', () => {
    const h = harness(), app = h.app; h.settleInitial(); h.grab(true);
    h.shellMain.layoutManager.monitors[0] = {x: 0, y: 0, width: 800, height: 600};
    app.key = () => 'workspace'; app.profileKey = () => 'profile';
    app.groups = new Map([['workspace', [h.w, null]]]);
    app.profiles = {profile: {pinned: [null, 'reserved.desktop']}};
    app.windows = () => [h.w];
    app.area = () => ({x: 0, y: 0, width: 800, height: 600});
    app.options = () => ({preset: 'split', gap: 0, padding: 0});
    app.captureCheckpoint = () => ({});
    let clears = 0, placements = 0, previews = 0;
    app.pinnedPlaceholders = new Map([['0:1', {button: {destroy() { clears++; }}}]]);
    app.border = {hide() {}}; app.hideWindowActions = () => {};
    app.hideDragGuides = () => {};
    app.preview = {hide() {}, show() { previews++; }};
    app.previewLabel = {hide() {}};
    app.queueWindowActions = () => {};
    app.pushCheckpoint = () => assert.fail('reserved drop must not create undo history');
    app.place = (w, rect) => { assert.equal(w, h.w); assert.deepEqual(rect, h.record.tileRect); placements++; };
    const rects = geometry.layout(app.area(), 2, app.options());
    const target = rects[1];
    app.grabBegin(h.w, 1);
    h.pointer(target.x + target.width / 2, target.y + target.height / 2); h.advance(32);
    assert.equal(app.drag.blocked, true);
    assert.equal(app.drag.target, null);
    assert.equal(clears, 0);
    assert.equal(app.pinnedPlaceholders.size, 1);
    assert.equal(previews, 0);
    app.updatePinnedPlaceholders();
    assert.equal(app.pinnedPlaceholders.size, 1);
    app.updatePinnedPlaceholders = () => {};
    h.grab(false); app.grabEnd();
    assert.equal(placements, 1);
    assert.equal(app.groups.get('workspace')[1], null);
});

test('keyboard swap does not enter a vacant pinned tile', () => {
    const h = harness(), app = h.app;
    app.key = () => 'workspace'; app.profileKey = () => 'profile';
    app.groups = new Map([['workspace', [h.w, null]]]);
    app.profiles = {profile: {pinned: [null, 'reserved.desktop']}};
    app.area = () => ({x: 0, y: 0, width: 800, height: 600});
    app.options = () => ({preset: 'split', gap: 0, padding: 0});
    app.swapWindow = h.w; app.swapKey = 'workspace'; app.swapChanged = false;
    app.showSwapGuides = () => assert.fail('reserved slot must not show swap feedback');
    app.checkpoint = () => assert.fail('reserved slot must not create undo history');
    const rects = geometry.layout(app.area(), 2, app.options());
    const direction = rects[1].x > rects[0].x ? 'right' : 'down';
    app.swapDirection(direction);
    assert.deepEqual(app.groups.get('workspace'), [h.w, null]);
    assert.equal(app.swapChanged, false);
    app.profiles.profile.pinned[1] = null;
    let guides = 0, checkpoints = 0, tiles = 0;
    app.showSwapGuides = () => guides++;
    app.checkpoint = () => checkpoints++;
    app.tile = () => tiles++;
    app.swapDirection(direction);
    assert.deepEqual(app.groups.get('workspace'), [null, h.w]);
    assert.equal(guides, 1);
    assert.equal(checkpoints, 1);
    assert.equal(tiles, 1);
});

test('automatic reflow omits motion guides while explicit tiling keeps them', () => {
    const h = harness(), app = h.app, guides = [];
    app.groups = new Map(); app.profiles = {};
    app.windows = () => [h.w];
    app.key = () => '0:0:0'; app.profileKey = () => '0:0:0';
    app.options = () => ({preset: 'auto', gap: 0, padding: 0});
    app.area = () => ({x: 0, y: 0, width: 800, height: 600});
    app.place = (_w, _rect, _restoring, _force, motionGuides) => guides.push(motionGuides);
    app.updateBorder = () => {};
    Object.getPrototypeOf(app).schedule.call(app, true);
    h.advance(110);
    app.tile(true);
    assert.deepEqual(guides, [false, true]);
});

test('placement keeps automatic motion guides hidden without disabling explicit guides', () => {
    const h = harness(); h.settleInitial();
    let guides = 0;
    h.app.animatePlacement = () => guides++;
    h.app.place(h.w, {...h.slot, x: 120}, false, false, false);
    assert.equal(guides, 0);
    h.app.place(h.w, {...h.slot, x: 140});
    assert.equal(guides, 1);
});

test('excluded applications match desktop IDs, aliases, and WM_CLASS', () => {
    const h = harness();
    h.w.get_wm_class = () => 'LegacyEditor';
    h.app.appId = () => 'org.example.Editor.desktop';
    const cases = [
        ['org.example.Editor.desktop', 'desktop ID'],
        ['org.example.Editor', 'non-desktop alias'],
        ['legacyeditor.desktop', 'WM_CLASS alias'],
        ['LEGACYEDITOR', 'legacy WM_CLASS value'],
    ];
    for (const [value, label] of cases) {
        h.app.settings.get_strv = key => key === 'excluded-apps' ? [value] : [];
        assert.equal(h.app.windows(0).length, 0, label);
    }
    h.app.settings.get_strv = () => ['unrelated.desktop'];
    assert.equal(h.app.windows(0)[0], h.w);
});

test('scaled applications use the same identifier matching without changing saved rules', () => {
    const h = harness();
    h.w.get_wm_class = () => 'ONLYOFFICE';
    h.app.appId = () => 'org.example.Editor.desktop';
    const cases = ['ORG.EXAMPLE.EDITOR', 'onlyoffice.desktop', 'ONLYOFFICE'];
    for (const value of cases) {
        h.app.settings.get_strv = key => key === 'scaled-apps' ? [value] : [];
        assert.equal(h.app.scalesApp(h.w), true, value);
        assert.equal(h.app.settings.get_strv('scaled-apps')[0], value);
    }
    h.app.settings.get_strv = () => ['unrelated.desktop'];
    assert.equal(h.app.scalesApp(h.w), false);
});

test('a window-backed app uses its verified desktop launch for application rules', () => {
    const environment = 'GIO_LAUNCHED_DESKTOP_FILE=/home/user/.local/share/applications/pdf4teachers.desktop\0' +
        'GIO_LAUNCHED_DESKTOP_FILE_PID=979491\0';
    const h = harness({launchEnvironment: environment,
        trackedApp: {is_window_backed: () => true, get_id: () => 'window:42'}});
    delete h.app.appId;
    h.w.get_wm_class = () => 'fr.clementgre.pdf4teachers.Main';
    h.w.get_pid = () => 0;
    assert.equal(h.app.appId(h.w), 'fr.clementgre.pdf4teachers.Main');
    h.w.get_pid = () => 979491;
    assert.equal(h.app.appId(h.w), 'pdf4teachers.desktop');
    assert.equal(h.app.windowApp(h.w).get_name(), 'PDF4Teachers');
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['pdf4teachers.desktop'] : [];
    assert.equal(h.app.scalesApp(h.w), true);
    h.app.settings.get_strv = key => key === 'excluded-apps' ? ['pdf4teachers.desktop'] : [];
    assert.equal(h.app.windows(0).length, 0);

    const mismatched = harness({launchEnvironment: environment.replace('PID=979491', 'PID=1'),
        trackedApp: {is_window_backed: () => true, get_id: () => 'window:43'}});
    delete mismatched.app.appId;
    mismatched.w.get_pid = () => 979491;
    mismatched.w.get_wm_class = () => 'fr.clementgre.pdf4teachers.Main';
    assert.equal(mismatched.app.appId(mismatched.w), 'fr.clementgre.pdf4teachers.Main');

    const recognized = harness({launchEnvironment: environment,
        trackedApp: {is_window_backed: () => false, get_id: () => 'other.desktop'}});
    delete recognized.app.appId;
    recognized.w.get_pid = () => 979491;
    assert.equal(recognized.app.appId(recognized.w), 'other.desktop');
});

test('a Wayland app ID resolves through a unique matching desktop executable', () => {
    const info = {get_id: () => 'hermes.desktop',
        get_executable: () => '/home/user/.venv/bin/hermes',
        app: {get_name: () => 'Hermes'}};
    const h = harness({launchPid: 2895620,
        launchEnvironment: 'GIO_LAUNCHED_DESKTOP_FILE=/usr/share/applications/kitty.desktop\0' +
            'GIO_LAUNCHED_DESKTOP_FILE_PID=2733261\0',
        executablePath: '/home/user/apps/Hermes', installedApps: [info],
        trackedApp: {is_window_backed: () => true, get_id: () => 'window:51'}});
    delete h.app.appId;
    h.w.get_pid = () => 2895620;
    h.w.get_wm_class = () => 'com.nousresearch.hermes';
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['hermes.desktop'] : [];
    assert.equal(h.app.appId(h.w), 'hermes.desktop');
    assert.equal(h.app.windowApp(h.w).get_name(), 'Hermes');
    assert.equal(h.app.scalesApp(h.w), true);

    const ambiguous = harness({launchPid: 2895620, executablePath: '/home/user/apps/Hermes',
        installedApps: [info, {get_id: () => 'another.desktop', get_executable: () => 'hermes'}],
        trackedApp: {is_window_backed: () => true, get_id: () => 'window:52'}});
    delete ambiguous.app.appId;
    ambiguous.w.get_pid = () => 2895620;
    ambiguous.w.get_wm_class = () => 'com.nousresearch.hermes';
    assert.equal(ambiguous.app.appId(ambiguous.w), 'com.nousresearch.hermes');
});

test('applying multiple Studio contexts creates one undo checkpoint and preserves every profile', () => {
    const h = harness(), app = h.app;
    let monitor = 0, tileCalls = 0;
    const first = h.w, second = {...h.w, id: 'second.desktop', minimized: true};
    first.id = 'first.desktop';
    first.get_monitor = () => monitor;
    first.move_to_monitor = value => { monitor = value; };
    first.minimize = () => { first.minimized = true; };
    first.unminimize = () => { first.minimized = false; };
    second.get_monitor = () => 0;
    second.move_to_monitor = () => {};
    second.minimize = () => { second.minimized = true; };
    second.unminimize = () => { second.minimized = false; };
    app.appId = w => w.id;
    app.records = new Map([[first, {original: null, floating: false, space: 0, parked: false, monitor: 0}],
        [second, {original: null, floating: false, space: 1, parked: true, monitor: 0}]]);
    app.groups = new Map([['0:0:0', [first]], ['0:0:1', [second]]]);
    app.history = []; app.profiles = {};
    app.deletedLayouts = [{layout: {id: 'old', name: 'Old layout'}, index: 0}];
    app.snapshot = () => ({});
    app.restore = () => {};
    app.workspaceIndex = () => 0;
    app.key = (display, space) => `0:${display}:${space}`;
    app.profileKey = (display, space) => `${display}:${space}`;
    app.activeSpace = () => 0;
    app.switchSpace = () => {};
    app.tile = () => { tileCalls++; };
    app.updatePanelStatus = () => {};
    app.notifyStatus = () => {};
    app.settings.set_string = () => {};

    app.applyProfiles([
        {monitor: 0, space: 0, preset: 'split', windows: [second], pinned: ['second.desktop']},
        {monitor: 0, space: 1, preset: 'full', windows: [first], pinned: []},
    ], {monitor: 0, space: 0});
    assert.equal(app.history.length, 1);
    assert.equal(app.deletedLayouts.length, 0, 'Apply retires an obsolete Undo delete');
    assert.equal(tileCalls, 1);
    assert.equal(app.groups.get('0:0:0')[0], second);
    assert.equal(app.groups.get('0:0:1')[0], first);
    assert.equal(app.profiles['0:0'].pinned[0], 'second.desktop');
    assert.equal(app.profiles['0:1'].preset, 'full');
    assert.equal(app.records.get(first).parked, true);
    assert.equal(app.records.get(second).parked, false);

    app.undo();
    assert.equal(app.history.length, 0);
    assert.equal(app.groups.get('0:0:0')[0], first);
    assert.equal(app.groups.get('0:0:1')[0], second);
    assert.equal(Object.keys(app.profiles).length, 0);
});

test('global redo restores all Studio contexts and a new manual checkpoint clears redo', () => {
    const {app, w} = harness();
    app.running = true; app.history = []; app.redoHistory = [];
    app.groups = new Map([['a', [w]]]); app.spaces = new Map(); app.profiles = {a: {preset: 'full'}};
    app.snapshot = () => ({}); app.restore = () => {}; app.updateMenuSensitivity = () => {}; app.publishPreviewState = () => {};
    app.checkpoint();
    app.profiles = {a: {preset: 'custom', tiles: [{x: 0, y: 0, width: 1, height: 1}], resize: [0.6]},
        b: {preset: 'master', pinned: ['test.desktop']}};
    app.records.get(w).spaces = new Set([0, 1]);
    app.records.get(w).floating = true;
    app.groups = new Map([['a', [null]], ['b', [w]]]);
    app.undo();
    assert.equal(app.profiles.a.preset, 'full');
    assert.equal(app.redoHistory.length, 1);
    app.redo();
    assert.equal(app.profiles.a.preset, 'custom');
    assert.equal(app.profiles.a.resize[0], 0.6);
    assert.equal(app.profiles.b.pinned[0], 'test.desktop');
    assert.equal(app.groups.get('b')[0], w);
    assert.equal(app.records.get(w).spaces.has(1), true);
    assert.equal(app.records.get(w).floating, true);
    app.undo(); app.redo(); app.undo();
    app.checkpoint();
    assert.equal(app.redoHistory.length, 0);
    const before = JSON.stringify(app.profiles);
    app.redo(); assert.equal(JSON.stringify(app.profiles), before);
});

test('global history is bounded and skips windows closed between undo and redo', () => {
    const {app, w} = harness();
    app.running = true; app.history = []; app.redoHistory = [];
    app.groups = new Map([['a', [w]]]); app.spaces = new Map(); app.profiles = {};
    app.snapshot = () => ({}); app.restore = () => {}; app.updateMenuSensitivity = () => {}; app.publishPreviewState = () => {};
    for (let i = 0; i < 12; i++) { app.checkpoint(); app.profiles = {step: i}; }
    assert.equal(app.history.length, 10);
    for (let i = 0; i < 10; i++) app.undo();
    assert.equal(app.redoHistory.length, 10);
    assert.equal(app.profiles.step, 1);
    app.records.delete(w);
    for (let i = 0; i < 10; i++) app.redo();
    assert.equal(app.profiles.step, 11);
    assert.equal(app.groups.get('a')[0], null);
    assert.equal(app.history.length, 10);
    app.undo();
    const redo = app.redoHistory.length;
    app.running = false; app.redo();
    assert.equal(app.redoHistory.length, redo, 'paused redo does not consume history');
});

test('undo cancels a pending destination and redo reuses its arriving window without relaunching', () => {
    const {app, w, launches} = sharingHarness();
    app.history = []; app.redoHistory = [];
    app.pendingLayoutApps = new Map(); app.snapshot = () => ({}); app.restore = () => {};
    app.updatePinnedPlaceholders = () => {}; app.updateMenuSensitivity = () => {};
    app.applyProfiles([{monitor: 0, space: 1, preset: 'master', windows: [null, null, null],
        apps: [null, null, 'test.desktop'], pinned: [], preserveSlots: true}]);
    assert.equal(app.pendingLayoutApps.size, 1);
    app.undo(); assert.equal(app.pendingLayoutApps.size, 0);
    app.eligible = () => true; app.schedule = () => {};
    app.redo();
    assert.equal(app.groups.get('0:0:1')[2], w);
    assert.equal(app.windowInSpace(w, 1), true);
    assert.equal(app.pendingLayoutApps.size, 0);
    assert.equal(launches.length, 1);
});

test('a saved app slot returns after close without undoing a live manual swap', () => {
    const h = harness(), app = h.app;
    const window = id => ({id, get_maximize_flags: () => 0});
    const pinned = window('editor.desktop'), other = window('browser.desktop'), reopened = window('editor.desktop');
    let live = [pinned, other];
    app.appId = w => w.id;
    app.windows = () => live;
    app.key = () => '0:0:0';
    app.profileKey = () => '0:0:0';
    app.profiles = {'0:0:0': {preset: 'split', apps: ['editor.desktop', 'browser.desktop'],
        pinned: ['editor.desktop']}};
    app.groups = new Map([['0:0:0', [other, pinned]]]);
    app.options = () => ({preset: 'split'});
    app.area = () => ({x: 0, y: 0, width: 800, height: 600});
    app.place = () => {};
    app.updateBorder = () => {};
    app.records = new Map([[pinned, {original: {}}], [other, {original: {}}], [reopened, {original: {}}]]);
    app.tile(true);
    assert.equal(app.groups.get('0:0:0')[0], other, 'manual swap remains visible');
    assert.equal(app.groups.get('0:0:0')[1], pinned);
    live = [other];
    app.tile(true);
    assert.equal(app.groups.get('0:0:0')[0], null, 'saved slot remains vacant after close');
    assert.equal(app.groups.get('0:0:0')[1], other);
    live = [other, reopened];
    app.tile(true);
    assert.equal(app.groups.get('0:0:0')[0], reopened, 'reopened app returns to its saved slot');
    assert.equal(app.groups.get('0:0:0')[1], other);
});

test('explicit saved-layout restore launches a missing app once and claims its window', () => {
    const h = harness(), app = h.app;
    app.savedLayouts = [{id: 'pair', name: 'Pair', preset: 'split', slotCount: 2,
        pinned: ['test.desktop', null]}];
    app.pendingLayoutApps = new Map();
    app.savedLayoutPlan = () => ({slots: [null, null], missing: ['test.desktop'], extras: []});
    let applied = 0, scheduled = 0;
    app.applyProfiles = () => { applied++; };
    app.activeSpace = () => 0;
    app.schedule = () => { scheduled++; };
    assert.equal(app.restoreSavedLayout('pair', 0, 0), true);
    assert.equal(app.restoreSavedLayout('pair', 0, 0), true);
    assert.equal(applied, 2, 'each explicit restore applies its template');
    assert.deepEqual(h.launches, ['test.desktop'], 'an in-flight app is not launched twice');
    assert.equal(app.claimLayoutWindow(h.w), true);
    assert.equal(app.pendingLayoutApps.size, 0);
    assert.equal(h.record.space, 0);
    assert.equal(scheduled, 1);
});

test('saved layouts keep app placement separate from explicit pins and read legacy templates', () => {
    const h = harness(), app = h.app;
    const other = {id: 'other.desktop'};
    app.appId = w => w === h.w ? 'test.desktop' : w.id;
    app.savedLayouts = [];
    app.deletedLayouts = [];
    let stored;
    app.settings.set_string = (key, value) => { stored = JSON.parse(value); };
    app.layoutCandidates = () => [h.w, other];
    const id = app.saveLayout('Pair', 'split', [h.w, other], ['test.desktop', null]);
    assert.equal(id, 'saved-layout-id');
    const saved = app.savedLayouts[0];
    assert.deepEqual(Array.from(saved.apps), ['test.desktop', 'other.desktop']);
    assert.deepEqual(Array.from(saved.pinned), ['test.desktop', null]);
    assert.deepEqual(Array.from(stored[0].pinned), ['test.desktop', null]);
    app.settings.get_string = () => JSON.stringify(stored);
    app.loadSavedLayouts();
    assert.deepEqual(Array.from(app.savedLayouts[0].pinned), ['test.desktop', null]);
    const plan = app.savedLayoutPlan(saved, 0, 0);
    assert.deepEqual(Array.from(plan.slots), [h.w, other]);
    assert.deepEqual(Array.from(plan.missing), []);
    app.layoutCandidates = () => [h.w];
    assert.deepEqual(Array.from(app.savedLayoutPlan(saved, 0, 0).missing), ['other.desktop']);
    const legacy = {slotCount: 2, pinned: ['test.desktop', 'other.desktop']};
    app.layoutCandidates = () => [h.w, other];
    assert.deepEqual(Array.from(app.savedLayoutPlan(legacy, 0, 0).slots), [h.w, other]);
});

test('a blank fixed-preset layout saves app IDs and pins without changing the current arrangement', () => {
    const h = harness(), app = h.app;
    app.savedLayouts = []; app.deletedLayouts = [];
    let stored;
    app.settings.set_string = (_key, value) => { stored = JSON.parse(value); };
    const before = h.frame();
    const apps = ['test.desktop', null, 'other.desktop', null];
    const pins = [null, null, 'other.desktop', null];
    assert.equal(app.saveNewLayout('Blank four', '2x2', apps, pins), 'saved-layout-id');
    assert.deepEqual(Array.from(stored[0].apps), apps);
    assert.deepEqual(Array.from(stored[0].pinned), pins);
    assert.deepEqual(h.frame(), before);
    app.settings.get_string = () => JSON.stringify(stored);
    app.loadSavedLayouts();
    assert.deepEqual(Array.from(app.savedLayouts[0].apps), apps);
    assert.equal(app.saveNewLayout('Auto', 'auto', apps, pins), false);
    assert.equal(app.saveNewLayout('Duplicate', '2x2',
        ['test.desktop', 'test.desktop', null, null], [null, null, null, null]), false);
    assert.equal(app.saveNewLayout('Invalid pin', '2x2', apps,
        ['other.desktop', null, null, null]), false);
});

test('editing a saved Auto layout preserves its slot count and saves changed apps and pins', () => {
    const h = harness(), app = h.app;
    app.savedLayouts = [{id: 'auto-edit', name: 'Auto saved', preset: 'auto', slotCount: 3,
        apps: ['test.desktop', 'test.desktop', null], pinned: [null, null, null]}];
    app.deletedLayouts = [];
    let stored;
    app.settings.set_string = (_key, value) => { stored = JSON.parse(value); };
    const before = h.frame();
    assert.equal(app.saveNewLayout('Auto saved', 'auto',
        ['other.desktop', 'legacy-app-id', null], ['other.desktop', null, null], 'auto-edit'), 'auto-edit');
    assert.equal(stored[0].preset, 'auto');
    assert.equal(stored[0].slotCount, 3);
    assert.deepEqual(Array.from(stored[0].apps), ['other.desktop', 'legacy-app-id', null]);
    assert.deepEqual(Array.from(stored[0].pinned), ['other.desktop', null, null]);
    assert.deepEqual(h.frame(), before);
});

test('replacing a saved layout requires its ID and preserves its position', () => {
    const h = harness(), app = h.app;
    app.savedLayouts = [
        {id: 'first', name: 'Work', preset: 'split', slotCount: 2,
            apps: ['old.desktop', null], pinned: [null, null]},
        {id: 'second', name: 'Other', preset: 'full', slotCount: 1,
            apps: [null], pinned: [null]},
    ];
    app.deletedLayouts = [];
    let stored;
    app.settings.set_string = (_key, value) => { stored = JSON.parse(value); };
    assert.equal(app.saveNewLayout('work', '2x2', ['test.desktop', null, null, null],
        [null, null, null, null]), false);
    assert.equal(app.saveNewLayout('work', '2x2', ['test.desktop', null, null, null],
        [null, null, null, null], 'second'), false);
    assert.equal(app.saveNewLayout('work', '2x2', ['test.desktop', null, null, null],
        [null, null, null, null], 'first'), 'first');
    assert.deepEqual(app.savedLayouts.map(item => item.id), ['first', 'second']);
    assert.equal(stored[0].name, 'work');
    assert.equal(stored[0].preset, '2x2');
    assert.deepEqual(Array.from(stored[0].apps), ['test.desktop', null, null, null]);
    assert.equal(app.saveLayout('Other', 'full', [h.w], [], 'second'), 'second');
    assert.deepEqual(app.savedLayouts.map(item => item.id), ['first', 'second']);
});

test('renaming a saved layout changes only its name and persists it', () => {
    const h = harness(), app = h.app;
    app.savedLayouts = [
        {id: 'first', name: 'Work', preset: 'split', slotCount: 2,
            apps: ['test.desktop', null], pinned: ['test.desktop', null]},
        {id: 'second', name: 'Other', preset: 'full', slotCount: 1,
            apps: [null], pinned: [null]},
    ];
    const before = JSON.parse(JSON.stringify(app.savedLayouts));
    const frame = h.frame();
    let writes = 0, stored;
    app.settings.set_string = (key, value) => {
        assert.equal(key, 'saved-layouts');
        writes++;
        stored = JSON.parse(value);
    };
    assert.equal(app.renameSavedLayout('missing', 'New'), false);
    assert.equal(app.renameSavedLayout('first', '  '), false);
    assert.equal(app.renameSavedLayout('first', 'other'), false);
    assert.equal(writes, 0);
    assert.equal(app.renameSavedLayout('first', 'Renamed work'), true);
    assert.equal(writes, 1);
    assert.deepEqual(stored, [{...before[0], name: 'Renamed work'}, before[1]]);
    assert.deepEqual(h.frame(), frame);
    assert.equal(app.renameSavedLayout('first', 'Renamed work'), true);
    assert.equal(writes, 1);
});

test('quick presets recover windows hidden by a saved layout without reviving manual minimization', () => {
    const h = harness(), app = h.app;
    app.key = () => 'workspace'; app.profileKey = () => 'profile';
    app.groups = new Map();
    app.profiles = {[app.profileKey(0, 0)]: {preset: 'full', pinned: []}};
    app.groups.set(app.key(0, 0), [null]);
    h.w.minimized = true;
    h.record.restoreParked = true;
    assert.deepEqual(Array.from(app.quickPresetPlan(0, 0, 'auto').windows), [h.w]);
    h.record.restoreParked = false;
    assert.deepEqual(Array.from(app.quickPresetPlan(0, 0, 'auto').windows), []);
    h.w.minimized = false;
    assert.equal(app.quickPresetPlan(0, 0, 'full').windows[0], h.w);
});

test('a saved layout is active only while its slots and pins still match', () => {
    const h = harness(), app = h.app;
    app.key = () => 'workspace'; app.profileKey = () => 'profile';
    app.groups = new Map();
    app.profiles = {[app.profileKey(0, 0)]: {preset: 'full', pinned: [null]}};
    app.groups.set(app.key(0, 0), [h.w]);
    const saved = {preset: 'full', slotCount: 1, apps: ['test.desktop'], pinned: [null]};
    assert.equal(app.savedLayoutActive(saved, 0, 0), true);
    app.groups.set(app.key(0, 0), [null]);
    assert.equal(app.savedLayoutActive(saved, 0, 0), false);
    app.groups.set(app.key(0, 0), [h.w]);
    app.profiles[app.profileKey(0, 0)].pinned = ['test.desktop'];
    assert.equal(app.savedLayoutActive(saved, 0, 0), false);
});

test('disable tolerates enable failing before settings are acquired', () => {
    const {app} = harness();
    delete app.settings;
    app.getSettings = () => { throw new Error('schema unavailable'); };
    assert.throws(() => app.enable(), /schema unavailable/);
    assert.doesNotThrow(() => app.disable());
});

test('closed pinned cards use the window grid despite trailing unpinned profile entries', () => {
    const h = harness(), app = h.app;
    h.shellMain.overview = {visible: false};
    app.spaceTransitions = new Set();
    app.key = () => 'workspace'; app.profileKey = () => 'profile'; app.activeSpace = () => 0;
    app.windows = () => [h.w];
    const pinned = Array.from({length: 16}, (_, i) => i < 15 ? `app-${i}.desktop` : null);
    app.profiles = {profile: {preset: 'auto', pinned}};
    app.pinnedSlotState = () => ({window: null, state: 'CLOSED'});
    const button = {
        set_size(width, height) { this.width = width; this.height = height; },
        set_position(x, y) { this.x = x; this.y = y; },
        set_style() {}, add_style_class_name() {}, remove_style_class_name() {},
        destroy() { assert.fail('the closed card should be reused'); },
    };
    app.pinnedPlaceholders = new Map([['0:8', {id: pinned[8], window: null, state: 'CLOSED',
        button, title: {set_width() {}}}]]);
    app.stackPinnedPlaceholders = () => {};
    const windows = pinned.slice(0, 15).map((id, i) => i === 8 ? null : {id}).filter(Boolean);
    const slots = geometry.reserveAppSlots(windows, pinned, w => w.id);
    assert.equal(slots.length, 15);
    app.groups = new Map([['workspace', slots]]);
    for (const [preset, count] of [['auto', 15], ['4x4', 15], ['auto', 15], ['4x3', 12], ['auto', 15]]) {
        app.profiles.profile.preset = preset;
        app.profiles.profile.pinned = pinned.map((id, i) => i < count ? id : null);
        app.groups.set('workspace', slots.slice(0, count));
        const tile = app.slotRects(0, count)[8];
        app.updatePinnedPlaceholders();
        assert.equal(button.x, tile.x + 7, `${preset}: the card belongs in tile 9`);
        assert.equal(button.y, tile.y + 7);
        assert.equal(button.width, tile.width - 14);
        assert.equal(button.height, tile.height - 14);
    }
});

test('pinned slot state distinguishes minimized, floating, elsewhere, opening, and closed apps', () => {
    const h = harness(), app = h.app, record = h.record;
    app.pendingLayoutApps = new Map();
    h.w.minimized = true;
    assert.equal(app.pinnedSlotState('TEST', 0, 0, 0).state, 'MINIMIZED');
    record.space = 1;
    assert.equal(app.pinnedSlotState('test.desktop', 0, 0, 0).state, 'OPEN ELSEWHERE');
    record.space = 0;
    record.floating = true;
    assert.equal(app.pinnedSlotState('test.desktop', 0, 0, 0).state, 'FLOATING');
    record.space = 1;
    assert.equal(app.pinnedSlotState('test.desktop', 0, 0, 0).state, 'OPEN ELSEWHERE');
    app.records.delete(h.w);
    assert.equal(app.pinnedSlotState('test.desktop', 0, 0, 0).state, 'CLOSED');
    app.pendingLayoutApps.set('test', {monitor: 0, space: 0, workspace: h.w.get_workspace()});
    assert.equal(app.pinnedSlotState('test.desktop', 0, 0, 0).state, 'OPENING');
});

test('deleted named layouts undo in reverse order without touching space profiles', () => {
    const h = harness(), app = h.app;
    const first = {id: 'one', name: 'One'}, second = {id: 'two', name: 'Two'};
    app.savedLayouts = [first, second];
    app.deletedLayouts = [];
    app.profiles = {space: {preset: 'split'}};
    app.settings.set_string = () => {};
    assert.equal(app.deleteSavedLayout('one'), true);
    assert.equal(app.deleteSavedLayout('two'), true);
    assert.equal(app.undoDeletedSavedLayout().id, 'two');
    assert.equal(app.undoDeletedSavedLayout().id, 'one');
    assert.deepEqual(app.savedLayouts.map(layout => layout.id), ['one', 'two']);
    assert.equal(app.deletedLayouts.length, 0);
    assert.equal(app.profiles.space.preset, 'split');
});

test('a persistently rejected size gets bounded retries then leaves tiling', () => {
    const h = harness();
    h.app.schedule = () => {};
    h.app.place(h.w, h.slot);
    h.commit({...h.slot, width: 800, height: 600});
    h.advance(100);
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 2, 'first bounded size repair');
    for (let i = 0; i < 15; i++) {
        h.commit({width: 810 + i * 3, height: 550 + i * 2});
        h.advance(200);
    }
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 3, 'no resize feedback loop');
    assert.equal(h.record.floating, false, 'size changes defer rejection while the client is settling');
    h.advance(1000);
    assert.equal(h.record.floating, true);
    assert.equal(h.actor.scale_x, 1);
    assert.equal(h.actor.scale_y, 1);
    assert.equal(h.timers.size, 0);
});

test('unmaximize preserves the backing plan across several size/position commits and duplicate notifications', () => {
    const h = harness(); h.app.schedule = () => {}; h.settleInitial();
    const backing = {...h.record.backingRect};
    h.special(3); h.commit({x: 0, y: 0, width: 1920, height: 1080});
    h.actor.__animationInfo = {}; h.special(0); h.advance(250);
    assert.equal(h.requests.length, 0, 'no writes during the compositor effect');
    h.effectsDone(); h.advance(1);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1], {type: 'resize', ...backing});
    h.commit(backing); h.advance(150);
    for (let i = 1; i <= 4; i++) {
        h.commit({x: h.slot.x + i * 22, y: h.slot.y + i * 15,
            width: h.slot.width + i * 10, height: h.slot.height + i * 8});
        h.advance(170);
        const correction = h.requests.at(-1);
        assert.equal(correction.type, 'move', 'late restoration repairs position without renegotiating size');
        h.commit({x: correction.x, y: correction.y});
    }
    h.advance(1600);
    assert.equal(h.record.restorePending, false);
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 3,
        'restoration stays position-only, then ordinary containment gets bounded retries');
    assert.equal(h.frame().x, h.slot.x); assert.equal(h.frame().y, h.slot.y);
    const before = h.requests.length;
    for (let i = 0; i < 10; i++) { h.commit({width: 800 + i, height: 550 + i}); h.advance(200); }
    h.advance(1000);
    assert.equal(h.requests.length, before, 'a floating client never creates a resize feedback loop');
    assert.equal(h.record.floating, true);
    assert.equal(h.timers.size, 0);
});

test('long compositor effects resume restoration without polling or corrupting the animation', () => {
    const h = harness(); h.settleInitial();
    h.actor.__animationInfo = {}; h.special(3); h.special(0); h.advance(2000);
    assert.equal(h.requests.length, 0); assert.equal(h.scaleWrites.length, 0);
    assert.equal(h.timers.size, 0, 'waits on effects-completed, not retry timeouts');
    h.effectsDone(); h.advance(1);
    assert.equal(h.requests.length, 2); assert.equal(h.record.restorePending, false);
});

test('fullscreen nested within maximize restores only when all special flags clear', () => {
    const h = harness(); h.settleInitial();
    h.special(3); h.special(3, true); h.special(3, false); h.advance(400);
    assert.equal(h.requests.length, 0);
    h.special(0); h.advance(250);
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 1);
});

test('all windows opened during fullscreen reflow together after fullscreen exit', () => {
    const h = harness(), app = h.app;
    h.settleInitial();
    const opened = Array.from({length: 3}, (_, index) => ({id: index, fullscreen: false,
        get_maximize_flags: () => 0}));
    for (const w of opened) app.records.set(w, {original: {}});
    app.groups = new Map([['0:0:0', [h.w]]]);
    app.profiles = {};
    app.windows = () => [h.w, ...opened];
    app.key = () => '0:0:0';
    app.profileKey = () => '0:0:0';
    app.options = () => ({preset: 'auto', gap: 0, padding: 0});
    app.area = () => ({x: 0, y: 0, width: 800, height: 600});
    const placed = [];
    app.place = (w, rect) => placed.push([w, rect]);
    app.schedule = compact => Object.getPrototypeOf(app).schedule.call(app, compact);
    h.special(0, true);
    app.tile(true);
    assert.equal(app.groups.get('0:0:0').length, 1);
    assert.equal(app.deferredRetile.has('0:0:0'), true);
    h.special(0, false);
    h.advance(1399);
    assert.equal(app.groups.get('0:0:0').length, 1, 'reflow waits for fullscreen restoration');
    h.advance(112);
    assert.equal(app.groups.get('0:0:0').length, 4);
    assert.deepEqual(placed.slice(-4).map(([w]) => w), [h.w, ...opened]);
    assert.equal(app.deferredRetile.has('0:0:0'), false);
});

test('synchronous geometry signals see the new target and cannot reenter placement', () => {
    const h = harness(); h.settleInitial();
    h.w.move_resize_frame = (_user, x, y, width, height) => {
        assert.equal(h.record.tileRect.x, 250);
        assert.equal(h.record.placing, true);
        h.commit({x, y, width, height});
        h.app.correctWindowScale(h.w);
    };
    h.app.place(h.w, {...h.slot, x: 250}); h.advance(300);
    assert.equal(h.record.placing, false);
    assert.equal(h.timers.size, 0);
});

test('a client rejecting every position correction has a finite request budget', () => {
    const h = harness(); h.settleInitial(); h.special(3); h.special(0); h.advance(200);
    h.requests.length = 0;
    for (let i = 1; i <= 30; i++) {
        h.commit({x: 100 + i, y: 50 + i});
        h.app.restoreWindowPlacement(h.w);
    }
    assert.equal(h.requests.filter(r => r.type === 'move').length, 8);
    h.advance(2000);
    assert.equal(h.requests.filter(r => r.type === 'move').length, 8);
    assert.equal(h.timers.size, 0);
});

test('grabs and stopped tiling suppress delayed scale and geometry writes', () => {
    const h = harness(); h.settleInitial(); h.grab(true);
    h.commit({width: 800}); h.advance(300);
    assert.equal(h.requests.length, 0); assert.equal(h.scaleWrites.length, 0);
    h.grab(false); h.app.running = false; h.app.scheduleWindowScale(h.w, 0); h.advance(1);
    assert.equal(h.requests.length, 0); assert.equal(h.scaleWrites.length, 0);
});

test('an explicit manual placement cancels the old restore transaction', () => {
    const h = harness(); h.settleInitial(); h.special(3); h.special(0);
    const manualSlot = {...h.slot, x: 700};
    h.app.place(h.w, manualSlot); h.commit(manualSlot); h.advance(2000);
    assert.equal(h.record.restorePending, false);
    assert.equal(h.requests.length, 2);
    assert.equal(h.record.tileRect.x, manualSlot.x);
    assert.equal(h.timers.size, 0);
});


test('ordinary delayed position drift is repaired without a resize', () => {
    const h = harness(); h.settleInitial();
    h.commit({x: h.slot.x + 80, y: h.slot.y + 50}); h.advance(200);
    assert.deepEqual(h.requests, [{type: 'move', x: h.slot.x, y: h.slot.y}]);
    h.commit({x: h.slot.x, y: h.slot.y}); h.advance(200);
    assert.equal(h.requests.length, 1);
});

test('an unlisted client rejecting its tile floats without compositor scaling', () => {
    const h = harness();
    let reflows = 0;
    h.app.schedule = compact => { assert.equal(compact, true); reflows++; };
    h.w.unmaximize = () => {};
    h.w.move_to_monitor = () => {};
    h.w.unminimize = () => {};
    h.record.original = h.app.snapshot(h.w);
    const target = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(800);
    assert.equal(h.record.floating, false, 'a slow resize remains tiled during the grace period');
    h.advance(1500);
    assert.equal(h.record.floating, true);
    assert.equal(h.record.tileRect, null);
    assert.equal(h.record.visualScale, 1);
    assert.equal(h.actor.scale_x, 1);
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.actor.translation_y, 0);
    assert.deepEqual(h.requests.at(-1), {type: 'resize', ...h.slot});
    assert.equal(reflows, 1);
});

test('an unlisted client accepting a delayed resize remains tiled at native scale', () => {
    const h = harness();
    const target = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({width: 800, height: 600});
    h.advance(850);
    assert.equal(h.record.floating, false);
    h.commit(target);
    h.advance(1800);
    assert.equal(h.record.floating, false);
    assert.equal(h.actor.scale_x, 1);
    assert.equal(h.record.visualScale, 1);
    assert.equal(h.timers.size, 0);
});

test('rapid layout changes do not classify delayed native resizes as floating', () => {
    const h = harness();
    const medium = {...h.slot, width: 500, height: 350};
    const final = {...h.slot, width: 625, height: 337};
    h.app.place(h.w, h.slot);
    h.advance(100);
    h.app.place(h.w, medium);
    h.advance(2200);
    h.app.place(h.w, final);
    h.commit(medium); // a response to the earlier layout arrives after the final request
    h.advance(2500);
    assert.equal(h.record.floating, false);
    h.commit(final);
    h.advance(1000);
    assert.equal(h.record.floating, false);
    assert.equal(h.record.visualScale, 1);
});

test('a resize still rejected after rapid-layout settling can float', () => {
    const h = harness();
    let reflows = 0;
    h.app.schedule = () => { reflows++; };
    h.app.place(h.w, h.slot);
    h.advance(100);
    h.app.place(h.w, {...h.slot, width: 500, height: 350});
    h.advance(100);
    h.app.place(h.w, {...h.slot, width: 625, height: 337});
    h.commit({width: 500, height: 350});
    h.advance(6500);
    assert.equal(h.record.floating, true);
    assert.equal(reflows, 1);
});

test('a newly accepted tile stays managed when an older layout commits afterward', () => {
    const h = harness();
    h.app.place(h.w, h.slot);
    h.advance(200);
    assert.equal(h.record.nativeFitSizes.length, 1);
    const intermediate = {...h.slot, width: 500, height: 350};
    const final = {...h.slot, width: 625, height: 337};
    h.app.place(h.w, intermediate);
    h.advance(100);
    h.app.place(h.w, final);
    h.commit(final);
    h.advance(200); // the current tile matches before the old configure arrives
    assert.equal(h.record.nativeFitSizes.length, 2);
    h.commit(intermediate);
    h.advance(7500);
    assert.equal(h.record.floating, false);
    assert.ok(h.requests.some(request => request.type === 'resize' &&
        request.width === final.width && request.height === final.height));
    h.commit(final);
    h.advance(1200);
    assert.equal(h.record.floating, false);
    assert.equal(h.record.visualScale, 1);
});

test('scale-to-fit includes X11 titlebar extents in the minimum frame size', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    h.w.get_min_size = () => [true, 700, 356];
    h.w.client_rect_to_frame_rect = rect => ({...rect, height: rect.height + 37});
    const target = {...h.slot, width: 625, height: 337};
    h.app.place(h.w, target);
    const minimum = h.app.minimumSize(h.w);
    assert.equal(minimum.width, 700);
    assert.equal(minimum.height, 393);
    assert.deepEqual(h.requests.at(-1),
        {type: 'resize', x: target.x, y: target.y, width: 729, height: 393});
    h.commit({width: 729, height: 393}); h.advance(200);
    assert.ok(Math.abs(h.record.visualScale * 729 - target.width) < 1);
    assert.ok(Math.abs(h.record.visualScale * 393 - target.height) < 1);
});

test('only configured applications use scale-to-fit fallback', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    h.w.get_min_size = () => [true, 800, 600];
    const target = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, target);
    assert.deepEqual(h.requests.at(-1), {type: 'resize', x: target.x, y: target.y, width: 800, height: 600});
    h.commit({x: target.x, y: target.y, width: 800, height: 600});
    h.advance(200);
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.scale_y, 0.5);
});

test('scaled backing size does not accumulate across tile aspect changes', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    const first = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, first);
    h.commit({width: 800, height: 500}); h.advance(100);
    assert.equal(h.record.scaleMinimum.width, 800);
    assert.equal(h.record.scaleMinimum.height, 500);
    h.commit({width: 800, height: 600}); h.advance(200);
    assert.equal(h.record.visualScale, 0.5);

    const second = {...first, width: 300, height: 300};
    h.app.place(h.w, second);
    assert.equal(h.record.backingRect.width, 800);
    assert.equal(h.record.backingRect.height, 800);
    h.commit({width: 800, height: 800}); h.advance(200);
    assert.equal(h.record.visualScale, 0.375);

    h.app.place(h.w, first);
    assert.equal(h.record.backingRect.width, 800);
    assert.equal(h.record.backingRect.height, 600);
    assert.equal(h.record.visualScale, 0.375, 'old backing frame remains contained until resize commits');
    h.commit({width: 800, height: 600}); h.advance(200);
    assert.equal(h.record.visualScale, 0.5);
    assert.equal(h.record.scaleMinimum.width, 800);
    assert.equal(h.record.scaleMinimum.height, 500);
});

test('moving a scaled exception keeps its fitted size during placement', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    h.w.get_min_size = () => [true, 800, 600];
    const first = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, first);
    h.commit({x: first.x, y: first.y, width: 800, height: 600});
    h.advance(200);
    assert.equal(h.actor.scale_x, 0.5);
    h.scaleWrites.length = 0;
    const second = {...first, x: 900, y: 500};
    h.app.place(h.w, second);
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.scale_y, 0.5);
    assert.ok(h.scaleWrites.every(([x, y]) => x === 0.5 && y === 0.5));
    assert.equal(h.actor.translation_x, second.x - first.x);
    assert.equal(h.actor.translation_y, second.y - first.y);
    assert.deepEqual(h.requests.at(-1), {type: 'move', x: second.x, y: second.y});
});

test('resetting a scaled window clears its visual translation', () => {
    const h = harness(); h.settleInitial();
    h.actor.translation_x = 250; h.actor.translation_y = 120;
    h.app.resetWindowScale(h.w);
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.actor.translation_y, 0);
});

test('placing an unchanged constrained tile preserves native scale', () => {
    const h = harness();
    const target = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(200);
    h.requests.length = 0; h.scaleWrites.length = 0;
    h.app.place(h.w, {...target});
    assert.equal(h.actor.scale_x, 1);
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.requests.length, 0);
    h.advance(1);
    assert.ok(h.scaleWrites.every(([x, y]) => x === 1 && y === 1));
});

test('moving a constrained window between equal slots keeps native scale', () => {
    const h = harness();
    const first = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, first);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(200);
    h.requests.length = 0; h.scaleWrites.length = 0;
    const second = {...first, x: 200, y: 100};
    h.app.place(h.w, second);
    assert.equal(h.actor.scale_x, 1);
    assert.ok(h.scaleWrites.every(([x, y]) => x === 1 && y === 1));
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.actor.translation_y, 0);
    assert.deepEqual(h.requests, [
        {type: 'move', x: second.x, y: second.y},
        {type: 'resize', ...second},
    ]);
});

test('post-grab validation restores allowlisted scale-to-fit transforms', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    const target = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({...target, width: 800, height: 600});
    h.advance(200);
    assert.equal(h.actor.scale_x, 0.5);
    h.app.validateTransformsAfterGrab();
    h.advance(300);
    h.actor.set_scale(1, 1);
    h.actor.translation_x = 90;
    h.actor.translation_y = 60;
    h.advance(400);
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.scale_y, 0.5);
    assert.equal(h.actor.translation_x, target.x - h.frame().x);
    assert.equal(h.actor.translation_y, target.y - h.frame().y);
});

test('a managed asynchronous monitor drift keeps ownership of its target monitor', () => {
    const h = harness(); h.settleInitial();
    h.monitor(1);
    h.commit({x: h.slot.x + 900});
    h.advance(200);
    assert.equal(h.record.monitor, 0);
    assert.deepEqual(h.requests, [{type: 'move', x: h.slot.x, y: h.slot.y}]);
});

test('same-slot drop reapplies a scaled transform synchronously', () => {
    const h = harness();
    h.app.settings.get_strv = key => key === 'scaled-apps' ? ['test.desktop'] : [];
    h.w.get_min_size = () => [true, 800, 600];
    const target = {...h.slot, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({width: 800, height: 600}); h.advance(200);
    h.actor.set_scale(1, 1);
    h.app.place(h.w, {...target});
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.scale_y, 0.5);
});

test('ordinary position repairs have a finite budget reset by explicit placement', () => {
    const h = harness(); h.settleInitial();
    for (let i = 1; i <= 20; i++) {
        h.commit({x: h.slot.x + i * 3}); h.advance(200);
    }
    assert.equal(h.requests.length, 8);
    assert.ok(h.requests.every(r => r.type === 'move'));
    h.app.place(h.w, h.slot); h.commit(h.slot); h.advance(300);
    h.requests.length = 0;
    h.commit({x: h.slot.x + 30}); h.advance(200);
    assert.equal(h.requests.length, 1);
});

test('ordinary position repair respects grabs, floating and stopped tiling', () => {
    for (const mode of ['grab', 'floating', 'stopped']) {
        const h = harness(); h.settleInitial();
        if (mode === 'grab') h.grab(true);
        if (mode === 'floating') h.record.floating = true;
        if (mode === 'stopped') h.app.running = false;
        h.commit({x: h.slot.x + 80}); h.advance(300);
        assert.equal(h.requests.length, 0, mode);
    }
});

test('dropping a window back into its own slot does not retile other windows', () => {
    const h = harness(); h.settleInitial();
    h.app.key = () => 'workspace';
    h.app.groups = new Map([['workspace', [h.w]]]);
    let labelHidden = 0;
    h.app.preview = {hide() {}};
    h.app.previewLabel = {hide() { labelHidden++; }};
    const checkpoint = {before: true};
    h.app.drag = {window: h.w, monitor: 0, target: {monitor: 0, index: 0}, checkpoint};
    let placements = 0, tiles = 0, borders = 0;
    h.app.pushCheckpoint = () => assert.fail('same-slot drop must not create an undo checkpoint');
    h.app.place = (w, rect) => {
        assert.equal(w, h.w); assert.deepEqual(rect, h.record.tileRect); placements++;
    };
    h.app.tile = () => tiles++;
    h.app.updateBorder = () => borders++;
    h.app.grabEnd();
    assert.equal(placements, 1);
    assert.equal(tiles, 0);
    assert.equal(borders, 1);
    assert.equal(labelHidden, 1);
});

test('moving to another slot commits the checkpoint captured before dragging', () => {
    const h = harness(); h.settleInitial();
    const other = {};
    h.app.key = () => 'workspace';
    h.app.groups = new Map([['workspace', [h.w, null, other]]]);
    h.app.preview = {hide() {}};
    h.app.previewLabel = {hide() {}};
    const checkpoint = {before: true};
    h.app.drag = {window: h.w, monitor: 0, target: {monitor: 0, index: 1, window: other}, checkpoint};
    const pushed = [];
    h.app.pushCheckpoint = state => pushed.push(state);
    let tiles = 0; h.app.tile = () => tiles++;
    h.app.grabEnd();
    assert.deepEqual(pushed, [checkpoint]);
    assert.equal(h.app.groups.get('workspace')[0], other);
    assert.equal(h.app.groups.get('workspace')[1], null);
    assert.equal(h.app.groups.get('workspace')[2], h.w);
    assert.equal(tiles, 1);
});

test('appearance changes update the border without rearranging windows', () => {
    const {app} = harness();
    let borders = 0, arrangements = 0;
    app.updateBorder = () => borders++;
    app.schedule = () => arrangements++;
    for (const key of ['active-border', 'border-color', 'border-width', 'border-style', 'border-custom-color']) app.settingsChanged(key);
    for (const key of ['animations', 'animation-speed', 'animation-duration', 'animation-curve']) app.settingsChanged(key);
    assert.equal(borders, 5);
    assert.equal(arrangements, 0);
    app.settingsChanged('padding-left');
    assert.equal(arrangements, 1);
});

test('window radius reads both HiDPI edges from one full window render', async () => {
    const calls = [], width = 512, height = 800, stride = width * 4;
    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (y < 24 && (x < 24 || x >= width - 24)) continue;
        pixels[y * stride + x * 4 + 3] = 255;
    }
    const pixbuf = {get_pixels: () => pixels, get_rowstride: () => stride,
        get_n_channels: () => 4, get_width: () => width, get_height: () => height, get_has_alpha: () => true};
    const {app, actor, w} = harness({screenshot: {async composite_to_stream(...args) { calls.push(args); return pixbuf; }}});
    actor.visible = true;
    actor.get_scale = () => [1, 1];
    actor.get_resource_scale = () => 2;
    let renders = 0;
    actor.paint_to_content = () => { renders++; return {get_texture: () => ({get_width: () => 1200, get_height: () => 800})}; };
    app.windowEffectActive = () => false;
    app.visualWindowRect = () => ({x: 100, y: 50, width: 600, height: 400});
    app.radiusReadbackReady = true;
    const radius = await app.measureWindowRadius(w);
    assert.deepEqual({...radius}, {top: 12, bottom: 0, topRight: 12, bottomRight: 0});
    assert.equal(calls.length, 2);
    assert.equal(renders, 1);
    assert(calls.every(args => args[3] === 512 && args[4] === 800));
    assert.equal(calls[0][1], 0); assert.equal(calls[1][1], 688);
});

test('focus refreshes cached corner geometry after the client decoration repaint', () => {
    const {app, w, record, advance, shellDisplay} = harness();
    let refreshes = 0;
    app.running = true;
    app.hideWindowActions = () => {};
    app.updateBorder = () => {};
    app.queueWindowActions = () => {};
    app.publishPreviewState = () => {};
    app.invalidateWindowRadius = target => { assert.equal(target, w); refreshes++; };
    record.windowRadius = {top: 4, topRight: 0, bottom: 0, bottomRight: 0};
    shellDisplay.focus_window = w;
    app.focusChanged();
    advance(249); assert.equal(refreshes, 0);
    advance(1); assert.equal(refreshes, 1);
    app.focusChanged();
    advance(100);
    app.focusChanged();
    advance(150); assert.equal(refreshes, 1);
    advance(100); assert.equal(refreshes, 2);
});

test('SnapTess preferences are never tiled or treated as a tile drag or resize', () => {
    for (const title of ['SnapTess', 'SnapTess Preferences']) {
        const h = harness();
        h.w.get_title = () => title;
        h.w.get_gtk_application_id = () => 'org.gnome.Shell.Extensions';
        assert.equal(h.app.eligible(h.w), false);
        assert.equal(h.app.windows(0).length, 0);
        let linkedResizeAttempts = 0;
        h.app.beginLinkedResize = () => linkedResizeAttempts++;
        for (const op of [1, 5]) h.app.grabBegin(h.w, op);
        assert.equal(linkedResizeAttempts, 0);
        assert.equal(h.app.drag, null);
    }
});

test('preferences exclusion also recognizes WM_CLASS without excluding other extension preferences', () => {
    const {app, w} = harness();
    w.get_title = () => 'SnapTess Preferences';
    w.get_wm_class = () => 'org.gnome.Shell.Extensions';
    assert.equal(app.eligible(w), false);
    w.get_title = () => 'Other Extension';
    assert.equal(app.eligible(w), true);
    w.get_title = () => 'SnapTess Preferences';
    w.get_wm_class = () => 'org.example.Editor';
    assert.equal(app.eligible(w), true);
});

test('preferences are released when Wayland supplies their identity after creation', () => {
    const {app, w, notifyWindow} = harness();
    let retile = 0;
    app.schedule = () => retile++;
    app.hideWindowActions = () => {};
    w.get_title = () => 'SnapTess Preferences';
    w.get_wm_class = () => 'org.gnome.Shell.Extensions';
    assert(app.records.has(w));
    notifyWindow('notify::wm-class');
    assert.equal(app.records.has(w), false);
    assert.equal(retile, 1);
});

test('custom templates preserve geometry on save, reload, replacement and restore', () => {
    const h = harness(), app = h.app;
    const tiles = [{x: 0, y: 0, width: .6, height: 1}, {x: .6, y: 0, width: .4, height: 1}];
    app.savedLayouts = []; app.deletedLayouts = [];
    let stored;
    app.settings.set_string = (_key, value) => { stored = value; };
    assert.equal(app.saveNewLayout('Custom pair', 'custom', ['test.desktop', null],
        ['test.desktop', null], null, tiles), 'saved-layout-id');
    assert.deepEqual(JSON.parse(stored)[0].tiles, tiles);
    tiles[0].width = .5;
    assert.equal(app.savedLayouts[0].tiles[0].width, .6); // No mutable draft references.
    app.settings.get_string = () => stored;
    app.loadSavedLayouts();
    assert.equal(app.savedLayouts.length, 1);
    assert.equal(app.saveNewLayout('Invalid', 'custom', ['test.desktop', null], [null, null], null, tiles), false);
    let restored;
    app.layoutCandidates = () => [h.w]; app.appId = () => 'test.desktop';
    app.applyProfiles = changes => { restored = changes[0]; };
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.restoreSavedLayout('saved-layout-id', 0, 0);
    assert.equal(restored.preset, 'custom');
    assert.equal(restored.tiles.length, 2); assert.equal(restored.slotCount, 2);
    assert.equal(restored.tiles[0].width, .6);
});

test('Arrange again resets custom resize offsets while keeping the saved custom preset', () => {
    const h = harness(), app = h.app;
    const tiles = [{x: 0, y: 0, width: .65, height: 1}, {x: .65, y: 0, width: .35, height: 1}];
    app.profileKey = () => '0:0:0'; app.activeSpace = () => 0;
    const key = app.profileKey(0, 0);
    app.profiles = {[key]: {preset: 'custom', tiles, slotCount: 2, apps: [], pinned: [],
        resize: {preset: 'custom', count: 2, offsets: [[0,0,.05,0],[.05,0,-.05,0]]}}};
    app.history = []; app.groups = new Map(); app.spaces = new Map(); app.settings.set_string = () => {};
    let placed;
    app.tile = () => { placed = app.slotRects(0, 2); };
    app.arrangeAgain();
    assert.equal(app.profiles[key].resize, undefined);
    assert.deepEqual(app.profiles[key].tiles, tiles);
    const base = geometry.layout(app.area(0), 2, app.options(0, 0));
    assert.deepEqual(placed, base);
    assert.equal(JSON.parse(app.history[0].profiles)[key].resize.count, 2);
});

function sharingHarness() {
    const h = harness(), app = h.app;
    app.groups = new Map([['0:0:0', [h.w]]]); app.profiles = {}; app.history = [];
    app.workspaceIndex = () => 0;
    app.key = (monitor, space = app.activeSpace(monitor)) => `0:${monitor}:${space}`;
    app.profileKey = (monitor, space = app.activeSpace(monitor)) => `${monitor}:${space}`;
    app.snapshot = () => ({}); app.restore = () => {};
    app.tile = () => {}; app.updatePanelStatus = () => {}; app.notifyStatus = () => {};
    app.exitSwap = () => {}; app.hideGuides = () => {};
    app.createSpaceTransition = () => null; app.playSpaceTransition = () => {};
    h.w.move_to_monitor = value => h.monitor(value);
    h.w.minimize = () => { h.w.minimized = true; };
    h.w.unminimize = () => { h.w.minimized = false; };
    h.w.get_stable_sequence = () => 42; h.w.get_pid = () => 1234;
    return h;
}

test('sharing preserves source slots and geometry, switches visibility and supports Undo', () => {
    const {app, w} = sharingHarness();
    const source = {preset: 'custom', apps: ['test.desktop'], pinned: [],
        tiles: [{x: 0, y: 0, width: 1, height: 1}], resize: {marker: 'source'}};
    app.profiles['0:0'] = source;
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [w]}]);
    assert.equal(app.groups.get('0:0:0')[0], w);
    assert.equal(app.groups.get('0:0:1')[0], w);
    assert.equal(app.profiles['0:0'], source);
    assert.equal(app.profiles['0:0'].resize.marker, 'source');
    assert.deepEqual([...app.windowSpaces(w)], [0, 1]);
    assert.equal(w.minimized, false);
    app.switchSpace(0, 0);
    assert.equal(w.minimized, false);
    app.switchSpace(2, 0);
    assert.equal(w.minimized, true);
    app.switchSpace(1, 0);
    assert.equal(w.minimized, false);
    app.undo();
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(app.windowInSpace(w, 1), false);
    assert.equal(app.groups.has('0:0:1'), false);
});

test('saved layouts reuse a window from another Space without launching or parking source extras', () => {
    const {app, w} = sharingHarness();
    app.layoutCandidates = () => [];
    const plan = app.savedLayoutPlan({apps: ['test.desktop'], pinned: [], slotCount: 1}, 0, 1);
    assert.equal(plan.slots[0], w);
    assert.equal(plan.missing.length, 0);
    assert.equal(plan.extras.length, 0);
});

test('live identity restores memberships after reload but never matches another process', () => {
    const {app, w, record} = sharingHarness();
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [w]}]);
    record.spaces = null; record.space = 0;
    app.restoreWindowSharing(w, record);
    assert.deepEqual([...record.spaces], [0, 1]);
    record.spaces = null; w.get_pid = () => 9999;
    app.restoreWindowSharing(w, record);
    assert.equal(record.spaces, null);
});

test('removing a shared window from one layout preserves its other assignment', () => {
    const {app, w} = sharingHarness();
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [w]}]);
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [], parkUnused: [w]}]);
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(app.windowInSpace(w, 1), false);
    assert.equal(app.records.get(w).parked, true);
    app.switchSpace(0, 0);
    assert.equal(w.minimized, false);
    assert.equal(app.groups.get('0:0:0')[0], w);
});

test('one native window can occupy multiple Space plans but never two slots in one plan', () => {
    const {app, w} = sharingHarness();
    app.applyProfiles([
        {monitor: 0, space: 0, preset: 'split', windows: [w, w]},
        {monitor: 0, space: 1, preset: 'full', windows: [w]},
    ]);
    assert.equal(app.groups.get('0:0:0')[0], w);
    assert.equal(app.groups.get('0:0:0')[1], null);
    assert.equal(app.groups.get('0:0:1')[0], w);
    assert.deepEqual([...app.windowSpaces(w)], [0, 1]);
});

test('surplus windows retain their sole membership so Auto can restore them', () => {
    const {app, w} = sharingHarness();
    app.applyProfiles([{monitor: 0, space: 0, preset: 'full', windows: [], parkUnused: [w]}]);
    assert.equal(app.records.get(w).restoreParked, true);
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(app.windows(0, 0, true)[0], w);
});

test('removing a shared assignment without parkUnused hides it only in the removed Space', () => {
    const {app, w} = sharingHarness();
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [w]}]);
    app.applyProfiles([{monitor: 0, space: 1, preset: 'auto', windows: [], pinned: []}]);
    assert.equal(app.windowInSpace(w, 1), false);
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(w.minimized, true);
    assert.equal(app.records.get(w).parked, true);
    app.switchSpace(0, 0);
    assert.equal(w.minimized, false);
    assert.equal(app.groups.get('0:0:0')[0], w);
});

test('resetting one shared Space preserves both other profiles, memberships and slots', () => {
    const {app, w} = sharingHarness();
    app.applyProfiles([
        {monitor: 0, space: 0, preset: '4x4', windows: [w], pinned: ['test.desktop']},
        {monitor: 0, space: 1, preset: 'master', windows: [w], pinned: ['test.desktop']},
        {monitor: 0, space: 2, preset: 'split', windows: [w], pinned: ['test.desktop']},
    ]);
    const source = JSON.stringify(app.profiles['0:0']), third = JSON.stringify(app.profiles['0:2']);
    const sourceSlots = [...app.groups.get('0:0:0')], thirdSlots = [...app.groups.get('0:0:2')];
    app.applyProfiles([{monitor: 0, space: 1, preset: 'auto', windows: [], pinned: [], reset: true}]);
    assert.equal(JSON.stringify(app.profiles['0:0']), source);
    assert.equal(JSON.stringify(app.profiles['0:2']), third);
    assert.deepEqual([...app.groups.get('0:0:0')], sourceSlots);
    assert.deepEqual([...app.groups.get('0:0:2')], thirdSlots);
    assert.deepEqual([...app.windowSpaces(w)], [0, 2]);
    assert.equal(app.profiles['0:1'].preset, 'auto');
    assert.equal(app.profiles['0:1'].pinned.length, 0);
});

test('Reset empties the selected tile group and floats local windows without changing other Spaces', () => {
    const {app, w} = sharingHarness();
    const shared = {...w, minimized: false, get_stable_sequence: () => 43};
    shared.minimize = () => { shared.minimized = true; };
    shared.unminimize = () => { shared.minimized = false; };
    app.records.set(shared, {space: 1, spaces: new Set([0, 1]), floating: false, parked: false});
    app.records.get(w).space = 1;
    app.groups = new Map([['0:0:0', [shared]], ['0:0:1', [shared, w]]]);
    app.profiles = {'0:0': {preset: '4x4', apps: ['test.desktop'], pinned: [], resize: {count: 1}}};
    const original = JSON.stringify(app.profiles['0:0']);
    app.applyProfiles([{monitor: 0, space: 1, preset: 'auto', windows: [], pinned: [], reset: true}]);
    assert.equal(app.groups.get('0:0:1').length, 0);
    assert.equal(app.records.get(w).floating, true);
    assert.equal(app.records.has(w), true, 'local window remains open');
    assert.equal(app.windowInSpace(shared, 0), true);
    assert.equal(app.windowInSpace(shared, 1), false);
    assert.equal(shared.minimized, true);
    assert.equal(app.groups.get('0:0:0')[0], shared);
    assert.equal(JSON.stringify(app.profiles['0:0']), original);
    app.undo();
    assert.equal(app.records.get(w).floating, false);
    assert.equal(app.windowInSpace(shared, 1), true);
    assert.equal(app.groups.get('0:0:1').length, 2);
});

test('Clear tile floats only the removed local window and preserves neighboring slots', () => {
    const {app, w} = sharingHarness();
    const other = {...w, minimized: false, get_stable_sequence: () => 44};
    other.minimize = () => { other.minimized = true; };
    other.unminimize = () => { other.minimized = false; };
    app.records.set(other, {space: 0, floating: false, parked: false});
    app.applyProfiles([{monitor: 0, space: 0, preset: 'split', windows: [null, other],
        pinned: [], releaseWindows: [w], preserveSlots: true}]);
    assert.equal(app.records.get(w).floating, true);
    assert.equal(app.records.get(other).floating, false);
    assert.equal(app.records.has(w), true);
    assert.equal(app.groups.get('0:0:0')[1], other);
    assert.equal(app.groups.get('0:0:0')[0], null);
    assert.equal(app.profiles['0:0'].slotCount, 2);
});

test('Apply opens an assigned app and claims its exact unpinned tile', () => {
    const {app, w, launches} = sharingHarness();
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.applyProfiles([{monitor: 0, space: 1, preset: 'master', windows: [null, null, null],
        apps: [null, null, 'test.desktop'], pinned: [], preserveSlots: true}]);
    assert.deepEqual(launches, ['test.desktop']);
    assert.equal(app.pendingLayoutApps.get('test').index, 2);
    assert.equal(app.profiles['0:1'].pinned.length, 0, 'assignment does not implicitly pin the app');
    app.eligible = () => true; app.schedule = () => {};
    assert.equal(app.claimLayoutWindow(w), true);
    assert.equal(app.groups.get('0:0:1')[2], w);
    assert.equal(app.groups.get('0:0:1')[0], null);
    assert.equal(app.profiles['0:1'].pendingApps.length, 0);
});

test('a launch appearing after a minute retains its exact Space and tile without a timeout notification', () => {
    const {app, w, advance, timers, shellMain, launches} = sharingHarness();
    timers.clear();
    const notifications = [];
    shellMain.notify = (...args) => notifications.push(args);
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.applyProfiles([{monitor: 0, space: 1, preset: 'master', windows: [null, null, null],
        apps: [null, null, 'test.desktop'], pinned: [], preserveSlots: true}]);
    advance(60000);
    assert.equal(app.pendingLayoutApps.get('test').index, 2);
    assert.equal(notifications.length, 0);
    app.eligible = () => true; app.schedule = () => {};
    assert.equal(app.claimLayoutWindow(w), true);
    assert.equal(app.groups.get('0:0:1')[2], w);
    assert.equal(app.windowInSpace(w, 1), true);
    assert.equal(app.pendingLayoutApps.size, 0);
    assert.deepEqual(launches, ['test.desktop']);
});

test('a pinned-card launch remains pending until its window appears or its tile is cleared', () => {
    const {app, w, advance, timers} = sharingHarness();
    timers.clear();
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.launchLayoutApps(['test.desktop'], 0, 1, w.get_workspace());
    advance(60000);
    assert.equal(app.pendingLayoutApps.has('test'), true);
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [null],
        apps: [], pinned: ['test.desktop'], preserveSlots: true}]);
    assert.equal(app.pendingLayoutApps.has('test'), true, 'keeping the pin keeps the launch request');
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [null],
        apps: [], pinned: [], preserveSlots: true}]);
    assert.equal(app.pendingLayoutApps.size, 0, 'clearing the tile cancels the launch request');
    assert.equal(app.claimLayoutWindow(w), false);
});

test('pending destinations survive a runtime reload and claim a window opened while disabled', () => {
    const {app, w, advance, timers} = sharingHarness();
    timers.clear(); app.restorePendingLaunches(); app.updatePinnedPlaceholders = () => {};
    app.applyProfiles([0, 1].map(space => ({monitor: 0, space, preset: 'master',
        windows: [null, null, null], apps: space === 0 ? ['test.desktop', null, null] : [null, null, 'test.desktop'],
        pinned: [], preserveSlots: true})));
    const pending = app.pendingLayoutApps;
    advance(60000);
    app.pendingLayoutApps = new Map(); app.restorePendingLaunches();
    assert.equal(app.pendingLayoutApps, pending, 'the same session owns the pending request');
    app.groups.clear(); // Fresh runtime groups have not been tiled yet.
    app.eligible = () => true; app.schedule = () => {}; app.running = false;
    assert.equal(app.claimLayoutWindow(w), true);
    assert.equal(app.groups.get('0:0:0')[0], w);
    assert.equal(app.groups.get('0:0:1')[2], w);
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(app.windowInSpace(w, 1), true);
    assert.equal(app.profiles['0:1'].pendingApps.length, 0);
    assert.equal(w.minimized, false, 'reloading a paused extension does not hide the arriving window');
    assert.equal(pending.size, 0);
});

test('one pending installed app can be assigned to two Spaces without launching twice', () => {
    const {app, w, launches} = sharingHarness();
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.applyProfiles([0, 1].map(space => ({monitor: 0, space, preset: 'split',
        windows: [null, null], apps: space === 0 ? ['test.desktop', null] : [null, 'test.desktop'],
        pinned: [], preserveSlots: true})));
    assert.deepEqual(launches, ['test.desktop']);
    app.eligible = () => true; app.schedule = () => {};
    assert.equal(app.claimLayoutWindow(w), true);
    assert.equal(app.windowInSpace(w, 0), true);
    assert.equal(app.windowInSpace(w, 1), true);
    assert.equal(app.groups.get('0:0:0')[0], w);
    assert.equal(app.groups.get('0:0:1')[1], w);
});

test('clearing a launching app in one Space keeps its pending assignment in another', () => {
    const {app, w, launches} = sharingHarness();
    app.pendingLayoutApps = new Map(); app.updatePinnedPlaceholders = () => {};
    app.applyProfiles([0, 1].map(space => ({monitor: 0, space, preset: 'full',
        windows: [null], apps: ['test.desktop'], pinned: [], preserveSlots: true})));
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [null],
        apps: [], pinned: [], preserveSlots: true}]);
    assert.deepEqual(launches, ['test.desktop']);
    app.eligible = () => true; app.schedule = () => {};
    assert.equal(app.claimLayoutWindow(w), true);
    assert.equal(app.groups.get('0:0:0')[0], w);
    assert.equal(app.groups.get('0:0:1')[0], null);
    assert.equal(app.windowInSpace(w, 1), false);
});

test('a New layout can save the app identity selected from an open window', () => {
    const {app} = harness();
    app.appId = () => 'WindowBackedApp'; app.savedLayouts = [];
    const id = app.saveNewLayout('Open window template', 'full', ['WindowBackedApp'], [null]);
    assert.equal(id, 'saved-layout-id');
    assert.equal(app.savedLayouts[0].apps[0], 'WindowBackedApp');
    assert.equal(app.saveNewLayout('Unknown identity', 'full', ['NotAnOpenApp'], [null]), false);
});

test('a window made floating keeps its size, centred on its display, never maximized', () => {
    const h = harness(), app = h.app;
    let unmaximized = 0;
    h.w.unmaximize = () => { unmaximized++; h.w.flags = 0; };
    app.resetWindowScale = () => {};
    app.placeFloating(h.w, {x: 1500, y: 900, width: 500, height: 300, monitor: 1, maximized: 0});
    assert.deepEqual(h.requests.at(-1), {type: 'resize', x: 150, y: 150, width: 500, height: 300});
    h.w.flags = 3;
    app.placeFloating(h.w, {x: 0, y: 0, width: 800, height: 600, monitor: 0, maximized: 3});
    assert.equal(unmaximized, 1);
    assert.deepEqual(h.requests.at(-1), {type: 'resize', x: 40, y: 30, width: 720, height: 540});
});
