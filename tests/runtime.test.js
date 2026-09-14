import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as geometry from '../lib/layout.js';

// Execute the actual runtime methods with asynchronous client commits and a
// deterministic clock. GI imports alone are replaced; no duplicate restore code.
const source = fs.readFileSync(new URL('../runtime.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../runtime.js', import.meta.url).href))
    .replace('export default class SnapTess', 'class SnapTess') + '\nSnapTess;';
function harness() {
    let now = 1000, nextId = 1, grabbed = false;
    const timers = new Map(), signals = new Map(), actorSignals = new Map();
    const requests = [], scaleWrites = [];
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
        get_monitor: () => 0, get_workspace: () => workspace,
        get_window_type: () => 0, is_override_redirect: () => false,
        is_on_all_workspaces: () => false, get_min_size: () => [false, 0, 0],
        connect(name, fn) { signals.set(name, fn); return nextId++; }, disconnect() {},
        move_resize_frame(_user, x, y, width, height) {
            requests.push({type: 'resize', x, y, width, height});
        },
        move_frame(_user, x, y) { requests.push({type: 'move', x, y}); },
    };
    const Runtime = vm.runInNewContext(source, {
        ...geometry, Extension: class {}, console,
        Date: class extends Date { static now() { return now; } },
        GLib: {file_get_contents() { throw new Error('trace disabled'); }},
        Meta: {WindowType: {NORMAL: 0}, GrabOp: {MOVING: 1, KEYBOARD_MOVING: 2}},
        global: {display: {is_grabbed: () => grabbed, focus_window: null},
            workspace_manager: {get_active_workspace: () => workspace}, get_window_actors: () => [actor]},
    });
    const app = new Runtime();
    Object.assign(app, {records: new Map(), spaces: new Map(), running: true, busy: false, drag: null});
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
    return {app, w, actor, record, requests, scaleWrites, slot, timers, advance, commit, special,
        effectsDone, settleInitial, frame: () => frame, grab: value => { grabbed = value; }};
}

test('successive asynchronous replies cannot feed backing-size negotiation indefinitely', () => {
    const h = harness();
    h.app.place(h.w, h.slot);
    h.commit({...h.slot, width: 800, height: 600});
    h.advance(100);
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 2, 'initial size plus one backing fit');
    for (let i = 0; i < 15; i++) {
        h.commit({width: 810 + i * 3, height: 550 + i * 2});
        h.advance(200);
    }
    assert.equal(h.requests.length, 2, 'client rounding/constraints do not generate new configure requests');
    assert.ok(h.actor.scale_x < 1);
    assert.ok(h.frame().width * h.actor.scale_x <= h.slot.width + 0.001);
    assert.ok(h.frame().height * h.actor.scale_y <= h.slot.height + 0.001);
    assert.equal(h.timers.size, 0);
});

test('unmaximize preserves the backing plan across several size/position commits and duplicate notifications', () => {
    const h = harness(); h.settleInitial();
    const backing = {...h.record.backingRect};
    h.special(3); h.commit({x: 0, y: 0, width: 1920, height: 1080});
    h.actor.__animationInfo = {}; h.special(0); h.advance(250);
    assert.equal(h.requests.length, 0, 'no writes during the compositor effect');
    h.effectsDone(); h.advance(1);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0], {type: 'resize', ...backing});
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
    assert.equal(h.requests.filter(r => r.type === 'resize').length, 1);
    assert.equal(h.frame().x, h.slot.x); assert.equal(h.frame().y, h.slot.y);
    const before = h.requests.length;
    for (let i = 0; i < 10; i++) { h.commit({width: 800 + i, height: 550 + i}); h.advance(200); }
    assert.equal(h.requests.length, before, 'scale updates after the restore deadline never resize');
    assert.equal(h.timers.size, 0);
});

test('long compositor effects resume restoration without polling or corrupting the animation', () => {
    const h = harness(); h.settleInitial();
    h.actor.__animationInfo = {}; h.special(3); h.special(0); h.advance(2000);
    assert.equal(h.requests.length, 0); assert.equal(h.scaleWrites.length, 0);
    assert.equal(h.timers.size, 0, 'waits on effects-completed, not retry timeouts');
    h.effectsDone(); h.advance(1);
    assert.equal(h.requests.length, 1); assert.equal(h.record.restorePending, false);
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
    assert.equal(h.requests.length, 1);
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

test('a clamped oversized backing window is translated into its visual slot', () => {
    const h = harness();
    const target = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(200);
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.translation_x, 400);
    assert.equal(h.actor.translation_y, 200);
});

test('resetting a scaled window clears its visual translation', () => {
    const h = harness(); h.settleInitial();
    h.actor.translation_x = 250; h.actor.translation_y = 120;
    h.app.resetWindowScale(h.w);
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.actor.translation_y, 0);
});

test('placing an unchanged constrained tile preserves its transform', () => {
    const h = harness();
    const target = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, target);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(200);
    h.requests.length = 0; h.scaleWrites.length = 0;
    h.app.place(h.w, {...target});
    assert.equal(h.actor.scale_x, 0.5);
    assert.equal(h.actor.translation_x, 400);
    assert.equal(h.requests.length, 0);
    h.advance(1);
    assert.ok(h.scaleWrites.every(([x, y]) => x === 0.5 && y === 0.5));
});

test('moving a constrained window between equal slots never resets its scale', () => {
    const h = harness();
    const first = {...h.slot, x: 1200, y: 700, width: 400, height: 300};
    h.app.place(h.w, first);
    h.commit({x: 800, y: 500, width: 800, height: 600});
    h.advance(200);
    h.requests.length = 0; h.scaleWrites.length = 0;
    const second = {...first, x: 200, y: 100};
    h.app.place(h.w, second);
    assert.equal(h.actor.scale_x, 0.5);
    assert.ok(h.scaleWrites.every(([x, y]) => x === 0.5 && y === 0.5));
    assert.equal(h.actor.translation_x, second.x - h.frame().x);
    assert.equal(h.actor.translation_y, second.y - h.frame().y);
    assert.deepEqual(h.requests, [{type: 'resize', x: second.x, y: second.y, width: 800, height: 600}]);
});

test('post-grab validation repairs a stale constrained-window transform', () => {
    const h = harness();
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
    assert.equal(h.actor.translation_x, 0);
    assert.equal(h.actor.translation_y, 0);
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
    h.app.preview = {hide() {}};
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
});

test('moving to another slot commits the checkpoint captured before dragging', () => {
    const h = harness(); h.settleInitial();
    const other = {};
    h.app.key = () => 'workspace';
    h.app.groups = new Map([['workspace', [h.w, other]]]);
    h.app.preview = {hide() {}};
    const checkpoint = {before: true};
    h.app.drag = {window: h.w, monitor: 0, target: {monitor: 0, index: 1}, checkpoint};
    const pushed = [];
    h.app.pushCheckpoint = state => pushed.push(state);
    let tiles = 0; h.app.tile = () => tiles++;
    h.app.grabEnd();
    assert.deepEqual(pushed, [checkpoint]);
    assert.equal(h.app.groups.get('workspace')[0], other);
    assert.equal(h.app.groups.get('workspace')[1], h.w);
    assert.equal(tiles, 1);
});
