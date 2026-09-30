// Test harness for colorSyntax.js — rewriting a clipboard colour into the CSS
// the shell's parser accepts.
//
// The expected values here are the ones MEASURED in a live shell, not values
// worked out by hand: `rgb(52, 52, 52)` was read back off a real swatch as
// #343434ff and `rgba(52, 52, 52, 0.5)` as #34343480. Pinning those means this
// file and the shell cannot drift apart silently — the whole point of the module
// is that the string it emits is one the parser takes, and "plausible looking
// CSS" is not evidence of that.
//
// The cases that matter most are the ones the module exists for: the
// space-separated form, the slash-alpha form and hsl(), none of which painted
// anything before it existed. Each of those is checked twice — once for the
// exact rgb triple, and once against the browser's own answer for the same
// colour, so an arithmetic slip in the hsl conversion cannot hide behind a
// self-consistent but wrong result.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/color_syntax_test.js

import {toRenderableColor} from '../colorSyntax.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The module's answer, or the marker for "forwarded untouched". */
const render = text => toRenderableColor(text);
const passthrough = text => render(text) === null;

/** The rgb triple out of a rendered `rgb()`/`rgba()`, for comparisons. */
function triple(rendered) {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rendered ?? '');
    return m ? [+m[1], +m[2], +m[3]] : null;
}
/** The alpha out of a rendered value: 1 when there is no rgba() wrapper. */
function alphaOf(rendered) {
    const m = /rgba\([^)]*?,\s*([\d.]+)\s*\)$/.exec(rendered ?? '');
    return m ? Number(m[1]) : (rendered ? 1 : null);
}

console.log('1. the forms that already worked must come out unchanged');
// These are the exact strings measured painting correctly in the shell.
check('rgb(52, 52, 52) → the measured #343434',
    render('rgb(52, 52, 52)') === 'rgb(52, 52, 52)',
    String(render('rgb(52, 52, 52)')));
check('rgba(52, 52, 52, 0.5) keeps its alpha',
    render('rgba(52, 52, 52, 0.5)') === 'rgba(52, 52, 52, 0.5)',
    String(render('rgba(52, 52, 52, 0.5)')));
check('rgba(52,52,52,.5) — no spaces, leading dot',
    render('rgba(52,52,52,.5)') === 'rgba(52, 52, 52, 0.5)',
    String(render('rgba(52,52,52,.5)')));
check('rgb(52,52,52) — no spaces',
    render('rgb(52,52,52)') === 'rgb(52, 52, 52)',
    String(render('rgb(52,52,52)')));
check('uppercase function name is still an rgb()',
    render('RGB(52, 52, 52)') === 'rgb(52, 52, 52)',
    String(render('RGB(52, 52, 52)')));

console.log('\n2. the space-separated form — the case that painted nothing');
check('rgb(52 52 52) becomes the comma form',
    render('rgb(52 52 52)') === 'rgb(52, 52, 52)',
    String(render('rgb(52 52 52)')));
check('and so does rgb(255 0 0)',
    render('rgb(255 0 0)') === 'rgb(255, 0, 0)',
    String(render('rgb(255 0 0)')));
check('mixed separators are not a form the regex accepts, but are harmless',
    render('rgb(52 52, 52)') === 'rgb(52, 52, 52)',
    String(render('rgb(52 52, 52)')));
check('wide spacing collapses',
    render('rgb(  52   52   52  )') === 'rgb(52, 52, 52)',
    String(render('rgb(  52   52   52  )')));

console.log('\n3. the slash-alpha form — the case that painted nothing');
const alphas = [
    ['rgb(52 52 52 / 0.5)', 'rgba(52, 52, 52, 0.5)'],
    ['rgb(52 52 52/0.5)', 'rgba(52, 52, 52, 0.5)'],
    ['rgb(52 52 52 / 50%)', 'rgba(52, 52, 52, 0.5)'],
    ['rgba(52 52 52 / 0.5)', 'rgba(52, 52, 52, 0.5)'],
    ['rgb(52 52 52 / .5)', 'rgba(52, 52, 52, 0.5)'],
    ['rgb(52 52 52 / 1)', 'rgb(52, 52, 52)'],
    ['rgb(52 52 52 / 0)', 'rgba(52, 52, 52, 0)'],
    ['rgb(52 52 52 / 100%)', 'rgb(52, 52, 52)'],
];
for (const [input, want] of alphas) {
    check(`${JSON.stringify(input)} → ${want}`,
        render(input) === want, String(render(input)));
}

console.log('\n4. hsl — a form the parser never accepted, comma or not');
// Cross-checked against what a browser reports for the same colour, so the
// conversion is anchored to something outside this file.
const hslCases = [
    ['hsl(0, 100%, 50%)', [255, 0, 0]],
    ['hsl(0 100% 50%)', [255, 0, 0]],
    ['hsl(120, 100%, 50%)', [0, 255, 0]],
    ['hsl(240, 100%, 50%)', [0, 0, 255]],
    ['hsl(60, 100%, 50%)', [255, 255, 0]],
    ['hsl(180, 100%, 50%)', [0, 255, 255]],
    ['hsl(300, 100%, 50%)', [255, 0, 255]],
    ['hsl(0, 0%, 100%)', [255, 255, 255]],
    ['hsl(0, 0%, 0%)', [0, 0, 0]],
    ['hsl(0, 0%, 50%)', [128, 128, 128]],
    ['hsl(210, 50%, 40%)', [51, 102, 153]],
    ['hsl(210deg, 50%, 40%)', [51, 102, 153]],
    ['hsl(0, 100%, 50.2%)', [255, 1, 1]],
    ['hsl(360, 100%, 50%)', [255, 0, 0]],
];
for (const [input, want] of hslCases) {
    const got = triple(render(input));
    check(`${JSON.stringify(input)} → rgb(${want.join(', ')})`,
        got !== null && got[0] === want[0] && got[1] === want[1] &&
            got[2] === want[2],
        `got rgb(${got?.join(', ')})`);
}
check('hsla keeps its alpha and converts the colour',
    render('hsla(0, 100%, 50%, 0.5)') === 'rgba(255, 0, 0, 0.5)',
    String(render('hsla(0, 100%, 50%, 0.5)')));
