// Test harness for categoryIndex.js — the one-pass category summary behind
// the vault's filter bar.
//
// The old code answered the same question two ways: getCategories() walked
// every record with a linear "seen" list, and each button label asked the
// item lookup for a filtered array and took its length. The differential cases
// below compare the new summary against verbatim copies of both, so "the
// counts are identical" is checked rather than assumed.
//
// Run with: gjs -m tools/local/category_index_test.js

import {buildCategoryIndex, categoryCount} from '../categoryIndex.js';

const ALL = '__all__';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

// --- the two implementations this replaces, copied verbatim ---------------
function oldGetCategories(items) {
    const seen = [];
    (items || []).forEach(item => {
        const cat = item.category;
        if (cat && !seen.includes(cat))
            seen.push(cat);
    });
    return seen;
}

function oldCategoryCount(items, cat) {
    let list = items || [];
    if (cat && cat !== ALL)
        list = list.filter(item => item.category === cat);
    return list.length;
}

const req = (cat, index) => categoryCount(index, cat, ALL);

console.log('1. membership and counts in one pass');
const items = [
    {id: '1', category: 'Work'},
    {id: '2', category: ''},
    {id: '3', category: 'Home'},
    {id: '4', category: 'Work'},
    {id: '5'},
    {id: '6', category: 'Work'},
    {id: '7', category: 'Home'},
];
const index = buildCategoryIndex(items);
check('categories in order of first appearance',
    index.categories.join() === 'Work,Home');
check('the uncategorized record is counted in no category',
    req('Work', index) === 3 && req('Home', index) === 2);
check('"All" counts every record, categorized or not',
    req(ALL, index) === 7, String(req(ALL, index)));
check('an unknown category counts zero', req('Nope', index) === 0);
check('an empty category name counts every record, as the lookup did',
    req('', index) === 7, String(req('', index)));
check('a missing category counts every record too', req(undefined, index) === 7);
check('total is the record count', index.total === 7);

console.log('\n2. empty and absent input');
check('no records', (() => {
    const i = buildCategoryIndex([]);
    return i.categories.length === 0 && i.total === 0 && req(ALL, i) === 0;
})());
check('records with no category at all', (() => {
    const i = buildCategoryIndex([{}, {category: ''}, {category: null}]);
    return i.categories.length === 0 && i.total === 3 && req(ALL, i) === 3;
})());
check('a missing items list is not a crash', (() => {
    const i = buildCategoryIndex(undefined);
    return i.categories.length === 0 && i.total === 0;
})());
check('a null record is not a crash', (() => {
    const i = buildCategoryIndex([null, {category: 'Work'}]);
    return i.categories.join() === 'Work' && i.total === 2;
})());

console.log('\n3. input is never touched');
const untouched = [{category: 'Work'}, {category: 'Home'}];
const before = JSON.stringify(untouched);
buildCategoryIndex(untouched);
check('the record array is unchanged', JSON.stringify(untouched) === before);

console.log('\n4. the summary is a snapshot, not a live view');
const growing = [{category: 'Work'}];
const snap = buildCategoryIndex(growing);
growing.push({category: 'Work'}, {category: 'New'});
check('later mutations are not reflected', req('Work', snap) === 1 && snap.categories.join() === 'Work');
check('a rebuilt summary sees them', (() => {
    const fresh = buildCategoryIndex(growing);
    return req('Work', fresh) === 2 && fresh.categories.join() === 'Work,New';
})());

console.log('\n5. differential against the old per-category scans');
// Category names chosen to collide with Map/object-key folklore, and to
// include the empty string and non-ASCII, which is what a hand-edited
// data.json can contain.
const NAMES = ['Work', 'work', '__all__', 'constructor', 'toString', 'hasOwnProperty',
    'Home', '', '  ', 'Работа', 'a b'];
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(20260928);
let mismatches = 0, cases = 0, totalRecords = 0;
for (let round = 0; round < 3000; round++) {
    const n = Math.floor(rand() * 40);
    const list = [];
    for (let i = 0; i < n; i++) {
        const roll = rand();
        const record = {id: String(i)};
        if (roll < 0.7)
            record.category = NAMES[Math.floor(rand() * NAMES.length)];
        else if (roll < 0.8)
            record.category = '';
        list.push(record);
    }
    totalRecords += list.length;
    const built = buildCategoryIndex(list);
    cases++;
    if (built.categories.join('|') !== oldGetCategories(list).join('|'))
        mismatches++;
    if (built.total !== oldCategoryCount(list, ALL))
        mismatches++;
    for (const cat of [...NAMES, ALL]) {
        if (req(cat, built) !== oldCategoryCount(list, cat)) {
            mismatches++;
            break;
        }
    }
}
check(`identical to the old scans on ${cases} random vaults (${totalRecords} records)`, mismatches === 0);

console.log('\n6. the count lookup is a map read, not a scan');
// The whole point: one pass to build, then a lookup. Counted by giving the
// index a proxy-ish item list whose records are counted as they are visited,
// which is what a second scan would show up as.
let visits = 0;
const counted = [];
for (let i = 0; i < 1000; i++)
    counted.push({get category() { visits++; return `c${i % 200}`; }});
visits = 0;
const big = buildCategoryIndex(counted);
const buildVisits = visits;
visits = 0;
for (const cat of big.categories)
    req(cat, big);
const lookupVisits = visits;
check('building reads every record exactly once', buildVisits === 1000, String(buildVisits));
check('200 count lookups read nothing', lookupVisits === 0, String(lookupVisits));
check('200 categories over 1000 records are counted right',
    big.categories.length === 200 && big.total === 1000 && req('c0', big) === 5);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} categoryIndex check(s) failed`);
