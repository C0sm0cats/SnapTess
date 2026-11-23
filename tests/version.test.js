import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// A release bumps the three numbers together: the package version, the GNOME
// metadata version and the runtime revision reported in runtime-status.json.
// They moved in step since v0.2.66; one bumped alone breaks the offsets.
test('package, metadata and runtime revision are bumped together', () => {
    const patch = Number(JSON.parse(read('package.json')).version.split('.')[2]);
    const metadata = JSON.parse(read('metadata.json')).version;
    const revision = Number(read('runtime.js').match(/^const RUNTIME_REVISION = (\d+);$/m)?.[1]);
    assert.equal(metadata - patch, 3, 'metadata.json version must be the package patch + 3');
    assert.equal(revision - metadata, 27, 'RUNTIME_REVISION must be the metadata.json version + 27');
});
