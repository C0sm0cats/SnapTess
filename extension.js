import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Bump when this loader changes: scripts/install.sh then asks for one new login.
export const LOADER_VERSION = 1;
const HOT_ROOT = 'snaptess-hot-reload';
const STATUS_DIR = 'snaptess';
const RELOAD_REQUEST = 'reload-request';

function ensureDir(file) {
    try {
        file.make_directory_with_parents(null);
    } catch (error) {
        if (!file.query_exists(null)) throw error;
    }
}

function copyTree(source, target) {
    ensureDir(target);
    const enumerator = source.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    try {
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
            const name = info.get_name();
            const from = source.get_child(name);
            const to = target.get_child(name);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                copyTree(from, to);
            else
                from.copy(to, Gio.FileCopyFlags.OVERWRITE, null, null);
        }
    } finally {
        enumerator.close(null);
    }
}

function hotRoot() {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(),
        HOT_ROOT,
    ]));
}

function removeTree(file) {
    if (!file.query_exists(null)) return;

    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );
        try {
            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
                removeTree(file.get_child(info.get_name()));
        } finally {
            enumerator.close(null);
        }
    }

    file.delete(null);
}

/*
 * Stable loader. scripts/install.sh writes $XDG_RUNTIME_DIR/snaptess/reload-request
 * and the loader swaps the runtime and the stylesheet itself. GNOME Shell never
 * disables the extension, so the extensions enabled after this one keep running.
 */
export default class SnapTess extends Extension {
    constructor(metadata) {
        super(metadata);
        this._generation = 0;
        this._runtime = null;
        this._reloadMonitor = null;
        this._reloadIdleId = 0;
    }

    get runtime() {
        return this._runtime;
    }

    enable() {
        this._enabled = true;
        this._watchReloadRequests();
        this._loadRuntime();
    }

    disable() {
        this._enabled = false;
        if (this._reloadIdleId) {
            GLib.source_remove(this._reloadIdleId);
            this._reloadIdleId = 0;
        }
        this._reloadMonitor?.cancel();
        this._reloadMonitor = null;
        this._unloadRuntime();
    }

    _statusDir() {
        return GLib.build_filenamev([GLib.get_user_runtime_dir(), STATUS_DIR]);
    }

    // The metadata GNOME Shell read at login is stale after a reload.
    _currentMetadata() {
        try {
            const [ok, contents] = GLib.file_get_contents(this.dir.get_child('metadata.json').get_path());
            if (ok) return {...this.metadata, ...JSON.parse(new TextDecoder().decode(contents))};
        } catch (error) {
            console.error(`[SnapTess] cannot read metadata.json: ${error.stack ?? error}`);
        }
        return this.metadata;
    }

    _loadRuntime() {
        const generation = ++this._generation;
        const root = hotRoot().get_child(`${GLib.get_real_time()}-${generation}`);
        ensureDir(root);

        this.dir.get_child('runtime.js').copy(
            root.get_child('runtime.js'),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
        copyTree(this.dir.get_child('lib'), root.get_child('lib'));

        import(root.get_child('runtime.js').get_uri())
            .then(module => {
                if (!this._enabled || generation !== this._generation) return;
                const Runtime = module.default;
                const runtime = new Runtime(this._currentMetadata());
                runtime.loaderVersion = LOADER_VERSION;
                try {
                    runtime.enable();
                } catch (error) {
                    // A half-enabled runtime must not block the next reload.
                    this._teardown(runtime);
                    throw error;
                }
                this._runtime = runtime;
                this._writeStatus({});
            })
            .catch(error => {
                if (generation !== this._generation) return;
                console.error(`[SnapTess] hot reload failed: ${error.stack ?? error}`);
                this._writeStatus({error: String(error)});
            });
    }

    // Also cleans up what a runtime that failed half-way left behind.
    _teardown(runtime) {
        try {
            runtime?.disable();
        } catch (error) {
            console.error(`[SnapTess] runtime teardown failed: ${error.stack ?? error}`);
        }
        try {
            Main.panel.statusArea[this.uuid]?.destroy();
        } catch {
            // Already destroyed.
        }
        delete Main.panel.statusArea[this.uuid];
    }

    _unloadRuntime() {
        ++this._generation;
        const runtime = this._runtime;
        this._runtime = null;
        this._teardown(runtime);
        try {
            removeTree(hotRoot());
        } catch (error) {
            console.error(`[SnapTess] hot reload cleanup failed: ${error.stack ?? error}`);
        }
    }

    // The loader version is known even when the runtime failed to load, so
    // scripts/install.sh can request a reload instead of a new login.
    _writeStatus(extra) {
        try {
            const path = GLib.build_filenamev([this._statusDir(), 'runtime-status.json']);
            let status = {};
            try {
                const [ok, contents] = GLib.file_get_contents(path);
                if (ok && !extra.error) status = JSON.parse(new TextDecoder().decode(contents));
            } catch {
                // No status yet.
            }
            delete status.error;
            GLib.mkdir_with_parents(this._statusDir(), 0o700);
            GLib.file_set_contents(path, JSON.stringify({
                ...status, loader_version: LOADER_VERSION, ...extra,
                ...extra.error ? {loaded_at: new Date().toISOString()} : {},
            }, null, 2));
        } catch (error) {
            console.error(`[SnapTess] cannot write loader status: ${error.stack ?? error}`);
        }
    }

    _watchReloadRequests() {
        const dir = Gio.File.new_for_path(this._statusDir());
        ensureDir(dir);
        try {
            this._reloadMonitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (error) {
            console.error(`[SnapTess] cannot watch reload requests: ${error.stack ?? error}`);
            return;
        }
        this._reloadMonitor.connect('changed', (_monitor, file, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.DELETED) return;
            const names = [file, otherFile].filter(Boolean).map(candidate => candidate.get_basename());
            if (!names.includes(RELOAD_REQUEST) || this._reloadIdleId) return;
            this._reloadIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._reloadIdleId = 0;
                this.reload();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Replaces the runtime in place, without disabling the extension.
    reload() {
        if (!this._enabled) return;
        const request = Gio.File.new_for_path(GLib.build_filenamev([this._statusDir(), RELOAD_REQUEST]));
        try {
            request.delete(null);
        } catch {
            // No request file: a direct call, or already consumed.
        }
        this._unloadRuntime();
        try {
            this._reloadStylesheet();
        } catch (error) {
            console.error(`[SnapTess] stylesheet reload failed: ${error.stack ?? error}`);
        }
        this._loadRuntime();
    }

    // Same lookup order as GNOME Shell's extension system.
    _reloadStylesheet() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const record = Main.extensionManager.lookup(this.uuid);
        if (record?.stylesheet) {
            theme.unload_stylesheet(record.stylesheet);
            delete record.stylesheet;
        }
        const variant = Main.getStyleVariant?.() ?? '';
        const names = [`stylesheet-${variant}.css`, 'stylesheet.css'];
        for (const name of variant ? names : names.slice(1)) {
            const file = this.dir.get_child(name);
            if (!file.query_exists(null)) continue;
            theme.load_stylesheet(file);
            if (record) record.stylesheet = file;
            break;
        }
    }
}
