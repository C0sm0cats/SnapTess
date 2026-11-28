import test from 'node:test';
import assert from 'node:assert/strict';
import {makeArchive, mergeArchive, parseArchive, validSavedLayout} from '../lib/archive.js';

const layout = {id: 'pair', name: 'Pair', preset: 'split', slotCount: 2,
    apps: ['editor.desktop', 'browser.desktop'], pinned: [null, 'browser.desktop']};
const profile = {preset: 'split', apps: ['editor.desktop', 'browser.desktop'], pinned: [null, null], slotCount: 2};

test('archive round trip preserves layouts and per-space profiles', () => {
    const text = makeArchive([layout], {'0:HDMI-A-1:0': profile});
    const parsed = parseArchive(text);
    assert.deepEqual(parsed.layouts, [layout]);
    assert.deepEqual(parsed.profiles, {'0:HDMI-A-1:0': profile});
});

test('legacy layouts and profiles without optional fields remain exportable', () => {
    const legacyLayout = {...layout};
    delete legacyLayout.apps;
    const legacyProfile = {preset: 'master', apps: ['editor.desktop', 'browser.desktop']};
    const text = makeArchive([legacyLayout], {'0:DP-1:2': legacyProfile});
    assert.deepEqual(parseArchive(text).profiles['0:DP-1:2'], legacyProfile);
    assert.equal(parseArchive(text).layouts[0].apps, undefined);
});

test('import merges without replacing existing layouts or profiles', () => {
    const text = makeArchive([layout], {'0:HDMI-A-1:0': profile, '0:DP-1:1': profile});
    const existing = {...layout, apps: ['other.desktop', null]};
    const existingProfile = {preset: 'full', apps: ['other.desktop'], pinned: []};
    const merged = mergeArchive(text, [existing], {'0:HDMI-A-1:0': existingProfile}, () => 'new-id');
    assert.equal(merged.addedLayouts, 1);
    assert.equal(merged.layouts[0], existing);
    assert.deepEqual(merged.layouts[1], {...layout, id: 'new-id', name: 'Pair (imported)'});
    assert.equal(merged.addedProfiles, 1);
    assert.equal(merged.profiles['0:HDMI-A-1:0'], existingProfile);
    assert.deepEqual(merged.profiles['0:DP-1:1'], profile);
});

test('identical layouts are not imported twice', () => {
    const merged = mergeArchive(makeArchive([layout], {}), [layout], {}, () => 'unused');
    assert.equal(merged.addedLayouts, 0);
});

test('reimporting a backup skips the layouts an earlier import renamed', () => {
    let count = 0;
    const newId = () => `new-${++count}`;
    const work = {...layout, id: 'work', name: 'Work'};
    const home = {...layout, id: 'home', name: 'Home'};
    const backup = makeArchive([work, home, layout], {});
    let layouts = [{...work, id: 'mine', apps: [null, null]}, {...layout, apps: ['other.desktop', null]}];
    const first = mergeArchive(backup, layouts, {}, newId);
    assert.equal(first.addedLayouts, 3);
    layouts = first.layouts;
    for (const time of [2, 3]) {
        const again = mergeArchive(backup, layouts, {}, newId);
        assert.equal(again.addedLayouts, 0, `import ${time} adds nothing`);
        assert.deepEqual(again.layouts, layouts);
    }
    assert.deepEqual(layouts.map(item => item.name), ['Work', 'Pair', 'Work (imported)', 'Home', 'Pair (imported)']);
    const changed = makeArchive([{...work, apps: ['changed.desktop', null]}], {});
    assert.deepEqual(mergeArchive(changed, layouts, {}, newId).layouts.at(-1).name, 'Work (imported 2)',
        'a changed layout under a taken name is still imported');
    assert.equal(mergeArchive(makeArchive([{...work, id: 'other', name: 'Office'}], {}), layouts, {}, newId).addedLayouts, 1,
        'the same content under another name is still imported');
});

test('conflicting imported names stay unique, valid and exportable', () => {
    let count = 0;
    const newId = () => `new-${++count}`;
    const long = {...layout, id: 'long', name: 'Development workspace with browser editor and terminal'};
    const merged = mergeArchive(makeArchive([long], {}), [{...long, id: 'mine', apps: [null, null]}], {}, newId);
    const imported = merged.layouts.at(-1);
    assert.equal(imported.name, `${long.name.slice(0, 45)} (imported)`);
    assert.ok(imported.name.length <= 60);
    assert.ok(validSavedLayout(imported));
    assert.doesNotThrow(() => makeArchive(merged.layouts, {}));
    const second = mergeArchive(makeArchive([{...long, apps: ['changed.desktop', null]}], {}), merged.layouts, {}, newId);
    assert.equal(second.layouts.at(-1).name, `${long.name.slice(0, 45)} (imported 2)`);
    assert.doesNotThrow(() => makeArchive(second.layouts, {}));
    const pairs = [{...layout, apps: [null, null]}];
    for (const apps of [['one.desktop', null], ['two.desktop', null]])
        pairs.push(mergeArchive(makeArchive([{...layout, id: 'x', name: 'pair', apps}], {}), pairs, {}, newId).layouts.at(-1));
    assert.deepEqual(pairs.map(item => item.name), ['Pair', 'pair (imported)', 'pair (imported 2)'],
        'a name differing only by case is renamed too');
});

