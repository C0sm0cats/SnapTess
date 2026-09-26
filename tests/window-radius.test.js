import test from 'node:test';
import assert from 'node:assert/strict';
import {radiusFromPixels, radiusStyle, plausibleWindowRadius, visualFrameRect} from '../lib/window-radius.js';

function edge(height, top, bottom, rowstride = 16) {
    const pixels = new Uint8Array(height * rowstride);
    for (let y = top; y < height - bottom; y++) pixels[y * rowstride + 3] = 255;
    return pixels;
}

test('left-edge alpha produces independent mirrored top and bottom radii', () => {
    assert.deepEqual(radiusFromPixels(edge(80, 0, 16), 16, 4, 3, 80), {top: 0, bottom: 16});
    assert.deepEqual(radiusFromPixels(edge(80, 18, 0), 16, 4, 3, 80), {top: 18, bottom: 0});
    assert.deepEqual(radiusFromPixels(edge(100, 12, 27), 16, 4, 3, 100), {top: 12, bottom: 27});
    assert.deepEqual(radiusFromPixels(edge(200, 70, 4), 16, 4, 3, 200), {top: 70, bottom: 4});
    assert.equal(radiusStyle({top: 0, bottom: 16}, 12), '0px 0px 16px 16px');
    assert.equal(radiusStyle({top: 18, bottom: 0}, 12), '18px 18px 0px 0px');
});

test('invalid and transparent captures retry rather than caching a false radius', () => {
    assert.equal(radiusFromPixels(null, 16, 4, 3, 80), null);
    assert.equal(radiusFromPixels(new Uint8Array(80 * 16), 16, 4, 3, 80), null);
    assert.deepEqual(radiusFromPixels(edge(80, 0, 0), 16, 4, 3, 80), {top: 0, bottom: 0});
    assert.deepEqual(radiusFromPixels(edge(80, 0, 0), 16, 3, 3, 80, false), {top: 0, bottom: 0});
    assert.equal(radiusStyle(null, 12), '12px 12px 12px 12px');
    assert.equal(radiusStyle({top: 10, bottom: 20}, 12, 0.5), '5px 5px 10px 10px');
});

test('horizontal edge rejects a transparent side strip mistaken for a huge corner', () => {
    const width = 160, height = 240, rowstride = width * 4;
    const pixels = new Uint8Array(height * rowstride);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if ((x === 0 && y >= height - 120) || (y === height - 1 && x < 16)) continue;
        pixels[y * rowstride + x * 4 + 3] = 255;
    }
    assert.deepEqual(radiusFromPixels(pixels, rowstride, 4, width, height), {top: 0, bottom: 16});
});

test('implausible transparent edges cannot create a giant focus-border corner', () => {
    assert.deepEqual(plausibleWindowRadius({top: 7, bottom: 123}), {top: 7, bottom: 7});
    assert.deepEqual(plausibleWindowRadius({top: 70, bottom: 4}), {top: 4, bottom: 4});
    assert.deepEqual(plausibleWindowRadius({top: 0, bottom: 16}), {top: 0, bottom: 16});
    assert.equal(plausibleWindowRadius({top: 70, bottom: 90}), null);
});

test('scaled frame follows the actor buffer pivot and translation', () => {
    const frame = {x: 110, y: 64, width: 600, height: 400};
    assert.deepEqual(visualFrameRect(frame, {
        x: 100, y: 50, width: 640, height: 440, scaleX: 0.5, scaleY: 0.5,
        pivotX: 10 / 640, pivotY: 14 / 440, translationX: 200, translationY: 100,
    }), {x: 310, y: 164, width: 300, height: 200});
    assert.deepEqual(visualFrameRect(frame, null), frame);
});
