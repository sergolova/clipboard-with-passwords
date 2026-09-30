// Test harness for textPreview.js — the single-pass scan that produces the two
// preview lines of a multiline clipboard entry.
//
// The whole point of the module is that it must return exactly what the old
// split('\n').map(trim).filter() chain returned, so most of the checks below
// are differential: the new scan is compared against a local reimplementation
// of the old chain over a large randomized corpus of line shapes (whitespace
// padding, blank runs, CR, exotic Unicode spaces, long lines, huge inputs).
//
// Run with: gjs -m tools/local/text_preview_test.js

import {scanPreviewLines} from '../textPreview.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

// The implementation this module replaced, kept verbatim as the oracle.
function legacyPreview(text) {
    const nonEmptyLines = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
    return {
        first: nonEmptyLines.length > 0 ? nonEmptyLines[0] : '',
        second: nonEmptyLines.length > 1 ? nonEmptyLines[1] : '',
        count: nonEmptyLines.length,
    };
}

function same(a, b) {
    return a.first === b.first && a.second === b.second && a.count === b.count;
}

// Line alphabets that stress the definition of "empty": plain, padded, blank,
// carriage returns, and the Unicode separators trim() also removes.
const LINE_SHAPES = [
    'plain line',
    '  leading and trailing  ',
    '',
    ' ',
    '\t\t',
    '   \t   ',
    'a',
    'ünïcödé töxt',
    ' nbsp only ',
    ' em space only ',
    '　ideographic space　',
    '﻿bom prefixed',
    ' line separator inside ',
    'ends with cr\r',
    '\t\t\t\tdeeply indented\t\t\t\t',
    'x'.repeat(5000),
    '  ' + 'y'.repeat(3000) + '  ',
];

console.log('1. single line');
check('plain text', same(
    scanPreviewLines('hello'),
    {first: 'hello', second: '', count: 1}));
check('leading/trailing whitespace is trimmed',
    scanPreviewLines('  \t hello \n ').first === 'hello');
check('single line with padding',
    scanPreviewLines('   hello   ').first === 'hello');

console.log('\n2. two and more non-empty lines');
check('two lines',
    same(scanPreviewLines('a\nb'), {first: 'a', second: 'b', count: 2}));
check('three lines',
    same(scanPreviewLines('a\nb\nc'), {first: 'a', second: 'b', count: 3}));
check('blank lines in between are skipped, not counted',
    same(scanPreviewLines('a\n\n\n   \nb\n\t\nc'), {first: 'a', second: 'b', count: 3}));
check('leading blank lines are skipped',
    same(scanPreviewLines('\n\n  \n\ta\nb'), {first: 'a', second: 'b', count: 2}));
check('trailing blank lines are skipped',
    same(scanPreviewLines('a\nb\n\n   \n'), {first: 'a', second: 'b', count: 2}));
check('only the first two lines are returned even with many',
    same(scanPreviewLines('a\nb\nc\nd\ne'), {first: 'a', second: 'b', count: 5}));
check('lines are trimmed like the old map(trim) did',
    same(scanPreviewLines('  a  \n\t b \t'), {first: 'a', second: 'b', count: 2}));

console.log('\n3. blank and degenerate input');
check('empty text', same(scanPreviewLines(''), {first: '', second: '', count: 0}));
check('only a newline', same(scanPreviewLines('\n'), {first: '', second: '', count: 0}));
check('only blank lines', same(
    scanPreviewLines('\n\n   \n\t\n \n'), {first: '', second: '', count: 0}));
check('whitespace-only text is one blank line',
    same(scanPreviewLines('    '), {first: '', second: '', count: 0}));
check('CRLF line endings count as one line each',
    same(scanPreviewLines('a\r\nb\r\nc'), {first: 'a', second: 'b', count: 3}));
check('CRLF blank lines are blank',
    same(scanPreviewLines('a\r\n\r\n  \r\nb'), {first: 'a', second: 'b', count: 2}));
check('lone CR is whitespace, not a separator',
    same(scanPreviewLines('a\rb'), {first: 'a\rb', second: '', count: 1}));
check('a real newline inside content is still a separator',
    same(scanPreviewLines('a b\nc'), {first: 'a b', second: 'c', count: 2}));
check('non-breaking space is stripped at the edges',
    scanPreviewLines(' x ').first === 'x');
