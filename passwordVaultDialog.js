import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { generatePassword } from './passwordVault.js';

// Button that inserts the CLIPBOARD text into `entry`:
// - if the entry currently has key focus, inserts at the cursor (like Ctrl+V);
// - otherwise replaces the whole field content.
// (Native Ctrl+V can silently fail on X11 inside shell dialogs, so this
// reads the clipboard via St.Clipboard directly - the very path the
// extension uses to build its history.)
function createPasteButton(entry) {
    let btn = new St.Button({
        label: '📋',
        style_class: 'button',
        can_focus: false,
        style: 'padding: 2px 6px; font-size: 13px;'
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
    class MasterPasswordDialog extends ModalDialog.ModalDialog {
        _init(title, message, callback) {
            super._init();

            let mainBox = new St.BoxLayout({
                vertical: true,
                style_class: 'password-vault-dialog-box',
                style: 'spacing: 12px; width: 340px; padding: 12px;'
            });
            this.contentLayout.add_child(mainBox);

            let titleLabel = new St.Label({
                style: 'font-weight: bold; font-size: 15px;',
                x_align: Clutter.ActorAlign.CENTER,
                text: title || 'Хранилище паролей'
            });
            mainBox.add_child(titleLabel);

            let msgLabel = new St.Label({
                style: 'font-size: 12px; color: #888888;',
                x_align: Clutter.ActorAlign.CENTER,
                text: message || 'Введите мастер-пароль для разблокировки:'
            });
            mainBox.add_child(msgLabel);

            let pwdEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.entry = new St.PasswordEntry({
                hint_text: 'Мастер-пароль',
                can_focus: true,
                style: 'padding: 8px; font-size: 14px;'
            });
            this.entry.set_x_expand(true);
            pwdEntryBox.add_child(this.entry);
            pwdEntryBox.add_child(createPasteButton(this.entry));
            mainBox.add_child(pwdEntryBox);

            this.errorLabel = new St.Label({
                style: 'color: #ff5555; font-size: 12px;',
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
                    label: 'Отмена',
                    action: () => {
                        this.close();
                    },
                    key: Clutter.KEY_Escape
                },
                {
                    label: 'Разблокировать',
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
                this.setError('Пароль не может быть пустым');
                return;
            }
            this.setError('Разблокировка...');
            try {
                let success = await callback(pwd);
                if (success) {
                    this.close();
                } else {
                    this.setError('Неверный пароль или ошибка архива');
                }
            } catch (e) {
                this.setError('Неверный пароль или ошибка архива');
            }
        }
    }
);

export const ServiceEditDialog = GObject.registerClass(
    class ServiceEditDialog extends ModalDialog.ModalDialog {
        _init(serviceItem, existingCategories, onSave, onDelete, focusFieldName = 'name') {
            super._init();

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
                text: serviceItem ? `Редактирование: ${serviceItem.name}` : 'Новый сервис'
            });
            mainBox.add_child(titleLabel);

            // CATEGORY AT THE TOP
            mainBox.add_child(new St.Label({ text: 'Категория:', style: 'font-weight: bold; font-size: 12px;' }));
            
            const initialCategory = serviceItem ? serviceItem.category : (existingCategories && existingCategories[0] ? existingCategories[0] : 'Общее');

            if (existingCategories && existingCategories.length > 0) {
                let catBtnsContainer = new St.BoxLayout({ vertical: true, style: 'spacing: 4px; margin-bottom: 4px;' });
                let currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
                catBtnsContainer.add_child(currentRowBox);

                let currentWidth = 0;
                existingCategories.forEach(cat => {
                    const isSelected = cat === initialCategory;
                    let catBtn = new St.Button({
                        label: cat,
                        style_class: 'button',
                        can_focus: false,
                        style: `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                            isSelected ? 'background-color: #3584e4; color: #ffffff; font-weight: bold;' : 'background-color: rgba(255,255,255,0.1); color: #eeeeee;'
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
                hint_text: 'Название категории (напр. Работа)'
            });
            this.categoryEntry.set_x_expand(true);
            this.categoryEntry.clutter_text.connect('text-changed', () => {
                this._updateEditCategoryButtonsUI(this.categoryEntry.get_text());
            });
            box.add_child(this.categoryEntry);
            box.add_child(createPasteButton(this.categoryEntry));
            mainBox.add_child(box);

            // NAME
            mainBox.add_child(new St.Label({ text: 'Название сервиса:', style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let nameEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.nameEntry = new St.Entry({
                text: serviceItem ? serviceItem.name : '',
                hint_text: 'Например: GitHub'
            });
            this.nameEntry.set_x_expand(true);
            nameEntryBox.add_child(this.nameEntry);
            nameEntryBox.add_child(createPasteButton(this.nameEntry));
            mainBox.add_child(nameEntryBox);
            if (focusFieldName === 'name') this.focusTargetWidget = this.nameEntry;

            // DESCRIPTION
            mainBox.add_child(new St.Label({ text: 'Описание:', style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let descEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.descEntry = new St.Entry({
                text: serviceItem ? (serviceItem.description || '') : '',
                hint_text: 'Описание (необязательно)'
            });
            this.descEntry.set_x_expand(true);
            descEntryBox.add_child(this.descEntry);
            descEntryBox.add_child(createPasteButton(this.descEntry));
            mainBox.add_child(descEntryBox);
            if (focusFieldName === 'description') this.focusTargetWidget = this.descEntry;

            // LOGIN
            mainBox.add_child(new St.Label({ text: 'Логин / Email:', style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let loginEntryBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.loginEntry = new St.Entry({
                text: serviceItem ? serviceItem.login : '',
                hint_text: 'user@example.com'
            });
            this.loginEntry.set_x_expand(true);
            loginEntryBox.add_child(this.loginEntry);
            loginEntryBox.add_child(createPasteButton(this.loginEntry));
            mainBox.add_child(loginEntryBox);
            if (focusFieldName === 'login') this.focusTargetWidget = this.loginEntry;

            // PASSWORD + GENERATOR
            mainBox.add_child(new St.Label({ text: 'Пароль:', style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' }));
            let pwdBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.pwdEntry = new St.PasswordEntry({
                text: serviceItem ? serviceItem.password : '',
                hint_text: 'Пароль'
            });
            this.pwdEntry.set_x_expand(true);
            pwdBox.add_child(this.pwdEntry);
            if (focusFieldName === 'password') this.focusTargetWidget = this.pwdEntry;

            let genBtn = new St.Button({
                label: '🎲 16 с.',
                style_class: 'button',
                can_focus: false,
                style: 'padding: 4px 8px; font-size: 11px;'
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
            extraHeaderBox.add_child(new St.Label({ text: 'Дополнительные поля:', style: 'font-weight: bold; font-size: 12px;', x_expand: true }));

            let addExtraBtn = new St.Button({
                label: '+ Добавить поле',
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

            this._setupTabNavigation([this.categoryEntry, this.nameEntry, this.loginEntry, this.pwdEntry]);

            let buttons = [
                {
                    label: 'Отмена',
                    action: () => this.close(),
                    key: Clutter.KEY_Escape
                }
            ];

            if (serviceItem && onDelete) {
                buttons.push({
                    label: '🗑️ Удалить',
                    action: () => {
                        this._confirmDelete(() => {
                            this.close();
                            onDelete(serviceItem.id);
                        });
                    }
                });
            }

            buttons.push({
                label: 'Сохранить',
                action: () => {
                    const data = {
                        name: this.nameEntry.get_text() || 'Без названия',
                        category: this.categoryEntry.get_text() || 'Общее',
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
                if (entry && entry.clutter_text) {
                    entry.clutter_text.connect('key-press-event', (actor, event) => {
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
                                    global.stage.set_key_focus(nextEntry.clutter_text);
                                    return Clutter.EVENT_STOP;
                                }
                            }
                        }
                        return Clutter.EVENT_PROPAGATE;
                    });
                }
            });
        }

        _updateEditCategoryButtonsUI(activeCat) {
            if (!this.editCategoryButtons) return;
            this.editCategoryButtons.forEach(({ cat, btn }) => {
                const isSelected = cat === activeCat;
                btn.style = `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                    isSelected ? 'background-color: #3584e4; color: #ffffff; font-weight: bold;' : 'background-color: rgba(255,255,255,0.1); color: #eeeeee;'
                }`;
            });
        }

        _confirmDelete(onConfirmed) {
            let confirmDialog = new ModalDialog.ModalDialog();
            let box = new St.BoxLayout({ vertical: true, style: 'spacing: 12px; padding: 12px;' });
            confirmDialog.contentLayout.add_child(box);

            box.add_child(new St.Label({
                text: 'Удаление сервиса',
                style: 'font-weight: bold; font-size: 15px; color: #ff5555;',
                x_align: Clutter.ActorAlign.CENTER
            }));

            box.add_child(new St.Label({
                text: 'Вы уверены, что хотите безвозвратно удалить этот сервис?',
                style: 'font-size: 12px;',
                x_align: Clutter.ActorAlign.CENTER
            }));

            confirmDialog.setButtons([
                {
                    label: 'Отмена',
                    action: () => {
                        confirmDialog.close();
                    },
                    key: Clutter.KEY_Escape
                },
                {
                    label: 'Удалить',
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

            let labelEntry = new St.Entry({ text: labelVal, hint_text: 'Метка (напр. 2FA)' });
            labelEntry.set_width(120);

            let valueEntry = new St.Entry({ text: valueVal, hint_text: 'Значение' });
            valueEntry.set_x_expand(true);

            if (isHidden) {
                valueEntry.clutter_text.password_char = '•'.charCodeAt(0);
            }

            let hideBtn = new St.Button({
                label: isHidden ? '🙈' : '👁️',
                style_class: 'button',
                can_focus: false,
                style: 'padding: 2px 6px; font-size: 11px;',
                accessible_name: 'Скрыть значение'
            });

            let delBtn = new St.Button({
                label: '✖',
                style_class: 'button',
                can_focus: false,
                style: 'padding: 2px 6px; color: #ff5555;'
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
                hideBtn.set_label(rowData.isHidden ? '🙈' : '👁️');
            });

            delBtn.connect('clicked', () => {
                this.extraContainer.remove_child(rowBox);
                this.extraRows = this.extraRows.filter(r => r !== rowData);
            });

            return rowData;
        }
    }
);