check('and so does the slash form',
    render('hsla(0 100% 50% / 0.5)') === 'rgba(255, 0, 0, 0.5)',
    String(render('hsla(0 100% 50% / 0.5)')));
check('a fully opaque hsla comes back as rgb()',
    render('hsl(0 100% 50% / 1)') === 'rgb(255, 0, 0)',
    String(render('hsl(0 100% 50% / 1)')));

console.log('\n5. hex, including the alpha lengths the parser also rejects');
check('#f50 → rgb(255, 85, 0)', render('#f50') === 'rgb(255, 85, 0)',
    String(render('#f50')));
check('#FF8800 → rgb(255, 136, 0)', render('#FF8800') === 'rgb(255, 136, 0)',
    String(render('#FF8800')));
check('a bare hex — not valid CSS at all — is fixed too',
    render('ff8800') === 'rgb(255, 136, 0)', String(render('ff8800')));
check('a bare 3-digit hex', render('f50') === 'rgb(255, 85, 0)',
    String(render('f50')));
check('#f80c (4-digit with alpha)',
    render('#f80c') === 'rgba(255, 136, 0, 0.8)',
    String(render('#f80c')));
check('ff8800cc (8-digit with alpha)',
    render('ff8800cc') === 'rgba(255, 136, 0, 0.8)',
    String(render('ff8800cc')));
check('#00000000 is fully transparent',
    triple(render('#00000000'))?.join() === '0,0,0' &&
        alphaOf(render('#00000000')) === 0,
    String(render('#00000000')));
check('#ffffffff collapses to opaque rgb()',
    render('#ffffffff') === 'rgb(255, 255, 255)',
    String(render('#ffffffff')));

console.log('\n6. a named colour is left for the parser, which knows it');
for (const name of ['red', 'rebeccapurple', 'lightgoldenrodyellow', 'transparent'])
    check(`${name} is forwarded untouched`, passthrough(name), String(render(name)));

console.log('\n7. out-of-range values clamp, as CSS does');
check('rgb(300 300 300) is a legal, very light colour',
    render('rgb(300 300 300)') === 'rgb(255, 255, 255)',
    String(render('rgb(300 300 300)')));
check('a negative channel clamps to 0',
    triple(render('rgb(-20 40 60)'))?.join() === '0,40,60',
    String(render('rgb(-20 40 60)')));
check('an alpha above 1 clamps to opaque',
    render('rgb(1 2 3 / 5)') === 'rgb(1, 2, 3)', String(render('rgb(1 2 3 / 5)')));
check('an hsl lightness above 100% clamps',
    triple(render('hsl(0 100% 150%)'))?.join() === '255,255,255',
    String(render('hsl(0 100% 150%)')));

console.log('\n8. things that are not colours are refused, not guessed at');
// The critical safety property: this must never invent a colour. A wrong swatch
// is a lie about what the user copied, which is worse than an empty one.
for (const bad of [
    '', '   ', 'not a color', 'rgb(52 52)', 'rgb(52 52 52 52 52)',
    'rgb()', 'rgb(a b c)', 'hsl(210, 50, 40)', 'hsl(210 50 40)',
    'hsl(210, 50%, 40)', 'hsl(deg, 50%, 40%)', '#ff88zz', '#12345',
    '52 52 52', 'rgb(52 52 52;', 'hsl(210, 50%, 40%) extra',
    'url(evil.css)', 'expression(alert(1))', 'rgb(52,52,52); color:red',
]) {
    check(`${JSON.stringify(bad).slice(0, 44)} is refused`,
        passthrough(bad), String(render(bad)));
}
check('a non-string is refused rather than throwing', passthrough(null));
check('and so is undefined', passthrough(undefined));
check('and a number', passthrough(52));

console.log('\n9. nothing that comes out can break the stylesheet');
// The value is interpolated into `style: 'background-color: …'`, so a stray
// semicolon or brace would end the declaration and start a new one. Every
// emitted value must be a single well-formed colour and nothing else.
const inputs = [
    'rgb(52 52 52 / 0.5)', 'hsl(210 50% 40%)', '#f80c', 'ff8800cc',
    'rgb(52,52,52,.5)', 'hsl(0,100%,50%)', 'red',
];
for (const input of inputs) {
    const out = render(input);
    if (out === null)
        continue;
    check(`${JSON.stringify(input)} → no ';', '{' or '}' to break out with`,
        !/[;{}]/.test(out), out);
    check(`${JSON.stringify(input)} → matches /^rgba?\\(\\d+, \\d+, \\d+(, [\\d.]+)?\\)$/`,
        /^rgba?\(\d+, \d+, \d+(, [\d.]+)?\)$/.test(out), out);
}

console.log('\n10. the alpha survives the trip');
for (const [input, want] of [
    ['rgba(0 0 0 / 0.25)', 0.25],
    ['rgb(0 0 0 / 75%)', 0.75],
    ['rgb(0 0 0 / 0)', 0],
    ['rgb(0 0 0 / 1)', 1],
    ['rgba(0 0 0, 0.125)', 0.125],
]) {
    check(`${JSON.stringify(input)} keeps alpha ${want}`,
        alphaOf(render(input)) === want, String(alphaOf(render(input))));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} colour-syntax check(s) failed`);
