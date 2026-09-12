import test from 'node:test';
import assert from 'node:assert/strict';
import {layout, autoLayout, nearestSlot, directionalSlot, reconcileSlots, PRESETS} from '../lib/layout.js';

test('SmartGrid layout progression, including more than 15 windows', () => {
    assert.deepEqual([1,2,3,4,5,7,10,13].map(autoLayout), ['full','split','master','2x2','3x2','3x3','4x3','5x3']);
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
test('directional swap follows geometric neighbors', () => {
    const r=layout({x:0,y:0,width:1000,height:800},4);
    assert.equal(directionalSlot(r,0,'left'),-1);
    assert.equal(directionalSlot(r,0,'right'),1);
    assert.equal(directionalSlot(r,0,'down'),2);
    assert.equal(directionalSlot(r,3,'up'),1);
    assert.equal(nearestSlot(r,999,799),3);
});
test('compaction retains order and non-compact mode retains holes', () => {
    const a={},b={},c={},d={};
    assert.deepEqual(reconcileSlots([a,b,c],[a,c],false),[a,null,c]);
    assert.deepEqual(reconcileSlots([a,null,c],[a,c,d],false),[a,d,c]);
    assert.deepEqual(reconcileSlots([a,b,c],[a,c],true),[a,c]);
    assert.deepEqual(reconcileSlots([a,b],[a,b,d],true),[a,b,d]);
});
test('invalid preset falls back and empty groups are empty', () => {
    const area={x:0,y:0,width:100,height:100};
    assert.deepEqual(layout(area,0),[]);
    assert.equal(layout(area,3,{preset:'broken'}).length,3);
});
