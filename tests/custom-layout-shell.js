import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Custom layout: ${message}`); };
const pause = () => Scripting.sleep(300);
export async function run() {
    await Scripting.sleep(1000); Main.overview.hide();
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    for (let i = 0; i < 3; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.setRunning(true); await pause();
    const windows = app.windows(0), before = JSON.stringify(app.profiles);
    app.openStudio(); await pause();
    const studio = app.studio;
    studio.openNewLayout(); studio.choosePreset('custom'); await pause();
    assert(studio.newLayout.tiles.length === 1 && studio.customControls.visible,
        'Custom starts with a full tile and shows geometry controls');
    assert(studio.customEntries.get('width').get_text() === '100', 'percentage editor uses 0–100 values');
    studio.splitCustom('vertical');
    studio.newLayout.selected = 1; studio.splitCustom('horizontal'); await pause();
    assert(studio.newLayout.tiles.length === 3, 'split creates an asymmetric three-tile partition');
    studio.newLayout.selected = 0; studio.render(); await pause();
    const width = studio.customEntries.get('width');
    width.set_text('60'); width.clutter_text.emit('activate'); await pause();
    assert(studio.newLayout.tiles[0].width === .6 && studio.newLayout.tiles[1].x === .6 &&
        studio.newLayout.tiles[2].x === .6, 'numeric width edits update every adjacent tile');
    assert(studio.customHandles.length === 2, 'custom canvas provides shared-divider drag handles');
    const beforeDrag = JSON.stringify(studio.newLayout.tiles);
    const device = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const handle = studio.customHandles.find(h => h.index === 0 && h.edge === 'E').handle;
    const [handleX, handleY] = handle.get_transformed_position();
    const [handleWidth, handleHeight] = handle.get_transformed_size();
    const startX = handleX + handleWidth / 2, startY = handleY + handleHeight / 2;
    // Use the observed cursor position for reliable headless pointer input.
    for (let attempt = 0; attempt < 3; attempt++) {
        const [x, y] = global.get_pointer();
        device.notify_relative_motion(GLib.get_monotonic_time(), startX - x, startY - y);
        await Scripting.sleep(60);
    }
    device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED); await Scripting.sleep(30);
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, startX, startY);
    assert(studio.customDragSignal, `pressing the visible divider starts pointer capture (${startX},${startY}; pointer=${global.get_pointer()}; picked=${picked}, handle=${handle})`);
    device.notify_relative_motion(GLib.get_monotonic_time(), 35, 0); await pause();
    device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED); await pause();
    assert(JSON.stringify(studio.newLayout.tiles) !== beforeDrag && !studio.customDragSignal,
        `pointer motion resizes the draft and release disconnects capture (${beforeDrag} → ${JSON.stringify(studio.newLayout.tiles)}, capture=${studio.customDragSignal}, pointer=${global.get_pointer()})`);
    studio.undo(); await pause();
    assert(JSON.stringify(studio.newLayout.tiles) === beforeDrag, 'Undo restores dragged geometry');
    studio.newLayout.selected = 1;
    studio.assignNewApp('first.desktop'); studio.newLayout.selected = 2; studio.assignNewApp('second.desktop');
    studio.newLayout.selected = 1; studio.mergeChoosing = true; studio.requestCustomMerge(2); await pause();
    assert(studio.mergePending && studio.newLayout.tiles.length === 3,
        'merging assigned tiles requires choosing the retained app');
    studio.finishCustomMerge(1, 2, 2); await pause();
    assert(studio.newLayout.tiles.length === 2 && studio.newLayout.apps[1] === 'second.desktop',
        'merge retains the selected assignment');
    studio.undo(); await pause();
    assert(studio.newLayout.tiles.length === 3 && studio.newLayout.apps[1] === 'first.desktop' &&
        studio.newLayout.apps[2] === 'second.desktop', 'Undo restores assignments and geometry');
    // Save a blank draft to prove that creating a template never touches the desktop.
    studio.newLayout.apps = [null, null, null]; studio.newLayout.pinned = [null, null, null];
    studio.nameEntry.set_text('Custom shell test'); studio.saveNamedLayout(); await pause();
    const saved = app.savedLayouts.find(l => l.name === 'Custom shell test');
    assert(saved?.preset === 'custom' && saved.tiles.length === 3, 'named custom template saved');
    assert(JSON.stringify(app.profiles) === before, 'draft creation and save leave desktop profiles untouched');
    studio.editButton.emit('clicked', 1); await pause();
    assert(studio.editingSavedId === saved.id && studio.newLayout.tiles[0].width === .6,
        'saved custom geometry reopens as an editable draft');
    if (GLib.getenv('SNAPTESS_CUSTOM_SCREENSHOT')) {
        const stream = Gio.File.new_for_path(GLib.getenv('SNAPTESS_CUSTOM_SCREENSHOT'))
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        const m = Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
        stream.close(null);
    }
    studio.nameRow.show(); studio.render(); await pause();
    const [dialogX, dialogY] = studio.dialog.dialogLayout.get_transformed_position();
    const [dialogWidth, dialogHeight] = studio.dialog.dialogLayout.get_transformed_size();
    const m = Main.layoutManager.monitors[0];
    assert(dialogX >= m.x && dialogY >= m.y && dialogX + dialogWidth <= m.x + m.width + 1 &&
        dialogY + dialogHeight <= m.y + m.height + 1, 'editor fits within the monitor');
    studio.dialog.close(); await pause();
    // Three PerfHelper windows share one app ID; save current windows for exact reuse.
    const template = app.saveLayout('Custom windows', 'custom', windows, [null, null, null], null, saved.tiles);
    app.restoreSavedLayout(template, 0, 0); await pause();
    const profile = app.profiles[app.profileKey(0, 0)];
    assert(profile.preset === 'custom' && profile.tiles[0].width === .6 &&
        app.groups.get(app.key(0)).length === 3, 'restoring a custom template applies its geometry');
    const rects = app.slotRects(0, 3);
    assert(rects[0].height > rects[1].height && rects[1].x === rects[2].x,
        'custom geometry positions real windows in a staggered partition');
    app.openStudio(); await pause();
    // Dense layouts must still show live previews when the toggle is enabled.
    app.studio.choosePreset('5x5'); app.studio.showPreviews = true; app.studio.render(); await pause();
    const descendants = actor => actor.get_children().flatMap(child => [child, ...descendants(child)]);
    const clones = descendants(app.studio.canvas).filter(actor => actor instanceof Clutter.Clone);
    assert(clones.length === windows.length && clones.every(clone => clone.width > 0 && clone.height > 0),
        '5x5 layout displays a scaled preview for each live window');
    app.studio.undo(); app.studio.showPreviews = false; app.studio.render(); await pause();
    assert(app.studio.draftTiles.get(app.studio.contextKey())?.[0].width === .6,
        'current-space Studio previews preserve custom geometry');
    app.studio.apply(); await pause();
    assert(app.profiles[app.profileKey(0,0)].tiles[0].width === .6,
        'applying current-space edits preserves custom geometry');
    const w = app.groups.get(app.key(0))[0], r = app.slotRects(0, 3)[0];
    w.activate(global.get_current_time()); await pause();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    for (let n = 0; n < 3; n++) {
        const [px, py] = global.get_pointer();
        device.notify_relative_motion(GLib.get_monotonic_time(), x - px, y - py); await Scripting.sleep(60);
    }
    device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED); await Scripting.sleep(30);
    assert(w.begin_grab_op(Meta.GrabOp.RESIZING_E,
        Clutter.get_default_backend().get_pointer_sprite(global.stage), global.get_current_time(), null),
        'native custom window resize begins');
    await Scripting.sleep(50);
    assert(app.resizeGrab?.rects.length === 3, 'custom windows enter existing linked resize');
    device.notify_relative_motion(GLib.get_monotonic_time(), 35, 0); await pause();
    device.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED); await Scripting.sleep(500);
    assert(app.profiles[app.profileKey(0,0)].resize && app.slotRects(0,3)[0].width > r.width,
        'native custom resize persists temporary proportions');
    app.arrangeAgain(); await pause();
    assert(app.profiles[app.profileKey(0,0)].tiles[0].width === .6 &&
        app.slotRects(0,3)[0].width === r.width && !app.profiles[app.profileKey(0,0)].resize,
        'Arrange again restores the custom base geometry');
    if (Main.layoutManager.monitors.length > 1) {
        app.applyProfiles([{monitor: 1, space: 0, preset: 'custom', tiles: saved.tiles,
            windows, pinned: [null, null, null]}], {monitor: 1, space: 0}); await pause();
        const area = app.area(1), rects = app.slotRects(1, 3);
        assert(windows.every(w => w.get_monitor() === 1) &&
            rects.every(r => r.x >= area.x && r.x + r.width <= area.x + area.width),
            'custom geometry and windows adapt to the second monitor');
        assert(app.profiles[app.profileKey(1,0)].tiles[0].width === .6,
            'second monitor keeps independent normalized custom geometry');
        app.undo(); await pause();
        assert(windows.every(w => w.get_monitor() === 0), 'Undo restores the original monitor');
    }
    app.saveNewLayout('Preset group test', '2x2', [null, null, null, null], [null, null, null, null]);
    app.openLayoutSwitcher(); await pause();
    const headings = app.layoutSwitcher.list.get_children()
        .filter(actor => actor instanceof St.Label).map(actor => actor.text);
    assert(headings.includes('CUSTOM LAYOUTS') && headings.includes('PRESET LAYOUTS'),
        'quick layout switcher separates saved custom and preset layouts');
    app.layoutSwitcher.dialog.close(); await pause();
    app.setRunning(false); await Scripting.destroyTestWindows();
    console.log('SNAPTESS_CUSTOM_LAYOUT_TESTS_PASSED');
}
