// Test harness for the registry loader: what one bad record costs.
//
// The property under test is not "can a record be read" — that is
// registry_entry_test.js — but "what does an unreadable record cost". A record
// whose mimetype is neither text/* nor image/* carries no contents field, and
// handing that undefined to GIO is an argument-type error. fromJSON() is async,
// so the error arrives as a rejection, and a rejection inside Promise.all()
// rejects the whole load, which the loader's catch turns into an empty history:
// one bad record used to take every entry with it.
//
// The harness writes a real registry.txt into a temporary directory, points a
// real Registry at it, and reads it back, so the whole path is exercised
// including the file IO.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/registry_load_test.js

import GLib from 'gi://GLib';

import {Registry} from '../registry.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = GLib.dir_make_tmp('cwp-load-XXXXXX');
const REGISTRY = `${tmp}/registry.txt`;

// A settings stub: the loader reads the history size from it, and that is all.
const settings = {get_int: () => 100, get_boolean: () => false, get_string: () => ''};

function registryFor(records) {
    GLib.file_set_contents(REGISTRY, JSON.stringify(records));
    const registry = new Registry({settings, uuid: 'cwp-load-test'});
    // The constructor derives the paths from the user cache dir; point it at the
    // temporary one instead of writing into the real cache.
    registry.REGISTRY_DIR = tmp;
    registry.REGISTRY_PATH = REGISTRY;
    registry.BACKUP_REGISTRY_PATH = `${REGISTRY}~`;
    return registry;
}

const good = (mimetype, contents) => ({favorite: false, mimetype, contents});
const bad = {favorite: false, mimetype: 'application/rtf'};
const noPayload = {favorite: false, mimetype: 'image/jpeg', contents: `${tmp}/gone`};

console.log('1. a registry of good records loads completely');
let registry = registryFor([
    good('text/plain;charset=utf-8', 'first'),
    good('text/plain;charset=utf-8', 'second'),
    good('text/html', '<b>third</b>'),
]);
let entries = await registry.read();
check('all three records came back',
    entries.length === 3, `${entries.length} of 3`);
check('in order', entries.map(e => e.getStringValue()).join('|') === 'first|second|<b>third</b>',
    entries.map(e => e.getStringValue()).join('|'));

console.log('\n2. one record with no contents costs that record only');
registry = registryFor([
    good('text/plain;charset=utf-8', 'alpha'),
    bad,
    good('text/plain;charset=utf-8', 'beta'),
]);
entries = await registry.read();
check('the two readable records survived', entries.length === 2, `${entries.length} of 2`);
check('and the history is NOT empty — the failure is local',
    entries.length > 0, 'the whole history was lost');
check('the unreadable one is the missing one',
    entries.map(e => e.getStringValue()).join('|') === 'alpha|beta',
    entries.map(e => e.getStringValue()).join('|'));

console.log('\n3. several bad records in a row still cost only themselves');
registry = registryFor([
    {favorite: false, mimetype: 'application/rtf'},
    {favorite: false, mimetype: 'application/x-kde-cursors'},
    good('text/plain;charset=utf-8', 'gamma'),
    {favorite: false, mimetype: 'application/octet-stream'},
]);
entries = await registry.read();
check('the one good record survived', entries.length === 1, `${entries.length}`);
check('and it is the right one', entries[0]?.getStringValue() === 'gamma',
    entries[0]?.getStringValue());

console.log('\n4. an image record whose payload file is gone is still self-healing');
registry = registryFor([
    good('text/plain;charset=utf-8', 'delta'),
    noPayload,
    good('text/plain;charset=utf-8', 'epsilon'),
]);
entries = await registry.read();
check('the missing payload is dropped, the rest loads',
    entries.length === 2, `${entries.length} of 2`);
check('and both are the text records',
    entries.map(e => e.getStringValue()).join('|') === 'delta|epsilon',
    entries.map(e => e.getStringValue()).join('|'));

console.log('\n5. the bad records are really unreadable, not merely dropped');
// Guards the tests above: if fromJSON() started returning an entry for these,
// they would pass for the wrong reason and the loader would be storing a record
// it cannot paste.
const {ClipboardEntry} = await import('../registry.js');
for (const record of [bad, {favorite: false, mimetype: 'application/octet-stream'}]) {
    const restored = await ClipboardEntry.fromJSON(record);
    check(`${record.mimetype} reads back as null`, restored === null,
        String(restored));
}

console.log('\n6. a registry that is not an array of objects does not take the rest');
// The outer catch still covers a file that is not valid JSON at all; that is
// the one case where an empty history is the right answer, because there is no
// record to keep.
GLib.file_set_contents(REGISTRY, 'not json at all');
registry = registryFor([]); // re-point after the raw write
GLib.file_set_contents(REGISTRY, 'not json at all');
entries = await registry.read();
check('a corrupt file yields an empty history rather than a throw',
    Array.isArray(entries) && entries.length === 0, `${entries.length}`);

// Clean up.
const {Gio} = await import('gi://Gio');
try {
    Gio.file_new_for_path(REGISTRY).delete(null);
} catch (e) {
    // a leftover temp file is not worth failing the run over
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} registry loader check(s) failed`);
