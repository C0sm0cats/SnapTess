import test from 'node:test';
import assert from 'node:assert/strict';
import {makeArchive, mergeArchive, parseArchive} from '../lib/archive.js';

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

test('invalid or oversized files leave import state untouched', () => {
    for (const text of ['{', '{}', ' '.repeat(1024 * 1024 + 1),
        JSON.stringify({format: 'snaptess-layouts', version: 1, layouts: [{...layout, slotCount: 3}], profiles: {}}),
        JSON.stringify({format: 'snaptess-layouts', version: 1, layouts: [], profiles: {'0:HDMI-A-1:0': {preset: 'bogus'}}})])
        assert.throws(() => mergeArchive(text, [layout], {}, () => 'new-id'));
});
