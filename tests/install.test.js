import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loaderVersionFromSource} from '../lib/version-notice.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const UUID = 'snaptess@c0sm0cats.github.io';
const LOADER_VERSION = loaderVersionFromSource(fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8'));

// Runs a copy of scripts/install.sh in a throwaway directory: HOME, XDG_DATA_HOME
// and XDG_RUNTIME_DIR live there, and gnome-extensions, glib-compile-schemas and
// sleep are fakes. The fake sleep plays the running loader: when a reload request
// is pending it consumes it and writes the prepared status, so the reload loop
// runs without real waiting.
function runInstall({status, response}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptess-install-'));
    try {
        const repo = path.join(dir, 'repo');
        fs.mkdirSync(path.join(repo, 'scripts'), {recursive: true});
        fs.mkdirSync(path.join(repo, 'schemas'));
        fs.copyFileSync(path.join(ROOT, 'scripts/install.sh'), path.join(repo, 'scripts/install.sh'));
        fs.copyFileSync(path.join(ROOT, 'extension.js'), path.join(repo, 'extension.js'));

        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const fake = (name, body) =>
            fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});
        fake('gnome-extensions', 'case "$1" in info) echo "  State: ACTIVE";; esac\nexit 0');
        fake('glib-compile-schemas', 'exit 0');
        const statusDir = path.join(dir, 'run/snaptess');
        const responseFile = path.join(dir, 'response.json');
        fake('sleep', [
            `req=${JSON.stringify(path.join(statusDir, 'reload-request'))}`,
            `resp=${JSON.stringify(responseFile)}`,
            'if [[ -f "$req" && -f "$resp" ]]; then',
            `    rm -f "$req"; mv "$resp" ${JSON.stringify(path.join(statusDir, 'runtime-status.json'))}`,
            'fi',
        ].join('\n'));

        fs.mkdirSync(statusDir, {recursive: true});
        if (status)
            fs.writeFileSync(path.join(statusDir, 'runtime-status.json'), JSON.stringify(status));
        if (response)
            fs.writeFileSync(responseFile, JSON.stringify(response));

        const result = spawnSync('bash', [path.join(repo, 'scripts/install.sh')], {
            encoding: 'utf8',
            env: {
                PATH: `${bin}:${process.env.PATH}`,
                HOME: path.join(dir, 'home'),
                XDG_DATA_HOME: path.join(dir, 'data'),
                XDG_RUNTIME_DIR: path.join(dir, 'run'),
            },
        });
        const link = path.join(dir, 'data/gnome-shell/extensions', UUID);
        return {
            code: result.status,
            out: result.stdout + result.stderr,
            linkTarget: fs.readlinkSync(link),
            repo,
            requestLeft: fs.existsSync(path.join(statusDir, 'reload-request')),
        };
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test('install.sh asks for a login instead of a reload when the running loader differs', () => {
    const r = runInstall({status: {loader_version: LOADER_VERSION - 1, loaded_at: 't0'}});
    assert.equal(r.linkTarget, r.repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Log out and back in once/);
    assert.equal(r.requestLeft, false, 'no reload request for an old loader');
});

test('install.sh reports a failed reload and exits 1', () => {
    const r = runInstall({
        status: {loader_version: LOADER_VERSION, loaded_at: 't0'},
        response: {loader_version: LOADER_VERSION, loaded_at: 't1', error: 'Error: boom'},
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /SnapTess reload failed: Error: boom/);
    assert.doesNotMatch(r.out, /reloaded in place/);
});

test('install.sh reports a reload in place that the loader confirmed', () => {
    const r = runInstall({
        status: {loader_version: LOADER_VERSION, loaded_at: 't0'},
        response: {loader_version: LOADER_VERSION, loaded_at: 't1', release_version: '0.2.70', runtime_revision: 100},
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(String.raw`SnapTess 0\.2\.70 reloaded in place: runtime revision 100, loader v${LOADER_VERSION}\.`));
});
