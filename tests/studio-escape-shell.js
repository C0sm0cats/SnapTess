import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Studio Escape: ${message}`); };
const pause = () => Scripting.sleep(300);
export async function run() {
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    const keyboard = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const escape = async () => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        await Scripting.sleep(60);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await pause();
    };
    app.openStudio(); await pause();
    const studio = app.studio;
    studio.openNewLayout(); await pause();
    const back = studio.dialog.buttonLayout.get_children().find(actor => actor.label === 'Back to current space');
    back.grab_key_focus(); back.emit('clicked', 1); await pause();
    assert(global.stage.get_key_focus() && studio.dialog.dialogLayout.contains(global.stage.get_key_focus()),
        'rebuilding the footer restores key focus inside the dialog');
    assert(!studio.creatingNew && studio.dialog.buttonLayout.get_children().some(actor => actor.label === 'Cancel'),
        'returned to the base page with Cancel');
    await escape();
    assert(!app.studio, 'Escape closes the base page after returning from New layout');
    const profilesBefore = JSON.stringify(app.profiles);
    app.openStudio(); await pause();
    app.studio.openNewLayout(); await pause();
    await escape();
    assert(app.studio && !app.studio.creatingNew, 'Escape in New layout returns to the base page');
    await escape(); assert(!app.studio, 'a second Escape closes the base page');
    app.openStudio(); await pause();
    app.studio.savedPicker.emit('clicked', 1); await pause();
    const chooserBack = app.studio.dialog.buttonLayout.get_children().find(actor => actor.label === 'Back to layout');
    chooserBack.grab_key_focus(); chooserBack.emit('clicked', 1); await pause();
    await escape(); assert(!app.studio, 'Escape works after returning from Saved layouts');
    app.openStudio(); await pause();
    app.studio.select(0); await pause();
    const installed = app.studio.appCatalogSections.installed;
    installed.header.emit('clicked', 1); installed.search.grab_key_focus();
    app.studio.libraryButton.emit('clicked', 1); await pause();
    await escape(); assert(!app.studio, 'Escape works after destroying a focused app search field');
    app.openStudio(); await pause();
    app.studio.nameRow.show(); app.studio.nameEntry.grab_key_focus(); await pause();
    await escape(); assert(!app.studio, 'Escape closes the base page even with a name field focused');
    assert(JSON.stringify(app.profiles) === profilesBefore, 'Escape never applies draft changes');
    console.log('SNAPTESS_STUDIO_ESCAPE_TESTS_PASSED');
}
