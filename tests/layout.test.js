import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, autoLayout, capacity, fitMinimumSize, frameScalePivot, nearestSlot, directionalSlot, directionalFocusSlot, reconcileSlots,
    activePinnedSlots, reserveAppSlots, edgeNeighbors, swapNeighbor, PRESETS, sortedSavedLayouts,
    resizeDivider, advanceLinkedResize, resizedLayout, resizeOffsets} from '../lib/layout.js';

function assertPartition(rects, base, gap = 12) {
    const covered = values => values.reduce((sum, r) => sum + (r.width + gap) * (r.height + gap), 0);
    assert.equal(covered(rects), covered(base), 'resizing preserves the complete tiled area');
    const left = Math.min(...base.map(r => r.x)), top = Math.min(...base.map(r => r.y));
    const right = Math.max(...base.map(r => r.x + r.width)), bottom = Math.max(...base.map(r => r.y + r.height));
    rects.forEach((r, i) => {
        assert.ok(r.x >= left && r.y >= top && r.x + r.width <= right && r.y + r.height <= bottom);
        assert.ok(r.width >= Math.min(80, base[i].width) && r.height >= Math.min(80, base[i].height));
        for (let j = i + 1; j < rects.length; j++) {
            const b = rects[j];
            assert.ok(r.x + r.width + gap <= b.x || b.x + b.width + gap <= r.x ||
                r.y + r.height + gap <= b.y || b.y + b.height + gap <= r.y,
            `tiles ${i} and ${j} preserve the gutter`);
        }
    });
}

test('a shared divider resizes only its neighboring row or column', () => {
    const area = {x: 0, y: 0, width: 1000, height: 800};
    const base = layout(area, 4, {preset: '2x2', gap: 12, padding: 12});
    const horizontal = resizeDivider(base, 0, 'E', 100);
    assert.equal(horizontal[0].width, base[0].width + 100);
    assert.deepEqual(horizontal[2], base[2]);
    assert.equal(horizontal[1].x, base[1].x + 100);
    assert.deepEqual(horizontal[3], base[3]);
    assert.equal(horizontal[0].x + horizontal[0].width + 12, horizontal[1].x);
    const corner = resizeDivider(base, 0, 'S', 50);
    assert.equal(corner[0].height, base[0].height + 50);
    assert.equal(corner[1].height, base[1].height);
    assert.equal(corner[2].y, base[2].y + 50);
    assert.deepEqual(corner[3], base[3]);
    assert.deepEqual(resizeDivider(base, 0, 'W', 40), base, 'outside edge has no neighbor');
    assert.equal(resizeDivider(base, 0, 'E', 9999)[1].width, 80);
});

test('focus layout resizes its column and its right-hand row independently', () => {
    const base = layout({x: 0, y: 0, width: 1000, height: 800}, 3, {preset: 'master'});
    const column = resizeDivider(base, 0, 'E', -90);
    assert.equal(column[1].x, base[1].x - 90);
    assert.equal(column[2].x, base[2].x - 90);
    const row = resizeDivider(column, 1, 'S', 55);
    assert.deepEqual(row[0], column[0]);
    assert.equal(row[2].y, column[2].y + 55);
    const fromStack = resizeDivider(base, 1, 'W', -90);
    assert.equal(fromStack[0].width, base[0].width - 90);
    assert.equal(fromStack[1].x, base[1].x - 90);
    assert.equal(fromStack[2].x, base[2].x - 90,
        'a full-height master requires both stacked neighbors to move');
});

test('a staggered shared edge moves on the requested axis without leaving holes', () => {
    const area = {x: 0, y: 0, width: 2560, height: 1408};
    let rects = layout(area, 15, {preset: 'auto', gap: 12, padding: 12});
    rects = resizeDivider(rects, 12, 'N', -385);
    rects = resizeDivider(rects, 2, 'W', -52);
    const moved = resizeDivider(rects, 7, 'N', -26);
    assert.equal(moved[7].y, rects[7].y - 26, 'the dragged edge follows the pointer immediately');
    rects.forEach((r, i) => {
        assert.equal(moved[i].x, r.x, 'vertical resizing never shifts a horizontal border');
        assert.equal(moved[i].width, r.width);
    });
    assertPartition(moved, rects);
});

