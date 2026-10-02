import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, capacity, validCustomTiles, splitCustomTile, mergeCustomTiles,
    moveCustomEdge, setCustomTileValue, resizeDivider, resizeOffsets, resizedLayout,
    directionalFocusSlot, swapNeighbor} from '../lib/layout.js';

const full = [{x: 0, y: 0, width: 1, height: 1}];
const focus = [{x: 0, y: 0, width: .6, height: 1},
    {x: .6, y: 0, width: .4, height: .5}, {x: .6, y: .5, width: .4, height: .5}];

test('custom geometry validates complete rectangular coverage and rejects corrupted partitions', () => {
    assert.ok(validCustomTiles(full)); assert.ok(validCustomTiles(focus));
    for (const tiles of [[], null, [{...full[0], width: .9}],
        [full[0], full[0]], [{...full[0], x: -.01}], [{...full[0], height: NaN}],
        [{...full[0], width: .0001}, {...full[0], x: .0001, width: .9999}],
        [{...full[0], width: .123456}, {...full[0], x: .123456, width: .876544}]])
        assert.equal(validCustomTiles(tiles), false);
    assert.equal(capacity('custom', focus), 3);
    assert.equal(capacity('custom'), 0);
});

test('split and merge preserve topology with exact integer boundaries and bounded tile counts', () => {
    const pair = splitCustomTile(full, 0, 'vertical');
    const three = splitCustomTile(pair, 1, 'horizontal');
    assert.ok(validCustomTiles(three));
    assert.deepEqual(mergeCustomTiles(three, 1, 2).tiles, pair);
    assert.equal(mergeCustomTiles(three, 0, 1), null); // L-shaped union
    assert.deepEqual(mergeCustomTiles(pair, 1, 0).tiles, full);
    let tiles = full;
    while (tiles.length < 30) {
        const i = tiles.findIndex(t => Math.max(t.width, t.height) >= .06);
        tiles = splitCustomTile(tiles, i, tiles[i].width >= tiles[i].height ? 'vertical' : 'horizontal');
        assert.ok(validCustomTiles(tiles));
    }
    assert.equal(splitCustomTile(tiles, 0, 'vertical'), null);
});

test('numeric edge edits and drag pressure update every neighbor at a T junction', () => {
    const changed = setCustomTileValue(focus, 0, 'width', .7);
    assert.ok(validCustomTiles(changed));
    assert.equal(changed[0].width, .7);
    assert.equal(changed[1].x, .7); assert.equal(changed[2].x, .7);
    assert.equal(changed[1].width, .3);
    assert.deepEqual(moveCustomEdge(focus, 0, 'E', .1), changed);
    const leftEdge = setCustomTileValue(changed, 1, 'x', .65);
    assert.equal(leftEdge[0].width, .65); assert.ok(validCustomTiles(leftEdge));
    const horizontal = setCustomTileValue(focus, 1, 'height', .75);
    assert.equal(horizontal[2].y, .75); assert.ok(validCustomTiles(horizontal));
    assert.deepEqual(setCustomTileValue(full, 0, 'x', .2), full);
    assert.ok(validCustomTiles(moveCustomEdge(focus, 0, 'E', 10)));
    assert.equal(setCustomTileValue(focus, 0, 'width', Infinity), null);
    assert.equal(setCustomTileValue(focus, 0, 'width', 2), null);
    const rightWidth = setCustomTileValue(focus, 1, 'width', .3);
    assert.equal(rightWidth[0].width, .7); assert.equal(rightWidth[2].width, .3);
    const bottomHeight = setCustomTileValue(focus, 2, 'height', .3);
    assert.equal(bottomHeight[1].height, .7); assert.equal(bottomHeight[2].height, .3);
});

test('custom layouts honor asymmetric margins and exact shared gaps at odd resolutions', () => {
    const area = {x: 1920, y: 17, width: 1365, height: 767};
    const rects = layout(area, 3, {preset: 'custom', tiles: focus, gap: 13,
        padding: {left: 21, right: 7, top: 9, bottom: 15}});
    assert.equal(rects[0].x, 1941); assert.equal(rects[0].y, 26);
    assert.equal(rects[0].height, 743);
    assert.equal(rects[1].x - rects[0].x - rects[0].width, 13);
    assert.equal(rects[2].y - rects[1].y - rects[1].height, 13);
    assert.equal(rects[1].x, rects[2].x);
    assert.equal(rects[1].x + rects[1].width, 3278);
    assert.equal(rects[2].y + rects[2].height, 769);
    const overflow = layout(area, 4, {preset: 'custom', tiles: focus});
    assert.equal(overflow.length, 4); // Existing Auto fallback when new windows exceed capacity.
});

test('custom partitions reuse linked resize persistence and directional focus and swap', () => {
    const area = {x: 0, y: 0, width: 1600, height: 1000};
    const base = layout(area, 3, {preset: 'custom', tiles: focus, gap: 12, padding: 12});
    const changed = resizeDivider(base, 0, 'E', 80);
    assert.equal(changed[1].x, base[1].x + 80); assert.equal(changed[2].x, base[2].x + 80);
    assert.deepEqual(resizedLayout(base, area, {offsets: resizeOffsets(base, changed, area)}), changed);
    assert.equal(directionalFocusSlot(base, 1, 'down'), 2);
    assert.equal(swapNeighbor(base, 1, 'down'), 2);
});
