import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {RENDERER_APP_ID, WINDOW_TITLE_PREFIX} from './const.js';
import * as Log from './logger.js';

function isRendererWindow(win) {
    if (!win)
        return false;
    const title = win.get_title?.() ?? '';
    if (title.startsWith(WINDOW_TITLE_PREFIX))
        return true;
    const gtkId = win.get_gtk_application_id?.();
    if (gtkId === RENDERER_APP_ID)
        return true;
    const wmClass = (win.get_wm_class?.() || '').toLowerCase();
    return wmClass.includes('liveengine');
}

function setDesktopWindow(win, waylandClient) {
    try {
        if (typeof win.unmake_fullscreen === 'function')
            win.unmake_fullscreen();
    } catch (e) {
        Log.warn(`unmake_fullscreen failed: ${e.message}`);
    }

    try {
        if (waylandClient?.owns_window?.(win)) {
            if (typeof win.set_type === 'function')
                win.set_type(Meta.WindowType.DESKTOP);
            else if (typeof waylandClient.make_desktop === 'function')
                waylandClient.make_desktop(win);
        } else if (typeof win.set_type === 'function') {
            win.set_type(Meta.WindowType.DESKTOP);
        }
    } catch (e) {
        Log.warn(`set_type DESKTOP failed: ${e.message}`);
    }

    try {
        if (typeof win.hide_from_window_list === 'function')
            win.hide_from_window_list();
        else if (typeof waylandClient?.hide_from_window_list === 'function')
            waylandClient.hide_from_window_list(win);
    } catch (e) {
        Log.warn(`hide_from_window_list failed: ${e.message}`);
    }

    try {
        win.stick();
    } catch {
        // Not all window types can stick.
    }

    try {
        win.make_above = false;
    } catch {
        // Property may be read-only.
    }
}

function reparentToBackground(win) {
    const actor = win.get_compositor_private();
    const group = Main.layoutManager._backgroundGroup;
    if (!actor || !group)
        return;

    const parent = actor.get_parent();
    try {
        if (parent === group) {
            group.set_child_above_sibling(actor, null);
        } else {
            parent?.remove_child(actor);
            group.add_child(actor);
        }
        actor.reactive = false;
    } catch (e) {
        Log.warn(`reparent failed: ${e.message}`);
    }
}

function positionOnMonitor(win) {
    const actor = win.get_compositor_private();
    if (!actor)
        return;
    const index = typeof win.get_monitor === 'function' ? win.get_monitor() : 0;
    const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.monitors[0];
    if (!monitor)
        return;
    actor.set_position(monitor.x, monitor.y);
    actor.set_size(monitor.width, monitor.height);
}

export class WallpaperWindows {
    constructor() {
        this._waylandClient = null;
        this._createdId = 0;
        this._focusId = 0;
        this._monitorsId = 0;
        this._managed = new Set();
        this._searchId = 0;
        this._layoutId = 0;
        this._stockBackgroundActors = new Map();
    }

    setWaylandClient(client) {
        this._waylandClient = client;
    }

    start() {
        this.stop();
        this._createdId = global.display.connect('window-created', (_d, win) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._claim(win);
                this._scheduleScan();
                this._scheduleLayout();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._focusId = global.display.connect('notify::focus-window', () => {
            this._scheduleLayout();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._scheduleScan();
        });
        this._scan();
    }

    _scheduleScan() {
        if (this._searchId)
            GLib.Source.remove(this._searchId);
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._searchId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleLayout() {
        if (this._layoutId)
            GLib.Source.remove(this._layoutId);
        this._layoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutId = 0;
            for (const win of this._managed)
                this._layout(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const actors = global.get_window_actors();
        Log.debug(`Scanning ${actors.length} window actors`);
        for (const actor of actors)
            this._claim(actor.meta_window);
        for (const win of this._managed)
            this._layout(win);
        this._hideStockBackground();
    }

    _hideStockBackground() {
        const group = Main.layoutManager._backgroundGroup;
        if (!group)
            return;
        for (const actor of group.get_children()) {
            if (this._managed.has(actor.meta_window))
                continue;
            if (!this._stockBackgroundActors.has(actor))
                this._stockBackgroundActors.set(actor, actor.visible);
            actor.hide();
        }
    }

    _restoreStockBackground() {
        for (const [actor, visible] of this._stockBackgroundActors) {
            if (visible)
                actor.show();
        }
        this._stockBackgroundActors.clear();
    }

    _claim(win) {
        const title = win.get_title?.() ?? '';
        const gtkId = win.get_gtk_application_id?.();
        const wmClass = win.get_wm_class?.() || '';
        const isOurs = isRendererWindow(win);
        const isOwned = this._owned(win);
        Log.warn(`Window check: title="${title}" gtkId="${gtkId}" wmClass="${wmClass}" isOurs=${isOurs} isOwned=${isOwned}`);
        if (!isOurs && !isOwned)
            return;
        Log.warn(`Claiming window: ${title}`);
        if (this._managed.has(win)) {
            this._layout(win);
            return;
        }
        this._managed.add(win);
        try {
            win.connect('unmanaged', () => this._managed.delete(win));
        } catch {
            // ignore
        }
        this._layout(win);
    }

    _owned(win) {
        try {
            const owned = Boolean(this._waylandClient?.owns_window?.(win));
            if (owned) Log.debug(`Window ${win.get_title?.() ?? 'no-title'} is owned by WaylandClient`);
            return owned;
        } catch {
            return false;
        }
    }

    _layout(win) {
        Log.warn(`Laying out window: ${win.get_title?.() ?? 'no-title'}`);
        setDesktopWindow(win, this._waylandClient);
        reparentToBackground(win);
        positionOnMonitor(win);
    }

    stop() {
        if (this._createdId) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._searchId) {
            GLib.Source.remove(this._searchId);
            this._searchId = 0;
        }
        if (this._layoutId) {
            GLib.Source.remove(this._layoutId);
            this._layoutId = 0;
        }
        this._managed.clear();
        this._restoreStockBackground();
        this._waylandClient = null;
    }

    destroy() {
        this.stop();
    }
}

function findRendererScript(extensionDir) {
    const script = extensionDir.get_child('renderer').get_child('liveengine-renderer.py');
    return script.get_path();
}

function applyHybridGpuEnv(launcher) {
    launcher.setenv('__NV_PRIME_RENDER_OFFLOAD', '0', true);
    launcher.setenv('__GLX_VENDOR_LIBRARY_NAME', 'mesa', true);
    launcher.setenv('__VK_LAYER_NV_optimus', 'non_NVIDIA_only', true);
    launcher.setenv('CUDA_VISIBLE_DEVICES', '', true);
    launcher.setenv('GST_GL_PLATFORM', 'egl', false);
    const driver = GLib.getenv('LIBVA_DRIVER_NAME');
    if (driver && ['nvidia', 'nvdec', 'vdpau'].includes(driver.toLowerCase()))
        launcher.setenv('LIBVA_DRIVER_NAME', 'iHD', true);
}

function isWaylandSession() {
    return GLib.getenv('XDG_SESSION_TYPE') === 'wayland' ||
        Boolean(GLib.getenv('WAYLAND_DISPLAY'));
}

function makeLauncher(extension) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    applyHybridGpuEnv(launcher);
    const isWayland = isWaylandSession();
    launcher.setenv('GDK_BACKEND', isWayland ? 'wayland' : 'x11', true);
    launcher.set_cwd(extension.dir.get_path());
    return launcher;
}

export class RendererProcess {
    constructor(extension) {
        this._extension = extension;
        this._proc = null;
        this._waylandClient = null;
        this._crashes = 0;
        this._restartId = 0;
        this._waitCancellable = null;
        this._stopping = false;
        this.onCrashExhausted = null;
        this.windows = new WallpaperWindows();
    }

