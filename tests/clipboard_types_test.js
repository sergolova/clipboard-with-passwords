// Test harness for clipboardTypes.js — the mimetype negotiation that decides
// which clipboard transfers a capture performs.
//
// The point of the module is that a capture asks the owner what it offers
// instead of probing every supported mimetype blind, so the cases below are
// mostly real advertised lists (captured from wl-copy and from typical X11
// apps) checked against the number and order of requests they produce.
//
// Run with: gjs -m tools/local/clipboard_types_test.js

import {
    BLIND_MIMETYPE_CHAIN,
    entryTypeForOffered,
    offeredTypeCandidates,
    preferLastSuccessful,
} from '../clipboardTypes.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

function requests(offered) {
    return offeredTypeCandidates(offered).map(c => c.request);
}

function requests2(candidates) {
    return candidates.map(c => c.request);
}

console.log('1. real advertised lists collapse to a single transfer');
// wl-copy --type text/plain, as reported by St.Clipboard.get_mimetypes.
check('wl-copy text: one request',
    requests(['UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8', 'text/plain', 'text/plain'])
        .length === 1);
check('wl-copy text: requests the charset spelling first',
    requests(['UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8', 'text/plain', 'text/plain'])[0]
        === 'text/plain;charset=utf-8');
// wl-copy --type image/png
check('wl-copy png: one request for image/png',
    JSON.stringify(requests(['image/png'])) === JSON.stringify(['image/png']));
// A typical X11 GTK application.
check('X11 text: one request',
    requests(['text/plain;charset=utf-8', 'text/plain', 'STRING', 'COMPOUND_TEXT', 'TEXT']).length === 1);
check('X11 text: prefers the charset spelling',
    requests(['text/plain;charset=utf-8', 'text/plain', 'STRING', 'COMPOUND_TEXT', 'TEXT'])[0]
        === 'text/plain;charset=utf-8');
check('image burst: one request per image copy',
    requests(['image/jpeg', 'image/png']).length === 2);

console.log('2. stored entry mimetype is normalised, request is the owner\'s spelling');
check('UTF8_STRING -> text/plain;charset=utf-8',
    entryTypeForOffered('UTF8_STRING') === 'text/plain;charset=utf-8');
check('COMPOUND_TEXT -> text/plain;charset=utf-8',
    entryTypeForOffered('COMPOUND_TEXT') === 'text/plain;charset=utf-8');
check('STRING -> text/plain', entryTypeForOffered('STRING') === 'text/plain');
check('TEXT -> text/plain', entryTypeForOffered('TEXT') === 'text/plain');
check('image/png stays image/png', entryTypeForOffered('image/png') === 'image/png');
check('image/svg+xml stays image/svg+xml', entryTypeForOffered('image/svg+xml') === 'image/svg+xml');
check('text/html stays text/html', entryTypeForOffered('text/html') === 'text/html');
check('text/uri-list stays text/uri-list', entryTypeForOffered('text/uri-list') === 'text/uri-list');

console.log('3. only the offered spelling is ever requested');
check('sole STRING offer: requests STRING, stores text/plain',
    JSON.stringify(offeredTypeCandidates(['STRING'])) ===
    JSON.stringify([{request: 'STRING', entryType: 'text/plain'}]));
check('sole TEXT offer: requests TEXT, stores text/plain',
    JSON.stringify(offeredTypeCandidates(['TEXT'])) ===
    JSON.stringify([{request: 'TEXT', entryType: 'text/plain'}]));
check('sole COMPOUND_TEXT offer: requests COMPOUND_TEXT, stores charset spelling',
    JSON.stringify(offeredTypeCandidates(['COMPOUND_TEXT'])) ===
    JSON.stringify([{request: 'COMPOUND_TEXT', entryType: 'text/plain;charset=utf-8'}]));
check('lowercase legacy spelling: requests the owner\'s spelling',
    offeredTypeCandidates(['utf8_string'])[0].request === 'utf8_string');
check('lowercase legacy spelling still normalises the entry',
    offeredTypeCandidates(['utf8_string'])[0].entryType === 'text/plain;charset=utf-8');
