import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

// Large Text (Settings > Accessibility) sets text-scaling-factor: every
// SnapTess label must grow with it, and Layout Studio must still fit the
// screen with its footer buttons visible.
const FACTOR = 1.25;
const assert = (condition, message) => { if (!condition) throw new Error(`Large text: ${message}`); };
const pause = (ms = 300) => Scripting.sleep(ms);
const failures = [];

const fontPx = label => {
    const font = label.get_theme_node().get_font();
    // St turns pt sizes into pixels with the text scaling factor already applied.
    return font.get_size() / 1024 * (font.get_size_is_absolute() ? 1 : 96 / 72);
};

function labels(root, prefix, out) {
    const walk = actor => {
        if (!actor.visible) return;
        if (actor instanceof St.Label && actor.text) {
            let key = `${prefix}: "${actor.text.slice(0, 40)}"`;
            while (out.has(key)) key += "'";
            out.set(key, fontPx(actor));
        }
        for (const child of actor.get_children()) walk(child);
    };
    walk(root);
    return out;
}

function checkFits(dialog, where) {
    const m = Main.layoutManager.primaryMonitor;
    const box = dialog.contentLayout.get_parent();
    const [, top] = box.get_transformed_position();
    const [, buttonsTop] = dialog.buttonLayout.get_transformed_position();
    const [, buttonsHeight] = dialog.buttonLayout.get_transformed_size();
    if (top < m.y || buttonsTop + buttonsHeight > m.y + m.height)
        failures.push(`${where}: dialog fits the ${m.width}x${m.height} screen (top ${top}, buttons end at ${buttonsTop + buttonsHeight})`);
}

async function screenshot(name) {
    const dir = GLib.getenv('SNAPTESS_LARGE_TEXT_SCREENSHOT_DIR');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

async function measure(app, factor) {
    const sizes = new Map();
    const menu = app.indicator.menu;
    menu.open(); await pause();
    for (const [item, name] of [[app.statusItem, 'menu status'], [app.focusHeading, 'menu heading']])
        labels(item, name, sizes);
    if (factor !== 1) await screenshot('menu');
    menu.close(); await pause();

    app.openStudio(); await pause();
    const studio = app.studio; assert(studio, 'Studio opened');
    const views = [
        ['Studio current space', () => {}],
        ['Studio tile selected', () => studio.select(0)],
        ['Studio saved layouts', () => { studio.showSavedChooser = true; studio.render(); }],
        ['Studio New layout', () => { studio.showSavedChooser = false; studio.openNewLayout(); }],
        ['Studio New layout tile selected', () => { studio.newLayout.selected = 0; studio.render(); }],
    ];
    for (const [where, step] of views) {
        step(); await pause();
        labels(studio.dialog, where, sizes);
        checkFits(studio.dialog, `${factor}: ${where}`);
        if (factor !== 1 && where === 'Studio current space') await screenshot('studio');
    }
    studio.dialog.close(); await pause(600);
    assert(!app.studio, 'Studio closed');

    app.openLayoutSwitcher(); await pause();
    const switcher = app.layoutSwitcher; assert(switcher, 'layout switcher opened');
    labels(switcher.dialog, 'Change layout', sizes);
    checkFits(switcher.dialog, `${factor}: Change layout`);
    switcher.dialog.close(); await pause(600);
    return sizes;
}

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: large-text-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    let normal, large;
    try {
        iface.set_double('text-scaling-factor', 1); await pause(1200);
        normal = await measure(app, 1);
        iface.set_double('text-scaling-factor', FACTOR); await pause(1200);
        large = await measure(app, FACTOR);
    } finally {
        iface.reset('text-scaling-factor');
    }
    assert(normal.size > 40, `labels found (${normal.size})`);
    for (const [key, size] of normal) {
        const scaled = large.get(key);
        if (scaled === undefined) { failures.push(`${key} is still shown with large text`); continue; }
        if (Math.abs(scaled - size * FACTOR) > 0.5)
            failures.push(`${key} grows with large text (${size.toFixed(2)} px -> ${scaled.toFixed(2)} px, expected ${(size * FACTOR).toFixed(2)})`);
    }
    for (const message of failures) console.log(`SNAPTESS_LARGE_TEXT_FAILURE: ${message}`);
    assert(!failures.length, `${failures.length} failures, first: ${failures[0]}`);
    console.log('SNAPTESS_LARGE_TEXT_TESTS_PASSED');
}
