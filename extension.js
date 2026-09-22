import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Registry, ClipboardEntry} from './registry.js';
import {DialogManager} from './confirmDialog.js';
import {PrefsFields} from './constants.js';
import {Keyboard} from './keyboard.js';
import {UrlMetadataManager} from './urlMetadataManager.js';
import {PasswordVaultManager} from './passwordVault.js';
import {MasterPasswordDialog} from './passwordVaultDialog.js';
import {PasswordVaultMenuSection} from './passwordVaultMenu.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = 'edit-paste-symbolic';

let DELAYED_SELECTION_TIMEOUT = 750;
let MAX_REGISTRY_LENGTH = 15;
let MAX_ENTRY_LENGTH = 50;
let CACHE_ONLY_FAVORITE = false;
let DELETE_ENABLED = true;
let MOVE_ITEM_FIRST = false;
let ENABLE_KEYBINDING = true;
let PRIVATEMODE = false;
let NOTIFY_ON_COPY = true;
let NOTIFY_ON_CYCLE = true;
let NOTIFY_ON_CLEAR = true;
let CONFIRM_ON_CLEAR = true;
let CONFIRM_ON_PINNED_DELETE = false;
let MAX_TOPBAR_LENGTH = 15;
let TOPBAR_DISPLAY_MODE = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
let CLEAR_ON_BOOT = false;
let PASTE_ON_SELECT = false;
let DISABLE_DOWN_ARROW = false;
let BLINK_ICON_ON_COPY = false;
let STRIP_TEXT = false;
let KEEP_SELECTED_ON_CLEAR = false;
let PASTE_BUTTON = true;
let PINNED_ON_BOTTOM = false;
let CACHE_IMAGES = true;
let EXCLUDED_APPS = [];
let CLEAR_HISTORY_ON_INTERVAL = false;
let CLEAR_HISTORY_INTERVAL = 60;
let NEXT_HISTORY_CLEAR = -1;
let CASE_SENSITIVE_SEARCH = false;
let REGEX_SEARCH = false;
let OPEN_AT_CURSOR = false;
let SHOW_SEARCH_BAR = true;
let SHOW_PRIVATE_MODE = true;
let SHOW_SETTINGS_BUTTON = true;
let SHOW_CLEAR_HISTORY_BUTTON = true;
let SHOW_DELETE_BUTTON = true;
let SHOW_TAG_BUTTON = true;
let SHOW_PIN_BUTTON = true;
let SHOW_EDIT_BUTTON = true;
let SHOW_PREVIEW_BUTTON = true;
let COLORIZE_CLIPBOARD = true;
let FETCH_YOUTUBE_TITLES = true;
let VAULT_ENABLED = true;
let VAULT_COPY_TO_HISTORY = false;

export default class ClipboardIndicatorExtension extends Extension {
    enable() {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable() {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
        EXCLUDED_APPS = [];
    }
}

const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #_imagePreviewOverlay = null;

