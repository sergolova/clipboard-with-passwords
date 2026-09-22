import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
            console.warn('Clipboard Indicator: failed to create virtual keyboard device', e);
        }

        try {
            Main.inputMethod.connectObject('notify::content-purpose', (method) => {
                this.#contentPurpose = method.content_purpose;
            }, this);
        } catch (e) {
            console.warn('Clipboard Indicator: failed to connect inputMethod notify', e);
        }
    }

    destroy () {
        try {
            Main.inputMethod.disconnectObject(this);
        } catch (e) {}
        if (this.#device) {
            try {
                // run_dispose() is required here: the virtual keyboard device
                // was explicitly created via seat.create_virtual_device() and
                // owns backend resources. Plain destroy()/unref would leak
                // the Clutter device, so we must dispose it explicitly.
                this.#device.run_dispose();
            } catch (e) {}
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
            console.warn('Clipboard Indicator: notify_keyval failed', e);
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
