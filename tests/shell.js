import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
export const METRICS = {};
const assert = (condition, message) => { if (!condition) throw new Error(`SnapTess: ${message}`); };
const pause = () => Scripting.sleep(400);
const geometry = w => { const r=w.get_frame_rect(); return [r.x,r.y,r.width,r.height].join(','); };
async function waitRuntime(loader) {
    for (let i=0;i<30 && !loader.runtime;i++) await Scripting.sleep(100);
    return loader.runtime;
}
export async function run() {
    await Scripting.sleep(1200);
    Main.overview.hide(); await pause();
    const entry=Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
    assert(entry?.stateObj, `extension loaded (${JSON.stringify(entry?.errors)})`);
    const loader=entry.stateObj;
    const hotRoot=Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(),
        'snaptess-hot-reload',
    ]));
    const app=await waitRuntime(loader);
    assert(app,'runtime loaded');
    assert(hotRoot.query_exists(null),'hot reload staging exists while enabled');
    assert(!app.running,'starts without moving windows');
    for(let i=0;i<4;i++) await Scripting.createTestWindow({width:320,height:240});
    await Scripting.waitTestWindows(); await pause();
    const windows=[...app.records.keys()];
    assert(windows.length===4,`tracked four native windows, got ${windows.length}`);
    const originals=windows.map(w=>app.snapshot(w));
    app.setRunning(true); await pause();
    assert(app.groups.get(app.key(0)).length===4,'four tiled slots');
    let rects=windows.map(w=>w.get_frame_rect());
    for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) {
        const a=rects[i],b=rects[j];
        assert(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y,'non-overlapping native frames');
    }
    const stubborn=windows[0], stubbornRecord=app.records.get(stubborn);
    const stubbornTarget={...stubbornRecord.tileRect};
    stubborn.move_resize_frame(false,stubbornTarget.x,stubbornTarget.y,stubbornTarget.width+180,stubbornTarget.height+140);
    await pause();
    const stubbornFrame=stubborn.get_frame_rect();
    assert(stubbornFrame.width>stubbornTarget.width || stubbornFrame.height>stubbornTarget.height,'simulated stubborn window grows beyond its tile');
    assert(stubbornRecord.visualScale<0.999,'late oversized frame is compositor-scaled');
    assert(stubbornFrame.width*stubbornRecord.visualScale<=stubbornTarget.width+1 &&
        stubbornFrame.height*stubbornRecord.visualScale<=stubbornTarget.height+1,'scaled stubborn window fits its tile');
    app.place(stubborn,stubbornTarget); await pause();
    assert(stubbornRecord.visualScale>0.999,'normal tile size restores unit scale');
    const before=windows.slice(1).map(w=>geometry(w));
    windows[0].maximize(); await pause();
    assert(windows.slice(1).every((w,i)=>geometry(w)===before[i]),'maximize freezes other windows');
    windows[0].unmaximize(); await pause();
    windows[0].minimize(); await pause();
    assert(app.groups.get(app.key(0)).filter(Boolean).length===3,'minimize compacts');
    windows[0].unminimize(); await pause();
    app.switchSpace(1,0); await pause();
    assert(windows.every(w=>w.minimized),'space parks windows');
    app.switchSpace(0,0); await pause();
    assert(windows.every(w=>!w.minimized),'space restores parked windows');
    windows[0].activate(global.get_current_time()); await pause();
    app.toggleFloating(); await pause();
    assert(app.records.get(windows[0]).floating,'floating enabled');
    app.undo(); await pause();
    assert(!app.records.get(windows[0]).floating,'undo restores floating membership');
    const slotBefore=app.groups.get(app.key(0)).indexOf(windows[0]);
    const direction=slotBefore%2===0?'right':'left';
    const reverse=direction==='right'?'left':'right';
    const historyBeforeSwap=app.history.length;
    app.toggleSwap();
    assert(app.swapMode,'swap mode entered');
    app.swapDirection(direction); await pause();
    assert(app.groups.get(app.key(0)).indexOf(windows[0])!==slotBefore,'keyboard swap changes slot');
    const swapHistoryLength=app.history.length;
    assert(swapHistoryLength===historyBeforeSwap+1,'swap session creates one undo checkpoint');
    app.swapDirection(reverse); await pause();
    app.swapDirection(direction); await pause();
    assert(app.history.length===swapHistoryLength,'multiple swap moves share one undo checkpoint');
    app.exitSwap(false); await pause();
    assert(!app.swapMode,'cancel exits swap mode');
    assert(app.groups.get(app.key(0)).indexOf(windows[0])===slotBefore,'cancel restores original slot');
    assert(app.history.length===historyBeforeSwap,'cancel removes swap undo checkpoint');
    app.toggleSwap();
    app.swapDirection(direction); await pause();
    const committedSlot=app.groups.get(app.key(0)).indexOf(windows[0]);
    assert(committedSlot!==slotBefore,'second swap session changes slot');
    app.exitSwap(true); await pause();
    assert(!app.swapMode,'commit exits swap mode');
    assert(app.groups.get(app.key(0)).indexOf(windows[0])===committedSlot,'commit keeps swapped slot');
    assert(app.history.length===historyBeforeSwap+1,'commit keeps one undo checkpoint');
    app.undo(); await pause();
    assert(app.groups.get(app.key(0)).indexOf(windows[0])===slotBefore,'undo reverts committed swap session');
    app.openStudio(); await pause();
    assert(app.studio?.canvas.get_children().length===4,'studio renders slots');
    const unassigned=app.studio.draft.pop();
    app.studio.showLibrary=true; app.studio.render();
    const library=app.studio.canvas.get_first_child().get_child();
    library.get_first_child().emit('clicked',1);
    assert(app.studio.draft.includes(unassigned) && !app.studio.showLibrary,'window library assigns to draft');
    if (GLib.getenv('SNAPTESS_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_SCREENSHOT')).replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.studio.select(0); app.studio.select(1); app.studio.apply(); await pause();
    assert(!app.studio,'studio closes after apply');
    if (Main.layoutManager.monitors.length > 1) {
        app.applyProfile(1,0,'auto',[windows[0]]); await pause();
        assert(windows[0].get_monitor()===1,'studio assignment moves across monitors');
        app.switchSpace(1,1); await pause();
        assert(windows[0].minimized && windows.slice(1).every(w=>!w.minimized),'spaces independent per monitor');
        app.switchSpace(0,1); await pause();
        app.grabBegin(windows[0],Meta.GrabOp.MOVING);
        app.drag.target={monitor:0,index:1}; app.grabEnd(); await pause();
        assert(windows[0].get_monitor()===0,'drop moves to target monitor');
        assert(app.groups.get(app.key(0)).filter(Boolean).length===4,'drop reflows target');
        assert(app.groups.get(app.key(1)).filter(Boolean).length===0,'drop reflows source');
    }
    app.setRunning(false); await pause();
    windows.forEach((w,i)=>{
        const r=w.get_frame_rect(),s=originals[i];
        assert(r.x===s.x && r.y===s.y && r.width===s.width && r.height===s.height,'stop restores original geometry');
    });
    app.setRunning(true); await pause();
    const firstRuntimeClass=app.constructor;
    await Main.extensionManager.disableExtension(loader.uuid); await pause();
    assert(!Main.panel.statusArea[loader.uuid],'disable removes indicator');
    assert(!hotRoot.query_exists(null),'disable removes hot reload staging');
    await Main.extensionManager.enableExtension(loader.uuid); await pause();
    const reloadedEntry=Main.extensionManager.lookup(loader.uuid);
    const reloaded=await waitRuntime(reloadedEntry.stateObj);
    assert(reloaded,'runtime reloads after disable/enable');
    assert(hotRoot.query_exists(null),'re-enable recreates hot reload staging');
    assert(reloaded.constructor!==firstRuntimeClass,'reload bypasses the GJS module cache');
    await Main.extensionManager.disableExtension(loader.uuid); await pause();
    assert(!hotRoot.query_exists(null),'final disable removes hot reload staging');
    await Scripting.destroyTestWindows();
    const launcher=new Gio.SubprocessLauncher({flags:Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY','gnome-shell-test-display',true);
    launcher.setenv('GDK_BACKEND','wayland',true);
    launcher.setenv('GI_TYPELIB_PATH','/usr/lib/gnome-shell/girepository-1.0',true);
    launcher.setenv('LD_LIBRARY_PATH','/usr/lib/gnome-shell',true);
    launcher.setenv('GSETTINGS_BACKEND','memory',true);
    const child=launcher.spawnv(['gjs','-m',Gio.File.new_for_uri(import.meta.url).get_parent().get_child('prefs.js').get_path()]);
    await new Promise((resolve,reject)=>child.wait_check_async(null,(p,r)=>{
        try { p.wait_check_finish(r); resolve(); } catch(e) { reject(e); }
    }));
    console.log('SNAPTESS_SHELL_TESTS_PASSED');
}
