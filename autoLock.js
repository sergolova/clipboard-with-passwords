import Gio from 'gi://Gio';
import { logWarn } from './logging.js';

/**
 * Subscribes to the OS signals that gate the password vault's auto-lock and
 * routes them to a single callback:
 *
 * - `org.gnome.ScreenSaver` "Locked" — session bus (compatibility interface,
 *   works on both X11 and Wayland);
 * - `org.freedesktop.login1.Manager` "PrepareForSleep" — system bus.
 *
 * Only the D-Bus plumbing lives here (connect/disconnect lifecycle). WHAT each
 * cause does to the vault — whether a plain screen lock or only a real
 * suspend requires the master password again — is the policy of the indicator
 * class (`_autoLockVault(cause)`), passed in as `onAutoLock`.
 */
export class AutoLockManager {
    constructor({onAutoLock}) {
        this._onAutoLock = onAutoLock;
        this._screenSaverProxy = null;
        this._screenSaverSignalId = null;
        this._login1Proxy = null;
        this._login1SignalId = null;
    }

    enable() {
        // Screen lock: gnome-shell exposes org.gnome.ScreenSaver on the
        // session bus for compatibility (works on X11 and Wayland).
        try {
            const iface = '<node><interface name="org.gnome.ScreenSaver"><signal name="Locked"/></interface></node>';
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                iface,
                null
            );
            if (proxy) {
                this._screenSaverProxy = proxy;
                this._screenSaverSignalId = proxy.connectSignal('Locked',
                    () => this._onAutoLock('screen-lock'));
            }
        } catch (e) {
            logWarn('Clipboard Indicator: cannot subscribe to screen lock:', e);
        }

        // Suspend / resume (system bus, requires a non-sandboxed extension).
        try {
            const iface = '<node><interface name="org.freedesktop.login1.Manager"><signal name="PrepareForSleep"><arg type="b"/></signal></interface></node>';
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                iface,
                null
            );
            if (proxy) {
                this._login1Proxy = proxy;
                this._login1SignalId = proxy.connectSignal('PrepareForSleep',
                    (proxy, senderName, signalName, parameters) => {
                        const sleeping = parameters && parameters[0] === true;
                        if (sleeping) {
                            this._onAutoLock('sleep');
                        }
                    }
                );
            }
        } catch (e) {
            logWarn('Clipboard Indicator: cannot subscribe to suspend:', e);
        }
    }

    disable() {
        if (this._screenSaverProxy && this._screenSaverSignalId) {
            try {
                this._screenSaverProxy.disconnectSignal(this._screenSaverSignalId);
            } catch (e) {
            }
        }
        if (this._login1Proxy && this._login1SignalId) {
            try {
                this._login1Proxy.disconnectSignal(this._login1SignalId);
            } catch (e) {
            }
        }
        this._screenSaverProxy = null;
        this._login1Proxy = null;
        this._screenSaverSignalId = null;
        this._login1SignalId = null;
    }
}