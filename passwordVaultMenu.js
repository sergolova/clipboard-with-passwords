import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ServiceEditDialog } from './passwordVaultDialog.js';
import { PrefsFields } from './constants.js';
import { ALL_CATEGORY } from './passwordVault.js';
import { themeColors } from './theme.js';

// A hidden (password / isHidden) field value that starts or ends with
// whitespace (space, tab, line breaks) or a non-printable character
// (control chars, zero-width space, BOM, …) is almost always a typo the user
// cannot see behind the dots — flag it with a warning icon. The flag is
// opt-in (see PasswordVaultMenuSection._hiddenEdgeWarning), off by default.
const INVISIBLE_EDGE_RE = /^[\s\u0000-\u001F\u007F-\u009F\u200B\u200C\u200D\uFEFF]|[\s\u0000-\u001F\u007F-\u009F\u200B\u200C\u200D\uFEFF]$/;

export class PasswordVaultMenuSection extends PopupMenu.PopupMenuSection {
    constructor(vaultManager, copyToClipboardCallback, refreshCallback, closeMenuCallback, extensionSettings = null, dialogTracker = null) {
        super();

        this.vaultManager = vaultManager;
        this.copyToClipboardCallback = copyToClipboardCallback; // fn(text)
        this.refreshCallback = refreshCallback; // fn() to refresh UI
        this.closeMenuCallback = closeMenuCallback; // fn() to close popup menu
        this.settings = extensionSettings;
        this.dialogTracker = dialogTracker; // fn(dialog) -> register an open vault dialog

        this.currentQuery = '';
        this.selectedCategory = ALL_CATEGORY;
        this.serviceCardEntries = []; // Array of { item, actor }
        this._revealHint = null; // "Type to reveal services…" label (hide-All mode)

        this._buildUI();
    }

    get _pinRecent() {
        if (this.settings) {
            try {
                return this.settings.get_boolean(PrefsFields.VAULT_PIN_RECENT);
            } catch (e) {
            }
        }
        return true;
    }

    get _hideAllCategory() {
        if (this.settings) {
            try {
                return this.settings.get_boolean(PrefsFields.VAULT_HIDE_ALL_CATEGORY);
            } catch (e) {
            }
        }
        return false;
    }

    get _hiddenEdgeWarning() {
        if (this.settings) {
            try {
                return this.settings.get_boolean(PrefsFields.VAULT_HIDDEN_EDGE_WARNING);
            } catch (e) {
            }
        }
        // Off by default: the warning icon is a metadata side-channel about
        // the secret value (it reveals that the value has edge junk to anyone
        // viewing the screen), so it is opt-in.
        return false;
    }

    refreshUI() {
        const visibleCatCount = this.vaultManager.getCategories()
            .filter(cat => this._categoryCount(cat) > 0).length;
        const barCatCount = (this.categoryButtons ? this.categoryButtons.length : 1) - 1; // minus ALL_CATEGORY
        if (barCatCount !== visibleCatCount) {
            this._rebuildCategoryBar();
        } else {
            this._updateCategoryButtonsUI();
        }
        this._updateRecentBanner();
        this._renderAllCards();
    }

    _rebuildCategoryBar() {
        if (!this.catWrapBox) return;
        this.catWrapBox.destroy_all_children();
        this.categoryButtons = [];

        const categories = [ALL_CATEGORY, ...this.vaultManager.getCategories().filter(cat => this._categoryCount(cat) > 0)];
        // Reset the filter if the selected category no longer has any services
        if (this.selectedCategory !== ALL_CATEGORY && !categories.includes(this.selectedCategory)) {
            this.selectedCategory = ALL_CATEGORY;
        }
        // Measuring a button's preferred width needs a theme node, which only
        // exists while the popup actor is in the stage. The button must ALSO be
        // attached to the tree first: measuring a detached button makes
        // st_widget_get_theme_node spew "not in the stage" + g_signal_connect_object
        // criticals. Off-stage we fall back to a text-length estimate; the
        // open-state-changed repack re-measures with the real allocated width.
        const inStage = this.catWrapBox.get_stage() !== null;
        // Diagnostic: confirms whether the build ran in/off stage and which
        // branch (estimate vs real measurement) was used.
        // log(`[clipboard-with-passwords] category bar rebuild: inStage=${inStage} categories=${categories.length}`);
        const available = inStage && this.catWrapBox.get_width() > 0
            ? this.catWrapBox.get_width()
            : 450;

        let currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
        this.catWrapBox.add_child(currentRowBox);

        const c = themeColors();
        let currentWidth = 0;
        categories.forEach(cat => {
            const labelText = this._categoryButtonLabel(cat);
            let btn = new St.Button({
                label: labelText,
                style_class: 'button',
                style: `padding: 2px 8px; font-size: 11px; border-radius: 4px; background-color: ${c.catBg}; color: ${c.catText};`
            });
            this.categoryButtons.push({ cat, btn });

            btn.connect('clicked', () => {
                this.selectedCategory = cat;
                this._updateCategoryButtonsUI();
                this._applyFilter();
            });

            // Attach before measuring: a detached button has no stage ancestor.
            currentRowBox.add_child(btn);

            // Rough estimate: ~7px per character + 16px horizontal padding.
            let btnWidth = Math.max(64, labelText.length * 7 + 22);
            if (inStage) {
                try {
                    const pref = btn.get_preferred_width(-1);
                    btnWidth = pref[1] || btnWidth;
                } catch (e) {
                }
            }
            btnWidth += 4; // inter-button spacing

            if (currentWidth > 0 && currentWidth + btnWidth > available) {
                // Button was placed on the wrong row — move it to a fresh one.
                currentRowBox.remove_child(btn);
                currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
                this.catWrapBox.add_child(currentRowBox);
                currentRowBox.add_child(btn);
                currentWidth = 0;
            }
            currentWidth += btnWidth;
        });
        this._updateCategoryButtonsUI();
    }

