import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {themeClass, themeColors} from './theme.js';

/**
 * Helpers extracted from the indicator class (extension.js): the full-screen
 * image preview overlay and the tag/edit dialogs for one clipboard entry.
 * The dialogs stay dumb — they build the widget tree and call back into the
 * indicator for anything stateful (menu reopening, cache updates, clipboard
 * writes); ordering of those side effects is preserved exactly.
 */

// Build a Clutter/Cogl color for the edit dialog from a CSS hex string and a
// 0..1 alpha. Clutter.Text color properties are typed ClutterColor on GNOME
// ≤46 (Clutter.Color, GJS boxed wrapper) and CoglColor on 47+ (Clutter.Color
// was merged into Cogl.Color upstream). Passing a Cogl.Color on ≤46 throws
// «Object is of type Cogl.Color - cannot convert to ClutterColor», so pick
// the exact wrapper the current runtime expects.
function buildEditorColor(hex, alpha = 1.0) {
    if (typeof Clutter.Color === 'function') {
        const aByte = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
            .toString(16).padStart(2, '0');
        const spec = `${(hex.startsWith('#') ? hex : `#${hex}`).slice(0, 7)}${aByte}`;
        const [ok, color] = Clutter.Color.from_string(spec);
        if (ok) return color;
    }
    const h = hex.replace('#', '');
    const color = new Cogl.Color();
    color.init_from_4f(
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
        alpha);
    return color;
}

// (Re)build the small tag label on a menu item, keeping it to the RIGHT of
// the content: hidden-label items (multiline/URL/file/color) put the actual
// content in a box, so inserting above the (hidden) label would push the tag
// far left. Placing it before the actions spacer keeps [content, tag, spacer].
function updateTagLabel(menuItem) {
    if (menuItem.tagLabel) {
        menuItem.actor.remove_child(menuItem.tagLabel);
        menuItem.tagLabel.destroy();
        menuItem.tagLabel = null;
    }

    const tag = menuItem.entry.getTag();
    if (tag) {
        menuItem.tagLabel = new St.Label({
            text: tag,
            style_class: 'ci-tag-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (menuItem.actionsSpacer && menuItem.actor.contains(menuItem.actionsSpacer)) {
            menuItem.actor.insert_child_below(menuItem.tagLabel, menuItem.actionsSpacer);
        } else {
            menuItem.actor.insert_child_above(menuItem.tagLabel, menuItem.label);
        }
    }
}

/**
 * Tag dialog for one clipboard entry.
 *
 * @param {object} menuItem - menu item whose entry.getTag() is edited
 * @param {object} [opts]
 * @param {boolean} [opts.reopenOnClose=false] - reopen the indicator menu after the dialog closes
 * @param {Function} [opts.onReopen] - called on close when reopenOnClose (menu reopening lives in the indicator)
 * @param {Function} [opts.onSaved] - called after entry.setTag()/tag label update (cache refresh lives in the indicator)
 */
export function showTagDialog(menuItem, {
    reopenOnClose = false,
    onReopen = null,
    onSaved = null,
} = {}) {
    const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
    dialog.contentLayout.add_style_class_name(themeClass());

    const onDialogClose = () => {
        if (reopenOnClose && onReopen) onReopen();
    };

    const textEntry = new St.Entry({
        text: menuItem.entry.getTag() || '',
        hint_text: _('Enter tag…'),
        can_focus: true,
        x_expand: true,
        style: 'min-width: 300px;',
    });
    // Non-empty unfocused texts push "clutter_input_focus_is_focused"
    // input-focus criticals on their first layout: an editable, unfocused
    // Clutter.Text asserts inside its cursor-location/surrounding updates.
    // Keep the field non-editable until first user interaction - once the
    // text holds key focus the input method is attached and the assertions
    // can't fire.
    textEntry.clutter_text.editable = false;
    textEntry.clutter_text.connect('button-press-event', () => {
        textEntry.clutter_text.editable = true;
    });
    textEntry.clutter_text.connect('key-press-event', () => {
        textEntry.clutter_text.editable = true;
    });

    dialog.contentLayout.add_child(textEntry);

    dialog.addButton({
        label: _('Discard'),
        action: () => {
            dialog.close();
            onDialogClose();
        },
        key: Clutter.KEY_Escape,
    });

    dialog.addButton({
        label: _('Save'),
        action: () => {
            const tag = textEntry.get_text().trim() || null;
            menuItem.entry.setTag(tag);
            updateTagLabel(menuItem);
            if (onSaved) onSaved();
            dialog.close();
            onDialogClose();
        },
        default: true,
    });

    dialog.open();
    textEntry.grab_key_focus();
}

/**
 * Editor dialog for a single-line text clipboard entry.
 *
 * Saves by mutating `menuItem.entry`/`menuItem.clipContents` FIRST, then runs
 * `onSave` (the indicator refreshes the label, cache and clipboard).
 *
 * @param {object} menuItem - menu item whose entry text is edited
 * @param {object} [opts]
 * @param {boolean} [opts.reopenOnClose=false] - close the indicator menu first and reopen it after
 * @param {Function} [opts.closeMenu] - called before opening when reopenOnClose
 * @param {Function} [opts.onReopen] - called on close when reopenOnClose (menu reopening lives in the indicator)
 * @param {Function} [opts.onSave] - called after entry.setText()/clipContents assignment
 */
export function showEditDialog(menuItem, {
    reopenOnClose = false,
    closeMenu = null,
    onReopen = null,
    onSave = null,
} = {}) {
    const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
    dialog.contentLayout.add_style_class_name(themeClass());

    const onDialogClose = () => {
        if (reopenOnClose && onReopen) onReopen();
    };

    const scrollView = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        x_expand: true,
        y_expand: false,
        style: 'min-width: 400px; min-height: 100px; max-height: 400px;',
    });

    const clutterText = new Clutter.Text({
        text: menuItem.entry.getStringValue(),
        // An editable, unfocused Clutter.Text pushes "clutter_input_focus_is_focused"
        // input-focus criticals whenever its text offsets change during
        // allocation. Start non-editable and only enable editing once the
        // user actually interacts with the text - by then the input method
        // is attached and the assertions can't fire.
        editable: false,
        reactive: true,
        single_line_mode: false,
        activatable: false,
        line_wrap: true,

    });
    clutterText.connect('button-press-event', () => {
        clutterText.editable = true;
    });
    clutterText.connect('key-press-event', () => {
        clutterText.editable = true;
    });

    // Text color must follow the active theme — hardcoding white makes the
    // dialog unreadable on light shells. Clutter.Text:color is a
    // ClutterColor (Clutter.Color) on GNOME ≤46 and a CoglColor
    // (Cogl.Color) on 47+, so colors are built via the type-appropriate API
    // (buildEditorColor handles both).
    clutterText.color = buildEditorColor(themeColors().text);
    clutterText.selection_color = buildEditorColor('#6396ff', 0.71);
    clutterText.selected_text_color = buildEditorColor('#ffffff');

    const textBox = new St.BoxLayout({
        style_class: 'ci-edit-textbox',
        x_expand: true,
        y_expand: true,
        vertical: true,
    });

    textBox.add_child(clutterText);

    scrollView.add_child(textBox);
    dialog.contentLayout.add_child(scrollView);

    dialog.addButton({
        label: _('Discard'),
        action: () => {
            dialog.close();
            onDialogClose();
        },
        key: Clutter.KEY_Escape,
    });

    dialog.addButton({
        label: _('Save'),
        action: () => {
            const newText = clutterText.get_text();
            menuItem.entry.setText(newText);
            menuItem.clipContents = newText;
            if (onSave) onSave();
            dialog.close();
            onDialogClose();
        },
        default: true,
    });

    if (reopenOnClose && closeMenu) closeMenu();
    dialog.open();
    clutterText.grab_key_focus();
}

