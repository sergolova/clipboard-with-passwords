// A clipboard colour, rewritten into the CSS that the shell can actually paint.
//
// The problem this exists to solve: the value on the clipboard and the value the
// shell is given are not the same thing, and the difference is not cosmetic.
// `isColor()` deliberately accepts the modern CSS Color syntax, because that is
// what browsers, design tools and drawing apps put on the clipboard:
//
//     rgb(52 52 52)              space-separated, no commas
//     rgb(52 52 52 / 0.5)        alpha after a slash
//     hsl(210 50% 40%)           and hsla(..., / 0.5)
//
// But a colour swatch is painted by handing a string to St as a CSS declaration,
// and St parses stylesheets with a libcroco it bundles — a CSS2-era parser. It
// understands `rgb(52, 52, 52)` and `rgba(52, 52, 52, 0.5)`, and nothing newer:
// the space-separated form, the slash-alpha form and hsl() itself are all
// rejected, silently, by dropping just that one declaration. A row whose
// colour is recognised therefore renders as an empty bordered box — a bug no
// test that stops at isColor() can see.
//
// So every colour that reaches a swatch goes through here first and comes out in
// one shape: comma-separated `rgb(r, g, b)`, or `rgba(r, g, b, a)` when it is
// not fully opaque. One output shape means there is nothing left to guess about
// — not the separators, not the alpha spelling, and not hsl, which has to be
// converted rather than forwarded.
//
// Pure arithmetic and string work, no Gio and no St, so the whole thing is
// testable with a plain `gjs` and no shell.

/** A value we can forward untouched — a CSS named colour, for instance. */
const PASSTHROUGH = null;

const FUNCTION_REGEX = /^(rgba?|hsla?)\s*\(([^()]*)\)$/i;
const BARE_HEX_REGEX = /^[0-9a-f]+$/;
const HEX_LENGTHS = new Set([3, 4, 6, 8]);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Split a function's arguments into channels and an optional alpha.
 *
 * The three spellings of the same value differ only in punctuation, and none of
 * the punctuation carries information: a comma, a run of spaces and a slash are
 * all just separators. `rgb(52 52 52 / 0.5)` and `rgba(52,52,52,0.5)` both
 * reduce to four tokens, so one split handles every form — and a trailing
 * fourth token is the alpha whichever spelling produced it.
 *
 * @param {string} body everything between the parentheses
 * @returns {{channels: string[], alpha: ?string}|null}
 */
function splitArguments(body) {
    const tokens = body.split(/[\s,/]+/).filter(t => t.length > 0);
    if (tokens.length === 3)
        return {channels: tokens, alpha: null};
    if (tokens.length === 4)
        return {channels: tokens.slice(0, 3), alpha: tokens[3]};
    return null;
}

/**
 * One rgb channel as 0–255. Accepts a plain number or a percentage, because CSS
 * accepts both and the value is clamped rather than rejected: `rgb(300 0 0)` is
 * a legal colour, it is just a very red one.
 *
 * @param {string} token
 * @returns {?number} null when the token is not a number at all
 */
function parseChannel(token) {
    const isPercent = token.endsWith('%');
    const number = Number.parseFloat(isPercent ? token.slice(0, -1) : token);
    if (!Number.isFinite(number))
        return null;
    return clamp(Math.round(isPercent ? (number / 100) * 255 : number), 0, 255);
}

/**
 * An alpha as 0–1, from either a number or a percentage. `1`, `0`, `.5`, `0.5`
 * and `50%` all mean something a reader expects; out-of-range values clamp,
 * again because that is what CSS does.
 *
 * @param {?string} token
 * @returns {?number} null when the token is not a number at all
 */
function parseAlpha(token) {
    if (token === null || token === undefined)
        return 1;
    const isPercent = token.endsWith('%');
    const number = Number.parseFloat(isPercent ? token.slice(0, -1) : token);
    if (!Number.isFinite(number))
        return null;
    return clamp(isPercent ? number / 100 : number, 0, 1);
}

/**
 * A hue in degrees, with or without the `deg` unit, as 0–360. Any other angle
 * unit is left alone rather than guessed at: the value would be wrong, and a
 * wrong colour is worse than a forwarded string.
 *
 * @param {string} token
 * @returns {?number}
 */
function parseHue(token) {
    const number = Number.parseFloat(
        token.toLowerCase().endsWith('deg') ? token.slice(0, -3) : token);
    if (!Number.isFinite(number))
        return null;
    return ((number % 360) + 360) % 360;
}

/**
 * Saturation or lightness, which CSS writes as a percentage, as 0–1.
 *
 * @param {string} token
 * @returns {?number}
 */
