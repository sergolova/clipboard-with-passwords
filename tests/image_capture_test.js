// Test harness for the image capture path — the deadline policy, and what a
// multi-megabyte payload has to survive.
//
// The bug these exist for: a single 200 ms deadline for every clipboard request
// could not serve both regimes it was applied to. Measured on a real Qt image
// editor offering one 1928x2560 selection:
//
//     image/png    5 123 880 B   1273 ms
//     image/jpeg     477 374 B     32 ms
//
// The same picture is 1.3 s in PNG and 32 ms in JPEG. Under one deadline, PNG
// always lost — and because image/png is requested BEFORE image/jpeg, the
// capture gave up on it, abandoned the transfer mid-flight, and the JPEG request
// queued behind the unfinished PNG conversion and lost too. Nothing was
// captured, at any size above a few hundred kilobytes, while small selections
// went in fine. The numbers above are in the tests as constants on purpose: a
// deadline that regressed below the measured transfer would pass a test written
// against its own current value, and fail one written against reality.
//
// Everything here runs in a plain gjs — no shell, no clipboard. The policy is
// pure, and the payload properties are the ones a size-dependent bug would
// break.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   GSETTINGS_SCHEMA_DIR=schemas gjs -m tools/local/image_capture_test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ClipboardEntry} from '../registry.js';
import {
    CHAIN_BUDGET_MS,
    IMAGE_REQUEST_TIMEOUT_MS,
    offeredTypeCandidates,
    preferLastSuccessful,
    requestTimeoutMs,
    TEXT_REQUEST_TIMEOUT_MS,
} from '../clipboardTypes.js';

// Measured on the user's own clipboard, from a Qt image editor's 1928x2560
// selection. The PNG is what the extension asks for first; the JPEG is the same
// picture in a cheaper encoding.
const MEASURED_PNG_MS = 1273;
const MEASURED_PNG_BYTES = 5123880;
const MEASURED_JPEG_MS = 32;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const us = ms => ms * 1000;

console.log('1. the deadline must be decided by the type being requested');
check('a text request keeps the short deadline',
    requestTimeoutMs('text/plain;charset=utf-8') === TEXT_REQUEST_TIMEOUT_MS,
    String(requestTimeoutMs('text/plain;charset=utf-8')));
check('and so does a file list',
    requestTimeoutMs('text/uri-list') === TEXT_REQUEST_TIMEOUT_MS);
check('and HTML', requestTimeoutMs('text/html') === TEXT_REQUEST_TIMEOUT_MS);
check('an image request gets the long one',
    requestTimeoutMs('image/png') === IMAGE_REQUEST_TIMEOUT_MS,
    String(requestTimeoutMs('image/png')));
for (const t of ['image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
    'image/svg+xml', 'image/png']) {
    check(`${t} gets the image deadline`, requestTimeoutMs(t) === IMAGE_REQUEST_TIMEOUT_MS);
}

console.log('\n2. the deadline must clear the transfer it was measured against');
// THE regression check. If this fails, a large image is dropped again — and it
// fails the same way every time, for the same user, on the same picture.
check(`image deadline (${IMAGE_REQUEST_TIMEOUT_MS} ms) clears the measured PNG (${MEASURED_PNG_MS} ms)`,
    IMAGE_REQUEST_TIMEOUT_MS > MEASURED_PNG_MS,
    `${IMAGE_REQUEST_TIMEOUT_MS} <= ${MEASURED_PNG_MS}`);
check('with real headroom, not by a hair',
    IMAGE_REQUEST_TIMEOUT_MS >= MEASURED_PNG_MS * 2,
    `${IMAGE_REQUEST_TIMEOUT_MS} ms for a ${MEASURED_PNG_MS} ms transfer`);
check('and it is still a deadline, not an open-ended wait',
    IMAGE_REQUEST_TIMEOUT_MS < 30000, String(IMAGE_REQUEST_TIMEOUT_MS));
check('the text deadline did not grow (the 2.4 s dead end must stay dead)',
    TEXT_REQUEST_TIMEOUT_MS === 200, String(TEXT_REQUEST_TIMEOUT_MS));

