import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { logWarn } from './logging.js';

export class DialogManager {
    #openDialog;

    open (title, message, sub_message, ok_label, cancel_label, callback) {
        if (this.#openDialog) return;
        this.#openDialog = new ConfirmDialog(title, message + "\n" + sub_message, ok_label, cancel_label, callback);
        this.#openDialog.onFinish = () => this.#openDialog = null;
        this.#openDialog.open();
    }

    // Promise-based confirm: resolves `true` when the user picks the OK
    // action, `false` on Cancel / Escape. The single-open-dialog policy from
    // open() is kept; if a dialog is already open a second confirm cannot
    // appear and resolves `false` (the caller treats it as "declined" — never
    // let a confirmation be silently skipped, so this is logged as well).
    openConfirm (title, message, sub_message, ok_label, cancel_label) {
        if (this.#openDialog) {
            logWarn('Confirm dialog skipped: another dialog is already open.');
            return Promise.resolve(false);
        }
        return new Promise(resolve => {
            const dialog = new ConfirmDialog(
                title, message + "\n" + sub_message, ok_label, cancel_label,
                () => {
                    resolve(true);
                });
            // Cancel / Escape closes the dialog without running the callback:
            // resolve `false` from the 'closed' signal. When the OK path runs
            // first the promise is already resolved and this is a no-op.
            dialog.connect('closed', () => {
                resolve(false);
            });
            this.#openDialog = dialog;
            dialog.onFinish = () => this.#openDialog = null;
            dialog.open();
        });
    }

    destroy () {
        if (this.#openDialog) this.#openDialog.destroy();
        this.#openDialog = null;
    }
}

const ConfirmDialog = GObject.registerClass(
  {GTypeName: 'ClipboardWithPasswordsConfirmDialog'},
  class ConfirmDialog extends ModalDialog.ModalDialog {

    _init(title, desc, ok_label, cancel_label, callback) {
      super._init();

      let main_box = new St.BoxLayout({
        vertical: false
      });
      this.contentLayout.add_child(main_box);

      let message_box = new St.BoxLayout({
        vertical: true
      });
      main_box.add_child(message_box);

      let subject_label = new St.Label({
        style: 'font-weight: bold',
        x_align: Clutter.ActorAlign.CENTER,
        text: title
      });
      message_box.add_child(subject_label);

      let desc_label = new St.Label({
        style: 'padding-top: 12px',
        x_align: Clutter.ActorAlign.CENTER,
        text: desc
      });
      message_box.add_child(desc_label);

      this.setButtons([
        {
          label: cancel_label,
          action: () => {
            this.close();
            this.onFinish();
          },
          key: Clutter.Escape
        },
        {
          label: ok_label,
          action: () => {
            this.close();
            this.onFinish();
            callback();
          }
        }
      ]);
    }
  }
);