test('a dragged divider uses every later column before reaching its limit', () => {
    const base = layout({x: 0, y: 0, width: 1000, height: 800}, 16,
        {preset: '4x4', gap: 12, padding: 12});
    const firstCapacity = base[1].width - 80;
    const expanded = resizeDivider(base, 0, 'E', firstCapacity + 60);
    assert.equal(expanded[0].width, base[0].width + firstCapacity + 60);
    assert.equal(expanded[1].width, 80);
    assert.equal(expanded[2].width, base[2].width - 60);
    assert.equal(expanded[3].width, base[3].width);
    assert.deepEqual(expanded[4], base[4], 'other rows keep their geometry');
    let previous = base[0].width;
    for (let delta = 0; delta <= 1000; delta += 25) {
        const rects = resizeDivider(base, 0, 'E', delta);
        assert.ok(rects[0].width >= previous, 'dragged tile never shrinks as the divider advances');
        previous = rects[0].width;
        assert.ok(rects.every(r => r.width >= 80));
        for (let i = 0; i < 3; i++)
            assert.equal(rects[i].x + rects[i].width + 12, rects[i + 1].x);
    }
    assert.deepEqual(resizeDivider(base, 0, 'E', 1000), resizeDivider(base, 0, 'E', 2000),
        'the outer edge caps further movement without reversing it');
    const fromRight = resizeDivider(base, 3, 'W', -(base[2].width - 80 + 60));
    assert.equal(fromRight[3].width, base[3].width + base[2].width - 80 + 60);
    assert.equal(fromRight[2].width, 80);
    assert.equal(fromRight[1].width, base[1].width - 60);
    assert.deepEqual(fromRight[7], base[7]);
});

test('pressure continues past a minimum neighbor with a staggered far band', () => {
    const base = layout({x: 0, y: 0, width: 1000, height: 800}, 16,
        {preset: '4x4', gap: 12, padding: 12});
    const staggered = resizeDivider(base, 2, 'S', 80);
    const firstCapacity = staggered[1].width - 80;
    const atMinimum = resizeDivider(staggered, 0, 'E', firstCapacity);
    assert.equal(atMinimum[1].width, 80);
    const aligning = resizeDivider(staggered, 0, 'E', firstCapacity + 1);
    assert.equal(aligning[0].width, atMinimum[0].width + 1);
    assert.equal(aligning[1].height, atMinimum[1].height);
    assertPartition(aligning, base);
    const continued = resizeDivider(staggered, 0, 'E', firstCapacity + 81);
    assert.equal(continued[0].width, atMinimum[0].width + 81);
    assert.equal(continued[2].width, staggered[2].width - 81);
    let previousWidth = staggered[0].width;
    for (let delta = 0; delta <= 600; delta += 10) {
        const rects = resizeDivider(staggered, 0, 'E', delta);
        assert.ok(rects[0].width >= previousWidth, 'the grabbed tile never reverses after far-band alignment');
        previousWidth = rects[0].width;
        assert.ok(rects.every((r, i) => rects.every((other, j) => i === j ||
            r.x >= other.x + other.width || other.x >= r.x + r.width ||
            r.y >= other.y + other.height || other.y >= r.y + r.height)));
    }
});

test('a corner drag crosses a newly connected distant tile without a jump', () => {
    const base = layout({x: 0, y: 0, width: 1600, height: 900}, 12,
        {preset: '4x3', gap: 12, padding: 12});
    let rects = base;
    for (const [index, edge, delta] of [[2, 'S', 15], [5, 'S', -98],
        [8, 'N', 58], [6, 'S', 152], [3, 'S', 52]])
        rects = resizeDivider(rects, index, edge, delta);
    const grab = {pointer: [0, 0], rects, index: 3, edges: ['S', 'W']};
    let previous = rects;
    for (let d = 1; d <= 400; d++) {
        const current = advanceLinkedResize(grab, [-d, d]);
        for (let i = 0; i < current.length; i++) {
            for (const key of ['x', 'y', 'width', 'height'])
                assert.ok(Math.abs(current[i][key] - previous[i][key]) <= 2,
                    `tile ${i} ${key} jumped at pointer step ${d}`);
            for (let j = i + 1; j < current.length; j++) {
                const a = current[i], b = current[j];
                assert.ok(a.x >= b.x + b.width || b.x >= a.x + a.width ||
                    a.y >= b.y + b.height || b.y >= a.y + a.height,
                `tiles ${i} and ${j} overlap at pointer step ${d}`);
            }
        }
        previous = current;
    }
    assert.deepEqual(advanceLinkedResize(grab, [0, 0]), rects,
        'reversing the pointer restores the exact initial geometry');
});

