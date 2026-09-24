import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as geometry from '../lib/layout.js';

// Execute the actual runtime methods with asynchronous client commits and a
// deterministic clock. GI imports alone are replaced; no duplicate restore code.
const source = fs.readFileSync(new URL('../runtime.js', import.meta.url), 'utf8')
    .replace(/^import [^;]+;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../runtime.js', import.meta.url).href))
    .replace('export default class SnapTess', 'class SnapTess') + '\nSnapTess;';
function harness() {
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
    const workspace = {};
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
        ...geometry, Extension: class {}, console,
        Date: class extends Date { static now() { return now; } },
        GLib: {file_get_contents() { throw new Error('trace disabled'); }},
        Main: {layoutManager: {monitors: [{}]}, notify() {}},
        Shell: {AppSystem: {get_default: () => ({lookup_app: id => id === 'test.desktop'
            ? {get_app_info: () => ({launch: () => { launches.push(id); return true; }})} : null})}},
        Meta: {WindowType: {NORMAL: 0}, GrabOp: {MOVING: 1, KEYBOARD_MOVING: 2}},
        global: {display: {is_grabbed: () => grabbed, focus_window: null}, get_pointer: () => pointer,
            workspace_manager: {get_active_workspace: () => workspace}, get_window_actors: () => [actor]},
    });
    const app = new Runtime();
    Object.assign(app, {records: new Map(), spaces: new Map(), running: true, busy: false, drag: null,
        settings: {get_strv: () => [], get_boolean: () => false}});
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
        effectsDone, settleInitial, frame: () => frame, grab: value => { grabbed = value; },
        monitor: value => { monitor = value; }, pointer: (x, y) => { pointer = [x, y]; }};
}

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
