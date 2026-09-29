// The system's own file icon for a name, decided by the name alone.
//
// A file row in the history shows the name, and the name is all that is needed
// to say what kind of file it is: the freedesktop MIME database maps it to a
// content type, and the icon theme has a themed icon for that content type.
// Both are the system's own tables — nothing here encodes a list of extensions
// or a picture of a file type — so a name stays right when the user's MIME
// database or icon theme changes, and a type this file has never heard of still
// gets whatever the system gives for it.
//
// Two cases the database already settles, and which is why there is no list of
// special cases in this module:
//
//   * a directory — a file list writes a name that ends in "/", and the database
//     reads that as inode/directory, so a copied folder gets the folder icon;
//   * an unknown extension, a missing extension, and a dotfile like ".bashrc" —
//     all of them come back as the generic binary type, which is the generic
//     icon.
//
// The name is the ONLY input. The file is never opened, stat'ed or sniffed.
// That is deliberate, twice over: the lookup stays free for a path on an
// unmounted volume or a file the user cannot read, which is a normal state for a
// clipboard history; and the answer stays the same before and after the file
// changes on disk, because the icon describes the name the user sees rather
// than whatever the disk happens to hold now.
//
// Every name gets an icon. A missing MIME database is the one case that can
// leave a row without one, and the last-resort icon below exists for it — a
// generic file is a better answer than no icon at all.
//
// Only Gio is imported, so this module can be exercised by a plain `gjs` test
// without a shell.

import Gio from 'gi://Gio';

// The one name written out by hand. Everything else comes from the system's own
// tables, so there is exactly one place where an icon can be out of step with
// the desktop — and this is the fallback, the one whose absence would show.
const LAST_RESORT_ICON = 'application-x-generic';

// Resolving a name is a MIME database lookup and a themed-icon lookup, and both
// are pure functions of the name, so a row that is re-rendered (every settings
// change re-labels every row) must not repeat them. The key is the name itself
// rather than its extension on purpose: the database resolves compound
// extensions better than the final dot does — `archive.tar.gz` is
// `application/x-compressed-tar` to it, while everything after the last dot is
// only `gz` — so a key of "the extension" would be wrong for exactly the names
// where the guess is most interesting. The map is bounded in practice by the
// number of names a history can hold, and it dies with the shell.
const iconByName = new Map();

/**
 * The content type the system guesses for a name from the name alone.
 *
 * @param {string} fileName a bare name, not a path
 * @returns {?string} null when the MIME database is unavailable
 */
export function contentTypeFor(fileName) {
    if (!fileName)
        return null;
    try {
        // The second argument is the file's data; null means "do not look".
        const [contentType] = Gio.content_type_guess(fileName, null);
        return contentType || null;
    } catch (e) {
        return null;
    }
}

function iconForContentType(contentType) {
    try {
        return Gio.content_type_get_icon(contentType);
    } catch (e) {
        return null;
    }
}

/**
 * The themed icon the system associates with a file name. The result is a
 * `Gio.Icon` — in practice a `GThemedIcon` carrying several names, most
 * specific first — rather than a resolved pixbuf, so the icon theme is still
 * consulted at draw time and a theme change is picked up without a re-lookup.
 *
 * Never returns null: a row with a name and no icon looks broken, so the
 * generic file icon stands in when the tables come up empty.
 *
 * @param {string} fileName a bare name, not a path
 * @returns {Gio.Icon}
 */
export function fileIconFor(fileName) {
    if (!fileName)
        return null;

    if (iconByName.has(fileName))
        return iconByName.get(fileName);

    const contentType = contentTypeFor(fileName);
    const icon = (contentType ? iconForContentType(contentType) : null) ??
        Gio.ThemedIcon.new([LAST_RESORT_ICON]);

    iconByName.set(fileName, icon);
    return icon;
}

/**
 * Whether a name is a directory, by the only signal a name carries: a file list
 * writes directories with a trailing "/". Nothing is stat'ed, so this stays
 * correct for a folder on a volume that is not mounted.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
export function isDirectoryName(fileName) {
    return !!fileName && fileName.endsWith('/');
}

/**
 * The name as it should be READ, with the trailing "/" of a directory dropped:
 * it is a separator in the file list, not part of the folder's name.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function displayName(fileName) {
    return isDirectoryName(fileName) ? fileName.slice(0, -1) : fileName;
}

/**
 * Drop the memo. Only the tests need this: the cache is a per-session
 * acceleration, not state anything can go stale in — the answer depends on the
 * name and on tables that do not change under a running shell.
 */
export function clearFileIconCache() {
    iconByName.clear();
}
