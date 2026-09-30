// Test harness for the two pieces of arithmetic that used to live inline in
// extension.js, where nothing could ask them a question: the file row's second
// line, and the countdown to the next automatic clear.
//
// Both decide something a user SEES and neither was covered at all, which is the
// combination that lets a regression sit there for months. The name layout
// decides how wide a row is — a mistake there is a menu that looks wrong rather
// than an error — and the countdown is the one label in the whole extension whose
// text is not translated, so its exact output is a contract in two directions at
// once: the formatting must not drift, and the day it is fixed that has to be a
// deliberate change rather than an accident.
//
// Run with:
//   gjs -m tools/local/row_layout_test.js
//
// No gi:// imports and no shell needed for either module.

import GLib from 'gi://GLib';

import {
    FILE_NAME_MIN_CHARS,
    MAX_SHOWN_FILE_NAMES,
    layoutFileNames,
} from '../fileRow.js';
import {formatCountdown} from '../historyInterval.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const texts = r => r.names.map(n => n.text);
const raws = r => r.names.map(n => n.raw);

console.log('1. a plain list: every name, nothing dropped');
{
    const r = layoutFileNames(['a.pdf', 'b.txt', 'c.png'], {chars: 50});
    check('three names in, three out', r.names.length === 3, String(r.names.length));
    check('nothing dropped', r.hiddenCount === 0, String(r.hiddenCount));
    check('the order is the copied order',
        JSON.stringify(raws(r)) === JSON.stringify(['a.pdf', 'b.txt', 'c.png']));
    check('the budget is split three ways', r.perName === Math.floor(50 / 3),
        String(r.perName));
    check('and the text is what the name already was',
        JSON.stringify(texts(r)) === JSON.stringify(['a.pdf', 'b.txt', 'c.png']));
}

console.log('\n2. duplicates are one file to a reader');
{
    const r = layoutFileNames(['a.pdf', 'a.pdf', 'b.txt'], {chars: 50});
    check('the repeat is dropped', r.names.length === 2, JSON.stringify(raws(r)));
    check('and it is not counted as hidden', r.hiddenCount === 0,
        `${r.hiddenCount} — повтор не должен выглядеть как скрытый файл`);
    // Only the FIRST occurrence survives: a directory's name and a file's name can
    // be equal, and the one that keeps its position is the one the owner listed
    // first, which is the one the "/" the icon looks at came with.
    const dir = layoutFileNames(['Photos/', 'Photos/'], {chars: 50});
    check('a repeated directory keeps one entry', dir.names.length === 1);
    check('and it keeps the raw form, slash and all', dir.names[0].raw === 'Photos/');
    check('while its text drops the separator', dir.names[0].text === 'Photos',
        JSON.stringify(dir.names[0].text));
}

console.log('\n3. the cap, and the honest count of what it hid');
{
    const many = Array.from({length: 12}, (_, i) => `file${i}.pdf`);
    const r = layoutFileNames(many, {chars: 50});
    check(`at most ${MAX_SHOWN_FILE_NAMES} names`, r.names.length === MAX_SHOWN_FILE_NAMES,
        String(r.names.length));
    check('the rest are reported, not silently dropped', r.hiddenCount === 7,
        String(r.hiddenCount));
    check('and the shown ones are the FIRST ones, not a sample',
        raws(r)[0] === 'file0.pdf' && raws(r)[4] === 'file4.pdf',
        JSON.stringify(raws(r)));
    // A list of exactly the cap is not "overflowing" — off-by-one here would
    // print "5 +" on a five-file selection.
    const exact = layoutFileNames(many.slice(0, MAX_SHOWN_FILE_NAMES), {chars: 50});
    check('exactly the cap is not an overflow', exact.hiddenCount === 0,
        String(exact.hiddenCount));
    check('one more is', layoutFileNames(many.slice(0, MAX_SHOWN_FILE_NAMES + 1), {chars: 50}).hiddenCount === 1);
}

console.log('\n4. a name is never squeezed below the floor');
{
    // Five names against a small budget is the case the floor exists for: the
    // honest share is 2 characters, and "fi… 3 chars" tells the reader nothing.
    const r = layoutFileNames(['alpha.pdf', 'bravo.pdf', 'charlie.pdf', 'delta.pdf', 'echo.pdf'],
        {chars: 10});
    check('the floor wins over the honest share', r.perName === FILE_NAME_MIN_CHARS,
        `perName=${r.perName} при budget=10 и 5 именах`);
    check('and the text is truncated to it, ellipsis and all',
        r.names.every(n => n.text.length === FILE_NAME_MIN_CHARS),
        JSON.stringify(texts(r)));
    check('a single name keeps the whole budget',
        layoutFileNames(['a-very-long-file-name-indeed.pdf'], {chars: 50}).perName === 50);
    check('even when the budget is absurdly large',
        layoutFileNames(['x', 'y'], {chars: 100000}).perName === 50000);
    // A budget of zero must not divide by zero, and must not produce a zero-length
    // name either — the floor covers it.
    const zero = layoutFileNames(['a', 'b'], {chars: 0});
    check('a zero budget does not divide by zero', Number.isFinite(zero.perName) && zero.perName > 0,
        String(zero.perName));
    check('and names are still non-empty', zero.names.every(n => n.text.length > 0),
        JSON.stringify(texts(zero)));
}

