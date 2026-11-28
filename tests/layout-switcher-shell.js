import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Layout switcher: ${message}`); };
const pause = (ms = 300) => Scripting.sleep(ms);

async function screenshot(name) {
    const dir = GLib.getenv('SNAPTESS_SWITCHER_SCREENSHOT_DIR');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

// The list needs no scrolling: its whole content fits in the scroll view.
function checkFits(switcher, where) {
    const adjustment = switcher.scroll.vadjustment;
    const overflow = adjustment.upper - adjustment.page_size;
    assert(overflow <= 0.5, `${where}: the list fits without scrolling (content ${adjustment.upper.toFixed(1)} px, ` +
        `visible ${adjustment.page_size.toFixed(1)} px)`);
    const [, natural] = switcher.list.get_preferred_height(-1);
    assert(switcher.scroll.height >= natural, `${where}: the scroll view is as tall as its content ` +
        `(${switcher.scroll.height} px for ${natural} px)`);
}

async function open(app) {
    app.openLayoutSwitcher(); await pause();
    const switcher = app.layoutSwitcher; assert(switcher, 'opened');
    return switcher;
}

async function close(app, switcher) {
    switcher.dialog.close(); await pause(600);
    assert(!app.layoutSwitcher, 'closed');
}

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: layout-switcher-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    app.setRunning(true); await pause();
    const ids = [];
    try {
        for (const saved of [...app.savedLayouts]) app.deleteSavedLayout(saved.id);
        let switcher = await open(app);
        assert(switcher.list.get_children().some(child => child.text === 'Create a layout in Studio to see it here.'),
            'empty state shows its hint');
        checkFits(switcher, 'empty state');
        await screenshot('empty');
        await close(app, switcher);

        ids.push(app.saveLayout('Layout 1', '2x2', [], []));
        assert(ids[0], 'first layout saved');
        switcher = await open(app);
        checkFits(switcher, 'one saved layout');
        await screenshot('one-layout');
        switcher.savedSearch.set_text('no such layout'); await pause();
        assert(switcher.noMatches.visible, 'search without results shows its message');
        checkFits(switcher, 'search without results');
        switcher.savedSearch.set_text(''); await pause();
        checkFits(switcher, 'search cleared');
        await close(app, switcher);

        for (let n = 2; n <= 12; n++) ids.push(app.saveLayout(`Layout ${n}`, '2x2', [], []));
        assert(ids.every(Boolean), 'twelve layouts saved');
        switcher = await open(app);
        const screen = Main.layoutManager.monitors[switcher.monitor];
        const cap = Math.min(440, Math.floor(screen.height * 0.56));
        assert(switcher.scroll.height <= cap, `a long list stays within ${cap} px (${switcher.scroll.height} px)`);
        const adjustment = switcher.scroll.vadjustment;
        assert(adjustment.upper > adjustment.page_size, 'a long list scrolls');
        await close(app, switcher);
    } finally {
        for (const id of ids) if (id) app.deleteSavedLayout(id);
    }
    console.log('SNAPTESS_LAYOUT_SWITCHER_TESTS_PASSED');
}
