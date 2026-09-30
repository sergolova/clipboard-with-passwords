// W2+W3 test harness for stdoutReader.js (streaming stdout limit + timeout).
//
// Runs against REAL spawned processes (sh/cat/yes-like producers), so it
// exercises the actual Gio.Subprocess plumbing — unlike vault_align_test.js
// it is NOT a replica: it imports the production module verbatim.
// Run with: gjs -m tools/local/stdout_reader_test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { streamStdoutWithLimit } from './stdoutReader.js';

const PIPE = Gio.SubprocessFlags.STDIN_PIPE |
             Gio.SubprocessFlags.STDOUT_PIPE |
             Gio.SubprocessFlags.STDERR_PIPE;

function spawn(argv) {
    const proc = new Gio.Subprocess({argv, flags: PIPE});
    proc.init(null);
    return proc;
}

function waitExit(proc) {
    return new Promise((resolve, reject) => {
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
                // A force-killed process has no exit status (it was signaled):
                // report the raw wait status instead (`get_status()` is the
                // raw WEXITSTATUS/WTERMSIG word and is non-zero for a kill).
                let status = null;
                if (p.get_if_exited())
                    status = p.get_exit_status();
                else if (p.get_if_signaled())
                    status = p.get_status();
                resolve({ok: true, status});
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Resolve after `ms`, used only to give a killed process a moment to die
// before we assert its exit status (the reader force-kills it; the harness
// then reaps it to prove it really died).
function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; });
    });
}

const loop = new GLib.MainLoop(null, false);
let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

function decodeBytes(u8) {
    return new TextDecoder().decode(u8);
}