console.log('\n3. a missing or nonsense entry type falls back to the short deadline');
for (const t of [null, undefined, '', 'image', 'notatype', 42, {}])
    check(`${JSON.stringify(t) ?? 'undefined'} → text deadline`,
        requestTimeoutMs(t) === TEXT_REQUEST_TIMEOUT_MS, String(requestTimeoutMs(t)));

console.log('\n4. the whole chain is still bounded');
// Six slow image types at the per-request budget would be 30 s of held
// clipboard. The chain ceiling is what stops that, and it has to sit ABOVE one
// image budget (or a single legitimate image could never be waited for) and
// BELOW the sum of several (or the ceiling means nothing).
check('the chain budget outlasts a single image request',
    CHAIN_BUDGET_MS > IMAGE_REQUEST_TIMEOUT_MS,
    `${CHAIN_BUDGET_MS} vs ${IMAGE_REQUEST_TIMEOUT_MS}`);
check('and it is far below six image budgets',
    CHAIN_BUDGET_MS < IMAGE_REQUEST_TIMEOUT_MS * 6,
    `${CHAIN_BUDGET_MS} vs ${IMAGE_REQUEST_TIMEOUT_MS * 6}`);
check('and it is not so long that a stuck owner is tolerable',
    CHAIN_BUDGET_MS <= 15000, String(CHAIN_BUDGET_MS));

// The ceiling is enforced by capping each request with what is left, so a chain
// that has already spent its budget must not start another one. Reimplemented
// here exactly as extension.js does it, because that arithmetic is the policy.
function budgetFor(entryType, spentMs) {
    const remaining = CHAIN_BUDGET_MS - spentMs;
    return Math.min(requestTimeoutMs(entryType), Math.max(0, remaining));
}
check('a fresh image request gets its full budget',
    budgetFor('image/png', 0) === IMAGE_REQUEST_TIMEOUT_MS);
check('a request late in the chain is trimmed to what is left',
    budgetFor('image/png', IMAGE_REQUEST_TIMEOUT_MS + 1000) === CHAIN_BUDGET_MS - IMAGE_REQUEST_TIMEOUT_MS - 1000,
    String(budgetFor('image/png', IMAGE_REQUEST_TIMEOUT_MS + 1000)));
check('a request after the budget is spent gets nothing',
    budgetFor('image/png', CHAIN_BUDGET_MS) === 0,
    String(budgetFor('image/png', CHAIN_BUDGET_MS)));
check('a text request is never trimmed UP to a bigger budget',
    budgetFor('text/plain', 0) === TEXT_REQUEST_TIMEOUT_MS);

console.log('\n5. the owner that started this must still be negotiable');
// The diagnosis was a specific TARGETS list, so the negotiation is pinned
// against it: PNG preferred over JPEG, and the Qt-only types ignored.
const KOLOURPAINT_TARGETS = [
    'application/x-kolourpaint-selection-400', 'application/x-qt-image',
    'image/png', 'image/bmp', 'image/cur', 'image/ico', 'image/jpeg',
    'image/jpg', 'image/pbm', 'BITMAP', 'image/pgm', 'image/ppm', 'PIXMAP',
    'image/xbm', 'image/xpm', 'TARGETS', 'MULTIPLE', 'TIMESTAMP',
    'SAVE_TARGETS',
];
const candidates = offeredTypeCandidates(KOLOURPAINT_TARGETS);
const requests = candidates.map(c => c.request);
check('PNG is requested before JPEG — that is why the budget mattered',
    requests.indexOf('image/png') < requests.indexOf('image/jpeg'),
    JSON.stringify(requests));
check('the Qt-only types are not requested',
    !requests.includes('application/x-qt-image') &&
        !requests.includes('application/x-kolourpaint-selection-400'),
    JSON.stringify(requests));
check('so the first candidate is the one that takes 1273 ms',
    requests[0] === 'image/png', String(requests[0]));
check('and its deadline is the one that covers it',
    requestTimeoutMs(candidates[0].entryType) > MEASURED_PNG_MS,
    `${requestTimeoutMs(candidates[0].entryType)} vs ${MEASURED_PNG_MS}`);

// Promotion: after a big PNG succeeds once, the next copy from the same kind of
// owner asks for PNG first again, so the 1.3 s is paid once and not every time.
const promoted = preferLastSuccessful(candidates, 'image/png');
check('a successful PNG stays first on the next capture',
    promoted[0].request === 'image/png', JSON.stringify(promoted.map(c => c.request)));
