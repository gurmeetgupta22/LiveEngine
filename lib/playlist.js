import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MEDIA_SUFFIXES} from './const.js';

function normalizePath(path) {
    if (!path)
        return '';
    try {
        return Gio.File.new_for_path(path).get_path() || path;
    } catch {
        return path;
    }
}

function isMedia(path) {
    const lower = path.toLowerCase();
    return MEDIA_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

export class Playlist {
    constructor(settings) {
        this._settings = settings;
        this._timeoutId = 0;
        this._queue = [];
        this._index = -1;
        this.onChange = null;
        this._settingIds = [];
        this._cancellable = null;
        this._pendingNext = false;
    }

    start() {
        this.stop();
        this._cancellable = new Gio.Cancellable();
        const keys = ['auto-change', 'interval-minutes', 'playlist-order',
            'playlist-folder', 'playlist-files'];
        for (const key of keys) {
            this._settingIds.push(this._settings.connect(`changed::${key}`, () => {
                if (key === 'interval-minutes' && this._settings.get_boolean('auto-change'))
                    this._armTimer();
                else
                    this._rebuild();
            }));
        }
        this._settingIds.push(this._settings.connect('changed::source-path', () => {
            this._syncIndex();
        }));
        this._rebuild();
    }

    _rebuild() {
        this._loadFiles(files => {
            this._queue = files.map(normalizePath).filter(Boolean);
            this._syncIndex();
            this._armTimer();
            if (this._pendingNext) {
                this._pendingNext = false;
                this.next();
            }
        });
    }

    _syncIndex() {
        const current = normalizePath(this._settings.get_string('source-path'));
        this._index = this._queue.indexOf(current);
        if (this._index < 0 && this._queue.length)
            this._index = 0;
    }

    _order(files) {
        const current = normalizePath(this._settings.get_string('source-path'));
        let list = files.map(normalizePath).filter(Boolean);
        if (current && isMedia(current) && !list.includes(current))
            list = [current, ...list];
        if (this._settings.get_string('playlist-order') === 'shuffle')
            list = shuffle(list);
        return list;
    }

    _loadFiles(callback) {
        const explicit = this._settings.get_strv('playlist-files').filter(isMedia);
        if (explicit.length) {
            callback(this._order(explicit));
            return;
        }

        const folderPath = this._settings.get_string('playlist-folder');
        if (!folderPath) {
            callback(this._order([]));
            return;
        }

        const dir = Gio.File.new_for_path(folderPath);
        dir.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (file, result) => {
                let enumerator;
                try {
                    enumerator = file.enumerate_children_finish(result);
                } catch {
                    callback(this._order([]));
                    return;
                }
                this._readEnumerator(enumerator, [], callback);
            }
        );
    }

    _readEnumerator(enumerator, acc, callback) {
        enumerator.next_files_async(
            64,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (en, result) => {
                let infos;
                try {
                    infos = en.next_files_finish(result);
                } catch {
                    callback(this._order(acc));
                    return;
                }
                if (!infos.length) {
                    en.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                    acc.sort((a, b) => a.localeCompare(b));
                    callback(this._order(acc));
                    return;
                }
                for (const info of infos) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        continue;
                    const path = enumerator.get_child(info).get_path();
                    if (path && isMedia(path))
                        acc.push(path);
                }
                this._readEnumerator(enumerator, acc, callback);
            }
        );
    }

    _armTimer() {
        this._clearTimer();
        if (!this._settings.get_boolean('auto-change'))
            return;
        if (this._queue.length < 2)
            return;
        const minutes = this._settings.get_int('interval-minutes');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, minutes) * 60,
            () => {
                this.next();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _clearTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    current() {
        if (this._index >= 0 && this._index < this._queue.length)
            return this._queue[this._index];
        return this._settings.get_string('source-path');
    }

    next() {
        if (!this._queue.length) {
            this._pendingNext = true;
            this._rebuild();
            return this.current() || null;
        }
        const previous = normalizePath(this._settings.get_string('source-path'));
        if (this._index < 0)
            this._syncIndex();

        let attempts = 0;
        let path = previous;
        while (attempts < this._queue.length) {
            this._index = (this._index + 1) % this._queue.length;
            if (this._index === 0 && this._settings.get_string('playlist-order') === 'shuffle')
                this._queue = shuffle(this._queue);
            path = this._queue[this._index];
            attempts += 1;
            if (this._queue.length === 1 || path !== previous)
                break;
        }

        this._settings.set_string('source-path', path);
        if (path === previous)
            this.onChange?.(path);
        return path;
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearTimer();
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._settingIds = [];
    }

    destroy() {
        this.stop();
        this.onChange = null;
    }
}
