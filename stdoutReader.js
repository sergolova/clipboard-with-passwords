import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { logWarn } from './logging.js';

// Bounded streaming reader for the 7-Zip subprocesses that produce the vault
// archive / its decrypted payload. This is a pure core — NO shell-resource
// imports (no `resource://...`, no gettext), only gi://Gio/GLib + logging,
// so the module can be imported and tested in a plain `gjs -m` process
// (pattern of random.js). All user-facing strings live in passwordVault.js;
// this module reports failures via `err.code`:
//
//   'timeout'    — the process did not finish within timeoutMs (killed)
//   'too-large'  — stdout exceeded maxBytes (killed mid-stream)
//   'read-error' — the stdout/stderr pipe failed for another reason (killed)
//
// Rationale (P1.2): `Gio.Subprocess.communicate_utf8_async` buffers the ENTIRE
// stdout before its callback runs, so a crafted or corrupt vault could make
// the shell allocate unbounded memory and only fail the MAX_VAULT_JSON_BYTES
// check after the fact. Streaming the pipe in bounded chunks caps the
// allocation mid-stream: the process is force-killed the moment the limit is
// crossed, before the buffer can grow further. The same wrapper also arms a
// hard timeout (P1.3) so a hung 7-Zip can never block the unlock / save flow
// forever.

const STREAM_CHUNK_BYTES = 64 * 1024; // per read_bytes_async call
const STDERR_CAP_BYTES = 64 * 1024;   // stderr is diagnostics-only; never buffer more

