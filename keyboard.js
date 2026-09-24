import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { logWarn } from './logging.js';

export class Keyboard {
    #device = null;
    #contentPurpose;

    constructor () {
        try {
            let seat = Clutter.get_default_backend()?.get_default_seat();
            if (seat && typeof seat.create_virtual_device === 'function') {
                this.#device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
        } catch (e) {
            logWarn('Clipboard Indicator: failed to create virtual keyboard device', e);
        }

        try {
            Main.inputMethod.connectObject('notify::content-purpose', (method) => {
                this.#contentPurpose = method.content_purpose;
            }, this);
        } catch (e) {
            logWarn('Clipboard Indicator: failed to connect inputMethod notify', e);
        }
    }

    destroy () {
        try {
            Main.inputMethod.disconnectObject(this);
        } catch (e) {}
        if (this.#device) {
            // Just drop the reference: the virtual keyboard device was created
            // via seat.create_virtual_device() and is owned by the seat/backend,
            // so releasing our reference finalizes it (EGO-X-003: extension code
            // must not call run_dispose()).
            this.#device = null;
        }
    }

    #notify (key, state) {
        if (!this.#device) return;
        try {
            this.#device.notify_keyval(
                Clutter.get_current_event_time() * 1000,
                key,
                state
            );
        } catch (e) {
            logWarn('Clipboard Indicator: notify_keyval failed', e);
        }
    }

    get purpose () {
        return this.#contentPurpose;
    }

    press (key) {
        this.#notify(key, Clutter.KeyState.PRESSED);
    }

    release (key) {
        this.#notify(key, Clutter.KeyState.RELEASED);
    }
}