test('the same pressure propagation works across later rows', () => {
    const base = layout({x: 0, y: 0, width: 1000, height: 800}, 16,
        {preset: '4x4', gap: 12, padding: 12});
    const firstCapacity = base[4].height - 80;
    const resized = resizeDivider(base, 0, 'S', firstCapacity + 40);
    assert.equal(resized[0].height, base[0].height + firstCapacity + 40);
    assert.equal(resized[4].height, 80);
    assert.equal(resized[8].height, base[8].height - 40);
    assert.equal(resized[12].height, base[12].height);
    assert.deepEqual(resized[1], base[1], 'other columns keep their geometry');
});

test('shrinking a grabbed tile stops at its minimum without moving its far edge', () => {
    const base = layout({x: 0, y: 0, width: 1000, height: 800}, 16,
        {preset: '4x4', gap: 12, padding: 12});
    for (const [index, edge, delta, start, size] of [
        [1, 'E', -500, 'x', 'width'], [1, 'W', 500, 'x', 'width'],
        [4, 'S', -500, 'y', 'height'], [4, 'N', 500, 'y', 'height'],
    ]) {
        const result = resizeDivider(base, index, edge, delta);
        assert.equal(result[index][size], 80, `${edge} reaches the minimum`);
        const far = edge === 'E' || edge === 'S'
            ? r => r[start] : r => r[start] + r[size];
        assert.equal(far(result[index]), far(base[index]), `${edge} keeps its far edge fixed`);
        assert.deepEqual(resizeDivider(base, index, edge, delta * 2), result,
            `${edge} stops moving after reaching the minimum`);
    }
});

test('a staggered neighboring tile caps a local divider before overlap', () => {
    const rects = [
        {x: 0, y: 0, width: 100, height: 200},
        {x: 110, y: 0, width: 100, height: 120},
        {x: 0, y: 210, width: 150, height: 200},
    ];
    const resized = resizeDivider(rects, 2, 'N', -100);
    assert.equal(resized[2].y, 130);
    assert.equal(resized[0].height, 120);
    assert.deepEqual(resized[1], rects[1]);
});

test('saved resize offsets follow work-area changes', () => {
    const area = {x: 0, y: 0, width: 1000, height: 800};
    const base = layout(area, 2, {preset: 'split'});
    const resized = resizeDivider(base, 0, 'E', 100);
    const saved = {offsets: resizeOffsets(base, resized, area)};
    assert.deepEqual(resizedLayout(base, area, saved), resized);
    const wide = {x: 1000, y: 0, width: 2000, height: 800};
    const restored = resizedLayout(layout(wide, 2, {preset: 'split'}), wide, saved);
    assert.equal(restored[0].width, layout(wide, 2, {preset: 'split'})[0].width + 200);
    assert.equal(resizedLayout(base, area, {offsets: [[Infinity, 0, 0, 0], [0, 0, 0, 0]]}), base);
});

