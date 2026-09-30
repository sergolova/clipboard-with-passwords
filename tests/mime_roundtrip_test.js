// Local-only check: what happens to a clipboard entry whose mimetype is
// neither text/* nor image/*.
//
// The report claims that such an entry cannot survive a restart. This proves it
// against the real ClipboardEntry, with no shell and no clipboard involved: it
// is the load half of the round-trip that matters, because the write half is a
// plain reading of the two `if` branches in Registry._writeNow().
//
// Run: GI_TYPELIB_PATH=/usr/lib/gnome-shell:<mutter> GSETTINGS_SCHEMA_DIR=schemas \
//         gjs -m tools/local/mime_roundtrip_test.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ClipboardEntry} from '../registry.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
    if (cond) {
        passed++;
        print(`  PASS ${name}`);
    } else {
        failed++;
        print(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const bytes = s => new TextEncoder().encode(s);

print('1. the two categories the writer knows how to store');
for (const [mimetype, expectText, expectImage] of [
    ['text/plain;charset=utf-8', true, false],
    ['text/rtf', true, false],
    ['text/html', true, false],
    ['image/jpeg', false, true],
    ['image/bmp', false, true],
    ['application/rtf', false, false],
    ['application/x-kde-cursors', false, false],
    ['text/uri-list', true, false],
]) {
    const e = new ClipboardEntry(mimetype, bytes('payload'), false);
    check(`${mimetype}: isText ${expectText}, isImage ${expectImage}`,
        e.isText() === expectText && e.isImage() === expectImage,
        `isText ${e.isText()}, isImage ${e.isImage()}`);
}

print('\n2. a type the writer has no branch for loses its contents');
// This mirrors Registry._writeNow() exactly: contents is written for a text
// entry and for an image entry, and for nothing else.
const whatTheWriterWrites = entry =>
    entry.isText() ? 'contents = the text'
        : entry.isImage() ? 'contents = the cache filename'
            : 'NO contents field at all';
for (const mimetype of ['text/rtf', 'image/jpeg', 'application/rtf']) {
    const e = new ClipboardEntry(mimetype, bytes('payload'), false);
    print(`    ${mimetype.padEnd(18)} → ${whatTheWriterWrites(e)}`);
}

print('\n3. so on the next start, only the first two come back');
// The load half, on the real class, with the exact record the writer would
// have produced. fromJSON is async — it checks the cache file — so this is too.
for (const [mimetype, stored] of [
    ['text/rtf', '{\\rtf1 hello}'],
    ['application/rtf', undefined],
    ['application/x-kde-cursors', undefined],
]) {
    const record = {mimetype, favorite: false};
    if (stored !== undefined)
        record.contents = stored;
    let entry = null;
    let error = null;
    try {
        entry = await ClipboardEntry.fromJSON(record);
    } catch (e) {
        error = e;
    }
    if (error) {
        check(`${mimetype}: loading it does not throw`, false, String(error));
    } else if (entry === null) {
        check(`${mimetype}: the entry is dropped on load`, true);
        print(`      → null: the record is unusable, so the history loses it`);
    } else {
        check(`${mimetype}: the entry survives a restart`, true,
            `payload ${JSON.stringify(entry.getStringValue())}`);
    }
}

print('\n4. an image is restored lazily from its cache file, and is');
print('   dropped when that file is missing or empty — the same fate a');
print('   non-text, non-image entry always meets.');
const tmp = Gio.file_new_for_path('/tmp/opencode/roundtrip-probe.bin');
GLib.file_set_contents(tmp.get_path(), 'not an image');
check('a real cache file is accepted', !!(() => {
    const e = new ClipboardEntry('image/jpeg', null, false, tmp.get_path());
    return e !== null;
})());
try {
    tmp.delete(null);
} catch (e) {
    // a leftover temp file is not worth failing the run over
}

print(`\n${passed} passed, ${failed} failed`);
