import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MEDIA_SUFFIXES} from './lib/const.js';

function scaleModes() {
    return [
        {id: 'fill', label: _('Fill')},
        {id: 'fit', label: _('Fit')},
        {id: 'stretch', label: _('Stretch')},
        {id: 'center', label: _('Center')},
    ];
}

function orderModes() {
    return [
        {id: 'sequential', label: _('Sequential')},
        {id: 'shuffle', label: _('Shuffle')},
    ];
}

function bindSwitch(settings, key, row) {
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
}

function addCombo(group, settings, key, title, subtitle, items) {
    const model = new Gtk.StringList();
    for (const item of items)
        model.append(item.label);
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model,
    });
    const current = settings.get_string(key);
    row.selected = Math.max(0, items.findIndex(item => item.id === current));
    row.connect('notify::selected', () => {
        const item = items[row.selected];
        if (item)
            settings.set_string(key, item.id);
    });
    group.add(row);
    return row;
}

function addSpin(group, settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step,
            value: settings.get_int(key),
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function looksLikeMedia(path) {
    const lower = path.toLowerCase();
    return MEDIA_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

function validatePath(path) {
    if (!path)
        return [_('No file selected'), false];
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return [_('File not found'), false];
    try {
        const info = file.query_info(
            'standard::content-type,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        if (info.get_size() <= 0)
            return [_('File is empty'), false];
        const type = info.get_content_type() || '';
        const okType = type.startsWith('video/') || type === 'image/gif' || looksLikeMedia(path);
        if (!okType)
            return [_('Unsupported type. Use MP4, WebM, MKV, MOV, or GIF.'), false];
    } catch (e) {
        return [e.message, false];
    }
    return [_('Ready'), true];
}

const FileRow = GObject.registerClass(
class FileRow extends Adw.ActionRow {
    _init(settings, window) {
        super._init({
            title: _('Wallpaper file'),
            subtitle: settings.get_string('source-path') || _('None selected'),
        });
        this._settings = settings;
        this._window = window;

        const button = new Gtk.Button({
            label: _('Choose…'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._open());
        this.add_suffix(button);
        this.set_activatable_widget(button);

        this._id = settings.connect('changed::source-path', () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._id));
        this._sync();
    }

    _sync() {
        const path = this._settings.get_string('source-path');
        const [message, ok] = validatePath(path);
        this.subtitle = path ? `${path}\n${message}` : message;
        this.css_classes = ok || !path ? [] : ['error'];
    }

    _open() {
        const dialog = new Gtk.FileDialog({title: _('Select a video or GIF')});
        const filter = new Gtk.FileFilter();
        filter.set_name(_('Videos and GIFs'));
        for (const mime of ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'image/gif'])
            filter.add_mime_type(mime);
        for (const suffix of MEDIA_SUFFIXES)
            filter.add_suffix(suffix.replace('.', ''));
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
        filters.append(filter);
        dialog.set_filters(filters);
        dialog.set_default_filter(filter);
        dialog.open(this._window, null, (_d, result) => {
            try {
                const file = dialog.open_finish(result);
                const path = file.get_path();
                const [message, ok] = validatePath(path);
                if (!ok) {
                    this._toast(message);
                    return;
                }
                this._settings.set_string('source-path', path);
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._toast(e.message);
            }
        });
    }

    _toast(text) {
        const toast = new Adw.Toast({title: text, timeout: 4});
        this._window.add_toast(toast);
    }
});

const FolderRow = GObject.registerClass(
class FolderRow extends Adw.ActionRow {
    _init(settings, window) {
        super._init({
            title: _('Playlist folder'),
            subtitle: settings.get_string('playlist-folder') || _('None selected'),
        });
        this._settings = settings;
        this._window = window;
        const button = new Gtk.Button({
            label: _('Choose…'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._open());
        this.add_suffix(button);
        this.set_activatable_widget(button);
        this._id = settings.connect('changed::playlist-folder', () => {
            this.subtitle = settings.get_string('playlist-folder') || _('None selected');
        });
        this.connect('destroy', () => settings.disconnect(this._id));
    }

    _open() {
        const dialog = new Gtk.FileDialog({title: _('Select a folder of videos')});
        dialog.select_folder(this._window, null, (_d, result) => {
            try {
                const file = dialog.select_folder_finish(result);
                this._settings.set_string('playlist-folder', file.get_path());
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
                    this._window.add_toast(new Adw.Toast({title: e.message}));
                }
            }
        });
    }
});

function probeBattery(callback) {
    Gio.DBus.system.call(
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower/devices/DisplayDevice',
        'org.freedesktop.DBus.Properties',
        'GetAll',
        new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']),
        new GLib.VariantType('(a{sv})'),
        Gio.DBusCallFlags.NONE,
        2000,
        null,
        (conn, result) => {
            try {
                const [props] = conn.call_finish(result).deep_unpack();
                const type = props.Type?.deep_unpack?.() ?? 0;
                const present = props.IsPresent?.deep_unpack?.() ?? false;
                callback(Number(type) === 2 && Boolean(present));
            } catch {
                callback(false);
            }
        }
    );
}

export default class LiveEnginePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window._settings = this.getSettings();
        const settings = window._settings;

        window.add(this._generalPage(window, settings));
        window.add(this._playlistPage(window, settings));
        window.add(this._powerPage(window, settings));
        window.add(this._audioPage(settings));
    }

    _generalPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const source = new Adw.PreferencesGroup({
            title: _('Source'),
            description: _('Choose a video (MP4, WebM) or an animated GIF. Playback starts after the shell has finished loading.'),
        });
        source.add(new FileRow(settings, window));
        page.add(source);

        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        addCombo(appearance, settings, 'scale-mode', _('Scale mode'),
            _('How the wallpaper is fitted to each monitor.'), scaleModes());
        const perMonitor = new Adw.SwitchRow({
            title: _('Same wallpaper on every monitor'),
            subtitle: _('LiveEngine always mirrors one decoded stream to every monitor. Per-file-per-monitor playlists are not used, so one decoder stays asleep on the iGPU.'),
            active: !settings.get_boolean('per-monitor'),
            sensitive: false,
        });
        appearance.add(perMonitor);
        const fade = new Adw.SwitchRow({
            title: _('Crossfade when changing wallpaper'),
            subtitle: _('Disable for an instant switch.'),
        });
        bindSwitch(settings, 'crossfade', fade);
        appearance.add(fade);
        addSpin(appearance, settings, 'crossfade-ms', _('Crossfade duration'),
            _('Milliseconds'), 0, 3000, 50);
        addSpin(appearance, settings, 'max-fps', _('Maximum frame rate'),
            _('Cap decoding to save power. 30 is a good default.'), 5, 60, 1);
        page.add(appearance);

        const startup = new Adw.PreferencesGroup({title: _('Startup')});
        addSpin(startup, settings, 'startup-delay-ms', _('Start delay'),
            _('Extra wait after GNOME Shell finishes starting. LiveEngine already waits for startup-complete so it does not fight other extensions at login.'), 0, 10000, 100);
        const indicator = new Adw.SwitchRow({
            title: _('Show Quick Settings tile'),
            subtitle: _('Pause, next wallpaper, and mute from the system menu.'),
        });
        bindSwitch(settings, 'show-indicator', indicator);
        startup.add(indicator);
        page.add(startup);
        return page;
    }

    _playlistPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Playlist'),
            icon_name: 'view-list-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Auto-changing wallpapers'),
            description: _('Pick a folder of videos/GIFs or keep using the current file plus any explicit playlist.'),
        });
        const auto = new Adw.SwitchRow({
            title: _('Auto change wallpaper'),
            subtitle: _('Advance on a timer. The timer is destroyed when the extension is disabled.'),
        });
        bindSwitch(settings, 'auto-change', auto);
        group.add(auto);
        addSpin(group, settings, 'interval-minutes', _('Interval'),
            _('1–15 minutes. Changes apply immediately.'), 1, 15, 1);
        addCombo(group, settings, 'playlist-order', _('Order'),
            _('Shuffle reshuffles after a full pass and avoids restarting the extension.'), orderModes());
        group.add(new FolderRow(settings, window));
        page.add(group);
        return page;
    }

    _powerPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Power'),
            icon_name: 'power-profile-power-saver-symbolic',
        });

        const lock = new Adw.PreferencesGroup({
            title: _('Lock screen'),
            description: _('LiveEngine declares session-modes user + unlock-dialog so the renderer can remain mapped behind the lock screen. Mutter still draws the unlock dialog on top.'),
        });
        const playLock = new Adw.SwitchRow({
            title: _('Play on lock screen'),
            subtitle: _('Turn off to pause the pipeline while locked and save battery.'),
        });
        bindSwitch(settings, 'play-on-lock-screen', playLock);
        lock.add(playLock);
        page.add(lock);

        const fullscreen = new Adw.PreferencesGroup({title: _('Fullscreen')});
        const pauseFs = new Adw.SwitchRow({
            title: _('Pause when an app is fullscreen'),
            subtitle: _('Per monitor. Other displays keep playing unless they are also fullscreen.'),
        });
        bindSwitch(settings, 'pause-on-fullscreen', pauseFs);
        fullscreen.add(pauseFs);
        const covered = new Adw.SwitchRow({
            title: _('Pause when wallpaper is fully covered'),
            subtitle: _('Also pause when a maximized window covers that monitor.'),
        });
        bindSwitch(settings, 'pause-when-covered', covered);
        fullscreen.add(covered);
        page.add(fullscreen);

        const battery = new Adw.PreferencesGroup({
            title: _('Battery'),
            description: _('Uses org.freedesktop.UPower DisplayDevice. Hidden automatically on desktops without a battery.'),
        });
        const pauseBat = new Adw.SwitchRow({
            title: _('Pause when battery is low'),
        });
        bindSwitch(settings, 'pause-on-low-battery', pauseBat);
        battery.add(pauseBat);
        const threshold = addSpin(battery, settings, 'battery-threshold',
            _('Low-battery threshold'), _('Percent'), 5, 50, 1);
        const discharging = new Adw.SwitchRow({
            title: _('Only apply when not charging'),
        });
        bindSwitch(settings, 'battery-only-discharging', discharging);
        battery.add(discharging);
        page.add(battery);

        probeBattery(hasBattery => {
            battery.visible = hasBattery;
            if (!hasBattery) {
                pauseBat.sensitive = false;
                threshold.sensitive = false;
                discharging.sensitive = false;
            }
        });
        return page;
    }

    _audioPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Audio'),
            icon_name: 'audio-volume-high-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Wallpaper audio'),
            description: _('Mute is on by default. If a file has no audio track the renderer keeps these controls inert and never errors.'),
        });
        const mute = new Adw.SwitchRow({
            title: _('Mute wallpaper audio'),
        });
        bindSwitch(settings, 'mute', mute);
        group.add(mute);
        const volume = addSpin(group, settings, 'volume', _('Volume'),
            _('Used when unmuted. 0–100%.'), 0, 100, 1);
        const syncVolume = () => {
            volume.sensitive = !settings.get_boolean('mute');
        };
        settings.connect('changed::mute', syncVolume);
        syncVolume();
        page.add(group);
        return page;
    }
}