test('restoring compound resizes never overlaps tiles after an aspect-ratio change', () => {
    const options = {preset: 'split', gap: 12, padding: 12};
    const originalArea = {x: 0, y: 0, width: 819, height: 816};
    const original = layout(originalArea, 9, options);
    // Persisted geometry produced by the old solver; keep this fixture independent
    // of the corrected solver so the aspect-ratio fallback remains exercised.
    const resized = [
        {x:12,y:12,width:245,height:231}, {x:269,y:12,width:257,height:231},
        {x:538,y:12,width:269,height:256}, {x:12,y:255,width:245,height:80},
        {x:269,y:255,width:257,height:80}, {x:538,y:280,width:269,height:432},
        {x:12,y:347,width:434,height:457}, {x:446,y:347,width:80,height:457},
        {x:538,y:724,width:269,height:80},
    ];
    const saved = {offsets: resizeOffsets(original, resized, originalArea)};
    assert.deepEqual(resizedLayout(original, originalArea, saved), original,
        'old geometry with missing gutters is rejected even on the original monitor');

    const newArea = {x: 0, y: 0, width: 2474, height: 1660};
    const base = layout(newArea, 9, options);
    assert.deepEqual(resizedLayout(base, newArea, saved), base,
        'invalid saved proportions fall back to a non-overlapping layout');
});

test('saved layouts sort by tile count without changing stored order or equal-count order', () => {
    const saved = [{id: 'two', slotCount: 2}, {id: 'one-a', slotCount: 1},
        {id: 'three', slotCount: 3}, {id: 'one-b', slotCount: 1}];
    assert.deepEqual(sortedSavedLayouts(saved).map(item => item.id),
        ['three', 'two', 'one-a', 'one-b']);
    assert.deepEqual(saved.map(item => item.id), ['two', 'one-a', 'three', 'one-b']);
});

