// Test for the string helpers the menu previews are built from: the whitespace
// flattening, and the character-count cut that is being replaced by a width cut
// row by row.
//
// These two used to be one function. They are separated because cutting to a
// character count and cutting to a width are different jobs that happened to be
// fused, and the second one is not something a pure function can do — it needs
// Pango's glyph metrics and a real allocation.
//
// What is pinned here is the part that has to survive the transition:
// collapseWhitespace() must do exactly what truncate() used to do BEFORE it cut,
// because a row that is now cut by width still must not render a copied
// paragraph as several lines. A regression there is invisible in a screenshot
// of a short string and obvious in a screenshot of a real one.
import { collapseWhitespace, truncate, fmt } from '../strings.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) {
        passed++;
        print(`  PASS ${name}`);
    } else {
        failed++;
        print(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}
function eq(actual, expected, what) {
    check(what, actual === expected, `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}

print('collapseWhitespace: схлопывание пробелов');

// The reason this exists at all: a menu row is one line, and a copied paragraph
// set verbatim would push every other row off the menu.
eq(collapseWhitespace('строка\n\nвторая\tтретья'), 'строка вторая третья',
    'переносы и табуляции схлопываются в один пробел');
eq(collapseWhitespace('a\n\nb'), 'a b', 'пустая строка между словами даёт один пробел');
eq(collapseWhitespace('  ведущие и конечные  '), ' ведущие и конечные ',
    'крайние пробелы НЕ трогаются — trim решает другая задача');
eq(collapseWhitespace('обычный текст без пробелов подряд'), 'обычный текст без пробелов подряд',
    'текст без лишних пробелов не меняется');
eq(collapseWhitespace(''), '', 'пустая строка остаётся пустой');
eq(collapseWhitespace('   '), ' ', 'строка из одних пробелов схлопывается в один');

// The invariant that made the split possible: for any input short enough that
// truncate() does not need to cut, the two must agree exactly. Every row that is
// still cut by character count depends on this.
for (const sample of ['a b', 'x\ny', '  p  q  ', 'одно', 'a\n\n\n\nb', '']) {
    eq(truncate(sample, 100), collapseWhitespace(sample),
        `truncate не режет — совпадает с collapseWhitespace: ${JSON.stringify(sample)}`);
}

print('\ntruncate: срез по символам');

// Counted in CODE POINTS, not UTF-16 units. Slicing a surrogate pair would
// render as a replacement character, the one artefact a preview must never have.
eq(truncate('W'.repeat(30), 10), 'WWWWWWWWW…', 'длинная строка режется с многоточием');
check('ellipsize занимает один глиф, а не три точки',
    truncate('W'.repeat(30), 10).endsWith('…') && !truncate('W'.repeat(30), 10).endsWith('...'));
eq(truncate('короткая', 10), 'короткая', 'строка короче лимита не режется');
// Exactly at the limit: no ellipsis, because nothing was lost.
eq(truncate('0123456789', 10), '0123456789', 'строка ровно в лимит не режется');
eq(truncate('0123456789A', 10), '012345678A…'.slice(0, 0) + '012345678…',
    'на один символ длиннее лимита режется');

const emoji = truncate('👍'.repeat(12), 5);
eq([...emoji].length, 5, 'эмодзи режется по кодовым точкам, не ломая сурогатную пару');
// U+FFFD REPLACEMENT CHARACTER, written as an escape on purpose: the literal
// glyph is invisible in a diff, and an assertion nobody can read is an
// assertion nobody checks.
check('в эмодзи нет символа замены', !emoji.includes('\uFFFD'),
    `получено ${JSON.stringify(emoji)}`);

// A character count cannot know that 30 "W" is 420 px where 30 "i" is 120 px.
// That gap is why rows are moving to width-based cutting, and it is worth
// stating as a test so the difference is not "fixed" by someone without knowing.
const wide = truncate('W'.repeat(30), 30);
const narrow = truncate('i'.repeat(30), 30);
check('одинаковый лимит символов даёт разный текст (это и есть причина перехода на ширину)',
    wide.length === narrow.length && wide !== narrow,
    'при равном числе символов ширина разная — счёт символов не измеряет ширину');

print('\nfmt: подстановки в переводимые строки');

eq(fmt('%1$d файлов в %2$s', 3, '/tmp'), '3 файлов в /tmp', 'номер и строка по индексам');
eq(fmt('%1$s и %1$s', 'дважды'), 'дважды и дважды', 'один индекс используется дважды');
eq(fmt('%1$s', undefined), '', 'неизвестный индекс даёт пустую строку, а не «undefined»');
eq(fmt('%3$s', 'x'), '', 'индекс вне списка аргументов даёт пустую строку');
// The docstring above strings.js promises that a literal '%%' is left alone.
// That holds for '%%' on its own and at the end of a string, and it does NOT
// hold when digits follow: fmt() has no notion of an escape, so it simply
// matches the placeholder that starts at the second '%'. Nothing in the
// translations uses '%%', so this is recorded rather than fixed — changing the
// formatter to be printf-exact would change behaviour nobody depends on, and
// the promise in the comment is what has to stay honest.
eq(fmt('100%%'), '100%%', '%% в конце строки остаётся как есть');
eq(fmt('%%1$s'), '%', 'но %% перед плейсхолдером схлопывается — экранирования нет');
eq(fmt('%1$d', 3.7), '3', 'дробное значение для %d округляется вниз');
eq(fmt('без подстановок'), 'без подстановок', 'строка без плейсхолдеров не меняется');

print(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} проверок не прошли`);
