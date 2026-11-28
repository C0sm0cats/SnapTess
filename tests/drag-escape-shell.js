import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Drag Escape: ${message}`); };
const keys = ['x', 'y', 'width', 'height'];
const same = (a, b) => keys.every(key => Math.abs(a[key] - b[key]) <= 1);
const rect = r => `${r.x},${r.y},${r.width}x${r.height}`;

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: drag-escape-shell.js');
    await Scripting.sleep(1200);
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime;
    assert(app, 'runtime loaded');
    for (let i = 0; i < 3; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await Scripting.sleep(400);
    app.setRunning(true); await Scripting.sleep(600);
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const button = state => pointer.notify_button(GLib.get_monotonic_time(), 1, state);
    const press = async key => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        await Scripting.sleep(40);
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
        await Scripting.sleep(60);
    };
    const sprite = () => global.stage.context.get_backend().get_pointer_sprite(global.stage);
    const slots = () => [...(app.groups.get(app.key(0)) ?? [])];
    const frames = () => slots().map(w => w.get_frame_rect());
    const centre = r => [r.x + r.width / 2, r.y + r.height / 2];

    // Presses the tile, starts a native grab with `op`, travels `steps` times by
    // (dx, dy), then either presses Escape before releasing or just releases.
    const pointerGrab = async (index, op, start, dx, dy, escape) => {
        const w = slots()[index];
        w.activate(global.get_current_time()); await Scripting.sleep(150);
        const [x, y] = start;
        move(x, y); await Scripting.sleep(40);
        button(Clutter.ButtonState.PRESSED); await Scripting.sleep(30);
        assert(w.begin_grab_op(op, sprite(), global.get_current_time(), null), `grab ${op} begins`);
        await Scripting.sleep(60);
        for (let step = 1; step <= 20; step++) { move(x + dx * step, y + dy * step); await Scripting.sleep(32); }
        await Scripting.sleep(120);
        if (escape) { await press(Clutter.KEY_Escape); await Scripting.sleep(120); }
        button(Clutter.ButtonState.RELEASED);
        await Scripting.sleep(600);
        assert(!global.display.is_grabbed() && !app.drag && !app.resizeGrab, 'grab has ended');
    };

    try {
        assert(slots().length === 3, `three tiles (${slots().length})`);
        const tiles = app.slotRects(0, 3);
        const order = slots(), history = app.history.length;

        // Moving a window over another tile and pressing Escape cancels the swap.
        let w0 = order[0];
        await pointerGrab(0, Meta.GrabOp.MOVING, centre(tiles[0]),
            (centre(tiles[2])[0] - centre(tiles[0])[0]) / 20, (centre(tiles[2])[1] - centre(tiles[0])[1]) / 20, true);
        assert(slots().every((w, i) => w === order[i]),
            `Escape during a move keeps the tile order (${slots().map(w => order.indexOf(w))})`);
        assert(app.history.length === history, `Escape during a move records no undo step (${app.history.length} vs ${history})`);
        assert(same(w0.get_frame_rect(), tiles[0]),
            `Escape during a move puts the window back on its tile (${rect(w0.get_frame_rect())} vs ${rect(tiles[0])})`);

        // Releasing the same move without Escape still swaps.
        await pointerGrab(0, Meta.GrabOp.MOVING, centre(tiles[0]),
            (centre(tiles[2])[0] - centre(tiles[0])[0]) / 20, (centre(tiles[2])[1] - centre(tiles[0])[1]) / 20, false);
        assert(slots()[2] === w0 && slots()[0] === order[2], 'a released move still swaps the tiles');
        assert(app.history.length === history + 1, 'a released move records one undo step');

        // Resizing a tile edge and pressing Escape keeps the proportions.
        const before = app.slotRects(0, 3), historyResize = app.history.length;
        const savedBefore = JSON.stringify(app.profiles[app.profileKey(0, app.activeSpace(0))]?.resize ?? null);
        const edge = [before[0].x + before[0].width - 2, before[0].y + before[0].height / 2];
        await pointerGrab(0, Meta.GrabOp.RESIZING_E, edge, 10, 0, true);
        const after = app.slotRects(0, 3);
        assert(after.every((r, i) => same(r, before[i])),
            `Escape during a resize keeps the tiles (${after.map(rect)} vs ${before.map(rect)})`);
        assert(frames().every((r, i) => same(r, before[i])),
            `Escape during a resize restores every window (${frames().map(rect)})`);
        assert(JSON.stringify(app.profiles[app.profileKey(0, app.activeSpace(0))]?.resize ?? null) === savedBefore,
            'Escape during a resize saves no proportions');
        assert(app.history.length === historyResize, 'Escape during a resize records no undo step');

        // Releasing the same resize without Escape still changes the proportions.
        await pointerGrab(0, Meta.GrabOp.RESIZING_E, edge, 10, 0, false);
        assert(!same(app.slotRects(0, 3)[0], before[0]), 'a released resize still changes the proportions');
        assert(app.history.length === historyResize + 1, 'a released resize records one undo step');

        // A keyboard move (Alt+F7) cancelled by Escape leaves the tiles alone.
        const keyboardOrder = slots(), keyboardHistory = app.history.length, keyboardTiles = app.slotRects(0, 3);
        const k0 = keyboardOrder[0];
        const keyboardMove = async finish => {
            k0.activate(global.get_current_time()); await Scripting.sleep(150);
            move(...centre(keyboardTiles[0])); await Scripting.sleep(40);
            assert(k0.begin_grab_op(Meta.GrabOp.KEYBOARD_MOVING, sprite(), global.get_current_time(), null),
                'keyboard move begins');
            await Scripting.sleep(100);
            assert(app.drag?.window === k0, 'SnapTess follows the keyboard move');
            // Mutter keeps the pointer on the moved window: walk it onto another tile.
            for (let i = 0; i < 120 && (app.drag?.target?.index ?? 0) === 0; i++) await press(Clutter.KEY_Right);
            await Scripting.sleep(200);
            assert(app.drag?.target?.window && app.drag.target.window !== k0,
                `the keyboard move reaches another tile (${app.drag?.target?.index})`);
            await press(finish);
            await Scripting.sleep(600);
            assert(!global.display.is_grabbed() && !app.drag, 'keyboard move has ended');
        };
        await keyboardMove(Clutter.KEY_Escape);
        assert(slots().every((w, i) => w === keyboardOrder[i]),
            `Escape during a keyboard move keeps the tile order (${slots().map(w => keyboardOrder.indexOf(w))})`);
        assert(app.history.length === keyboardHistory, 'Escape during a keyboard move records no undo step');
        assert(same(k0.get_frame_rect(), keyboardTiles[0]), 'Escape during a keyboard move keeps the window on its tile');

        // Confirming the same keyboard move with Return still swaps.
        await keyboardMove(Clutter.KEY_Return);
        assert(slots()[0] !== k0 && app.history.length === keyboardHistory + 1,
            'a keyboard move confirmed with Return still swaps the tiles');

        console.log('SNAPTESS_TEST_PASSED: drag-escape-shell.js');
    } finally {
        button(Clutter.ButtonState.RELEASED);
        app.setRunning(false);
        await Scripting.destroyTestWindows();
    }
}