/**
 * Full-screen dimmed overlay that shows one image entry at most half the
 * monitor size. Owns its overlay actor so the indicator only holds a
 * reference to the manager (destroy() just calls close()).
 */
export class ImagePreviewOverlay {
    constructor({registry}) {
        this._registry = registry;
        this._overlay = null;
    }

    show(entry, onClose = null) {
        this.close();

        const monitor = Main.layoutManager.currentMonitor;

        const overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0.75);',
        });

        this._overlay = overlay;
        global.stage.add_child(overlay);
        overlay.grab_key_focus();

        const close = () => {
            this.close();
            if (onClose) onClose();
        };

        overlay._previewClickId = overlay.connect('button-press-event', () => {
            close();
            return Clutter.EVENT_STOP;
        });

        overlay._previewKeyId = overlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const maxW = Math.floor(monitor.width * 0.5);
        const maxH = Math.floor(monitor.height * 0.4);

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));
        overlay.add_child(bin);

        this._registry.getEntryAsTexture(entry).then(actor => {
            if (this._overlay !== overlay) return;
            if (!actor) return;

            let contentHandlerId = actor.connect('notify::content', () => {
                const [, natW] = actor.get_preferred_width(-1);
                const [, natH] = actor.get_preferred_height(-1);

                if (natW > 0 && natH > 0) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                    const scale = Math.min(1, maxW / natW, maxH / natH);
                    bin.set_size(Math.round(natW * scale), Math.round(natH * scale));
                }
            });

            actor.connect('destroy', () => {
                if (contentHandlerId) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                }
            });

            bin.set_child(actor);
        }).catch(e => {
            console.error('Clipboard Indicator: failed to load image preview');
            console.error(e);
        });
    }

    close() {
        if (!this._overlay) return;

        const overlay = this._overlay;
        this._overlay = null;

        if (overlay._previewClickId) overlay.disconnect(overlay._previewClickId);
        if (overlay._previewKeyId) overlay.disconnect(overlay._previewKeyId);

        if (overlay.get_parent()) global.stage.remove_child(overlay);
        overlay.destroy();
    }
}