import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Classes that GNOME Shell or St itself sets on its own widgets.
const SHELL_CLASSES = new Set([
    'hint-text',
    'popup-menu-item',
    'modal-dialog-button-box',
    'modal-dialog-button',
]);

function sourceText() {
    const files = ['extension.js', 'runtime.js', 'prefs.js',
        ...readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => join('lib', name))];
    return files.map(file => readFileSync(join(root, file), 'utf8')).join('\n');
}

test('every stylesheet class is set by the extension or by GNOME Shell', () => {
    const css = readFileSync(join(root, 'stylesheet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(match => match[1]));
    const source = sourceText();
    const orphans = [...classes].filter(name => !SHELL_CLASSES.has(name) && !source.includes(name)).sort();
    assert.deepEqual(orphans, []);
});
