import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { PrefsFields, DEFAULT_VAULT_PATH, DEFAULT_VAULT_PATH_7Z } from './constants.js';

// The vault-format notice under the path entry is a live status message, not
// a normal settings row: it is glued to the entry (no separator line between
// them), tinted so it reads as feedback instead of a regular row, and the
// state icon sits on the left. The classes are toggled in
// `_updateVaultFormatStatus()`.
const VAULT_STATUS_CSS = `
row.vault-path-row { border-bottom: none; }
row.vault-status-row { background-color: alpha(@accent_bg_color, 0.10); }
row.vault-status-row.vault-status-warning { background-color: alpha(@warning_bg_color, 0.16); }
.vault-status-icon { color: @accent_color; }
.vault-status-warning .vault-status-icon { color: @warning_color; }
`;

export default class ClipboardIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow (window) {
        window._settings = this.getSettings();
        // Load the styles shaping the vault-format notice before any widget is
        // built, so the classes take effect on the first layout.
        const cssProvider = new Gtk.CssProvider();
        cssProvider.load_from_string(VAULT_STATUS_CSS);
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(), cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        const settingsUI = new Settings(window._settings, window);

        const tabs = [
            { title: _('UI'),            iconName: 'view-grid-symbolic',               groups: [settingsUI.ui, settingsUI.item_actions] },
            { title: _('Behavior'),      iconName: 'system-run-symbolic',              groups: [settingsUI.behavior] },
            { title: _('Search'),        iconName: 'system-search-symbolic',           groups: [settingsUI.search] },
            { title: _('Limits'),        iconName: 'preferences-system-symbolic',      groups: [settingsUI.limits] },
            { title: _('Exclusion'),     iconName: 'action-unavailable-symbolic',      groups: [settingsUI.exclusion] },
            { title: _('Topbar'),        iconName: 'edit-paste-symbolic',              groups: [settingsUI.topbar] },
            { title: _('Notifications'), iconName: 'emoji-objects-symbolic',           groups: [settingsUI.notifications] },
            { title: _('Shortcuts'),     iconName: 'input-keyboard-symbolic',          groups: [settingsUI.shortcuts] },
            { title: _('Password Vault'),iconName: 'dialog-password-symbolic',         groups: [settingsUI.password_vault] },
        ];

        window.set_default_size(700, 650);

        for (const { title, iconName, groups } of tabs) {
            const page = new Adw.PreferencesPage({ title, icon_name: iconName });
            groups.forEach(g => page.add(g));
            window.add(page);
        }
    }
}

