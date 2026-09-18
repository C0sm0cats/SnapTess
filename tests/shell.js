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
    assert(app.border.get_parent()===global.window_group,'focus border stays below Shell chrome');
    assert(app.windowActions.get_parent()===global.window_group,'window actions stay below Shell chrome');
    assert(app.windowActionHandle.get_parent()===global.window_group,'window action handle stays below Shell chrome');
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
    app.showDragGuides(windows[0],windows[1],rects[0],rects[1]);
    assert(app.dragSourceGuide.visible && app.dragTargetGuide.visible && app.dragFlow.visible &&
        app.dragFlow.get_children().length===3,'drag feedback shows source, target and application flow');
    app.hideDragGuides();
    const stubborn=windows[0], stubbornRecord=app.records.get(stubborn);
    const stubbornTarget={...stubbornRecord.tileRect};
    stubborn.move_resize_frame(false,stubbornTarget.x,stubbornTarget.y,stubbornTarget.width+180,stubbornTarget.height+140);
    const matchesTarget=frame=>Math.abs(frame.x-stubbornTarget.x)<=1 && Math.abs(frame.y-stubbornTarget.y)<=1 &&
        Math.abs(frame.width-stubbornTarget.width)<=1 && Math.abs(frame.height-stubbornTarget.height)<=1;
    let stubbornFrame;
    for(let i=0;i<8;i++) {
        await pause();
        stubbornFrame=stubborn.get_frame_rect();
        if(matchesTarget(stubbornFrame)) break;
    }
    const nativeRepair=matchesTarget(stubbornFrame);
    const stubbornActor=app.windowActor(stubborn);
    let [actorScaleX,actorScaleY]=stubbornActor.get_scale();
    if(nativeRepair) {
        assert(stubbornRecord.visualScale===1,'accepted size repair keeps native scale');
        assert(actorScaleX===1 && actorScaleY===1,'repaired window actor stays at native scale');
    } else {
        const fit=Math.min(stubbornTarget.width/stubbornFrame.width,stubbornTarget.height/stubbornFrame.height);
        assert(stubbornRecord.autoScale && stubbornRecord.sizeRepairs===1,
            'rejected native size gets one repair attempt then automatic scale-to-fit');
        assert(Math.abs(stubbornRecord.visualScale-fit)<0.001 &&
            Math.abs(actorScaleX-fit)<0.001 && Math.abs(actorScaleY-fit)<0.001 &&
            Math.abs(stubbornActor.translation_x-(stubbornTarget.x-stubbornFrame.x))<=1 &&
            Math.abs(stubbornActor.translation_y-(stubbornTarget.y-stubbornFrame.y))<=1,
            'rejected oversized frame is visually contained in its tile');
    }
    const expectedScale=stubbornRecord.visualScale;
    stubbornActor.emit('effects-completed');
    await pause();
    [actorScaleX,actorScaleY]=stubbornActor.get_scale();
    assert(Math.abs(actorScaleX-expectedScale)<0.001 && Math.abs(actorScaleY-expectedScale)<0.001,
        'effects completion preserves the repaired or fitted scale');
    stubborn.activate(global.get_current_time()); await pause();
    app.actionWindow=null; app.hideWindowActions(); app.windowsRestacked(); await Scripting.sleep(160);
    assert(app.windowActions.visible,'client restacking can reveal actions without a focus notification');
    app.hideWindowActions();
    app.showWindowActions();
    assert(app.windowActions.visible && app.windowActions.get_children().length===4,
        'focused window exposes four contextual actions');
    app.showWindowActionTooltip(app.floatAction);
    assert(app.windowActionTooltip.visible && app.windowActionTooltip.text.length>0,
        'window actions expose contextual tooltips');
    global.window_group.set_child_above_sibling(stubbornActor,null);
    app.updateBorder(); app.stackWindowOverlays(stubborn);
    const stack=global.window_group.get_children();
    assert(stack.indexOf(app.border)>stack.indexOf(stubbornActor) &&
        stack.indexOf(app.windowActionHandle)>stack.indexOf(app.border) &&
        stack.indexOf(app.windowActions)>stack.indexOf(app.windowActionHandle),
        'window restacking keeps contextual actions above delayed client raises');
    app.scheduleWindowActionsHide(0); await Scripting.sleep(20);
    assert(!app.windowActions.visible && app.windowActionHandle.visible,
        'hidden window actions leave a hoverable edge handle');
    app.showWindowActions();
    assert(app.windowActions.visible && !app.windowActionHandle.visible,
        'hovering the edge handle restores window actions');
    app.hideWindowActions();
    app.place(stubborn,stubbornTarget); await pause();
    [actorScaleX,actorScaleY]=stubbornActor.get_scale();
    assert(Math.abs(actorScaleX-expectedScale)<0.001 && Math.abs(actorScaleY-expectedScale)<0.001,
        'unchanged placement preserves native or fitted scale');
    app.place(stubborn,stubbornTarget,false,true); await pause();
    [actorScaleX,actorScaleY]=stubbornActor.get_scale();
    if(nativeRepair) {
        assert(stubbornRecord.visualScale>0.999,'normal tile size restores unit scale');
        assert(actorScaleX>0.999 && actorScaleY>0.999,'normal tile size restores the actor transform');
    } else {
        assert(Math.abs(actorScaleX-stubbornRecord.visualScale)<0.001 &&
            Math.abs(actorScaleY-stubbornRecord.visualScale)<0.001 &&
            stubbornRecord.visualScale<=expectedScale+0.001,
            'forced placement keeps a rejected client visually contained');
    }
    const before=windows.slice(1).map(w=>geometry(w));
    const restoreTarget={...app.records.get(windows[0]).tileRect};
    app.showWindowActionHandle();
    assert(app.windowActionHandle.visible,'focused tiled window shows the action handle');
    windows[0].maximize(); await pause();
    assert(!app.windowActionHandle.visible && !app.windowActions.visible,
        'maximizing a focused window hides its contextual controls');
    assert(windows.slice(1).every((w,i)=>geometry(w)===before[i]),'maximize freezes other windows');
    windows[0].unmaximize();
    await Scripting.sleep(90);
    const restoreActor=app.windowActor(windows[0]);
    restoreActor.emit('effects-completed');
    await Scripting.sleep(90);
    for(let i=1;i<=4;i++) {
        windows[0].move_resize_frame(false,restoreTarget.x+i*22,restoreTarget.y+i*15,restoreTarget.width,restoreTarget.height);
        await Scripting.sleep(170);
    }
    await Scripting.sleep(900);
    const restoredFrame=windows[0].get_frame_rect();
    assert(Math.abs(restoredFrame.x-restoreTarget.x)<=1 && Math.abs(restoredFrame.y-restoreTarget.y)<=1 &&
        Math.abs(restoredFrame.width-restoreTarget.width)<=1 && Math.abs(restoredFrame.height-restoreTarget.height)<=1,
        'progressive app geometry drift after maximize exit is pulled back into its tile');
    assert(!app.records.get(windows[0]).restorePending,'restore stabilization is bounded and finishes');
    app.showWindowActionHandle();
    assert(app.windowActionHandle.visible,'restored tiled window shows the action handle');
    windows[0].make_fullscreen(); await pause();
    assert(!app.windowActionHandle.visible && !app.windowActions.visible,
        'fullscreen hides a previously visible action handle');
    windows[0].unmake_fullscreen(); await pause();
    windows[0].minimize(); await pause();
    assert(app.groups.get(app.key(0)).filter(Boolean).length===3,'minimize compacts');
    windows[0].unminimize(); await pause();
    app.switchSpace(1,0);
    assert(app.spaceTransitions.size===1,'space switch uses the custom SnapTess transition');
    await pause();
    assert(windows.every(w=>w.minimized),'space parks windows');
    app.switchSpace(0,0);
    assert(app.spaceTransitions.size===1,'reverse space switch uses the custom transition');
    await pause();
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
    const initialPreset=app.studio.preset, initialUndo=app.studio.undoStack.length;
    const initialCardWidth=app.studio.canvas.get_first_child().width;
    assert(!app.studio.presets.get_children()[1].reactive,
        'Full is unavailable when four windows need tiles');
    app.studio.choosePreset('full');
    assert(app.studio.preset===initialPreset && app.studio.undoStack.length===initialUndo,
        'an unavailable layout cannot create a misleading draft');
    app.studio.choosePreset('3x2');
    assert(app.studio.canvas.get_first_child().width<initialCardWidth,
        'a compatible layout updates the Studio preview immediately');
    app.studio.undo();
    const studioWidth=app.studio.width;
    app.studio.width=700; app.studio.render();
    assert(app.studio.presetMenu,'compact Studio renders the layout menu');
    app.studio.width=studioWidth; app.studio.render();
    const unassigned=app.studio.draft.pop();
    app.studio.showLibrary=true; app.studio.render();
    const library=app.studio.canvas.get_first_child().get_child();
    library.get_first_child().emit('clicked',1);
    assert(app.studio.draft.includes(unassigned) && !app.studio.showLibrary,'window library assigns to draft');
    const studioPreset=app.studio.preset, scaledRecord=app.records.get(app.studio.draft[0]);
    const originalScale=scaledRecord.visualScale;
    scaledRecord.visualScale=0.8;
    app.studio.preset='4x3'; app.studio.showPreviews=true; app.studio.render(); await pause();
    const compactCard=app.studio.canvas.get_first_child();
    const scaleBadge=compactCard.get_child().get_children().find(child =>
        child.has_style_class_name?.('snaptess-scale-badge'));
    assert(compactCard.height<130 && scaleBadge,'compact preview card includes the scale badge');
    const [, cardY]=compactCard.get_transformed_position();
    const [, badgeY]=scaleBadge.get_transformed_position();
    const [, badgeHeight]=scaleBadge.get_transformed_size();
    assert(badgeY>=cardY && badgeY+badgeHeight<=cardY+compactCard.height,
        'scale badge stays fully inside a compact preview card');
    scaledRecord.visualScale=originalScale;
    app.studio.preset=studioPreset; app.studio.showPreviews=false; app.studio.render();
    if (GLib.getenv('SNAPTESS_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_SCREENSHOT')).replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    const studio=app.studio, historyBeforeStudio=app.history.length;
    studio.select(0);
    assert(studio.pinButton.visible,'selected Studio window offers a reserved app slot');
    const pinnedWindow=studio.draft[0];
    const beforePinDirty=new Set(studio.dirtyContexts), beforePinUndo=studio.undoStack.length;
    studio.togglePin();
    assert(studio.pins[0]===app.appId(pinnedWindow),'Studio marks the selected app for its tile');
    assert(studio.undoButton.visible && !studio.modifiedBadge,
        'Studio exposes Undo without the prominent modified badge');
    assert(studio.context.get_children().some(chip=>chip.get_child?.()?.get_children?.()
        .some(child=>child.has_style_class_name?.('snaptess-dirty-dot'))),
    'modified contexts use a discreet dot');
    studio.undo();
    assert(!studio.pins[0] && studio.undoStack.length===beforePinUndo &&
        [...studio.dirtyContexts].every(key=>beforePinDirty.has(key)) &&
        studio.dirtyContexts.size===beforePinDirty.size,
        'Studio Undo restores the previous pin and draft state');
    studio.togglePin();
    studio.changeContext(0,1);
    const priorPreset=studio.preset;
    studio.choosePreset('full');
    studio.undo();
    assert(studio.preset===priorPreset && studio.dirtyContexts.size===beforePinDirty.size,
        'Studio Undo restores a preset in another space without losing earlier edits');
    studio.choosePreset('full');
    studio.changeContext(0,0);
    assert(studio.preset===studioPreset && studio.dirtyContexts.size===2,
        'switching spaces preserves both layout drafts');
    studio.select(0); studio.select(1);
    studio.undo();
    assert(studio.pins[0]===app.appId(pinnedWindow) && studio.draft[0]===pinnedWindow,
        'Studio Undo restores a swap and its reserved app slot');
    studio.select(1);
    studio.reset(); studio.undo();
    assert(studio.pins[1]===app.appId(pinnedWindow),
        'Studio Undo restores the layout after Reset profile');
    studio.apply(); await pause();
    assert(!app.studio,'studio closes after apply');
    assert(app.history.length===Math.min(10,historyBeforeStudio+1),'all Studio changes share one undo checkpoint');
    assert(app.profiles[app.profileKey(0,0)].pinned[1]===app.appId(pinnedWindow),
        'reserved app slot follows a Studio swap');
    assert(app.profiles[app.profileKey(0,1)].preset==='full','Apply saves changes from another space');
    app.undo(); await pause();
    assert(!app.profiles[app.profileKey(0,1)],'one undo restores the other space profile');
    app.openStudio(); await pause();
    const moveStudio=app.studio;
    moveStudio.changeContext(0,1);
    moveStudio.showLibrary=true; moveStudio.render();
    moveStudio.canvas.get_first_child().get_child().get_first_child().emit('clicked',1);
    assert(moveStudio.dirtyContexts.has('0:0') && moveStudio.dirtyContexts.has('0:1'),
        'moving a window marks both source and destination drafts');
    moveStudio.undo();
    assert(moveStudio.dirtyContexts.size===0 && moveStudio.draft.length===0,
        'Studio Undo restores both drafts after adding a window');
    moveStudio.showLibrary=true; moveStudio.render();
    moveStudio.canvas.get_first_child().get_child().get_first_child().emit('clicked',1);
    const movedWindow=moveStudio.draft[0];
    moveStudio.apply(); await pause();
    assert(app.records.get(movedWindow).space===1 && app.groups.get(app.key(0,1)).includes(movedWindow) &&
        !app.groups.get(app.key(0,0)).includes(movedWindow),
        'Apply moves a window and updates both spaces together');
    app.undo(); await pause();
    assert(app.records.get(movedWindow).space===0 && app.groups.get(app.key(0,0)).includes(movedWindow),
        'one undo restores a cross-space Studio assignment');
    if (Main.layoutManager.monitors.length > 1) {
        app.applyProfile(1,0,'auto',[windows[0]]); await pause();
        assert(windows[0].get_monitor()===1,'studio assignment moves across monitors');
        app.switchSpace(1,1); await pause();
        assert(windows[0].minimized && windows.slice(1).every(w=>!w.minimized),'spaces independent per monitor');
        app.switchSpace(0,1); await pause();
        app.applyProfile(0,0,'auto',windows); await pause();
        assert(windows[0].get_monitor()===0,'studio assignment returns to the primary monitor');
        assert(app.groups.get(app.key(0)).filter(Boolean).length===4,'studio assignment reflows target');
        assert(app.groups.get(app.key(1)).filter(Boolean).length===0,'studio assignment reflows source');
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
    console.log('SNAPTESS_PREFS_TESTS_STARTING');
    const child=launcher.spawnv(['gjs','-m',Gio.File.new_for_uri(import.meta.url).get_parent().get_child('prefs.js').get_path()]);
    try {
        await new Promise((resolve,reject)=>child.wait_check_async(null,(p,r)=>{
            try { p.wait_check_finish(r); resolve(); } catch(e) { reject(e); }
        }));
    } catch (error) {
        console.error(`SNAPTESS_PREFS_TESTS_FAILED: ${error}`);
        throw error;
    }
    console.log('SNAPTESS_SHELL_TESTS_PASSED');
}
