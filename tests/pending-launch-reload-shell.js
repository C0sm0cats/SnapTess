import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Pending reload: ${message}`); };
export async function run() {
    await Scripting.sleep(1000); Main.overview.hide();
    const uuid = 'snaptess@c0sm0cats.github.io';
    const entry = Main.extensionManager.lookup(uuid);
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const before = entry.stateObj.runtime;
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await Scripting.sleep(400);
    const w = [...before.records.keys()][0], id = before.appId(w);
    const workspace = w.get_workspace();
    before.profiles[before.profileKey(0, 0)] = {preset: 'auto', apps: [id], pinned: [], pendingApps: [id]};
    before.profiles[before.profileKey(0, 1)] = {preset: 'auto', apps: [null, null, id], pinned: [], pendingApps: [id]};
    before.settings.set_string('profiles', JSON.stringify(before.profiles));
    before.pendingLayoutApps.set(id.toLowerCase().replace(/\.desktop$/i, ''), {
        monitor: 0, space: 0, workspace, index: 0,
        targets: [{monitor: 0, space: 0, index: 0}, {monitor: 0, space: 1, index: 2}],
    });
    Main.extensionManager.disableExtension(uuid);
    Main.extensionManager.enableExtension(uuid);
    for (let n = 0; n < 40 && (!entry.stateObj?.runtime || entry.stateObj.runtime === before); n++)
        await Scripting.sleep(100);
    const after = entry.stateObj?.runtime;
    assert(after && after !== before, 'new runtime loaded');
    assert(after.pendingLayoutApps.size === 0, 'restored request claims the already-open window');
    assert(after.groups.get(after.key(0, 0))?.[0] === w && after.groups.get(after.key(0, 1))?.[2] === w,
        'each target restores its exact tile after reload');
    assert(after.windowInSpace(w, 0) && after.windowInSpace(w, 1), 'shared destinations preserved');
    assert(!w.minimized && !after.running, 'paused reload keeps the window visible');
    after.openStudio(); await Scripting.sleep(300);
    const card = after.studio.canvas.get_children().find(actor => actor.accessible_name?.includes('Shared:'));
    assert(card?.accessible_name.includes('Space 1, Space 2'), 'tile exposes its shared Spaces');
    assert(card._sharedTooltip, 'shared details available on hover');
    card.emit('enter-event', null);
    assert(card._sharedTooltip.visible, 'hover reveals shared destinations');
    card.emit('leave-event', null);
    assert(!card._sharedTooltip.visible, 'shared tooltip hides on leave');
    after.studio.dialog.close();
    console.log('SNAPTESS_PENDING_RELOAD_TESTS_PASSED');
}