test('automatic layout progression, including more than 15 windows', () => {
    assert.deepEqual([1,2,3,4,5,7,10,13].map(autoLayout), ['full','split','master','2x2','3x2','3x3','4x3','5x3']);
    assert.deepEqual([16,17,20,21,25].map(autoLayout), ['4x4','5x4','5x4','5x5','5x5']);
    assert.deepEqual(['4x4','5x4','5x5'].map(capacity), [16,20,25]);
    assert.equal(layout({x:0,y:0,width:1920,height:1080}, 22).length,22);
});
test('every slot stays in the work area without overlap across scales and negative origins', () => {
    for (const area of [{x:0,y:32,width:1920,height:1048},{x:-1366,y:-300,width:1366,height:768},{x:1920,y:27,width:853,height:480}]) {
        for (let n=1;n<=30;n++) for (const [preset] of PRESETS) {
            const rects=layout(area,n,{preset,gap:13,padding:17});
            assert.equal(rects.length,n);
            for (let i=0;i<n;i++) {
                const a=rects[i];
                assert.ok(a.width>0 && a.height>0);
                assert.ok(a.x>=area.x && a.y>=area.y);
                assert.ok(a.x+a.width<=area.x+area.width && a.y+a.height<=area.y+area.height);
                for (const b of rects.slice(i+1)) assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
            }
        }
    }
});
test('split and master consume the available extent exactly', () => {
    const area={x:-100,y:20,width:1001,height:701};
    for (const n of [2,3]) {
        const r=layout(area,n,{padding:0,gap:11});
        assert.equal(r.at(-1).x+r.at(-1).width,901);
        assert.equal(r.at(-1).y+r.at(-1).height,721);
    }
});
test('minimum-size fitting preserves slot aspect and only scales constrained windows', () => {
    const slot={x:100,y:50,width:600,height:400};
    assert.deepEqual(fitMinimumSize(slot,500,300),{frame:slot,scale:1});
    const widthLimited=fitMinimumSize(slot,800,200);
    assert.equal(widthLimited.scale,0.75);
    assert.deepEqual(widthLimited.frame,{x:100,y:50,width:800,height:534});
    const heightLimited=fitMinimumSize(slot,300,800);
    assert.equal(heightLimited.scale,0.5);
    assert.deepEqual(heightLimited.frame,{x:100,y:50,width:1200,height:800});
});
test('frame scaling pivot anchors the visible frame inside a larger compositor buffer', () => {
    const frame={x:110,y:64,width:600,height:400};
    const buffer={x:100,y:50,width:640,height:440};
    const pivot=frameScalePivot(frame,buffer,800,500);
    assert.equal(pivot.x,10/800);
    assert.equal(pivot.y,14/500);
    assert.deepEqual(frameScalePivot(frame,frame,0,0),{x:0,y:0});
});
test('directional swap follows geometric neighbors', () => {
    const r=layout({x:0,y:0,width:1000,height:800},4);
    assert.equal(directionalSlot(r,0,'left'),-1);
    assert.equal(directionalSlot(r,0,'right'),1);
    assert.equal(directionalSlot(r,0,'down'),2);
    assert.equal(directionalSlot(r,3,'up'),1);
    assert.equal(nearestSlot(r,999,799),3);
    assert.equal(swapNeighbor(r,0,'right'),1);
    assert.equal(swapNeighbor(r,0,'down'),2);
    assert.equal(swapNeighbor(r,0,'left'),-1);
    const withHole=[{x:0,y:0,width:100,height:100},{x:110,y:0,width:100,height:100},
        {x:220,y:0,width:100,height:100}];
    assert.equal(swapNeighbor(withHole,0,'right'),1);
    assert.equal(swapNeighbor(withHole,2,'left'),1);
    assert.equal(swapNeighbor([{x:0,y:0,width:100,height:100},{x:110,y:110,width:100,height:100}],0,'right'),-1);
});
test('swap targets only windows across a shared edge and marks every neighbor', () => {
    // Focus: large tile on the left, two stacked tiles on the right.
    const focus=[{x:0,y:0,width:600,height:800},{x:612,y:0,width:388,height:394},{x:612,y:406,width:388,height:394}];
    assert.deepEqual(edgeNeighbors(focus,0,'right').map(n=>n.index),[1,2]);
    assert.equal(swapNeighbor(focus,0,'right'),1);
    assert.equal(swapNeighbor(focus,0,'right',i=>i!==1),2);
    assert.equal(swapNeighbor(focus,2,'left'),0);
    // A tile beyond the adjacent one is never a target, even when the adjacent one is unavailable.
    const row=[{x:0,y:0,width:100,height:100},{x:112,y:0,width:100,height:100},{x:224,y:0,width:100,height:100}];
    assert.equal(swapNeighbor(row,0,'right',i=>i!==1),-1);
    assert.deepEqual(edgeNeighbors(row,0,'right',i=>i!==1),[]);
    // The longest shared stretch wins over a centred sliver.
    const uneven=[{x:0,y:0,width:100,height:300},{x:112,y:0,width:100,height:250},{x:112,y:262,width:100,height:38}];
    assert.equal(swapNeighbor(uneven,0,'right'),1);
    assert.deepEqual(edgeNeighbors(uneven,0,'right').map(n=>n.index),[1,2]);
});
test('directional focus crosses holes, prefers aligned windows and never wraps', () => {
    const rects = [{x:-500,y:0,width:100,height:100}, null,
        {x:-280,y:0,width:100,height:100}, {x:-390,y:120,width:100,height:100}];
    assert.equal(directionalFocusSlot(rects, 0, 'right'), 2);
    assert.equal(directionalFocusSlot(rects, 0, 'down'), 3);
    assert.equal(directionalFocusSlot(rects, 2, 'left'), 0);
    assert.equal(directionalFocusSlot(rects, 2, 'right'), -1);
    assert.equal(directionalFocusSlot(rects, 0, 'up'), -1);
    assert.equal(directionalFocusSlot(rects, 1, 'right'), -1);
    assert.equal(directionalFocusSlot(rects, 0, 'invalid'), -1);
});
test('directional focus follows unequal tiles and resized divider geometry', () => {
    const master = layout({x:0,y:0,width:1000,height:800}, 3, {preset:'master', gap:0, padding:0});
    assert.equal(directionalFocusSlot(master, 1, 'left'), 0);
    assert.equal(directionalFocusSlot(master, 2, 'up'), 1);
    assert.equal(directionalFocusSlot(master, 0, 'right'), 1);
    const resized = [{x:0,y:0,width:200,height:300},
        {x:210,y:0,width:100,height:100}, {x:210,y:110,width:100,height:190}];
    assert.equal(directionalFocusSlot(resized, 0, 'right'), 2);
    assert.equal(directionalFocusSlot(resized, 2, 'up'), 1);
});
test('compaction retains order and non-compact mode retains holes', () => {
    const a={},b={},c={},d={};
    assert.deepEqual(reconcileSlots([a,b,c],[a,c],false),[a,null,c]);
    assert.deepEqual(reconcileSlots([a,null,c],[a,c,d],false),[a,d,c]);
    assert.deepEqual(reconcileSlots([a,b,c],[a,c],true),[a,c]);
    assert.deepEqual(reconcileSlots([a,b],[a,b,d],true),[a,b,d]);
});
test('reserved application slots survive closing and reopening without moving other apps', () => {
    const editor = {app: 'editor.desktop'}, browser = {app: 'browser.desktop'}, replacement = {app: 'editor.desktop'};
    const identify = w => w.app;
    const pinned = [null, 'editor.desktop'];
    assert.deepEqual(reserveAppSlots([browser, editor], pinned, identify), [browser, editor]);
    assert.deepEqual(reserveAppSlots([browser], pinned, identify), [browser, null]);
    assert.deepEqual(reserveAppSlots([browser, replacement], pinned, identify), [browser, replacement]);
    assert.deepEqual(reserveAppSlots([browser, null, editor], [null, null, 'editor.desktop'], identify, false),
        [browser, null, editor]);
    assert.deepEqual(reserveAppSlots([browser, editor], [], identify), [browser, editor]);
    assert.deepEqual(activePinnedSlots([browser, editor], [browser, editor], pinned, identify), pinned);
    assert.deepEqual(activePinnedSlots([editor, browser], [editor, browser], pinned, identify), [null, null]);
    assert.deepEqual(activePinnedSlots([editor, browser], [browser], pinned, identify), pinned);
    const secondEditor = {app: 'editor.desktop'};
    assert.deepEqual(activePinnedSlots([editor, null], [editor],
        ['editor.desktop', 'editor.desktop'], identify), ['editor.desktop', 'editor.desktop'],
    'closing one of two pinned windows from the same app keeps its reserved slot');
    assert.deepEqual(activePinnedSlots([null, secondEditor], [secondEditor],
        ['editor.desktop', 'editor.desktop'], identify), ['editor.desktop', 'editor.desktop']);
});
test('invalid preset falls back and empty groups are empty', () => {
    const area={x:0,y:0,width:100,height:100};
    assert.deepEqual(layout(area,0),[]);
    assert.equal(layout(area,3,{preset:'broken'}).length,3);
});

