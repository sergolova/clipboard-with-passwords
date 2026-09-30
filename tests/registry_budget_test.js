// Test harness for the registry size ceiling — the policy, and the refusal.
//
// The bug this guards against is a data-loss one, and it was found the worst
// way: a 120 000-line text file is 8.1 MB, which as one registry record is
// 8.2 MB, which is over the default 5 MB «Cache file size» ceiling on its own.
// Capturing it worked, the item appeared in the menu, and then the NEXT shell
// start moved the whole registry aside and came up empty — 65 records and 25
// cached images, with nothing but an unnoticed `registry.txt~` as evidence.
//
// So the ceiling is now enforced before the entry exists, and the user is told.
// These tests pin the three things that has to mean:
//
//   1. the arithmetic — what fits, what does not, and by how much;
//   2. the measurement — the real serialized size of a real entry, including
//      the JSON escaping that a per-character estimate gets wrong;
//   3. the refusal — that a fitting entry is allowed through and an oversized
//      one is turned away, and that the read-side guard stays as the backstop.
//
// The sizes here are the measured ones, not invented, for the same reason the
// image deadlines are: a ceiling expressed only in terms of its own test's
// fixtures would still pass with the real-world threshold in the wrong place.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   GSETTINGS_SCHEMA_DIR=schemas gjs -m tools/local/registry_budget_test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Registry, ClipboardEntry} from '../registry.js';
import {budgetBytesFrom, formatBytes, planAddition} from '../registryBudget.js';

// A real 120 000-line capture, measured on the user's own clipboard.
const MEASURED_TEXT_BYTES = 8507870;
const MEASURED_RECORD_BYTES = 8630000;   // 8.23 MB as JSON, rounded up
const DEFAULT_CAP_MB = 5;               // the schema default for cache-size

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const MIB = 1024 * 1024;

function makeRegistry(dir, cacheSizeMb) {
    const registry = new Registry({
        settings: {
            get_int: key => (key === 'cache-size' ? cacheSizeMb : 60),
            get_boolean: () => false,
        },
        uuid: 'budget-test',
    });
    registry.REGISTRY_DIR = dir;
    registry.REGISTRY_PATH = `${dir}/registry.txt`;
    registry.BACKUP_REGISTRY_PATH = `${dir}/registry.txt~`;
    return registry;
}

console.log('1. the ceiling comes from the setting, with a floor');
check('5 MB is 5 MiB', budgetBytesFrom(5) === 5 * MIB, String(budgetBytesFrom(5)));
check('1 MB is 1 MiB', budgetBytesFrom(1) === MIB);
check('1024 MB is 1024 MiB', budgetBytesFrom(1024) === 1024 * MIB);
check('a non-numeric setting cannot mean "no limit"',
    budgetBytesFrom(NaN) === MIB, String(budgetBytesFrom(NaN)));
check('nor can zero', budgetBytesFrom(0) === MIB, String(budgetBytesFrom(0)));
check('nor can a negative', budgetBytesFrom(-5) === MIB, String(budgetBytesFrom(-5)));
check('a fractional setting is rounded, not truncated to nothing',
    budgetBytesFrom(5.4) === 5 * MIB, String(budgetBytesFrom(5.4)));

console.log('\n2. the arithmetic: what fits, and by how much it does not');
const cap = budgetBytesFrom(DEFAULT_CAP_MB);
const fits = planAddition({currentBytes: 0, recordBytes: 100, capBytes: cap});
check('a first small entry fits', fits.fits === true);
check('and reports the numbers back', fits.currentBytes === 0 && fits.recordBytes === 100 &&
    fits.projectedBytes === 100 && fits.capBytes === cap);
check('an empty registry plus an empty record still fits',
    planAddition({currentBytes: 0, recordBytes: 0, capBytes: cap}).fits === true);

const exact = planAddition({currentBytes: cap - 100, recordBytes: 100, capBytes: cap});
check('landing exactly ON the ceiling fits (the guard is ">=", so "=" must pass)',
    exact.fits === true, `projected ${exact.projectedBytes} vs cap ${cap}`);

const over = planAddition({currentBytes: cap - 100, recordBytes: 101, capBytes: cap});
check('one byte over does not', over.fits === false);
check('and the shortfall is exactly that one byte',
    over.shortfallBytes === 1, String(over.shortfallBytes));
check('the shortfall is never negative on a fitting addition',
    exact.shortfallBytes === 0, String(exact.shortfallBytes));

// The rule is on the PROJECTED total, not on the record alone — that is the
// whole point, because the read path fails on the total.
const creep = [];
for (let i = 0; i < 12; i++) {
    const plan = planAddition({
        currentBytes: i * (MIB / 2), recordBytes: MIB / 2, capBytes: cap,
    });
    creep.push(plan.fits);
}
// Ten half-megabyte records land exactly on the 5 MB ceiling and the eleventh
// breaks it — which is the point: no single record is over the limit, so only
// the projected total can catch the eleventh.
check('ten half-MB records land exactly on the ceiling and fit',
    creep.slice(0, 10).every(Boolean), creep.map(f => (f ? '1' : '0')).join(''));
