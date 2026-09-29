// How big a clipboard entry is allowed to be before it is refused.
//
// The registry is one JSON file, and it is read back in full at every start. The
// user controls its ceiling with the «Cache file size» setting (default 5 MB),
// and the read path treats going over that ceiling as a reason to move the file
// aside and start from an empty history — a safety valve against an unbounded
// file, but one that costs the user everything if a single entry can cross it.
//
// A 120 000-line text file is 8.1 MB. As one registry record it is 8.2 MB. That
// is over the default ceiling on its own, so capturing it left behind a registry
// that the very next shell start wiped — 65 records and 25 cached images gone,
// with nothing but an unnoticed `registry.txt~` to show for it.
//
// So the ceiling is enforced where it can be honoured, which is before the entry
// ever reaches the array: the capture is refused, and the user is told, instead
// of being allowed to fill the registry and find out at the next login.
//
// What is deliberately NOT here: any decision about what to do with a registry
// that is already over the ceiling. That belongs to the read path, which is the
// only place that knows the history it is about to lose. This module only
// answers "may this one entry be added, and if not, by how much does it not fit".
//
// Pure arithmetic on numbers — no gi:// imports, no file access — so the policy
// is testable on its own. The measurements (how big is the file, how big is this
// record) happen in registry.js, which knows both.

const MIB = 1024 * 1024;

/**
 * The ceiling in bytes, from the setting's megabytes.
 *
 * Clamped at one megabyte: the schema already bounds the setting to 1..1024, but
 * a zero or a negative would make `fits` answer false for everything, and a
 * ceiling of "nothing at all" is not a state the policy should be able to reach.
 *
 * @param {number} cacheSizeMb the «Cache file size» setting
 * @returns {number} bytes
 */
export function budgetBytesFrom(cacheSizeMb) {
    const mb = Number.isFinite(cacheSizeMb) ? Math.round(cacheSizeMb) : 0;
    return Math.max(1, mb) * MIB;
}

/**
 * Whether one more record fits, and by how much it does not.
 *
 * The test is on the PROJECTED total, not on the record alone. Testing the record
 * alone would let the registry creep over the ceiling through several medium
 * entries, and the wipe is caused by the total — so the total is what decides.
 *
 * @param {object} plan
 * @param {number} plan.currentBytes size of the registry as it stands
 * @param {number} plan.recordBytes  serialized size of the entry being added
 * @param {number} plan.capBytes     ceiling, from budgetBytesFrom()
 * @returns {{fits: boolean, currentBytes: number, recordBytes: number,
 *            capBytes: number, projectedBytes: number, shortfallBytes: number}}
 */
export function planAddition({currentBytes, recordBytes, capBytes}) {
    const current = Number.isFinite(currentBytes) ? currentBytes : 0;
    const record = Number.isFinite(recordBytes) ? Math.max(0, recordBytes) : 0;
    const cap = Number.isFinite(capBytes) ? capBytes : 0;
    const projected = current + record;
    return {
        fits: projected <= cap,
        currentBytes: current,
        recordBytes: record,
        capBytes: cap,
        projectedBytes: projected,
        shortfallBytes: Math.max(0, projected - cap),
    };
}

/**
 * A megabyte count for a human, with one decimal below 10 MB and none above.
 *
 * For the notification only. "8.2 MB" and "1.4 GB" both read better than
 * "8.23 MB" and "1436.2 MB", and neither is a number anyone will act on
 * differently from the other.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '?';
    const mb = bytes / MIB;
    if (mb >= 1024)
        return `${(mb / 1024).toFixed(1)} GB`;
    if (mb >= 10)
        return `${Math.round(mb)} MB`;
    return `${mb.toFixed(1)} MB`;
}
