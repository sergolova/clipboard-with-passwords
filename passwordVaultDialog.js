import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { generatePassword } from './passwordVault.js';
import { themeColors } from './theme.js';

// Button that inserts the CLIPBOARD text into `entry`:
// - if the entry currently has key focus, inserts at the cursor (like Ctrl+V);
// - otherwise replaces the whole field content.
// (Native Ctrl+V can silently fail on X11 inside shell dialogs, so this
// reads the clipboard via St.Clipboard directly - the very path the
// extension uses to build its history.)
function createPasteButton(entry) {
    let btn = new St.Button({
        style_class: 'button',
        can_focus: false,
        style: 'padding: 2px 6px;',
        accessible_name: _('Paste'),
        child: new St.Icon({icon_name: 'edit-paste-symbolic', icon_size: 14})
    });
    btn.connect('clicked', () => {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (!text) return;
            const ct = entry.clutter_text;
            const focused = global.stage.get_key_focus() === ct;
            if (focused && ct.get_cursor_position() >= 0) {
                // true "paste" semantics: drop any selection, insert at cursor
                ct.delete_selection();
                ct.insert_text(text, ct.get_cursor_position());
            } else {
                entry.set_text(text);
            }
        });
    });
    return btn;
}

export const MasterPasswordDialog = GObject.registerClass(
    {GTypeName: 'ClipboardWithPasswordsMasterPasswordDialog'},
    class MasterPasswordDialog extends ModalDialog.ModalDialog {
        _init(title, message, callback) {
            super._init({ destroyOnClose: true });

            let mainBox = new St.BoxLayout({
                vertical: true,
                style_class: 'password-vault-dialog-box',
                style: 'spacing: 12px; width: 340px; padding: 12px;'
            });
            this.contentLayout.add_child(mainBox);

            let titleLabel = new St.Label({
                style: 'font-weight: bold; font-size: 15px;',
                x_align: Clutter.ActorAlign.CENTER,
                text: title || _('Password Vault')
            });
            mainBox.add_child(titleLabel);

            let msgLabel = new St.Label({
                style: `font-size: 12px; color: ${themeColors().secondary};`,
                x_align: Clutter.ActorAlign.CENTER,
                text: message || _('Enter the master password to unlock:')
            });
            mainBox.add_child(msgLabel);

            let pwdEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.entry = new St.PasswordEntry({
                hint_text: _('Master password'),
                can_focus: true,
                style: 'padding: 8px; font-size: 14px;'
            });
            this.entry.set_x_expand(true);
            pwdEntryBox.add_child(this.entry);
            pwdEntryBox.add_child(createPasteButton(this.entry));
            mainBox.add_child(pwdEntryBox);

            this.errorLabel = new St.Label({
                style: `color: ${themeColors().error}; font-size: 12px;`,
                x_align: Clutter.ActorAlign.CENTER,
                text: ''
            });
            mainBox.add_child(this.errorLabel);

            // Connect Enter key
            this.entry.clutter_text.connect('activate', () => {
                this._submit(callback);
            });
            this.setInitialKeyFocus(this.entry);

            this.setButtons([
                {
                    label: _('Cancel'),
                    action: () => {
                        this.close();
                    },
                    key: Clutter.KEY_Escape
                },
                {
                    label: _('Unlock'),
                    action: () => {
                        this._submit(callback);
                    },
                    default: true
                }
            ]);
        }


        setError(text) {
            this.errorLabel.set_text(text || '');
        }

        async _submit(callback) {
            const pwd = this.entry.get_text();
            if (!pwd) {
                this.setError(_('Password cannot be empty'));
                return;
            }
            this.setError(_('Unlocking…'));
            try {
                let success = await callback(pwd);
                if (success) {
                    this.close();
                } else {
                    this.setError(_('Wrong password or archive error'));
                }
            } catch (e) {
                const msg = (e && e.message && typeof e.message === 'string' && e.message.length > 0)
                    ? e.message
                    : _('Wrong password or archive error');
                this.setError(msg);
            }
        }
    }
);