class Settings {
    constructor (schema, window) {
        this.schema = schema;
        // Parent window for modal dialogs (the file chooser); may be null
        // when the prefs page is embedded without one.
        this.window = window || null;

        this.field_size = new Adw.SpinRow({
            title: _("History Size"),
            subtitle: _("Maximum number of entries to keep in clipboard history"),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10000,
                step_increment: 1
            })
        });

        this.field_preview_size = new Adw.SpinRow({
            title: _("Preview Size (characters)"),
            subtitle: _("Number of characters shown per entry in the history menu"),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 1
            })
        });

        this.field_cache_size = new Adw.SpinRow({
            title: _("Max cache file size (MB)"),
            subtitle: _("Maximum disk space used for caching clipboard data"),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1024,
                step_increment: 1
            })
        });

        this.field_topbar_preview_size = new Adw.SpinRow({
            title: _("Number of characters in top bar"),
            subtitle: _("Length of the clipboard content preview shown in the panel"),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1
            })
        });

        this.field_display_mode = new Adw.ComboRow({
            title: _("What to show in top bar"),
            model: this.#createDisplayModeOptions()
        });

        this.field_disable_down_arrow = new Adw.SwitchRow({
            title: _("Remove down arrow in top bar"),
            subtitle: _("Hide the dropdown arrow next to the clipboard indicator")
        });

        this.field_blink_icon_on_copy = new Adw.SwitchRow({
            title: _("Blink icon on copy"),
            subtitle: _("Briefly flash the indicator icon when something is copied")
        });

        this.field_cache_disable = new Adw.SwitchRow({
            title: _("Cache only pinned items"),
            subtitle: _("Only save pinned (favorite) entries to disk")
        });

        this.field_copy_notification_toggle = new Adw.SwitchRow({
            title: _("Show notification on copy"),
            subtitle: _("Display a notification each time text is copied")
        });

        this.field_cycle_notification_toggle = new Adw.SwitchRow({
            title: _("Show notification on cycle"),
            subtitle: _("Display a notification when cycling through entries with shortcuts")
        });

        this.field_clear_notification_toggle = new Adw.SwitchRow({
            title: _("Show notification on Clear History"),
            subtitle: _("Display a notification when clipboard history is cleared")
        });

        this.field_confirm_clear_toggle = new Adw.SwitchRow({
            title: _("Prompt for confirmation on Clear History"),
            subtitle: _("Ask before deleting all clipboard entries")
        });

        this.field_confirm_pinned_delete_toggle = new Adw.SwitchRow({
            title: _("Prompt before deleting pinned item"),
            subtitle: _("Ask for confirmation before deleting a pinned item")
        });

        this.field_strip_text = new Adw.SwitchRow({
            title: _("Remove spaces around text"),
            subtitle: _("Strip leading and trailing spaces from text entries on copy")
        });

        this.field_strip_line_breaks = new Adw.SwitchRow({
            title: _("Remove line breaks around text"),
            subtitle: _("Strip leading and trailing line breaks from text entries on copy")
        });

        this.field_move_item_first = new Adw.SwitchRow({
            title: _("Move item to the top after selection"),
            subtitle: _("When selecting an entry, bring it to the top of the history")
        });

        this.field_keep_selected_on_clear = new Adw.SwitchRow({
            title: _("Keep selected entry after Clear History"),
            subtitle: _("The currently active clipboard entry will not be removed when clearing history")
        });

        this.field_pinned_on_bottom = new Adw.SwitchRow({
            title: _("Place the pinned section on the bottom"),
            subtitle: _("Move the pinned section to the bottom of the menu. Requires re-login")
        });

        this.field_show_search_bar = new Adw.SwitchRow({
            title: _("Show Search Bar"),
            subtitle: _("Display a search field at the top of the clipboard menu")
        });
        this.field_show_private_mode = new Adw.SwitchRow({
            title: _("Show Private Mode"),
            subtitle: _("Display the private mode toggle in the clipboard menu")
        });
        this.field_show_settings_button = new Adw.SwitchRow({
            title: _("Show Settings Button"),
            subtitle: _("Display a shortcut to these settings in the clipboard menu")
        });
        this.field_show_clear_history_button = new Adw.SwitchRow({
            title: _("Show Clear History Button"),
            subtitle: _("Display the clear history button in the clipboard menu")
        });

        this.field_clear_on_boot = new Adw.SwitchRow({
            title: _("Clear clipboard history on system reboot"),
            subtitle: _("Delete all cached clipboard entries when the system starts")
        });

        this.field_paste_on_select = new Adw.SwitchRow({
            title: _("Paste on select"),
            subtitle: _("Automatically paste the entry into the active window when selected")
        });

        this.field_open_at_cursor = new Adw.SwitchRow({
            title: _("Open menu at cursor"),
            subtitle: _("When using the keyboard shortcut, open the menu at the cursor position")
        });

        this.field_show_delete_button = new Adw.SwitchRow({
            title: _("Delete"),
            subtitle: _("Show the delete button on each item")
        });

        this.field_show_tag_button = new Adw.SwitchRow({
            title: _("Tag"),
            subtitle: _("Show the tag button on each item")
        });

        this.field_paste_button = new Adw.SwitchRow({
            title: _("Paste"),
            subtitle: _("Show the paste button on each item")
        });

        this.field_show_pin_button = new Adw.SwitchRow({
            title: _("Pin"),
            subtitle: _("Show the pin/favorite button on each item")
        });

        this.field_show_edit_button = new Adw.SwitchRow({
            title: _("Edit"),
            subtitle: _("Show the edit button on each text item")
        });

        this.field_show_preview_button = new Adw.SwitchRow({
            title: _("Preview"),
            subtitle: _("Show the preview button on each image item")
        });

        this.field_preview_on_hover = new Adw.SwitchRow({
            title: _("Preview on hover"),
            subtitle: _("Show the image preview while hovering over the preview button")
        });

        this.field_cache_images = new Adw.SwitchRow({
            title: _("Cache images"),
            subtitle: _("Save copied images to clipboard history"),
            active: true
        });

        this.field_exclusion_row = new Adw.ExpanderRow({
            title: _('Excluded Apps'),
            subtitle: _('Content copied will not be saved while these apps are in focus'),
        });

        this.field_exclusion_row_add_button = new Gtk.Button({
            iconName: 'list-add-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        this.case_sensitive_search = new Adw.SwitchRow({
            title: _("Case-sensitive"),
            subtitle: _("Match uppercase and lowercase letters exactly when searching")
        });

        this.regex_search = new Adw.SwitchRow({
            title: _("Regular expressions"),
            subtitle: _("Allow regular expressions to filter clipboard entries")
        });

        this.field_exclusion_row_add_button.connect('clicked', () => {
            this.field_exclusion_row_add_button.set_sensitive(false);
            this.excluded_row_counter++;
            this.field_exclusion_row.set_expanded(true);
            this.field_exclusion_row.add_row(this.#createExcludedAppInputRow());
        });

        this.field_exclusion_row.add_suffix(this.field_exclusion_row_add_button);

        this.field_clear_history_on_interval = new Adw.SwitchRow({
            title: _("Clear clipboard history on interval"),
            subtitle: _("Automatically clear clipboard history at a recurring interval")
        });

        this.field_clear_history_interval = new Adw.SpinRow({
            title: _("History clear interval (in minutes)"),
            adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 1440,
            step_increment: 10
            })
        });

        this.field_clear_history_on_interval.connect('notify::active', (widget) => {
            this.field_clear_history_interval.set_sensitive(widget.active);
        });

        this.field_colorize_clipboard = new Adw.SwitchRow({
            title: _("Colorize clipboard content"),
            subtitle: _("Highlight clipboard entries by type (files, URLs, emails, colors, masked items)")
        });

        this.field_fetch_youtube_titles = new Adw.SwitchRow({
            title: _("Fetch YouTube video titles"),
            subtitle: _("Warning: enabling this sends YouTube links copied to the clipboard (clipboard data) to a third party — https://www.youtube.com/oembed")
        });

        this.field_vault_enabled = new Adw.SwitchRow({
            title: _("Enable password vault"),
            subtitle: _("Show the vault section and open it with right-click or the hotkey")
        });

        this.field_vault_copy_to_history = new Adw.SwitchRow({
            title: _("Add vault copies to clipboard history"),
            subtitle: _("Everything copied from the vault lands in the visible clipboard list. WARNING: this stores passwords and logins in plain text — keep it off unless you understand the risk")
        });

        this.field_password_vault_path = new Adw.EntryRow({
            title: _("Password Vault File Path"),
            text: this.schema.get_string(PrefsFields.PASSWORD_VAULT_PATH) || DEFAULT_VAULT_PATH
        });
        // The format notice below is glued to this row: its separator (the
        // row's bottom border) is suppressed via `vault-path-row`.
        this.field_password_vault_path.add_css_class('vault-path-row');
        this.field_password_vault_path.connect('changed', (row) => {
            this.schema.set_string(PrefsFields.PASSWORD_VAULT_PATH, row.get_text());
            this._updateVaultFormatStatus();
        });

        // Pick the vault file with the system file chooser instead of typing
        // the path by hand — handy after restoring a backup or switching to
        // an existing archive. The chosen local path goes straight into the
        // entry, so the 'changed' handler above persists it and refreshes the
        // detected-format status row.
        const browseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse…')
        });
        browseButton.add_css_class('flat');
        browseButton.connect('clicked', () => this._browseVaultPath());
        this.field_password_vault_path.add_suffix(browseButton);

        this.field_vault_format_7z = new Adw.SwitchRow({
            title: _("Use 7z vault format"),
            subtitle: _("The 7z format (AES-256) encrypts the archive headers, hiding the internal file name and per-entry sizes; opening it requires an application with 7z support (this extension uses the system 7-Zip). ZIP stays portable but reveals them. A new vault is created in 7z by default; an existing archive keeps its current format until you switch it here — the conversion is then offered on the next unlock (or right away while the vault is unlocked) and runs once you confirm it; the file is renamed to match (.zip ↔ .7z) and the old copy is kept until you delete it.")
        });
        this.field_vault_format_7z.connect('notify::active', () => {
            // Keep the *default* file name honest: switching the format with
            // the untouched default path and no archive created there yet
            // renames the effective default to storage.7z (and back). If the
            // path was customized, or an archive already exists there, leave
            // it alone — the extension aligns the archive name to its format
            // the next time the vault is opened.
            const on = this.field_vault_format_7z.active;
            const from = on ? DEFAULT_VAULT_PATH : DEFAULT_VAULT_PATH_7Z;
            const to = on ? DEFAULT_VAULT_PATH_7Z : DEFAULT_VAULT_PATH;
            const shown = this.field_password_vault_path.get_text();
            if (shown === from) {
                const resolved = from.startsWith('~')
                    ? GLib.get_home_dir() + from.slice(1)
                    : from;
                if (!Gio.File.new_for_path(resolved).query_exists(null)) {
                    this.field_password_vault_path.set_text(to);
                }
            }
            this._updateVaultFormatStatus();
        });

        // Live status of the vault archive at the path above. It doubles as
        // the separator-less continuation of the path row: colored state icon
        // on the *left* (prefix), tinted background that flips between info
        // and warning in `_updateVaultFormatStatus()`.
        this.field_vault_format_status = new Adw.ActionRow({
            title: '',
            subtitle: ''
        });
        this.field_vault_format_status_icon = new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER
        });
        this.field_vault_format_status_icon.add_css_class('vault-status-icon');
        this.field_vault_format_status.add_prefix(this.field_vault_format_status_icon);
        this.field_vault_format_status.add_css_class('vault-status-row');
        this._updateVaultFormatStatus();

        this.field_vault_pin_recent = new Adw.SwitchRow({
            title: _("Pin last used service card"),
            subtitle: _("Show the last used service as a card at the top of the vault")
        });

        this.field_vault_hide_all_category = new Adw.SwitchRow({
            title: _("Hide services in the 'All' view"),
            subtitle: _("When 'All' is selected, show nothing until you search (extra privacy)")
        });

        this.field_vault_hidden_edge_warning = new Adw.SwitchRow({
            title: _("Hidden-field edge warning"),
            subtitle: _("Show a ⚠️ icon when a hidden password or field starts or ends with a space, line break or non-printable character. Catches invisible paste typos (Ctrl+V artifact, stray space), but the icon also reveals metadata about the secret value to anyone viewing the screen, e.g. during screen sharing. Off by default.")
        });

        this.field_vault_password_request = new Adw.ComboRow({
            title: _("When to ask for the master password"),
            subtitle: _("How often the password vault requests the master password"),
            model: this.#createVaultPasswordRequestOptions()
        });

        this.field_vault_reset_search = new Adw.SwitchRow({
            title: _("Reset vault search on close"),
            subtitle: _("Clear the search filter in the password vault when the vault menu closes")
        });

        this.field_vault_clear_clipboard = new Adw.SwitchRow({
            title: _("Clear copied vault secrets from clipboard"),
            subtitle: _("Automatically remove a value copied from the password vault from the clipboard after a short delay — only when it still matches the copied value")
        });

        this.field_vault_clear_clipboard_timeout = new Adw.SpinRow({
            title: _("Clipboard clear delay (seconds)"),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 300,
                step_increment: 5
            })
        });

        this.field_vault_clear_clipboard.connect('notify::active', (widget) => {
            this.field_vault_clear_clipboard_timeout.set_sensitive(widget.active);
        });

        this.ui =  new Adw.PreferencesGroup({ title: _('UI') });
        this.behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        this.exclusion = new Adw.PreferencesGroup({ title: _('Exclusion') });
        this.limits =  new Adw.PreferencesGroup({ title: _('Limits') });
        this.topbar =  new Adw.PreferencesGroup({ title: _('Topbar') });
        this.notifications =  new Adw.PreferencesGroup({ title: _('Notifications') });
        this.shortcuts =  new Adw.PreferencesGroup({ title: _('Shortcuts') });
        this.search = new Adw.PreferencesGroup({title: _('Search')});
        this.item_actions = new Adw.PreferencesGroup({ title: _('Item Actions') });
        this.password_vault = new Adw.PreferencesGroup({ title: _('Password Vault Settings') });

        this.field_vault_requirements_warning = new Adw.ActionRow({
            title: _('Required: 7-Zip (7z, 7za or 7zz)'),
            subtitle: _('The vault is an encrypted archive (ZIP or 7z). To open and save it the extension needs 7-Zip: install 7zip (7zz), p7zip-full (7z) or p7zip (7za). Keep the archive file in a protected location.'),
            activatable: false,
            selectable: false
        });
        this.field_vault_requirements_warning.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic' }));

        this.password_vault.add(this.field_vault_requirements_warning);
        // Basic Settings
        this.password_vault.add(this.field_vault_enabled);
        this.password_vault.add(this.field_vault_format_7z);
        this.password_vault.add(this.field_password_vault_path);
        this.password_vault.add(this.field_vault_format_status);
        this.password_vault.add(this.field_vault_password_request);
        // Additional Settings
        this.password_vault.add(this.field_vault_clear_clipboard);
        this.password_vault.add(this.field_vault_clear_clipboard_timeout);
        this.password_vault.add(this.field_vault_pin_recent);
        this.password_vault.add(this.field_vault_hide_all_category);
        this.password_vault.add(this.field_vault_hidden_edge_warning);
        this.password_vault.add(this.field_vault_reset_search);
        this.password_vault.add(this.field_vault_copy_to_history);

        this.ui.add(this.field_preview_size);
        this.ui.add(this.field_confirm_clear_toggle);
        this.ui.add(this.field_confirm_pinned_delete_toggle);
        this.ui.add(this.field_pinned_on_bottom);
        this.ui.add(this.field_show_search_bar);
        this.ui.add(this.field_show_private_mode);
        this.ui.add(this.field_show_settings_button);
        this.ui.add(this.field_show_clear_history_button);
        this.ui.add(this.field_colorize_clipboard);
        this.ui.add(this.field_fetch_youtube_titles);

        this.behavior.add(this.field_strip_text);
        this.behavior.add(this.field_strip_line_breaks);
        this.behavior.add(this.field_move_item_first);
        this.behavior.add(this.field_keep_selected_on_clear);
        this.behavior.add(this.field_open_at_cursor);
        this.behavior.add(this.field_paste_on_select);
        this.behavior.add(this.field_cache_images);
        this.behavior.add(this.field_clear_on_boot);
        this.behavior.add(this.field_clear_history_on_interval);
        this.behavior.add(this.field_clear_history_interval);

        this.exclusion.add(this.field_exclusion_row);
        this.exclusion.add(this.field_exclusion_row_add_button);

        this.limits.add(this.field_size);
        this.limits.add(this.field_cache_size);
        this.limits.add(this.field_cache_disable);

        this.topbar.add(this.field_display_mode);
        this.topbar.add(this.field_topbar_preview_size);
        this.topbar.add(this.field_disable_down_arrow);
        this.topbar.add(this.field_blink_icon_on_copy);

        this.notifications.add(this.field_copy_notification_toggle);
        this.notifications.add(this.field_cycle_notification_toggle);
        this.notifications.add(this.field_clear_notification_toggle);

        this.search.add(this.case_sensitive_search);
        this.search.add(this.regex_search);

        this.item_actions.add(this.field_show_delete_button);
        this.item_actions.add(this.field_show_tag_button);
        this.item_actions.add(this.field_paste_button);
        this.item_actions.add(this.field_show_pin_button);
        this.item_actions.add(this.field_show_edit_button);
        this.item_actions.add(this.field_show_preview_button);
        this.item_actions.add(this.field_preview_on_hover);

        this.#buildShorcuts(this.shortcuts);

        this.schema.bind(PrefsFields.HISTORY_SIZE, this.field_size, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.PREVIEW_SIZE, this.field_preview_size, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CACHE_FILE_SIZE, this.field_cache_size, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CACHE_ONLY_FAVORITE, this.field_cache_disable, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.NOTIFY_ON_COPY, this.field_copy_notification_toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.NOTIFY_ON_CYCLE, this.field_cycle_notification_toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.NOTIFY_ON_CLEAR, this.field_clear_notification_toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CONFIRM_ON_CLEAR, this.field_confirm_clear_toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CONFIRM_ON_PINNED_DELETE, this.field_confirm_pinned_delete_toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.MOVE_ITEM_FIRST, this.field_move_item_first, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.KEEP_SELECTED_ON_CLEAR, this.field_keep_selected_on_clear, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.TOPBAR_DISPLAY_MODE_ID, this.field_display_mode, 'selected', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.DISABLE_DOWN_ARROW, this.field_disable_down_arrow, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.BLINK_ICON_ON_COPY, this.field_blink_icon_on_copy, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.TOPBAR_PREVIEW_SIZE, this.field_topbar_preview_size, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.STRIP_TEXT, this.field_strip_text, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.STRIP_LINE_BREAKS, this.field_strip_line_breaks, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.PASTE_BUTTON, this.field_paste_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.PINNED_ON_BOTTOM, this.field_pinned_on_bottom, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_SEARCH_BAR, this.field_show_search_bar, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_PRIVATE_MODE, this.field_show_private_mode, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_SETTINGS_BUTTON, this.field_show_settings_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_CLEAR_HISTORY_BUTTON, this.field_show_clear_history_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.ENABLE_KEYBINDING, this.field_keybinding_activation, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CLEAR_ON_BOOT, this.field_clear_on_boot, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.PASTE_ON_SELECT, this.field_paste_on_select, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.OPEN_AT_CURSOR, this.field_open_at_cursor, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CACHE_IMAGES, this.field_cache_images, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CLEAR_HISTORY_ON_INTERVAL, this.field_clear_history_on_interval, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CLEAR_HISTORY_INTERVAL, this.field_clear_history_interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.CASE_SENSITIVE_SEARCH, this.case_sensitive_search, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.REGEX_SEARCH, this.regex_search, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_DELETE_BUTTON, this.field_show_delete_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_TAG_BUTTON, this.field_show_tag_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_PIN_BUTTON, this.field_show_pin_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_EDIT_BUTTON, this.field_show_edit_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.SHOW_PREVIEW_BUTTON, this.field_show_preview_button, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.PREVIEW_ON_HOVER, this.field_preview_on_hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.COLORIZE_CLIPBOARD, this.field_colorize_clipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.FETCH_YOUTUBE_TITLES, this.field_fetch_youtube_titles, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_PIN_RECENT, this.field_vault_pin_recent, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_HIDE_ALL_CATEGORY, this.field_vault_hide_all_category, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_HIDDEN_EDGE_WARNING, this.field_vault_hidden_edge_warning, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_ENABLED, this.field_vault_enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_FORMAT_7Z, this.field_vault_format_7z, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_COPY_TO_HISTORY, this.field_vault_copy_to_history, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_CLEAR_CLIPBOARD, this.field_vault_clear_clipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT, this.field_vault_clear_clipboard_timeout, 'value', Gio.SettingsBindFlags.DEFAULT);
        this.schema.bind(PrefsFields.VAULT_RESET_SEARCH_ON_CLOSE, this.field_vault_reset_search, 'active', Gio.SettingsBindFlags.DEFAULT);

        // vault-password-request is a free-form string; map it to the combo index.
        const vaultRequestModes = ['session', 'every-open', 'after-sleep'];
        let vaultRequestCurrent = 'session';
        try {
            vaultRequestCurrent = this.schema.get_string(PrefsFields.VAULT_PASSWORD_REQUEST) || 'session';
        } catch (e) {
        }
        this.field_vault_password_request.set_selected(Math.max(0, vaultRequestModes.indexOf(vaultRequestCurrent)));
        this.field_vault_password_request.connect('notify::selected', () => {
            const idx = this.field_vault_password_request.get_selected();
            if (idx >= 0 && idx < vaultRequestModes.length) {
                this.schema.set_string(PrefsFields.VAULT_PASSWORD_REQUEST, vaultRequestModes[idx]);
            }
        });

        this.field_clear_history_interval.set_sensitive(this.field_clear_history_on_interval.active);
        this.field_vault_clear_clipboard_timeout.set_sensitive(this.field_vault_clear_clipboard.active);
        this.#fetchExludedAppsList();
    }

    #createDisplayModeOptions () {
        let options = [
            _("Icon"),
            _("Clipboard Content"),
            _("Both"),
            _("Neither")
        ];
        let liststore = new Gtk.StringList();
        for (let option of options) {
            liststore.append(option)
        }
        return liststore;
    }

    #createVaultPasswordRequestOptions () {
        let options = [
            _("Once per session"),
            _("Every time the vault is opened"),
            _("After system sleep")
        ];
        let liststore = new Gtk.StringList();
        for (let option of options) {
            liststore.append(option)
        }
        return liststore;
    }

    // Open a system file chooser pre-positioned in the vault's directory, so
    // the path can be picked (or restored from a backup) instead of typed.
    // Only local files are accepted — resolveVaultPath() on the extension
    // side works with filesystem paths, not URIs.
    _browseVaultPath() {
        const raw = (this.field_password_vault_path.get_text() || '').trim() || DEFAULT_VAULT_PATH;
        const resolved = raw.startsWith('~') ? GLib.get_home_dir() + raw.slice(1) : raw;

        const dialog = new Gtk.FileDialog({
            title: _('Select the password vault file'),
            modal: true
        });
        const parentDir = Gio.File.new_for_path(GLib.path_get_dirname(resolved));
        if (parentDir.query_exists(null)) {
            dialog.set_initial_folder(parentDir);
        }

        const window = this.window || null;
        dialog.open(window, null, (dlg, res) => {
            let file;
            try {
                file = dlg.open_finish(res);
            } catch (e) {
                return; // dialog dismissed / cancelled
            }
            const path = file.get_path();
            if (path) {
                this.field_password_vault_path.set_text(path);
            }
        });
    }

    // Report the *actual* state of the vault archive on disk: which container
    // really sits in the file (decided by magic bytes, never by the name),
    // whether the file name contradicts it, and what the selected format will
    // do on the next unlock. This makes the "the extension answers to its
    // content" promise visible in the settings UI.
    _updateVaultFormatStatus() {
        const raw = (this.field_password_vault_path.get_text() || '').trim() || DEFAULT_VAULT_PATH;
        const resolved = raw.startsWith('~') ? GLib.get_home_dir() + raw.slice(1) : raw;
        const file = Gio.File.new_for_path(resolved);
        const exists = file.query_exists(null);
        const format = exists ? this.#detectVaultFormat(resolved) : null;
        const suffix = /\.(zip|7z)$/i.exec(resolved);
        const nameFormat = suffix ? suffix[1].toLowerCase() : null;
        const desired7z = this.field_vault_format_7z.active;
        // W1: while the user never explicitly chose a format (the key is at
        // its default), an existing archive keeps the format it was created
        // with — the disk is the source of truth and no silent conversion
        // happens. Only the toggle flip itself requests a conversion.
        let userSetFormat = true;
        try {
            userSetFormat = this.schema.get_user_value(PrefsFields.VAULT_FORMAT_7Z) !== null;
        } catch (e) {
            userSetFormat = false;
        }

        let title, subtitle, icon, stateClass;
        if (!exists) {
            title = _('No vault archive at this path yet');
            subtitle = desired7z ? _('It will be created in 7z format.') : _('It will be created in ZIP format.');
            icon = 'dialog-information-symbolic';
            stateClass = 'vault-status-info';
        } else if (format === null) {
            title = _('The vault file is empty or not a readable archive');
            subtitle = _('It is 0 bytes or its content is not ZIP/7z — restore it from the .bak file or a backup.');
            icon = 'dialog-warning-symbolic';
            stateClass = 'vault-status-warning';
        } else if (nameFormat && nameFormat !== format) {
            title = format === '7z'
                ? _('Detected a 7z archive in a .zip file')
                : _('Detected a ZIP archive in a .7z file');
            subtitle = _('The archive is renamed to match its content the next time the vault is opened with the master password.');
            icon = 'dialog-warning-symbolic';
            stateClass = 'vault-status-warning';
        } else {
            title = format === '7z' ? _('Detected a 7z archive') : _('Detected a ZIP archive');
            subtitle = ((desired7z !== (format === '7z')) && userSetFormat)
                ? (desired7z ? _('It will be converted to 7z the next time it is opened.') : _('It will be converted to ZIP the next time it is opened.'))
                : ((desired7z !== (format === '7z'))
                    ? _('It keeps its current format — switch it in the settings to convert it on the next open.')
                    : '');
            icon = 'dialog-information-symbolic';
            stateClass = 'vault-status-info';
        }

        this.field_vault_format_status.set_title(title);
        this.field_vault_format_status.set_subtitle(subtitle);
        this.field_vault_format_status_icon.icon_name = icon;
        this.field_vault_format_status.remove_css_class('vault-status-info');
        this.field_vault_format_status.remove_css_class('vault-status-warning');
        this.field_vault_format_status.add_css_class(stateClass);
    }

    // Identify the vault container from the archive's first bytes:
    // PK\x03\x04 = ZIP, 37 7A BC AF 27 1C = 7z (plaintext even with header
    // encryption). Returns 'zip' | '7z' | null (missing / unreadable / not an
    // archive, e.g. a 0-byte file).
    #detectVaultFormat(pathStr) {
        const file = Gio.File.new_for_path(pathStr);
        let stream;
        try {
            stream = file.read(null);
            const head = stream.read_bytes(8, null).toArray();
            if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b &&
                head[2] === 0x03 && head[3] === 0x04) {
                return 'zip';
            }
            if (head.length >= 6 && head[0] === 0x37 && head[1] === 0x7a &&
                head[2] === 0xbc && head[3] === 0xaf && head[4] === 0x27 &&
                head[5] === 0x1c) {
                return '7z';
            }
            return null;
        } catch (e) {
            return null;
        } finally {
            try {
                if (stream) stream.close(null);
            } catch (e) {
            }
        }
    }

    #shortcuts = {
        [PrefsFields.BINDING_PRIVATE_MODE]: _("Private mode"),
        [PrefsFields.BINDING_TOGGLE_MENU]: _("Toggle the menu"),
        [PrefsFields.BINDING_TOGGLE_PASSWORD_VAULT]: _("Toggle Password Vault"),
        [PrefsFields.BINDING_CLEAR_HISTORY]: _("Clear history"),
        [PrefsFields.BINDING_PREV_ENTRY]: _("Previous entry"),
        [PrefsFields.BINDING_NEXT_ENTRY]: _("Next entry")
    };

    #buildShorcuts (group) {
        this.field_keybinding_activation = new Adw.SwitchRow({
            title: _("Enable shortcuts")
        });

        group.add(this.field_keybinding_activation);

        for (const [pref, title] of Object.entries(this.#shortcuts)) {
            const row = new Adw.ActionRow({
                title
            });

            row.add_suffix(this.#createShortcutButton(pref));

            group.add(row);
        }
    }

    #createShortcutButton (pref) {
        const button = new Gtk.Button({
            has_frame: false
        });

        const setLabelFromSettings = () => {
            const originalValue = this.schema.get_strv(pref)[0];

            if (!originalValue) {
                button.set_label(_('Disabled'));
            }
            else {
                button.set_label(originalValue);
            }
        };

        const startEditing = () => {
            button.isEditing = button.label;
            button.set_label(_('Enter shortcut'));
        };

        const revertEditing = () => {
            button.set_label(button.isEditing);
            button.isEditing = null;
        };

        const stopEditing = () => {
            setLabelFromSettings();
            button.isEditing = null;
        };

        setLabelFromSettings();

        button.connect('clicked', () => {
            if (button.isEditing) {
                revertEditing();
                return;
            }

            startEditing();

            const eventController = new Gtk.EventControllerKey();
            button.add_controller(eventController);

            let debounceTimeoutId = null;
            const connectId = eventController.connect('key-pressed', (_ec, keyval, keycode, mask) => {
                if (debounceTimeoutId) clearTimeout(debounceTimeoutId);

                mask = mask & Gtk.accelerator_get_default_mod_mask();

                if (mask === 0) {
                    switch (keyval) {
                        case Gdk.KEY_Escape:
                            revertEditing();
                            return Gdk.EVENT_STOP;
                        case Gdk.KEY_BackSpace:
                            this.schema.set_strv(pref, []);
                            setLabelFromSettings();
                            stopEditing();
                            eventController.disconnect(connectId);
                            return Gdk.EVENT_STOP;
                    }
                }

                const selectedShortcut = Gtk.accelerator_name_with_keycode(
                    null,
                    keyval,
                    keycode,
                    mask
                );

                debounceTimeoutId = setTimeout(() => {
                    eventController.disconnect(connectId);
                    this.schema.set_strv(pref, [selectedShortcut]);
                    stopEditing();
                }, 400);

                return Gdk.EVENT_STOP;
            });

            button.show();
        });

        return button;
    }

    #excluded_row_counter = 0;

    set excluded_row_counter(value) {
        this.#excluded_row_counter = value;
        this.#updateExcludedAppRow();
    }

    get excluded_row_counter() {
        return this.#excluded_row_counter;
    }

    #createExcludedAppInputRow() {
        //The entry row for adding new excluded apps
        const entry_row = new Adw.ActionRow({
            hexpand: false,
        });

        //The input field for the app wm class name
        const entry = new Gtk.Entry({
            placeholderText: _('Window class name, e.g. "KeePassXC"'),
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        //The button to open the popover with the list of installed applications
        const appButton = new Gtk.MenuButton({
            iconName: 'view-list-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            tooltip_text: _('Choose from installed applications'),
        });

        //The popover
        const popover = new Gtk.Popover();

        //The popover box
        const popoverBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        //The search entry in the popover list for searching applications
        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Search applications...'),
            margin_bottom: 6,
        });

        //The scrolled window for the list of applications
        const scrolledWindow = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            height_request: 300,
            width_request: 300,
        });

        const listBox = new Gtk.ListBox();

        entry.connect('activate', () => {
            ok_button.emit('clicked');
        });

        popoverBox.append(searchEntry);

        popoverBox.append(scrolledWindow);

        scrolledWindow.set_child(listBox);

        popover.set_child(popoverBox);
        appButton.set_popover(popover);

        const appInfoList = Gio.AppInfo.get_all();
        const appRows = [];

        appInfoList.sort((a, b) => {
            return a.get_display_name().localeCompare(b.get_display_name());
        }).forEach(appInfo => {
            if (appInfo.should_show()) {
                const row = new Gtk.ListBoxRow();
                const box = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 10,
                    margin_top: 6,
                    margin_bottom: 6,
                    margin_start: 6,
                    margin_end: 6,
                });

                const icon = appInfo.get_icon();
                if (icon) {
                    const image = new Gtk.Image({
                        gicon: icon,
                        pixel_size: 24,
                    });
                    box.append(image);
                }

                const label = new Gtk.Label({
                    label: appInfo.get_display_name(),
                    halign: Gtk.Align.START,
                    hexpand: true,
                });
                box.append(label);

                row.set_child(box);
                row.appInfo = appInfo;
                listBox.append(row);
                appRows.push({ row, appInfo });
            }
        });

        //for searching the list of applications
        searchEntry.connect('search-changed', () => {
            const text = searchEntry.get_text().toLowerCase();
            for (const { row, appInfo } of appRows) {
                const appName = appInfo.get_display_name().toLowerCase();
                row.set_visible(appName.includes(text));
            }
        });

        //when using enter on the search entry, select the first row and focus the entry
        searchEntry.connect('activate', () => {
            const firstVisibleRow = appRows.find(({ row }) => row.visible);
            if (firstVisibleRow) {
                listBox.emit('row-activated', firstVisibleRow.row);
            }
            entry.grab_focus();
        });

        //when selecting an application, set the entry text to the app class name and close the popover
        listBox.connect('row-activated', (list, row) => {
            if (row && row.appInfo) {
                const appClassName = row.appInfo.get_id().replace(/\.desktop$/, '');
                entry.set_text(appClassName);
                popover.popdown();
            }
        });

        //The suffix buttons
        const ok_button = new Gtk.Button({
            iconName: 'object-select-symbolic',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
        });

        ok_button.connect('clicked', () => {
            const text = entry.get_text();
            if (text !== null && text.trim() !== '') {
                this.field_exclusion_row.remove(entry_row);
                this.field_exclusion_row.add_row(this.#createExludedAppRow(text.trim()));
                this.field_exclusion_row_add_button.set_sensitive(true);
                this.schema.set_strv('excluded-apps', [...this.schema.get_strv('excluded-apps'), text.trim()]);
            }
        });

        const cancel_button = new Gtk.Button({
            iconName: 'window-close-symbolic',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
        });

        cancel_button.connect('clicked', () => {
            this.field_exclusion_row.remove(entry_row);
            this.field_exclusion_row_add_button.set_sensitive(true);
            this.excluded_row_counter--;
        });

        // Hide the title/subtitle/icon children of the ActionRow
        let child = entry_row.child.get_first_child();
        while (child) {
            child.visible = false;
            child = child.get_next_sibling();
        }

        entry_row.add_prefix(entry);
        entry_row.add_suffix(appButton);
        entry_row.add_suffix(ok_button);
        entry_row.add_suffix(cancel_button);

        return entry_row;
    }

    #createExludedAppRow(app_class_name) {
        const excluded_row = new Adw.ActionRow({
            title: app_class_name,
        });

        const remove_button = new Gtk.Button({
            cssClasses: ['destructive-action'],
            iconName: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        remove_button.connect('clicked', () => {
            this.field_exclusion_row.remove(excluded_row);
            const updated_list = this.schema.get_strv('excluded-apps').filter(app => app !== app_class_name);
            this.schema.set_strv('excluded-apps', updated_list);
            this.excluded_row_counter--;
        });
        excluded_row.add_suffix(remove_button);

        return excluded_row;
    }

    #fetchExludedAppsList() {
        const excludedApps = this.schema.get_strv('excluded-apps');
        for (const app of excludedApps) {
            this.field_exclusion_row.add_row(this.#createExludedAppRow(app));
        }
        this.excluded_row_counter = excludedApps.length;
    }

    #updateExcludedAppRow() {
        const hasExcludedApps = this.excluded_row_counter > 0;
        this.field_exclusion_row.set_enable_expansion(hasExcludedApps);
        this.field_exclusion_row.set_expanded(hasExcludedApps);
    }
}