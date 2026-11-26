import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {versionNotice, loaderVersionFromSource} from '../lib/version-notice.js';

const running = {release_version: '0.2.70', loader_version: 1, runtime_revision: 100};

test('the running version matches the disk: no notice', () => {
    assert.deepEqual(versionNotice('0.2.70', 1, running), {version: '0.2.70', notice: ''});
});

test('a pending update with the same loader can be reloaded in place', () => {
    const {version, notice} = versionNotice('0.2.71', 1, running);
    assert.equal(version, '0.2.70');
    assert.match(notice, /v0\.2\.71 is installed\. Run \.\/scripts\/install\.sh or log out/);
});

test('a pending update with a new loader needs a login', () => {
    const {version, notice} = versionNotice('0.2.71', 2, running);
    assert.equal(version, '0.2.70');
    assert.match(notice, /v0\.2\.71 is installed\. Log out and back in/);
    assert.doesNotMatch(notice, /install\.sh/);
});

test('a runtime that predates the release version (0.2.69 or older) is reported as older', () => {
    const {version, notice} = versionNotice('0.2.70', 1, {runtime_revision: 98, extension_version: 70});
    assert.equal(version, '0.2.70');
    assert.match(notice, /older version is running/);
});

test('a load error is shown', () => {
    const {notice} = versionNotice('0.2.70', 1, {loader_version: 1, error: 'SyntaxError: boom'});
    assert.match(notice, /failed to load: SyntaxError: boom/);
});

test('a missing status means SnapTess is not running', () => {
    assert.deepEqual(versionNotice('0.2.70', 1, null), {version: '0.2.70', notice: 'SnapTess is not running.'});
});

test('the loader version is read from extension.js like install.sh does', () => {
    assert.equal(loaderVersionFromSource(fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8')), 1);
    assert.equal(loaderVersionFromSource('const x = 1;'), null);
});