check('the eleventh does not, though it is well under the ceiling alone',
    creep.slice(10).every(f => !f), creep.map(f => (f ? '1' : '0')).join(''));

console.log('\n3. the measured record size is the real serialized size');
const dir = GLib.dir_make_tmp('cwp-budget-XXXXXX');
const registry = makeRegistry(dir, DEFAULT_CAP_MB);

const small = new ClipboardEntry('text/plain;charset=utf-8',
    new TextEncoder().encode('hello clipboard'), false);
const smallPlan = registry.canStoreEntry(small);
check('a short text entry fits the default ceiling', smallPlan.fits === true,
    `record ${smallPlan.recordBytes} B`);
// The record is JSON, so it is always a little larger than the text, and the
// amount matters: a per-character estimate would miss it and the ceiling would
// be reachable.
check('the record is measured, and is larger than its text',
    smallPlan.recordBytes > 'hello clipboard'.length,
    `${smallPlan.recordBytes} B`);

// Non-ASCII is where counting characters stops working, and the direction is
// worth pinning: JSON.stringify leaves non-ASCII as-is (it escapes only control
// characters, quotes and lone surrogates), so the inflation comes from UTF-8 —
// two bytes per Cyrillic character, and the ceiling is therefore tested in bytes
// because bytes are what the file is made of.
const cyrillic = 'ы'.repeat(1000);
const cyrillicEntry = new ClipboardEntry('text/plain;charset=utf-8',
    new TextEncoder().encode(cyrillic), false);
const cyrillicPlan = registry.canStoreEntry(cyrillicEntry);
check('1000 Cyrillic characters cost ~2000 bytes, not 1000',
    cyrillicPlan.recordBytes > 2000 && cyrillicPlan.recordBytes < 2200,
    `${cyrillicPlan.recordBytes} B for ${cyrillic.length} chars`);
check('and JSON does not inflate them to \\uXXXX escapes',
    cyrillicPlan.recordBytes < 6000,
    'stringify escapes only control characters, not all non-ASCII');

console.log('\n4. the refusal: the measured capture does not fit the default');
// Real UTF-8 TEXT, not synthetic bytes. That distinction is not pedantry: a
// buffer of arbitrary byte values is mostly invalid UTF-8, every bad byte
// decodes to U+FFFD, and U+FFFD is three bytes of UTF-8 — so random bytes
// "measure" at nearly three times their size and the fixture would be testing a
// payload no clipboard ever carries. (The expansion is real and is checked
// separately below; it just is not what a 120 000-line file does.)
const HUGE_LINE = 'line with some words in it to be realistic text\n';
// Counted off HUGE_LINE's own length, not a guessed one: the first version
// divided by 50 while the line is 49 characters, which quietly produced a
// fixture 170 KB short and a "measured" figure that was simply wrong.
const hugeText = HUGE_LINE.repeat(Math.ceil(MEASURED_TEXT_BYTES / HUGE_LINE.length))
    .slice(0, MEASURED_TEXT_BYTES);
check(`the fixture really is ${(MEASURED_TEXT_BYTES / MIB).toFixed(2)} MB of text`,
    new TextEncoder().encode(hugeText).length === MEASURED_TEXT_BYTES,
    `${new TextEncoder().encode(hugeText).length} bytes`);
const hugeEntry = new ClipboardEntry('text/plain;charset=utf-8',
    new TextEncoder().encode(hugeText), false);
const hugePlan = registry.canStoreEntry(hugeEntry);
check(`an ${(MEASURED_TEXT_BYTES / MIB).toFixed(1)} MB text is measured as ~8.2 MB`,
    hugePlan.recordBytes > 8 * MIB && hugePlan.recordBytes < 9 * MIB,
    `${(hugePlan.recordBytes / MIB).toFixed(2)} MB`);
check('and is REFUSED against the default ceiling', hugePlan.fits === false);
check('reporting by how much it does not fit',
    hugePlan.shortfallBytes > 3 * MIB,
    `${(hugePlan.shortfallBytes / MIB).toFixed(2)} MB over`);

// The decode expansion, as its own check: the ceiling is tested against the
// DECODED size, which is what actually gets written, and for a payload that is
// not valid UTF-8 the decoded string is larger than the bytes it came from.
const garbage = new Uint8Array(4 * MIB).fill(0xff);
const garbagePlan = registry.canStoreEntry(
    new ClipboardEntry('text/plain;charset=utf-8', garbage, false));
check('a 4 MB non-UTF-8 payload measures LARGER than 4 MB, because it decodes to U+FFFD',
    garbagePlan.recordBytes > 4 * MIB,
    `${(garbagePlan.recordBytes / MIB).toFixed(2)} MB from 4.00 MB of bytes`);
check('and is refused for it — the check measures what would be written',
    garbagePlan.fits === false);

