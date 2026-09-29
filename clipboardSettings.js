// The clipboard settings, as the rest of the code sees them.
//
// Every GSettings value the extension behaves on is read into a module-level
// variable here, and the rest of the code reads the variable rather than calling
// GSettings. That is not a micro-optimisation — it is what makes a row render
// from one consistent snapshot instead of re-reading the schema per field, and
// it is the shape the whole codebase is written against: `if (SHOW_DELETE_BUTTON)`
// appears in the menu builder, the topbar, the item builder and the search.
//
// So this module is three things:
//
//   1. the mirrors, exported as live bindings (an importer always sees the value
//      written last, which is what makes a snapshot meaningful at all);
//   2. the group tables, which say which extra work each key triggers and are
//      checked against the schema at load time, so a key that is not a setting —
//      or that two groups both claim — is a loud error rather than a switch that
//      quietly stops working;
//   3. applySettings(), the one place a Gio.Settings is read, including the
//      try/catch fallbacks for the keys an older schema may not have.
//
// The last two used to be a hundred lines inside the indicator, where nothing
// could reach them: the "every key belongs to a group" invariant was real and
// untestable. Here it is a table, and a table can be asserted on.
//
// No shell imports, so this can be exercised by a plain `gjs` with a stub
// settings object. `logWarn` is deliberately not used even where a log line
// would seem reasonable: importing the logger would pull the extension's
// resource:// context into every test that touches a setting.

import {PrefsFields} from './constants.js';

export let DELAYED_SELECTION_TIMEOUT = 750;
export let MAX_REGISTRY_LENGTH = 15;
export let MAX_ENTRY_LENGTH = 50;
export let CACHE_ONLY_FAVORITE = false;
export let DELETE_ENABLED = true;
export let MOVE_ITEM_FIRST = false;
export let ENABLE_KEYBINDING = true;
export let PRIVATEMODE = false;
export let NOTIFY_ON_COPY = true;
export let NOTIFY_ON_CYCLE = true;
export let NOTIFY_ON_CLEAR = true;
export let CONFIRM_ON_CLEAR = true;
export let CONFIRM_ON_PINNED_DELETE = false;
export let MAX_TOPBAR_LENGTH = 15;
export let TOPBAR_DISPLAY_MODE = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
export let CLEAR_ON_BOOT = false;
export let PASTE_ON_SELECT = false;
export let DISABLE_DOWN_ARROW = false;
export let BLINK_ICON_ON_COPY = false;
export let STRIP_TEXT = false;
export let STRIP_LINE_BREAKS = false;
export let KEEP_SELECTED_ON_CLEAR = false;
export let PASTE_BUTTON = true;
export let PINNED_ON_BOTTOM = false;
export let CACHE_IMAGES = true;
export let EXCLUDED_APPS = [];
export let CLEAR_HISTORY_ON_INTERVAL = false;
export let CLEAR_HISTORY_INTERVAL = 60;
export let NEXT_HISTORY_CLEAR = -1;
export let CASE_SENSITIVE_SEARCH = false;
export let REGEX_SEARCH = false;
export let OPEN_AT_CURSOR = false;
export let SHOW_SEARCH_BAR = true;
export let SHOW_PRIVATE_MODE = true;
export let SHOW_SETTINGS_BUTTON = true;
export let SHOW_CLEAR_HISTORY_BUTTON = true;
export let SHOW_DELETE_BUTTON = true;
export let SHOW_TAG_BUTTON = true;
export let SHOW_PIN_BUTTON = true;
export let SHOW_EDIT_BUTTON = true;
export let SHOW_PREVIEW_BUTTON = true;
export let PREVIEW_ON_HOVER = true;
export let COLORIZE_CLIPBOARD = true;
export let FETCH_YOUTUBE_TITLES = false;
export let VAULT_ENABLED = true;
export let VAULT_COPY_TO_HISTORY = false;
export let VAULT_FORMAT_7Z = false;
// Whether the user explicitly chose the vault format (true) or the setting
// still sits at its default (false). Used to keep legacy archives from being
// silently converted just because the *default* changed.
export let VAULT_FORMAT_7Z_USER_SET = false;
export let VAULT_CLEAR_CLIPBOARD = true;
export let VAULT_CLEAR_CLIPBOARD_TIMEOUT = 20;
export let VAULT_PASSWORD_REQUEST = 'session'; // 'session' | 'every-open' | 'after-sleep'
export let VAULT_RESET_SEARCH_ON_CLOSE = true;

