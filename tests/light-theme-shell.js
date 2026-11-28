import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Light theme: ${message}`); };
const pause = (ms = 300) => Scripting.sleep(ms);
// WCAG AA for normal text. Every unreadable label is collected, so a single
// run reports all of them.
const unreadable = [];
const readable = (ratio, message) => { if (!(ratio >= 4.5)) unreadable.push(message); };

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
// Background actually painted behind an actor: its own background composited
// over every ancestor's, down to the first opaque one (or the black stage).
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
const textContrast = (label, background = label) =>
    contrast(over(rgba(label.get_theme_node().get_foreground_color()), backdrop(background)), backdrop(background));

async function screenshot(name) {
    const dir = GLib.getenv('SNAPTESS_LIGHT_SCREENSHOT_DIR');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

function checkButtons(dialog, where, scheme) {
    const buttons = dialog.buttonLayout.get_children().filter(b => b.visible && b instanceof St.Button);
    assert(buttons.length, `${where} has footer buttons`);
    for (const button of buttons) {
        for (const state of [null, 'hover', 'focus', 'active']) {
            if (state) button.add_style_pseudo_class(state);
            const ratio = textContrast(button);
            if (state) button.remove_style_pseudo_class(state);
            if (button.has_style_pseudo_class('insensitive')) continue;
            readable(ratio, `${scheme}: ${where} button "${button.label}" ${state ?? 'normal'} is readable (${ratio.toFixed(2)}:1)`);
        }
    }
}

function checkSearch(entry, where, scheme) {
    assert(entry.get_hint_actor(), `${where} search has a hint`);
    for (const state of [null, 'hover', 'focus']) {
        if (state) entry.add_style_pseudo_class(state);
        const hint = textContrast(entry.get_hint_actor(), entry);
        const text = textContrast(entry);
        if (state) entry.remove_style_pseudo_class(state);
        readable(hint, `${scheme}: ${where} search hint ${state ?? 'normal'} is readable (${hint.toFixed(2)}:1)`);
        readable(text, `${scheme}: ${where} search text ${state ?? 'normal'} is readable (${text.toFixed(2)}:1)`);
    }
}

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: light-theme-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    try {
        for (const scheme of ['prefer-light', 'prefer-dark']) {
            iface.set_string('color-scheme', scheme); await pause(1200);
            const menu = app.indicator.menu;
            menu.open(); await pause();
            const menuLuminance = luminance(backdrop(app.statusItem));
            assert(scheme === 'prefer-light' ? menuLuminance > 0.6 : menuLuminance < 0.2,
                `${scheme}: the Shell theme follows the color scheme (menu luminance ${menuLuminance.toFixed(2)})`);
            app.updateStatus?.();
            for (const [item, name] of [[app.statusItem, 'status line'], [app.focusHeading, 'Focused window heading']]) {
                const ratio = textContrast(item.label, item);
                readable(ratio, `${scheme}: menu ${name} is readable (${ratio.toFixed(2)}:1)`);
            }
            if (scheme === 'prefer-light') await screenshot('menu');
            menu.close(); await pause();

            app.openStudio(); await pause();
            const studio = app.studio; assert(studio, 'Studio opened');
            checkButtons(studio.dialog, 'Studio', scheme);
            checkSearch(studio.savedSearch, 'Studio saved layouts', scheme);
            if (scheme === 'prefer-light') await screenshot('studio');
            studio.select(0); await pause();
            checkSearch(studio.appCatalogSections.installed.search, 'Studio app catalog', scheme);
            if (scheme === 'prefer-light') await screenshot('studio-catalog');
            studio.openNewLayout(); await pause();
            checkButtons(studio.dialog, 'Studio New layout', scheme);
            studio.dialog.close(); await pause(600);
            assert(!app.studio, 'Studio closed');

            app.openLayoutSwitcher(); await pause();
            const switcher = app.layoutSwitcher; assert(switcher, 'layout switcher opened');
            checkButtons(switcher.dialog, 'layout switcher', scheme);
            checkSearch(switcher.savedSearch, 'layout switcher', scheme);
            if (scheme === 'prefer-light') {
                switcher.savedSearch.show(); await pause();
                await screenshot('switcher');
            }
            switcher.dialog.close(); await pause(600);
        }
    } finally {
        iface.reset('color-scheme');
    }
    for (const message of unreadable) console.log(`SNAPTESS_UNREADABLE: ${message}`);
    assert(!unreadable.length, `${unreadable.length} unreadable labels, first: ${unreadable[0]}`);
    console.log('SNAPTESS_LIGHT_THEME_TESTS_PASSED');
}
