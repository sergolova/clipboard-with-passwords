// Minimal printf-style formatter for translated strings that carry positional
// placeholders (%1$s, %2$d). GJS does not expose String.prototype.format (the
// codebase must therefore never rely on it), and a bare `.replace('%1$s', x)`
// would substitute only the first occurrence — so every user-facing string
// with placeholders routes through this helper.
//
// Supported placeholders: %1$s, %2$s, %1$d, %2$d … (the index is 1-based).
// Unknown indexes render as ''; the literal sequence '%%' is left untouched.
export function fmt(tpl, ...args) {
    return String(tpl).replace(/%(\d+)\$([ds])/g, (match, idx, type) => {
        const value = args[Number(idx) - 1];
        if (value === undefined) {
            return '';
        }
        return type === 'd' ? String(Math.floor(Number(value))) : String(value);
    });
}

/**
 * Shorten a value to `length` characters, collapsing runs of whitespace and
 * marking the cut with an ellipsis.
 *
 * Two details that are the whole point of doing it here rather than inline at
 * each call site:
 *
 *   * the length is counted in CODE POINTS, not UTF-16 units. A Cyrillic or
 *     emoji preview is sliced at [...string] rather than string.slice, so it
 *     cannot be cut in the middle of a surrogate pair — which would render as a
 *     replacement character, the one artefact a preview must never have;
 *   * the ellipsis character is "…", not three dots, so a cut costs one glyph of
 *     width instead of three and a row does not jump as the text length setting
 *     changes.
 *
 * @param {string} string the value to shorten
 * @param {number} length maximum length in code points
 * @returns {string}
 */
export function truncate(string, length) {
    let shortened = string.replace(/\s+/g, ' ');

    let chars = [...shortened];
    if (chars.length > length)
        shortened = chars.slice(0, length - 1).join('') + '…';

    return shortened;
}