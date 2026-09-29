import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, autoLayout, capacity, fitMinimumSize, frameScalePivot, nearestSlot, directionalSlot, reconcileSlots,
    activePinnedSlots, reserveAppSlots, swapNeighbor, PRESETS, sortedSavedLayouts,
    resizeDivider, resizedLayout, resizeOffsets} from '../lib/layout.js';

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
    assert.equal(resized[2].y, 120);
    assert.equal(resized[0].height, 110);
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
