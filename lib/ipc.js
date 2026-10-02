import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, IFACE_XML, OBJECT_PATH} from './const.js';
import * as Log from './logger.js';

const RendererProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

export class RendererIpc {
    constructor() {
        this._proxy = null;
        this._signalIds = [];
        this._watchId = 0;
        this._ready = false;
        this.onReady = null;
        this.onError = null;
        this.onHasAudioChanged = null;
        this.onNameVanished = null;
    }

    watch() {
        this.unwatch();
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            this._onAppeared.bind(this),
            this._onVanished.bind(this)
        );
    }

    unwatch() {
        this._disconnectProxy();
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._ready = false;
    }

    get ready() {
        return this._ready && this._proxy !== null;
    }

    _onAppeared() {
        this._disconnectProxy();
        try {
            this._proxy = new RendererProxy(
                Gio.DBus.session,
                BUS_NAME,
                OBJECT_PATH,
                (proxy, err) => {
                    if (err) {
                        Log.error(`D-Bus proxy failed: ${err.message}`);
                        this._proxy = null;
                        return;
                    }
                    this._proxy = proxy;
                    this._connectSignals();
                    this._ready = true;
                    this.onReady?.();
                }
            );
        } catch (e) {
            Log.error(`D-Bus proxy exception: ${e.message}`);
        }
    }

    _onVanished() {
        this._ready = false;
        this._disconnectProxy();
        this.onNameVanished?.();
    }

    _connectSignals() {
        const connect = (name, cb) => {
            const id = this._proxy.connectSignal(name, cb);
            this._signalIds.push(id);
        };
        connect('Error', (_p, _sender, params) => {
            const message = params[0];
            this.onError?.(message);
        });
        connect('Ready', () => this.onReady?.());
        connect('HasAudioChanged', (_p, _sender, params) => {
            this.onHasAudioChanged?.(params[0]);
        });
    }

    _disconnectProxy() {
        if (this._proxy) {
            for (const id of this._signalIds) {
                try {
                    this._proxy.disconnectSignal(id);
                } catch {
                    // Proxy may already be gone with the name owner.
                }
            }
        }
        this._signalIds = [];
        this._proxy = null;
    }

    _call(method, parameters = null, timeoutMs = 4000) {
        if (!this._proxy)
            return;

        this._proxy.call(
            method,
            parameters,
            Gio.DBusCallFlags.NO_AUTO_START,
            timeoutMs,
            null,
            (_proxy, result) => {
                try {
                    this._proxy?.call_finish(result);
                } catch (e) {
                    Log.warn(`${method} failed: ${e.message}`);
                }
            }
        );
    }

    play() {
        this._call('Play');
    }

    pause() {
        this._call('Pause');
    }

    resume() {
        this._call('Resume');
    }

    quit() {
        this._call('Quit', null, 1500);
    }

    setSource(path) {
        this._call('SetSource', new GLib.Variant('(s)', [path]));
    }

    setMute(mute) {
        this._call('SetMute', new GLib.Variant('(b)', [mute]));
    }

    setVolume(volume01) {
        this._call('SetVolume', new GLib.Variant('(d)', [volume01]));
    }

    setScaleMode(mode) {
        this._call('SetScaleMode', new GLib.Variant('(s)', [mode]));
    }

    setFps(fps) {
        this._call('SetFps', new GLib.Variant('(i)', [fps]));
    }

    setCrossfade(enabled, durationMs) {
        this._call('SetCrossfade', new GLib.Variant('(bi)', [enabled, durationMs]));
    }

    setPausedMonitors(indexes) {
        this._call('SetPausedMonitors', new GLib.Variant('(ai)', [indexes]));
    }

    destroy() {
        this.unwatch();
        this.onReady = null;
        this.onError = null;
        this.onHasAudioChanged = null;
        this.onNameVanished = null;
    }
}
