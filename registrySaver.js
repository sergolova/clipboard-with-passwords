// Debounced, single-writer persistence core for the clipboard registry.
//
// Pure JS with no gi:// imports (pattern of random.js / stdoutReader.js): the
// shell-facing pieces — the debounce timer source and the actual file write —
// are injected by the caller, so the coalescing and write-ordering rules can
// be exercised in a plain `gjs -m` process without a running shell.
//
// Why: writing the registry synchronously on every clipboard event stalled the
// shell main loop (filesystem latency becomes UI latency). This core replaces
// "one synchronous write per mutation" with "mutate memory, schedule a save,
// coalesce bursts into one asynchronous write".
//
// Guarantees for any interleaving of schedule() / flush() calls:
//   - a burst of schedule() calls inside one debounce window collapses into a
//     single write;
//   - at most one write is ever in flight (the file has exactly one writer, so
//     two writes can never race each other);
//   - a schedule() arriving while a write is in flight queues exactly one
//     follow-up write carrying the LATEST snapshot — an older, slower write can
//     never land on disk after a newer state (no stale overwrite);
//   - flush() cancels a pending debounce and starts the (single) write right
//     away (explicit clear / shutdown path); while a write is in flight it
//     only re-queues the fresh snapshot, never starts a second writer.
//
// The injected `write` callback receives the latest snapshot and must resolve
// (never reject — the caller logs its own failures) once the data is on disk;
// the saver funnels every save through that single promise.
export class DebouncedSaver {
    constructor({debounceMs, scheduleTimer, cancelTimer, write}) {
        this._debounceMs = debounceMs;
        this._scheduleTimer = scheduleTimer;  // (ms, callback) => source id
        this._cancelTimer = cancelTimer;      // source id => void
        this._write = write;                  // snapshot => Promise
        this._latest = undefined;
        this._dirty = false;
        this._debounceSource = null;
        this._writeInFlight = false;
        this._writeAgainQueued = false;
    }

    // Ask for `snapshot` to be persisted. Returns immediately; the data hits
    // the disk after the debounce window (or right after the write currently
    // in flight completes).
    schedule(snapshot) {
        this._latest = snapshot;
        this._dirty = true;

        if (this._writeInFlight) {
            // The running write owns the file and re-reads `_latest` when it
            // completes, so this fresh snapshot needs no separate timer.
            this._writeAgainQueued = true;
            return;
        }

        if (this._debounceSource === null) {
            this._debounceSource = this._scheduleTimer(this._debounceMs, () => {
                this._debounceSource = null;
                this._startWrite();
                return false; // one-shot; the injected timer decides the meaning
            });
        }
    }

    // Persist the latest snapshot without waiting for the debounce. Safe to
    // call at any moment: a pending debounce is cancelled, and an in-flight
    // write is left alone (its queued follow-up already carries the latest
    // state).
    flush() {
        if (this._debounceSource !== null) {
            this._cancelTimer(this._debounceSource);
            this._debounceSource = null;
        }
        if (!this._writeInFlight)
            this._startWrite();
    }

    _startWrite() {
        if (!this._dirty)
            return;
        if (this._writeInFlight) {
            this._writeAgainQueued = true;
            return;
        }

        this._dirty = false;
        this._writeInFlight = true;
        const snapshot = this._latest;

        const done = () => {
            this._writeInFlight = false;
            if (this._writeAgainQueued) {
                this._writeAgainQueued = false;
                this._startWrite();
            }
        };
        Promise.resolve(this._write(snapshot)).then(done, done);
    }
}