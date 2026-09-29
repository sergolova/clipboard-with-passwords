// Clipboard mimetype negotiation.
//
// The extension needs the clipboard's content, but it cannot know in advance
// which mimetype the current owner will answer with. Asking blind — one
// request per supported mimetype until something comes back — is expensive and
// unsafe: a request for a type the owner never offered starts a selection
// transfer that the owner cannot answer. On X11 those abandoned transfers pile
// up during a burst of copies until mutter's teardown of them crashed the shell
// (signal 11).
//
// So the capture path asks the owner what it offers first, maps the answer onto
// the types the extension understands, and requests only those — normally a
// single selection transfer per capture.
//
// An owner that offers nothing we understand gets no request at all rather than
// a walk of the types it did not offer; the one case that still falls back to a
// blind walk is an owner that advertised nothing, which is the X11 quirk the
// fallback exists for. See offeredTypeCandidates().
//
// Pure JS on purpose (no gi:// imports) so it can be unit-tested outside the
// shell.

/**
 * How long to wait for one clipboard request before giving up on that type.
 *
 * One deadline for everything was a compromise between two failures, and it
 * lost to the larger one. 200 ms is right for a text request: the types that go
 * unanswered are the dead-end ones, and waiting them out is pure loss. But a
 * request for an image is not answered by a buffer the owner already has — the
 * owner may still have to BUILD it. Measured on a real Qt image editor offering
 * a 1928x2560 selection:
 *
 *     image/png   5 123 880 B   1273 ms
 *     image/jpeg    477 374 B     32 ms
 *
 * So the same selection is 1.3 s in PNG and 32 ms in JPEG, and a single 200 ms
 * budget cannot serve both. It also cannot simply be given to everything: that
 * would put the multi-second text dead end straight back.
 *
 * The image budget is about four times the worst case measured, which leaves room
 * for a large screenshot without turning the wait into a stall — and it is
 * bounded by CHAIN_BUDGET_MS regardless, so an owner that never answers cannot
 * hang the menu by being offered six image types.
 */
export const TEXT_REQUEST_TIMEOUT_MS = 200;
export const IMAGE_REQUEST_TIMEOUT_MS = 5000;

/**
 * Ceiling on one whole capture chain, across every candidate it tries.
 *
 * The per-request budget is what a single transfer may take; this is what the
 * entire capture may take. They are separate because the per-request number
 * cannot be lowered to bound the chain (a large image needs it) and the chain
 * cannot be raised to suit one type. A capture that overruns returns nothing
 * rather than holding the clipboard hostage.
 */
export const CHAIN_BUDGET_MS = 10000;

/**
 * The deadline for one request, given the entry type it will produce.
 *
 * Keyed on the entry type rather than on the owner's spelling of the request,
 * because that is the extension's own normalized value — an owner's odd casing
 * of `IMAGE/PNG` cannot slip past a string comparison on the request.
 *
 * @param {?string} entryType the type the entry would be stored as
 * @returns {number} milliseconds
 */
export function requestTimeoutMs(entryType) {
    return typeof entryType === 'string' && entryType.startsWith('image/')
        ? IMAGE_REQUEST_TIMEOUT_MS
        : TEXT_REQUEST_TIMEOUT_MS;
}

/**
 * Clipboard MIME → short extension label shown next to the image size in the
 * menu (e.g. "1920 × 1080 · jpg"). Display-only: cache files keep their
 * content-hash names without an extension.
 */
const IMAGE_FORMAT_LABELS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
};

/**
 * The short label for an image mimetype.
 *
 * The table covers what is actually met, and the fallback covers the rest by
 * naming the subtype — so an `image/avif` still reads as "avif" rather than
 * printing the whole mimetype next to the dimensions. The `+xml` removal is for
 * `image/svg+xml`, which would otherwise label itself "svg+xml".
 *
 * @param {?string} mimetype
 * @returns {?string}
 */
export function imageFormatLabel(mimetype) {
    if (IMAGE_FORMAT_LABELS[mimetype])
        return IMAGE_FORMAT_LABELS[mimetype];
    if (mimetype && mimetype.startsWith('image/'))
        return mimetype.slice('image/'.length).replace('+xml', '');
    return mimetype;
}

/**
 * Equivalent spellings of one logical type, in the order the extension prefers
 * them. Only the spelling the owner actually advertises is requested.
 */
export const OFFERED_TYPE_GROUPS = [
    ['text/uri-list'],
    ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT', 'COMPOUND_TEXT'],
    ['image/gif'],
    ['image/png'],
    ['image/jpeg', 'image/jpg'],
    ['image/webp'],
    ['image/svg+xml'],
    ['text/html'],
];

/**
 * Fallback probe for owners that advertise NOTHING: some X11 selection sources
 * answer a TARGETS request with an empty list, and for those the blind walk is
 * the only way to be captured at all.
 *
 * It is deliberately not used for an owner that advertised something we could
 * not use — see offeredTypeCandidates().
 */
export const BLIND_MIMETYPE_CHAIN = [
    'text/uri-list',
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/gif',
    'image/png',
    'image/jpg',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'text/html',
];

