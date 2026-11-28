import {PRESETS, capacity, validCustomTiles} from './layout.js';

const FORMAT = 'snaptess-layouts';
const VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const appId = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256);
const appList = (value, count) => Array.isArray(value) && value.length <= count && value.every(appId);

export function validSavedLayout(item) {
    return isObject(item) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
        typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 60 &&
        (PRESETS.some(([id]) => id === item.preset) || item.preset === 'custom') &&
        Number.isInteger(item.slotCount) && item.slotCount >= 1 && item.slotCount <= 30 &&
        (item.preset === 'auto' || item.slotCount <= capacity(item.preset, item.tiles)) &&
        (item.preset !== 'custom' || (validCustomTiles(item.tiles) && item.slotCount === item.tiles.length)) &&
        appList(item.pinned, item.slotCount) &&
        (item.apps === undefined || appList(item.apps, item.slotCount));
}

function validProfile(profile) {
    // The runtime arranges any number of windows in a preset profile, so only
    // custom tiles keep the 30-slot limit; MAX_BYTES still bounds the archive.
    const limit = profile?.preset === 'custom' ? 30 : Infinity;
    return isObject(profile) && (PRESETS.some(([id]) => id === profile.preset) ||
        (profile.preset === 'custom' && validCustomTiles(profile.tiles) && profile.slotCount === profile.tiles.length)) &&
        appList(profile.apps, limit) &&
        (profile.pinned === undefined || appList(profile.pinned, limit)) &&
        (profile.slotCount === undefined || (Number.isInteger(profile.slotCount) &&
            profile.slotCount >= 1 && profile.slotCount <= limit));
}

export function parseArchive(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES)
        throw new Error('The file is too large (maximum 1 MB).');
    let archive;
    try { archive = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
    if (!isObject(archive) || archive.format !== FORMAT || archive.version !== VERSION ||
        !Array.isArray(archive.layouts) || !isObject(archive.profiles))
        throw new Error('This is not a supported SnapTess layout archive.');
    if (archive.layouts.length > 500 || Object.keys(archive.profiles).length > 1000 ||
        !archive.layouts.every(validSavedLayout) ||
        Object.entries(archive.profiles).some(([key, profile]) =>
            !/^\d+:[^\n\r]{1,120}:[012]$/.test(key) || !validProfile(profile)))
        throw new Error('The archive contains invalid layouts or profiles.');
    return archive;
}

// Live window identities and pending launches belong to this GNOME session.
// Older releases saved an empty app ID for a window without one.
function portableProfile(profile) {
    const {sharedWindows, pendingApps, ...portable} = profile;
    for (const field of ['apps', 'pinned'])
        if (Array.isArray(portable[field])) portable[field] = portable[field].map(id => id === '' ? null : id);
    return portable;
}

function spaceName(key) {
    const match = /^(\d+):(.+):([012])$/.exec(key);
    return match ? `${match[2]}, workspace ${Number(match[1]) + 1}, Space ${Number(match[3]) + 1}` : key;
}

export function makeArchive(layouts, profiles) {
    profiles = Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, portableProfile(profile)]));
    const invalid = layouts.findIndex(item => !validSavedLayout(item));
    if (invalid >= 0) {
        const name = layouts[invalid]?.name;
        throw new Error(`The layout ${typeof name === 'string' ? `"${name}"` : `number ${invalid + 1}`} cannot be exported. Delete it in Layout Studio and try again.`);
    }
    const key = Object.keys(profiles).find(item => !validProfile(profiles[item]));
    if (key !== undefined)
        throw new Error(`The profile of ${spaceName(key)} cannot be exported. Use Reset Space in Layout Studio and try again.`);
    const text = JSON.stringify({format: FORMAT, version: VERSION, layouts, profiles}, null, 2) + '\n';
    parseArchive(text);
    return text;
}

export function mergeArchive(text, currentLayouts, currentProfiles, newId) {
    const archive = parseArchive(text);
    const layouts = [...currentLayouts];
    const profiles = {...currentProfiles};
    const names = new Set(layouts.map(item => item.name.toLocaleLowerCase()));
    const ids = new Set(layouts.map(item => item.id));
    let addedLayouts = 0, addedProfiles = 0;
    for (const imported of archive.layouts) {
        if (layouts.some(item => item.id === imported.id &&
            JSON.stringify(item) === JSON.stringify(imported))) continue;
        let name = imported.name;
        if (names.has(name.toLocaleLowerCase())) {
            const base = imported.name.slice(0, 45);
            name = `${base} (imported)`;
            for (let number = 2; names.has(name.toLocaleLowerCase()); number++)
                name = `${base} (imported ${number})`;
        }
        let id = imported.id;
        if (ids.has(id)) {
            do { id = newId(); } while (ids.has(id));
        }
        layouts.push({...imported, id, name});
        names.add(name.toLocaleLowerCase()); ids.add(id); addedLayouts++;
    }
    for (const [key, profile] of Object.entries(archive.profiles)) {
        if (Object.hasOwn(profiles, key)) continue;
        profiles[key] = portableProfile(profile);
        addedProfiles++;
    }
    return {layouts, profiles, addedLayouts, addedProfiles};
}