export const ServiceEditDialog = GObject.registerClass(
    {GTypeName: 'ClipboardWithPasswordsServiceEditDialog'},
    class ServiceEditDialog extends ModalDialog.ModalDialog {
        _init(serviceItem, existingCategories, onSave, onDelete, focusFieldName = 'name') {
            super._init({ destroyOnClose: true });

            this.serviceId = serviceItem ? serviceItem.id : null;
            this.focusTargetWidget = null;
            this.editCategoryButtons = [];

            let scrollView = new St.ScrollView({
                style: 'max-height: 600px; width: 470px;',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                clip_to_allocation: true
            });
            this.contentLayout.add_child(scrollView);

            let mainBox = new St.BoxLayout({
                vertical: true,
                style: 'spacing: 10px; padding: 12px; width: 446px;'
            });
            scrollView.set_child(mainBox);

            let titleLabel = new St.Label({
                style: 'font-weight: bold; font-size: 16px; margin-bottom: 6px;',
                text: serviceItem ? `${_('Edit')}: ${serviceItem.name}` : _('New service')
            });
            mainBox.add_child(titleLabel);

            // CATEGORY AT THE TOP
            mainBox.add_child(new St.Label({ text: _('Category:'), style: 'font-weight: bold; font-size: 12px;' }));
            
            const initialCategory = serviceItem ? (serviceItem.category || '') : ((existingCategories && existingCategories[0]) || '');

            if (existingCategories && existingCategories.length > 0) {
                let catBtnsContainer = new St.BoxLayout({ vertical: true, style: 'spacing: 4px; margin-bottom: 4px;' });
                let currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
                catBtnsContainer.add_child(currentRowBox);

                let currentWidth = 0;
                const c = themeColors();
                existingCategories.forEach(cat => {
                    const isSelected = cat === initialCategory;
                    let catBtn = new St.Button({
                        label: cat,
                        style_class: 'button',
                        can_focus: false,
                        style: `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                            isSelected ? `background-color: ${c.catBgSelected}; color: ${c.catTextSelected}; font-weight: bold;` : `background-color: ${c.catBg}; color: ${c.catText};`
                        }`
                    });
                    this.editCategoryButtons.push({ cat, btn: catBtn });

                    catBtn.connect('clicked', () => {
                        this.categoryEntry.set_text(cat);
                        this._updateEditCategoryButtonsUI(cat);
                    });

                    if (cat.length * 8 + 20 > (430 - currentWidth)) {
                        currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
                        catBtnsContainer.add_child(currentRowBox);
                        currentWidth = 0;
                    }
                    currentRowBox.add_child(catBtn);
                    currentWidth += cat.length * 8 + 24;
                });
                mainBox.add_child(catBtnsContainer);
            }

            let box = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.categoryEntry = new St.Entry({
                text: initialCategory,
                hint_text: _('Category name (e.g. Work)')
            });
            this.categoryEntry.set_x_expand(true);
            this._deferEditable(this.categoryEntry);
            this.categoryEntry.clutter_text.connect('text-changed', () => {
                this._updateEditCategoryButtonsUI(this.categoryEntry.get_text());
            });
            box.add_child(this.categoryEntry);
            box.add_child(createPasteButton(this.categoryEntry));
            mainBox.add_child(box);

            // NAME
            mainBox.add_child(new St.Label({ text: _('Service name:'), style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let nameEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.nameEntry = new St.Entry({
                text: serviceItem ? (serviceItem.name || '') : '',
                hint_text: _('For example: GitHub')
            });
            this.nameEntry.set_x_expand(true);
            this._deferEditable(this.nameEntry);
            nameEntryBox.add_child(this.nameEntry);
            nameEntryBox.add_child(createPasteButton(this.nameEntry));
            mainBox.add_child(nameEntryBox);
            if (focusFieldName === 'name') this.focusTargetWidget = this.nameEntry;

            // DESCRIPTION
            mainBox.add_child(new St.Label({ text: _('Description:'), style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let descEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.descEntry = new St.Entry({
                text: serviceItem ? (serviceItem.description || '') : '',
                hint_text: _('Description (optional)')
            });
            this.descEntry.set_x_expand(true);
            this._deferEditable(this.descEntry);
            descEntryBox.add_child(this.descEntry);
            descEntryBox.add_child(createPasteButton(this.descEntry));
            mainBox.add_child(descEntryBox);
            if (focusFieldName === 'description') this.focusTargetWidget = this.descEntry;

            // LOGIN
            mainBox.add_child(new St.Label({ text: _('Login / Email:'), style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let loginEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.loginEntry = new St.Entry({
                text: serviceItem ? (serviceItem.login || '') : '',
                hint_text: 'user@example.com'
            });
            this.loginEntry.set_x_expand(true);
            this._deferEditable(this.loginEntry);
            loginEntryBox.add_child(this.loginEntry);
            loginEntryBox.add_child(createPasteButton(this.loginEntry));
            mainBox.add_child(loginEntryBox);
            if (focusFieldName === 'login') this.focusTargetWidget = this.loginEntry;

            // PASSWORD + GENERATOR
            mainBox.add_child(new St.Label({ text: _('Password:'), style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let pwdBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.pwdEntry = new St.PasswordEntry({
                text: serviceItem ? (serviceItem.password || '') : '',
                hint_text: _('Password')
            });
            this.pwdEntry.set_x_expand(true);
            this._deferEditable(this.pwdEntry);
            pwdBox.add_child(this.pwdEntry);
            if (focusFieldName === 'password') this.focusTargetWidget = this.pwdEntry;

            let genBox = new St.BoxLayout({
                vertical: false,
                style: 'spacing: 4px;'
            });
            genBox.add_child(new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 12,
                y_align: Clutter.ActorAlign.CENTER
            }));
            genBox.add_child(new St.Label({
                text: _('16 chars'),
                style: 'font-size: 11px;',
                y_align: Clutter.ActorAlign.CENTER
            }));

            let genBtn = new St.Button({
                style_class: 'button',
                can_focus: false,
                style: 'padding: 4px 8px;',
                accessible_name: _('Generate password (16 characters)'),
                child: genBox
            });
            genBtn.connect('clicked', () => {
                const newPwd = generatePassword(16);
                this.pwdEntry.set_text(newPwd);
                this.pwdEntry.show_password = true;
            });
            pwdBox.add_child(genBtn);
            pwdBox.add_child(createPasteButton(this.pwdEntry));
            mainBox.add_child(pwdBox);

            // EXTRA FIELDS
            let extraHeaderBox = new St.BoxLayout({ vertical: false, style: 'margin-top: 10px;' });
            extraHeaderBox.add_child(new St.Label({ text: _('Extra fields:'), style: 'font-weight: bold; font-size: 12px;', x_expand: true }));

            let addExtraBtn = new St.Button({
                label: '+ ' + _('Add field'),
                style_class: 'button',
                can_focus: false,
                style: 'padding: 2px 6px; font-size: 11px;'
            });
            extraHeaderBox.add_child(addExtraBtn);
            mainBox.add_child(extraHeaderBox);

            this.extraContainer = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
            mainBox.add_child(this.extraContainer);

            this.extraRows = [];
            const initialExtras = (serviceItem && serviceItem.extraFields) ? serviceItem.extraFields : [];
            initialExtras.forEach((f, idx) => {
                const rowObj = this._addExtraRow(f.label, f.value, f.isHidden);
                if (focusFieldName === `extra_${idx}`) {
                    this.focusTargetWidget = rowObj.valueEntry;
                }
            });

            addExtraBtn.connect('clicked', () => {
                this._addExtraRow('', '');
            });

            this._setupTabNavigation([this.categoryEntry, this.nameEntry, this.descEntry, this.loginEntry, this.pwdEntry]);

            let buttons = [
                {
                    label: _('Cancel'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape
                }
            ];

            if (serviceItem && onDelete) {
                buttons.push({
                    label: _('Delete'),
                    action: () => {
                        this._confirmDelete(() => {
                            this.close();
                            onDelete(serviceItem.id);
                        });
                    }
                });
            }

            buttons.push({
                label: _('Save'),
                action: () => {
                    const data = {
                        name: this.nameEntry.get_text() || _('Untitled'),
                        category: this.categoryEntry.get_text() || '',
                        description: this.descEntry.get_text() || '',
                        login: this.loginEntry.get_text() || '',
                        password: this.pwdEntry.get_text() || '',
                        extraFields: this.extraRows.map(r => ({
                            label: r.labelEntry.get_text(),
                            value: r.valueEntry.get_text(),
                            isHidden: !!r.isHidden
                        })).filter(f => f.label || f.value)
                    };
                    this.close();
                    onSave(data);
                },
                default: true
            });

            this.setButtons(buttons);

            const focusTarget = this.focusTargetWidget || this.nameEntry;
            if (focusTarget) {
                this.setInitialKeyFocus(focusTarget);
            }

            // Background: an editable Clutter.Text pushes input-focus updates
            // (set_cursor_location / set_surrounding) via update_cursor_location()
            // whenever its text offsets change during an allocation, and both
            // calls assert the text's input focus is attached (i.e. the text is
            // the current key-focus holder). Flipping `editable` back on after
            // the first allocation does NOT help: the editable and non-editable
            // allocation branches compute different text offsets (TEXT_PADDING
            // vs 0), so any state flip that is followed by another allocation
            // re-trips the "clutter_input_focus_is_focused" criticals for every
            // unfocused field. Instead the fields start out NON-editable - their
            // cursor updates then bail out early - and become editable only on
            // first user interaction (click, or the dialog's own tab/any-key
            // handler). By then the input method is attached, so the assertions
            // can't fire. The initial focus target stays editable from the
            // start: it is focused at open, so its input focus is attached
            // before its first allocation.
            (this._deferEditableEntries || [])
                .filter(e => e !== focusTarget)
                .forEach(entry => {
                    const ct = entry.clutter_text;
                    ct.editable = false;
                    // A non-editable ClutterText is skipped by pointer pick, so
                    // the click lands on the St.Entry widget and a handler on
                    // the text alone never fires (the field only becomes
                    // clickable after something, e.g. Tab, flips it editable).
                    // Connect on BOTH actors: the entry widget catches the
                    // click while the text is non-editable, the text catches
                    // it once editable (harmless duplicate then).
                    [entry, ct].forEach(actor => {
                        actor.connect('button-press-event', () => {
                            // Enable AND grant key focus in the same
                            // interaction. Runs before the default handler, so
                            // cursor positioning at the click point still works
                            // after the text has become editable.
                            ct.editable = true;
                            global.stage.set_key_focus(ct);
                        });
                    });
                });
            // DIAGNOSTIC (verification only, dropped at commit time): proves the
            // deferred-editable code is actually running in this shell session.
            // log(`[clipboard-with-passwords] service edit dialog: defer-editable armed (${(this._deferEditableEntries || []).length} entries)`);
        }

        // Registers an entry whose editable state should be left disabled until
        // after its first allocation (see the comment in _init).
        _deferEditable(entry) {
            if (!entry || !entry.clutter_text) return;
            if (!this._deferEditableEntries) this._deferEditableEntries = [];
            this._deferEditableEntries.push(entry);
        }


        _getTabOrderEntries() {
            let list = [
                this.categoryEntry,
                this.nameEntry,
                this.descEntry,
                this.loginEntry,
                this.pwdEntry
            ];
            if (this.extraRows) {
                this.extraRows.forEach(r => {
                    if (r.labelEntry) list.push(r.labelEntry);
                    if (r.valueEntry) list.push(r.valueEntry);
                });
            }
            return list;
        }

        _setupTabNavigation(entries) {
            entries.forEach((entry) => {
                if (!entry || !entry.clutter_text) return;
                // Connect on the St.Entry itself, not just the clutter_text:
                // key events bubble UP from the focused actor, and at open the
                // key focus sits on the St.Entry widget (setInitialKeyFocus),
                // so a handler on the text child never fires. Connecting on the
                // entry receives keys whether focus is on the widget or its text.
                entry.connect('key-press-event', (actor, event) => {
                    // A keypress means the user is about to type here: make
                    // the field editable right away (see _init). For real
                    // Tab/Shift-Tab handling we also pre-enable the target.
                    entry.clutter_text.editable = true;
                    const symbol = event.get_key_symbol();
                    const state = event.get_state();

                    if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
                        const isShift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0 || symbol === Clutter.KEY_ISO_Left_Tab;
                        const allEntries = this._getTabOrderEntries();
                        const curIdx = allEntries.findIndex(e => e && (e === entry || e.clutter_text === actor));
                        if (curIdx !== -1 && allEntries.length > 0) {
                            const nextIdx = isShift ? (curIdx - 1 + allEntries.length) % allEntries.length : (curIdx + 1) % allEntries.length;
                            const nextEntry = allEntries[nextIdx];
                            if (nextEntry && nextEntry.clutter_text) {
                                nextEntry.clutter_text.editable = true;
                                global.stage.set_key_focus(nextEntry.clutter_text);
                                return Clutter.EVENT_STOP;
                            }
                        }
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
            });
        }

        _updateEditCategoryButtonsUI(activeCat) {
            if (!this.editCategoryButtons) return;
            const c = themeColors();
            this.editCategoryButtons.forEach(({ cat, btn }) => {
                const isSelected = cat === activeCat;
                btn.style = `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                    isSelected ? `background-color: ${c.catBgSelected}; color: ${c.catTextSelected}; font-weight: bold;` : `background-color: ${c.catBg}; color: ${c.catText};`
                }`;
            });
        }

        _confirmDelete(onConfirmed) {
            let confirmDialog = new ModalDialog.ModalDialog();
            let box = new St.BoxLayout({ vertical: true, style: 'spacing: 12px; padding: 12px;' });
            confirmDialog.contentLayout.add_child(box);

            box.add_child(new St.Label({
                text: _('Delete service'),
                style: `font-weight: bold; font-size: 15px; color: ${themeColors().error};`,
                x_align: Clutter.ActorAlign.CENTER
            }));

            box.add_child(new St.Label({
                text: _('Are you sure you want to permanently delete this service?'),
                style: 'font-size: 12px;',
                x_align: Clutter.ActorAlign.CENTER
            }));

            confirmDialog.setButtons([
                {
                    label: _('Cancel'),
                    action: () => {
                        confirmDialog.close();
                    },
                    key: Clutter.KEY_Escape
                },
                {
                    label: _('Delete'),
                    action: () => {
                        confirmDialog.close();
                        onConfirmed();
                    }
                }
            ]);

            confirmDialog.open();
        }

        _addExtraRow(labelVal = '', valueVal = '', isHidden = false) {
            let rowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });

            let labelEntry = new St.Entry({ text: labelVal, hint_text: _('Label (e.g. 2FA)') });
            labelEntry.set_width(120);

            let valueEntry = new St.Entry({ text: valueVal, hint_text: _('Value') });
            valueEntry.set_x_expand(true);
            this._deferEditable(labelEntry);
            this._deferEditable(valueEntry);

            if (isHidden) {
                valueEntry.clutter_text.password_char = '•'.charCodeAt(0);
            }

            let hideBtn = new St.Button({
                style_class: 'button',
                can_focus: false,
                style: 'padding: 2px 6px;',
                accessible_name: isHidden ? _('Reveal value') : _('Hide value'),
                child: new St.Icon({
                    icon_name: isHidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic',
                    icon_size: 12
                })
            });

            let delBtn = new St.Button({
                style_class: 'button',
                can_focus: false,
                style: 'padding: 2px 6px;',
                accessible_name: _('Remove field'),
                child: new St.Icon({
                    icon_name: 'edit-delete-symbolic',
                    icon_size: 12,
                    style: `color: ${themeColors().error};`
                })
            });

            rowBox.add_child(labelEntry);
            rowBox.add_child(valueEntry);
            rowBox.add_child(createPasteButton(valueEntry));
            rowBox.add_child(hideBtn);
            rowBox.add_child(delBtn);

            this.extraContainer.add_child(rowBox);

            const rowData = { labelEntry, valueEntry, rowBox, isHidden, hideBtn };
            this.extraRows.push(rowData);

            this._setupTabNavigation([labelEntry, valueEntry]);

            hideBtn.connect('clicked', () => {
                rowData.isHidden = !rowData.isHidden;
                valueEntry.clutter_text.password_char = rowData.isHidden ? '•'.charCodeAt(0) : 0;
                hideBtn.child.icon_name = rowData.isHidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic';
                hideBtn.accessible_name = rowData.isHidden ? _('Reveal value') : _('Hide value');
            });

            delBtn.connect('clicked', () => {
                this.extraContainer.remove_child(rowBox);
                this.extraRows = this.extraRows.filter(r => r !== rowData);
            });

            return rowData;
        }
    }
);