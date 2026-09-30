// Test harness for the settings layer — the mirrors, the group tables, and
// applySettings().
//
// These three things used to be a hundred lines of `let` declarations and a
// hundred lines of assignments buried inside the indicator, where no test could
// reach them. That left one real invariant unverified: every key a group claims
// must be a key the schema actually has. A typo in that table produced a
// setting whose per-key signal fired into a group that did not exist, and the
// symptom was a switch that quietly stopped working — the worst kind of bug,
// because the code is correct and the feature is simply dead.
//
// The other thing worth pinning is the snapshot semantics. The mirrors exist so a
// row renders from one consistent view of the schema, and that only holds if an
// importer sees the value written LAST. A test that read the mirrors in the same
// tick as the write would pass even if the bindings were copies, so the read
// happens after an await.
import GLib from 'gi://GLib';

import {PrefsFields} from '../constants.js';
import * as S from '../clipboardSettings.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const wait = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

/** A Gio.Settings stand-in: every key answers, unless listed in `absent`. */
function stubSettings(values = {}, absent = []) {
    const missing = new Set(absent);
    const fail = key => {
        throw new Error(`no such key ${key}`);
    };
    return {
        get_int: k => (missing.has(k) ? fail(k) : (values[k] ?? 0)),
        get_int64: k => (missing.has(k) ? fail(k) : (values[k] ?? 0)),
        get_boolean: k => (missing.has(k) ? fail(k) : (values[k] ?? false)),
        get_string: k => (missing.has(k) ? fail(k) : (values[k] ?? '')),
        get_strv: k => (missing.has(k) ? fail(k) : (values[k] ?? [])),
        get_user_value: k => (missing.has(k) ? fail(k) : (values[k] ?? null)),
    };
}

console.log('1. every group key is a real schema key, and no key is claimed twice');
// The invariant the old file could not be asked about. SETTINGS_WORK throws at
// load time on a violation, so reaching this point already proves part of it —
// but a throw would take the whole extension down, so the table is also walked
// key by key to say WHICH invariant is being relied on.
//
// PrefsFields maps NAMES to key strings ('PREVIEW_SIZE' → 'preview-size'), so
// membership is a test on its values. Testing `key in PrefsFields` would answer
// false for every real key and quietly pass nothing.
const ALL_KEYS = Object.values(PrefsFields);
let unknown = [];
for (const [group, keys] of S.SETTINGS_GROUPS) {
    for (const key of keys) {
        if (!ALL_KEYS.includes(key))
            unknown.push(`${group}:${key}`);
    }
}
check('no group names a key that is not in the schema', unknown.length === 0,
    unknown.join(', '));

const seen = new Map();
const twice = [];
for (const [group, keys] of S.SETTINGS_GROUPS) {
    for (const key of keys) {
        if (seen.has(key))
            twice.push(`${key} (${seen.get(key)} and ${group})`);
        seen.set(key, group);
    }
}
check('no key is claimed by two groups', twice.length === 0, twice.join(', '));
check('and SETTINGS_WORK agrees with the walk',
    S.SETTINGS_WORK.size === seen.size,
    `${S.SETTINGS_WORK.size} vs ${seen.size}`);
check('every claimed key maps back to its own group',
    [...S.SETTINGS_WORK.entries()].every(([k, g]) => seen.get(k) === g));
check('the table is not trivially small', S.SETTINGS_WORK.size >= 25,
    String(S.SETTINGS_WORK.size));

console.log('\n2. a key in no group is a deliberate state, not an oversight');
// A key needs no group when nothing beyond reloading its own value is needed —
// so what matters is that the grouped keys are a SUBSET of the schema, and that
// the ungrouped ones are genuinely the ones no handler branches on.
const grouped = new Set(S.SETTINGS_WORK.keys());
const allKeys = ALL_KEYS;
const ungrouped = allKeys.filter(k => !grouped.has(k));
console.log(`    схема: ${allKeys.length} ключей, с работой: ${grouped.size}, без: ${ungrouped.length}`);
check('every grouped key is a schema key',
    [...grouped].every(k => allKeys.includes(k)));
check('the ungrouped set is not empty (else the groups cover everything by accident)',
    ungrouped.length > 0, String(ungrouped.length));
