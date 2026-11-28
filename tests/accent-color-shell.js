import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Accent color: ${message}`); };
const pause = (ms = 400) => Scripting.sleep(ms);
// Every pale accent is collected, so a single run reports all of them.
const pale = [], measured = {};
// WCAG 1.4.11: graphical objects (the swap arrow, the panel status icon).
const visible = (ratio, min, message) => { if (!(ratio >= min)) pale.push(message); };

const rgb = c => [c.red, c.green, c.blue];
const hex = c => `#${rgb(c).map(v => v.toString(16).padStart(2, '0')).join('')}`;
const luminance = color => {
    const [r, g, b] = color.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
// Opaque background painted behind an actor: the first ancestor with one
// (the top bar may be translucent: composite it over black).
const backdrop = actor => {
    for (let a = actor; a; a = a.get_parent()) {
        if (!(a instanceof St.Widget)) continue;
        const bg = a.get_theme_node().get_background_color();
        if (bg.alpha > 0) return rgb(bg).map(v => v * bg.alpha / 255);
    }
    return [0, 0, 0];
};

async function screenshot(name) {
    const dir = GLib.getenv('SNAPTESS_ACCENT_SCREENSHOT_DIR');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

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
    console.log('SNAPTESS_TEST_STARTED: accent-color-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const context = St.ThemeContext.get_for_stage(global.stage);
    const icon = app.indicator.get_children().find(child => child instanceof St.Icon);
    assert(icon, 'panel icon found');
    try {
        const windows = await openWindows(app, 4);
        assert(windows.length === 4, `four windows tracked, got ${windows.length}`);
        app.setRunning(true); await pause();
        Main.activateWindow(windows[0]); await pause();
        app.toggleSwap(); await pause();
        assert(app.swapMode, 'swap mode entered');
        for (const scheme of ['prefer-light', 'prefer-dark']) {
            iface.set_string('color-scheme', scheme); await pause(1200);
            for (const accent of ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate']) {
                // Changed while swap mode is shown: the live styles must follow.
                iface.set_string('accent-color', accent); await pause();
                const [shellAccent, shellText] = context.get_accent_color();
                const hints = [...app.swapHints.values()].flat().filter(hint => hint.visible);
                const filled = hints.filter(hint => hint.get_theme_node().get_background_color().alpha === 255);
                assert(filled.length, `${scheme} ${accent}: a filled swap hint is shown`);
                for (const hint of filled) {
                    const bg = hint.get_theme_node().get_background_color();
                    const fg = hint.get_child().get_theme_node().get_foreground_color();
                    assert(hex(bg) === hex(shellAccent) && hex(fg) === hex(shellText),
                        `${scheme} ${accent}: swap hint uses the Shell accent ${hex(shellAccent)}/${hex(shellText)}, got ${hex(bg)}/${hex(fg)}`);
                    const ratio = contrast(rgb(fg), rgb(bg));
                    measured[`${scheme}-${accent}-swap`] = ratio.toFixed(2);
                    visible(ratio, 3, `${scheme} ${accent}: swap arrow ${hex(fg)} on ${hex(bg)} (${ratio.toFixed(2)}:1)`);
                }
                const outlined = hints.filter(hint => !filled.includes(hint));
                for (const hint of outlined) {
                    const fg = hint.get_child().get_theme_node().get_foreground_color();
                    assert(hex(fg) === hex(shellAccent), `${scheme} ${accent}: outlined hint uses the Shell accent, got ${hex(fg)}`);
                }
                const iconColor = icon.get_theme_node().get_foreground_color();
                assert(hex(iconColor) === hex(shellAccent),
                    `${scheme} ${accent}: panel icon uses the Shell accent ${hex(shellAccent)}, got ${hex(iconColor)}`);
                // The light top bar is where pale accents vanished; the
                // Shell's own accent is the readability floor there.
                const ratio = contrast(rgb(iconColor), backdrop(icon));
                visible(ratio, 2.5, `${scheme} ${accent}: panel icon ${hex(iconColor)} on ${backdrop(icon).map(Math.round)} (${ratio.toFixed(2)}:1)`);
                measured[`${scheme}-${accent}-icon`] = ratio.toFixed(2);
                if (accent === 'yellow') await screenshot(`${scheme}-yellow`);
            }
        }
    } finally {
        if (app.swapMode) app.toggleSwap();
        iface.reset('accent-color');
        iface.reset('color-scheme');
        await Scripting.destroyTestWindows();
    }
    for (const message of pale) console.log(`SNAPTESS_PALE_ACCENT: ${message}`);
    console.log(`SNAPTESS_ACCENT_CONTRAST: ${JSON.stringify(measured)}`);
    assert(!pale.length, `${pale.length} pale accent marks, first: ${pale[0]}`);
    console.log('SNAPTESS_ACCENT_COLOR_TESTS_PASSED');
}