check('no unoffered type is requested',
    requests(['image/png']).every(r => offeredTypeCandidates(['image/png'])[0].request === r) &&
    !requests(['image/png']).includes('text/uri-list'));
check('group preference beats owner order (charset spelling over text/plain)',
    requests(['text/plain', 'text/plain;charset=utf-8'])[0] === 'text/plain;charset=utf-8');
check('duplicated offers collapse to one candidate',
    requests(['text/plain', 'text/plain']).length === 1);
check('jpeg group accepts image/jpg',
    JSON.stringify(requests(['image/jpg'])) === JSON.stringify(['image/jpg']));
check('jpeg group accepts image/jpeg',
    JSON.stringify(requests(['image/jpeg'])) === JSON.stringify(['image/jpeg']));
check('png is preferred over jpeg regardless of owner order',
    JSON.stringify(requests(['image/jpeg', 'image/png'])) === JSON.stringify(['image/png', 'image/jpeg']));
check('uri-list is preferred over text',
    JSON.stringify(requests(['text/plain;charset=utf-8', 'text/uri-list'])) ===
    JSON.stringify(['text/uri-list', 'text/plain;charset=utf-8']));
check('webp alone', JSON.stringify(requests(['image/webp'])) === JSON.stringify(['image/webp']));
check('gif alone', JSON.stringify(requests(['image/gif'])) === JSON.stringify(['image/gif']));
check('html alone', JSON.stringify(requests(['text/html'])) === JSON.stringify(['text/html']));
check('unknown types are ignored, not requested',
    JSON.stringify(requests(['application/x-kde-cutselection', 'image/png'])) ===
    JSON.stringify(['image/png']));

console.log('4. blind chain is the fallback for an owner that advertised nothing');
check('empty offer falls back to the blind chain',
    JSON.stringify(requests([])) === JSON.stringify(BLIND_MIMETYPE_CHAIN));
check('null offer falls back to the blind chain',
    JSON.stringify(requests(null)) === JSON.stringify(BLIND_MIMETYPE_CHAIN));
check('non-array offer falls back to the blind chain',
    JSON.stringify(requests(undefined)) === JSON.stringify(BLIND_MIMETYPE_CHAIN));
check('an offer of only empty strings is still "advertised something"',
    requests(['', '']).length === 0, JSON.stringify(requests(['', ''])));
check('fallback keeps the historical entry mimetypes',
    JSON.stringify(offeredTypeCandidates([]).map(c => c.entryType)) ===
    JSON.stringify(BLIND_MIMETYPE_CHAIN.map(entryTypeForOffered)));
check('fallback normalises UTF8_STRING like the historical chain did',
    offeredTypeCandidates([]).find(c => c.request === 'UTF8_STRING').entryType ===
    'text/plain;charset=utf-8');

console.log('4b. an owner that advertised only unusable types gets no request');
// The measured case: an owner offering only image/bmp + image/tiff, or only
// application/rtf, used to walk all twelve blind requests. Each unanswered one
// waits out its full timeout, so that was 2415 ms of silence and no capture —
// and those unoffered requests are the abandoned-transfer pattern that used to
// take the shell down. The visible result is the same either way (nothing is
// captured), so the stall and the risk are pure loss.
for (const offered of [
    ['application/x-unknown-thing'],
    ['image/bmp', 'image/tiff'],
    ['application/rtf'],
    ['image/x-icon', 'application/x-kde-cursors', 'application/rtf'],
    ['SAVE_TARGETS', 'MULTIPLE', 'TIMESTAMP'],
]) {
    check(`${JSON.stringify(offered)} produces no request at all`,
        requests(offered).length === 0, JSON.stringify(requests(offered)));
}
check('the captured case still requests, so the rule is not "give up always"',
    requests(['image/png']).length === 1);
check('one usable type among many still wins over the unusable ones',
    JSON.stringify(requests(['application/rtf', 'image/png', 'text/html'])) ===
    JSON.stringify(['image/png', 'text/html']));
