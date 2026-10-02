import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Linked resize: ${message}`); };
const keys = ['x', 'y', 'width', 'height'];
export async function run() {
    await Scripting.sleep(1200);
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime;
    assert(app, 'runtime loaded');
    for (let i = 0; i < 15; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await Scripting.sleep(400);
    app.settings.set_boolean('independent-padding', true);
    for (const [edge, value] of [['top', 7], ['right', 19], ['bottom', 31], ['left', 43]])
        app.settings.set_int(`padding-${edge}`, value);
    app.setRunning(true); await Scripting.sleep(500);
    const device = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => device.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    let frames = 0, failure = null, worstUpdate = 0, settling = null, stoppedPid = 0;
    const originalUpdate = app.updateLinkedResize.bind(app);
    app.updateLinkedResize = () => {
        const start = GLib.get_monotonic_time();
        originalUpdate();
        worstUpdate = Math.max(worstUpdate, (GLib.get_monotonic_time() - start) / 1000);
    };
    const sample = global.stage.connect('after-paint', () => {
        const grab = app.resizeGrab?.updated ? app.resizeGrab : settling;
        if (!grab?.updated || failure) return;
        frames++;
        grab.slots.forEach((w, i) => {
            const actor = app.windowActor(w), frame = w.get_frame_rect(), buffer = w.get_buffer_rect();
            const [x, y] = actor.get_transformed_position();
            const visible = {x: x + (frame.x - buffer.x) * actor.scale_x,
                y: y + (frame.y - buffer.y) * actor.scale_y,
                width: frame.width * actor.scale_x, height: frame.height * actor.scale_y};
            const target = grab.updated[i];
            if (keys.some(key => Math.abs(visible[key] - target[key]) > 1.1))
                failure = `frame ${frames}, tile ${i}: ${JSON.stringify(visible)} != ${JSON.stringify(target)}`;
        });
    });
    try {
        for (const [index, op, dx, dy] of [
            [0, Meta.GrabOp.RESIZING_E, 24, 0], [1, Meta.GrabOp.RESIZING_W, -14, 0],
            [4, Meta.GrabOp.RESIZING_S, 0, 12], [0, Meta.GrabOp.RESIZING_SE, 3, 3],
            [4, Meta.GrabOp.RESIZING_NW, -3, -3], [0, Meta.GrabOp.RESIZING_W, -4, 0],
        ]) {
            const slots = app.groups.get(app.key(0)), w = slots[index];
            const target = app.slotRects(0, slots.length)[index];
            w.activate(global.get_current_time()); await Scripting.sleep(100);
            const x = target.x + target.width / 2;
            const y = target.y + target.height / 2;
            move(x, y); await Scripting.sleep(30);
            device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
            await Scripting.sleep(24);
            assert(w.begin_grab_op(op, Clutter.get_default_backend().get_pointer_sprite(global.stage), global.get_current_time(), null), `native resize grab begins for tile ${index} (grabbed=${global.display.is_grabbed()})`);
            await Scripting.sleep(40);
            assert(app.resizeGrab, `SnapTess handles the native grab: running=${app.running} busy=${app.busy} drag=${!!app.drag} floating=${app.records.get(w)?.floating} grabbed=${global.display.is_grabbed()} op=${op}`);
            const travel = [...Array.from({length: 18}, (_, n) => n + 1),
                ...Array.from({length: 9}, (_, n) => 17 - n)];
            for (const step of travel) {
                if (op === Meta.GrabOp.RESIZING_E && step === 8) {
                    stoppedPid = w.get_pid();
                    assert(stoppedPid > 1, 'test client has a process ID');
                    Gio.Subprocess.new(['kill', '-STOP', String(stoppedPid)], Gio.SubprocessFlags.NONE).wait_check(null);
                }
                if (stoppedPid && step === 12) {
                    Gio.Subprocess.new(['kill', '-CONT', String(stoppedPid)], Gio.SubprocessFlags.NONE).wait_check(null);
                    stoppedPid = 0;
                }
                move(x + dx * step, y + dy * step);
                await Scripting.sleep(24);
            }
            const last = app.resizeGrab.updated ?? app.resizeGrab.rects;
            settling = {slots, updated: last};
            device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
            await Scripting.sleep(350);
            assert(!app.resizeGrab && !app.resizeLater, 'release cancels the frame callback');
            const saved = app.slotRects(0, slots.length);
            assert(saved.every((r, i) => keys.every(key => r[key] === last[i][key])), 'release preserves displayed geometry');
            assert(slots.every(window => !app.records.get(window).floating), 'every window stays tiled');
            const area = w.get_workspace().get_work_area_for_monitor(0);
            assert(Math.min(...saved.map(r => r.x)) === area.x + 43 &&
                Math.min(...saved.map(r => r.y)) === area.y + 7 &&
                Math.max(...saved.map(r => r.x + r.width)) === area.x + area.width - 19 &&
                Math.max(...saved.map(r => r.y + r.height)) === area.y + area.height - 31,
                'native linked resizing preserves independent outer margins');
        }
        assert(!Main.overview.visible, 'desktop remains visible during native resizing');
        assert(!failure, failure);
        assert(frames > 30, `sampled enough actual compositor frames (${frames})`);
        if (GLib.getenv('SNAPTESS_RESIZE_SCREENSHOT')) {
            const stream = Gio.File.new_for_path(GLib.getenv('SNAPTESS_RESIZE_SCREENSHOT'))
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
            const m = Main.layoutManager.monitors[0];
            await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
            stream.close(null);
        }
        console.log(`SNAPTESS_LINKED_RESIZE_PASSED frames=${frames} worstUpdateMs=${worstUpdate.toFixed(2)}`);
    } finally {
        if (stoppedPid) Gio.Subprocess.new(['kill', '-CONT', String(stoppedPid)], Gio.SubprocessFlags.NONE).wait_check(null);
        global.stage.disconnect(sample);
        device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        app.setRunning(false);
        await Scripting.destroyTestWindows();
    }
}
