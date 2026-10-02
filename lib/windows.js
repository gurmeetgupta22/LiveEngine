import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function windowMonitorIndex(win) {
    if (typeof win.get_monitor === 'function')
        return win.get_monitor();
    return -1;
}

function isMaximized(win) {
    if (typeof win.is_maximized === 'function')
        return win.is_maximized();
    if (typeof win.get_maximized === 'function')
        return win.get_maximized() !== 0;
    return false;
}

function isInteresting(win) {
    if (!win)
        return false;
    if (win.is_override_redirect?.())
        return false;
    if (win.skip_taskbar)
        return false;
    const type = win.get_window_type();
    return type === Meta.WindowType.NORMAL;
}

function coversMonitor(win, monitorIndex, includeMaximized) {
    if (windowMonitorIndex(win) !== monitorIndex)
        return false;
    if (win.is_fullscreen())
        return true;
    return includeMaximized && isMaximized(win);
}

export class WindowMonitor {
    constructor() {
        this.onChanged = null;
        this._ids = [];
        this._windowIds = new Map();
        this.pauseOnFullscreen = false;
        this.pauseWhenCovered = false;
    }

    start() {
        this.stop();
        const display = global.display;
        this._ids.push([display, display.connect('notify::focus-window', () => this._emit())]);
        this._ids.push([display, display.connect('in-fullscreen-changed', () => this._emit())]);
        this._ids.push([display, display.connect('window-created', (_d, win) => this._trackWindow(win))]);
        this._ids.push([global.window_manager, global.window_manager.connect('switch-workspace', () => this._emit())]);

        const actors = global.get_window_actors();
        for (const actor of actors)
            this._trackWindow(actor.meta_window);

        this._emit();
    }

    _trackWindow(win) {
        if (!win || this._windowIds.has(win))
            return;

        const ids = [];
        const connect = (sig, cb) => {
            try {
                ids.push(win.connect(sig, cb));
            } catch {
                // Signal names differ slightly across Mutter versions.
            }
        };
        connect('unmanaged', () => {
            this._untrackWindow(win);
            this._emit();
        });
        connect('notify::fullscreen', () => this._emit());
        connect('notify::maximized-horizontally', () => this._emit());
        connect('notify::maximized-vertically', () => this._emit());
        connect('size-changed', () => this._emit());
        connect('position-changed', () => this._emit());
        this._windowIds.set(win, ids);
    }

    _untrackWindow(win) {
        const ids = this._windowIds.get(win);
        if (!ids)
            return;
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch {
                // Window already disposed.
            }
        }
        this._windowIds.delete(win);
    }

    pausedMonitors() {
        if (!this.pauseOnFullscreen && !this.pauseWhenCovered)
            return [];

        const paused = [];
        const monitors = Main.layoutManager.monitors;
        const actors = global.get_window_actors();
        for (const monitor of monitors) {
            const covered = actors.some(actor => {
                const win = actor.meta_window;
                return isInteresting(win) &&
                    coversMonitor(win, monitor.index, this.pauseWhenCovered);
            });
            if (covered)
                paused.push(monitor.index);
        }
        return paused;
    }

    _emit() {
        this.onChanged?.();
    }

    stop() {
        for (const [obj, id] of this._ids) {
            try {
                obj.disconnect(id);
            } catch {
                // Already disconnected.
            }
        }
        this._ids = [];
        for (const win of this._windowIds.keys())
            this._untrackWindow(win);
    }

    destroy() {
        this.stop();
        this.onChanged = null;
    }
}