test('invalid or oversized files leave import state untouched', () => {
    for (const text of ['{', '{}', ' '.repeat(1024 * 1024 + 1),
        JSON.stringify({format: 'snaptess-layouts', version: 1, layouts: [{...layout, slotCount: 3}], profiles: {}}),
        JSON.stringify({format: 'snaptess-layouts', version: 1, layouts: [], profiles: {'0:HDMI-A-1:0': {preset: 'bogus'}}})])
        assert.throws(() => mergeArchive(text, [layout], {}, () => 'new-id'));
});

test('custom geometry round trips in templates and profiles while legacy archives remain valid', () => {
    const tiles = [{x: 0, y: 0, width: .6, height: 1}, {x: .6, y: 0, width: .4, height: 1}];
    const custom = {...layout, preset: 'custom', tiles};
    const customProfile = {...profile, preset: 'custom', tiles};
    const parsed = parseArchive(makeArchive([layout, custom], {'0:DP-1:0': customProfile}));
    assert.deepEqual(parsed.layouts[1].tiles, tiles);
    assert.deepEqual(parsed.profiles['0:DP-1:0'].tiles, tiles);
    assert.throws(() => makeArchive([{...custom, tiles: [{...tiles[0], width: .5}, tiles[1]]}], {}));
    assert.throws(() => makeArchive([{...custom, slotCount: 1}], {}));
    assert.throws(() => makeArchive([], {'0:DP-1:0': {...customProfile, tiles: []}}));
});

test('archives omit live window identities while preserving portable profile settings', () => {
    const shared = {...profile, sharedWindows: [{sequence: 42, pid: 1234, appId: 'editor.desktop'}]};
    const text = makeArchive([], {'0:DP-1:0': shared});
    assert.deepEqual(parseArchive(text).profiles['0:DP-1:0'], profile);
    assert.equal(shared.sharedWindows.length, 1, 'export leaves live memberships intact');
    const legacyText = JSON.stringify({format: 'snaptess-layouts', version: 1, layouts: [],
        profiles: {'0:DP-1:0': shared}});
    assert.deepEqual(mergeArchive(legacyText, [], {}, () => 'id').profiles['0:DP-1:0'], profile);
});

test('profiles with deliberately empty tiles round-trip without pending launch metadata', () => {
    const profiles = {'0:DP-1:0': {preset: 'split', apps: [null, 'app.desktop'], pinned: [],
        slotCount: 2, preserveSlots: true, pendingApps: ['app.desktop']}};
    const archive = parseArchive(makeArchive([], profiles));
    assert.deepEqual(archive.profiles['0:DP-1:0'].apps, [null, 'app.desktop']);
    assert.equal(archive.profiles['0:DP-1:0'].preserveSlots, true);
    assert.equal(archive.profiles['0:DP-1:0'].pendingApps, undefined);
});

test('a layout holding and pinning the same app on several tiles survives export then import', () => {
    const repeated = {id: 'orca', name: 'Orca', preset: 'split', slotCount: 2,
        apps: ['orca.desktop', 'orca.desktop'], pinned: ['orca.desktop', 'orca.desktop']};
    const text = makeArchive([repeated], {});
    assert.deepEqual(parseArchive(text).layouts, [repeated]);
    const merged = mergeArchive(text, [], {}, () => 'unused');
    assert.equal(merged.addedLayouts, 1);
    assert.deepEqual(merged.layouts, [repeated]);
});

test('profiles the runtime writes for many or unidentified windows stay exportable', () => {
    const apps = Array.from({length: 31}, (_, i) => `app${i}.desktop`);
    const many = {preset: 'auto', apps, pinned: Array(31).fill(null), slotCount: 31, preserveSlots: true};
    // Releases before this fix saved an empty ID for a window without an app.
    const legacy = {preset: 'split', apps: ['', 'editor.desktop'], pinned: ['', null]};
    const text = makeArchive([], {'0:DP-1:0': many, '0:DP-1:1': legacy});
    assert.deepEqual(parseArchive(text).profiles['0:DP-1:0'], many);
    assert.deepEqual(parseArchive(text).profiles['0:DP-1:1'], {preset: 'split', apps: [null, 'editor.desktop'], pinned: [null, null]});
    assert.equal(mergeArchive(text, [], {}, () => 'id').addedProfiles, 2, 'the same version imports its own export');
    assert.deepEqual(legacy.apps, ['', 'editor.desktop'], 'export leaves the stored profile intact');
    const tiles = Array.from({length: 31}, (_, i) => ({x: i / 31, y: 0, width: 1 / 31, height: 1}));
    assert.throws(() => makeArchive([], {'0:DP-1:2': {preset: 'custom', tiles, slotCount: 31, apps: []}}));
});

test('a custom profile whose space holds more windows than tiles stays exportable', () => {
    const tiles = [{x: 0, y: 0, width: .5, height: 1}, {x: .5, y: 0, width: .5, height: 1}];
    const apps = Array.from({length: 31}, (_, i) => `app${i}.desktop`);
    const profile = {preset: 'custom', tiles, slotCount: 2, apps, pinned: Array(31).fill(null)};
    assert.deepEqual(parseArchive(makeArchive([], {'0:DP-1:0': profile})).profiles['0:DP-1:0'], profile);
});

test('an export refused for one entry names that layout or space', () => {
    assert.throws(() => makeArchive([], {'1:HDMI-A-1:2': {preset: 'bogus', apps: []}}),
        {message: 'The profile of HDMI-A-1, workspace 2, Space 3 cannot be exported. Use Reset Space in Layout Studio and try again.'});
    assert.throws(() => makeArchive([{...layout, slotCount: 3}], {}),
        {message: 'The layout "Pair" cannot be exported. Delete it in Layout Studio and try again.'});
});
