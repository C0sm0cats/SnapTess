import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Close gaps: ${message}`); };
const pause = () => Scripting.sleep(500);
const frame = w => { const r = w.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(','); };
const slots = (app, monitor = 0) => (app.groups.get(app.key(monitor)) ?? []).map(w => w ? 'w' : '-').join('');
async function openWindows(app, count) {
    const before = new Set(app.records.keys());
    for (let i = 0; i < count; i++) await Scripting.createTestWindow({width: 160, height: 120});
    await Scripting.waitTestWindows();
    for (let n = 0; n < 30 && [...app.records.keys()].filter(w => !before.has(w)).length < count; n++)
        await Scripting.sleep(100);
    await Scripting.sleep(800);
    return [...app.records.keys()].filter(w => !before.has(w));
}
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: close-gaps-shell.js');
    await Scripting.sleep(1000); Main.overview.hide(); await pause();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry.stateObj.runtime;
    assert(app, 'runtime loaded');
    const settings = app.settings;
    const saved = ['compact-close', 'compact-minimize'].map(key => [key, settings.get_boolean(key)]);
    const scaled = settings.get_strv('scaled-apps');
    try {
        settings.set_boolean('compact-close', false);
        settings.set_boolean('compact-minimize', false);
        const windows = await openWindows(app, 4);
        assert(windows.length === 4, `four windows tracked, got ${windows.length}`);
        settings.set_strv('scaled-apps', [...scaled, app.appId(windows[0])]);
        app.setRunning(true); await pause();
        const group = [...app.groups.get(app.key(0))];
        assert(group.length === 4 && group.every(Boolean), `four tiled slots, got ${slots(app)}`);
        const closed = group[1], others = group.filter(w => w !== closed);

        closed.minimize(); await pause();
        assert(slots(app) === 'w-ww', `minimize keeps the gap with the setting off, got ${slots(app)}`);
        closed.unminimize(); await pause();
        assert(slots(app) === 'wwww', `unminimize refills the gap, got ${slots(app)}`);
        await Scripting.sleep(1500);
        const geometry = others.map(frame);

        // Mutter removes a closing window from its workspace (workspace-changed)
        // before it emits unmanaged; the close setting must still decide.
        closed.delete(global.get_current_time());
        for (let n = 0; n < 30 && app.records.has(closed); n++) await Scripting.sleep(100);
        assert(!app.records.has(closed), 'closed window untracked');
        await pause();
        assert(slots(app) === 'w-ww', `close keeps the gap with the setting off, got ${slots(app)}`);
        assert(others.every((w, i) => frame(w) === geometry[i]),
            `close leaves the other tiles in place: ${others.map(frame).join(' ')} vs ${geometry.join(' ')}`);

        // A window sent to another GNOME workspace from Space 2 joins that
        // workspace's active Space and is tiled there.
        for (const w of others) w.delete(global.get_current_time());
        for (let n = 0; n < 30 && app.records.size; n++) await Scripting.sleep(100);
        await pause();
        app.switchSpace(1, 0); await pause();
        const [moved] = await openWindows(app, 1);
        assert(moved && app.records.get(moved).space === 1, 'window opened in Space 2');
        const manager = global.workspace_manager;
        const target = manager.get_workspace_by_index(1) ?? manager.append_new_workspace(false, global.get_current_time());
        moved.change_workspace(target); await pause();
        target.activate(global.get_current_time()); await pause();
        assert(moved.get_workspace() === target, 'window moved to the second workspace');
        assert(app.records.get(moved).space === app.activeSpace(moved.get_monitor(), target) &&
            app.records.get(moved).spaces === null, 'moved window joins the target workspace active Space');
        const [next] = await openWindows(app, 1);
        assert(next?.get_workspace() === target, 'new window opened on the second workspace');
        await pause();
        assert(frame(moved) !== frame(next), `moved and new windows are tiled apart: ${frame(moved)} ${frame(next)}`);
    } finally {
        for (const [key, value] of saved) settings.set_boolean(key, value);
        settings.set_strv('scaled-apps', scaled);
        await Scripting.destroyTestWindows();
    }
    console.log('SNAPTESS_CLOSE_GAPS_TESTS_PASSED');
}