    destroy() {
        this._destroyed = true;
        if (this.urlMetadataManager) {
            this.urlMetadataManager.saveCache();
        }
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearDelayedSelectionTimeout();
        this.#clearTimeouts();
        this.#closeImagePreview();
        this._removeHistoryLabel();
        this._destroyNotifSource();
        this._destroyAutoLock();
        this.dialogManager.destroy();
        this.keyboard.destroy();
        this._cursorActor.destroy();
        this._cursorActor = null;

        super.destroy();
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === 3) { // Right Click
                this.openPasswordVault();
                return Clutter.EVENT_STOP;
            } else if (event.get_button() === 1) { // Left Click
                if (this.isVaultMode) {
                    this._showHistoryMenu();
                }
            }
        }
        return super.vfunc_event(event);
    }

    _init(extension) {
        super._init(0.0, "ClipboardIndicator");

        this._cursorActor = new Clutter.Actor({opacity: 0, width: 1, height: 1});
        Main.uiGroup.add_child(this._cursorActor);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen) {
                this.menu.sourceActor = this;
                if (this.isVaultMode) {
                    this._showHistoryMenu();
                }
            }
        });

        this.extension = extension;
        this._destroyed = false;
        this.registry = new Registry(extension);
        this.urlMetadataManager = new UrlMetadataManager(this.registry.REGISTRY_DIR);

        let vaultPath = '~/.config/clipboard-indicator/passwords.zip';
        try {
            vaultPath = extension.settings.get_string(PrefsFields.PASSWORD_VAULT_PATH) || vaultPath;
        } catch (e) {
            console.warn('Clipboard Indicator: password-vault-path fallback used', e);
        }
        this.vaultManager = new PasswordVaultManager(vaultPath);
        this.ignoreNextClipboardChange = false;
        this.isVaultMode = false;
        this.keyboard = new Keyboard();
        this._unlockedVaultPath = null;
        this._setupAutoLock();
        this._settingsChangedId = null;
        this._selectionOwnerChangedId = null;
        this._historyLabel = null;
        this._buttonText = null;
        this._disableDownArrow = null;

        this._shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];

        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });

        this.hbox = hbox;

        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add_child(this._downArrow);
        this.add_child(hbox);
        this._createHistoryLabel();
        this._loadSettings();

        if (CLEAR_ON_BOOT) this.registry.clearCacheFolder();

        this.dialogManager = new DialogManager();
        this._buildMenu().then(() => {
            if (this._destroyed) {
                return;
            }
            this._updateTopbarLayout();
            this._setupListener();
            this._setupHistoryIntervalClearing();
        });
    }

    #updateIndicatorContent(entry) {
        if (this.preventIndicatorUpdate || (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2)) {
            return;
        }

        if (!entry || PRIVATEMODE) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text("...");
        } else {
            if (entry.isURIList()) {
                const display = entry.getURIListDisplay();
                if (display) {
                    this._buttonText.set_text(
                        `${display.count} ${_('file(s) in')} ${this._truncate(display.commonPath || '/', MAX_TOPBAR_LENGTH)}`
                    );
                } else {
                    this._buttonText.set_text(_('(files)'));
                }
                this._buttonImgPreview.destroy_all_children();
            } else if (entry.isText()) {
                this._buttonText.set_text(this._truncate(entry.isPassword() ? entry.getMaskedValue() : entry.getStringValue(), MAX_TOPBAR_LENGTH));
                this._buttonImgPreview.destroy_all_children();
            } else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.registry.getEntryAsImage(entry).then(img => {
                    img.add_style_class_name('clipboard-indicator-img-preview');
                    img.y_align = Clutter.ActorAlign.CENTER;

                    // icon only renders properly in setTimeout for some arcane reason
                    this._imagePreviewTimeout = setTimeout(() => {
                        this._buttonImgPreview.set_child(img);
                    }, 0);
                });
            }
        }
    }

    _blinkIcon() {
        if (!BLINK_ICON_ON_COPY || !this.icon) {
            return;
        }

        // Set inverted colors
        this.set_style('background-color: rgba(255, 255, 255, 0.9);');
        this.icon.set_style('color: rgba(0, 0, 0, 0.9);');

        // Revert back to normal after delay
        this._blinkAnimationTimeout = setTimeout(() => {
            this._blinkAnimationTimeout = null;
            this.set_style(null);
            this.icon.set_style(null);
        }, 200);
    }

    async _buildMenu() {
        const clipHistory = await this._getCache();
        if (this._destroyed) {
            return;
        }
        let lastIdx = clipHistory.length - 1;
        let clipItemsArr = this.clipItemsRadioGroup;

        /* This create the search entry, which is add to a menuItem.
        The searchEntry is connected to the function for research.
        The menu itself is connected to some shitty hack in order to
        grab the focus of the keyboard. */
        this._entryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.searchEntry = new St.Entry({
            name: 'searchEntry',
            style_class: 'search-entry',
            can_focus: true,
            hint_text: _('Type here to search...'),
            track_hover: true,
            x_expand: true,
            y_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'})
        });

        this.searchEntry.get_clutter_text().connect(
            'text-changed',
            this._onSearchTextChanged.bind(this)
        );

        this._entryItem.add_child(this.searchEntry);

        this.menu.connect('open-state-changed', (self, open) => {
            this._setFocusOnOpenTimeout = setTimeout(() => {
                if (!open) return;

                if (this.isVaultMode && this.passwordVaultMenuSection) {
                    // Repack category buttons using the real (allocated) menu width
                    this.passwordVaultMenuSection._rebuildCategoryBar();
                }

                if (this._focusItemOnOpen) {
                    const item = this._focusItemOnOpen;
                    this._focusItemOnOpen = null;
                    global.stage.set_key_focus(item.actor);
                } else if (this.isVaultMode && this.passwordVaultMenuSection?.searchEntry) {
                    // Focus the vault search field as soon as the storage opens
                    global.stage.set_key_focus(this.passwordVaultMenuSection.searchEntry);
                } else if (SHOW_SEARCH_BAR && this.clipItemsRadioGroup.length > 0) {
                    this.searchEntry.set_text('');
                    global.stage.set_key_focus(this.searchEntry);
                } else if (this.clipItemsRadioGroup.length > 0) {
                    const currentItem = this._getCurrentlySelectedItem();
                    if (currentItem) global.stage.set_key_focus(currentItem.actor);
                } else if (SHOW_PRIVATE_MODE && this.privateModeMenuItem) {
                    global.stage.set_key_focus(this.privateModeMenuItem.actor);
                }
            }, 50);
        });

        // Create menu sections for items
        // Favorites
        this.favoritesSection = new PopupMenu.PopupMenuSection();

        this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
        this.favoritesScrollView = new St.ScrollView({
            style_class: 'ci-favorites-menu-section ci-history-menu-section',
            overlay_scrollbars: true,
            clip_to_allocation: true
        });
        this.favoritesScrollView.add_child(this.favoritesSection.actor);

        this.scrollViewFavoritesMenuSection.actor.add_child(this.favoritesScrollView);
        this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

        // History
        this.historySection = new PopupMenu.PopupMenuSection();

        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true,
            clip_to_allocation: true
        });
        this.historyScrollView.add_child(this.historySection.actor);

        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

        // Add separator
        this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

        // Add sections ordered according to settings
        if (PINNED_ON_BOTTOM) {
            this.menu.addMenuItem(this.scrollViewMenuSection);
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
        } else {
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
            this.menu.addMenuItem(this.scrollViewMenuSection);
        }

        // Private mode switch
        this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
            _("Private mode"), PRIVATEMODE, {reactive: true});
        this.privateModeMenuItem.connect('toggled',
            this._onPrivateModeSwitch.bind(this));
        this.privateModeMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'security-medium-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.menu.addMenuItem(this.privateModeMenuItem);

        // Add 'Clear' button which removes all items from cache
        this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );

        let timerBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });

        this.timerLabel = new St.Label({
            text: '',
            style: 'font-family: monospace;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });

        this.resetTimerButton = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Reset Timer'),
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'system-status-icon',
                icon_size: 14
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.resetTimerButton.connect('clicked', () => {
            this._scheduleNextHistoryClear();
        });

        timerBox.add_child(this.timerLabel);
        timerBox.add_child(this.resetTimerButton);
        this.clearMenuItem.add_child(timerBox);

        this.clearMenuItem.connect('activate', this._removeAll.bind(this));

        // Add 'Settings' menu item to open settings
        this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
        this.settingsMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.settingsMenuItem.connect('activate', this._openSettings.bind(this));

        // Empty state section
        this.emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.emptyStateSection.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER
        }));

        // Add cached items
        // Password Vault Menu Section
        if (!this.passwordVaultMenuSection) {
            const copyVaultCallback = (text) => {
                if (!text) return;
                if (VAULT_COPY_TO_HISTORY) {
                    // Let the normal clipboard watcher pick this up so the
                    // value lands in the main clipboard history too.
                    this.extension.clipboard.set_text(CLIPBOARD_TYPE, text);
                } else {
                    this.ignoreNextClipboardChange = true;
                    this.extension.clipboard.set_text(CLIPBOARD_TYPE, text);
                }
                if (NOTIFY_ON_COPY) {
                    this._showNotification(_("Copied from vault"));
                }
            };

            const closeMenuCallback = () => {
                if (this.menu && this.menu.isOpen) {
                    this.menu.close();
                }
            };

            this.passwordVaultMenuSection = new PasswordVaultMenuSection(
                this.vaultManager,
                copyVaultCallback,
                () => {
                    if (this.passwordVaultMenuSection) {
                        this.passwordVaultMenuSection.refreshUI();
                    }
                },
                closeMenuCallback,
                this.extension.settings
            );
            this.menu.addMenuItem(this.passwordVaultMenuSection);
        }
        this.passwordVaultMenuSection.actor.visible = this.isVaultMode;

        clipHistory.forEach(entry => this._addEntry(entry));

        if (lastIdx >= 0) {
            this._selectMenuItem(clipItemsArr[lastIdx]);
        }

        this.#showElements();
    }

    #hideElements() {
        if (this._destroyed) {
            return;
        }
        if (this.menu.box.contains(this._entryItem)) this.menu.box.remove_child(this._entryItem);
        if (this.menu.box.contains(this.favoritesSeparator)) this.menu.box.remove_child(this.favoritesSeparator);
        if (this.menu.box.contains(this.historySeparator)) this.menu.box.remove_child(this.historySeparator);
        if (this.clearMenuItem?.actor && this.menu.box.contains(this.clearMenuItem.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);
        if (this.settingsMenuItem?.actor && this.menu.box.contains(this.settingsMenuItem.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.emptyStateSection)) this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements() {
        if (this._destroyed) {
            return;
        }

        if (this.passwordVaultMenuSection?.actor) {
            this.passwordVaultMenuSection.actor.visible = this.isVaultMode;
        }

        if (this.isVaultMode) {
            if (this._entryItem?.actor) this._entryItem.actor.visible = false;
            if (this.scrollViewFavoritesMenuSection?.actor) this.scrollViewFavoritesMenuSection.actor.visible = false;
            if (this.scrollViewMenuSection?.actor) this.scrollViewMenuSection.actor.visible = false;
            if (this.privateModeMenuItem?.actor) this.privateModeMenuItem.actor.visible = false;
            if (this.clearMenuItem?.actor) this.clearMenuItem.actor.visible = false;
            if (this.settingsMenuItem?.actor) this.settingsMenuItem.actor.visible = false;
            if (this.favoritesSeparator?.actor) this.favoritesSeparator.actor.visible = false;
            if (this.historySeparator?.actor) this.historySeparator.actor.visible = false;
            if (this.emptyStateSection) this.emptyStateSection.visible = false;
            return;
        }

        if (this.scrollViewFavoritesMenuSection?.actor) this.scrollViewFavoritesMenuSection.actor.visible = true;
        if (this.scrollViewMenuSection?.actor) this.scrollViewMenuSection.actor.visible = true;

        // Remove empty-state if items exist
        if (this.clipItemsRadioGroup.length > 0 &&
            this.menu.box.contains(this.emptyStateSection)) {
            this.menu.box.remove_child(this.emptyStateSection);
        }

        // Search bar
        if (SHOW_SEARCH_BAR && !PRIVATEMODE) {
            if (!this.menu.box.contains(this._entryItem))
                this.menu.box.insert_child_at_index(this._entryItem, 0);
        } else {
            if (this.menu.box.contains(this._entryItem))
                this.menu.box.remove_child(this._entryItem);
        }

        // Keep the private-mode switch in place; only gate its visibility
        if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.visible = SHOW_PRIVATE_MODE;
        }

        // Favorites separator (between pinned/favorites and regular history)
        if (this.clipItemsRadioGroup.length > 0) {
            if (this.favoritesSection._getMenuItems().length > 0 && !PRIVATEMODE) {
                if (this.menu.box.contains(this.favoritesSeparator.actor) === false) {
                    // place it right above the section that comes second in the menu
                    const afterSection = PINNED_ON_BOTTOM
                        ? this.scrollViewFavoritesMenuSection
                        : this.scrollViewMenuSection;
                    const idx = this.menu.box.get_children().indexOf(afterSection.actor);
                    this.menu.box.insert_child_at_index(this.favoritesSeparator.actor, idx < 0 ? 0 : idx);
                }
            } else if (this.menu.box.contains(this.favoritesSeparator.actor) === true) {
                this.menu.box.remove_child(this.favoritesSeparator.actor);
            }
        }

        // History separator (between history and toggled buttons)
        if (this.clipItemsRadioGroup.length > 0 &&
            this.historySection._getMenuItems().length > 0 && !PRIVATEMODE &&
            (SHOW_PRIVATE_MODE || SHOW_SETTINGS_BUTTON || SHOW_CLEAR_HISTORY_BUTTON)) {
            if (!this.menu.box.contains(this.historySeparator.actor)) {
                const idx = this.menu.box.get_children().indexOf(this.scrollViewMenuSection.actor);
                this.menu.box.insert_child_at_index(this.historySeparator.actor, idx < 0 ? 0 : idx + 1);
            }
        } else if (this.menu.box.contains(this.historySeparator.actor)) {
            this.menu.box.remove_child(this.historySeparator.actor);
        }

        // If no items, render empty state and (if toggled on) only show Private/Settings
        if (this.clipItemsRadioGroup.length === 0) {
            if (!this.menu.box.contains(this.emptyStateSection))
                this.#renderEmptyState();
            // Re-append toggled buttons after the empty state
            if (this.menu.box.contains(this.settingsMenuItem?.actor))
                this.menu.box.remove_child(this.settingsMenuItem.actor);

            let index = this.menu.box.get_n_children(); // append after empty state
            if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
                this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
            return;
        }

        // Re-append toggled buttons at end in fixed order
        if (this.menu.box.contains(this.settingsMenuItem?.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.clearMenuItem?.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);

        let index = this.menu.box.get_n_children(); // append
        if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
            this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
        if (SHOW_CLEAR_HISTORY_BUTTON && this.clearMenuItem && !PRIVATEMODE)
            this.menu.box.insert_child_at_index(this.clearMenuItem.actor, index++);
    }

    #renderEmptyState() {
        if (this._destroyed) {
            return;
        }
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged() {

        // Text to be searched converted to lowercase if search is case insensitive
        let searchedText = this.searchEntry.get_text();
        if (!CASE_SENSITIVE_SEARCH) searchedText = searchedText.toLowerCase();

        if (searchedText === '') {
            this._getAllIMenuItems().forEach(function (mItem) {
                mItem.actor.visible = true;
            });
        } else {
            this._getAllIMenuItems().forEach((mItem) => {
                let text = mItem.clipContents;
                let tag = mItem.entry.getTag() || '';
                if (!CASE_SENSITIVE_SEARCH) {
                    text = text.toLowerCase();
                    tag = tag.toLowerCase();
                }

                let isMatching = false;
                if (REGEX_SEARCH) {
                    const flags = 'm' + (CASE_SENSITIVE_SEARCH ? '' : 'i');
                    const re = new RegExp(searchedText, flags);
                    isMatching = re.test(text) || re.test(tag);
                } else {
                    isMatching = text.includes(searchedText) || tag.includes(searchedText);
                }
                mItem.actor.visible = isMatching;
            });
        }
    }

    _truncate(string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        let chars = [...shortened]
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';

        return shortened;
    }

    _renderTwoLineBox(menuItem, line1Text, line2Text) {
        menuItem.label.hide();

        if (menuItem._twoLineBox) {
            if (menuItem.actor.contains(menuItem._twoLineBox)) {
                menuItem.actor.remove_child(menuItem._twoLineBox);
            }
            menuItem._twoLineBox = null;
        }

        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const line1 = new St.Label({
            text: line1Text,
            x_expand: true
        });
        box.add_child(line1);

        const line2 = new St.Label({
            text: line2Text,
            style_class: 'clipboard-second-line',
            x_expand: true
        });
        box.add_child(line2);

        if (menuItem.actionsSpacer && menuItem.actor.contains(menuItem.actionsSpacer)) {
            menuItem.actor.insert_child_below(box, menuItem.actionsSpacer);
        } else if (menuItem.label && menuItem.actor.contains(menuItem.label)) {
            menuItem.actor.insert_child_above(box, menuItem.label);
        } else {
            menuItem.actor.insert_child_at_index(box, 0);
        }

        menuItem._twoLineBox = box;
    }

    _setEntryLabel(menuItem) {
        const {entry} = menuItem;
        if (entry.isURIList()) {
            menuItem.label.hide();
            if (menuItem._twoLineBox) {
                if (menuItem.actor.contains(menuItem._twoLineBox)) {
                    menuItem.actor.remove_child(menuItem._twoLineBox);
                }
                menuItem._twoLineBox = null;
            }
            const display = entry.getURIListDisplay();
            if (display) {
                const box = new St.BoxLayout({vertical: true, x_expand: true});

                // Line 1: N file(s) in /path — truncate so a long path cannot
                // stretch the whole menu off-screen.
                const summaryLabel = new St.Label({
                    text: this._truncate(`${display.count} ${_('file(s) in')} ${display.commonPath || '/'}`, MAX_ENTRY_LENGTH),
                    x_expand: true
                });
                summaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(summaryLabel);

                // Line 2: file names — dedupe repeated URIs, show at most 5,
                // truncate to 80 chars, ellipsize as a second guard.
                const maxShown = 5;
                let shown = display.fileNames.filter((f, i) =>
                    f && display.fileNames.indexOf(f) === i).slice(0, maxShown);
                if (shown.length === 0) shown = display.fileNames.slice(0, maxShown);
                let fileText = shown.join(',  ');
                if (display.fileNames.length > maxShown) {
                    fileText += ', …';
                }
                if ([...fileText].length > 80) {
                    const chars = [...fileText];
                    fileText = chars.slice(0, 77).join('') + '…';
                }
                const fileNamesLabel = new St.Label({
                    text: fileText,
                    style_class: 'clipboard-second-line',
                    x_expand: true
                });
                fileNamesLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(fileNamesLabel);

                if (menuItem.actionsSpacer && menuItem.actor.contains(menuItem.actionsSpacer)) {
                    menuItem.actor.insert_child_below(box, menuItem.actionsSpacer);
                } else {
                    menuItem.actor.add_child(box);
                }
                menuItem._twoLineBox = box;
            }
        } else if (entry.isColor()) {
            menuItem.label.hide();
            if (menuItem._twoLineBox) {
                if (menuItem.actor.contains(menuItem._twoLineBox)) {
                    menuItem.actor.remove_child(menuItem._twoLineBox);
                }
                menuItem._twoLineBox = null;
            }
            const colorText = entry.getStringValue().trim();
            const cssColor = entry.needsHashPrefix(colorText) ? ('#' + colorText) : colorText;
            const box = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });

            const swatch = new St.Widget({
                style: `background-color: ${cssColor}; width: 36px; height: 18px; border: 1px solid rgba(255,255,255,0.4); border-radius: 2px; margin: 0 8px;`,
                y_align: Clutter.ActorAlign.CENTER
            });
            box.add_child(swatch);

            const label = new St.Label({
                text: this._truncate(colorText, MAX_ENTRY_LENGTH),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            box.add_child(label);

            if (menuItem.actionsSpacer && menuItem.actor.contains(menuItem.actionsSpacer)) {
                menuItem.actor.insert_child_below(box, menuItem.actionsSpacer);
            } else {
                menuItem.actor.add_child(box);
            }
            menuItem._twoLineBox = box;
        } else if (entry.isMultiline()) {
            menuItem.label.hide();

            const rawLines = entry.getStringValue().split('\n');
            // Trim whitespace and skip empty lines
            const nonEmptyLines = rawLines
                .map(l => l.trim())
                .filter(l => l.length > 0);

            const line1Text = nonEmptyLines.length > 0
                ? this._truncate(nonEmptyLines[0], MAX_ENTRY_LENGTH)
                : '';

            let line2Text = nonEmptyLines.length > 1
                ? this._truncate(nonEmptyLines[1], MAX_ENTRY_LENGTH)
                : '';

            if (nonEmptyLines.length > 2) {
                line2Text += `   (${nonEmptyLines.length} ${_('lines')})`;
            }

            this._renderTwoLineBox(menuItem, line1Text, line2Text);
        } else if (entry.isText()) {
            const rawText = entry.isPassword() ? entry.getMaskedValue() : entry.getStringValue();
            const urlText = rawText.trim();

            if (!entry.isPassword() && entry.isURL() && FETCH_YOUTUBE_TITLES &&
                this.urlMetadataManager && this.urlMetadataManager.canHandle(urlText)) {
                const cachedMeta = this.urlMetadataManager.getCachedMetadata(urlText);
                if (cachedMeta && cachedMeta.title) {
                    this._renderTwoLineBox(menuItem, this._truncate(urlText, MAX_ENTRY_LENGTH), this._truncate(cachedMeta.title, 80));
                } else {
                    if (menuItem._twoLineBox) {
                        if (menuItem.actor.contains(menuItem._twoLineBox)) {
                            menuItem.actor.remove_child(menuItem._twoLineBox);
                        }
                        menuItem._twoLineBox = null;
                    }
                    menuItem.label.show();
                    menuItem.label.set_text(this._truncate(rawText, MAX_ENTRY_LENGTH));

                    if (!cachedMeta || (!cachedMeta.title && !cachedMeta.failed)) {
                        this.urlMetadataManager.fetchMetadataAsync(urlText).then(meta => {
                            if (meta && meta.title && !this._destroyed && menuItem.actor) {
                                this._renderTwoLineBox(menuItem, this._truncate(urlText, MAX_ENTRY_LENGTH), this._truncate(meta.title, 80));
                            }
                        }).catch(e => {
                            console.error('Error fetching URL metadata:', e);
                        });
                    }
                }
            } else {
                if (menuItem._twoLineBox) {
                    if (menuItem.actor.contains(menuItem._twoLineBox)) {
                        menuItem.actor.remove_child(menuItem._twoLineBox);
                    }
                    menuItem._twoLineBox = null;
                }
                menuItem.label.show();
                menuItem.label.set_text(this._truncate(rawText, MAX_ENTRY_LENGTH));
            }
        } else if (entry.isImage()) {
            this.registry.getEntryAsImage(entry).then(img => {
                img.add_style_class_name('clipboard-menu-img-preview');
                if (menuItem.previewImage) {
                    menuItem.remove_child(menuItem.previewImage);
                }
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            });
        }
    }

    _updateTypeStyle(menuItem) {
        const TYPE_CLASSES = [
            'clipboard-type-file',
            'clipboard-type-color',
            'clipboard-type-url',
            'clipboard-type-email',
            'clipboard-type-image',
            'clipboard-type-multiline',
            'clipboard-type-password'
        ];
        TYPE_CLASSES.forEach(c => menuItem.actor.remove_style_class_name(c));

        if (!COLORIZE_CLIPBOARD) {
            return;
        }

        const {entry} = menuItem;
        if (entry.isURIList()) {
            menuItem.actor.add_style_class_name('clipboard-type-file');
        } else if (entry.isColor()) {
            menuItem.actor.add_style_class_name('clipboard-type-color');
        } else if (entry.isURL()) {
            menuItem.actor.add_style_class_name('clipboard-type-url');
        } else if (entry.isEmail()) {
            menuItem.actor.add_style_class_name('clipboard-type-email');
        } else if (entry.isImage()) {
            menuItem.actor.add_style_class_name('clipboard-type-image');
        } else if (entry.isMultiline()) {
            menuItem.actor.add_style_class_name('clipboard-type-multiline');
        }

        if (entry.isPassword()) {
            menuItem.actor.add_style_class_name('clipboard-type-password');
        }
    }

    _findNextMenuItem(currentMenutItem) {
        let currentIndex = this.clipItemsRadioGroup.indexOf(currentMenutItem);

        // for only one item
        if (this.clipItemsRadioGroup.length === 1) {
            return null;
        }

        // when focus is in middle of the displayed list
        for (let i = currentIndex - 1; i >= 0; i--) {
            let menuItem = this.clipItemsRadioGroup[i];
            if (menuItem.actor.visible) {
                return menuItem;
            }
        }

        // when focus is at the last element of the displayed list
        let beforeMenuItem = this.clipItemsRadioGroup[currentIndex + 1];
        if (beforeMenuItem.actor.visible) {
            return beforeMenuItem;
        }

        return null;
    }

    #selectNextMenuItem(menuItem) {
        let nextMenuItem = this._findNextMenuItem(menuItem);

        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        } else if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.grab_key_focus();
        }
    }

    _addEntry(entry, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = entry.getStringValue();
        menuItem.radioGroup = this.clipItemsRadioGroup;

        // CLICK fix for Paste on Select: clicking behaves like Enter
        menuItem.connect('activate', () => {
            if (PASTE_ON_SELECT) {
                this.#pasteItem(menuItem);
                this._onMenuItemSelectedAndMenuClose(menuItem, false);
            } else {
                this._onMenuItemSelectedAndMenuClose(menuItem, true);
            }
        });

        menuItem.connect('key-focus-in', () => {
            const viewToScroll = menuItem.entry.isFavorite() ?
                this.favoritesScrollView : this.historyScrollView;
            AnimationUtils.ensureActorVisibleInScrollView(viewToScroll, menuItem);
        });
        menuItem.actor.connect('key-press-event', (actor, event) => {
            switch (event.get_key_symbol()) {
                case Clutter.KEY_Delete:
                    if (menuItem.entry.isFavorite()) {
                        if (CONFIRM_ON_PINNED_DELETE) {
                            this._confirmRemovePinnedEntry(menuItem, true);
                        } else {
                            this.#selectNextMenuItem(menuItem);
                            this._removeEntry(menuItem, 'delete');
                        }
                    } else {
                        this.#selectNextMenuItem(menuItem);
                        this._removeEntry(menuItem, 'delete');
                    }
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_p:
                    this.#selectNextMenuItem(menuItem);
                    this._favoriteToggle(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_v:
                    this.#pasteItem(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_h:
                    if (entry.isImage()) {
                        this.#showImagePreview(entry, () => {
                            this._focusItemOnOpen = menuItem;
                            this.menu.open();
                        });
                        return Clutter.EVENT_STOP;
                    }
                    break;
                case Clutter.KEY_e:
                    if (entry.isText() && !entry.isURIList()) {
                        this.#showEditDialog(menuItem, true);
                        return Clutter.EVENT_STOP;
                    }
                    break;
                case Clutter.KEY_t:
                    this.#showTagDialog(menuItem, true);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_Return:
                    if (PASTE_ON_SELECT) {
                        this.#pasteItem(menuItem);
                        this._onMenuItemSelectedAndMenuClose(menuItem, false);
                    } else {
                        this._onMenuItemSelectedAndMenuClose(menuItem, true);
                    }
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._setEntryLabel(menuItem);

        // Type-based styling
        this._updateTypeStyle(menuItem);

        this.clipItemsRadioGroup.push(menuItem);

        if (entry.getTag()) {
            menuItem.tagLabel = new St.Label({
                text: entry.getTag(),
                style_class: 'ci-tag-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            menuItem.actor.add_child(menuItem.tagLabel);
        }

        menuItem.actionsSpacer = new St.Widget({
            x_expand: true,
        });
        menuItem.actor.add_child(menuItem.actionsSpacer);

        // Image preview button
        if (entry.isImage()) {
            menuItem.imagePreviewBtn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                accessible_name: _('Preview Image'),
                child: new St.Icon({
                    icon_name: 'image-x-generic-symbolic',
                    style_class: 'system-status-icon'
                }),
                visible: SHOW_PREVIEW_BUTTON,
                x_expand: false,
                y_expand: true,
            });
            menuItem.imagePreviewBtn.connect('clicked', () => this.#showImagePreview(entry));
            menuItem.actor.add_child(menuItem.imagePreviewBtn);
        }

        // Edit button (text entries only, not URI list)
        if (entry.isText() && !entry.isURIList()) {
            menuItem.editBtn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                accessible_name: _('Edit'),
                child: new St.Icon({
                    icon_name: 'document-edit-symbolic',
                    style_class: 'system-status-icon',
                }),
                visible: SHOW_EDIT_BUTTON,
                x_expand: false,
                y_expand: true,
            });
            menuItem.editBtn.connect('clicked', () => this.#showEditDialog(menuItem));
            menuItem.actor.add_child(menuItem.editBtn);
        }

        // Favorite button
        let iconfav = new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-pin-btn ci-action-btn',
            can_focus: true,
            child: iconfav,
            visible: SHOW_PIN_BUTTON,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        menuItem.favoritePressId = icofavBtn.connect('clicked',
            () => this._favoriteToggle(menuItem)
        );

        // Password toggle button (pinned text items only)
        if (entry.isText() && !entry.isURIList()) {
            const pwIcon = new St.Icon({
                icon_name: 'channel-insecure-symbolic',
                style_class: 'system-status-icon'
            });
            menuItem.passwordBtn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                accessible_name: _('Mark as password'),
                child: pwIcon,
                visible: entry.isFavorite(),
                x_expand: false,
                y_expand: true
            });
            menuItem.passwordBtn.connect('clicked', () => {
                entry.setPassword(!entry.isPassword());
                menuItem.passwordBtn.visible = entry.isFavorite();
                menuItem.passwordBtn.child.icon_name = entry.isPassword()
                    ? 'security-high-symbolic'
                    : 'channel-insecure-symbolic';
                menuItem.passwordBtn.accessible_name = entry.isPassword()
                    ? _('Unmark as password')
                    : _('Mark as password');
                this._setEntryLabel(menuItem);
                this.#updatePasswordStyle(menuItem);
                this._updateCache();
            });
            menuItem.actor.add_child(menuItem.passwordBtn);
        }

        // Paste button
        menuItem.pasteBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Paste'),
            child: new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon'
            }),
            x_expand: false,
            y_expand: true,
            visible: PASTE_BUTTON
        });

        menuItem.pasteBtn.connect('clicked',
            () => this.#pasteItem(menuItem)
        );

        menuItem.actor.add_child(menuItem.pasteBtn);

        // Tag button
        const tagIcon = new St.Icon({
            icon_name: 'user-bookmarks-symbolic',
            style_class: 'system-status-icon',
        });

        menuItem.tagBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: tagIcon,
            visible: SHOW_TAG_BUTTON,
            x_expand: false,
            y_expand: true,
        });
        menuItem.tagBtn.connect('clicked', () => this.#showTagDialog(menuItem));
        menuItem.actor.add_child(menuItem.tagBtn);

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: icon,
            visible: SHOW_DELETE_BUTTON,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('clicked',
            () => menuItem.entry.isFavorite()
                ? (CONFIRM_ON_PINNED_DELETE
                    ? this._confirmRemovePinnedEntry(menuItem)
                    : this._removeEntry(menuItem, 'delete'))
                : this._removeEntry(menuItem, 'delete')
        );

        if (entry.isFavorite()) {
            this.favoritesSection.addMenuItem(menuItem, 0);
        } else {
            this.historySection.addMenuItem(menuItem, 0);
        }

        if (autoSelect === true) {
            this._selectMenuItem(menuItem, autoSetClip);
        } else {
            menuItem.setOrnament(PopupMenu.Ornament.DOT);
            if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 0;
        }

        this.#showElements();
    }

    _favoriteToggle(menuItem) {
        menuItem.entry.favorite = menuItem.entry.isFavorite() ? false : true;
        this._moveItemFirst(menuItem);
        this._updateCache();
        this.#showElements();
    }

    _confirmRemovePinnedEntry(menuItem, selectNext = false) {
        const title = _("Delete pinned item?");
        const message = _("Are you sure you want to delete this pinned item?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Delete"), _("Cancel"), () => {
            if (selectNext) this.#selectNextMenuItem(menuItem);
            this._removeEntry(menuItem, 'delete');
        });
    }

    _confirmRemoveAll() {
        const title = _("Clear all?");
        const message = _("Are you sure you want to delete all clipboard items?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Clear"), _("Cancel"), () => {
                this._clearHistory();
            }
        );
    }

    _clearHistory(invokedAutomatically = false) {
        // Don't remove pinned items
        this.historySection._getMenuItems().forEach(mItem => {
            if (KEEP_SELECTED_ON_CLEAR === false || !mItem.currentlySelected) {
                this._removeEntry(mItem, 'delete');
            }
        });

        if (NOTIFY_ON_CLEAR) {
            const message = invokedAutomatically
                ? _("Clipboard history cleared automatically")
                : _("Clipboard history cleared");
            this._showNotification(message);
        }
    }

    _removeAll() {
        if (PRIVATEMODE) return;

        if (CONFIRM_ON_CLEAR) {
            this._confirmRemoveAll();
        } else {
            this._clearHistory();
        }
    }

    _removeEntry(menuItem, event) {
        let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

        if (event === 'delete' && menuItem.currentlySelected) {
            this.#clearClipboard();
        }

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(itemIdx, 1);

        if (menuItem.entry.isImage()) {
            this.registry.deleteEntryFile(menuItem.entry);
        }

        this._updateCache();
        this.#showElements();
    }

    _removeOldestEntries() {
        let clipItemsRadioGroupNoFavorite = this.clipItemsRadioGroup.filter(
            item => item.entry.isFavorite() === false);

        const origSize = clipItemsRadioGroupNoFavorite.length;

        while (clipItemsRadioGroupNoFavorite.length > MAX_REGISTRY_LENGTH) {
            let oldestNoFavorite = clipItemsRadioGroupNoFavorite.shift();
            this._removeEntry(oldestNoFavorite);

            clipItemsRadioGroupNoFavorite = this.clipItemsRadioGroup.filter(
                item => item.entry.isFavorite() === false);
        }

        if (clipItemsRadioGroupNoFavorite.length < origSize) {
            this._updateCache();
        }
    }

    #updatePasswordStyle(menuItem) {
        if (COLORIZE_CLIPBOARD && menuItem.entry.isPassword()) {
            menuItem.actor.add_style_class_name('clipboard-type-password');
        } else {
            menuItem.actor.remove_style_class_name('clipboard-type-password');
        }
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelected(menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem(menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose(menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }

        // Ensure MOVE_ITEM_FIRST also applies when PASTE_ON_SELECT fast-path skips _refreshIndicator()
        if (PASTE_ON_SELECT && MOVE_ITEM_FIRST && !menuItem.entry.isFavorite()) {
            this._moveItemFirst(menuItem);
        }

        menuItem.menu.close();
    }

    _getCache() {
        return this.registry.read();
    }

    #addToCache(entry) {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite())
            .concat([entry]);
        this.registry.write(entries);
    }

    _updateCache() {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite());

        this.registry.write(entries);
    }

    async _onSelectionChange(selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            this._refreshIndicator();
        }
    }

    async _refreshIndicator() {
        if (PRIVATEMODE || this._destroyed) return; // Private mode, do not.
        if (this.ignoreNextClipboardChange) {
            this.ignoreNextClipboardChange = false;
            return;
        }

        const focussedWindow = Shell.Global.get().display.focusWindow;
        const wmClass = focussedWindow?.get_wm_class();

        if (wmClass && EXCLUDED_APPS.includes(wmClass)) return; // Excluded app, do not.

        if (this.#refreshInProgress) return;
        this.#refreshInProgress = true;

        try {
            const result = await this.#getClipboardContent();
            if (this._destroyed) {
                return;
            }

            if (result) {
                for (let menuItem of this.clipItemsRadioGroup) {
                    if (menuItem.entry.equals(result)) {
                        this._selectMenuItem(menuItem, false);

                        if (!menuItem.entry.isFavorite() && MOVE_ITEM_FIRST) {
                            this._moveItemFirst(menuItem);
                        }

                        return;
                    }
                }

                this.#addToCache(result);
                this._addEntry(result, true, false);
                this._removeOldestEntries();
                if (NOTIFY_ON_COPY) {
                    this._showNotification(_("Copied to clipboard"), notif => {
                        notif.addAction(_('Cancel'), this._cancelNotification);
                    });
                }
                this._blinkIcon();
            }
        } catch (e) {
            console.error('Clipboard Indicator: Failed to refresh indicator');
            console.error(e);
        } finally {
            this.#refreshInProgress = false;
        }
    }

    _moveItemFirst(item) {
        this._removeEntry(item);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _findItem(text) {
        return this.clipItemsRadioGroup.filter(
            item => item.clipContents === text)[0];
    }

    _getCurrentlySelectedItem() {
        return this.clipItemsRadioGroup.find(item => item.currentlySelected);
    }

    _getAllIMenuItems() {
        return this.historySection._getMenuItems().concat(this.favoritesSection._getMenuItems());
    }

    _setupListener() {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking(selection) {
        this.selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
            this._onSelectionChange(selection, selectionType, selectionSource);
        });
    }

    _setupHistoryIntervalClearing() {
        this._fetchSettings();

        if (this._intervalSettingChangedId) {
            this.extension.settings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }
        if (this._intervalToggleChangedId) {
            this.extension.settings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        this._intervalSettingChangedId = this.extension.settings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this)
        );
        this._intervalToggleChangedId = this.extension.settings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_ON_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this)
        );

        if (!CLEAR_HISTORY_ON_INTERVAL) {
            this._updateIntervalTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);

        if (NEXT_HISTORY_CLEAR === -1) { //new timer
            this._scheduleNextHistoryClear();
        } else if (NEXT_HISTORY_CLEAR < currentTime) { //timer expired
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        } else { //timer already set, but not expired
            // Clean up existing timers before reassigning
            if (this._historyClearTimeoutId) {
                clearTimeout(this._historyClearTimeoutId);
                this._historyClearTimeoutId = null;
            }
            if (this._timerIntervalId) {
                clearInterval(this._timerIntervalId);
                this._timerIntervalId = null;
            }

            const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;
            this._historyClearTimeoutId = setTimeout(() => {
                this._clearHistory(true);
                this._scheduleNextHistoryClear();
            }, timeoutMs);
            this._timerIntervalId = setInterval(() => {
                this._updateIntervalTimer();
            }, 1000);
        }
    }

    _onHistoryIntervalClearSettingsChanged(_settings, key) {
        this._fetchSettings();
        if (key === PrefsFields.CLEAR_HISTORY_INTERVAL) {
            this._scheduleNextHistoryClear();
        } else if (key === PrefsFields.CLEAR_HISTORY_ON_INTERVAL) {
            if (CLEAR_HISTORY_ON_INTERVAL) {
                this._resetHistoryClearTimer();
                this._setupHistoryIntervalClearing();
            } else {
                this._resetHistoryClearTimer();
            }
        }
    }

    _scheduleNextHistoryClear() {
        this._fetchSettings();

        clearInterval(this._timerIntervalId);
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        if (!CLEAR_HISTORY_ON_INTERVAL) {
            this._resetHistoryClearTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);
        NEXT_HISTORY_CLEAR = currentTime + CLEAR_HISTORY_INTERVAL * 60;
        const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;

        this.extension.settings.set_int64(PrefsFields.NEXT_HISTORY_CLEAR, NEXT_HISTORY_CLEAR);

        this._updateIntervalTimer();
        this._timerIntervalId = setInterval(() => {
            this._updateIntervalTimer();
        }, 1000);

        this._historyClearTimeoutId = setTimeout(() => {
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        }, timeoutMs);
    }

    _resetHistoryClearTimer() {
        //basically just reset and stop the timer
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }
        clearInterval(this._timerIntervalId);
        this._timerIntervalId = null;
        this._updateIntervalTimer();
        this.extension.settings.set_int64(PrefsFields.NEXT_HISTORY_CLEAR, -1);
    }

    _updateIntervalTimer() {
        this._fetchSettings();
        this.resetTimerButton.visible = CLEAR_HISTORY_ON_INTERVAL;
        this.timerLabel.visible = CLEAR_HISTORY_ON_INTERVAL;
        if (!CLEAR_HISTORY_ON_INTERVAL) return;


        let currentTime = Math.ceil(new Date().getTime() / 1000);
        let timeLeft = NEXT_HISTORY_CLEAR - currentTime;

        if (timeLeft <= 0) {
            this.timerLabel.set_text('');
            return;
        }

        let hours = Math.floor(timeLeft / 3600);
        let minutes = Math.floor((timeLeft % 3600) / 60);
        let seconds = Math.floor(timeLeft % 60);

        let formattedTime = '';
        if (hours > 0) {
            formattedTime += `${hours}h `;
        }
        if (minutes > 0) {
            formattedTime += `${minutes}m `;
        }
        formattedTime += `${seconds}s`;
        this.timerLabel.set_text(formattedTime);
    }

    _openSettings() {
        this.extension.openSettings();
        this.menu.close();
    }

    _initNotifSource() {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });

            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });

            Main.messageTray.add(this._notifSource);
        }
    }

    _destroyNotifSource() {
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
    }

    _cancelNotification() {
        if (this.clipItemsRadioGroup.length >= 2) {
            let clipSecond = this.clipItemsRadioGroup.length - 2;
            let previousClip = this.clipItemsRadioGroup[clipSecond];
            this.#updateClipboard(previousClip.entry);
            previousClip.setOrnament(PopupMenu.Ornament.DOT);
            previousClip.icoBtn.visible = false;
            previousClip.currentlySelected = true;
        } else {
            this.#clearClipboard();
        }
        let clipFirst = this.clipItemsRadioGroup.length - 1;
        this._removeEntry(this.clipItemsRadioGroup[clipFirst]);
    }

    _showNotification(message, transformFn) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (PRIVATEMODE || dndOn()) {
            return;
        }

        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        } else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        this._notifSource.addNotification(notification);
    }

    _createHistoryLabel() {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_child(this._historyLabel);

        this._historyLabel.hide();
    }

    _removeHistoryLabel() {
        if (this._historyLabel) {
            if (this._historyLabel.get_parent()) {
                global.stage.remove_child(this._historyLabel);
            }
            this._historyLabel.destroy();
            this._historyLabel = null;
        }
    }

    togglePrivateMode() {
        this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch() {
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            let selectList = this.clipItemsRadioGroup.filter((item) => !!item.currentlySelected);

            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                this.#clearClipboard();
            }

            this.#getClipboardContent().then(entry => {
                if (!entry) return;
                this.#updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this.hbox.remove_style_class_name('private-mode');
            this.#showElements();
        } else {
            this.hbox.add_style_class_name('private-mode');
            this.#updateIndicatorContent(null);
            this.#showElements();
        }
    }

    _loadSettings() {
        this._settingsChangedId = this.extension.settings.connect('changed',
            this._onSettingsChange.bind(this));

        this._fetchSettings();

        if (ENABLE_KEYBINDING)
            this._bindShortcuts();
    }

    _fetchSettings() {
        const {settings} = this.extension;
        MAX_REGISTRY_LENGTH = settings.get_int(PrefsFields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH = settings.get_int(PrefsFields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE = settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED = settings.get_boolean(PrefsFields.DELETE);
        MOVE_ITEM_FIRST = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        NOTIFY_ON_COPY = settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        NOTIFY_ON_CYCLE = settings.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
        NOTIFY_ON_CLEAR = settings.get_boolean(PrefsFields.NOTIFY_ON_CLEAR);
        CONFIRM_ON_CLEAR = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        CONFIRM_ON_PINNED_DELETE = settings.get_boolean(PrefsFields.CONFIRM_ON_PINNED_DELETE);
        ENABLE_KEYBINDING = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE = settings.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        CLEAR_ON_BOOT = settings.get_boolean(PrefsFields.CLEAR_ON_BOOT);
        PASTE_ON_SELECT = settings.get_boolean(PrefsFields.PASTE_ON_SELECT);
        DISABLE_DOWN_ARROW = settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        BLINK_ICON_ON_COPY = settings.get_boolean(PrefsFields.BLINK_ICON_ON_COPY);
        STRIP_TEXT = settings.get_boolean(PrefsFields.STRIP_TEXT);
        KEEP_SELECTED_ON_CLEAR = settings.get_boolean(PrefsFields.KEEP_SELECTED_ON_CLEAR);
        PASTE_BUTTON = settings.get_boolean(PrefsFields.PASTE_BUTTON);
        PINNED_ON_BOTTOM = settings.get_boolean(PrefsFields.PINNED_ON_BOTTOM);
        CACHE_IMAGES = settings.get_boolean(PrefsFields.CACHE_IMAGES);
        EXCLUDED_APPS = settings.get_strv(PrefsFields.EXCLUDED_APPS);
        CLEAR_HISTORY_ON_INTERVAL = settings.get_boolean(PrefsFields.CLEAR_HISTORY_ON_INTERVAL);
        CLEAR_HISTORY_INTERVAL = settings.get_int(PrefsFields.CLEAR_HISTORY_INTERVAL);
        NEXT_HISTORY_CLEAR = settings.get_int64(PrefsFields.NEXT_HISTORY_CLEAR);
        CASE_SENSITIVE_SEARCH = settings.get_boolean(PrefsFields.CASE_SENSITIVE_SEARCH);
        REGEX_SEARCH = settings.get_boolean(PrefsFields.REGEX_SEARCH);
        OPEN_AT_CURSOR = settings.get_boolean(PrefsFields.OPEN_AT_CURSOR);
        SHOW_SEARCH_BAR = settings.get_boolean(PrefsFields.SHOW_SEARCH_BAR);
        SHOW_PRIVATE_MODE = settings.get_boolean(PrefsFields.SHOW_PRIVATE_MODE);
        SHOW_SETTINGS_BUTTON = settings.get_boolean(PrefsFields.SHOW_SETTINGS_BUTTON);
        SHOW_CLEAR_HISTORY_BUTTON = settings.get_boolean(PrefsFields.SHOW_CLEAR_HISTORY_BUTTON);
        SHOW_DELETE_BUTTON = settings.get_boolean(PrefsFields.SHOW_DELETE_BUTTON);
        SHOW_TAG_BUTTON = settings.get_boolean(PrefsFields.SHOW_TAG_BUTTON);
        SHOW_PIN_BUTTON = settings.get_boolean(PrefsFields.SHOW_PIN_BUTTON);
        SHOW_EDIT_BUTTON = settings.get_boolean(PrefsFields.SHOW_EDIT_BUTTON);
        SHOW_PREVIEW_BUTTON = settings.get_boolean(PrefsFields.SHOW_PREVIEW_BUTTON);
        COLORIZE_CLIPBOARD = settings.get_boolean(PrefsFields.COLORIZE_CLIPBOARD);
        FETCH_YOUTUBE_TITLES = settings.get_boolean(PrefsFields.FETCH_YOUTUBE_TITLES);
        VAULT_ENABLED = settings.get_boolean(PrefsFields.VAULT_ENABLED);
        VAULT_COPY_TO_HISTORY = settings.get_boolean(PrefsFields.VAULT_COPY_TO_HISTORY);
    }

    async _onSettingsChange() {
        try {
            // Load the settings into variables
            this._fetchSettings();

            // If the vault got disabled while it was open, drop back to the
            // regular clipboard list.
            if (!VAULT_ENABLED && this.isVaultMode) {
                this._showHistoryMenu();
            }

            // If the toggle is hidden but private mode is on, force it off now
            if (!SHOW_PRIVATE_MODE && PRIVATEMODE && this.privateModeMenuItem) {
                this.privateModeMenuItem.setToggleState(false);
                this._onPrivateModeSwitch();
            }

            // Remove old entries in case the registry size changed
            this._removeOldestEntries();

            // Re-set menu-items lables in case preview size changed
            this._getAllIMenuItems().forEach(mItem => {
                this._setEntryLabel(mItem);
                this._updateTypeStyle(mItem);
                mItem.pasteBtn.visible = PASTE_BUTTON;
                mItem.icoBtn.visible = SHOW_DELETE_BUTTON;
                mItem.tagBtn.visible = SHOW_TAG_BUTTON;
                mItem.icofavBtn.visible = SHOW_PIN_BUTTON;
                if (mItem.editBtn) mItem.editBtn.visible = SHOW_EDIT_BUTTON;
                if (mItem.imagePreviewBtn) mItem.imagePreviewBtn.visible = SHOW_PREVIEW_BUTTON;
            });

            //update topbar
            this._updateTopbarLayout();
            this.#updateIndicatorContent(await this.#getClipboardContent());

            // Bind or unbind shortcuts
            if (ENABLE_KEYBINDING)
                this._bindShortcuts();
            else
                this._unbindShortcuts();

            // Respect UI toggles
            this.#showElements();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update registry');
            console.error(e);
        }
    }

    _bindShortcuts() {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
        this._bindShortcut(PrefsFields.BINDING_PRIVATE_MODE, this.togglePrivateMode);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_PASSWORD_VAULT, this.openPasswordVault);
    }

    async openPasswordVault() {
        if (!VAULT_ENABLED) {
            return;
        }

        const vaultPath = this.extension.settings.get_string(PrefsFields.PASSWORD_VAULT_PATH);
        if (vaultPath) {
            this.vaultManager.setZipPath(vaultPath);
        }

        if (this.menu && this.menu.isOpen) {
            this.menu.close();
        }

        // The vault file moved while we were unlocked: require the master
        // password again instead of silently writing to the new path.
        if (this.vaultManager.isUnlocked() &&
            this._unlockedVaultPath &&
            this._unlockedVaultPath !== this.vaultManager.zipPath) {
            this.vaultManager.lock();
            this._unlockedVaultPath = null;
        }

        if (!this.vaultManager.isUnlocked()) {
            const dialog = new MasterPasswordDialog(
                _('Password Vault'),
                _('Enter the master password to unlock:'),
                async (pwd) => {
                    // Let exceptions reach the dialog: it displays e.message.
                    await this.vaultManager.unlock(pwd);
                    this._unlockedVaultPath = this.vaultManager.zipPath;
                    return true;
                }
            );
            dialog.connect('closed', () => {
                if (this.vaultManager.isUnlocked()) {
                    this._showVaultMenu();
                }
            });
            dialog.open();
        } else {
            this._showVaultMenu();
        }
    }

    _setupAutoLock() {
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
                this._screenSaverSignalId = proxy.connectSignal('Locked', () => this._autoLockVault());
            }
        } catch (e) {
            console.warn('Clipboard Indicator: cannot subscribe to screen lock:', e);
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
                            this._autoLockVault();
                        }
                    }
                );
            }
        } catch (e) {
            console.warn('Clipboard Indicator: cannot subscribe to suspend:', e);
        }
    }

    _destroyAutoLock() {
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

    _autoLockVault() {
        if (!this.vaultManager || !this.vaultManager.isUnlocked()) {
            return;
        }
        if (this.menu && this.menu.isOpen) {
            this.menu.close();
        }
        this.vaultManager.lock();
        this._unlockedVaultPath = null;
        if (!this._destroyed) {
            Main.notify(_('Password Vault'), _('The password vault has been locked.'));
        }
    }

    _showVaultMenu() {
        if (this._setFocusOnOpenTimeout) {
            clearTimeout(this._setFocusOnOpenTimeout);
            this._setFocusOnOpenTimeout = null;
        }
        this._focusItemOnOpen = null;

        this.isVaultMode = true;

        if (this.passwordVaultMenuSection) {
            this.passwordVaultMenuSection.refreshUI();
        }
        this.#showElements();

        if (!this.menu.isOpen) {
            this.menu.open();
        }
    }

    _showHistoryMenu() {
        this.isVaultMode = false;
        this.#showElements();
    }

    _unbindShortcuts() {
        this._shortcutsBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutsBindingIds = [];
    }

    _bindShortcut(name, cb) {
        Main.wm.addKeybinding(
            name,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            cb.bind(this)
        );

        this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout() {
        if (TOPBAR_DISPLAY_MODE === 0) {
            this.icon.visible = true;
            this._buttonText.visible = false;
            this._buttonImgPreview.visible = false;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 1) {
            this.icon.visible = false;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 2) {
            this.icon.visible = true;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 3) {
            this.hide();
        }
        if (!DISABLE_DOWN_ARROW) {
            this._downArrow.visible = true;
        } else {
            this._downArrow.visible = false;
        }
    }

    _disconnectSettings() {
        if (!this._settingsChangedId)
            return;

        this.extension.settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;

        if (this._intervalSettingChangedId) {
            this.extension.settings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }

        if (this._intervalToggleChangedId) {
            this.extension.settings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }

        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }
    }

    _disconnectSelectionListener() {
        if (!this._selectionOwnerChangedId)
            return;

        this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearDelayedSelectionTimeout() {
        if (this._delayedSelectionTimeoutId) {
            clearInterval(this._delayedSelectionTimeoutId);
        }
    }

    _selectEntryWithDelay(entry) {
        this._selectMenuItem(entry, false);

        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._selectMenuItem(entry);  //select the item
            this._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    _previousEntry() {
        if (PRIVATEMODE) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed

                if (NOTIFY_ON_CYCLE) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                }
                if (MOVE_ITEM_FIRST) {
                    this._selectEntryWithDelay(menuItems[i]);
                } else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _nextEntry() {
        if (PRIVATEMODE) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                     //index to be displayed

                if (NOTIFY_ON_CYCLE) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                }
                if (MOVE_ITEM_FIRST) {
                    this._selectEntryWithDelay(menuItems[i]);
                } else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _toggleMenu() {
        if (!this.menu.isOpen && OPEN_AT_CURSOR) {
            const [x, y] = global.get_pointer();
            this._cursorActor.set_position(x, y);
            this.menu.sourceActor = this._cursorActor;
        }
        this.menu.toggle();
    }


    #pasteItem(menuItem) {
        this.menu.close();
        const currentlySelected = this._getCurrentlySelectedItem();
        this.preventIndicatorUpdate = true;
        this.#updateClipboard(menuItem.entry);
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            } else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this.preventIndicatorUpdate = false;
                if (currentlySelected && currentlySelected.entry)
                    this.#updateClipboard(currentlySelected.entry);
            }, 50);
        }, 50);
    }

    #showImagePreview(entry, onClose = null) {
        this.#closeImagePreview();
        this.menu.close();

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

        this.#_imagePreviewOverlay = overlay;
        global.stage.add_child(overlay);
        overlay.grab_key_focus();

        const close = () => {
            this.#closeImagePreview();
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

        this.registry.getEntryAsTexture(entry).then(actor => {
            if (this.#_imagePreviewOverlay !== overlay) return;
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

    #showTagDialog(menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
        };

        const textEntry = new St.Entry({
            text: menuItem.entry.getTag() || '',
            hint_text: _('Enter tag…'),
            can_focus: true,
            x_expand: true,
            style: 'min-width: 300px;',
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
                this._updateTagLabel(menuItem);
                this._updateCache();
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        dialog.open();
        textEntry.grab_key_focus();
    }

    _updateTagLabel(menuItem) {
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
            menuItem.actor.insert_child_above(menuItem.tagLabel, menuItem.label);
        }
    }

    #showEditDialog(menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
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
            editable: true,
            reactive: true,
            single_line_mode: false,
            activatable: false,
            line_wrap: true,

        });

        const white = new Cogl.Color();
        white.init_from_4f(1.0, 1.0, 1.0, 1.0);
        const selectionBlue = new Cogl.Color();
        selectionBlue.init_from_4f(0.39, 0.59, 1.0, 0.71);
        clutterText.color = white;
        clutterText.selection_color = selectionBlue;
        clutterText.selected_text_color = white;

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
                this._setEntryLabel(menuItem);
                this._updateCache();
                if (menuItem.currentlySelected)
                    this.#updateClipboard(menuItem.entry);
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        if (reopenOnClose) this.menu.close();
        dialog.open();
        clutterText.grab_key_focus();
    }

    #closeImagePreview() {
        if (!this.#_imagePreviewOverlay) return;

        const overlay = this.#_imagePreviewOverlay;
        this.#_imagePreviewOverlay = null;

        if (overlay._previewClickId) overlay.disconnect(overlay._previewClickId);
        if (overlay._previewKeyId) overlay.disconnect(overlay._previewKeyId);

        if (overlay.get_parent()) global.stage.remove_child(overlay);
        overlay.destroy();
    }

    #clearTimeouts() {
        if (this._imagePreviewTimeout) clearTimeout(this._imagePreviewTimeout);
        if (this._setFocusOnOpenTimeout) clearTimeout(this._setFocusOnOpenTimeout);
        if (this._pastingKeypressTimeout) clearTimeout(this._pastingKeypressTimeout);
        if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
        if (this._historyClearTimeoutId) clearTimeout(this._historyClearTimeoutId);
        if (this._timerIntervalId) clearInterval(this._timerIntervalId);
        if (this._blinkAnimationTimeout) clearTimeout(this._blinkAnimationTimeout);
    }

    #clearClipboard() {
        this.extension.clipboard.set_text(CLIPBOARD_TYPE, "");
        this.#updateIndicatorContent(null);
    }

    #updateClipboard(entry) {
        this.extension.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        this.#updateIndicatorContent(entry);
    }

    async #getClipboardContent() {
        if (this._destroyed) return null;

        const mimetypes = [
            'text/uri-list',
            'text/plain;charset=utf-8',
            "UTF8_STRING",
            "text/plain",
            "STRING",
            'image/gif',
            'image/png',
            'image/jpg',
            'image/jpeg',
            'image/webp',
            'image/svg+xml',
            'text/html',
        ];

        for (let type of mimetypes) {
            if (this._destroyed) return null;

            let result = await new Promise(resolve => {
                let resolved = false;
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(null);
                    }
                }, 200);

                try {
                    this.extension.clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                        if (resolved) return;
                        resolved = true;
                        clearTimeout(timeoutId);

                        if (this._destroyed || bytes === null || bytes.get_size() === 0) {
                            resolve(null);
                            return;
                        }

                        if (type === "UTF8_STRING") {
                            type = "text/plain;charset=utf-8";
                        }

                        try {
                            const entry = new ClipboardEntry(type, bytes.get_data(), false);
                            if (CACHE_IMAGES && entry.isImage()) {
                                this.registry.writeEntryFile(entry);
                            }
                            resolve(entry);
                        } catch (err) {
                            resolve(null);
                        }
                    });
                } catch (err) {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        resolve(null);
                    }
                }
            });

            if (result) {
                if (!CACHE_IMAGES && result.isImage()) {
                    return null;
                } else {
                    return result;
                }
            }
        }

        return null;
    }
});