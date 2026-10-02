import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Shared Spaces: ${message}`); };
const pause = () => Scripting.sleep(400);
const geometry = w => { const r = w.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(','); };
export async function run() {
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    console.log('SNAPTESS_SHARING_START');
    for (let i = 0; i < 16; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.settings.set_strv('scaled-apps', [...new Set([...app.records.keys()].map(w => app.appId(w)))]);
    app.setRunning(true); await pause();
    const windows = app.windows(0), w = windows[0]; assert(windows.length === 16, 'native windows tracked');
    app.applyProfiles([{monitor: 0, space: 0, preset: '4x4', windows, pinned: windows.map(w => app.appId(w))}]); await pause();
    const sourceGeometry = geometry(w), sourceProfile = JSON.stringify(app.profiles[app.profileKey(0, 0)]);
    app.openStudio(); await pause();
    const studio = app.studio; studio.changeContext(0, 1); studio.select(0);
    assert(studio.showLibrary && studio.libraryButton.label === 'Back to layout', 'empty tile opens the app picker');
    studio.appCatalogSections.windows.header.emit('clicked', 1);
    studio.appCatalogSections.windows.rows[0].row.emit('clicked', 1);
    const shared = studio.draft[0], before = geometry(shared);
    assert(!studio.dirtyContexts.has('0:0') && studio.dirtyContexts.has('0:1'), 'source draft kept');
    for (let i = 0; i < 2; i++) {
        studio.selected = i + 1; studio.assignWindow(windows[i + 1]);
    }
    studio.choosePreset('master'); studio.apply(); await pause();
    assert(app.windowInSpace(shared, 0) && app.windowInSpace(shared, 1), 'same native window in both Spaces');
    assert(app.groups.get(app.key(0, 0)).includes(shared), 'source slots kept');
    const {sharedWindows, ...keptProfile} = app.profiles[app.profileKey(0, 0)];
    assert(JSON.stringify(keptProfile) === sourceProfile, 'source profile kept');
    assert(app.profiles[app.profileKey(0, 0)].pinned.length === 16 &&
        app.profiles[app.profileKey(0, 0)].apps.length === 16,
        'sharing three windows never adds three source profile entries');
    // Also reproduce a profile containing residual unpinned positions from older arrangements.
    app.profiles[app.profileKey(0, 0)].pinned.push(null, null, null);
    app.settings.set_string('profiles', JSON.stringify(app.profiles));
    const destination = geometry(shared);
    app.switchSpace(0, 0); await pause();
    assert(!shared.minimized && geometry(shared) === before, 'source frame restored');
    assert(app.groups.get(app.key(0, 0)).length === 16 && app.windows(0, 0).length === 16,
        '4x4 with sixteen windows stays sixteen slots after sharing three in Focus');
    app.switchSpace(1, 0); await pause();
    assert(!shared.minimized && geometry(shared) === destination, 'destination frame restored');
    app.switchSpace(2, 0); await pause(); assert(shared.minimized, 'unassigned Space parks window');
    app.switchSpace(0, 0); await pause(); assert(!shared.minimized, 'assigned Space restores parked window');
    app.openStudio(); await pause();
    const clearStudio = app.studio; clearStudio.changeContext(0, 1); clearStudio.select(1);
    const cleared = clearStudio.draft[1], kept = clearStudio.draft[2];
    assert(clearStudio.removeAppButton.visible && clearStudio.removeAppButton.label === 'Clear tile', 'selected tile exposes Clear tile');
    clearStudio.removeAppButton.emit('clicked', 1);
    assert(!clearStudio.draft[1] && app.windowInSpace(cleared, 1), 'Clear is a draft without desktop changes');
    clearStudio.undo(); assert(clearStudio.draft[1] === cleared, 'Undo restores cleared assignment');
    clearStudio.redo(); assert(!clearStudio.draft[1], 'Redo clears assignment');
    clearStudio.apply(); await pause();
    assert(!app.windowInSpace(cleared, 1) && app.windowInSpace(cleared, 0) && app.records.has(cleared), 'Clear removes only target membership without closing window');
    assert(app.groups.get(app.key(0, 1)).length === 2 && app.groups.get(app.key(0, 1)).includes(kept),
        'Clear reflows the adaptive target while preserving its remaining windows');
    app.undo(); await pause();
    const portableSource = () => { const {sharedWindows, ...profile} = app.profiles[app.profileKey(0, 0)]; return JSON.stringify(profile); };
    const unchangedSource = portableSource();
    const unchangedSlots = [...app.groups.get(app.key(0, 0))];
    app.openStudio(); await pause();
    const resetStudio = app.studio; resetStudio.changeContext(0, 1); resetStudio.reset();
    assert(resetStudio.preset === 'auto' && resetStudio.draft.length === 0 &&
        resetStudio.pins.length === 0 && resetStudio.hint.text.includes('Other spaces are unchanged'),
        'Reset removes shared assignments from only the selected draft');
    assert(app.windowInSpace(shared, 1), 'Reset remains a draft until Apply');
    resetStudio.undo(); assert(resetStudio.draft.length === 3, 'Studio Undo restores the three removed assignments');
    resetStudio.redo(); assert(resetStudio.draft.length === 0, 'Studio Redo removes them again');
    resetStudio.apply(); await pause();
    assert(app.windows(0, 1).length === 0 && shared.minimized && !app.windowInSpace(shared, 1),
        'Apply after Reset leaves the selected Space empty');
    assert(portableSource() === unchangedSource &&
        unchangedSlots.every((w, i) => app.groups.get(app.key(0, 0))[i] === w),
        'Reset and Apply preserve every source profile field and every source slot');
    app.switchSpace(0, 0); await pause();
    assert(app.windows(0, 0).length === 16 && geometry(shared) === before,
        'Reset in Space 2 never changes the original 4x4 arrangement in Space 1');
    app.undo(); await pause();
    app.applyProfiles([{monitor: 0, space: 1, preset: 'auto', windows: [], pinned: []}]); await pause();
    assert(!app.windowInSpace(shared, 1) && shared.minimized && app.windows(0, 1).length === 0,
        'clearing shared assignments leaves the destination empty and parks its windows');
    app.switchSpace(0, 0); await pause();
    assert(app.windows(0, 0).length === 16 && !shared.minimized && geometry(shared) === before,
        'clearing another Space keeps all sixteen source windows and their original geometry');
    app.undo(); await pause();
    assert(app.windowInSpace(shared, 1), 'Undo restores cleared shared assignments');
    app.undo(); await pause();
    assert(app.windowInSpace(shared, 0) && !app.windowInSpace(shared, 1), 'Undo removes only destination assignment');
    const plan = app.savedLayoutPlan({apps: [app.appId(w)], pinned: [], slotCount: 1}, 0, 1);
    assert(plan.slots[0] && plan.missing.length === 0, 'saved template reuses existing window');
    app.applyProfiles([{monitor: 0, space: 1, preset: 'full', windows: [w]}]); await pause();
    app.setRunning(false); await pause(); app.setRunning(true); await pause();
    assert(app.windowInSpace(w, 0) && app.windowInSpace(w, 1), 'toggle restores live memberships');
    app.switchSpace(0, 0); await pause();
    assert(!w.minimized && geometry(w) === sourceGeometry, 'toggle preserves original layout geometry');
    app.switchSpace(1, 0); await pause();
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const local = [...app.records.keys()].find(item => !windows.includes(item));
    assert(local && app.windowInSpace(local, 1) && !app.windowInSpace(local, 0),
        'a window opened in Space 2 belongs only to Space 2');
    app.openStudio(); await pause();
    const mixedReset = app.studio; mixedReset.changeContext(0, 1); mixedReset.reset();
    assert(mixedReset.draft.length === 0,
        'Reset clears both local and shared tile assignments');
    mixedReset.apply(); await pause();
    assert(app.records.get(local).floating && !local.minimized && app.windows(0,1).length === 0 && !app.windowInSpace(w, 1),
        'Apply returns local windows to floating and removes the shared assignments');
    app.switchSpace(0, 0); await pause();
    assert(app.windows(0, 0).length === 16 && geometry(w) === sourceGeometry,
        'a mixed Reset also keeps the original sixteen-window arrangement intact');
    app.undo(); await pause();
    local.delete(global.get_current_time()); await pause();
    app.switchSpace(0, 0); await pause();
    if (Main.layoutManager.monitors.length > 1) {
        app.applyProfiles([{monitor: 1, space: 0, preset: 'full', windows: [w]}]); await pause();
        assert(w.get_monitor() === 1 && !app.groups.get(app.key(0, 0)).includes(w) &&
            !(app.groups.get(app.key(0, 1)) ?? []).includes(w), 'another display moves instead of sharing');
    }
    app.setRunning(false); await pause();
    await Scripting.destroyTestWindows();
    app.openStudio(); await pause();
    const picker = app.studio; picker.changeContext(0, 2); picker.reset(); picker.choosePreset('master');
    const recordCount = app.records.size;
    picker.select(2);
    const sections = picker.appCatalogSections;
    assert(!sections.windows.body.visible && !sections.installed.body.visible, 'both app sections default to collapsed');
    sections.installed.header.emit('clicked', 1);
    const search = sections.installed.search, rows = sections.installed.rows.map(item => item.row);
    sections.windows.search.set_text('no matching open window');
    assert(search.get_text() === '', 'section search fields are independent');
    const info = Shell.AppSystem.get_default().get_installed().find(info => info.get_id()?.endsWith('.desktop') && info.should_show());
    assert(info, 'installed application catalog available');
    search.set_text(info.get_id());
    const row = rows.find(row => row.accessible_name === `Assign ${info.get_name()} (${info.get_id()}) to tile 3`);
    assert(row?.visible, 'search finds installed app for selected empty tile');
    row.emit('clicked', 1);
    assert(picker.apps[2] === info.get_id() && !picker.pins[2] && !picker.draft[2] && app.records.size === recordCount,
        'choosing installed app records an unpinned draft assignment without opening it');
    if (GLib.getenv('SNAPTESS_TILE_ACTIONS_SCREENSHOT')) {
        await pause();
        const stream = Gio.File.new_for_path(GLib.getenv('SNAPTESS_TILE_ACTIONS_SCREENSHOT'))
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        const m = Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
        stream.close(null);
    }
    picker.removeAppButton.emit('clicked', 1);
    assert(!picker.apps[2], 'Clear tile also removes a pending app');
    picker.undo(); assert(picker.apps[2] === info.get_id(), 'Undo restores pending app');
    picker.redo(); assert(!picker.apps[2], 'Redo clears pending app');
    picker.dialog.close();
    console.log('SNAPTESS_SHARED_SPACES_TESTS_PASSED');
}
