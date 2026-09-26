import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, autoLayout, capacity, fitMinimumSize, frameScalePivot, nearestSlot, directionalSlot, reconcileSlots,
    activePinnedSlots, reserveAppSlots, swapNeighbor, PRESETS} from '../lib/layout.js';

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