// Reload-only keys, named by their real schema key: read at the point of use, so
// a change is already in effect and no handler has to be woken.
for (const k of [PrefsFields.CACHE_ONLY_FAVORITE, PrefsFields.CASE_SENSITIVE_SEARCH,
    PrefsFields.REGEX_SEARCH, PrefsFields.OPEN_AT_CURSOR]) {
    check(`${k} is reload-only`, ungrouped.includes(k), 'it is in a group');
}
// And the flip side: the keys that DO have work, picked from the table itself so
// the test cannot drift from it.
for (const [group, keys] of S.SETTINGS_GROUPS) {
    check(`group ${group} has at least one key`, keys.length > 0);
    check(`group ${group} maps its own keys to itself`,
        keys.every(k => S.SETTINGS_WORK.get(k) === group));
}

console.log('\n3. the mirrors are defaults before anything is read');
// These are the values the extension behaves as on a schema it cannot read, so
// they are not arbitrary: each has to be the schema default, or a first run on an
// old schema would behave differently from a first run on a new one.
check('MAX_ENTRY_LENGTH starts at 50', S.MAX_ENTRY_LENGTH === 50, String(S.MAX_ENTRY_LENGTH));
check('MAX_REGISTRY_LENGTH starts at 15', S.MAX_REGISTRY_LENGTH === 15);
check('MAX_TOPBAR_LENGTH starts at 15', S.MAX_TOPBAR_LENGTH === 15);
check('CACHE_IMAGES starts on, or images would never be previewed',
    S.CACHE_IMAGES === true);
check('NOTIFY_ON_COPY starts on', S.NOTIFY_ON_COPY === true);
check('VAULT_PASSWORD_REQUEST starts at its safest value',
    S.VAULT_PASSWORD_REQUEST === 'session', S.VAULT_PASSWORD_REQUEST);
check('VAULT_FORMAT_7Z starts off, so no archive is converted unasked',
    S.VAULT_FORMAT_7Z === false);
check('and the "user chose it" guard starts off with it',
    S.VAULT_FORMAT_7Z_USER_SET === false);
check('EXCLUDED_APPS starts empty', S.EXCLUDED_APPS.length === 0);
check('NEXT_HISTORY_CLEAR starts unset', S.NEXT_HISTORY_CLEAR === -1);

console.log('\n4. applySettings loads what it is given');
S.applySettings(stubSettings({
    [PrefsFields.HISTORY_SIZE]: 42,
    [PrefsFields.PREVIEW_SIZE]: 77,
    [PrefsFields.SHOW_DELETE_BUTTON]: true,
    [PrefsFields.TOPBAR_DISPLAY_MODE_ID]: 2,
    [PrefsFields.EXCLUDED_APPS]: ['KolourPaint', 'Gimp'],
    [PrefsFields.CLEAR_HISTORY_INTERVAL]: 15,
    [PrefsFields.VAULT_PASSWORD_REQUEST]: 'after-sleep',
    [PrefsFields.STRIP_TEXT]: true,
}));
check('an int key', S.MAX_REGISTRY_LENGTH === 42, String(S.MAX_REGISTRY_LENGTH));
check('another int key', S.MAX_ENTRY_LENGTH === 77, String(S.MAX_ENTRY_LENGTH));
check('a boolean key', S.SHOW_DELETE_BUTTON === true);
check('the topbar mode is an int, not a bool', S.TOPBAR_DISPLAY_MODE === 2,
    String(S.TOPBAR_DISPLAY_MODE));
check('a string-array key', S.EXCLUDED_APPS.length === 2 &&
    S.EXCLUDED_APPS.includes('KolourPaint'), JSON.stringify(S.EXCLUDED_APPS));
check('a string key', S.VAULT_PASSWORD_REQUEST === 'after-sleep');
check('a boolean the strip rule reads', S.STRIP_TEXT === true);
check('NEXT_HISTORY_CLEAR comes from an int64', S.NEXT_HISTORY_CLEAR === 0);

console.log('\n5. a re-read replaces the snapshot rather than merging into it');
// The point of the mirrors: one load is one consistent view. A second load must
// not leave the previous value of a key the new schema lacks behind, or the
// extension runs on a mixture of two schema states — which is exactly the
// failure mode that is invisible until it is not.
S.applySettings(stubSettings({[PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT]: 99}));
check('a guarded key takes the loaded value', S.VAULT_CLEAR_CLIPBOARD_TIMEOUT === 99,
    String(S.VAULT_CLEAR_CLIPBOARD_TIMEOUT));
