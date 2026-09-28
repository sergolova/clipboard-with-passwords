import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import { generatePassword } from './passwordVault.js';
import { themeColors } from './theme.js';
import { logWarn } from './logging.js';
import Pango from 'gi://Pango';

// Usable width of the service dialog's content box, in pixels. The scroll view
// is 470px wide and the content box adds 12px of padding on each side, so this
// is what a row inside the form actually has to share. It is named rather than
// written into the CSS twice because the category buttons wrap by it: two
// copies of this number, free to drift apart, is how a wrap ends up believing
// it has more or less room than it does.
const DIALOG_CONTENT_WIDTH = 446;

// Soft floor for the live passphrase hint shown when a NEW vault is created
// (its master password is chosen inside this dialog for the first time).
// Deliberately a guideline, not a hard "weak/strong" verdict: the hint only
// reacts to length, it never rejects a password and it performs no network
// or policy checks.
const MASTER_PASSWORD_MIN_LENGTH = 8;

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
        // EGO-A-005 (manual review): reading the clipboard here is the Paste
        // semantic of a clipboard manager — pull the current text and insert
        // it into the password field.
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
        // `requireConfirmation` adds a second field the master password has to
        // be typed into twice. It is only ever true for the CREATION dialog:
        // there the passphrase is being chosen for the first time, it cannot be
        // recovered, and there is no second chance to notice a typo — an
        // unlock only checks an existing password, so there is nothing to
        // confirm there.
        _init(title, message, callback, guidance = null, confirmBtnCaption = null,
            requireConfirmation = false) {
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

            // Typo guard for the creation dialog only (see the note on
            // _init): a master password that is wrong in a way the user cannot
            // see means the vault is unreadable forever, because nothing else
            // can verify it. A second identical field turns "pressed the wrong
            // key" into an error the dialog can point at.
            if (requireConfirmation) {
                this.confirmEntry = new St.PasswordEntry({
                    hint_text: _('Repeat the master password'),
                    can_focus: true,
                    style: 'padding: 8px; font-size: 14px;'
                });
                this.confirmEntry.set_x_expand(true);

                let confirmBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
                confirmBox.add_child(this.confirmEntry);
                confirmBox.add_child(createPasteButton(this.confirmEntry));
                mainBox.add_child(confirmBox);

                // Enter in either field submits, so the user never has to
                // reach for the mouse to confirm a second time.
                this.confirmEntry.clutter_text.connect('activate', () => {
                    this._submit(callback);
                });

                // A second field makes this the "several entries in one
                // dialog" case: with the creation dialog now holding two
                // password fields, the unfocused one would trip the
                // clutter_input_focus_is_focused criticals on its first
                // allocation if it were editable (an editable ClutterText
                // pushes cursor updates that assert the input focus is
                // attached). So it starts non-editable and only becomes
                // editable on the first real interaction, when the input method
                // is already attached. The first field keeps its editable
                // state: it is the dialog's initial key focus, so its input
                // focus is attached before its first allocation.
                this._deferEditableUntilTouched(this.confirmEntry);

                // Once a mismatch has been reported, correct it the moment the
                // two fields agree again instead of waiting for another submit.
                const recheck = () => {
                    if (this._reportedMismatch && this._passwordsMatch())
                        this.setError('');
                };
                this.entry.clutter_text.connect('text-changed', recheck);
                this.confirmEntry.clutter_text.connect('text-changed', recheck);
            }

            this.errorLabel = new St.Label({
                style: `color: ${themeColors().error}; font-size: 12px;`,
                x_align: Clutter.ActorAlign.CENTER,
                text: ''
            });

            const clutterErrorText = this.errorLabel.get_clutter_text();
            clutterErrorText.line_wrap = true;
            clutterErrorText.ellipsize = Pango.EllipsizeMode.NONE;
            clutterErrorText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            
            mainBox.add_child(this.errorLabel);

            // When this dialog CREATES the vault (fresh archive — first run or the file
            // was deleted), the password typed here becomes the master password.
            // Explain what makes a good one and that it can never be recovered.
            // Regular unlock dialogs pass guidance=null and show no extra label;
            // the live hint reacts to length only (see _updateGuidance).
            if (guidance) {
                this.guidanceLabel = new St.Label({
                    style: `font-size: 11px; color: ${themeColors().secondary};`,
                    x_align: Clutter.ActorAlign.CENTER,
                    text: guidance
                });

                const clutterText = this.guidanceLabel.get_clutter_text();
                clutterText.line_wrap = true;
                clutterText.ellipsize = Pango.EllipsizeMode.NONE;
                clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

                mainBox.add_child(this.guidanceLabel);
                this.entry.clutter_text.connect('text-changed', () => {
                    this._updateGuidance(guidance);
                });
            }

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
                    label: confirmBtnCaption || _('Unlock'),
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

        // Leave `entry` non-editable until the user actually reaches for it,
        // then make it editable and give it the key focus in the same
        // interaction. Handlers go on BOTH the St.Entry widget and its
        // ClutterText: a non-editable text is skipped by pointer picking, so
        // the click lands on the widget and a handler on the text alone would
        // never fire; once the text is editable the same click reaches it too,
        // which is a harmless duplicate. Key events need the widget handler as
        // well, because the key focus sits on the widget until the first click.
        _deferEditableUntilTouched(entry) {
            const ct = entry.clutter_text;
            ct.editable = false;
            const takeFocus = () => {
                ct.editable = true;
                global.stage.set_key_focus(ct);
            };
            entry.connect('button-press-event', takeFocus);
            ct.connect('button-press-event', takeFocus);
            entry.connect('key-press-event', event => {
                // A keypress means the user is typing here. Tab additionally
                // moves to the other password field, so the confirmation can be
                // reached without a mouse.
                ct.editable = true;
                const symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
                    const isShift = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
                    const other = isShift ? this.entry : this.confirmEntry;
                    if (other && other.clutter_text) {
                        other.clutter_text.editable = true;
                        global.stage.set_key_focus(other.clutter_text);
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        // Soft passphrase guidance while a NEW vault's master password is
        // being typed. Empty field → the static creation guidance; very
        // short input → a gentle "longer is harder to guess" hint; adequate
        // length → a reassurance to keep it unique. No verdict labels, no
        // thresholds that block anything.
        _updateGuidance(guidance) {
            if (!this.guidanceLabel) {
                return;
            }
            const length = (this.entry.get_text() || '').length;
            let text = guidance;
            if (length > 0 && length < MASTER_PASSWORD_MIN_LENGTH) {
                text = _('A longer passphrase is much harder to guess — the vault password cannot be recovered.');
            } else if (length >= MASTER_PASSWORD_MIN_LENGTH) {
                text = _('Good length. Keep this passphrase unique — do not reuse another account\'s password.');
            }
            if (text !== this.guidanceLabel.get_text()) {
                this.guidanceLabel.set_text(text);
            }
        }

        // The two fields agree, or there is nothing to compare: exact string
        // equality, not a length or a trimmed comparison — the master password
        // is never trimmed either, so "  a" and "a" are genuinely different
        // passwords and must not be treated as a match.
        _passwordsMatch() {
            if (!this.confirmEntry) {
                return true;
            }
            return this.entry.get_text() === this.confirmEntry.get_text();
        }

        async _submit(callback) {
            const pwd = this.entry.get_text();
            if (!pwd) {
                this.setError(_('Password cannot be empty'));
                return;
            }
            // Checked before anything is written: the confirmation exists to
            // catch the typo, and unlocking first would defeat that.
            if (!this._passwordsMatch()) {
                this._reportedMismatch = true;
                this.setError(_('The two passwords do not match.'));
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

            // This scroll view is the dialog's only height clamp, and a
            // scrollbar that can scroll a couple of pixels is worse than no
            // scrollbar at all: add one extra field, the content ends up a few
            // pixels taller than the clamp, and the bar appears, moves the
            // content by an amount nobody can use, and stays there. The clamp
            // is therefore taken from the monitor rather than being a fixed
            // number — the dialog gets all the height the screen can really
            // give it, and a scrollbar appears only for a service with enough
            // fields to be taller than the screen.
            //
            // The reserve is what the dialog spends around the content, taken
            // from the shell theme: 32px of content-box margin above and below
            // (64), 32px of spacing between the content and the button bar, the
            // button bar itself (~40), and slack so the buttons never sit on
            // the screen edge.
            const DIALOG_CHROME_RESERVE = 240;
            // Past this the dialog stops being a dialog, so a tall monitor
            // does not turn a long list of fields into a full-screen panel.
            const DIALOG_MAX_CONTENT = 900;
            const monitorHeight = Main.layoutManager.primaryMonitor?.height ?? 1080;
            const maxContentHeight = Math.max(360,
                Math.min(DIALOG_MAX_CONTENT, monitorHeight - DIALOG_CHROME_RESERVE));

            let scrollView = new St.ScrollView({
                style: `max-height: ${maxContentHeight}px; width: 470px;`,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                clip_to_allocation: true
            });
            this.contentLayout.add_child(scrollView);

            // During (smooth) scrolling St lets the moved child damage only
            // its own old/new bounds; a ~10px strip at the content's right
            // edge can stay OUT of the damage region, so the compositor
            // keeps showing the PRE-scroll frame there — the "frozen strip"
            // artifact (visible live, absent from captures; a click on the
            // widget repaints it). Force the whole viewport to repaint on
            // every scroll step so the strip can never lag behind.
            scrollView.vadjustment.connect('notify::value', () => scrollView.queue_redraw());

            let mainBox = new St.BoxLayout({
                vertical: true,
                style: `spacing: 10px; padding: 12px; width: ${DIALOG_CONTENT_WIDTH}px;`
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
                // The category buttons are wrapped by hand, one row box at a
                // time, because St has no flow layout. What decides where a
                // row breaks has to be two real numbers, or the block looks
                // wrong in ways that are hard to describe:
                //   * how wide a button actually IS — asking the actor, because
                //     the old estimate (8px per character) was wrong for short
                //     names, for non-Latin ones and for any other font;
                //   * how much width the block actually HAS — the content box's
                //     own width, named once, so it cannot drift from the CSS the
                //     way the old hardcoded 430 did against a 446px box.
                const catBtnSpacing = 4;
                const catRow = () => new St.BoxLayout({
                    vertical: false,
                    style: `spacing: ${catBtnSpacing}px;`
                });

                const catBtnsContainer = new St.BoxLayout({
                    vertical: true,
                    style: `spacing: ${catBtnSpacing}px; margin-bottom: 4px;`
                });
                const c = themeColors();

                // Build every button first, in order. The record is what
                // _updateEditCategoryButtonsUI() works from, so it is filled in
                // the same order the buttons are shown in.
                for (const cat of existingCategories) {
                    const isSelected = cat === initialCategory;
                    const catBtn = new St.Button({
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
                }

                // Start with every button in one row. That is not the final
                // layout — it is what makes them real: a button's width measured
                // before its first allocation is a few pixels short of what the
                // row actually needs, because the label's font metrics only
                // settle once it has been laid out. Allocating them all in one
                // row first, and wrapping afterwards, is what makes the
                // measurement true; the alternative is a block that overflows by
                // a handful of pixels for reasons nobody can see.
                const firstRow = catRow();
                for (const {btn} of this.editCategoryButtons)
                    firstRow.add_child(btn);
                catBtnsContainer.add_child(firstRow);
                mainBox.add_child(catBtnsContainer);

                // Wrap once, on the container's first allocation, and then leave
                // it alone: the widths do not change after that, and a wrap that
                // re-ran on every resize would only make the block jump around
                // for no reason.
                //
                // The re-parenting itself waits for an idle: `notify::width`
                // arrives in the middle of Clutter's allocation cycle, and
                // adding and removing children from inside it makes Clutter
                // warn that the actor "needs an allocation" while it is already
                // on stage. By the next idle the buttons have been allocated
                // once, which is what the measurement needs anyway.
                let wrapScheduled = false;
                const id = catBtnsContainer.connect('notify::width', () => {
                    if (wrapScheduled)
                        return false;
                    wrapScheduled = true;
                    catBtnsContainer.disconnect(id);
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._wrapCategoryButtons(catBtnsContainer, catBtnSpacing, firstRow);
                        return GLib.SOURCE_REMOVE;
                    });
                    return false;
                });
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
            let pwdLabel = new St.Label({ text: _('Password:'), style: 'font-weight: bold; font-size: 12px; margin-top: 6px;' });
            mainBox.add_child(pwdLabel);
            let pwdBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });
            this.pwdEntry = new St.PasswordEntry({
                text: serviceItem ? (serviceItem.password || '') : '',
                hint_text: _('Password')
            });
            this.pwdEntry.set_x_expand(true);
            this._deferEditable(this.pwdEntry);
            pwdBox.add_child(this.pwdEntry);
            if (focusFieldName === 'password') this.focusTargetWidget = this.pwdEntry;

            // Live length counter shown in the label itself — "Password: (N chars)" —
            // so no extra rows are needed and the dialog height stays flat. It
            // updates on every text change (typing or the generator) and hides
            // the count for an empty field.
            const updatePwdLength = () => {
                const n = this.pwdEntry.text.length;
                pwdLabel.set_text(n > 0
                    ? `${_('Password:')} (${ngettext('%d char', '%d chars', n).replace('%d', String(n))})`
                    : _('Password:'));
            };
            this.pwdEntry.connect('notify::text', updatePwdLength);
            updatePwdLength(); // reflect the pre-filled value at open

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
                let newPwd;
                try {
                    newPwd = generatePassword(16);
                } catch (e) {
                    // Entropy failure (/dev/urandom unreadable) — surface it
                    // instead of silently degrading to Math.random().
                    logWarn('Failed to generate a password:', e);
                    Main.notify(_('Password Vault'), _('Failed to generate a password.'));
                    return;
                }
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
                label: serviceItem ? _('Save') : _('Create'),
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

        // Lay the category buttons out into rows that each fit the content box.
        // Called once, from an idle after the block's first allocation, so that
        // every button reports a settled width: measured before its first
        // allocation a button is a few pixels narrower than the row really
        // needs, which is just enough to push a row past the edge.
        //
        // `firstRow` is the row the buttons are already in, and it is reused as
        // the first row of the result rather than thrown away, so the block
        // never ends up with an empty row above the real content.
        _wrapCategoryButtons(container, spacing, firstRow) {
            const catRow = () => new St.BoxLayout({
                vertical: false,
                style: `spacing: ${spacing}px;`
            });

            let row = firstRow;
            let rowWidth = 0;
            for (const {btn} of this.editCategoryButtons) {
                // get_preferred_width() answers [minimum, natural]: the minimum
                // is how far the button could shrink, which is far less than it
                // will ever occupy, so the natural one is the number to wrap on.
                const [, natural] = btn.get_preferred_width(-1);
                const withSpacing = rowWidth === 0
                    ? natural
                    : rowWidth + spacing + natural;
                if (withSpacing > DIALOG_CONTENT_WIDTH && rowWidth > 0) {
                    row = catRow();
                    container.add_child(row);
                    rowWidth = natural;
                } else {
                    rowWidth = withSpacing;
                }
                if (btn.get_parent() !== row) {
                    btn.get_parent()?.remove_child(btn);
                    row.add_child(btn);
                }
            }
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

            let labelEntry = new St.Entry({ text: labelVal, hint_text: _('Label') });
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