import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

/**
 * Message-tray bridge for the indicator's transient notifications.
 * Extracted from extension.js: owns the single MessageTray.Source (created
 * lazily, destroyed with the indicator) and the recycling of one transient
 * notification — so a burst of copies updates the same banner instead of
 * stacking copies in the tray.
 *
 * The class is deliberately dumb about state: private-mode gating reads a
 * live getter (the private-mode flag is a module-level `let` toggled by the
 * menu item), and the indicator attaches notification actions (e.g. the
 * "Cancel copy" that rewrites the clipboard) through `transformFn`.
 */
export class NotificationSource {
    constructor({
        iconName,
        isPrivateMode = () => false,
    }) {
        this._iconName = iconName;
        this._isPrivateMode = isPrivateMode;
        this._source = null;
    }

    // Show a transient notification (or recycle the current one), skipping
    // quietly under private mode / Do-Not-Disturb.
    show(message, transformFn = null) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (this._isPrivateMode() || dndOn()) {
            return;
        }

        this._ensureSource();

        let notification = null;

        if (this._source.count === 0) {
            notification = new MessageTray.Notification({
                source: this._source,
                body: message,
                'is-transient': true
            });
        } else {
            notification = this._source.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        this._source.addNotification(notification);
    }

    destroy() {
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    }

    _ensureSource() {
        if (this._source) return;

        this._source = new MessageTray.Source({
            title: 'Clipboard Indicator',
            'icon-name': this._iconName
        });

        this._source.connect('destroy', () => {
            this._source = null;
        });

        Main.messageTray.add(this._source);
    }
}