test('alternating windows and axes preserves coverage, gutters and opposite edges', () => {
    let seed = 41374;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    for (const count of [4, 9, 15, 16, 25]) {
        const base = layout({x: -1000, y: 32, width: 2560, height: 1408}, count);
        let rects = base;
        for (let step = 0; step < 500; step++) {
            const index = Math.floor(random() * count), edge = ['E', 'W', 'N', 'S'][Math.floor(random() * 4)];
            const delta = Math.round(random() * 1200 - 600);
            const next = resizeDivider(rects, index, edge, delta);
            const horizontal = edge === 'E' || edge === 'W';
            const start = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
            const far = r => r[start] + (edge === 'W' || edge === 'N' ? r[size] : 0);
            assert.equal(far(next[index]), far(rects[index]), 'the opposite edge stays anchored');
            rects.forEach((r, i) => {
                assert.equal(next[i][horizontal ? 'y' : 'x'], r[horizontal ? 'y' : 'x']);
                assert.equal(next[i][horizontal ? 'height' : 'width'], r[horizontal ? 'height' : 'width']);
            });
            assertPartition(next, base);
            rects = next;
        }
    }
});

test('a straight grab solves large deltas directly and reverses without retained pixel states', () => {
    const rects = layout({x: 0, y: 0, width: 2560, height: 1408}, 25);
    const grab = {rects, index: 0, pointer: [0, 0], edges: ['E']};
    assertPartition(advanceLinkedResize(grab, [10000, 10000]), rects);
    assert.equal(grab.steps, undefined);
    assert.deepEqual(advanceLinkedResize(grab, [0, 10000]), rects);
});

test('corner drags preserve coverage across changing windows and reversals', () => {
    const base = layout({x: 0, y: 0, width: 1600, height: 900}, 16);
    let rects = base;
    for (let index = 0; index < 16; index++) {
        const grab = {rects, index, pointer: [0, 0], edges: [index % 2 ? 'W' : 'E', index % 3 ? 'S' : 'N']};
        for (const pointer of [[90, 90], [30, 30], [220, 60], [-70, 140], [-90, -90], [0, 0]]) {
            rects = advanceLinkedResize(grab, pointer);
            assertPartition(rects, base);
        }
    }
});