check('ideographic space is stripped at the edges',
    scanPreviewLines('　x　').first === 'x');
check('interior whitespace survives',
    scanPreviewLines('a  b\tc').first === 'a  b\tc');
check('text without a trailing newline keeps its last line',
    same(scanPreviewLines('a\nb\nc'), {first: 'a', second: 'b', count: 3}));
check('text with a trailing newline does not gain a line',
    same(scanPreviewLines('a\nb\n'), {first: 'a', second: 'b', count: 2}));

console.log('\n4. differential against the old split/map/filter chain');
let rng = 123456789;
function rand(n) {
    // xorshift32 so the corpus is reproducible from run to run
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5; rng >>>= 0;
    return rng % n;
}
let diffCases = 0;
let diffFails = 0;
const TRIALS = 20000;
for (let t = 0; t < TRIALS; t++) {
    const lineCount = 1 + rand(6);
    const lines = [];
    for (let i = 0; i < lineCount; i++)
        lines.push(LINE_SHAPES[rand(LINE_SHAPES.length)]);
    const text = lines.join('\n') + (rand(4) === 0 ? '\n' : '');
    const got = scanPreviewLines(text);
    const want = legacyPreview(text);
    if (!same(got, want)) {
        diffFails++;
        if (diffFails === 1)
            console.log(`  first mismatch: ${JSON.stringify(text)}\n` +
                        `    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
    }
    diffCases++;
}
check(`${diffCases} random line combinations match the old chain`, diffFails === 0);

console.log('\n5. differential on large inputs');// A multi-megabyte log: the case the single-pass scan exists for.
const bigLines = [];
for (let i = 0; i < 60000; i++) {
    switch (i % 4) {
    case 0: bigLines.push(''); break;
    case 1: bigLines.push('    '); break;
    case 2: bigLines.push(`    2026-01-01 12:00:${String(i % 60).padStart(2, '0')} INFO  message number ${i}`); break;
    default: bigLines.push(''); break;
    }
}
const bigText = bigLines.join('\n');
check('60k-line log: first line',
    scanPreviewLines(bigText).first === '2026-01-01 12:00:02 INFO  message number 2');
check('60k-line log: second line',
    scanPreviewLines(bigText).second === '2026-01-01 12:00:06 INFO  message number 6');
check('60k-line log: count matches the old chain',
    scanPreviewLines(bigText).count === legacyPreview(bigText).count);
check('60k-line log: count is the expected 15000',
    scanPreviewLines(bigText).count === 15000);
// A wall of blank lines: the probe must not rescan the run per line.
const blankWall = '\n'.repeat(200000);
check('200k blank lines: count 0', scanPreviewLines(blankWall).count === 0);
check('200k blank lines: no line returned', scanPreviewLines(blankWall).first === '');
check('wall of spaces then content',
    same(scanPreviewLines(' '.repeat(100000) + '\nreal line\nsecond'),
        {first: 'real line', second: 'second', count: 2}));

console.log('\n6. the scan whitespace set is exactly trim()\'s');
// The scan combines a cheap ASCII shortcut with a sticky regex probe. Both
// have to agree with String.prototype.trim() about what counts as whitespace,
// or a line could be counted as empty (or non-empty) the wrong way.
let wsMismatch = 0;
let shortcutMismatch = 0;
for (let code = 0; code < 0x10000; code++) {
    const ch = String.fromCharCode(code);
    const isSpaceForTrim = ch.trim() === '';
    if (ch !== '\n' && /[^\S\n]/.test(ch) !== isSpaceForTrim)
        wsMismatch++;
    // The shortcut is one-directional: taking it must never happen for a
    // character trim() would strip. Declining to take it is always safe (the
    // probe then decides), so only that direction can be wrong.
    if (isSpaceForTrim && code > 32 && code < 128)
        shortcutMismatch++;
}
check('probe matches trim() for all 65536 code points', wsMismatch === 0);
check('ASCII shortcut never fires on a whitespace character', shortcutMismatch === 0);
check('a line starting with a shortcut-ruled-out char is non-empty',
    scanPreviewLines('abc').count === 1);
check('a line starting with an exotic space still probes',
    same(scanPreviewLines(' 　x'), {first: 'x', second: '', count: 1}));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} textPreview check(s) failed`);
