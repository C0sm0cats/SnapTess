import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`Pinned cards: ${message}`); };
const pause = (ms = 300) => Scripting.sleep(ms);
// Pinned cards sit directly on the desktop background, which can be any
// wallpaper: their text must stay readable over the lightest one, white.
const WALLPAPERS = {white: [255, 255, 255, 1], black: [0, 0, 0, 1]};
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
// What is painted under a label: the backgrounds of its ancestors up to the
// card, composited over the wallpaper.
const backdrop = (label, card, wallpaper) => {
    const layers = [];
    for (let a = label; a; a = a.get_parent()) {
        const bg = rgba(a.get_theme_node().get_background_color());
        if (bg[3] > 0) layers.push(bg);
        if (a === card) break;
    }
    return layers.reverse().reduce((under, layer) => [...over(layer, under), 1], wallpaper);
};
// The card's paint opacity fades both the text and its backdrop into the
// wallpaper, as the compositor does.
const labelContrast = (label, card, wallpaper) => {
    const fade = card.get_paint_opacity() / 255;
    const under = backdrop(label, card, wallpaper);
    const text = over(rgba(label.get_theme_node().get_foreground_color()), under);
    return contrast(over([...text, fade], wallpaper), over([...under, fade], wallpaper));
};

function checkCard(card, where) {
    const labels = card.button.get_child().get_children()[1].get_children();
    assert(labels.length === 2, `${where} card has a name and a state`);
    const states = card.button.reactive ? [null, 'hover', 'focus'] : [null];
    for (const state of states) {
        if (state) card.button.add_style_pseudo_class(state);
        for (const [name, wallpaper] of Object.entries(WALLPAPERS)) {
            for (const label of labels) {
                const ratio = labelContrast(label, card.button, wallpaper);
                readable(ratio, `${where} card "${label.text}" ${state ?? 'normal'} on a ${name} wallpaper (${ratio.toFixed(2)}:1)`);
            }
        }
        if (state) card.button.remove_style_pseudo_class(state);
    }
}

async function screenshot() {
    const path = GLib.getenv('SNAPTESS_PIN_CONTRAST_SCREENSHOT');
    if (!path) return;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const m = Main.layoutManager.primaryMonitor;
    await new Shell.Screenshot().screenshot_area(m.x, m.y, m.width, m.height, stream);
    stream.close(null);
}

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: pin-card-contrast-shell.js');
    await Scripting.sleep(1000); Main.overview.hide();
    const entry = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    for (let n = 0; n < 30 && !entry?.stateObj?.runtime; n++) await Scripting.sleep(100);
    const app = entry?.stateObj?.runtime; assert(app, 'runtime loaded');
    for (let i = 0; i < 4; i++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows(); await pause();
    const windows = [...app.records.keys()];
    assert(windows.length === 4, `tracked four windows, got ${windows.length}`);
    app.setRunning(true); await pause();

    const pinId = 'snaptess-test-pinned.desktop', missingId = 'snaptess-test-missing.desktop';
    const closedId = ['org.gnome.Shell.Extensions.desktop', 'org.gnome.Settings.desktop']
        .find(id => Shell.AppSystem.get_default().lookup_app(id)?.get_app_info?.());
    const originalAppId = app.appId, profileKey = app.profileKey(0, 0);
    app.appId = w => w === windows[0] ? pinId : originalAppId.call(app, w);
    try {
        await checkCards(app, windows, profileKey, pinId, closedId, missingId);
    } finally {
        app.appId = originalAppId;
        await Scripting.destroyTestWindows();
    }
    for (const message of unreadable) console.log(`SNAPTESS_UNREADABLE: ${message}`);
    assert(!unreadable.length, `${unreadable.length} unreadable labels, first: ${unreadable[0]}`);
    console.log('SNAPTESS_PIN_CARD_TESTS_PASSED');
}

async function checkCards(app, windows, profileKey, pinId, closedId, missingId) {
    app.profiles[profileKey] = {...app.profiles[profileKey], preset: '3x3',
        pinned: [pinId, null, null, null, closedId ?? null, missingId], slotCount: 6};
    app.tile(true); await pause();
    windows[0].minimize(); await pause();

    const minimized = app.pinnedPlaceholders.get('0:0');
    assert(minimized?.state === 'MINIMIZED' && minimized.button.reactive, 'a minimized pinned app shows its card');
    checkCard(minimized, 'minimized');
    if (closedId) {
        const closed = app.pinnedPlaceholders.get('0:4');
        assert(closed?.state === 'CLOSED' && closed.button.reactive, 'a closed pinned app shows its card');
        checkCard(closed, 'closed');
    }
    const missing = app.pinnedPlaceholders.get('0:5');
    assert(missing?.button.has_style_class_name('unavailable'), 'a pinned app that cannot open shows an unavailable card');
    checkCard(missing, 'unavailable');
    await screenshot();
}