function parsePercent(token) {
    if (!token.endsWith('%'))
        return null;
    const number = Number.parseFloat(token.slice(0, -1));
    if (!Number.isFinite(number))
        return null;
    return clamp(number / 100, 0, 1);
}

/**
 * hsl() to rgb(), the standard six-sector construction. Returned as 0–255
 * integers, because that is what the caller formats and what the parser on the
 * other side wants.
 *
 * @param {number} hue 0–360
 * @param {number} saturation 0–1
 * @param {number} lightness 0–1
 * @returns {[number, number, number]}
 */
function hslToRgb(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const second = chroma * (1 - Math.abs((sector % 2) - 1));
    const offset = lightness - chroma / 2;

    let triple;
    if (sector < 1) triple = [chroma, second, 0];
    else if (sector < 2) triple = [second, chroma, 0];
    else if (sector < 3) triple = [0, chroma, second];
    else if (sector < 4) triple = [0, second, chroma];
    else if (sector < 5) triple = [second, 0, chroma];
    else triple = [chroma, 0, second];

    return triple.map(part =>
        clamp(Math.round((part + offset) * 255), 0, 255));
}

/**
 * Hex, with or without its `#`, at any of the four CSS lengths — so including
 * the two alpha forms (`#f80c`, `#ff8800cc`), which is the other thing the
 * parser on the other side does not accept.
 *
 * @param {string} hex digits only, 3/4/6/8 of them
 * @returns {?{rgb: [number, number, number], alpha: number}}
 */
function parseHex(hex) {
    if (!HEX_LENGTHS.has(hex.length) || !BARE_HEX_REGEX.test(hex))
        return null;

    // A short form is one digit per channel, doubled: `f80` is `ff8800`.
    const pairs = hex.length <= 4
        ? [...hex].map(d => d + d)
        : (hex.match(/../g) ?? []);

    const channel = i => Number.parseInt(pairs[i], 16);
    const alpha = hex.length === 4 || hex.length === 8
        ? clamp(channel(pairs.length - 1) / 255, 0, 1)
        : 1;

    const rgb = [channel(0), channel(1), channel(2)];
    return rgb.some(Number.isNaN) ? null : {rgb, alpha};
}

/**
 * The one form this module emits. Opaque colours are written `rgb()`, because a
 * trailing `, 1` is noise libcroco does not need; anything else gets `rgba()`
 * with the alpha trimmed to three decimals, which is finer than the 8-bit alpha
 * the swatch ends up with anyway.
 */
function format([r, g, b], alpha) {
    if (alpha >= 1)
        return `rgb(${r}, ${g}, ${b})`;
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/**
 * Rewrite a clipboard colour into the CSS the shell's parser accepts, or return
 * null when there is nothing to rewrite.
 *
 * Null means "not a form this module handles" — a named colour, say, which
 * libcroco already knows. The caller should forward those untouched; returning
 * the input unchanged would work too, but a null is what lets a caller tell
 * "I left this alone on purpose" from "I could not read this".
 *
 * @param {string} text the entry's trimmed value
 * @returns {?string} a paintable CSS colour, or null to forward as-is
 */
export function toRenderableColor(text) {
    if (typeof text !== 'string')
        return PASSTHROUGH;

    const value = text.trim();
    if (value.length === 0)
        return PASSTHROUGH;

    // Hex first: a bare one is not valid CSS at all, so it is not a "leave it
    // alone" case even though it looks like one. Folded to lower case first,
    // because uppercase hex is ordinary — "#FF8800" is what half the tools in
    // the world emit — and the digit test below is lower-case only.
    const hex = (value.startsWith('#') ? value.slice(1) : value).toLowerCase();
    if (value.startsWith('#') || (HEX_LENGTHS.has(hex.length) &&
        BARE_HEX_REGEX.test(hex))) {
        const parsed = parseHex(hex);
        return parsed ? format(parsed.rgb, parsed.alpha) : PASSTHROUGH;
    }

    const match = FUNCTION_REGEX.exec(value);
    if (!match)
        return PASSTHROUGH;

    const [, name, body] = match;
    const args = splitArguments(body);
    if (!args)
        return PASSTHROUGH;

    const alpha = parseAlpha(args.alpha);
    if (alpha === null)
        return PASSTHROUGH;

    if (name.toLowerCase().startsWith('rgb')) {
        const rgb = args.channels.map(parseChannel);
        if (rgb.some(c => c === null))
            return PASSTHROUGH;
        return format(rgb, alpha);
    }

    const hue = parseHue(args.channels[0]);
    const saturation = parsePercent(args.channels[1]);
    const lightness = parsePercent(args.channels[2]);
    if (hue === null || saturation === null || lightness === null)
        return PASSTHROUGH;

    return format(hslToRgb(hue, saturation, lightness), alpha);
}