S.applySettings(stubSettings({}, [PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT]));
check('and falls back on the next load rather than keeping 99 stale',
    S.VAULT_CLEAR_CLIPBOARD_TIMEOUT === 20, String(S.VAULT_CLEAR_CLIPBOARD_TIMEOUT));
S.applySettings(stubSettings({[PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT]: 7}));
check('and takes a new value again afterwards', S.VAULT_CLEAR_CLIPBOARD_TIMEOUT === 7);

// The other half of the contract, and it is a deliberate one: a key that is not
// wrapped THROWS when the schema lacks it. GSettings raises on an unknown key
// rather than returning a default, so a missing key has to be either guarded or
// known to exist in every schema the extension supports. Anything else would be a
// silent zero.
let threw = false;
try {
    S.applySettings(stubSettings({}, [PrefsFields.PREVIEW_SIZE]));
} catch (e) {
    threw = true;
}
check('an unguarded key that the schema lacks does throw, by design', threw,
    'a silent default would hide a schema mismatch');
S.applySettings(stubSettings({[PrefsFields.PREVIEW_SIZE]: 77}));
check('and a complete load still works afterwards', S.MAX_ENTRY_LENGTH === 77);

console.log('\n6. the keys an older schema may not have all fall back safely');
// GSettings throws on an unknown key, so each of these is wrapped. The
// fallbacks are not cosmetic: they decide what a shell running an older
// compiled schema does with a feature it has never heard of, and each one is
// the CONSERVATIVE choice — never convert an archive, never clear a clipboard,
// never prompt more often than before.
//
// Each key is exercised on its own. A shared load would leave the other
// fallbacks untriggered and the assertions would be reading values the stub
// supplied, not values the fallback produced.
const GUARDED = [
    [PrefsFields.PREVIEW_ON_HOVER, () => S.PREVIEW_ON_HOVER, true,
        'on: a preview you cannot switch off is better than one you cannot switch on'],
    [PrefsFields.VAULT_FORMAT_7Z, () => S.VAULT_FORMAT_7Z, false,
        'off: never convert an archive unasked'],
    [PrefsFields.VAULT_PASSWORD_REQUEST, () => S.VAULT_PASSWORD_REQUEST, 'session',
        "'session': the least frequent prompt"],
    [PrefsFields.VAULT_RESET_SEARCH_ON_CLOSE, () => S.VAULT_RESET_SEARCH_ON_CLOSE, true,
        'on: keep the behaviour the user already had'],
    [PrefsFields.VAULT_CLEAR_CLIPBOARD, () => S.VAULT_CLEAR_CLIPBOARD, true,
        'on: keep clearing, as before'],
    [PrefsFields.VAULT_CLEAR_CLIPBOARD_TIMEOUT, () => S.VAULT_CLEAR_CLIPBOARD_TIMEOUT, 20,
        'the previous default'],
];
for (const [key, read, want, why] of GUARDED) {
    if (!ALL_KEYS.includes(key)) {
        check(`${key} exists in the schema`, false, 'PrefsFields no longer names it');
        continue;
    }
    S.applySettings(stubSettings({}, [key]));
    check(`${key} falls back to ${JSON.stringify(want)} — ${why}`,
        read() === want, String(read()));
}
// The "user chose it" guard reads a DIFFERENT accessor (get_user_value), so it
// has to be exercised on its own or the other key's absence is what is tested.
S.applySettings(stubSettings({}, [PrefsFields.VAULT_FORMAT_7Z]));
check('and the "user chose it" guard falls back to off with it',
    S.VAULT_FORMAT_7Z_USER_SET === false, String(S.VAULT_FORMAT_7Z_USER_SET));
S.applySettings(stubSettings({[PrefsFields.VAULT_FORMAT_7Z]: true}));
check('a key the user actually chose makes the guard true, so a conversion may happen',
    S.VAULT_FORMAT_7Z_USER_SET === true, String(S.VAULT_FORMAT_7Z_USER_SET));
