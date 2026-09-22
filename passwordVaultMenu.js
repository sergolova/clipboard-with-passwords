import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { ServiceEditDialog } from './passwordVaultDialog.js';

export class PasswordVaultMenuSection extends PopupMenu.PopupMenuSection {
    constructor(vaultManager, copyToClipboardCallback, refreshCallback, closeMenuCallback) {
        super();

        this.vaultManager = vaultManager;
        this.copyToClipboardCallback = copyToClipboardCallback; // fn(text)
        this.refreshCallback = refreshCallback; // fn() to refresh UI
        this.closeMenuCallback = closeMenuCallback; // fn() to close popup menu

        this.currentQuery = '';
        this.selectedCategory = 'Все';
        this.serviceCardEntries = []; // Array of { item, actor }

        this._buildUI();
    }

    refreshUI() {
        const visibleCatCount = this.vaultManager.getCategories()
            .filter(cat => this._categoryCount(cat) > 0).length;
        const barCatCount = (this.categoryButtons ? this.categoryButtons.length : 1) - 1; // minus "Все"
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

        const categories = ['Все', ...this.vaultManager.getCategories().filter(cat => this._categoryCount(cat) > 0)];
        // Reset the filter if the selected category no longer has any services
        if (this.selectedCategory !== 'Все' && !categories.includes(this.selectedCategory)) {
            this.selectedCategory = 'Все';
        }
        // Use the real allocated width when the popup is open; otherwise the
        // popup auto-sizes to its content, so full-width rows are safe.
        const available = this.catWrapBox.get_width() > 0
            ? this.catWrapBox.get_width()
            : 450;

        let currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
        this.catWrapBox.add_child(currentRowBox);

        let currentWidth = 0;
        categories.forEach(cat => {
            const labelText = `${cat === 'Все' ? _('All') : cat} (${this._categoryCount(cat)})`;
            let btn = new St.Button({
                label: labelText,
                style_class: 'button',
                style: 'padding: 2px 8px; font-size: 11px; border-radius: 4px; background-color: rgba(255,255,255,0.1); color: #eeeeee;'
            });
            this.categoryButtons.push({ cat, btn });

            btn.connect('clicked', () => {
                this.selectedCategory = cat;
                this._updateCategoryButtonsUI();
                this._applyFilter();
            });

            let btnWidth = 64;
            try {
                const pref = btn.get_preferred_width(-1);
                btnWidth = pref[1] || pref.natural_size || 64;
            } catch (e) {
            }
            btnWidth += 4; // inter-button spacing

            if (currentWidth > 0 && currentWidth + btnWidth > available) {
                currentRowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });
                this.catWrapBox.add_child(currentRowBox);
                currentWidth = 0;
            }
            currentRowBox.add_child(btn);
            currentWidth += btnWidth;
        });
        this._updateCategoryButtonsUI();
    }

    _updateCategoryButtonsUI() {
        if (!this.categoryButtons) return;
        this.categoryButtons.forEach(({ cat, btn }) => {
            const isSelected = cat === this.selectedCategory;
            btn.set_label(`${cat === 'Все' ? _('All') : cat} (${this._categoryCount(cat)})`);
            btn.style_class = isSelected ? 'button button-active' : 'button';
            btn.style = `padding: 2px 8px; font-size: 11px; border-radius: 4px; ${
                isSelected ? 'background-color: #3584e4; color: #ffffff; font-weight: bold;' : 'background-color: rgba(255,255,255,0.1); color: #eeeeee;'
            }`;
        });
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
            style: 'spacing: 8px; padding: 8px; min-width: 380px;'
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
            style: 'background-color: rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 8px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.15);'
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
        this.searchEntry.set_x_expand(true);
        this.searchEntry.clutter_text.connect('text-changed', () => {
            this.currentQuery = this.searchEntry.get_text();
            this._applyFilter();
        });
        topBar.add_child(this.searchEntry);

        let clearSearchBtn = new St.Button({
            label: '✖',
            style_class: 'button',
            style: 'padding: 4px 8px; font-size: 11px;'
        });
        clearSearchBtn.connect('clicked', () => {
            this.searchEntry.set_text('');
            global.stage.set_key_focus(this.searchEntry);
        });
        topBar.add_child(clearSearchBtn);

        let addBtn = new St.Button({
            label: '➕',
            style_class: 'button',
            style: 'padding: 4px 10px; font-weight: bold;'
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
        if (!recent) {
            this.recentBox.hide();
            return;
        }

        this.recentBox.show();
        let recentHeader = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 4px; spacing: 6px;' });

        let recentEditBtn = new St.Button({
            label: '✏️',
            style_class: 'button',
            style: 'padding: 0 4px; font-size: 10px;'
        });
        recentEditBtn.connect('clicked', () => {
            this._openEditDialog(recent, 'name');
        });
        recentHeader.add_child(recentEditBtn);

        let recentNameLabel = new St.Label({
            text: recent.name,
            style: 'font-weight: bold; font-size: 13px; color: #4af;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        recentNameLabel.set_x_expand(true);
        recentNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        recentHeader.add_child(recentNameLabel);

        let clearRecentBtn = new St.Button({
            label: '✖',
            style_class: 'button',
            style: 'padding: 0 4px; font-size: 10px;'
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

    _renderAllCards() {
        this.itemsBox.destroy_all_children();
        this.serviceCardEntries = [];

        const items = this.vaultManager.getItems('', ''); // All items

        if (items.length === 0) {
            let emptyLabel = new St.Label({
                text: _('Vault is empty. Press + to add a service.'),
                style: 'color: #888888; font-size: 12px; padding: 16px;',
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
            let matchCat = (cat === 'Все' || item.category === cat);
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
    }

    _createServiceCard(item) {
        let card = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(255, 255, 255, 0.04); border-radius: 6px; padding: 8px; border: 1px solid rgba(255,255,255,0.08);'
        });

        // Title bar: [категория] название
        let titleBar = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 4px; spacing: 6px;' });

        let catLabel = new St.Label({
            text: `[${item.category}]`,
            style: 'font-size: 11px; color: #888888;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START
        });
        titleBar.add_child(catLabel);

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
            label: '✏️',
            style_class: 'button',
            style: 'padding: 2px 6px; font-size: 11px;'
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
                style: 'font-size: 12px; color: #bbbbbb; padding: 0 2px; margin-bottom: 2px;',
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
            style: 'font-size: 11px; color: #aaaaaa;',
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

        row.add_child(labelWidget);
        row.add_child(valueWidget);

        if (isPassword) {
            let toggleBtn = new St.Button({
                label: '👁️',
                style_class: 'button',
                style: 'padding: 1px 4px; font-size: 11px;'
            });
            toggleBtn.connect('clicked', () => {
                showState.hidden = !showState.hidden;
                valueWidget.set_text(showState.hidden ? '••••••••' : valueStr);
                toggleBtn.set_label(showState.hidden ? '👁️' : '🙈');
            });
            row.add_child(toggleBtn);
        }

        let editBtn = new St.Button({
            label: '✏️',
            style_class: 'button',
            style: 'padding: 1px 4px; font-size: 11px;'
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
                if (item) {
                    await this.vaultManager.updateService(item.id, savedData);
                } else {
                    await this.vaultManager.addService(savedData);
                }
                if (this.refreshCallback) this.refreshCallback();
            },
            async (deleteId) => {
                await this.vaultManager.deleteService(deleteId);
                if (this.refreshCallback) this.refreshCallback();
            },
            focusFieldName
        );
        dialog.open();
    }
}
