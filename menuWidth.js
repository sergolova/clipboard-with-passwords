// How wide the history menu is, derived from the «Preview Size» setting.
//
// The rows are cut by WIDTH, not by character count, and a width has to come
// from somewhere. The setting the user already has is a number of characters, so
// it is converted: measure how many pixels one average character occupies in the
// theme's font, multiply, clamp.
//
// The conversion is approximate and that is fine, as long as the reason is stated.
// No single character has a width — 60 "W" measured 840 px where 60 "i" measured
// 240 px — so any reference string is wrong for some strings. What matters is
// not that the width is exactly right for any one entry, but that EVERY row gets
// the SAME width and Pango then cuts each of them by its own glyphs. Getting the
// reference string badly wrong costs a slightly wider or narrower menu; it does
// not bring back the defect this replaced, which was each row cutting at a
// different length.
//
// Pure module: no gi:// imports, so the arithmetic is testable with plain gjs.
// The measurement itself needs a stage and a font, and lives in theme.js.

/**
 * The floor. Below this a row shows a word and a half, which is not a preview.
 *
 * The setting's own range starts at 10, and 10 characters is roughly 78 px, so
 * without a floor the low end of the range produces an unusable menu. The knob
 * therefore stops being linear at the bottom — deliberately, because the
 * alternative is a menu one letter wide.
 */
export const MIN_MENU_WIDTH = 240;

/**
 * The ceiling, as a fraction of the monitor's width.
 *
 * This fraction was 0.6 and it never bound: 100 characters is about 777 px, and
 * 0.6 of even a 1366 px panel is 820 px, so the cap was unreachable dead code
 * that looked like a safeguard. 0.4 is the first value that actually engages —
 * 768 px on a 1920 monitor, 546 px on a 1366 one — while leaving the default
 * setting of 60 characters (about 466 px) untouched, so the menu a user sees
 * today does not change when this constant is right.
 */
export const MAX_MENU_WIDTH_FRACTION = 0.4;

/**
 * Convert the character budget into a pixel width.
 *
 * @param {object} opts
 * @param {number} opts.pxPerChar width of one average character, in px
 * @param {number} opts.previewSize the «Preview Size» setting, in characters
 * @param {number} [opts.minWidth] floor in px
 * @param {number} [opts.maxWidth] ceiling in px
 * @returns {number} a whole number of pixels, always at least minWidth
 */
export function menuWidthFor({
    pxPerChar,
    previewSize,
    minWidth = MIN_MENU_WIDTH,
    maxWidth = Infinity,
} = {}) {
    // A ceiling BELOW the floor would be contradictory, and it happens on a
    // screen narrow enough that 40% of it is less than 240 px. The floor wins:
    // a menu that is a little too wide for a tiny screen is still a menu, while
    // a menu narrower than one usable row shows nothing at all.
    const lo = Math.round(minWidth);
    const hi = Math.max(lo, Math.round(maxWidth));

    if (!(pxPerChar > 0) || !(previewSize > 0)) {
        // A measurement that failed (no stage yet, a font that would not load)
        // must not produce a zero-width menu, which would make every row
        // invisible. Fall back to the floor, which is always usable.
        return lo;
    }

    const wanted = pxPerChar * previewSize;
    // Clamp BEFORE rounding and again after, so a maxWidth of 383.6 is not
    // rounded up past it and the row scrolls for a single pixel.
    return Math.min(Math.max(Math.round(wanted), lo), hi);
}