    _updateCategoryButtonsUI() {
        if (!this.categoryButtons) return;
        // Styling (style_class/style) must only touch widgets that are in the
        // stage: off stage those setters can still trigger theme-node access.
        // The menu-open repack (_rebuildCategoryBar) re-applies the styles.
        const inStage = this.catWrapBox && this.catWrapBox.get_stage() !== null;
        const c = themeColors();
        this.categoryButtons.forEach(({ cat, btn }) => {
            const isSelected = cat === this.selectedCategory;
            btn.set_label(this._categoryButtonLabel(cat));
            if (!inStage) return;
            btn.style_class = isSelected ? 'button button-active' : 'button';
            btn.style = `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                isSelected ? `background-color: ${c.catBgSelected}; color: ${c.catTextSelected}; font-weight: bold;` : `background-color: ${c.catBg}; color: ${c.catText};`
            }`;
        });
    }

    // In "hide All" mode the counts are suppressed too, so a shoulder-surfer
    // can't learn how many services are stored.
    _categoryButtonLabel(cat) {
        const name = cat === ALL_CATEGORY ? _('All') : cat;
        if (this._hideAllCategory) {
            return name;
        }
        return `${name} (${this._categoryCount(cat)})`;
    }

    _categoryCount(cat) {
        return this.vaultManager.getItems('', cat).length;
    }