/**
 * The legacy X11 spellings are not useful as a stored mimetype — a later paste
 * wants a real media type, and the historical chain already normalised
 * UTF8_STRING to text/plain;charset=utf-8. Everything else keeps the owner's
 * own spelling, so image/gif stays image/gif and so on.
 */
export function entryTypeForOffered(offeredType) {
    const upper = offeredType.toUpperCase();
    if (upper === 'UTF8_STRING' || upper === 'COMPOUND_TEXT')
        return 'text/plain;charset=utf-8';
    if (upper === 'STRING' || upper === 'TEXT')
        return 'text/plain';
    return offeredType;
}

/**
 * Turns the owner's advertised mimetypes into the ordered list of requests a
 * capture will make. `request` is what gets asked of the clipboard,
 * `entryType` is what the resulting entry is stored as.
 *
 * An empty list means "make no request at all", and that is a deliberate answer
 * rather than a missing one. When the owner advertised types and none of them is
 * one the extension understands, it has already told us what it holds: the walk
 * of unoffered types cannot produce a better answer, and it is exactly the
 * abandoned-transfer pattern that used to take the shell down under an X11 image
 * burst. It also costs real time — an unanswered request waits out its full
 * timeout, so the twelve of the chain were measured at about 2.4 seconds of
 * silence before the capture gave up. Giving up at once leaves the same visible
 * result (nothing captured) without the stall and without the risky requests.
 *
 * The blind chain is still the answer when the owner advertised nothing at all,
 * which is the quirk it exists for. A `get_mimetypes()` that throws or answers
 * non-array reaches that path too, because the caller passes an empty list.
 *
 * @param {string[]} offered mimetypes as reported by the clipboard owner
 * @returns {{request: string, entryType: string}[]}
 */
export function offeredTypeCandidates(offered) {
    const advertised = Array.isArray(offered) ? offered : [];
    const candidates = [];

    for (const spellings of OFFERED_TYPE_GROUPS) {
        // Match case-insensitively (owners are inconsistent about legacy
        // spellings) but request the OWNER's exact string: X11 mimetype
        // matching is case-sensitive, so it is the one it advertised.
        const match = spellings.find(candidate =>
            advertised.some(offeredType => offeredType.toLowerCase() === candidate.toLowerCase()));
        const offeredType = advertised.find(o => o.toLowerCase() === match?.toLowerCase());
        if (offeredType)
            candidates.push({request: offeredType, entryType: entryTypeForOffered(offeredType)});
    }

    if (candidates.length > 0)
        return candidates;

    if (advertised.length > 0)
        return [];

    return BLIND_MIMETYPE_CHAIN.map(type => ({request: type, entryType: entryTypeForOffered(type)}));
}

// A rendering of the copied content as text: it can stand in for a file list or
// for an image only by losing what those carried.
const TEXT_RENDERINGS = new Set(['text/plain', 'text/plain;charset=utf-8', 'text/html']);

/**
 * Moves the request that last produced a capture to the front of `candidates`.
 *
 * A capture walks the candidates in order and stops at the first one the owner
 * answers, and an unanswered request costs up to the full 200 ms timeout — so
 * every candidate in front of the right one is paid for in latency. The type
 * that just worked is the best available guess at the right one for the next
 * capture too: it is reached in one transfer instead of one per skipped
 * candidate. Any other candidate is pushed at most one position further back,
 * so the cost of guessing wrong is a single failed request, never a whole
 * re-walk.
 *
 * A promotion is refused only when it would change *what* gets stored rather
 * than only when it arrives, and the only rendering that loses anything is a
 * text one: a GTK application answers a file copy with the URI list as plain
 * text too, and answers an image with its path or a data URI. So a text
 * rendering is never moved in front of `text/uri-list` or of an image type —
 * otherwise a file list or a picture copied right after a text copy would land
 * as text.
 *
 * Everything else is a pure latency win, and the case that matters in practice
 * is an image type moving in front of plain text: an image viewer that offers
 * both otherwise pays a failed text request, and its full timeout, on every
 * copy. An image type may also pass `text/uri-list`, because an owner that
 * answers with image data has an image even if the last thing copied was text.
 *
 * @param {{request: string, entryType: string}[]} candidates as produced by
 *   offeredTypeCandidates()
 * @param {?string} lastSuccessful the `request` of the last successful capture
 * @returns {{request: string, entryType: string}[]} a new list, or `candidates`
 *   itself when there is nothing to move
 */
export function preferLastSuccessful(candidates, lastSuccessful) {
    if (!lastSuccessful || !Array.isArray(candidates))
        return candidates;

    const index = candidates.findIndex(c => c.request === lastSuccessful);
    if (index <= 0)
        return candidates;

    const preferred = candidates[index];
    const isText = TEXT_RENDERINGS.has(preferred.entryType);
    if (!isText)
        return moveToFront(candidates, index);
    if (candidates.slice(0, index).some(c =>
            c.entryType === 'text/uri-list' || c.entryType.startsWith('image/')))
        return candidates;

    return moveToFront(candidates, index);
}

function moveToFront(candidates, index) {
    return [
        candidates[index],
        ...candidates.slice(0, index),
        ...candidates.slice(index + 1),
    ];
}
