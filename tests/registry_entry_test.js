// Test harness for ClipboardEntry.fromJSON() — the reader that turns a
// registry.txt record back into an entry.
//
// Focus: which records survive the read. A record whose image payload file is
// missing or empty must be dropped, because such an entry can neither be
// previewed nor pasted, and because a registry that keeps it desynchronizes
// the menu-item array from the history array (the last item then cannot be
// selected, and the failure used to abort the whole menu build). Records with
// a half-written payload are exactly what a crash during an image copy leaves
// behind, so this is a self-healing path, not a theoretical one.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/registry_entry_test.js

import GLib from 'gi://GLib';
import {ClipboardEntry} from '../registry.js';
import {contentTypeFor, isDirectoryName} from '../fileIcons.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

const tmp = GLib.dir_make_tmp('cwp-entry-XXXXXX');
const goodPath = `${tmp}/good-png`;
const emptyPath = `${tmp}/empty-png`;

GLib.file_set_contents(goodPath, 'PNG-not-really-but-non-empty');
// An interrupted write: the file exists, but nothing landed in it.
GLib.file_set_contents(emptyPath, '');
check('fixture: empty file is really 0 bytes',
    GLib.file_get_contents(emptyPath)[1].length === 0);

console.log('1. text records always survive (nothing to stat)');
const textEntry = await ClipboardEntry.fromJSON({
    mimetype: 'text/plain;charset=utf-8', contents: 'hello', favorite: false,
});
check('text entry is restored', textEntry !== null);
check('text entry keeps its value', textEntry.getStringValue() === 'hello');
check('text entry needs no cache file', textEntry.storedFilename === null);

console.log('2. image records with a real payload file survive, lazily');
const imageEntry = await ClipboardEntry.fromJSON({
    mimetype: 'image/png', contents: goodPath, favorite: true,
});
check('image entry is restored', imageEntry !== null);
check('image entry remembers its cache file', imageEntry.storedFilename === goodPath);
check('image entry is not loaded into memory', imageEntry.hasPayload() === false);
check('favorite flag survives', imageEntry.isFavorite() === true);

console.log('3. image records with a missing or empty payload are dropped');
const missingEntry = await ClipboardEntry.fromJSON({
    mimetype: 'image/png', contents: `${tmp}/never-written`, favorite: false,
});
check('missing payload file → null', missingEntry === null);
const emptyEntry = await ClipboardEntry.fromJSON({
    mimetype: 'image/png', contents: emptyPath, favorite: false,
});
check('0-byte payload file (interrupted write) → null', emptyEntry === null);

console.log('4. a payload that appears later is still picked up');
GLib.file_set_contents(emptyPath, 'PNG-now-complete');
const healed = await ClipboardEntry.fromJSON({
    mimetype: 'image/png', contents: emptyPath, favorite: false,
});
check('rewritten payload file → entry restored', healed !== null);

console.log('5. flags and metadata survive the read');
const tagged = await ClipboardEntry.fromJSON({
    mimetype: 'text/plain;charset=utf-8', contents: 'x', favorite: false,
    tag: 'work', protected: true,
});
check('tag survives', tagged.getTag() === 'work');
check('protected survives', tagged.isProtected() === true);
const legacy = await ClipboardEntry.fromJSON({
    mimetype: 'text/plain;charset=utf-8', contents: 'x', favorite: false,
    password: true,
});
check('legacy password flag is honoured as protected', legacy.isProtected() === true);
const noMime = await ClipboardEntry.fromJSON({contents: 'plain', favorite: false});
check('missing mimetype defaults to text', noMime !== null && noMime.isText());