    _buildUI() {
        this.removeAll();
        this.serviceCardEntries = [];

        let container = new St.BoxLayout({
            vertical: true,
            style_class: 'password-vault-menu-container',
            // max-width caps the whole menu: without it one very long field
            // value stretches every card and the popup becomes absurdly wide.
            style: 'spacing: 8px; padding: 8px; min-width: 380px; max-width: 480px;'
        });

        let itemContainer = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'password-vault-menu-item'
        });
        itemContainer.actor.add_child(container);
        this.addMenuItem(itemContainer);

        // 1. RECENT SERVICE BANNER (Зона последнего использованного сервиса)
        this.recentBox = new St.BoxLayout({
            vertical: true,
            style: `background-color: ${themeColors().bannerBg}; border-radius: 8px; padding: 8px; margin-bottom: 6px; border: 1px solid ${themeColors().bannerBorder};`
        });
        container.add_child(this.recentBox);
        this._updateRecentBanner();

        // 2. SEARCH BAR & ADD BUTTON
        let topBar = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' });

        this.searchEntry = new St.Entry({
            hint_text: '🔍 ' + _('Search by name or login…'),
            text: this.currentQuery,
            style: 'padding: 4px 8px; font-size: 13px;'
        });
        // A non-empty, unfocused search field also trips the
        // "clutter_input_focus_is_focused" criticals on first layout (e.g. when
        // the vault reopens with a leftover query). Keep it non-editable until
        // first interaction / until it gets focused by the caller on open.
        this.searchEntry.clutter_text.editable = false;
        this.searchEntry.clutter_text.connect('button-press-event', () => {
            this.searchEntry.clutter_text.editable = true;
        });
        this.searchEntry.clutter_text.connect('key-press-event', () => {
            this.searchEntry.clutter_text.editable = true;
        });
        this.searchEntry.set_x_expand(true);
        this.searchEntry.clutter_text.connect('text-changed', () => {
            this.currentQuery = this.searchEntry.get_text();
            this._applyFilter();
        });
        topBar.add_child(this.searchEntry);

        let clearSearchBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 4px 8px;',
            accessible_name: _('Clear search'),
            child: new St.Icon({icon_name: 'edit-clear-symbolic', icon_size: 12})
        });
        clearSearchBtn.connect('clicked', () => {
            this.searchEntry.set_text('');
            this.searchEntry.clutter_text.editable = true;
            global.stage.set_key_focus(this.searchEntry);
        });
        topBar.add_child(clearSearchBtn);

        let addBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 4px 10px;',
            accessible_name: _('Add service'),
            child: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 12})
        });
        addBtn.connect('clicked', () => {
            this._openEditDialog(null);
        });
        topBar.add_child(addBtn);

        container.add_child(topBar);

        // 3. CATEGORIES FILTER BAR (WRAPPING LAYOUT)
        this.catWrapBox = new St.BoxLayout({ vertical: true, style: 'spacing: 4px; margin-top: 4px;' });
        container.add_child(this.catWrapBox);
        this._rebuildCategoryBar();

        // 4. ITEMS LIST (SCROLLABLE)
        this.itemsScrollView = new St.ScrollView({
            style: 'max-height: 380px; margin-top: 6px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
        });

        this.itemsBox = new St.BoxLayout({ vertical: true, style: 'spacing: 8px;' });
        this.itemsScrollView.set_child(this.itemsBox);
        container.add_child(this.itemsScrollView);

        this._renderAllCards();
    }

    _updateRecentBanner() {
        this.recentBox.destroy_all_children();
        const recent = this.vaultManager.recentService;
        if (!recent || !this._pinRecent) {
            this.recentBox.hide();
            return;
        }

        this.recentBox.show();
        let recentHeader = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 4px; spacing: 6px;' });

        let recentEditBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 0 4px;',
            accessible_name: _('Edit recent service'),
            child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 12})
        });
        recentEditBtn.connect('clicked', () => {
            this._openEditDialog(recent, 'name');
        });
        recentHeader.add_child(recentEditBtn);

        let recentNameLabel = new St.Label({
            text: recent.name,
            style: `font-weight: bold; font-size: 13px; color: ${themeColors().accent};`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        recentNameLabel.set_x_expand(true);
        recentNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        recentHeader.add_child(recentNameLabel);

        let clearRecentBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 0 4px;',
            accessible_name: _('Clear recent service'),
            child: new St.Icon({icon_name: 'edit-clear-symbolic', icon_size: 12})
        });
        clearRecentBtn.connect('clicked', () => {
            this.vaultManager.setRecentService(null);
            this._updateRecentBanner();
        });
        recentHeader.add_child(clearRecentBtn);

        this.recentBox.add_child(recentHeader);

        if (recent.login) {
            this.recentBox.add_child(this._createFieldRow(recent, _('Login'), recent.login, 'login'));
        }
        if (recent.password) {
            this.recentBox.add_child(this._createFieldRow(recent, _('Password'), recent.password, 'password', true));
        }
        if (recent.extraFields && recent.extraFields.length > 0) {
            recent.extraFields.forEach((f, idx) => {
                if (f.value) {
                    this.recentBox.add_child(this._createFieldRow(recent, f.label || _('Extra field'), f.value, `extra_${idx}`, !!f.isHidden));
                }
            });
        }
    }

    resetSearch() {
        if (!this.currentQuery && (!this.searchEntry || this.searchEntry.get_text() === '')) {
            return;
        }
        this.currentQuery = '';
        if (this.searchEntry) {
            this.searchEntry.set_text('');
        }
        this._applyFilter();
    }

    _renderAllCards() {
        this.itemsBox.destroy_all_children();
        this.serviceCardEntries = [];
        this._revealHint = null;

        const items = this.vaultManager.getItems('', ''); // All items

        if (items.length === 0) {
            let emptyLabel = new St.Label({
                text: _('Vault is empty. Press + to add a service.'),
                style: `color: ${themeColors().hint}; font-size: 12px; padding: 16px;`,
                x_align: Clutter.ActorAlign.CENTER
            });
            this.itemsBox.add_child(emptyLabel);
            return;
        }

        items.forEach(item => {
            const cardActor = this._createServiceCard(item);
            this.itemsBox.add_child(cardActor);
            this.serviceCardEntries.push({ item, actor: cardActor });
        });

        this._applyFilter();
    }

    _applyFilter() {
        const q = (this.currentQuery || '').toLowerCase();
        const cat = this.selectedCategory;

        let visibleCount = 0;
        this.serviceCardEntries.forEach(({ item, actor }) => {
            let matchCat = (cat === ALL_CATEGORY || item.category === cat);
            if (cat === ALL_CATEGORY && this._hideAllCategory && !q) {
                matchCat = false;
            }
            let matchQuery = true;

            if (q) {
                const matchName = item.name && item.name.toLowerCase().includes(q);
                const matchLogin = item.login && item.login.toLowerCase().includes(q);
                const matchCategory = item.category && item.category.toLowerCase().includes(q);
                const matchDescription = item.description && item.description.toLowerCase().includes(q);
                const matchExtra = item.extraFields && item.extraFields.some(f =>
                    (f.label && f.label.toLowerCase().includes(q)) ||
                    (f.value && f.value.toLowerCase().includes(q))
                );
                matchQuery = matchName || matchLogin || matchCategory || matchDescription || matchExtra;
            }

            const visible = matchCat && matchQuery;
            actor.visible = visible;
            if (visible) visibleCount++;
        });

        // In "hide All" mode the cards are hidden until the user searches;
        // show a neutral hint instead of a wall of nothing. The hint appears
        // at the bottom of the list and is removed as soon as the user types
        // (i.e. once any search takes effect), whatever the results are.
        const showRevealHint = this._hideAllCategory &&
            cat === ALL_CATEGORY &&
            !q &&
            this.serviceCardEntries.length > 0;
        if (showRevealHint && !this._revealHint) {
            this._revealHint = new St.Label({
                text: _('Type to reveal services…'),
                style: `color: ${themeColors().hint}; font-size: 12px; padding: 16px;`,
                x_align: Clutter.ActorAlign.CENTER
            });
            this.itemsBox.add_child(this._revealHint);
        } else if (!showRevealHint && this._revealHint) {
            this._revealHint.destroy();
            this._revealHint = null;
        }
    }

    _createServiceCard(item) {
        const c = themeColors();
        let card = new St.BoxLayout({
            vertical: true,
            style: `background-color: ${c.cardBg}; border-radius: 6px; padding: 8px; border: 1px solid ${c.cardBorder};`
        });

        // Title bar: [категория] название
        let titleBar = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 4px; spacing: 6px;' });

        if (item.category) {
            let catLabel = new St.Label({
                text: `[${item.category}]`,
                style: `font-size: 11px; color: ${c.secondary};`,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.START
            });
            titleBar.add_child(catLabel);
        }

        let nameLabel = new St.Label({
            text: item.name,
            style: 'font-weight: bold; font-size: 13px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        nameLabel.set_x_expand(true);
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBar.add_child(nameLabel);

        let copyAllBtn = new St.Button({
            style_class: 'button',
            can_focus: false,
            accessible_name: _('Copy all'),
            style: 'padding: 2px 6px;',
            child: new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 12
            })
        });
        copyAllBtn.connect('clicked', () => {
            this.vaultManager.setRecentService(item);
            const lines = [];
            if (item.login) lines.push(`${_('Login')}: ${item.login}`);
            if (item.password) lines.push(`${_('Password')}: ${item.password}`);
            if (item.extraFields && item.extraFields.length > 0) {
                item.extraFields.forEach(f => {
                    if (f.label || f.value) {
                        lines.push(`${f.label || _('Extra field')}: ${f.value || ''}`);
                    }
                });
            }
            this.copyToClipboardCallback(lines.join('\n'));
            this._updateRecentBanner();
        });
        titleBar.add_child(copyAllBtn);

        let editCardBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 2px 6px;',
            accessible_name: _('Edit service'),
            child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 12})
        });
        editCardBtn.connect('clicked', () => {
            this._openEditDialog(item, 'name');
        });
        titleBar.add_child(editCardBtn);

        card.add_child(titleBar);

        // Description (1 line, not copyable)
        if (item.description) {
            let descLabel = new St.Label({
                text: item.description,
                style: `font-size: 12px; color: ${c.desc}; padding: 0 2px; margin-bottom: 2px;`,
                y_align: Clutter.ActorAlign.START,
                x_align: Clutter.ActorAlign.START,
                x_expand: true
            });
            descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            card.add_child(descLabel);
        }

        // Login row
        if (item.login) {
            card.add_child(this._createFieldRow(item, _('Login'), item.login, 'login'));
        }

        // Password row
        if (item.password) {
            card.add_child(this._createFieldRow(item, _('Password'), item.password, 'password', true));
        }

        // Extra fields
        if (item.extraFields && item.extraFields.length > 0) {
            item.extraFields.forEach((field, index) => {
                card.add_child(this._createFieldRow(item, field.label || `${_('Extra')} ${index + 1}`, field.value, `extra_${index}`, !!field.isHidden));
            });
        }

        return card;
    }

    _createFieldRow(item, labelStr, valueStr, fieldName = 'name', isPassword = false) {
        let rowBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 4px; border-radius: 4px; margin: 1px 0;',
            can_focus: true,
            reactive: true
        });

        let row = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 8px;',
            x_expand: true
        });
        rowBtn.set_child(row);

        let showState = { hidden: isPassword };

        let labelWidget = new St.Label({
            text: `${labelStr}:`,
            style: `font-size: 11px; color: ${themeColors().key};`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        labelWidget.set_width(70);

        let valueWidget = new St.Label({
            text: isPassword ? '••••••••' : valueStr,
            style: 'font-size: 12px; font-weight: bold; margin-left: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        valueWidget.set_x_expand(true);
        // Never let one long stored value widen the card/menu: truncate with
        // an ellipsis inside the row's allocated width (full value is still
        // copied on click and visible in the edit dialog).
        valueWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        row.add_child(labelWidget);
        row.add_child(valueWidget);

        // Warn about leading/trailing junk in the stored value: invisible
        // whitespace or non-printable chars at the edges are a common typo
        // (Ctrl+V artifact, stray space) that stays hidden behind the dots.
        // Opt-in (vault-hidden-edge-warning, default off) — the icon also
        // leaks metadata about the secret to onlookers.
        if (isPassword && this._hiddenEdgeWarning && INVISIBLE_EDGE_RE.test(valueStr)) {
            let warnIcon = new St.Icon({
                icon_name: 'dialog-warning-symbolic',
                icon_size: 14,
                style: `color: ${themeColors().warn};`,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: _('Warning: value has hidden leading or trailing characters')
            });
            row.add_child(warnIcon);
        }

        if (isPassword) {
            let toggleBtn = new St.Button({
                style_class: 'button',
                style: 'padding: 1px 4px;',
                accessible_name: _('Reveal value'),
                child: new St.Icon({
                    icon_name: 'view-reveal-symbolic',
                    icon_size: 12
                })
            });
            toggleBtn.connect('clicked', () => {
                showState.hidden = !showState.hidden;
                valueWidget.set_text(showState.hidden ? '••••••••' : valueStr);
                toggleBtn.child.icon_name = showState.hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic';
                toggleBtn.accessible_name = showState.hidden ? _('Reveal value') : _('Hide value');
            });
            row.add_child(toggleBtn);
        }

        let editBtn = new St.Button({
            style_class: 'button',
            style: 'padding: 1px 4px;',
            accessible_name: _('Edit value'),
            child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 12})
        });
        editBtn.connect('clicked', () => {
            this._openEditDialog(item, fieldName);
        });
        row.add_child(editBtn);

        // Click row to copy to clipboard safely
        rowBtn.connect('clicked', () => {
            this.vaultManager.setRecentService(item);
            this.copyToClipboardCallback(valueStr);
            this._updateRecentBanner();
        });

        return rowBtn;
    }

    _openEditDialog(item, focusFieldName = 'name') {
        // CLOSE MENU FIRST to avoid Clutter double-modal / popup grab deadlock!
        if (this.closeMenuCallback) {
            this.closeMenuCallback();
        }

        let dialog = new ServiceEditDialog(
            item,
            this.vaultManager.getCategories(),
            async (savedData) => {
                try {
                    if (item) {
                        await this.vaultManager.updateService(item.id, savedData);
                    } else {
                        await this.vaultManager.addService(savedData);
                    }
                    if (this.refreshCallback) this.refreshCallback();
                } catch (e) {
                    this._notifySaveError(e);
                }
            },
            async (deleteId) => {
                try {
                    await this.vaultManager.deleteService(deleteId);
                    if (this.refreshCallback) this.refreshCallback();
                } catch (e) {
                    this._notifySaveError(e);
                }
            },
            focusFieldName
        );
        if (this.dialogTracker) {
            this.dialogTracker(dialog);
        }
        dialog.open();
    }

    _notifySaveError(e) {
        let msg = (e && e.message && typeof e.message === 'string' && e.message.length > 0)
            ? e.message
            : _('Failed to save the password vault.');
        Main.notify(_('Password Vault'), msg);
    }
}