// Gated logging (EGO-A-004: no excessive ungated console output in the bundle).
// Set DEBUG_LOGGING to true while debugging (`journalctl`) — release bundles
// ship with logging off to keep the journal quiet.
export const DEBUG_LOGGING = false;

export function logError(...args) {
    if (DEBUG_LOGGING)
        console.error(...args);
}

export function logWarn(...args) {
    if (DEBUG_LOGGING)
        console.warn(...args);
}