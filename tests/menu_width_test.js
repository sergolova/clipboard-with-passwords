// Test for the character-budget → pixel-width conversion behind the menu's width.
//
// This is pure arithmetic and needs no shell, which is the point: the conversion
// has a clamp at BOTH ends, and the ends are where the bugs are. The «Preview
// Size» setting runs from 10 to 100 characters. At 10 characters a menu would be
// about 78 px wide — one letter and an ellipsis — so without a floor the bottom
// of the range produces something unusable. At 100 characters it would be about
// 777 px, which on a laptop runs off the screen. The clamp is therefore not
// decoration; it is the difference between a setting that works at its extremes
// and one that does not.
//
// The measured value (about 7.8 px per character) is what the theme's font gave
// on this machine at the default setting of 60. It is a real measurement and it
// is the reason the numbers below look like the ones a user would see — but it is
// NOT pinned as an assertion, because the user is free to change the system font
// and a test that fails when they do is a test that gets ignored.
import {menuWidthFor, MIN_MENU_WIDTH, MAX_MENU_WIDTH_FRACTION} from '../menuWidth.js';

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
    check(what, actual === expected, `получено ${actual}, ожидалось ${expected}`);
}

const PX_PER_CHAR = 7.77;   // measured, not asserted
const SCREEN = 1920;
const MAX = Math.round(SCREEN * MAX_MENU_WIDTH_FRACTION);   // 768

print('menuWidthFor: перевод бюджета символов в пиксели');

eq(menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 60, maxWidth: MAX}),
    466, '60 символов при 7.77 px/символ даёт 466 px');

print('\nзажим снизу — короткий бюджет не даёт нечитаемое меню');

// 10 characters is the setting's own minimum and comes out at 78 px uncapped.
const tiny = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 10, maxWidth: MAX});
eq(tiny, MIN_MENU_WIDTH, '10 символов поднимается до минимальной ширины');
check('минимальная ширина пригодна для чтения', tiny >= 240, `получено ${tiny}px`);
for (const size of [10, 11, 15, 20]) {
    const w = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: size, maxWidth: MAX});
    check(`${size} симв. не даёт меню уже ${MIN_MENU_WIDTH}px`, w === MIN_MENU_WIDTH,
        `получено ${w}px`);
}

print('\nзажим сверху — длинный бюджет не уводит меню за экран');

const huge = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 100, maxWidth: MAX});
eq(huge, MAX, '100 символов обрезается до максимальной ширины');
check('максимальная ширина — доля экрана, а не сама ширина текста',
    MAX === Math.round(SCREEN * 0.4), `получено ${MAX}px при экране ${SCREEN}px`);
// The fraction was 0.6 once, and at that value the ceiling could never bind:
// 100 characters is about 777 px and 0.6 of a 1366 px panel is 820. A safeguard
// that no input can reach is not a safeguard, it is decoration.
check('потолок достижим на верхнем краю диапазона', MAX < 777,
    `потолок ${MAX}px против 777 px при 100 символах — потолок недостижим`);
// The important part of the ceiling is that it scales with the monitor.
const small = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 100, maxWidth: Math.round(1366 * MAX_MENU_WIDTH_FRACTION)});
check('на узком экране потолок ниже', small < huge,
    `1366px → ${small}px, 1920px → ${huge}px`);

print('\nсередина диапазона не зажата');

// Every size between the clamps must produce a width strictly between them, or
// the setting has a dead zone where turning the knob does nothing.
let dead = [];
for (let size = 10; size <= 100; size++) {
    const w = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: size, maxWidth: MAX});
    if (size > 30 && size < 90 && (w <= MIN_MENU_WIDTH || w >= MAX))
        dead.push(size);
}
check('в середине диапазона ручка не мёртвая', dead.length === 0,
    `мёртвые значения: ${dead.join(', ') || 'нет'}`);

// And it must actually grow across that range, or the clamp is doing something
// other than what it claims.
const low = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 35, maxWidth: MAX});
const high = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 85, maxWidth: MAX});
check('в середине диапазона ширина растёт вместе с настройкой', high > low,
    `35 → ${low}px, 85 → ${high}px`);

print('\nнеудачный замер не даёт нулевое меню');

// measurePxPerChar() returns 0 when the stage is not ready yet, which is a normal
// state during enable(). A zero-width menu would make every row invisible, which
// is a far worse failure than a too-wide one.
for (const [what, opts] of [
    ['нулевой замер', {pxPerChar: 0, previewSize: 60}],
    ['отрицательный замер', {pxPerChar: -5, previewSize: 60}],
    ['нулевой бюджет', {pxPerChar: PX_PER_CHAR, previewSize: 0}],
    ['пустые аргументы', {}],
]) {
    const w = menuWidthFor({maxWidth: MAX, ...opts});
    eq(w, MIN_MENU_WIDTH, `${what} → минимальная ширина, а не ноль`);
}

print('\nдеталь: округление не выпускает за зажим');

// A maxWidth of 383.6 must not become 384 by rounding — the row would then
// overflow by a pixel and the scrollbar would appear for nothing.
const fractional = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 49.35, maxWidth: 383.6});
check('округление не выходит за потолок', fractional <= 384,
    `получено ${fractional}px при потолке 383.6px`);
eq(menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 60, minWidth: 240.6, maxWidth: 500}),
    466, ' округление применяется один раз, а не на каждом шаге');

print('\nширины всегда целые и никогда не инвертированы');
// A screen narrow enough that the ceiling lands below the floor is
// contradictory, and the floor must win — a menu too wide for a tiny screen is
// still a menu, one narrower than a usable row shows nothing.
const cramped = menuWidthFor({pxPerChar: PX_PER_CHAR, previewSize: 100, maxWidth: 160});
check('на очень узком экране побеждает минимум, а не потолок',
    cramped === MIN_MENU_WIDTH, `потолок был 160px, получено ${cramped}px`);

let allInt = true, allOrdered = true;
for (let size = 1; size <= 200; size++) {
    for (const ppc of [3, 7.77, 12.5]) {
        const w = menuWidthFor({pxPerChar: ppc, previewSize: size, maxWidth: 900});
        if (!Number.isInteger(w)) allInt = false;
        if (w < MIN_MENU_WIDTH || w > 900) allOrdered = false;
    }
}
check('ширина всегда целое число пикселей', allInt);
check('ширина всегда внутри [минимум, максимум]', allOrdered);

print(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} проверок не прошли`);