/**
 * The one mirror that is not a copy of a setting: it is the scheduled moment of
 * the next automatic history clear, computed by the timer and also persisted.
 * Set through a setter, because an ES module's imports are read-only to the
 * importer and the scheduler is not this file.
 */
export function setNextHistoryClear(when) {
    NEXT_HISTORY_CLEAR = when;
}

/**
 * Back to "nothing is excluded", for when the extension is disabled. The
 * excluded-app list is a capture-time filter, so a stale one would keep
 * suppressing an app that the user has since allowed.
 */
export function resetExcludedApps() {
    EXCLUDED_APPS = [];
}

/*
 * Strip leading/trailing whitespace from a text value according to the
 * STRIP_TEXT / STRIP_LINE_BREAKS settings:
 * - neither:  no change
 * - STRIP_TEXT only: remove leading/trailing spaces and tabs (keeps line breaks)
 * - STRIP_LINE_BREAKS only: remove leading/trailing line breaks (keeps spaces)
 * - both: full trim of any alternating mix (equivalent to String.trim())
 */
export function stripClipboardEdges(text) {
    if (STRIP_TEXT && STRIP_LINE_BREAKS)
        return text.replace(/^\s+|\s+$/g, '');
    if (STRIP_TEXT)
        return text.replace(/^[ \t]+|[ \t]+$/g, '');
    if (STRIP_LINE_BREAKS)
        return text.replace(/^[\r\n]+|[\r\n]+$/g, '');
    return text;
}

// Which extra work each setting key triggers, grouped by what that work is. A
// key in no group is one that needs nothing beyond reloading its own value: it
// is read at the moment it is used, so nothing visible waits for the change to be
// applied. `changed` with a null key — the schema itself moving, or a key
// appearing after an upgrade — is not covered by any per-key signal and runs
// everything.
export const ITEM_APPEARANCE_KEYS = [
    PrefsFields.PREVIEW_SIZE,          // row text length
    PrefsFields.COLORIZE_CLIPBOARD,    // per-type row styling
    PrefsFields.PASTE_BUTTON,
    PrefsFields.SHOW_DELETE_BUTTON,
    PrefsFields.SHOW_TAG_BUTTON,
    PrefsFields.SHOW_PIN_BUTTON,
    PrefsFields.SHOW_EDIT_BUTTON,
    PrefsFields.SHOW_PREVIEW_BUTTON,
];

export const MENU_LAYOUT_KEYS = [
    PrefsFields.SHOW_SEARCH_BAR,
    PrefsFields.SHOW_PRIVATE_MODE,
    PrefsFields.PINNED_ON_BOTTOM,
    PrefsFields.SHOW_SETTINGS_BUTTON,
    PrefsFields.SHOW_CLEAR_HISTORY_BUTTON,
];

export const TOPBAR_KEYS = [
    PrefsFields.TOPBAR_DISPLAY_MODE_ID,
    PrefsFields.TOPBAR_PREVIEW_SIZE,
    PrefsFields.DISABLE_DOWN_ARROW,
];

// Shrinking the history has to drop rows right away, not at the next copy.
export const HISTORY_KEYS = [
    PrefsFields.HISTORY_SIZE,
];

// Settings that change the entry itself, so the clipboard has to be read again
// for the topbar to show what it would have shown before: whether an image may
// be shown at all, and the two edge-trimming options, which are applied while a
// payload becomes an entry.
export const CAPTURE_KEYS = [
    PrefsFields.CACHE_IMAGES,
    PrefsFields.STRIP_TEXT,
    PrefsFields.STRIP_LINE_BREAKS,
];

export const KEYBINDING_KEYS = [
    PrefsFields.ENABLE_KEYBINDING,
    PrefsFields.BINDING_TOGGLE_MENU,
    PrefsFields.BINDING_CLEAR_HISTORY,
    PrefsFields.BINDING_PREV_ENTRY,
    PrefsFields.BINDING_NEXT_ENTRY,
    PrefsFields.BINDING_PRIVATE_MODE,
    PrefsFields.BINDING_TOGGLE_PASSWORD_VAULT,
];

export const VAULT_FORMAT_KEYS = [
    PrefsFields.VAULT_FORMAT_7Z,
];

export const VAULT_ENABLED_KEYS = [
    PrefsFields.VAULT_ENABLED,
];

