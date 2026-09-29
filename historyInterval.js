// Formatting the countdown to the next automatic history clear.
//
// Pure arithmetic, and it was in the middle of a timer callback where nothing
// could ask it a question. Two things make it worth its own file: the rounding at
// each unit boundary is where a countdown is normally wrong ("1h 0m 0s" for an
// hour that has not passed, or "59s" that should read "1m"), and the suffixes are
// user-visible text.
//
// On those suffixes: they are hardcoded, so this label is not translated, and a
// Russian user sees "2h 14m 3s" in a menu where everything else is in Russian.
// That is a real defect and the fix is one translated format string, but it
// changes what users see, so it is not folded into a refactor: the behaviour
// below is pinned by the tests exactly as it is today, and the localisation is a
// separate, deliberate change.
//
// No gi:// imports, so it is testable with a plain `gjs`.

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/**
 * Format a remaining time as a compact countdown: "2h 14m 3s".
 *
 * Hours and minutes are dropped when they read zero; the seconds always show.
 * So an hour is "1h 0s" and not "1h 0m 0s" — the leading zero slot is noise — but
 * the trailing seconds are the part that ticks, and a countdown that showed no
 * seconds would look stuck.
 *
 * A time of zero or less formats as the empty string, which is what the label
 * shows when the clear time has passed.
 *
 * @param {number} seconds time remaining
 * @returns {string}
 */
export function formatCountdown(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return '';

    const total = Math.floor(seconds);
    const hours = Math.floor(total / SECONDS_PER_HOUR);
    const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const secs = total % SECONDS_PER_MINUTE;

    let out = '';
    if (hours > 0)
        out += `${hours}h `;
    if (minutes > 0)
        out += `${minutes}m `;
    out += `${secs}s`;
    return out;
}
