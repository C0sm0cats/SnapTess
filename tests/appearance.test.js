import test from 'node:test';
import assert from 'node:assert/strict';
import {paddingOptions, animationDuration, borderOptions} from '../lib/appearance.js';
import {layout, PRESETS, capacity, resizedLayout} from '../lib/layout.js';
const settings = values => ({get_int: key => values[key], get_boolean: key => !!values[key], get_string: key => values[key]});

test('common and independent margins share the same scaled preview geometry', () => {
    const s = settings({padding: 24, 'independent-padding': true,
        'padding-top': 10, 'padding-right': 20, 'padding-bottom': 30, 'padding-left': 40});
    assert.deepEqual(paddingOptions(s, 0.5), {top: 5, right: 10, bottom: 15, left: 20});
    assert.equal(paddingOptions(settings({padding: 24}), 0.5), 12);
});

test('every complete preset respects independent outer margins and internal gaps', () => {
    const area = {x: -1200, y: 40, width: 1200, height: 900};
    for (const [preset] of PRESETS) {
        if (preset === 'auto') continue;
        const rects = layout(area, capacity(preset), {preset, padding: {top: 7, right: 19, bottom: 31, left: 43}, gap: 12});
        assert.equal(Math.min(...rects.map(r => r.x)), area.x + 43, preset);
        assert.equal(Math.min(...rects.map(r => r.y)), area.y + 7, preset);
        assert.equal(Math.max(...rects.map(r => r.x + r.width)), area.x + area.width - 19, preset);
        assert.equal(Math.max(...rects.map(r => r.y + r.height)), area.y + area.height - 31, preset);
        assert(rects.every(r => r.width > 0 && r.height > 0), preset);
    }
});

test('excessive margins leave a positive full tile inside the work area', () => {
    const [r] = layout({x: 0, y: 0, width: 20, height: 10}, 1,
        {padding: {left: 64, right: 64, top: 0, bottom: 64}});
    assert(r.width >= 1 && r.height >= 1 && r.x + r.width <= 20 && r.y + r.height <= 10);
});

test('saved resize cannot translate tiles outside their configured outer margins', () => {
    const area = {x: 0, y: 0, width: 1000, height: 800};
    const base = layout(area, 2, {padding: {top: 10, bottom: 20, left: 30, right: 40}});
    assert.deepEqual(resizedLayout(base, area, {offsets: [[-0.02, 0, 0, 0], [-0.02, 0, 0, 0]]}), base);
});

test('animation presets preserve relative durations and normal defaults', () => {
    for (const [speed, expected] of [['fast', 80], ['normal', 140], ['slow', 250], ['custom', 350]]) {
        const s = settings({'animation-speed': speed, 'animation-duration': 350});
        assert.equal(animationDuration(s), expected);
        assert.equal(animationDuration(s, 210), Math.round(expected * 1.5));
    }
    assert.equal(animationDuration(settings({'animation-speed': 'unknown'}), 230), 230);
    assert.equal(animationDuration(settings({'animation-speed': 'custom', 'animation-duration': 900})), 500);
});

test('focus color follows accent unless a valid custom color is enabled', () => {
    const values = {'border-custom-color': true, 'border-color': '#abc123', 'border-width': 6, 'border-style': 'halo'};
    assert.deepEqual(borderOptions(settings(values), '#3584e4'), {color: '#abc123', width: 6, style: 'halo'});
    assert.equal(borderOptions(settings({...values, 'border-custom-color': false}), '#ff0000').color, '#ff0000');
    assert.equal(borderOptions(settings({...values, 'border-color': 'invalid'}), '#ff0000').color, '#ff0000');
});
