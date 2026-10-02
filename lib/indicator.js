import GObject from 'gi://GObject';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const LiveEngineToggle = GObject.registerClass(
class LiveEngineToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, controller) {
        super._init({
            title: 'LiveEngine',
            iconName: 'folder-videos-symbolic',
            toggleMode: true,
        });
        this._extension = extension;
        this._controller = controller;
        this._settings = extension.getSettings();

        this.menu.setHeader('folder-videos-symbolic', 'LiveEngine', _('Live wallpaper'));

        this._items = new PopupMenu.PopupMenuSection();
        this._nextItem = this._items.addAction(_('Next wallpaper'), () => controller.next());
        this._muteItem = this._items.addAction(_('Mute audio'), () => {
            const mute = !this._settings.get_boolean('mute');
            this._settings.set_boolean('mute', mute);
        });
        this.menu.addMenuItem(this._items);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.menu.addAction(_('LiveEngine Settings'), () => {
            extension.openPreferences();
        });
        settingsItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = settingsItem;

        this._bind();
        this.connect('clicked', () => {
            const paused = !this.checked;
            this._settings.set_boolean('user-paused', paused);
        });
        this.connect('destroy', () => {
            if (this._checkedId)
                this._settings.disconnect(this._checkedId);
            if (this._muteId)
                this._settings.disconnect(this._muteId);
            this._checkedId = 0;
            this._muteId = 0;
        });
    }

    _bind() {
        this._checkedId = this._settings.connect('changed::user-paused', () => this._sync());
        this._muteId = this._settings.connect('changed::mute', () => this._sync());
        this._sync();
    }

    _sync() {
        const paused = this._settings.get_boolean('user-paused');
        this.checked = !paused;
        this.subtitle = this._settings.get_boolean('mute')
            ? _('Audio muted')
            : (paused ? _('Paused') : _('Playing'));
        this._muteItem.label.text = this._settings.get_boolean('mute')
            ? _('Unmute audio')
            : _('Mute audio');
    }
});

export const LiveEngineIndicator = GObject.registerClass(
class LiveEngineIndicator extends QuickSettings.SystemIndicator {
    _init(extension, controller) {
        super._init();
        this._extension = extension;
        this._settings = extension.getSettings();
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'folder-videos-symbolic';

        this._toggle = new LiveEngineToggle(extension, controller);
        this.quickSettingsItems.push(this._toggle);

        this._visId = this._settings.connect('changed::show-indicator', () => this._syncVisible());
        this._syncVisible();
        this.connect('destroy', () => {
            if (this._visId)
                this._settings.disconnect(this._visId);
            this._visId = 0;
            this.quickSettingsItems.forEach(item => item.destroy());
        });
    }

    _syncVisible() {
        const show = this._settings.get_boolean('show-indicator');
        const locked = Main.sessionMode.currentMode === 'unlock-dialog' ||
            Main.sessionMode.isLocked;
        this._indicator.visible = show && !locked;
        this.visible = this._indicator.visible;
    }

    setLocked(locked) {
        this._toggle.visible = !locked;
        this._syncVisible();
    }
});