test('fast corner motion matches slow motion at topology changes', () => {
    let seed = 418;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 32; trial++) {
        let rects = layout({x: 0, y: 0, width: 1600, height: 900}, 16);
        for (let n = 0; n < 10; n++) rects = resizeDivider(rects, Math.floor(random() * 16),
            ['E', 'W', 'N', 'S'][Math.floor(random() * 4)], Math.round(random() * 800 - 400));
        const index = Math.floor(random() * 16), edges = [random() < .5 ? 'E' : 'W', random() < .5 ? 'N' : 'S'];
        const dx = random() < .5 ? -1 : 1, dy = random() < .5 ? -1 : 1;
        const grab = {rects, index, edges, pointer: [0, 0]};
        const batched = advanceLinkedResize(grab, [dx * 200, dy * 200]);
        const slow = {rects, index, edges, pointer: [0, 0]};
        let stepped;
        for (let n = 1; n <= 200; n++) stepped = advanceLinkedResize(slow, [dx * n, dy * n]);
        assert.ok(slow.steps.length < 50, 'steady motion does not retain one layout per pointer sample');
        assert.deepEqual(batched, stepped, `sampling frequency does not change the layout (${trial})`);
        assertPartition(batched, rects);
        assert.deepEqual(advanceLinkedResize(grab, [0, 0]), rects, 'batched steps reverse exactly');
    }
});

test('restored proportions preserve gutters and coverage after monitor changes', () => {
    let seed = 814;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 100; trial++) {
        const area = {x: 0, y: 32, width: 1200 + Math.floor(random() * 1600), height: 800 + Math.floor(random() * 700)};
        const base = layout(area, 16);
        let rects = base;
        for (let n = 0; n < 8; n++) rects = resizeDivider(rects, Math.floor(random() * 16),
            ['E', 'W', 'N', 'S'][Math.floor(random() * 4)], Math.round(random() * 500 - 250));
        const saved = {offsets: resizeOffsets(base, rects, area)};
        assert.deepEqual(resizedLayout(base, area, saved), rects, 'saving and restoring the same screen is lossless');
        const dest = {x: 0, y: 32, width: 1400 + Math.floor(random() * 1200), height: 900 + Math.floor(random() * 600)};
        const next = layout(dest, 16);
        assertPartition(resizedLayout(next, dest, saved), next);
    }
});

test('noncompact Space switches do not expand a 4x4 because of trailing unpinned profile entries', () => {
    const windows = Array.from({length: 16}, (_, i) => ({id: `app-${i}`}));
    const pins = [...windows.slice(0, 15).map(w => w.id), null, null, null, null];
    const slots = reserveAppSlots(windows, pins, w => w.id, false);
    assert.deepEqual(slots, windows);
    assert.equal(layout({x: 0, y: 0, width: 2560, height: 1408}, slots.length).length, 16);
    const hole = [...windows]; hole[8] = null;
    assert.equal(reserveAppSlots(hole, pins, w => w.id, false)[8], null,
        'an actual reserved empty tile remains in place');
    assert.equal(reserveAppSlots([...windows, null], pins, w => w.id, false).length, 17,
        'noncompact layouts keep explicit existing holes');
});

test('adaptive classic presets grow and shrink to the window count while Custom keeps its tiles', () => {
    const area = {x: 0, y: 0, width: 1600, height: 900};
    for (const [preset] of PRESETS) {
        for (const count of [2, 9, 16, 20]) {
            assert.deepEqual(layout(area, count, {preset, adaptive: true}), layout(area, count));
        }
    }
    const tiles = [{x: 0, y: 0, width: .7, height: 1}, {x: .7, y: 0, width: .3, height: 1}];
    assert.deepEqual(layout(area, 1, {preset: 'custom', tiles, adaptive: true}),
        layout(area, 2, {preset: 'custom', tiles}).slice(0, 1));
});