async function main() {
    console.log('== 1. normal stream: exact bytes, exit 0 ==');
    {
        const proc = spawn(['/bin/sh', '-c', 'printf "hello world"']);
        const r = await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 5000});
        check('exitStatus === 0', r.exitStatus === 0);
        check('stdout is Uint8Array', r.data instanceof Uint8Array);
        check('exact payload', decodeBytes(r.data) === 'hello world');
        check('no stderr', r.stderr === '');
        const w = await waitExit(proc);
        check('process reaped ok', w.ok && !w.forceKilled);
    }

    console.log('== 2. exit != 0 with small stdout: status passed through ==');
    {
        const proc = spawn(['/bin/sh', '-c', 'printf "partial"; echo oops >&2; exit 3']);
        const r = await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 5000});
        check('exitStatus === 3 (not swallowed)', r.exitStatus === 3);
        check('stdout still delivered', decodeBytes(r.data) === 'partial');
        check('stderr captured for diagnostics', r.stderr.includes('oops'));
    }

    console.log('== 3. input (password) written to stdin ==');
    {
        const proc = spawn(['/bin/cat']);
        const r = await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 5000,
                                                       input: 'secret\n'});
        check('cat echoes the input back', decodeBytes(r.data) === 'secret\n');
        check('exitStatus === 0', r.exitStatus === 0);
    }

    console.log('== 4. stream > maxBytes: force-killed, reject too-large ==');
    {
        const proc = spawn(['/bin/sh', '-c', 'i=0; while [ $i -lt 200000 ]; do printf x; i=$((i+1)); done']);
        let err = null, r = null;
        try {
            r = await streamStdoutWithLimit(proc, {maxBytes: 1000, timeoutMs: 5000});
        } catch (e) {
            err = e;
        }
        check('rejected with code too-large', !!err && err.code === 'too-large');
        if (r) check('too-large must not resolve', false);
        const w = await waitExit(proc);
        check('overflowing process was killed (non-zero / signal)', w.ok && w.status !== 0);
    }

    console.log('== 5. hung producer: timeout kills, reject timeout ==');
    {
        const proc = spawn(['/bin/sleep', '30']);
        const t0 = Date.now();
        let err = null;
        try {
            await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 400});
        } catch (e) {
            err = e;
        }
        const elapsed = Date.now() - t0;
        check('rejected with code timeout', !!err && err.code === 'timeout');
        check('timed out near the deadline (< 3s)', elapsed < 3000);
        const w = await waitExit(proc);
        check('hung process was killed', w.ok && w.status !== 0);
    }

    console.log('== 6. producer stuck writing stdout past limit: killed ==');
    {
        // `yes` writes forever; the cap must kill it mid-stream.
        const proc = spawn(['/bin/sh', '-c', 'while true; do printf "xxxxxxxxxxxxxxxx"; done']);
        let err = null;
        try {
            await streamStdoutWithLimit(proc, {maxBytes: 4096, timeoutMs: 5000});
        } catch (e) {
            err = e;
        }
        check('rejected (too-large wins over timeout)', !!err && err.code === 'too-large');
        const w = await waitExit(proc);
        check('infinite producer killed', w.ok && w.status !== 0);
    }

    console.log('== 7. large-but-under-limit stream: full exact bytes ==');
    {
        // 300 KB of a deterministic pattern, chunked reads must reassemble it.
        const proc = spawn(['/bin/sh', '-c', 'for i in $(seq 1 30000); do printf "abcdefghij"; done']);
        const r = await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 10000});
        const s = decodeBytes(r.data);
        check('300 KB reassembled exactly', s.length === 300000 && s.slice(0, 60) === 'abcdefghij'.repeat(6));
        check('exitStatus === 0', r.exitStatus === 0);
    }

    console.log('== 8. multi-byte UTF-8 rounds trip ==');
    {
        const proc = spawn(['/bin/sh', '-c', 'printf "пароль_секрет"']);
        const r = await streamStdoutWithLimit(proc, {maxBytes: 1024 * 1024, timeoutMs: 5000});
        check('UTF-8 decoded correctly', decodeBytes(r.data) === 'пароль_секрет');
    }

    console.log('== 9. real 7-Zip: pack then decrypt via streamStdoutWithLimit ==');
    // End-to-end against the REAL vault format (same argv as passwordVault.js):
    // 7z a -t7z -mhe=on -p -y + 7z x -so, password via stdin. Verifies the
    // streaming reader decrypts a real archive back to the exact source JSON.
    {
        const GioLib = Gio;
        const tmpDir = GLib.dir_make_tmp('ci_st_XXXXXX');
        const jsonPath = tmpDir + '/data.json';
        const archivePath = tmpDir + '/vault.7z';
        GLib.file_set_contents(jsonPath, JSON.stringify({version: 1, items: [{id: 's1', name: '7z reader'}]}, null, 2));

        const pack = () => new Promise((resolve, reject) => {
            const p = spawn(['/usr/bin/7z', 'a', '-t7z', '-mhe=on', '-p', '-y', archivePath, jsonPath]);
            streamStdoutWithLimit(p, {maxBytes: 1024 * 1024, timeoutMs: 10000, input: 'secret\n'})
                .then(r => r.exitStatus === 0 ? resolve() : reject(new Error('pack failed ' + r.exitStatus)))
                .catch(reject);
        });
        const unpack = () => {
            const p = spawn(['/usr/bin/7z', 'x', '-so', archivePath]);
            return streamStdoutWithLimit(p, {maxBytes: 1024 * 1024, timeoutMs: 10000, input: 'secret\n'});
        };
        try {
            await pack();
            const r = await unpack();
            check('7z decrypts to exact JSON', decodeBytes(r.data) === JSON.stringify({version: 1, items: [{id: 's1', name: '7z reader'}]}, null, 2));
            check('7z exitStatus === 0', r.exitStatus === 0);
            // Wrong password must surface as exit != 0, never as garbage data.
            const p2 = spawn(['/usr/bin/7z', 'x', '-so', archivePath]);
            const r2 = await streamStdoutWithLimit(p2, {maxBytes: 1024 * 1024, timeoutMs: 10000, input: 'nope\n'}).catch(e => ({code: e && e.code}));
            check('wrong password → exit != 0', typeof r2.exitStatus === 'number' && r2.exitStatus !== 0);
        } finally {
            try { GLib.unlink(jsonPath); } catch (e) {}
            try { GLib.unlink(archivePath); } catch (e) {}
            try { GLib.rmdir(tmpDir); } catch (e) {}
        }
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    loop.quit();
    if (failed > 0)
        process.exit(1);
}

main().catch(e => { console.log('HARNESS ERROR:', e); loop.quit(); process.exit(1); });
loop.run();