check('and the cheap JPEG is still reachable behind it',
    promoted.some(c => c.request === 'image/jpeg'),
    JSON.stringify(promoted.map(c => c.request)));

console.log('\n6. a multi-megabyte payload survives the entry');
// The other half of "add image tests for the future": a size-dependent bug in
// hashing, deduping or the payload file would show up here and nowhere else.
const big = n => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 7)) & 0xff;
    return b;
};
const MEASURED_SIZE = MEASURED_PNG_BYTES;
const payload = big(MEASURED_SIZE);
const entry = new ClipboardEntry('image/png', payload, false);

check('a multi-MB image is an image', entry.isImage() === true);
check('its value is the [Image <hash>] placeholder',
    entry.getStringValue().startsWith('[Image '), entry.getStringValue().slice(0, 20));
check('and the placeholder carries a hash, not the bytes',
    entry.getStringValue().length < 40, `len ${entry.getStringValue().length}`);

const hash1 = entry.getStringValue();
// The cost is measured on a FRESH entry: the one above has already paid for its
// hash, so timing it again would measure a cache hit and report 0 ms — which
// looks like a fast hash and proves nothing.
const fresh = new ClipboardEntry('image/png', big(MEASURED_SIZE), false);
const t0 = GLib.get_monotonic_time();
fresh.getStringValue();
const hashMs = (GLib.get_monotonic_time() - t0) / 1000;
check(`hashing ${(MEASURED_SIZE / 1048576).toFixed(1)} MB is cheap (${hashMs.toFixed(0)} ms)`,
    hashMs < 100, `${hashMs.toFixed(1)} ms`);
// And the caching that keeps the menu cheap on a long history.
const t1 = GLib.get_monotonic_time();
entry.getStringValue();
const cachedMs = (GLib.get_monotonic_time() - t1) / 1000;
check(`a cached lookup is a cache hit (${cachedMs.toFixed(2)} ms)`,
    cachedMs < 1, `${cachedMs.toFixed(2)} ms — getStringValue() re-hashed the payload`);

const same = new ClipboardEntry('image/png', big(MEASURED_SIZE), false);
check('an identical multi-MB image hashes the same (dedupe works)',
    same.getStringValue() === hash1);

// A change in the LAST byte is the case a prefix-sampling or truncated hash
// would miss, and it is exactly what two similar photographs differ by.
const tailOnly = big(MEASURED_SIZE);
tailOnly[MEASURED_SIZE - 1] = (tailOnly[MEASURED_SIZE - 1] + 1) & 0xff;
const tailEntry = new ClipboardEntry('image/png', tailOnly, false);
check('a difference in the LAST byte changes the hash',
    tailEntry.getStringValue() !== hash1,
    'a prefix-only hash would make these look like the same image');
check('so the duplicate check would NOT drop it',
    tailEntry.getStringValue() !== same.getStringValue());

console.log('\n7. a multi-MB payload round-trips through the registry');
const dir = GLib.dir_make_tmp('cwp-bigimg-XXXXXX');
// Written by hand rather than through the registry, so the test owns the file
// and the record and can check the round-trip's own inputs. asBytesAsync() hands
// back a GLib.Bytes, whose get_data() is the raw array file_set_contents wants.
const payloadFile = `${dir}/${hash1.slice(7, -1)}`;
const raw = (await entry.asBytesAsync()).get_data();
GLib.file_set_contents(payloadFile, raw);
const record = {mimetype: 'image/png', contents: payloadFile, favorite: false};
const restored = await ClipboardEntry.fromJSON(record);
check('a multi-MB image is restored', restored !== null);
check('as an image', restored?.isImage() === true);
check('with a complete payload on disk',
    (() => {
        const info = Gio.file_new_for_path(record.contents).query_info('*', null, null);
        return info.get_size() === MEASURED_SIZE;
    })(), 'payload file size differs');
check('and the same hash, so the history does not fork',
    restored?.getStringValue() === hash1,
    `${restored?.getStringValue()} vs ${hash1}`);
GLib.unlink(payloadFile);
GLib.rmdir(dir);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} image-capture check(s) failed`);