// The same entry is fine once the user raises the setting — which is the
// remedy the notification names, so it has to be true.
const roomy = makeRegistry(dir, 200);
const roomyPlan = roomy.canStoreEntry(hugeEntry);
check('the same entry fits a 200 MB ceiling', roomyPlan.fits === true,
    `${(roomyPlan.projectedBytes / MIB).toFixed(2)} MB vs ${(roomyPlan.capBytes / MIB)} MB`);

console.log('\n5. an image record stays cheap — the payload is a separate file');
// Only a text entry is stored inline. An image's record holds a path, so the
// ceiling must never be what stops a large screenshot.
const imageDir = GLib.dir_make_tmp('cwp-budget-img-XXXXXX');
const imageRegistry = makeRegistry(imageDir, DEFAULT_CAP_MB);
const imageEntry = new ClipboardEntry('image/png', new Uint8Array(4 * MIB), false);
const imagePlan = imageRegistry.canStoreEntry(imageEntry);
check('a 4 MB image has a tiny record', imagePlan.recordBytes < 4096,
    `${imagePlan.recordBytes} B`);
check('so it fits the default ceiling', imagePlan.fits === true);
GLib.rmdir(imageDir);

console.log('\n6. a nearly full registry blocks new copies, and says so');
// The other half of the rule: when the history is nearly full, ordinary small
// copies are refused too. That is correct — the read path fails on the total —
// and it is only acceptable because the refusal is reported rather than silent.
// Headroom left deliberately smaller than one record: 10 bytes, where even
// "just a word" needs ~70. Anything that merely left "a little space" would fit
// and the test would pass for the wrong reason.
GLib.file_set_contents(registry.REGISTRY_PATH, 'x'.repeat(5 * MIB - 10));
const nearFull = makeRegistry(dir, DEFAULT_CAP_MB);
const tinyPlan = nearFull.canStoreEntry(new ClipboardEntry('text/plain;charset=utf-8',
    new TextEncoder().encode('just a word'), false));
check('a nearly-full registry refuses even a small entry', tinyPlan.fits === false,
    `record ${tinyPlan.recordBytes} B, headroom 10 B`);
check('and the numbers for the message are present',
    Number.isFinite(tinyPlan.recordBytes) && Number.isFinite(tinyPlan.projectedBytes) &&
        Number.isFinite(tinyPlan.capBytes) && tinyPlan.shortfallBytes > 0);
GLib.unlink(registry.REGISTRY_PATH);

console.log('\n7. a missing registry file is not a reason to refuse anything');
const fresh = makeRegistry(dir, DEFAULT_CAP_MB);
check('with no file on disk, the first entry fits',
    fresh.canStoreEntry(small).fits === true);

console.log('\n8. the read-side guard is still there, as a backstop');
// The capture-time check makes it unreachable in normal operation, but the only
// ways to reach it are a LOWERED ceiling or a file written by an older version —
// and in both cases the history must still be preserved on disk rather than
// deleted, and the loss must be reported.
const wipeDir = GLib.dir_make_tmp('cwp-budget-wipe-XXXXXX');
const wipeRegistry = makeRegistry(wipeDir, 5);
const history = Array.from({length: 3}, (_, i) => ({
    mimetype: 'text/plain;charset=utf-8', contents: `entry ${i}`, favorite: false,
}));
GLib.file_set_contents(wipeRegistry.REGISTRY_PATH, JSON.stringify(history));
// A registry over the ceiling, as if written before the check existed.
GLib.file_set_contents(wipeRegistry.REGISTRY_PATH, 'x'.repeat(6 * MIB));
const afterWipe = await wipeRegistry.read();
check('an over-ceiling registry is still not loaded', afterWipe.length === 0);
check('but the file is kept, not deleted',
    GLib.file_test(wipeRegistry.BACKUP_REGISTRY_PATH, GLib.FileTest.EXISTS));
check('and the backup is the whole file, not a fragment',
    Gio.file_new_for_path(wipeRegistry.BACKUP_REGISTRY_PATH)
        .query_info('*', null, null).get_size() === 6 * MIB);
GLib.unlink(wipeRegistry.BACKUP_REGISTRY_PATH);
GLib.rmdir(wipeDir);

console.log('\n9. the sizes in the message are readable');
check('8200000 B reads as 7.8 MB, not 8200000', formatBytes(8200000) === '7.8 MB',
    formatBytes(8200000));
check('something huge reads in GB', formatBytes(2.5 * 1024 * MIB) === '2.5 GB',
    formatBytes(2.5 * 1024 * MIB));
check('a small size keeps its decimal', formatBytes(0.5 * MIB) === '0.5 MB',
    formatBytes(0.5 * MIB));
check('nonsense does not throw and does not invent a number',
    formatBytes(NaN) === '?' && formatBytes(-1) === '?');
check('zero is 0.0 MB, not an empty string', formatBytes(0) === '0.0 MB',
    formatBytes(0));

GLib.rmdir(dir);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} registry-budget check(s) failed`);
