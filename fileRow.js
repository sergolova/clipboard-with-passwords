// The data behind the file row's second line: which names, how much of each,
// how many were dropped.
//
// This was a dozen lines of arithmetic in the middle of the row renderer, and
// that is the worst place for it to live for three reasons. It decides how WIDE a
// row is, so a mistake shows up as a menu that looks wrong rather than as an
// error. It has edge cases that a reading of the code does not settle — a list of
// nothing but empty names, a budget smaller than the number of names, a name with
// a trailing slash that is not part of the name. And it is pure, so every one of
// those cases can be asked about directly instead of only through a screenshot.
//
// What comes out is ready for the renderer: display text already truncated, and
// the raw name kept alongside it, because the raw name is what the icon is decided
// by — a directory's trailing "/" is a signal to the icon lookup and must not
// survive into the text.
//
// No gi:// imports: displayName() and truncate() are pure too, so this module is
// testable with a plain `gjs` and no shell.

import {displayName} from './fileIcons.js';
import {truncate} from './strings.js';

// At most this many names on the second line. A cap rather than a target: a
// selection of two hundred files is still two files' worth of names, and a row
// cannot be both complete and readable.
export const MAX_SHOWN_FILE_NAMES = 5;

// The floor on a name's share of the line. Below this a name is not a name any
// more, it is an ellipsis with a glyph in front of it.
export const FILE_NAME_MIN_CHARS = 8;

/**
 * Decide what the second line of a file row shows.
 *
 * The character budget is SPLIT between the names rather than applied to their
 * concatenation. Applying it to the joined string was the previous behaviour and
 * it is what made the row several times wider than every other preview: five full
 * names side by side are not one budget's worth of characters.
 *
 * The icons are not part of that budget. They are a fixed size each, and a name
 * is worth more readable than a row is worth narrow.
 *
 * @param {string[]} fileNames the entry's names, as the URI list gave them
 * @param {object} budget
 * @param {number} budget.chars the line's character budget («Preview Size»)
 * @param {number} [budget.maxShown] cap on the number of names
 * @param {number} [budget.minChars] floor on one name's share
 * @returns {{names: {raw: string, text: string}[], hiddenCount: number, perName: number}}
 */
export function layoutFileNames(fileNames, {chars, maxShown = MAX_SHOWN_FILE_NAMES, minChars = FILE_NAME_MIN_CHARS} = {}) {
    const list = Array.isArray(fileNames) ? fileNames : [];

    // Dedupe: a selection that names the same file twice is one file to a reader.
    // The truthiness test drops empty names, which are not names.
    const unique = list.filter((name, i) => name && list.indexOf(name) === i);

    // A list of nothing but empty names dedupes down to nothing, and the raw list
    // is still what the user copied — so fall back to it rather than showing
    // nothing for a selection that was not empty.
    const source = unique.length > 0 ? unique : list;

    const shown = source.slice(0, maxShown);
    const perName = Math.max(minChars,
        Math.floor(chars / Math.max(1, shown.length)));

    return {
        names: shown.map(raw => ({
            raw,
            // A directory's name carries the trailing "/" that told the icon it
            // was a directory; that separator is not part of what it is called.
            text: truncate(displayName(raw), perName),
        })),
        hiddenCount: source.length - shown.length,
        perName,
    };
}
