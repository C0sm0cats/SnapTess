import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
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
    if (GLib.getenv('SNAPTESS_TWO_MONITORS'))
        assert(Main.layoutManager.monitors.length>=2,'two-monitor test environment did not start');
    await Scripting.sleep(1200);
    Main.overview.hide(); await pause();
    let entry;
    for (let i=0;i<30;i++) {
        entry=Main.extensionManager.lookup('snaptess@c0sm0cats.github.io');
        if (entry?.stateObj) break;
        await Scripting.sleep(100);
    }
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
    assert(app.settings.get_string('preview-state')==='{}','preview starts without stale window data');
    for(let i=0;i<4;i++) await Scripting.createTestWindow({width:320,height:240});
    await Scripting.waitTestWindows(); await pause();
    const windows=[...app.records.keys()];
    assert(windows.length===4,`tracked four native windows, got ${windows.length}`);
    const originals=windows.map(w=>app.snapshot(w));
    app.updateMenuSensitivity();
    assert(!app.arrangeItem.sensitive && !app.floatItem.sensitive && !app.swapItem.sensitive &&
        !app.undoItem.sensitive && !app.spaceMenu.sensitive && !app.stopItem.sensitive,
        'tray disables arrangement actions while SnapTess is paused');
    app.setRunning(true); await pause();
    assert(app.groups.get(app.key(0)).length===4,'four tiled slots');
    const initialPreview=JSON.parse(app.settings.get_string('preview-state'));
    assert(initialPreview.running && initialPreview.monitor===0 && initialPreview.space===0 &&
        initialPreview.count===4 && initialPreview.occupied.length===4 && initialPreview.preset==='auto',
        'preferences preview follows the active tiled space');
    assert(app.statusItem.label.text.includes('ON') && app.monitorMenus.length===Main.layoutManager.monitors.length &&
        app.monitorMenus[0].menu.label.text.includes('Display 1') &&
        app.monitorMenus[0].spaces.length===3,
        'panel separates global state from monitor layout and Space controls');
    if (GLib.getenv('SNAPTESS_PANEL_SCREENSHOT')) {
        app.indicator.menu.open(); await Scripting.sleep(160);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_PANEL_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null); app.indicator.menu.close();
    }
    app.updateMenuSensitivity();
    assert(app.arrangeItem.sensitive && app.spaceMenu.sensitive && app.stopItem.sensitive,
        'tray enables global arrangement actions while SnapTess is active');
    let rects=windows.map(w=>w.get_frame_rect());
    for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) {
        const a=rects[i],b=rects[j];
        assert(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y,'non-overlapping native frames');
    }
    const addMotionGuide=app.motionGuides.add.bind(app.motionGuides);
    let placementGhostKind=null;
    app.motionGuides.add=guide=> {
        placementGhostKind=guide instanceof Clutter.Clone ||
            guide.has_style_class_name?.('snaptess-placement-ghost');
        return addMotionGuide(guide);
    };
    app.animatePlacement(windows[0],rects[0],{...rects[0],x:rects[0].x+80});
    app.motionGuides.add=addMotionGuide;
    assert(placementGhostKind,'placement feedback uses a window clone or icon fallback');
    await Scripting.sleep(240);
    assert(app.motionGuides.size===0,'placement ghost is destroyed after its transition');
    windows[0].activate(global.get_current_time()); await pause();
    app.updateMenuSensitivity();
    assert(app.floatItem.sensitive && app.swapItem.sensitive,
        'tray enables focused-window actions when they are available');
    const borderRadius=await app.measureWindowRadius(windows[0]);
    const scaledActor=app.windowActor(windows[0]);
    scaledActor.set_scale(0.5,0.5);
    scaledActor.remove_all_transitions();
    await Scripting.sleep(250);
    const scaledRadius=await app.measureWindowRadius(windows[0]);
    scaledActor.set_scale(1,1);
    assert(scaledRadius && Math.abs(scaledRadius.top-borderRadius.top)<=3 &&
        Math.abs(scaledRadius.bottom-borderRadius.bottom)<=3,
        `a scaled window keeps its measured corners (${JSON.stringify(scaledRadius)})`);
    assert(borderRadius && borderRadius.top>=0 && borderRadius.bottom>=0,
        'GNOME Shell samples independent top and bottom corner radii');
    const borderRecord=app.records.get(windows[0]);
    app.invalidateWindowRadius(windows[0]);
    assert(app.border.visible && borderRecord.windowRadius && borderRecord.radiusDirty,
        'a known radius stays visible while the window is remeasured');
    await Scripting.sleep(850);
    assert(borderRecord.windowRadius && !borderRecord.radiusDirty && borderRecord.windowRadius.top>=0,
        'a cleared window radius is measured again instead of caching the fallback');
    assert(app.border.visible, 'focus border appears after the radius has been measured');
    borderRecord.windowRadius=null;
    borderRecord.radiusDirty=true;
    borderRecord.radiusAttempts=0;
    app.updateBorder();
    assert(!app.border.visible && borderRecord.radiusTimer && borderRecord.radiusTimerDelay===0,
        'an uncached focused window starts measurement without a fixed wait');
    await Scripting.sleep(300);
    assert(borderRecord.windowRadius && app.border.visible,
        'the first measurement reveals the border without a provisional radius');
    borderRecord.windowRadius=null;
    borderRecord.radiusDirty=true;
    borderRecord.radiusAttempts=3;
    app.updateBorder();
    assert(app.border.visible && app.border.topRadius===12,
        'the fallback appears only after measurement retries are exhausted');
    borderRecord.radiusAttempts=0;
    const measureRadius=app.measureWindowRadius;
    app.measureWindowRadius=async()=>null;
    for(let i=0;i<3;i++) {
        app.invalidateWindowRadius(windows[0]);
        await Scripting.sleep(300);
    }
    assert(borderRecord.radiusAttempts===3 && app.border.visible,
        'repeated invalidations cannot postpone the focus border indefinitely');
    app.invalidateWindowRadius(windows[0]);
    assert(app.border.visible, 'an exhausted fallback survives another geometry notification');
    app.cancel(borderRecord.radiusFallbackTimer);
    borderRecord.radiusFallbackTimer=0;
    borderRecord.radiusFallbackReady=false;
    borderRecord.radiusAttempts=0;
    for(let i=0;i<16;i++) {
        app.invalidateWindowRadius(windows[0]);
        await Scripting.sleep(100);
    }
    assert(app.border.visible && (borderRecord.radiusFallbackReady || borderRecord.radiusAttempts>=3),
        'rapid geometry notifications cannot hide the fallback indefinitely');
    app.measureWindowRadius=measureRadius;
    borderRecord.radiusAttempts=0;
    borderRecord.windowRadius={top:0,bottom:20};
    borderRecord.radiusDirty=false;
    app.updateBorder();
    const frame=app.visualWindowRect(windows[0]), bw=app.border.strokeWidth;
    assert(app.border.topRadius===0 && app.border.bottomRadius===20,
        'the painted border keeps square top corners and rounded bottom corners');
    assert(Math.abs(app.border.x-(frame.x-bw))<=1 && Math.abs(app.border.y-(frame.y-bw))<=1 &&
        Math.abs(app.border.width-(frame.width+2*bw))<=1,
        'focus border follows the visible window frame with its stroke outset');
    scaledActor.set_scale(0.7,0.7);
    await Scripting.sleep(60);
    const shrinking=app.visualWindowRect(windows[0]);
    assert(Math.abs(app.border.width-(shrinking.width+2*bw))<=1 &&
        Math.abs(app.border.height-(shrinking.height+2*bw))<=1,
        'focus border follows compositor scale changes during restoration');
    scaledActor.set_scale(1,1);
    await Scripting.sleep(60);
    const restored=app.visualWindowRect(windows[0]);
    assert(Math.abs(app.border.width-(restored.width+2*bw))<=1 &&
        Math.abs(app.border.height-(restored.height+2*bw))<=1,
        'focus border returns to the full frame after an animation');
    app.setGuideRadius(app.preview,windows[0],14);
    assert(app.preview.get_style().includes('0px 0px 20px 20px'),
        'target ghost mirrors the independently measured top and bottom corners');
    borderRecord.windowRadius=borderRadius;
    app.updateBorder();
    app.setPreviewApp(windows[0]);
    app.showRect(app.preview,rects[1]);
    app.previewWindow=windows[0];
    app.setGuideRadius(app.preview,windows[0],16);
    assert(app.preview.visible && app.preview.has_style_class_name('snaptess-target-ghost') &&
        app.previewContent.get_n_children()===2,
        'drag feedback uses one accent target ghost with source application identity');
    const originalAccent=app.accentColor.bind(app);
    app.accentColor=()=> '#a051c3';
    app.refreshAccentStyles();
    assert(app.preview.get_style().includes('#a051c3') && app.border.strokeColor==='#a051c3',
        'runtime accent changes recolor the ghost and focus border');
    app.accentColor=originalAccent;
    app.refreshAccentStyles();
    if (GLib.getenv('SNAPTESS_DRAG_SCREENSHOT')) {
        app.previewLabel.text='Swap · Test window';
        app.previewLabel.set_position(rects[1].x+12,rects[1].y+12);
        app.previewLabel.show();
        await Scripting.sleep(90);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_DRAG_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
        app.previewLabel.hide();
    }
    app.preview.hide();
    const stubborn=windows[0], stubbornRecord=app.records.get(stubborn);
    const frameMinimum=stubborn.client_rect_to_frame_rect(new Mtk.Rectangle({
        x: 0, y: 0, width: 700, height: 356}));
    assert(Number.isFinite(frameMinimum.width) && Number.isFinite(frameMinimum.height),
        'Mutter exposes the native client-to-frame geometry conversion');
    app.settings.set_strv('scaled-apps', [...app.settings.get_strv('scaled-apps'), app.appId(stubborn)]);
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
        assert(!stubbornRecord.floating,
            'an allowlisted window remains tiled when its native size is rejected');
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
    assert(app.windowActionHandle.visible && !app.windowActions.visible,
        'client restacking reveals the action tab without opening the palette');
    const handleRect=stubbornRecord.tileRect;
    assert(app.windowActionHandle.width===28 && app.windowActions.width===44 &&
        app.windowActionHandle.x>=handleRect.x &&
        app.windowActionHandle.x<=handleRect.x+8,
        'the compact action tab and palette keep fixed widths at the left edge');
    assert(app.windowActionHandle.get_scale().every(scale => scale===1),
        'the action tab keeps its size beside a scaled client');
    if (GLib.getenv('SNAPTESS_ACTION_HANDLE_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_ACTION_HANDLE_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    const handleStageSize=app.windowActionHandle.get_transformed_size();
    const savedClientScale=stubbornActor.get_scale();
    stubbornActor.set_scale(0.65,0.65);
    app.updateWindowActionsPosition(stubborn);
    assert(app.windowActionHandle.width===28 && app.windowActionHandle.get_scale().every(scale => scale===1) &&
        app.windowActionHandle.get_transformed_size().every((size,index) =>
            Math.abs(size-handleStageSize[index])<=1),
        'the closed control keeps its stage size while the client actor is scaled');
    if (GLib.getenv('SNAPTESS_ACTION_SCALED_HANDLE_SCREENSHOT')) {
        await Scripting.sleep(180);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_ACTION_SCALED_HANDLE_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    stubbornActor.set_scale(...savedClientScale);
    app.hideWindowActions();
    app.showWindowActions();
    assert(app.windowActions.visible && app.windowActions.get_children().length===4,
        'focused window exposes four contextual actions');
    assert(app.windowActions.get_scale().every(scale => scale===1),
        'the open palette keeps its size beside a scaled client');
    await Scripting.sleep(180);
    const paletteStageSize=app.windowActions.get_transformed_size();
    stubbornActor.set_scale(0.65,0.65);
    app.updateWindowActionsPosition(stubborn);
    assert(app.windowActions.width===44 && app.windowActions.get_scale().every(scale => scale===1) &&
        app.windowActions.get_transformed_size().every((size,index) =>
            Math.abs(size-paletteStageSize[index])<=1),
        'the open control keeps its stage size while the client actor is scaled');
    if (GLib.getenv('SNAPTESS_ACTION_SCALED_SCREENSHOT')) {
        await Scripting.sleep(180);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_ACTION_SCALED_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    stubbornActor.set_scale(...savedClientScale);
    if (GLib.getenv('SNAPTESS_ACTION_PALETTE_SCREENSHOT')) {
        await Scripting.sleep(180);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_ACTION_PALETTE_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    assert(app.floatAction.child.icon_name==='window-pop-out-symbolic',
        'a tiled window shows the distinct float action icon');
    stubbornRecord.floating=true; app.showWindowActions();
    assert(app.floatAction.child.icon_name==='view-grid-symbolic',
        'a floating window shows the distinct return-to-grid action icon');
    stubbornRecord.floating=false; app.showWindowActions();
    app.showWindowActionTooltip(app.floatAction);
    assert(app.windowActionTooltip.visible && app.windowActionTooltip.text.length>0,
        'window actions expose contextual tooltips');
    const tooltipArea=app.area(stubborn.get_monitor());
    const [,tooltipWidth]=app.windowActionTooltip.get_preferred_width(-1);
    assert(app.windowActionTooltip.x>=tooltipArea.x+6 &&
        app.windowActionTooltip.x+tooltipWidth<=tooltipArea.x+tooltipArea.width-5 &&
        (app.windowActionTooltip.x+tooltipWidth<=app.windowActions.x ||
            app.windowActionTooltip.x>=app.windowActions.x+app.windowActions.width),
        `action tooltip ${app.windowActionTooltip.x}:${tooltipWidth} avoids palette ` +
        `${app.windowActions.x}:${app.windowActions.width} within ${tooltipArea.x}:${tooltipArea.width}`);
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
    if(matchesTarget(stubborn.get_frame_rect())) {
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
    assert(app.windowActionHandle.visible || app.windowActions.visible,
        'maximized focused window keeps its contextual controls');
    const maximizedRect=app.visualWindowRect(windows[0]);
    const visibleControl=app.windowActions.visible ? app.windowActions : app.windowActionHandle;
    assert(visibleControl.x>=maximizedRect.x && visibleControl.x<maximizedRect.x+maximizedRect.width,
        'maximized controls follow the visible window instead of its old tile');
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
    assert(app.windowActionHandle.visible || app.windowActions.visible,
        'restored tiled window regains its contextual controls automatically');
    windows[0].make_fullscreen(); await pause();
    assert(!app.windowActionHandle.visible && !app.windowActions.visible,
        'fullscreen hides a previously visible action handle');
    windows[0].unmake_fullscreen(); await pause();
    windows[0].minimize(); await pause();
    assert(app.groups.get(app.key(0)).filter(Boolean).length===3,'minimize compacts');
    windows[0].unminimize(); await pause();
    windows[0].activate(global.get_current_time()); await pause();
    const unminimized=app.visualWindowRect(windows[0]);
    assert(app.border.visible && Math.abs(app.border.width-(unminimized.width+2*app.border.strokeWidth))<=1 &&
        Math.abs(app.border.height-(unminimized.height+2*app.border.strokeWidth))<=1,
        'unminimized window has a full-size focus border');
    const originalAppId=app.appId.bind(app), pinId='snaptess-test-pinned.desktop';
    const closedId=['org.gnome.Shell.Extensions.desktop','org.gnome.Settings.desktop']
        .find(id=>Shell.AppSystem.get_default().lookup_app(id)) ?? 'snaptess-test-closed.desktop';
    const profileKey=app.profileKey(0,0), previousProfile=app.profiles[profileKey];
    app.appId=w=>w===windows[0]?pinId:originalAppId(w);
    app.profiles[profileKey]={...previousProfile,preset:'3x2',
        pinned:[pinId,null,null,null,closedId],slotCount:5};
    app.tile(true);
    assert(app.pinnedPlaceholders.get('0:4')?.state==='CLOSED' && app.pinnedPlaceholders.size===1,
        'only a genuinely vacant pinned tile shows the closed card');
    windows[0].minimize(); await Scripting.sleep(250);
    const placeholder=app.pinnedPlaceholders.get('0:0');
    const pinRect=app.area(0);
    assert(placeholder?.state==='MINIMIZED' && placeholder.button.visible &&
        placeholder.button.x>=pinRect.x && placeholder.button.y>=pinRect.y &&
        placeholder.button.x+placeholder.button.width<=pinRect.x+pinRect.width &&
        placeholder.button.y+placeholder.button.height<=pinRect.y+pinRect.height,
        'a minimized pinned app shows a card inside its vacant tile');
    assert(global.window_group.get_children().indexOf(placeholder.button)<
        global.window_group.get_children().indexOf(app.windowActor(windows[1])),
        'the pinned card stays behind real windows');
    assert(app.pinnedPlaceholders.size===2,'ordinary unpinned vacancies have no card');
    assert(app.reservedPinnedSlot(0,0) && app.reservedPinnedSlot(0,4),
        'minimized and closed pinned tiles are reserved drag and swap targets');
    app.drag={started:true}; app.updatePinnedPlaceholders();
    assert(app.pinnedPlaceholders.get('0:0')===placeholder &&
        app.pinnedPlaceholders.get('0:4')?.button.visible,
    'reserved tiles stay visible while a window is dragged');
    app.drag=null;
    if (GLib.getenv('SNAPTESS_PIN_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_PIN_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.openStudio();
    const reservedCards=app.studio.canvas.get_children();
    const minimizedContent=reservedCards[0].get_child().get_children();
    const closedContent=reservedCards[4].get_child().get_children();
    const closedAvailable=Boolean(Shell.AppSystem.get_default().lookup_app(closedId)?.get_app_info?.());
    assert(minimizedContent[0].text==='01' && !(minimizedContent[1].get_child() instanceof St.Label) &&
        minimizedContent[1].get_child().width>=20 && minimizedContent[1].get_child().height>=20 &&
        minimizedContent[2].has_style_class_name('snaptess-reserved-name') &&
        minimizedContent[3].text==='PINNED · MINIMIZED',
        'Studio shows the pinned app icon after its slot number and the minimized state');
    assert(closedContent[0].text==='05' && !(closedContent[1].get_child() instanceof St.Label) &&
        closedContent[3].text===`PINNED · ${closedAvailable?'CLOSED':'UNAVAILABLE'}`,
        'Studio distinguishes a closed pinned app from a minimized one');
    if (GLib.getenv('SNAPTESS_RESERVED_SCREENSHOT')) {
        await Scripting.sleep(180);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_RESERVED_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.studio.dialog.close();
    app.updatePinnedPlaceholders();
    app.pinnedPlaceholders.get('0:0').button.emit('clicked',1); await Scripting.sleep(250);
    assert(!windows[0].minimized && !app.pinnedPlaceholders.has('0:0'),
        'clicking a minimized pinned card restores its window and removes the card');
    if (previousProfile) app.profiles[profileKey]=previousProfile;
    else delete app.profiles[profileKey];
    app.appId=originalAppId;
    app.tile(true);
    assert(app.pinnedPlaceholders.size===0,'clearing pins removes every placeholder');
    app.switchSpace(1,0);
    assert(JSON.parse(app.settings.get_string('preview-state')).space===1,
        'preferences preview follows a SnapTess space switch');
    assert(app.spaceTransitions.size===1,'space switch uses the custom SnapTess transition');
    const spaceLayer=[...app.spaceTransitions][0];
    assert(spaceLayer._snaptessMonitor===0 && spaceLayer._snaptessDot && app.spaceDots.has(spaceLayer._snaptessDot),
        'Space OSD identifies the affected monitor and active Space');
    assert(spaceLayer.get_n_children()>2,'Space transition retains outgoing window footprints');
    await Scripting.sleep(650);
    assert(app.spaceTransitions.has(spaceLayer),'Space OSD remains readable after the window transition');
    await pause();
    assert(windows.every(w=>w.minimized),'space parks windows');
    app.switchSpace(0,0);
    assert(app.spaceTransitions.size===1,'reverse space switch uses the custom transition');
    if (GLib.getenv('SNAPTESS_SPACE_SCREENSHOT')) {
        await Scripting.sleep(100);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_SPACE_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    await pause();
    assert(windows.every(w=>!w.minimized),'space restores parked windows');
    const animationSetting=app.settings.get_boolean('animations');
    app.settings.set_boolean('animations',false);
    const guideCount=app.motionGuides.size;
    app.animatePlacement(windows[0],{x:0,y:0,width:200,height:100},{x:300,y:0,width:200,height:100});
    assert(app.motionGuides.size===guideCount,'animations=false creates no placement actor');
    app.showRect(app.preview,{x:0,y:0,width:120,height:80});
    assert(app.preview.opacity===255,'animations=false leaves overlays fully opaque');
    app.preview.hide();
    app.settings.set_boolean('animations',animationSetting);
    windows[0].activate(global.get_current_time()); await pause();
    app.toggleFloating(); await pause();
    assert(app.records.get(windows[0]).floating,'floating enabled');
    assert(app.windowActionHandle.visible,'floating leaves its action handle available without a focus change');
    windows[0].move_frame(true,90,75); await pause();
    let floatFrame=windows[0].get_frame_rect();
    assert(Math.abs(app.windowActionHandle.x-(floatFrame.x+4))<=1 &&
        Math.abs(app.windowActionHandle.y-(floatFrame.y+Math.round((floatFrame.height-40)/2)))<=1,
        'the handle follows a floating window after its geometry changes');
    app.showWindowActions();
    windows[0].move_frame(true,130,110); await pause();
    floatFrame=windows[0].get_frame_rect();
    assert(app.windowActions.visible &&
        Math.abs(app.windowActions.x-(floatFrame.x+4))<=1 &&
        Math.abs(app.windowActions.y-(floatFrame.y+Math.max(8,Math.round((floatFrame.height-176)/2))))<=1,
        'the open palette follows subsequent floating-window movement');
    app.undo(); await pause();
    assert(!app.records.get(windows[0]).floating,'undo restores floating membership');
    const slotBefore=app.groups.get(app.key(0)).indexOf(windows[0]);
    const direction=slotBefore%2===0?'right':'left';
    const reverse=direction==='right'?'left':'right';
    const historyBeforeSwap=app.history.length;
    const normalSwapBorderWidth=app.border.strokeWidth;
    app.toggleSwap();
    assert(app.swapMode,'swap mode entered');
    assert(app.border.visible && app.border.strokeWidth>normalSwapBorderWidth &&
        app.border.bandWidth>0 && app.borderSwapActive,
        'swap mode emphasizes the focused window immediately');
    assert(app.swapHints.get(direction).visible && !app.swapHints.get(reverse).visible,
        'swap hints mark reachable neighbors on the active window only');
    assert(app.swapHints.get(slotBefore<2?'down':'up').visible,
        'swap hints also mark the vertical neighbor');
    const swapFrame=app.visualWindowRect(windows[0]);
    const swapHint=app.swapHints.get(direction);
    assert(Math.abs(swapHint.x+13-(direction==='right' ? swapFrame.x+swapFrame.width : swapFrame.x))<=1,
        'swap hint straddles the focused window edge');
    if (GLib.getenv('SNAPTESS_SWAP_SCREENSHOT')) {
        await Scripting.sleep(120);
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_SWAP_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.swapDirection(direction); await pause();
    assert(app.groups.get(app.key(0)).indexOf(windows[0])!==slotBefore,'keyboard swap changes slot');
    assert(app.swapHints.get(reverse).visible,'swap hints follow the active window into its new slot');
    const swapHistoryLength=app.history.length;
    assert(swapHistoryLength===historyBeforeSwap+1,'swap session creates one undo checkpoint');
    app.swapDirection(reverse); await pause();
    app.swapDirection(direction); await pause();
    assert(app.history.length===swapHistoryLength,'multiple swap moves share one undo checkpoint');
    app.exitSwap(false); await pause();
    assert(!app.swapMode,'cancel exits swap mode');
    assert(!app.swapFromGuide.visible && !app.swapToGuide.visible && !app.swapArrow.visible,
        'cancel clears swap target feedback immediately');
    assert([...app.swapHints.values()].every(hint=>!hint.visible),'cancel clears swap hints');
    assert(app.border.strokeWidth===normalSwapBorderWidth && app.border.bandWidth===0 && !app.borderSwapActive,
        'cancel restores the normal focus outline');
    assert(app.groups.get(app.key(0)).indexOf(windows[0])===slotBefore,'cancel restores original slot');
    assert(app.history.length===historyBeforeSwap,'cancel removes swap undo checkpoint');
    app.toggleSwap();
    app.swapDirection(direction); await pause();
    const committedSlot=app.groups.get(app.key(0)).indexOf(windows[0]);
    assert(committedSlot!==slotBefore,'second swap session changes slot');
    app.exitSwap(true); await pause();
    assert(!app.swapMode,'commit exits swap mode');
    assert(!app.swapFromGuide.visible && !app.swapToGuide.visible && !app.swapArrow.visible,
        'commit clears swap target feedback immediately');
    assert([...app.swapHints.values()].every(hint=>!hint.visible),'commit clears swap hints');
    assert(app.border.strokeWidth===normalSwapBorderWidth && app.border.bandWidth===0 && !app.borderSwapActive,
        'commit restores the normal focus outline');
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
    app.studio.preset='5x5'; app.studio.render();
    assert(app.studio.canvas.get_n_children()===25 &&
        app.studio.canvas.get_first_child().get_child().get_n_children()<=3,
        'Studio renders a dense 25-tile grid without overflowing tile content');
    if (GLib.getenv('SNAPTESS_DENSE_STUDIO_SCREENSHOT')) {
        await pause();
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_DENSE_STUDIO_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.studio.preset=initialPreset; app.studio.render();
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
    const badgeRow=compactCard.get_child().get_children().find(child =>
        child.has_style_class_name?.('snaptess-state-badges'));
    const scaleBadge=badgeRow?.get_children().find(child => child.has_style_class_name?.('snaptess-scale-badge'));
    assert(compactCard.height<130 && scaleBadge,'compact preview card includes the scale badge');
    const [, cardY]=compactCard.get_transformed_position();
    const [, badgeY]=scaleBadge.get_transformed_position();
    const [, badgeHeight]=scaleBadge.get_transformed_size();
    assert(badgeY>=cardY && badgeY+badgeHeight<=cardY+compactCard.height,
        'scale badge stays fully inside a compact preview card');
    const focusedCard=app.studio.canvas.get_children().find(card=>card.get_child()?.get_children?.().some(child=>
        child.has_style_class_name?.('snaptess-state-badges') && child.get_children().some(badge=>
            badge.has_style_class_name?.('snaptess-active-badge'))));
    assert(focusedCard && !focusedCard.has_style_class_name('active'),
        'the focused Studio window uses an ACTIVE badge without a competing outline');
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
    assert(studio.pinButton.label.startsWith('Unpin this app'),
        'Studio pin action reflects the selected pinned tile');
    studio.selected=1; studio.updatePinButton();
    assert(studio.pinButton.label.startsWith('Pin this app'),
        'Studio pin action refreshes when selection moves to an unpinned tile');
    studio.selected=0; studio.updatePinButton();
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
    const beforeSelection=studio.draft[0];
    studio.select(0); studio.select(1);
    assert(studio.selected===1 && studio.draft[0]===beforeSelection && studio.pinButton.label.startsWith('Pin this app'),
        'clicking another tile changes selection without moving or pinning its application');
    studio.drop({studio,index:0},1); await pause();
    assert(studio.selected===1 && studio.pinButton.label.startsWith('Unpin this app'),
        'drag-to-swap keeps the pinned destination selected and its action synchronized');
    studio.undo();
    assert(studio.pins[0]===app.appId(pinnedWindow) && studio.draft[0]===pinnedWindow,
        'Studio Undo restores a swap and its reserved app slot');
    studio.drop({studio,index:0},1); await pause();
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
    app.openStudio(); await pause();
    const savedStudio=app.studio;
    savedStudio.drafts.set('0:0',[windows[0],windows[1]]);
    savedStudio.draftPins.set('0:0',[app.appId(windows[0]),null]);
    savedStudio.preset='split';
    savedStudio.nameEntry.set_text('Test pair');
    savedStudio.saveCurrentLayout();
    const saved=app.savedLayouts.find(item=>item.name==='Test pair');
    assert(saved?.preset==='split' && saved.slotCount===2 &&
        saved.apps[0]===app.appId(windows[0]) && saved.apps[1]===app.appId(windows[1]) &&
        saved.pinned[0]===app.appId(windows[0]) && !saved.pinned[1],
    'Studio saves both app placement and only the explicit pin');
    assert(savedStudio.previewSavedId===saved.id && savedStudio.canvas.get_n_children()===2 &&
        savedStudio.savedActions.visible,'Studio previews the selected saved layout before restore');
    const savedCards=savedStudio.canvas.get_children();
    const hasPinBadge=card=>card.get_child().get_children().some(child=>
        child.has_style_class_name?.('snaptess-state-badges') && child.get_children().some(badge=>
            badge.has_style_class_name('snaptess-pinned-badge')));
    assert(hasPinBadge(savedCards[0]) &&
        !savedCards[1].get_child().get_children().some(child=>
            child.has_style_class_name?.('snaptess-state-badges')) &&
        savedStudio.savedSummary.text.includes('reuse') &&
        savedStudio.savedSummary.text.includes('open'),
        'saved preview shows only persisted PINNED badges and keeps restore effects in the summary');
    assert(savedStudio.savedPicker.has_style_class_name('selected') &&
        !savedStudio.currentViewButton.has_style_class_name('selected') &&
        savedStudio.savedPicker.label.includes('Test pair') && savedStudio.savedChooserList,
    'saved layouts use a separate vertical picker rather than current-space list chips');
    const savedHeaderCount=savedStudio.savedHeader.get_n_children();
    const extraLayouts=[];
    for (let i=0;i<5;i++) extraLayouts.push(app.saveLayout(`Long saved layout name ${i} with extra detail`,
        'full',[windows[0]],[]));
    savedStudio.render();
    assert(savedStudio.savedHeader.get_n_children()===savedHeaderCount &&
        savedStudio.savedPicker.label.length<35 && !savedStudio.savedChooser.visible,
    'many long names do not widen the Studio toolbar');
    savedStudio.savedPicker.emit('clicked',1); await pause();
    assert(savedStudio.savedChooser.visible && savedStudio.savedChooserList.get_n_children()===6,
        'saved layouts open as a vertical list inside the Studio modal');
    if (GLib.getenv('SNAPTESS_MENU_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_MENU_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    const targetRow=savedStudio.savedChooserList.get_children()[1];
    assert(targetRow.reactive && savedStudio.savedChooser.get_parent()===savedStudio.dialog.contentLayout,
        'saved-layout rows receive input inside the modal dialog');
    targetRow.emit('clicked',1);
    assert(savedStudio.previewSavedId===extraLayouts[0] && !savedStudio.showSavedChooser,
        'selecting a row inside the Studio modal opens its saved-layout preview');
    savedStudio.savedPicker.emit('clicked',1);
    savedStudio.savedChooserList.get_first_child().emit('clicked',1);
    assert(savedStudio.previewSavedId===saved.id,'the original saved layout remains selectable');
    for (const id of extraLayouts) app.deleteSavedLayout(id);
    savedStudio.render();
    if (GLib.getenv('SNAPTESS_SAVED_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_SAVED_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    const plan=app.savedLayoutPlan(saved,0,0);
    assert(plan.slots.filter(Boolean).length===2 && plan.extras.length===2,
        'restore plan reuses matching windows and identifies surplus windows');
    savedStudio.dialog.close();
    const beforeRestore=JSON.stringify(app.profiles[app.profileKey(0,0)]);
    app.restoreSavedLayout(saved.id,0,0); await pause();
    assert(app.deletedLayouts.length===0,'restoring a layout retires stale Undo delete actions');
    assert(windows[2].minimized && windows[3].minimized &&
        app.records.get(windows[2]).restoreParked && app.records.get(windows[3]).restoreParked &&
        app.profiles[app.profileKey(0,0)].slotCount===2,
    'explicit restore minimizes extras without closing them and keeps the template capacity');
    assert(app.profiles[app.profileKey(0,0)].pinned[0]===app.appId(windows[0]) &&
        !app.profiles[app.profileKey(0,0)].pinned[1],
    'restoring a saved layout does not pin an unpinned app');
    app.undo(); await pause();
    assert(!windows[2].minimized && !windows[3].minimized &&
        JSON.stringify(app.profiles[app.profileKey(0,0)])===beforeRestore,
    'Undo restores the previous space profile and surplus windows');
    app.deleteSavedLayout(saved.id);
    assert(!app.savedLayouts.some(item=>item.id===saved.id),'saved templates can be deleted independently');
    app.openStudio(); await pause();
    assert(app.studio.undoDeleteButton.visible &&
        app.studio.undoDeleteButton.accessible_name.includes('Test pair') &&
        app.studio.undoDeleteButton.get_parent()===app.studio.savedActions &&
        app.studio.savedSummary.text.includes('Deleted'),
        'Studio shows contextual Undo beside the deleted-layout feedback');
    if (GLib.getenv('SNAPTESS_DELETED_SCREENSHOT')) {
        const stream=Gio.File.new_for_path(GLib.getenv('SNAPTESS_DELETED_SCREENSHOT'))
            .replace(null,false,Gio.FileCreateFlags.NONE,null);
        const m=Main.layoutManager.monitors[0];
        await new Shell.Screenshot().screenshot_area(m.x,m.y,m.width,m.height,stream);
        stream.close(null);
    }
    app.studio.undoDeleteButton.emit('clicked',1);
    assert(app.savedLayouts.some(item=>item.id===saved.id) && app.studio.previewSavedId===saved.id,
        'Undo delete restores the template and its preview');
    assert(app.studio.deleteButton.visible && app.studio.deleteButton.get_parent()===app.studio.savedActions,
        'Delete layout sits beside the selected-layout summary');
    app.studio.dialog.close();
    app.deleteSavedLayout(saved.id);
    app.openStudio(); await pause();
    app.studio.apply(); await pause();
    app.openStudio(); await pause();
    assert(!app.studio.undoDeleteButton.visible && !app.studio.savedActions.visible,
        'Apply retires stale deleted-layout feedback');
    app.studio.dialog.close();
    if (Main.layoutManager.monitors.length > 1) {
        app.applyProfile(1,0,'auto',[windows[0]]); await pause();
        windows[0].activate(global.get_current_time()); await pause();
        assert(JSON.parse(app.settings.get_string('preview-state')).monitor===1,
            'preferences preview follows the focused display');
        assert(windows[0].get_monitor()===1,
            `studio assignment moves across monitors: frame ${geometry(windows[0])}, record ${JSON.stringify(app.records.get(windows[0])?.tileRect)}`);
        app.switchSpace(1,1); await pause();
        assert(windows[0].minimized && windows.slice(1).every(w=>!w.minimized),'spaces independent per monitor');
        app.switchSpace(0,1); await pause();
        app.applyProfile(0,0,'auto',windows); await pause();
        assert(windows[0].get_monitor()===0,
            `studio assignment returns to the primary monitor: frame ${geometry(windows[0])}, record ${JSON.stringify(app.records.get(windows[0])?.tileRect)}`);
        assert(app.groups.get(app.key(0)).filter(Boolean).length===4,'studio assignment reflows target');
        assert(app.groups.get(app.key(1)).filter(Boolean).length===0,'studio assignment reflows source');
    }
    const beforeFullscreenOpen=new Set(app.records.keys());
    const beforeFullscreenSlots=[...app.groups.get(app.key(0))];
    windows[0].make_fullscreen(); await pause();
    for(let i=0;i<2;i++) await Scripting.createTestWindow({width:320,height:240});
    await Scripting.waitTestWindows();
    await Scripting.sleep(1400);
    const openedDuringFullscreen=[...app.records.keys()].filter(w=>!beforeFullscreenOpen.has(w));
    assert(openedDuringFullscreen.length===2 && app.deferredRetile.has(app.key(0)) &&
        app.groups.get(app.key(0)).filter(Boolean).length===4,
    'new windows wait for a full reflow while another window is fullscreen');
    windows[0].unmake_fullscreen();
    for(let i=0;i<30 && app.groups.get(app.key(0)).filter(Boolean).length!==6;i++) await Scripting.sleep(100);
    await Scripting.sleep(450);
    const reflowed=app.groups.get(app.key(0));
    assert(reflowed.filter(Boolean).length===6 && !app.deferredRetile.has(app.key(0)),
        'exiting fullscreen reflows the original and newly opened windows together');
    assert(beforeFullscreenSlots.every((w,index)=>reflowed[index]===w),
        'reflow keeps existing windows in their original tile order');
    for(const w of reflowed) {
        const target=app.records.get(w)?.tileRect, actual=w.get_frame_rect();
        assert(target && ['x','y','width','height'].every(key=>Math.abs(actual[key]-target[key])<=2),
            `window matches its new tile after fullscreen: ${geometry(w)} vs ${JSON.stringify(target)}`);
    }
    windows.forEach((w,i)=>{
        const r=app.records.get(w)?.original,s=originals[i];
        assert(r && r.x===s.x && r.y===s.y && r.width===s.width && r.height===s.height &&
            r.tileRect===null, `stop retains original snapshot for ${i}: ${JSON.stringify(r)}`);
    });
    app.setRunning(false); await pause();
    assert(app.settings.get_string('preview-state')==='{}','preview clears when arrangement stops');
    assert(app.motionGuides.size===0 && app.spaceTransitions.size===0 && app.spaceDots.size===0,
        'pausing removes short-lived visual actors');
    const restoredOriginals=()=>windows.every((w,i)=>{
        const r=w.get_frame_rect(),s=originals[i];
        return r.x===s.x && r.y===s.y && r.width===s.width && r.height===s.height;
    });
    for (let i=0;i<20 && !restoredOriginals();i++) await Scripting.sleep(100);
    windows.forEach((w,i)=>{
        const r=w.get_frame_rect(),s=originals[i];
        assert(r.x===s.x && r.y===s.y && r.width===s.width && r.height===s.height,
            `stop restores original geometry for ${i}: ${geometry(w)} vs ${[s.x,s.y,s.width,s.height].join(',')}`);
    });
    app.setRunning(true); await pause();
    const reloadLayoutId=app.saveLayout('Reload test','full',[windows[0]],[]);
    const firstRuntimeClass=app.constructor;
    await Main.extensionManager.disableExtension(loader.uuid); await pause();
    assert(app.settings===null,'disabled runtime releases settings');
    assert(!Main.panel.statusArea[loader.uuid],'disable removes indicator');
    assert(!hotRoot.query_exists(null),'disable removes hot reload staging');
    await Main.extensionManager.enableExtension(loader.uuid); await pause();
    const reloadedEntry=Main.extensionManager.lookup(loader.uuid);
    const reloaded=await waitRuntime(reloadedEntry.stateObj);
    assert(reloaded,'runtime reloads after disable/enable');
    assert(reloaded.savedLayouts.some(item=>item.id===reloadLayoutId),
        'named layouts persist independently across extension reloads');
    reloaded.deleteSavedLayout(reloadLayoutId);
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
