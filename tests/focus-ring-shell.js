import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Focus ring: ${message}`); };
const pause = (ms = 300) => Scripting.sleep(ms);
// Every invisible focus is collected, so a single run reports all of them.
const invisible = [];

const rgba = c => [c.red, c.green, c.blue, c.alpha / 255];
const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3]));
const luminance = rgb => {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
// Background painted behind an actor, composited down to the first opaque
// ancestor (or the black stage).
const backdrop = actor => {
    const layers = [];
    for (let a = actor; a; a = a.get_parent()) {
        if (!(a instanceof St.Widget)) continue;
        const bg = rgba(a.get_theme_node().get_background_color());
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
    }
    return layers.reverse().reduce((under, layer) => [...over(layer, under), 1], [0, 0, 0, 1]);
};
const look = actor => {
    const node = actor.get_theme_node();
    const background = backdrop(actor);
    return {background, border: over(rgba(node.get_border_color(St.Side.TOP)), background),
        width: node.get_border_width(St.Side.TOP)};
};

// The currently active or selected element is also the one keyboard focus
// lands on first: focusing it must change its ring visibly (1.5:1 against the
// unfocused ring, 3:1 against its background), not leave it as it was.
function checkFocusable(root, where) {
    const found = [];
    const walk = actor => {
        if (actor instanceof St.Widget && actor.can_focus && actor.mapped &&
            (actor.has_style_class_name('selected') || actor.has_style_class_name('active')))
            found.push(actor);
        for (const child of actor.get_children()) walk(child);
    };
    walk(root);
    for (const actor of found) {
        const name = `${where} ${actor.style_class} "${actor.label ?? actor.accessible_name ?? ''}"`;
        // The element may already hold the real key focus: compare both states.
        const hadFocus = actor.has_style_pseudo_class('focus');
        actor.remove_style_pseudo_class('focus');
        const before = look(actor);
        actor.add_style_pseudo_class('focus');
        const after = look(actor);
        if (!hadFocus) actor.remove_style_pseudo_class('focus');
        const ring = contrast(after.border, before.border);
        const visible = after.width > 0 && ring >= 1.5 && contrast(after.border, after.background) >= 3;
        if (!visible) invisible.push(`${name}: focused ring ${ring.toFixed(2)}:1 against unfocused, ` +
            `${contrast(after.border, after.background).toFixed(2)}:1 against its background`);
    }
    return found.length;
}

async function screenshot(name) {
    const dir = GLib.getenv('SNAPTESS_FOCUS_RING_SCREENSHOT_DIR');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: focus-ring-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    for (let i = 0; i < 4; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    app.setRunning(true); await pause();
    const ids = [];
    try {
        ids.push(app.saveLayout('Focus ring 1', '2x2', [], []), app.saveLayout('Focus ring 2', '3x3', [], []));
        assert(ids.every(Boolean), 'two layouts saved');

        app.openLayoutSwitcher(); await pause();
        const switcher = app.layoutSwitcher; assert(switcher, 'layout switcher opened');
        const activeRow = switcher.rows.find(row => row.has_style_class_name('active'));
        assert(activeRow, 'the switcher marks the current arrangement ACTIVE');
        assert(global.stage.get_key_focus() === activeRow, 'the switcher opens with focus on the ACTIVE row');
        assert(checkFocusable(switcher.dialog, 'switcher') >= 1, 'switcher has an active row');
        await screenshot('switcher');
        switcher.dialog.close(); await pause(600);

        app.openStudio(); await pause();
        const studio = app.studio; assert(studio, 'Studio opened');
        studio.select(0); await pause();
        assert(checkFocusable(studio.dialog, 'Studio current space') >= 4,
            'Studio marks display, space, view and tile as selected');
        studio.canvas.get_children().find(c => c.has_style_class_name('selected'))?.grab_key_focus();
        await pause(); await screenshot('studio');

        studio.previewSavedId = ids[0]; studio.showSavedChooser = true; studio.render(); await pause();
        assert(checkFocusable(studio.dialog, 'Studio saved layouts') >= 2, 'Studio marks the previewed layout');

        studio.showSavedChooser = false; studio.openNewLayout(); await pause();
        studio.choosePreset('custom'); await pause();
        assert(checkFocusable(studio.dialog, 'Studio Custom') >= 2, 'Studio marks the preset and the empty tile');
        studio.dialog.close(); await pause(600);
    } finally {
        for (const id of ids) if (id) app.deleteSavedLayout(id);
        await Scripting.destroyTestWindows();
    }
    for (const message of invisible) console.log(`SNAPTESS_INVISIBLE_FOCUS: ${message}`);
    assert(!invisible.length, `${invisible.length} invisible focus rings, first: ${invisible[0]}`);
    console.log('SNAPTESS_FOCUS_RING_TESTS_PASSED');
}
