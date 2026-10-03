import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (ok, message) => { if (!ok) throw new Error(`Studio library: ${message}`); };
const pause = () => Scripting.sleep(300);
export async function run() {
    console.log('SNAPTESS_TEST_STARTED: studio-library-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry.stateObj.runtime;
    await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const w = [...app.records.keys()][0], appId = app.appId(w);
    const preset = app.saveNewLayout('Alpha desk', '2x2', [appId, null, null, null], Array(4).fill(null));
    app.saveNewLayout('Beta desk', 'full', [null], [null]);
    app.openStudio(); await pause();
    const studio = app.studio;
    studio.openNewLayout(); studio.choosePreset('3x3');
    studio.newLayout.selected = 0; studio.assignNewApp(appId);
    studio.nameEntry.set_text('My unfinished creation');
    const history = studio.newUndoStack.length;
    studio.previewSavedId = preset; studio.editSavedLayout(); studio.choosePreset('focus');
    studio.openNewLayout();
    assert(studio.newLayout.preset === '3x3' && studio.newLayout.apps[0] === appId &&
        studio.nameEntry.get_text() === 'My unfinished creation' && studio.newUndoStack.length === history,
        'returning from a saved edit restores creation geometry, assignments, name and undo history');
    studio.previewSavedId = preset; studio.editSavedLayout();
    studio.nameEntry.set_text('Alpha desk'); studio.saveNamedLayout(); studio.openNewLayout();
    assert(studio.newLayout.preset === '3x3' && studio.newLayout.apps[0] === appId,
        'saving an edited template also preserves the independent creation draft');
    studio.showLibrary = true; studio.render();
    const catalog = studio.appCatalogSections;
    catalog.windows.header.emit('clicked', 1);
    assert(catalog.windows.rows.length === 1 && !catalog.installed.rows.length, 'catalog stays lazy');
    catalog.windows.search.set_text('not a matching title');
    await Scripting.createTestWindow({width: 330, height: 250});
    await Scripting.waitTestWindows(); await pause();
    assert(catalog.windows.rows.length === 2 && catalog.windows.search.get_text() === 'not a matching title' &&
        catalog.windows.empty.visible, 'live additions preserve the current search');
    w.delete(global.get_current_time()); await pause();
    assert(!app.records.has(w) && catalog.windows.rows.length === 1, 'closed windows disappear without reopening the picker');
    studio.creatingNew = false; studio.selected = 0;
    const undo = studio.undoStack.length; studio.assignWindow(w);
    assert(studio.undoStack.length === undo, 'a stale window cannot modify a draft');
    studio.showSavedChooser = true; studio.showLibrary = false; studio.render();
    studio.savedSearch.set_text('ALPHA');
    const namedRows = () => studio.savedChooserList.get_children().filter(actor => actor.accessible_name?.startsWith('Preview '));
    assert(namedRows().length === 1 && namedRows()[0].accessible_name === 'Preview Alpha desk', 'Studio filters names case-insensitively');
    studio.savedSearch.set_text('missing-name');
    assert(namedRows().length === 0 && studio.savedChooserList.get_first_child().text === 'No matching layouts.', 'Studio explains an empty search');
    studio.savedSearch.set_text(''); assert(namedRows().length === 2, 'clearing search restores every saved layout');
    studio.dialog.close(); await pause();
    app.openLayoutSwitcher(); await pause();
    const quick = app.layoutSwitcher;
    quick.savedSearch.set_text('beta');
    const visibleRows = () => quick.rows.filter(row => row !== quick.autoRow && row.visible);
    assert(visibleRows().length === 1 && visibleRows()[0]._savedName === 'beta desk' && quick.autoRow.visible,
        'quick search preserves Arrange open windows and filters saved names');
    quick.navigate({get_key_symbol: () => Clutter.KEY_Down}, quick.autoRow);
    assert(global.stage.get_key_focus() === visibleRows()[0], 'keyboard navigation skips filtered-out layouts');
    quick.savedSearch.set_text('missing-name');
    assert(quick.noMatches.visible && !visibleRows().length && quick.autoRow.visible, 'quick search explains no matches');
    quick.savedSearch.set_text(''); assert(visibleRows().length === 2, 'quick search can be cleared');
    quick.dialog.close();
    console.log('SNAPTESS_STUDIO_LIBRARY_TESTS_PASSED');
}
