export const PrefsFields = {
    HISTORY_SIZE                    : 'history-size',
    PREVIEW_SIZE                    : 'preview-size',
    CACHE_FILE_SIZE                 : 'cache-size',
    CACHE_ONLY_FAVORITE             : 'cache-only-favorites',
    DELETE                          : 'enable-deletion',
    NOTIFY_ON_COPY                  : 'notify-on-copy',
    NOTIFY_ON_CYCLE                 : 'notify-on-cycle',
    NOTIFY_ON_CLEAR                 : 'notify-on-clear',
    CONFIRM_ON_CLEAR                : 'confirm-clear',
    CONFIRM_ON_PINNED_DELETE        : 'confirm-pinned-delete',
    MOVE_ITEM_FIRST                 : 'move-item-first',
    ENABLE_KEYBINDING               : 'enable-keybindings',
    TOPBAR_PREVIEW_SIZE             : 'topbar-preview-size',
    TOPBAR_DISPLAY_MODE_ID          : 'display-mode',
    DISABLE_DOWN_ARROW              : 'disable-down-arrow',
    BLINK_ICON_ON_COPY              : 'blink-icon-on-copy',
    STRIP_TEXT                      : 'strip-text',
    STRIP_LINE_BREAKS               : 'cwp-strip-line-breaks',
    KEEP_SELECTED_ON_CLEAR          : 'keep-selected-on-clear',
    PASTE_BUTTON                    : 'paste-button',
    PINNED_ON_BOTTOM                : 'pinned-on-bottom',
    BINDING_TOGGLE_MENU             : 'toggle-menu',
    BINDING_CLEAR_HISTORY           : 'clear-history',
    BINDING_PREV_ENTRY              : 'prev-entry',
    BINDING_NEXT_ENTRY              : 'next-entry',
    BINDING_PRIVATE_MODE            : 'private-mode-binding',
    CLEAR_ON_BOOT                   : 'clear-on-boot',
    PASTE_ON_SELECT                 : 'paste-on-select',
    CACHE_IMAGES                    : 'cache-images',
    EXCLUDED_APPS                   : 'excluded-apps',
    CLEAR_HISTORY_ON_INTERVAL       : 'clear-history-on-interval',
    CLEAR_HISTORY_INTERVAL          : 'clear-history-interval',
    NEXT_HISTORY_CLEAR              : 'next-history-clear',
    CASE_SENSITIVE_SEARCH           : 'case-sensitive-search',
    REGEX_SEARCH                    : 'regex-search',
    SHOW_SEARCH_BAR                 : 'show-search-bar',
    SHOW_PRIVATE_MODE               : 'show-private-mode',
    SHOW_SETTINGS_BUTTON            : 'show-settings-button',
    SHOW_CLEAR_HISTORY_BUTTON       : 'show-clear-history-button',
    OPEN_AT_CURSOR                  : 'open-at-cursor',
    SHOW_DELETE_BUTTON              : 'show-delete-button',
    SHOW_TAG_BUTTON                 : 'show-tag-button',
    SHOW_PIN_BUTTON                 : 'show-pin-button',
    SHOW_EDIT_BUTTON                : 'show-edit-button',
    SHOW_PREVIEW_BUTTON             : 'show-preview-button',
    PREVIEW_ON_HOVER                : 'cwp-preview-on-hover',
    PASSWORD_VAULT_PATH             : 'cwp-password-vault-path',
    VAULT_FORMAT_7Z                 : 'cwp-vault-format-7z',
    VAULT_ENABLED                   : 'cwp-vault-enabled',
    VAULT_COPY_TO_HISTORY           : 'cwp-vault-copy-to-history',
    VAULT_CLEAR_CLIPBOARD           : 'cwp-vault-clear-clipboard',
    VAULT_CLEAR_CLIPBOARD_TIMEOUT   : 'cwp-vault-clear-clipboard-timeout',
    VAULT_PIN_RECENT                : 'cwp-vault-pin-recent',
    VAULT_HIDE_ALL_CATEGORY         : 'cwp-vault-hide-all-category',
    VAULT_HIDDEN_EDGE_WARNING       : 'cwp-vault-hidden-edge-warning',
    VAULT_PASSWORD_REQUEST          : 'cwp-vault-password-request',
    VAULT_RESET_SEARCH_ON_CLOSE     : 'cwp-vault-reset-search-on-close',
    COLORIZE_CLIPBOARD              : 'cwp-colorize-clipboard',
    FETCH_YOUTUBE_TITLES            : 'cwp-fetch-youtube-titles',
    BINDING_TOGGLE_PASSWORD_VAULT   : 'cwp-toggle-password-vault',
};

// Default location of the encrypted vault archive. Chosen so that nothing in
// the extension's defaults, docs or on-disk formats advertises that it stores
// passwords; the JSON payload inside the archive is named "data.json".
export const DEFAULT_VAULT_PATH = '~/.config/clipboard-with-passwords/storage.zip';

// Effective default when the 7z format is selected and the vault path was
// never customized (see prefs.js normalization): the extension then creates
// `storage.7z` instead of `storage.zip` so the file name stays honest.
export const DEFAULT_VAULT_PATH_7Z = '~/.config/clipboard-with-passwords/storage.7z';

// P1.3: structural limits enforced when a vault archive is loaded, so a
// crafted or hand-broken archive cannot make the shell JSON.parse unbounded
// data, hold an unbounded item list in memory, or render unbounded UI.
// These are generous upper bounds — a real vault is a few kilobytes — sized so
// no legitimate vault trips them while an archive bomb still fails fast with a
// readable message. Any breach REJECTS the load (never silent truncation:
// cutting a password would corrupt it forever, and an oversized archive must
// fail loudly). The message strings in passwordVault.js carry the numbers
// (max 1000 / 4096) — keep them in sync with the values here.
export const MAX_VAULT_ARCHIVE_BYTES = 64 * 1024 * 1024;   // on-disk archive, pre-check before unpacking
export const MAX_VAULT_JSON_BYTES = 64 * 1024 * 1024;      // decompressed JSON string (UTF-16 units), before JSON.parse
export const MAX_VAULT_ITEMS = 1000;                       // records per vault
export const MAX_FIELD_LENGTH = 4096;                      // chars per string field (name, password, extra label/value, …)
export const MAX_EXTRA_FIELDS = 32;                        // extra fields per item
export const STALE_TEMP_MIN_AGE_MS = 60 * 1000;            // P2.2: temp artifacts younger than this are treated as live writes

// W3 (P1.3): hard ceiling on how long a single `7z` subprocess may run for
// before it is force-killed. 7-Zip on a small vault finishes in well under
// a second; 60 s only ever fires on a hung / pathological binary, and a
// force-kill then guarantees the unlock/save flow cannot block the shell
// forever. Shared by unlock-extract, save-pack and post-save verify.
export const SEVENZ_TIMEOUT_MS = 60 * 1000;
