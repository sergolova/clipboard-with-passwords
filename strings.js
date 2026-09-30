// Minimal printf-style formatter for translated strings that carry positional
// placeholders (%1$s, %2$d). GJS does not expose String.prototype.format (the
// codebase must therefore never rely on it), and a bare `.replace('%1$s', x)`
// would substitute only the first occurrence — so every user-facing string
// with placeholders routes through this helper.
//
// Supported placeholders: %1$s, %2$s, %1$d, %2$d … (the index is 1-based).
// Unknown indexes render as ''.
//
// There is no escape mechanism: '%%' is not a literal percent but is also not
// special, so it survives as written UNLESS digits and a type follow it, in
// which case the placeholder that starts at the second '%' is substituted and
// the first '%' is left behind. No translated string relies on '%%', so nothing
// depends on either half of that — but do not write '%%' expecting printf
// behaviour here.
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
 * Collapse runs of whitespace into single spaces, so a multi-line clipboard
 * entry can be shown on ONE line of a menu row.
 *
 * This is the first half of what truncate() used to do, and it is separated out
 * because cutting by character count and cutting by width are different jobs
 * that happen to have been fused. Whitespace collapsing still has to happen
 * either way — a copied paragraph rendered verbatim would take over the menu —
 * but it is not a form of shortening and must not be tied to a length limit.
 * Where the row has a real width to fit into, Pango's own ellipsize does the
 * shortening and this is the only preprocessing needed.
 *
 * @param {string} string the value to flatten
 * @returns {string}
 */
export function collapseWhitespace(string) {
    return string.replace(/\s+/g, ' ');
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
 * Prefer width-based cutting where the row can supply a real width: a character
 * count cannot know that 30 of "W" is 420 px while 30 of "i" is 120 px.
 *
 * @param {string} string the value to shorten
 * @param {number} length maximum length in code points
 * @returns {string}
 */
export function truncate(string, length) {
    const shortened = collapseWhitespace(string);

    const chars = [...shortened];
    if (chars.length > length)
        return chars.slice(0, length - 1).join('') + '…';

    return shortened;
}