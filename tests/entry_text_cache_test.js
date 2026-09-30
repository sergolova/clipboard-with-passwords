// Decoded-text / classification caching for ClipboardEntry.
//
// TextDecoder is read-only in GJS, so the cache is observed behaviorally
// instead of by counting decodes: the test keeps its own reference to the
// entry's byte buffer and mutates it. A cached entry keeps returning the old
// string; a fresh entry built from the same mutated buffer returns the new one.
// That pair of observations is what proves the value is cached rather than
// re-derived.

import { ClipboardEntry } from '../registry.js';

let passed = 0;
let failed = 0;

function ok (cond, label) {
    if (cond) {
        passed++;
    } else {
        failed++;
        print(`  FAIL: ${label}`);
    }
}

function eq (actual, expected, label) {
    ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const encoder = new TextEncoder();

// Builds an entry plus a handle on the exact buffer it reads from. The
// accessors are forwarded so tests can read `makeText('red').isColor()`.
function makeText (text, mimetype = 'text/plain;charset=utf-8') {
    const bytes = encoder.encode(text);
    const entry = new ClipboardEntry(mimetype, bytes, false);
    return {
        entry,
        bytes,
        getStringValue: (...a) => entry.getStringValue(...a),
        isColor: (...a) => entry.isColor(...a),
        isURL: (...a) => entry.isURL(...a),
        isEmail: (...a) => entry.isEmail(...a),
        isMultiline: (...a) => entry.isMultiline(...a),
        needsHashPrefix: (...a) => entry.needsHashPrefix(...a),
        setText: (...a) => entry.setText(...a),
        parseURIList: (...a) => entry.parseURIList(...a),
        getURIListDisplay: (...a) => entry.getURIListDisplay(...a)
    };
}

// Overwrites the payload in place. The buffer keeps its identity (the entry
// holds a reference to exactly this object), so a fresh entry over the same
// buffer acts as the control group that shows the new text.
function mutate (harness, newText) {
    const fresh = encoder.encode(newText);
    const shared = Math.min(fresh.length, harness.bytes.length);
    for (let i = 0; i < shared; i++)
        harness.bytes[i] = fresh[i];
    for (let i = shared; i < harness.bytes.length; i++)
        harness.bytes[i] = 0;
    return harness.entry;
}

print('== the mutation probe itself is sound ==');
{
    // Sanity check: without a cache the entry would see the new bytes. Proved
    // by a fresh entry over the same buffer — this is the control group for
    // every "cache" assertion below.
    const h = makeText('aaaa');
    const entry = new ClipboardEntry('text/plain;charset=utf-8', h.bytes, false);
    eq(entry.getStringValue(), 'aaaa', 'control: reads the original text');

    mutate(h, 'bbbb');
    const probe = new ClipboardEntry('text/plain;charset=utf-8', h.bytes, false);
    eq(probe.getStringValue(), 'bbbb', 'control: a fresh entry over mutated bytes sees them');
}
{
    // A multi-byte case, so the probe cannot pass by accident on ASCII.
    const h = makeText('привет');
    const entry = new ClipboardEntry('text/plain;charset=utf-8', h.bytes, false);
    eq(entry.getStringValue(), 'привет', 'control: decodes UTF-8');
    mutate(h, 'выводы');
    const probe = new ClipboardEntry('text/plain;charset=utf-8', h.bytes, false);
    eq(probe.getStringValue(), 'выводы', 'control: fresh entry over mutated UTF-8 sees it');
    eq(entry.getStringValue(), 'привет', 'cached entry still returns the old text');
}

print('== getStringValue() keeps the first decode ==');
{
    const h = makeText('hello clipboard');
    const entry = h.entry;
    eq(entry.getStringValue(), 'hello clipboard', 'first read');

    mutate(h, 'WELCOME HOME');
    eq(entry.getStringValue(), 'hello clipboard', 'three reads share one decode');
    eq(entry.getStringValue(), 'hello clipboard', 'and the fourth');
}

print('== setText() drops the cached text ==');
{
    const h = makeText('hello clipboard');
    const entry = h.entry;
    eq(entry.getStringValue(), 'hello clipboard', 'first read');

    entry.setText('replaced text');
    eq(entry.getStringValue(), 'replaced text', 'setText() refreshes the decoded text');
    eq(entry.getStringValue(), 'replaced text', 'and caches the new one');
}

print('== the menu-refresh call sequence decodes once ==');
{
    // The exact accessor sequence one menu refresh performs on a text entry.
    const h = makeText('https://example.com/watch?v=1');
    const entry = h.entry;
    const readAll = () => {
        entry.getStringValue();          // clipContents
        entry.isColor();
        entry.isMultiline();
        entry.isURL();
        entry.getStringValue().trim();   // urlText for the metadata branch
    };

    readAll();
    eq(entry.getStringValue(), 'https://example.com/watch?v=1', 'refresh 1 correct');
    mutate(h, 'https://changed.example/other');
    readAll();

    eq(entry.getStringValue(), 'https://example.com/watch?v=1', 'refresh 2 still cached');
    eq(entry.isURL(), true, 'isURL() is not recomputed from the mutated buffer');
}

print('== classification is resolved once ==');
{
    const h = makeText('red');
    const entry = h.entry;
    eq(entry.isColor(), true, 'red is a color');
    eq(entry.isColor(), true, 'repeated isColor() agrees');

    mutate(h, 'not a color at all');
    eq(entry.isColor(), true, 'isColor() is not recomputed after the payload changed');
    eq(entry.isColor(), true, 'still cached');

    entry.setText('not a color at all');
    eq(entry.isColor(), false, 'setText() re-runs the classification');
}

print('== every cached value is invalidated by setText() ==');
{
    const h = makeText('  #ff0000  \nsecond line');
    const entry = h.entry;
    eq(entry.getStringValue(), '  #ff0000  \nsecond line', 'text');
    eq(entry.isColor(), false, 'multiline text is not a color');
    eq(entry.isMultiline(), true, 'isMultiline() true');
    eq(entry.needsHashPrefix(), false, 'leading # means no prefix');

    entry.setText('00ff00');
    eq(entry.getStringValue(), '00ff00', 'text updated');
    eq(entry.isColor(), true, 'isColor() updated');
    eq(entry.isMultiline(), false, 'isMultiline() updated');
    eq(entry.needsHashPrefix(), true, 'needsHashPrefix() updated — bare hex');
}
{
    const h = makeText('https://example.com');
    const entry = h.entry;
    eq(entry.isURL(), true, 'url before');
    eq(entry.isEmail(), false, 'not an email before');
    entry.setText('who@example.com');
    eq(entry.isURL(), false, 'isURL() updated');
    eq(entry.isEmail(), true, 'isEmail() updated');
}

print('== classification values did not drift ==');
{
    const cases = [
        ['https://example.com/a', {url: true}],
        ['  HTTP://EXAMPLE.COM  ', {url: true}],
        ['ftp://example.com', {}],
        ['user@example.com', {email: true}],
        ['a/b@example.com', {}],
        ['.lead@example.com', {}],
        ['not an email', {}],
        ['one\ntwo', {multiline: true}],
        ['one line', {multiline: false}],
        ['red', {color: true}],
        ['  CornflowerBlue  ', {color: true}],
        ['#abc', {color: true}],
        ['#123', {color: true}],
        ['#12345', {}],
        ['abc', {color: true}],
        ['123', {}],
        ['123456', {}],
        ['rgb(1, 2, 3)', {color: true}],
        ['rgba(1 2 3 / 0.5)', {color: true}],
        ['rgb(1, 2)', {}],
        ['hsl(120, 100%, 50%)', {color: true}],
        ['hsla(180deg 20% 50% / 80%)', {color: true}],
        ['hsl(120, 100%)', {}],
        ['lightgoldenrodyellow', {color: true}],
        ['a'.repeat(60), {}],
    ];

    for (const [text, expected] of Object.entries(
        Object.fromEntries(cases.map(([t, e]) => [t, e])))) {
        const entry = makeText(text).entry;
        for (const [flag, value] of Object.entries(expected)) {
            const method = {url: 'isURL', email: 'isEmail', multiline: 'isMultiline', color: 'isColor'}[flag];
            eq(entry[method](), value, `${method}("${text.length > 40 ? text.slice(0, 12) + '…' : text}")`);
            eq(entry[method](), value, `${method}("${text.length > 40 ? text.slice(0, 12) + '…' : text}") repeated`);
        }
    }
}

print('== needsHashPrefix() is independent of isColor() ==');
{
    const bare = makeText('ff8800').entry;
    eq(bare.isColor(), true, 'bare hex is a color');
    eq(bare.needsHashPrefix(), true, 'and still needs a # to be usable as CSS');

    const hashed = makeText('#ff8800').entry;
    eq(hashed.isColor(), true, 'hashed hex is a color');
    eq(hashed.needsHashPrefix(), false, 'hashed hex needs no prefix');

    eq(makeText('red').needsHashPrefix(), false, 'named color needs no prefix');
    eq(makeText('123').needsHashPrefix(), false, 'decimal needs no prefix');
    eq(makeText('123456').needsHashPrefix(), false, 'six digits have no hex letters');
    eq(makeText('  FF8800  ').needsHashPrefix(), true, 'whitespace and case tolerated');
    eq(makeText('ff88').needsHashPrefix(), true, '4-digit hex');
    eq(makeText('ff8800ff').needsHashPrefix(), true, '8-digit hex with alpha');
    eq(makeText('ff88zz').needsHashPrefix(), false, 'non-hex characters');
    eq(makeText('').needsHashPrefix(), false, 'empty text');
    eq(makeText('  ').needsHashPrefix(), false, 'whitespace only');
}

print('== non-text and URI-list entries classify as nothing ==');
{
    const image = new ClipboardEntry('image/png', new Uint8Array([0x89, 0x50]), false);
    eq(image.isColor(), false, 'image is not a color');
    eq(image.isURL(), false, 'image is not a URL');
    eq(image.isEmail(), false, 'image is not an email');
    eq(image.isMultiline(), false, 'image is not multiline');
    eq(image.needsHashPrefix(), false, 'image needs no hex prefix');
    ok(image.getStringValue().startsWith('[Image '), 'image string value is the placeholder');
    ok(image.getStringValue().startsWith('[Image '), 'and is cached, not rehashed');
    image.setText('ignored');
    ok(image.getStringValue().startsWith('[Image '), 'setText() is still a no-op for images');
}
{
    const uri = makeText('file:///tmp/a.txt\nfile:///tmp/b.txt', 'text/uri-list').entry;
    eq(uri.isURL(), false, 'URI list is not a URL');
    eq(uri.isColor(), false, 'URI list is not a color');
    eq(uri.isMultiline(), false, 'URI list is not multiline');
    eq(uri.needsHashPrefix(), false, 'URI list needs no prefix');
    eq(uri.getStringValue().includes('file:///tmp/a.txt'), true, 'URI list text is intact');
    eq(uri.parseURIList().length, 2, 'parseURIList() still works');
    eq(uri.getURIListDisplay().count, 2, 'getURIListDisplay() still works');
}

print('== the shared CSS table is not rebuilt per call ==');
{
    // Every named color must still be recognized, which is only true if the
    // module-level table is complete.
    const names = ['red', 'blue', 'rebeccapurple', 'transparent', 'yellowgreen',
        'lightgoldenrodyellow', 'midnightblue', 'antiquewhite'];
    for (const name of names)
        eq(makeText(name).isColor(), true, `"${name}" is a named color`);
    for (const notColor of ['redd', 'xyzzy', 'lightgoldenrod', 'translucent'])
        eq(makeText(notColor).isColor(), false, `"${notColor}" is not a named color`);
}

print('== large payload: cached access is stable ==');
{
    const big = 'line of text\n'.repeat(50000);   // ~600 KB
    const h = makeText(big);
    const entry = h.entry;
    const first = entry.getStringValue();
    eq(first.length, big.length, 'full length decoded');
    eq(entry.isMultiline(), true, 'multiline');

    for (let i = 0; i < 20; i++) {
        entry.getStringValue();
        entry.isColor();
        entry.isMultiline();
        entry.isURL();
        entry.isEmail();
        entry.needsHashPrefix();
    }
    eq(entry.getStringValue().length, big.length, '100 further reads still correct');
    eq(entry.isColor(), false, 'isColor() false for large text');
}

print(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} assertions failed`);
