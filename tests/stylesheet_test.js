// Test harness for stylesheet.css — every colour in it must be one the shell's
// CSS parser can actually read.
//
// The bug this guards against is the quiet kind. St parses stylesheets with a
// bundled libcroco, a CSS2-era parser, and when it meets a value it cannot read
// it drops that one declaration and carries on. Nothing is logged, nothing
// throws, the stylesheet still "works" — the rule simply has no effect. So the
// second line of a row was rendering in the colour it inherited from its row
// instead of the grey written for it, while `font-size` from the same rule
// applied perfectly. It is visible only if you know to look, and it is invisible
// to every test that exercises JavaScript, because the value that fails is in a
// CSS file, not in any code.
//
// A lint is the right shape for this. It cannot tell whether a colour LOOKS
// right, and it does not try to: it checks one thing — that every colour in the
// sheet is spelled in a form the parser accepts. That is mechanical, it needs no
// shell, and it covers the whole file at once instead of one row at a time.
//
// The parser accepts, and therefore this file allows:
//   * rgb() and rgba() with comma-separated arguments, alpha as a 0–1 number;
//   * hex in the 3- and 6-digit forms, with a leading '#';
//   * the CSS named colours, which the parser has its own table for.
//
// Everything else is refused here rather than shipped and discovered later: the
// space-separated and slash-alpha forms, hsl()/hsla() and every other colour
// function, and the 4- and 8-digit hexes that carry alpha.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/stylesheet_test.js

import GLib from 'gi://GLib';

const SHEET = '/home/seriy/PhpstormProjects/MY/clipboard-with-passwords/stylesheet.css';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const [, bytes] = GLib.file_get_contents(SHEET);
const raw = new TextDecoder().decode(bytes);

// Comments are not CSS, so nothing in them can be a broken declaration — and a
// lint that trips over its own documentation is a lint people learn to ignore.
// They are blanked out rather than deleted, so offsets (and therefore the line
// numbers this file reports) stay those of the real sheet.
const css = raw
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/^\s*\/\/.*$/gm, m => ' '.repeat(m.length));

console.log('1. the file is the one this test thinks it is');
check('stylesheet.css was read', css.length > 0, `${css.length} bytes`);
check('and it is not empty of rules', css.includes('{') && css.includes('}'));

/** Line number of a character offset, for reporting. */
const lineAt = offset => css.slice(0, offset).split('\n').length;

console.log('\n2. every rgb()/rgba() is comma-separated and 3-4 arguments');
// The single most important check, and the one that would have caught the bug:
// the modern spelling looks perfectly reasonable and parses as a valid CSS
// function call, so nothing but a check like this notices.
const FUNC = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi;
let match;
const colourFunctions = [];
while ((match = FUNC.exec(css)) !== null) {
    const name = match[1].toLowerCase();
    const open = match.index + match[0].length - 1;
    const close = css.indexOf(')', open);
    if (close < 0) {
        check(`${name}( on line ${lineAt(match.index)} closes`, false,
            'no ")" in the rest of the file');
        continue;
    }
    const args = css.slice(open + 1, close);
    colourFunctions.push({name, args, line: lineAt(match.index)});
    check(`line ${lineAt(match.index)}: ${name}(…) is rgb/rgba, which the parser knows`,
        name === 'rgb' || name === 'rgba', `${name}(${args})`);
    check(`line ${lineAt(match.index)}: ${name}(…) separates its arguments with commas`,
        args.includes(','), `${name}(${args})`);
    check(`line ${lineAt(match.index)}: ${name}(…) has no slash-alpha`,
        !args.includes('/'), `${name}(${args})`);
    check(`line ${lineAt(match.index)}: ${name}(…) has 3 or 4 arguments`,
        args.split(',').filter(a => a.trim().length > 0).length === 3 ||
            args.split(',').filter(a => a.trim().length > 0).length === 4,
        `${name}(${args})`);
}
check('the sheet does contain colour functions, so the scan found something',
    colourFunctions.length > 0, `${colourFunctions.length} found`);

console.log('\n3. every hex colour is a form the parser knows');
// Length 4 and 8 carry an alpha channel, which libcroco does not read.
const HEX = /#([0-9a-fA-F]+)/g;
let hexCount = 0;
while ((match = HEX.exec(css)) !== null) {
    hexCount++;
    const digits = match[1];
    check(`line ${lineAt(match.index)}: #${digits} is 3 or 6 digits`,
        digits.length === 3 || digits.length === 6, `${digits.length} digits`);
}
check('the sheet does contain hex colours', hexCount > 0, `${hexCount} found`);

console.log('\n4. the rule that was broken is now spelled the way the parser reads');
// Pinned by SHAPE, not by value. What matters is that the second line's colour
// declaration is comma-separated; which grey it is, is a design choice that has
// already changed once, and a test that failed on a new tone would be a test
// that gets deleted instead of a bug that gets found.
// Every rule whose SELECTOR mentions .clipboard-second-line, with its body —
// matched as selector-then-block rather than by the class name alone, so a
// compound selector like `.ci-theme-light .clipboard-second-line` is found too
// and the text-shadow rule that also lists the class is not mistaken for a
// colour rule.
const secondLineRules = [...css.matchAll(
    /(?:^|})\s*([^{}]*clipboard-second-line[^{}]*)\{([^}]*)\}/gm)]
    .map(m => ({selector: m[1].trim(), body: m[2]}))
    .filter(r => /(^|\s)color\s*:/.test(r.body));
check('both colour rules for the second line are found',
    secondLineRules.length === 2,
    `found ${secondLineRules.length}: ` +
        `${secondLineRules.map(r => r.selector).join(' | ')}`);
for (const {selector, body} of secondLineRules) {
    const colour = /color\s*:\s*([^;]+);/.exec(body)?.[1]?.trim();
    check(`${selector} → "${colour}" is comma-separated`,
        !!colour && colour.includes(',') && !colour.includes('/'),
        'the space-separated and slash forms are dropped by the parser');
    check(`${selector} → "${colour}" is an rgb the parser knows`,
        /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(,\s*[\d.]+\s*)?\)$/.test(colour ?? ''),
        String(colour));
}
check('and no rule anywhere still uses the space-separated form',
    !/rgb\(\s*\d+\s+\d+\s+\d+\s*\)/.test(css),
    'found a space-separated rgb()');
check('the font-size next to it is untouched, which is why the bug hid',
    css.includes('font-size: 0.85em;'));

console.log('\n5. nothing else in the sheet is a value the parser cannot read');
// The catch-all: a modern colour written some other way still gets refused.
const SUSPECT = [
    [/\boklch\(/i, 'oklch()'],
    [/\boklab\(/i, 'oklab()'],
    [/\bhwb\(/i, 'hwb()'],
    [/\blab\(/i, 'lab()'],
    [/\blch\(/i, 'lch()'],
    [/\bcolor-mix\(/i, 'color-mix()'],
    [/\bcolor\(/i, 'color()'],
    [/\bhsva?\(/i, 'hsv()'],
    [/:(space-separated|any)\b/i, 'a newer colour space keyword'],
];
for (const [regex, label] of SUSPECT) {
    check(`the sheet uses no ${label}`, !regex.test(css),
        regex.exec(css)?.[0] ?? '');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} stylesheet check(s) failed`);