// Untouched is the case the guard exists for: the value may equal the default,
// but the user never asked, so a legacy archive must not be converted just
// because the default moved. It needs its own stub — the value is present and
// readable while get_user_value still answers null, which is not something a
// single values map can express.
const untouched = stubSettings({[PrefsFields.VAULT_FORMAT_7Z]: false});
untouched.get_user_value = () => null;
S.applySettings(untouched);
check('a key that is present but untouched is still "not the user\'s choice"',
    S.VAULT_FORMAT_7Z_USER_SET === false, String(S.VAULT_FORMAT_7Z_USER_SET));
const untouchedTrue = stubSettings({[PrefsFields.VAULT_FORMAT_7Z]: true});
untouchedTrue.get_user_value = () => null;
S.applySettings(untouchedTrue);
check('even when the value happens to equal the new default',
    S.VAULT_FORMAT_7Z_USER_SET === false, String(S.VAULT_FORMAT_7Z_USER_SET));

console.log('\n7. the mirrors are LIVE, not copies taken at import');
// The property the whole design rests on. Reading straight after a write would
// pass even for a snapshot, so the read happens after a turn of the main loop —
// long enough that a copy made at import time would already be stale.
S.applySettings(stubSettings({[PrefsFields.PREVIEW_SIZE]: 51}));
const before = S.MAX_ENTRY_LENGTH;
S.applySettings(stubSettings({[PrefsFields.PREVIEW_SIZE]: 12}));
await wait(20);
check('a write is visible to a later read', S.MAX_ENTRY_LENGTH === 12,
    `${before} then ${S.MAX_ENTRY_LENGTH}`);
check('and the value really changed', before === 51 && S.MAX_ENTRY_LENGTH === 12);

console.log('\n8. the two setters exist because imports are read-only');
S.setNextHistoryClear(1700000000);
check('setNextHistoryClear writes the mirror', S.NEXT_HISTORY_CLEAR === 1700000000,
    String(S.NEXT_HISTORY_CLEAR));
// applySettings overwrites it from the schema, which is the point: on start the
// scheduled moment comes from disk, and only the scheduler moves it after that.
S.applySettings(stubSettings({[PrefsFields.NEXT_HISTORY_CLEAR]: 99}));
check('and a settings load still wins over a scheduled value',
    S.NEXT_HISTORY_CLEAR === 99, String(S.NEXT_HISTORY_CLEAR));

S.applySettings(stubSettings({[PrefsFields.EXCLUDED_APPS]: ['A', 'B']}));
check('resetExcludedApps clears the list', S.EXCLUDED_APPS.length === 2);
S.resetExcludedApps();
check('and leaves it empty', S.EXCLUDED_APPS.length === 0,
    JSON.stringify(S.EXCLUDED_APPS));

console.log('\n9. the strip rule follows the two settings it reads');
// It lives here because it is defined in terms of the mirrors, and it is
// applied to a captured value — the point at which the settings mean something.
const cases = [
    [{}, '  padded  ', '  padded  '],
    [{ [PrefsFields.STRIP_TEXT]: true }, '  padded  ', 'padded'],
    [{ [PrefsFields.STRIP_TEXT]: true }, '\n\nline\n\n', '\n\nline\n\n'],
    [{ [PrefsFields.STRIP_LINE_BREAKS]: true }, '\n\nline\n\n', 'line'],
    [{ [PrefsFields.STRIP_LINE_BREAKS]: true }, '  line  ', '  line  '],
    [{
        [PrefsFields.STRIP_TEXT]: true, [PrefsFields.STRIP_LINE_BREAKS]: true,
    }, '\n  \tline \t\n', 'line'],
];
for (const [values, input, want] of cases) {
    S.applySettings(stubSettings(values));
    const got = S.stripClipboardEdges(input);
    check(`${JSON.stringify(values).slice(0, 60).padEnd(62)} ${JSON.stringify(input)} → ${JSON.stringify(got)}`,
        got === want, `want ${JSON.stringify(want)}`);
}
// With both on it must agree with String.trim(), which is the definition it is
// supposed to be equivalent to.
S.applySettings(stubSettings({
    [PrefsFields.STRIP_TEXT]: true, [PrefsFields.STRIP_LINE_BREAKS]: true,
}));
for (const v of [' \n\t x \n\t ', 'no-padding', '\n', ' ', '\t\n \t', 'a b']) {
    check(`both on: ${JSON.stringify(v)} === trim()`,
        S.stripClipboardEdges(v) === v.trim(), JSON.stringify(S.stripClipboardEdges(v)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} settings check(s) failed`);
