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
// Pure JS on purpose (no gi:// imports) so it can be unit-tested outside the
// shell.

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
 * Fallback probe for owners that advertise nothing: some X11 selection sources
 * answer a TARGETS request with an empty list, and those still need the blind
 * walk to be captured at all.
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

    if (candidates.length === 0)
        return BLIND_MIMETYPE_CHAIN.map(type => ({request: type, entryType: entryTypeForOffered(type)}));

    return candidates;
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