console.log('6. uri-list names come out the way an icon lookup can use them');
// These names are the ONLY input to the icon lookup on a file row, and the
// lookup is by name: no stat, no sniffing. So a name that arrives with a
// carriage return welded to it, or that arrives empty, does not just render
// oddly — it resolves to the generic file icon, or to no icon at all, and the
// row silently loses the thing it is supposed to show.
const uriEntry = text => {
    const e = new ClipboardEntry('text/uri-list');
    e.setText(text);
    return e;
};
const namesOf = text => uriEntry(text).getURIListDisplay().fileNames;

check('a CRLF uri-list leaves no \\r on any name',
    JSON.stringify(namesOf('file:///home/x/a.pdf\r\nfile:///home/x/b.txt')) ===
        JSON.stringify(['a.pdf', 'b.txt']),
    JSON.stringify(namesOf('file:///home/x/a.pdf\r\nfile:///home/x/b.txt')));
check('a bare-LF uri-list is unchanged',
    JSON.stringify(namesOf('file:///home/x/a.pdf\nfile:///home/x/b.txt')) ===
        JSON.stringify(['a.pdf', 'b.txt']));
check('blank lines are still dropped',
    JSON.stringify(namesOf('file:///home/x/a.pdf\r\n\r\nfile:///home/x/b.txt\r\n')) ===
        JSON.stringify(['a.pdf', 'b.txt']));
check('a trailing CRLF adds no empty name',
    namesOf('file:///home/x/a.pdf\r\n').length === 1,
    JSON.stringify(namesOf('file:///home/x/a.pdf\r\n')));

// One directory copied on its own: the common path of a single path is that
// path's parent, so stripping the prefix leaves nothing behind. A blank name is
// a row with no icon and no text, and the user did copy something.
check('one copied directory keeps its own name',
    JSON.stringify(namesOf('file:///home/x/Documents/')) ===
        JSON.stringify(['Documents/']),
    JSON.stringify(namesOf('file:///home/x/Documents/')));
check('and the name it keeps still says it is a directory',
    isDirectoryName(namesOf('file:///home/x/Documents/')[0]) === true);
check('one copied file keeps its own name',
    JSON.stringify(namesOf('file:///home/x/Documents')) ===
        JSON.stringify(['Documents']));
check('one file at the filesystem root keeps its own name',
    JSON.stringify(namesOf('file:///report.pdf')) ===
        JSON.stringify(['report.pdf']),
    JSON.stringify(namesOf('file:///report.pdf')));
check('no name in any of those cases is empty',
    ['file:///home/x/Documents/', 'file:///home/x/Documents', 'file:///report.pdf']
        .every(t => namesOf(t).every(n => n.length > 0)));
check('directories nested in a shared parent keep their separator',
    JSON.stringify(namesOf('file:///home/x/Docs/\r\nfile:///home/x/Docs/inner/')) ===
        JSON.stringify(['Docs/', 'inner/']));
check('a single nested file is named, not pathed',
    JSON.stringify(namesOf('file:///home/x/sub/deep.pdf')) ===
        JSON.stringify(['deep.pdf']),
    JSON.stringify(namesOf('file:///home/x/sub/deep.pdf')));
check('files under one parent keep only their own segment',
    JSON.stringify(namesOf('file:///home/x/sub/a.pdf\r\nfile:///home/x/other/b.pdf')) ===
        JSON.stringify(['sub/a.pdf', 'other/b.pdf']),
    JSON.stringify(namesOf('file:///home/x/sub/a.pdf\r\nfile:///home/x/other/b.pdf')));

// The end of the chain: the name the entry hands out is the name the icon is
// decided by, so a name with a stray character must visibly cost the icon.
check('a \\r-free name resolves to its own type, a \\r-carrying one does not',
    contentTypeFor('a.pdf') === 'application/pdf' &&
        contentTypeFor('a.pdf\r') !== 'application/pdf',
    `${contentTypeFor('a.pdf')} vs ${contentTypeFor('a.pdf\r')}`);

// Cleanup
GLib.unlink(goodPath);
GLib.unlink(emptyPath);
GLib.rmdir(tmp);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    imports.system.exit(1);
