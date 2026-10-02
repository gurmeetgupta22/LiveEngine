import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RendererIpc} from './lib/ipc.js';
import {PowerMonitor} from './lib/power.js';
import {WindowMonitor} from './lib/windows.js';
import {Playlist} from './lib/playlist.js';
import {RendererProcess} from './lib/manager.js';
import {LiveEngineIndicator} from './lib/indicator.js';
import * as Log from './lib/logger.js';

export default class LiveEngineExtension extends Extension {
    enable() {
        this._gdmSkipped = false;
        if (Main.sessionMode.currentMode === 'gdm' || Main.sessionMode.isGreeter) {
            this._gdmSkipped = true;
            return;
        }

        this._settings = this.getSettings();
        this._timeouts = [];
        this._settingIds = [];
        this._sleepId = 0;
        this._sessionId = 0;
        this._suspended = false;
        this._ipcReady = false;

        this._ipc = new RendererIpc();
        this._process = new RendererProcess(this);
        this._power = new PowerMonitor();
        this._windows = new WindowMonitor();
        this._playlist = new Playlist(this._settings);

        this._process.onCrashExhausted = () => {
            Main.notify(
                _('LiveEngine'),
                _('The wallpaper renderer crashed repeatedly and was stopped.')
            );
        };

        this._ipc.onReady = () => this._onRendererReady();
        this._ipc.onError = message => {
            Log.error(message);
            Main.notify(_('LiveEngine'), message);
        };
        this._ipc.onHasAudioChanged = () => this._syncPlayback();
        this._ipc.onNameVanished = () => {
            this._ipcReady = false;
        };

        this._power.onChanged = () => this._syncPlayback();
        this._windows.onChanged = () => this._syncPlayback();
        this._playlist.onChange = path => this._applySource(path);

        this._bindSettings();
        this._connectSession();
        this._connectSleep();

        this._indicator = new LiveEngineIndicator(this, this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        const delay = this._settings.get_int('startup-delay-ms');
        this._addTimeout(Math.max(0, delay), () => {
            this._ipc.watch();
            this._process.start();
            this._power.start();
            this._windows.start();
            this._playlist.start();
        });
    }

    /**
     * unlock-dialog is required so the live wallpaper can stay mapped behind
     * GNOME's lock screen and unlock dialog. disable() still tears down every
     * signal, timeout, D-Bus watch, and the renderer subprocess.
     */
    disable() {
        if (this._gdmSkipped) {
            this._gdmSkipped = false;
            return;
        }

        this._clearTimeouts();
        this._disconnectSettings();

        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        if (this._sleepId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepId);
            this._sleepId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._playlist?.destroy();
        this._windows?.destroy();
        this._power?.destroy();
        this._playlist = null;
        this._windows = null;
        this._power = null;

        if (this._ipc?.ready)
            this._ipc.quit();
        this._ipc?.destroy();
        this._ipc = null;

        this._process?.destroy();
        this._process = null;
        this._settings = null;
        this._ipcReady = false;
    }

    next() {
        this._playlist?.next();
    }

    _bindSettings() {
        const reload = key => this._settings.connect(`changed::${key}`, () => this._pushSettings());
        for (const key of [
            'source-path', 'mute', 'volume', 'scale-mode', 'max-fps',
            'crossfade', 'crossfade-ms', 'user-paused', 'play-on-lock-screen',
            'pause-on-fullscreen', 'pause-when-covered', 'pause-on-low-battery',
            'battery-threshold', 'battery-only-discharging', 'show-indicator',
        ])
            this._settingIds.push(reload(key));
    }

    _disconnectSettings() {
        for (const id of this._settingIds)
            this._settings?.disconnect(id);
        this._settingIds = [];
    }

    _connectSession() {
        this._onSessionMode();
        this._sessionId = Main.sessionMode.connect('updated', () => this._onSessionMode());
    }

    _onSessionMode() {
        const locked = Main.sessionMode.currentMode === 'unlock-dialog' ||
            Main.sessionMode.isLocked;
        this._indicator?.setLocked(locked);
        this._syncPlayback();
    }

    _connectSleep() {
        this._sleepId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [goingToSleep] = params.deep_unpack();
                this._suspended = Boolean(goingToSleep);
                if (goingToSleep) {
                    this._ipc?.pause();
                } else {
                    this._addTimeout(800, () => this._syncPlayback());
                }
            }
        );
    }

    _onRendererReady() {
        this._ipcReady = true;
        this._process.noteHealthy();
        this._pushSettings();
        const path = this._settings.get_string('source-path') || this._playlist.current();
        if (path)
            this._applySource(path);
        this._syncPlayback();
    }

    _pushSettings() {
        if (!this._ipc?.ready)
            return;
        this._ipc.setMute(this._settings.get_boolean('mute'));
        this._ipc.setVolume(this._settings.get_int('volume') / 100);
        this._ipc.setScaleMode(this._settings.get_string('scale-mode'));
        this._ipc.setFps(this._settings.get_int('max-fps'));
        this._ipc.setCrossfade(
            this._settings.get_boolean('crossfade'),
            this._settings.get_int('crossfade-ms')
        );
        this._windows.pauseOnFullscreen = this._settings.get_boolean('pause-on-fullscreen');
        this._windows.pauseWhenCovered = this._settings.get_boolean('pause-when-covered');
        this._syncPlayback();
    }

    _applySource(path) {
        if (!path || !this._ipc?.ready)
            return;
        this._ipc.setSource(path);
        this._syncPlayback();
    }

    _syncPlayback() {
        if (!this._ipc?.ready)
            return;

        this._windows.pauseOnFullscreen = this._settings.get_boolean('pause-on-fullscreen');
        this._windows.pauseWhenCovered = this._settings.get_boolean('pause-when-covered');

        const locked = Main.sessionMode.currentMode === 'unlock-dialog' ||
            Main.sessionMode.isLocked;
        const pauseOnLock = locked && !this._settings.get_boolean('play-on-lock-screen');
        const userPaused = this._settings.get_boolean('user-paused');
        const batteryPaused = this._power.shouldPause(
            this._settings.get_boolean('pause-on-low-battery'),
            this._settings.get_int('battery-threshold'),
            this._settings.get_boolean('battery-only-discharging')
        );
        const pauseAll = userPaused || batteryPaused || pauseOnLock || this._suspended;

        if (pauseAll)
            this._ipc.pause();
        else
            this._ipc.resume();

        this._ipc.setPausedMonitors([]);
    }

    _addTimeout(ms, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts = this._timeouts.filter(item => item !== id);
            cb();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
        return id;
    }

    _clearTimeouts() {
        for (const id of this._timeouts)
            GLib.Source.remove(id);
        this._timeouts = [];
    }
}