// The settings groups, in the order the full handler used to do their work.
export const SETTINGS_GROUPS = [
    ['items', ITEM_APPEARANCE_KEYS],
    ['menu', MENU_LAYOUT_KEYS],
    ['topbar', TOPBAR_KEYS],
    ['capture', CAPTURE_KEYS],
    ['history', HISTORY_KEYS],
    ['keybindings', KEYBINDING_KEYS],
    ['vault-format', VAULT_FORMAT_KEYS],
    ['vault-enabled', VAULT_ENABLED_KEYS],
];

// The work each key is part of, as a lookup from the key itself, so connecting
// one signal per key does not need the group threaded through it. A key that is
// in here is a typo away from doing nothing at all, so the table is checked
// against PrefsFields once, when the signals are connected: a key that is not a
// real setting, or one that two groups both claim, is a load-time error rather
// than a switch that quietly stops working.
export const SETTINGS_WORK = (() => {
    const work = new Map();
    for (const [group, keys] of SETTINGS_GROUPS) {
        for (const key of keys) {
            if (work.has(key))
                throw new Error(`Clipboard Indicator: ${key} is claimed by two settings groups`);
            work.set(key, group);
        }
    }

    const known = new Set(Object.values(PrefsFields));
    const unknown = [...work.keys()].filter(key => !known.has(key));
    if (unknown.length)
        throw new Error(`Clipboard Indicator: settings work for keys not in the schema: ${unknown.join(', ')}`);

    return work;
})();

/**
 * Read a Gio.Settings into every mirror. The only place in the extension that
 * talks to the schema, which is what lets the key list above be asserted on
 * instead of maintained by reading this function.
 *
 * The try/catch blocks are not decoration: a key added in a later version is
 * absent from an older schema, and GSettings throws on an unknown key rather than
 * returning a default. Each of those keys therefore falls back to the value that
 * makes the extension behave as if the user had never heard of the feature.
 *
 * @param {object} settings a Gio.Settings (anything with the same accessors)
 */
export function applySettings(settings) {
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
    STRIP_LINE_BREAKS = settings.get_boolean(PrefsFields.STRIP_LINE_BREAKS);
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
    try {
        PREVIEW_ON_HOVER = settings.get_boolean(PrefsFields.PREVIEW_ON_HOVER);
    } catch (e) {
        PREVIEW_ON_HOVER = true;
    }
    COLORIZE_CLIPBOARD = settings.get_boolean(PrefsFields.COLORIZE_CLIPBOARD);
    FETCH_YOUTUBE_TITLES = settings.get_boolean(PrefsFields.FETCH_YOUTUBE_TITLES);
    VAULT_ENABLED = settings.get_boolean(PrefsFields.VAULT_ENABLED);
    VAULT_COPY_TO_HISTORY = settings.get_boolean(PrefsFields.VAULT_COPY_TO_HISTORY);
    try {
        VAULT_FORMAT_7Z = settings.get_boolean(PrefsFields.VAULT_FORMAT_7Z);
    } catch (e) {
        VAULT_FORMAT_7Z = false;
    }
    try {
        // `get_user_value` returns null while the key is untouched; any
        // explicit choice (either direction) makes it non-null.
        VAULT_FORMAT_7Z_USER_SET = settings.get_user_value(PrefsFields.VAULT_FORMAT_7Z) !== null;
    } catch (e) {
        // Cannot tell → be conservative and keep the guard active (disk
        // format stays the source of truth, no silent conversion).
        VAULT_FORMAT_7Z_USER_SET = false;
    }
    try {
        VAULT_PASSWORD_REQUEST = settings.get_string(PrefsFields.VAULT_PASSWORD_REQUEST);
    } catch (e) {
        VAULT_PASSWORD_REQUEST = 'session';
    }
    try {
        VAULT_RESET_SEARCH_ON_CLOSE = settings.get_boolean(PrefsFields.VAULT_RESET_SEARCH_ON_CLOSE);
    } catch (e) {
        VAULT_RESET_SEARCH_ON_CLOSE = true;
    }
    try {
        VAULT_CLEAR_CLIPBOARD = settings.get_boolean(PrefsFields.VAULT_CLEAR_CLIPBOARD);
    } catch (e) {
        VAULT_CLEAR_CLIPBOARD = true;
    }
    try {
        VAULT_CLEAR_CLIPBOARD_TIMEOUT = settings.get_int(PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT);
    } catch (e) {
        VAULT_CLEAR_CLIPBOARD_TIMEOUT = 20;
    }
}
