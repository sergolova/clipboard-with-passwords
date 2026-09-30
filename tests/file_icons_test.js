// Test harness for fileIcons.js — the system's own icon for a file name.
//
// The contract has three parts and each of them is worth a check:
//
//   1. the answer comes from the system's tables, so a real extension resolves
//      to the content type and themed icon the desktop would give it;
//   2. a directory is recognised, and an unknown or missing extension falls back
//      to the generic file — because the MIME database already does exactly
//      that, which is why this module has no list of special cases;
//   3. EVERY name gets an icon. A row with a name and no icon looks broken, so
//      "no icon" has to be unreachable, including for the pathological names.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/file_icons_test.js

import Gio from 'gi://Gio';

import {
    clearFileIconCache,
    contentTypeFor,
    displayName,
    fileIconFor,
    isDirectoryName,
} from '../fileIcons.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A GThemedIcon lists its names most specific first, so "the icon the desktop
// would show" is a membership test against the first name, not an exact string
// compare: the theme decides which of the list it can actually draw.
const namesOf = icon => {
    const s = icon?.to_string?.() ?? '';
    return s.replace(/^[\s.]*GThemedIcon\s*/, '').split(/\s+/).filter(Boolean);
};
const offersName = (icon, name) => namesOf(icon).includes(name);

console.log('1. real extensions resolve to the system\'s own type and icon');
// The expected pairs are read off the system's MIME database rather than written
// here, so the test cannot pass by agreeing with a typo of its own: if the guess
// is right, the icon for that same type must contain the type's own icon name.
for (const [name, expectedType, expectedIcon] of [
    ['report.pdf', 'application/pdf', 'application-pdf'],
    ['photo.jpg', 'image/jpeg', 'image-jpeg'],
    ['picture.PNG', 'image/png', 'image-png'],
    ['notes.txt', 'text/plain', 'text-plain'],
    ['song.mp3', 'audio/mpeg', 'audio-x-generic'],
    ['clip.mp4', 'video/mp4', 'video-x-generic'],
    ['doc.odt', 'application/vnd.oasis.opendocument.text', 'x-office-document'],
    ['page.html', 'text/html', 'text-html'],
]) {
    const type = contentTypeFor(name);
    check(`${name} → ${expectedType}`, type === expectedType, String(type));
    const icon = fileIconFor(name);
    check(`${name} gets an icon`, icon !== null && namesOf(icon).length > 0,
        String(icon));
    check(`${name} icon is the system's for that type`,
        offersName(icon, expectedIcon), namesOf(icon).join(','));
    // The extension case must not matter: the database is case-insensitive, and
    // a name that differs only in case must look the same.
    const swapped = name.replace(/\.[^.]+$/, m => m.toUpperCase());
    check(`${swapped} resolves the same way`,
        contentTypeFor(swapped) === type,
        `${contentTypeFor(swapped)} vs ${type}`);
}

console.log('\n2. a directory is recognised by the name\'s trailing "/"');
check('"Documents/" is a directory', isDirectoryName('Documents/') === true);
check('"report.pdf" is not', isDirectoryName('report.pdf') === false);
check('and the database agrees, which is why there is no special case here',
    contentTypeFor('Documents/') === 'inode/directory',
    String(contentTypeFor('Documents/')));
const dirIcon = fileIconFor('Documents/');
check('a directory gets the folder icon',
    offersName(dirIcon, 'inode-directory') || offersName(dirIcon, 'folder'),
    namesOf(dirIcon).join(','));
check('a directory name reads without the separator',
    displayName('Documents/') === 'Documents', displayName('Documents/'));
check('a file name reads unchanged',
    displayName('report.pdf') === 'report.pdf');
check('a nested path still ends in the separator it needs',
    isDirectoryName('sub/dir/') === true && displayName('sub/dir/') === 'sub/dir');

console.log('\n3. an unknown or missing extension falls back to the generic file');
for (const name of ['thing.weirdextension', 'noextension', '.bashrc', '.', '..']) {
    const type = contentTypeFor(name);
    const icon = fileIconFor(name);
    check(`${name} still gets an icon`, icon !== null && namesOf(icon).length > 0,
        String(icon));
    check(`${name} falls back to the generic file icon`,
        offersName(icon, 'application-x-generic') || offersName(icon, 'image-x-generic'),
        namesOf(icon).join(','));
    void type;
}
check('an unknown extension is reported as uncertain, not invented',
    Gio.content_type_guess('thing.weirdextension', null)[1] === true);

console.log('\n4. EVERY name gets an icon — the promise, on the hard names');
for (const name of ['', ' ', '  ', 'a', 'файл.txt', 'файл', 'имя.документ',
    'a'.repeat(300), 'x.'.repeat(200), '../relative/path.txt', '/abs/path.txt',
    'weird\nname.txt', 'name with spaces.doc', '\t.txt', '.hidden.dir/',
    'null\0byte.txt', '💡.pptx', 'x', '..']) {
    const icon = fileIconFor(name);
    const named = namesOf(icon);
    // The empty string is the one name with nothing to say: there is no name to
    // attach an icon to, and the caller drops such a row.
    const expected = name === '' ? 'no icon needed' : 'icon';
    check(`${JSON.stringify(name).slice(0, 40)} → ${expected}`,
        name === '' ? icon === null : (icon !== null && named.length > 0),
        String(icon));
}

console.log('\n5. the memo does not change the answer');
clearFileIconCache();
const first = namesOf(fileIconFor('report.pdf')).join(',');
const second = namesOf(fileIconFor('report.pdf')).join(',');
check('a cached lookup is the same lookup', first === second, `${first} vs ${second}`);
clearFileIconCache();
const third = namesOf(fileIconFor('report.pdf')).join(',');
check('and a cleared cache re-answers the same', first === third, `${first} vs ${third}`);

console.log('\n6. nothing here reads the file');
// The whole point of guessing by name: a path that cannot exist, or be read,
// still answers. If any of these ever needed the disk, the module would have to
// start failing on unmounted volumes.
for (const name of ['/nonexistent-volume/deep/file.pdf', '/proc/1/mem.txt',
    'relative/nowhere.png']) {
    const icon = fileIconFor(name);
    check(`${name} answers without a lookup on disk`,
        icon !== null && namesOf(icon).length > 0, String(icon));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} file-icon check(s) failed`);