    get waylandClient() {
        return this._waylandClient;
    }

    start() {
        this.stop();
        this._stopping = false;
        this.windows.start();
        this._spawn();
    }

    _spawn() {
        const script = findRendererScript(this._extension.dir);
        const python = GLib.find_program_in_path('python3') || '/usr/bin/python3';
        const argv = [python, script];

        try {
            const isWayland = isWaylandSession();
            const canOwnClient = isWayland &&
                typeof Meta.WaylandClient?.new_subprocess === 'function' &&
                global.context;
            Log.debug(`Spawning renderer: isWayland=${isWayland}, canOwnClient=${canOwnClient}, hasNewSubprocess=${typeof Meta.WaylandClient?.new_subprocess === 'function'}, hasContext=${!!global.context}`);
            if (canOwnClient) {
                try {
                    this._waylandClient = Meta.WaylandClient.new_subprocess(
                        global.context,
                        makeLauncher(this._extension),
                        argv
                    );
                    this._proc = this._waylandClient.get_subprocess();
                    Log.debug('WaylandClient spawn succeeded');
                } catch (e) {
                    Log.warn(`WaylandClient spawn failed, using Gio.Subprocess: ${e.message}`);
                    this._waylandClient = null;
                }
            }
            if (!this._proc) {
                this._proc = makeLauncher(this._extension).spawnv(argv);
                Log.debug('Gio.Subprocess spawn used');
            }
        } catch (e) {
            Log.error(`Failed to start renderer: ${e.message}`);
            this._scheduleRestart();
            return;
        }

        this.windows.setWaylandClient(this._waylandClient);
        this._waitCancellable = new Gio.Cancellable();
        const proc = this._proc;
        proc.communicate_utf8_async(null, this._waitCancellable, (_proc, result) => {
            let output;
            try {
                output = proc.communicate_utf8_finish(result);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                Log.warn(`Could not read renderer output: ${e.message}`);
            }
            if (output?.[1])
                Log.debug(`Renderer stdout: ${output[1].trim()}`);
            if (output?.[2])
                Log.error(`Renderer stderr: ${output[2].trim()}`);
            const status = proc.get_status?.() ?? 1;
            Log.warn(`Renderer exited with status ${status}`);
            if (this._proc === proc) {
                this._proc = null;
                this._waylandClient = null;
                this.windows.setWaylandClient(null);
            }
            if (!this._stopping)
                this._scheduleRestart();
        });
    }

    _scheduleRestart() {
        if (this._stopping || this._restartId)
            return;
        this._crashes += 1;
        if (this._crashes > 3) {
            this.onCrashExhausted?.();
            return;
        }
        const delay = Math.min(8000, 750 * (2 ** (this._crashes - 1)));
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    noteHealthy() {
        this._crashes = 0;
    }

    stop() {
        this._stopping = true;
        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }
        this._waitCancellable?.cancel();
        this._waitCancellable = null;
        if (this._proc) {
            try {
                this._proc.send_signal(15);
            } catch {
                try {
                    this._proc.force_exit();
                } catch (e) {
                    Log.warn(`force_exit: ${e.message}`);
                }
            }
        }
        this._proc = null;
        this._waylandClient = null;
        this.windows.stop();
    }

    destroy() {
        this.stop();
        this.windows.destroy();
        this.onCrashExhausted = null;
    }
}
