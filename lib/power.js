import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Log from './logger.js';

const UPOWER_NAME = 'org.freedesktop.UPower';
const DISPLAY_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const PROPS = 'org.freedesktop.DBus.Properties';
const DEVICE_IFACE = 'org.freedesktop.UPower.Device';

// UPower Device.Type: 2 = Battery, 1 = Line Power
const TYPE_BATTERY = 2;
// UPower Device.State: 1 = Charging, 2 = Discharging, 4 = Fully charged, 5 = Pending charge
const STATE_CHARGING = 1;
const STATE_FULL = 4;
const STATE_PENDING_CHARGE = 5;

export class PowerMonitor {
    constructor() {
        this.available = false;
        this.percentage = 100;
        this.state = 0;
        this.onChanged = null;
        this._subId = 0;
        this._cancellable = new Gio.Cancellable();
    }

    start() {
        Gio.DBus.system.call(
            UPOWER_NAME,
            DISPLAY_PATH,
            PROPS,
            'GetAll',
            new GLib.Variant('(s)', [DEVICE_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            3000,
            this._cancellable,
            (conn, result) => {
                try {
                    const reply = conn.call_finish(result);
                    const [props] = reply.deep_unpack();
                    this._apply(props);
                } catch (e) {
                    Log.warn(`UPower unavailable: ${e.message}`);
                    this.available = false;
                    this.onChanged?.();
                    return;
                }
                this._subscribe();
            }
        );
    }

    _subscribe() {
        this._subId = Gio.DBus.system.signal_subscribe(
            UPOWER_NAME,
            PROPS,
            'PropertiesChanged',
            DISPLAY_PATH,
            DEVICE_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [_ifaceName, changed] = params.deep_unpack();
                this._apply(changed, false);
            }
        );
    }

    _apply(props, replaceAvailability = true) {
        const read = (key, fallback) => {
            if (!(key in props))
                return fallback;
            const variant = props[key];
            return variant?.deep_unpack?.() ?? variant;
        };

        const type = read('Type', this.available ? TYPE_BATTERY : 0);
        const present = read('IsPresent', true);
        const percentage = read('Percentage', this.percentage);
        const state = read('State', this.state);

        if (replaceAvailability || type)
            this.available = Number(type) === TYPE_BATTERY && Boolean(present);

        this.percentage = Number(percentage);
        this.state = Number(state);
        this.onChanged?.();
    }

    isCharging() {
        return this.state === STATE_CHARGING ||
            this.state === STATE_FULL ||
            this.state === STATE_PENDING_CHARGE;
    }

    shouldPause(enabled, threshold, onlyDischarging) {
        if (!enabled || !this.available)
            return false;
        if (onlyDischarging && this.isCharging())
            return false;
        return this.percentage <= threshold;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._subId) {
            Gio.DBus.system.signal_unsubscribe(this._subId);
            this._subId = 0;
        }
        this.onChanged = null;
    }
}