check('the unusable types are not merely reordered, they are absent',
    requests(['application/rtf', 'image/png', 'text/html'])
        .every(r => r !== 'application/rtf'));

console.log('5. every negotiated request is one the owner advertised');
const realLists = [
    ['UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8', 'text/plain', 'text/plain'],
    ['image/png'],
    ['text/plain;charset=utf-8', 'text/plain', 'STRING', 'COMPOUND_TEXT', 'TEXT'],
    ['text/uri-list', 'text/plain;charset=utf-8', 'STRING'],
    ['image/jpeg', 'image/png'],
    ['application/x-kde-cutselection', 'image/gif', 'text/plain'],
    ['image/svg+xml', 'text/html'],
];
let allAdvertised = true;
for (const offered of realLists) {
    for (const candidate of offeredTypeCandidates(offered)) {
        if (!offered.includes(candidate.request))
            allAdvertised = false;
    }
}
check('no request is outside the advertised list', allAdvertised);
check('negotiated requests never exceed the advertised list',
    realLists.every(o => offeredTypeCandidates(o).length <= o.length));
check(`a text-only capture costs 1 transfer instead of walking the ` +
    `${BLIND_MIMETYPE_CHAIN.length}-type blind chain`,
    offeredTypeCandidates(realLists[0]).length === 1 &&
    BLIND_MIMETYPE_CHAIN.length > 1);

console.log('6. the last successful request is retried first');
const textAndImage = offeredTypeCandidates(['text/plain;charset=utf-8', 'image/png']);
const imageThenText = preferLastSuccessful(textAndImage, 'image/png');
check('an image request is moved in front of plain text',
    requests2(imageThenText).join() === 'image/png,text/plain;charset=utf-8');
check('an image first costs 1 transfer on the next identical copy',
    imageThenText.length === textAndImage.length && imageThenText.length === 2);

const fileListThenText = preferLastSuccessful(
    offeredTypeCandidates(['text/uri-list', 'text/plain;charset=utf-8']), 'text/plain;charset=utf-8');
check('plain text is NOT moved in front of a file list',
    requests2(fileListThenText).join() === 'text/uri-list,text/plain;charset=utf-8');

const fileListThenHtml = preferLastSuccessful(
    offeredTypeCandidates(['text/uri-list', 'text/html']), 'text/html');
check('html is NOT moved in front of a file list',
    requests2(fileListThenHtml).join() === 'text/uri-list,text/html');

const imageThenHtml = preferLastSuccessful(
    offeredTypeCandidates(['image/png', 'text/html']), 'text/html');
check('html is NOT moved in front of an image',
    requests2(imageThenHtml).join() === 'image/png,text/html');

const imageInFront = preferLastSuccessful(
    offeredTypeCandidates(['text/plain;charset=utf-8', 'image/jpeg']), 'image/jpeg');
check('an image request is moved in front of plain text (jpeg)',
    requests2(imageInFront).join() === 'image/jpeg,text/plain;charset=utf-8');

const allTypes = offeredTypeCandidates(
    ['text/uri-list', 'text/plain;charset=utf-8', 'image/png', 'image/jpeg', 'text/html']);
const pngFirst = preferLastSuccessful(allTypes, 'image/png');
check('the rest of the order is left alone',
    requests2(pngFirst).join() ===
    'image/png,text/uri-list,text/plain;charset=utf-8,image/jpeg,text/html');
check('a promotion is refused when a richer type leads',
    preferLastSuccessful(allTypes, 'text/plain;charset=utf-8') === allTypes &&
    preferLastSuccessful(allTypes, 'text/html') === allTypes);

console.log('7. the fast path never changes what is stored, only when');
const before = offeredTypeCandidates(['text/uri-list', 'text/plain;charset=utf-8', 'image/png', 'text/html']);
const after = preferLastSuccessful(before, 'text/html');
check('a refused promotion returns the very same list (no copy)', after === before);
check('no-op when the request is absent',
    preferLastSuccessful(before, 'application/x-nope') === before);
check('no-op when the request is already first',
    preferLastSuccessful(before, 'text/uri-list') === before);