console.log('\n5. the awkward inputs');
{
    // A selection of nothing but empty names: dedupe drops them all, and showing
    // nothing for a selection that was not empty is the wrong answer.
    const empties = layoutFileNames(['', '', ''], {chars: 50});
    check('a list of empty names still shows something', empties.names.length === 3,
        String(empties.names.length));
    check('and the text of an empty name is empty, not a crash',
        empties.names.every(n => n.text === ''), JSON.stringify(texts(empties)));
    const mixed = layoutFileNames(['', 'a.pdf', ''], {chars: 50});
    check('empties are dropped when a real name is present',
        JSON.stringify(raws(mixed)) === JSON.stringify(['a.pdf']), JSON.stringify(raws(mixed)));
    check('a missing list is an empty row, not a throw',
        layoutFileNames(undefined, {chars: 50}).names.length === 0);
    check('a non-array is the same', layoutFileNames('nonsense', {chars: 50}).names.length === 0);
    check('an absent budget still yields names', layoutFileNames(['a']).names.length === 1);
    // A directory is the case where raw and text must differ, and the icon is
    // decided by raw — so the two fields are not interchangeable.
    const dir = layoutFileNames(['Documents/'], {chars: 50});
    check('a directory keeps its raw name for the icon lookup', dir.names[0].raw === 'Documents/');
    check('and reads without the separator', dir.names[0].text === 'Documents');
    // Whitespace inside a name is collapsed by the shared truncation, so a name
    // with a stray space does not silently widen the row.
    check('whitespace in a name is collapsed',
        layoutFileNames(['a   b.pdf'], {chars: 50}).names[0].text === 'a b.pdf',
        JSON.stringify(layoutFileNames(['a   b.pdf'], {chars: 50}).names[0].text));
}

console.log('\n6. the countdown, unit by unit');
const COUNTDOWN = [
    [0, ''], [-1, ''], [1, '1s'], [9, '9s'], [59, '59s'],
    [60, '1m 0s'], [61, '1m 1s'], [119, '1m 59s'],
    [3599, '59m 59s'], [3600, '1h 0s'], [3601, '1h 1s'],
    [3660, '1h 1m 0s'], [86400, '24h 0s'], [90061, '25h 1m 1s'],
    [5400, '1h 30m 0s'],
    [0.5, '0s'], [1.9, '1s'], [-0.5, ''],
];
for (const [seconds, want] of COUNTDOWN) {
    check(`formatCountdown(${seconds}) → ${JSON.stringify(want)}`,
        formatCountdown(seconds) === want, JSON.stringify(formatCountdown(seconds)));
}
check('nonsense is an empty label, not "NaNs"',
    formatCountdown(NaN) === '' && formatCountdown(Infinity) === '' && formatCountdown(undefined) === '',
    JSON.stringify(formatCountdown(NaN)));
check('a past time empties the label, which is what the timer relies on',
    formatCountdown(-1) === '');

console.log('\n7. the countdown is not translated — pinned, not endorsed');
// The one label in the extension whose text never went through gettext: the
// suffixes are literals, so a Russian user reads "2h 14m 3s". Fixing it is a
// translated format string and a real improvement, but it CHANGES what users
// see, so it is not folded into a refactor. These checks make the current output
// a deliberate contract instead of an accident: when someone localises it, the
// second check below fails and says so, which is the point.
check('the suffixes are still the hardcoded ones', formatCountdown(3723) === '1h 2m 3s',
    formatCountdown(3723));
// Read the template and look for a message that could be the countdown. Today
// there is none, and that absence IS the defect. When it is fixed this fails, and
// the fix is to delete this check and the one above, not to quieten it.
const POT = '/home/seriy/PhpstormProjects/MY/clipboard-with-passwords/clipboard-with-passwords.pot';
const potText = GLib.file_get_contents(POT)[1] ? new TextDecoder().decode(GLib.file_get_contents(POT)[1]) : '';
const msgids = [...potText.matchAll(/^msgid "((?:[^"\\]|\\.)*)"/gm)].map(m => m[1]);
// Precise on purpose: a placeholder IMMEDIATELY followed by a time-unit
// letter, which is what a localised countdown would look like. A looser
// pattern matched the unrelated '%1$s' notification and reported a
// localisation that does not exist.
const countdownish = msgids.filter(id => /%[123]\$d[hms]/.test(id));
check('the template still has no translatable countdown string, as reported',
    countdownish.length === 0,
    countdownish.length > 0
        ? `появилась строка "${countdownish[0]}" — локализация сделана, `
          + 'теперь снимите пиннинг в секции 7 и добавьте перевод в ru/uk'
        : '');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} row-layout check(s) failed`);
