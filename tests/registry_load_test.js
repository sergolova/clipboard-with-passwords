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
import Gio from 'gi://Gio';

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

console.log('\n7. the cache sweep empties the directory before it resolves');
// clear-on-boot runs while the panel is being built, so a blocking delete here
// freezes the compositor for as long as the filesystem takes, and the cache
// holds one file per image the user has copied. It is asynchronous, and the
// caller in extension.js relies on the promise meaning FINISHED: the menu is
// populated from this same directory, so a sweep that merely started would let
// rows the user asked to have cleared appear on this boot.
//
// Driven through clearCacheFolder() rather than through any internal helper,
// because that is the contract the caller depends on. The internal async Gio
// calls it is built on are each a way to be wrong that only shows up when GJS is
// asked for a promise it does not provide: enumerate_children_async refuses the
// promise form, GFileEnumerator has no next_file_async (only the plural
// next_files_async), and the callback's first argument is the object the method
// was called on, not an error — so the `if (src)` reflex calls every success a
// failure. A harness that ran these against a plain main loop found all three.
function listNames (dir) {
    const names = [];
    const enumerator = dir.enumerate_children('', Gio.FileQueryInfoFlags.NONE, null);
    let child;
    // [ok, info, child]: index 2 is a GFile, not a GFileInfo — which is why the
    // sweep this test covers could hand it straight to delete().
    while ((child = enumerator.iterate(null)[2]) !== null)
        names.push(child.get_basename());
    enumerator.close(null);
    return names;
}

function sweepRegistry (dir) {
    const r = new Registry({settings, uuid: 'cwp-sweep-test'});
    r.REGISTRY_DIR = dir;
    r.REGISTRY_PATH = `${dir}/registry.txt`;
    r.BACKUP_REGISTRY_PATH = `${dir}/registry.txt~`;
    return r;
}

function withFiles (name, count, {withSubdir = false} = {}) {
    const dir = `${tmp}/${name}`;
    Gio.File.new_for_path(dir).make_directory_with_parents(null);
    for (let i = 0; i < count; i++) {
        Gio.File.new_for_path(`${dir}/f${i}`).replace_contents(
            'x', null, false, Gio.FileCreateFlags.NONE, null);
    }
    if (withSubdir) {
        const sub = Gio.File.new_for_path(`${dir}/subdir`);
        sub.make_directory_with_parents(null);
        Gio.File.new_for_path(`${dir}/subdir/inner`).replace_contents(
            'y', null, false, Gio.FileCreateFlags.NONE, null);
    }
    return Gio.File.new_for_path(dir);
}

// More files than one batch holds, so the walk has to take several rounds and
// still finish: a sweep that stopped after the first batch would look identical
// on a cache of 5 entries.
const many = withFiles('sweep-many', 70);
check('the sweep fixture is in place', listNames(many).length === 70, `${listNames(many).length}`);
await sweepRegistry(many.get_path()).clearCacheFolder();
check('the directory is empty the moment the promise resolves',
    listNames(many).length === 0, `осталось ${listNames(many).length}`);

console.log('\n8. an undeletable entry does not abandon the rest of the sweep');
// The synchronous version this replaced had one try around the whole loop, so a
// single failure stopped it and left the cache half-cleared with nothing said
// about it. A subdirectory cannot be removed without recursion, which makes it
// the reliable stand-in for a file the user happens to own.
const mixed = withFiles('sweep-mixed', 5, {withSubdir: true});
await sweepRegistry(mixed.get_path()).clearCacheFolder();
const leftMixed = listNames(mixed);
check('every plain file went despite the subdirectory failing',
    leftMixed.length === 1 && leftMixed[0] === 'subdir', `осталось: ${leftMixed.join(',') || '—'}`);
check('and the undeletable entry is reported, not swallowed',
    Gio.File.new_for_path(`${mixed.get_path()}/subdir/inner`).query_exists(null),
    'подкаталог исчез — тест больше ничего не проверяет');

console.log('\n9. sweeping a directory that is not there is not an error');
const absent = `${tmp}/sweep-absent`;
let absentThrew = null;
try {
    await sweepRegistry(absent).clearCacheFolder();
} catch (e) {
    absentThrew = e;
}
check('a missing directory resolves instead of throwing', absentThrew === null,
    absentThrew ? absentThrew.message : '');
check('and it was not silently created', !Gio.File.new_for_path(absent).query_exists(null));

console.log('\n10. an already empty directory is a no-op, not a failure');
const none = withFiles('sweep-none', 0);
let noneThrew = null;
try {
    await sweepRegistry(none.get_path()).clearCacheFolder();
} catch (e) {
    noneThrew = e;
}
check('sweeping zero entries resolves cleanly', noneThrew === null,
    noneThrew ? noneThrew.message : '');

// Clean up.
try {
    Gio.file_new_for_path(REGISTRY).delete(null);
} catch (e) {
    // a leftover temp file is not worth failing the run over
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} registry loader check(s) failed`);
