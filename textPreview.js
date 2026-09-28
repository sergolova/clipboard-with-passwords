// Extraction of the two preview lines the clipboard menu shows for a
// multiline entry.
//
// The preview used to be built as
//
//     text.split('\n').map(line => line.trim()).filter(line => line.length)
//
// which materializes the whole line list three times over: a multi-megabyte
// copied log or source file became tens of thousands of strings per item per
// render, and all but the first two of them were discarded immediately. Only
// three values are actually wanted — the first two non-empty lines and the
// total number of non-empty lines — so they are collected in a single pass
// that allocates nothing per line.
//
// Pure JS on purpose (no gi:// imports) so it can be unit-tested outside the
// shell.

// Whitespace exactly as String.prototype.trim() defines it, minus the line
// feed: the "is this line empty" probe must not run past the end of its own
// line, otherwise a run of blank lines would be rescanned once per line.
// Sticky so it can be aimed at an arbitrary offset of the source text.
const BLANK_RUN = /[^\S\n]*/y;

/**
 * First two non-empty lines of `text` and how many non-empty lines it has.
 *
 * The returned lines are whitespace-trimmed, so they are the same values the
 * old map(trim) produced; `count` is the same total the old filter counted.
 *
 * @param {string} text - full text of the entry
 * @returns {{first: string, second: string, count: number}} `first` and
 *   `second` are '' when the text has fewer than that many non-empty lines
 */
export function scanPreviewLines(text) {
    let first = '';
    let second = '';
    let count = 0;

    const length = text.length;
    let start = 0;
    while (start <= length) {
        let end = text.indexOf('\n', start);
        if (end === -1)
            end = length;

        // A line is empty when nothing but whitespace sits before its end.
        // ASCII content (code 33..127) can never be whitespace, so the probe
        // is skipped for it — otherwise every short ASCII line would pay a
        // regex call, which on small entries costs more than the whole
        // split/map/filter chain it replaces. The probe stays the only
        // definition of "whitespace", so nothing can drift; only the
        // suspicion of it is cheap.
        const code = end > start ? text.charCodeAt(start) : 0;
        let nonEmpty;
        if (code > 32 && code < 128) {
            nonEmpty = true;
        } else {
            // Sticky, and the character class excludes the line feed, so the
            // run stops at the first non-whitespace character or at this
            // line's end — it cannot escape into the next line.
            BLANK_RUN.lastIndex = start;
            BLANK_RUN.exec(text);
            nonEmpty = BLANK_RUN.lastIndex < end;
        }

        if (nonEmpty) {
            count++;
            if (count === 1)
                first = text.slice(start, end).trim();
            else if (count === 2)
                second = text.slice(start, end).trim();
        }

        start = end + 1;
    }

    return {first, second, count};
}