// Read `proc`'s stdout in bounded chunks, write `input` (a string, usually the
// master password + '\n') to its stdin first, and wait for the process to
// finish. Resolves with `{ exitStatus, data, stderr }` where `data` is a
// Uint8Array with the full (or capped-at-limit) stdout and `stderr` is the
// decoded stderr prefix (capped). Rejects with an Error carrying `.code` on
// timeout / overflow / pipe failure — in those cases the process is
// force-killed first.
//
//   proc:      a Gio.Subprocess created with STDIN_PIPE|STDOUT_PIPE|STDERR_PIPE
//              and already initialized (not yet communicated with).
//   maxBytes:  hard ceiling on stdout bytes; exceeding it kills the process.
//   timeoutMs: hard ceiling on total runtime; elapsing it kills the process.
//   input:     optional string written to stdin (then stdin is closed).
export function streamStdoutWithLimit(proc, {maxBytes = Infinity, timeoutMs = 0, input = null} = {}) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0)
        return Promise.reject(Object.assign(new Error('invalid maxBytes'), {code: 'read-error'}));

    // Write stdin and close it BEFORE reading: 7-Zip reads the password from
    // stdin, so it cannot produce output until it has it. Mirrors what
    // communicate_utf8_async does internally (write input, then close stdin).
    const stdinPromise = new Promise((resolve) => {
        const stdin = proc.get_stdin_pipe();
        if (!stdin) {
            resolve();
            return;
        }
        const finish = (ok) => {
            try { stdin.close(null); } catch (e) { }
            resolve(ok);
        };
        if (input === null) {
            // Nothing to write — still close stdin so a child reading until
            // EOF is not left waiting forever.
            finish(true);
            return;
        }
        stdin.write_all_async(new TextEncoder().encode(input), GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                s.write_all_finish(res);
                finish(true);
            } catch (e) {
                // Child exited before reading stdin (e.g. instant failure) —
                // the read/wait loop below will surface the real error.
                finish(false);
            }
        });
    });

    return stdinPromise.then(() => new Promise((resolve, reject) => {
        const stdoutPipe = proc.get_stdout_pipe();
        const stderrPipe = proc.get_stderr_pipe();

        let done = false;          // settled once
        let stdoutChunks = [];
        let stdoutBytes = 0;
        let stderrChunks = [];
        let stderrBytes = 0;
        let stderrTruncated = false;
        let stdoutReading = false;
        let stderrReading = false;
        let timerId = null;

        const cleanup = () => {
            if (timerId !== null) {
                GLib.source_remove(timerId);
                timerId = null;
            }
        };

        const fail = (code) => {
            if (done)
                return;
            done = true;
            cleanup();
            try { proc.force_exit(); } catch (e) { }
            reject(Object.assign(new Error(code), {code}));
        };

        const maybeDone = () => {
            // Resolve only when the process has exited AND both pipes hit
            // EOF: after the child dies its fds close, so EOF follows
            // immediately — this guarantees we have the FULL stdout and that
            // stderr diagnostics are complete before the caller acts.
            if (done || exitStatus === null || !stdoutEof || !stderrEof)
                return;
            done = true;
            cleanup();
            const data = concatChunks(stdoutChunks, stdoutBytes);
            let stderr = '';
            if (stderrBytes > 0) {
                try {
                    stderr = new TextDecoder().decode(concatChunks(stderrChunks, stderrBytes));
                } catch (e) {
                    stderr = '';
                }
            }
            if (stderrTruncated)
                stderr += '\n[stderr truncated]';
            resolve({exitStatus, data, stderr});
        };

        let exitStatus = null;
        let stdoutEof = false;
        let stderrEof = false;

        // ---- stdout pump ---------------------------------------------------
        const pumpStdout = () => {
            if (done || stdoutReading || !stdoutPipe)
                return;
            stdoutReading = true;
            stdoutPipe.read_bytes_async(STREAM_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                stdoutReading = false;
                if (done)
                    return;
                let bytes;
                try {
                    bytes = s.read_bytes_finish(res);
                } catch (e) {
                    fail('read-error');
                    return;
                }
                const data = bytes.get_data();
                if (!data || data.length === 0) {
                    stdoutEof = true;
                    maybeDone();
                    return;
                }
                stdoutBytes += data.length;
                if (stdoutBytes > maxBytes) {
                    fail('too-large');
                    return;
                }
                stdoutChunks.push(data);
                pumpStdout();
            });
        };

        // ---- stderr pump (diagnostics only, capped) -------------------------
        const pumpStderr = () => {
            if (done || stderrReading || !stderrPipe)
                return;
            stderrReading = true;
            stderrPipe.read_bytes_async(STREAM_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                stderrReading = false;
                if (done)
                    return;
                let bytes;
                try {
                    bytes = s.read_bytes_finish(res);
                } catch (e) {
                    fail('read-error');
                    return;
                }
                const data = bytes.get_data();
                if (!data || data.length === 0) {
                    stderrEof = true;
                    maybeDone();
                    return;
                }
                // Keep draining even past the cap (so the child can never
                // deadlock on a full stderr pipe) but only RETAIN the head.
                const room = STDERR_CAP_BYTES - stderrBytes;
                if (room > 0) {
                    stderrChunks.push(data.subarray(0, Math.min(data.length, room)));
                    stderrBytes += Math.min(data.length, room);
                    if (room < data.length)
                        stderrTruncated = true;
                } else {
                    stderrTruncated = true;
                }
                pumpStderr();
            });
        };

        // ---- process exit ---------------------------------------------------
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch (e) {
                // wait failed (rare) — treat like a read failure but still
                // deliver whatever we already have.
                fail('read-error');
                return;
            }
            if (done)
                return;
            // Only read the exit status for an exited (not killed) child;
            // calling get_exit_status() on a force-killed one would trip a
            // GLib critical. On a killed child exitStatus stays null and
            // `done` was already set by the fail() path.
            exitStatus = p.get_if_exited() ? p.get_exit_status() : null;
            // The child is dead: both pipes will EOF on their next read. If a
            // pump is idle (no read in flight), start one last pass so the EOF
            // (and any final buffered bytes) is actually observed.
            if (!stdoutReading && !stdoutEof)
                pumpStdout();
            if (!stderrReading && !stderrEof)
                pumpStderr();
            maybeDone();
        });

        // ---- timeout ---------------------------------------------------------
        if (timeoutMs > 0) {
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                fail('timeout');
                return GLib.SOURCE_REMOVE;
            });
        }

        pumpStdout();
        pumpStderr();
    }));
}

// ---- helpers ---------------------------------------------------------------

function concatChunks(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}