check('no-op without a remembered request',
    preferLastSuccessful(before, null) === before &&
    preferLastSuccessful(before, undefined) === before);
check('no-op on a non-list', preferLastSuccessful(null, 'image/png') === null);
check('the input list is not mutated', requests2(before).join() ===
    'text/uri-list,text/plain;charset=utf-8,image/png,text/html');

console.log('8. guessing wrong costs one failed request, not a re-walk');
// Walk every candidate list the negotiation can produce, move every candidate to
// the front in turn, and compare the number of transfers needed to reach each
// possible winner.
function permutations(list) {
    if (list.length <= 1)
        return [list];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const rest = [...list.slice(0, i), ...list.slice(i + 1)];
        for (const tail of permutations(rest))
            out.push([list[i], ...tail]);
    }
    return out;
}
const pool = [
    {request: 'text/uri-list', entryType: 'text/uri-list'},
    {request: 'text/plain;charset=utf-8', entryType: 'text/plain;charset=utf-8'},
    {request: 'text/plain', entryType: 'text/plain'},
    {request: 'image/png', entryType: 'image/png'},
    {request: 'image/jpeg', entryType: 'image/jpeg'},
    {request: 'text/html', entryType: 'text/html'},
];
let neverMuchWorse = false, everShorter = false, refuted = 0, worstPush = 0;
for (const list of permutations(pool)) {
    for (const last of [null, ...list.map(c => c.request)]) {
        const reordered = preferLastSuccessful(list, last);
        // The remembered type is always reached first, and never with more
        // transfers than the unmodified order needed.
        if (last && reordered[0].request === last &&
            reordered.findIndex(c => c.request === last) < list.findIndex(c => c.request === last))
            everShorter = true;
        for (const winner of list) {
            const a = list.indexOf(winner);
            const b = reordered.findIndex(c => c.request === winner.request);
            const push = b - a;
            if (push > 1)
                neverMuchWorse = true;
            if (push > worstPush)
                worstPush = push;
        }
    }
    // A refused promotion must be one where a text rendering would have
    // outranked a file list or an image.
    for (const last of list) {
        if (preferLastSuccessful(list, last.request) === list) {
            const idx = list.indexOf(last);
            const isText = last.entryType === 'text/html' || last.entryType.startsWith('text/plain');
            const blockedBy = isText && list.slice(0, idx).find(c =>
                c.entryType === 'text/uri-list' || c.entryType.startsWith('image/'));
            if (idx > 0 && !blockedBy)
                neverMuchWorse = true;
            if (idx > 0)
                refuted++;
        }
    }
}
check('no candidate is pushed back by more than one transfer', !neverMuchWorse);
check(`the worst case is exactly one failed request (${worstPush})`, worstPush <= 1);
check('the remembered type is reached sooner', everShorter);
check(`every refusal has a rich type to protect (${refuted} cases)`, refuted > 0);

console.log('9. a promoted request is still one the owner advertised');
let stillAdvertised = true;
for (const offered of realLists.concat([['text/uri-list', 'text/plain', 'image/png', 'text/html']])) {
    const candidates = offeredTypeCandidates(offered);
    for (const last of candidates.map(c => c.request)) {
        for (const candidate of preferLastSuccessful(candidates, last)) {
            if (!offered.includes(candidate.request))
                stillAdvertised = false;
        }
    }
}
check('the fast path never introduces an unoffered request', stillAdvertised);

console.log('10. the blind chain benefits most');
const blindImage = preferLastSuccessful(offeredTypeCandidates([]), 'image/png');
check('an image in the blind chain drops from 7 transfers to 1',
    requests2(blindImage)[0] === 'image/png' && blindImage.length === BLIND_MIMETYPE_CHAIN.length);
const blindText = preferLastSuccessful(offeredTypeCandidates([]), 'text/plain;charset=utf-8');
check('plain text in the blind chain stays behind the file-list request',
    requests2(blindText).join() === BLIND_MIMETYPE_CHAIN.join());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} clipboardTypes check(s) failed`);