import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const assert = (condition, message) => {
    if (!condition) throw new Error(`Focus border: ${message}`);
};

export async function run() {
    console.log('SNAPTESS_TEST_STARTED: focus-border-shell.js');
    await Scripting.sleep(1200);
    Main.overview.hide();
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    let app;
    for (let n = 0; n < 30 && !app; n++) {
        app = Main.extensionManager.lookup('snaptess@c0sm0cats.github.io')?.stateObj?.runtime;
        if (!app) await Scripting.sleep(100);
    }
    assert(app, 'runtime loaded');
    for (let n = 0; n < 5; n++) await Scripting.createTestWindow({width: 320, height: 240});
    await Scripting.waitTestWindows();
    app.settings.set_boolean('active-border', true);
    app.settings.set_boolean('animations', true);
    app.setRunning(true);
    await Scripting.sleep(1000);
    const windows = [...app.records.keys()];
    assert(windows.length === 5, 'five native windows tracked');
    assert(windows.some(w => !app.records.get(w).activeWindowRadius), 'first pass includes unmeasured active corners');

    let target = null, painted = 0, frames = 0, misses = 0, surfaceMismatches = 0;
    const samples = new Map();
    const paint = global.stage.connect('after-paint', () => {
        if (!target) return;
        frames++;
        if (app.borderFocusWindow !== target || !app.border.visible || app.border.opacity < 200) return;
        painted++;
        if (!samples.has(target)) samples.set(target, {
            top: app.border.topRadius, bottom: app.border.bottomRadius,
            topRight: app.border.topRightRadius, bottomRight: app.border.bottomRightRadius,
        });
    });
    const repaint = app.border.connect('repaint', () => {
        const [width, height] = app.border.get_surface_size();
        const scale = width / Math.max(1, app.border.width);
        if (scale < 0.9 || Math.abs(height / Math.max(1, app.border.height) - scale) > 0.05)
            surfaceMismatches++;
    });
    try {
        for (let n = 0; n < 35; n++) {
            target = windows[n % windows.length];
            painted = 0;
            target.activate(global.get_current_time());
            await Scripting.sleep(50);
            if (!painted) misses++;
        }
        target = null;
        assert(misses === 0, `every first and cached activation paints a border (${misses} missed)`);
        assert(surfaceMismatches === 0, 'no border surface is discarded during rapid transfers');
        assert(samples.size === windows.length, 'every native window has painted its outline');
        // Check early corners against a later readback after client decoration
        // repaints have had ample time to settle, without changing the outline.
        for (const w of windows) {
            w.activate(global.get_current_time());
            await Scripting.sleep(350);
            const radius = await app.measureWindowRadius(w);
            assert(radius, 'settled corners remain measurable');
            const scale = app.windowActor(w).get_scale()[0];
            const first = samples.get(w);
            assert(Object.keys(first).every(key => first[key] === radius[key] * scale),
                'the first displayed corners match the settled client frame');
        }
        console.log(`SNAPTESS_FOCUS_BORDER_PASSED activations=35 intervalMs=50 frames=${frames} misses=${misses}`);
    } finally {
        global.stage.disconnect(paint);
        app.border.disconnect(repaint);
        app.setRunning(false);
        await Scripting.destroyTestWindows();
    }
}
