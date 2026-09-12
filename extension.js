import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOT_ROOT = 'snaptess-hot-reload';

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

export default class SnapTess extends Extension {
    constructor(metadata) {
        super(metadata);
        this._generation = 0;
        this._runtime = null;
    }

    get runtime() {
        return this._runtime;
    }

    enable() {
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
                if (generation !== this._generation) return;
                const Runtime = module.default;
                this._runtime = new Runtime(this.metadata);
                this._runtime.enable();
            })
            .catch(error => {
                if (generation === this._generation)
                    console.error(`[SnapTess] hot reload failed: ${error.stack ?? error}`);
            });
    }

    disable() {
        ++this._generation;
        try {
            this._runtime?.disable();
        } finally {
            this._runtime = null;
            try {
                removeTree(hotRoot());
            } catch (error) {
                console.error(`[SnapTess] hot reload cleanup failed: ${error.stack ?? error}`);
            }
        }
    }
}
