import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {actionStyle, actionPlacement, actionHandleSize, actionPaletteSize, actionHandleIcon, actionSlide,
    actionTooltipPlacement, actionHandleStyle, actionPaletteStyle, appRuleValue, lighten, REMOTE_HANDLE_COLOR} from '../lib/window-actions.js';

const area = {x: 0, y: 32, width: 1920, height: 1048};
const tiled = {x: 960, y: 44, width: 948, height: 1024};

test('the handle attaches to each edge, centered along it', () => {
    const left = actionPlacement('left', tiled, area, actionHandleSize('left'));
    assert.deepEqual(left, {x: 964, y: Math.round(44 + (1024 - 40) / 2)});
    const right = actionPlacement('right', tiled, area, actionHandleSize('right'));
    assert.deepEqual(right, {x: 960 + 948 - 28 - 4, y: left.y});
    const top = actionPlacement('top', tiled, area, actionHandleSize('top'));
    assert.deepEqual(top, {x: Math.round(960 + (948 - 40) / 2), y: 48});
    const bottom = actionPlacement('bottom', tiled, area, actionHandleSize('bottom'));
    assert.deepEqual(bottom, {x: top.x, y: 44 + 1024 - 28 - 4});
});

test('a maximized window keeps every control inside the work area', () => {
    const maximized = {x: 0, y: 32, width: 1920, height: 1048};
    for (const position of ['left', 'right', 'top', 'bottom']) {
        for (const size of [actionHandleSize(position), actionPaletteSize(position)]) {
            const {x, y} = actionPlacement(position, maximized, area, size);
            assert.ok(x >= area.x + 6 && x + size.width <= area.x + area.width - 6, `${position} x`);
            assert.ok(y >= area.y + 8 && y + size.height <= area.y + area.height - 8, `${position} y`);
        }
    }
    const offscreen = {x: 1900, y: 1060, width: 400, height: 300};
    const {x, y} = actionPlacement('right', offscreen, area, actionPaletteSize('right'));
    assert.equal(x, area.x + area.width - 44 - 6);
    assert.equal(y, area.y + area.height - 176 - 8);
});

test('top and bottom controls are horizontal with matching arrows and slides', () => {
    assert.deepEqual(actionHandleSize('left'), {width: 28, height: 40});
    assert.deepEqual(actionHandleSize('top'), {width: 40, height: 28});
    assert.deepEqual(actionPaletteSize('right'), {width: 44, height: 176});
    assert.deepEqual(actionPaletteSize('bottom'), {width: 176, height: 44});
    assert.deepEqual(['left', 'right', 'top', 'bottom'].map(actionHandleIcon),
        ['go-next-symbolic', 'go-previous-symbolic', 'go-down-symbolic', 'go-up-symbolic']);
    assert.deepEqual(actionSlide('left'), {x: -8, y: 0});
    assert.deepEqual(actionSlide('right'), {x: 8, y: 0});
    assert.deepEqual(actionSlide('top'), {x: 0, y: -8});
    assert.deepEqual(actionSlide('bottom'), {x: 0, y: 8});
});

test('tooltips open away from the edge the palette is attached to', () => {
    const tooltip = {width: 120, height: 26};
    const button = {x: 1000, y: 500, width: 36, height: 36};
    assert.equal(actionTooltipPlacement('left', button, tooltip, area).x, 1044);
    assert.equal(actionTooltipPlacement('right', button, tooltip, area).x, 1000 - 120 - 8);
    assert.equal(actionTooltipPlacement('top', button, tooltip, area).y, 544);
    assert.equal(actionTooltipPlacement('bottom', button, tooltip, area).y, 500 - 26 - 8);
    const nearRight = {x: 1870, y: 500, width: 36, height: 36};
    assert.equal(actionTooltipPlacement('left', nearRight, tooltip, area).x, 1870 - 120 - 8);
    const nearLeft = {x: 10, y: 500, width: 36, height: 36};
    assert.equal(actionTooltipPlacement('right', nearLeft, tooltip, area).x, 54);
});

test('rules match app IDs and WM_CLASS like other application rules', () => {
    const positions = {'org.remmina.Remmina': 'right', 'VirtualBox Machine': 'top', broken: 'diagonal'};
    const colors = {'org.remmina.Remmina': '#ED5B00', broken: 'orange'};
    assert.deepEqual(actionStyle(['org.remmina.Remmina.desktop', 'org.remmina.Remmina'], positions, colors),
        {position: 'right', color: '#ed5b00'});
    assert.deepEqual(actionStyle(['', 'virtualbox machine'], positions, colors), {position: 'top', color: null});
    assert.deepEqual(actionStyle(['broken'], positions, colors), {position: 'left', color: null});
    assert.deepEqual(actionStyle(['org.example.Editor.desktop'], positions, colors), {position: 'left', color: null});
    assert.equal(appRuleValue(null, ['x']), null);
});

test('colored handles keep a visible border; default style is untouched', () => {
    assert.equal(actionHandleStyle(null), null);
    assert.equal(actionPaletteStyle(null), null);
    assert.equal(lighten('#000000', 0.5), '#808080');
    assert.equal(actionHandleStyle('#ed5b00'), `background-color: rgba(237,91,0,0.96); border-color: ${lighten('#ed5b00')};`);
    assert.equal(actionPaletteStyle('#ed5b00'), 'border-color: #ed5b00;');
});

test('remote desktop and VM clients default to an orange handle on the right', () => {
    const schema = fs.readFileSync(new URL('../schemas/org.gnome.shell.extensions.snaptess.gschema.xml', import.meta.url), 'utf8');
    const parse = name => Object.fromEntries([...schema.match(new RegExp(`name="${name}"[^>]*><default>\\{([^}]*)\\}`))[1]
        .matchAll(/'([^']+)': '([^']+)'/g)].map(match => [match[1], match[2]]));
    const positions = parse('window-action-positions'), colors = parse('window-action-colors');
    for (const id of ['xfreerdp', 'sdl-freerdp', 'wlfreerdp', 'org.remmina.Remmina', 'org.gnome.Connections',
        'org.kde.krdc', 'vncviewer', 'rustdesk', 'anydesk', 'TeamViewer', 'nxplayer', 'x2goclient',
        'com.moonlight_stream.Moonlight', 'parsecd', 'org.gnome.Boxes', 'remote-viewer', 'virt-manager',
        'VirtualBox Machine', 'vmware']) {
        assert.deepEqual(actionStyle([id], positions, colors), {position: 'right', color: REMOTE_HANDLE_COLOR}, id);
    }
    assert.deepEqual(Object.keys(positions).sort(), Object.keys(colors).sort());
});
