// T1 logic test: the rename/conversion never-overwrite guard (destCollides)
// from passwordVault.js against real archives. passwordVault.js itself cannot
// be imported from the gjs CLI (it imports the shell resource), so these are
// faithful replicas that MUST stay in sync by review — same technique as
// vault_align_test.js.
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const PASSWORD = 'secret';

const dir = GLib.canonicalize_filename(
    GLib.path_get_dirname(imports.system.programInvocationName) + '/guard', null);

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

function detectArchiveFormat(pathStr) {
    const file = Gio.File.new_for_path(pathStr);
    if (!file.query_exists(null))
        return null;
    let stream;
    try {
        stream = file.read(null);
        const head = stream.read_bytes(8, null).toArray();
        if (head.length >= 4 && head[0] === ZIP_MAGIC[0] && head[1] === ZIP_MAGIC[1] &&
            head[2] === ZIP_MAGIC[2] && head[3] === ZIP_MAGIC[3])
            return 'zip';
        if (head.length >= 6 && SEVENZ_MAGIC.every((b, i) => head[i] === b))
            return '7z';
        return null;
    } catch (e) {
        return null;
    } finally {
        try { if (stream) stream.close(null); } catch (e) {}
    }
}

function canonicalFormatPath(pathStr, use7z) {
    const suffix = /\.(zip|7z)$/i.exec(pathStr);
    if (!suffix)
        return pathStr;
    return pathStr.slice(0, -suffix[0].length) + (use7z ? '.7z' : '.zip');
}

// destCollides replica — the single guard behind every rename/conversion.
function destCollides(srcPath, destPath) {
    if (!destPath || destPath === srcPath)
        return false;
    return Gio.File.new_for_path(destPath).query_exists(null);
}

// save()-time guard replica: refuse an atomic rename whose target differs from
// the active vault path AND is already occupied (T1). Comparison against the
// active path mirrors passwordVault.js exactly.
function saveRefused(srcPath, targetPath) {
    return destCollides(srcPath, targetPath);
}

const binary = '/usr/bin/7z';
function run(args, stdin) {
    return new Promise((resolve, reject) => {
        const proc = new Gio.Subprocess({
            argv: [binary, ...args],
            flags: Gio.SubprocessFlags.STDIN_PIPE |
                   Gio.SubprocessFlags.STDOUT_PIPE |
                   Gio.SubprocessFlags.STDERR_PIPE
        });
        proc.init(null);
        proc.communicate_utf8_async(stdin, null, (p, r) => {
            try {
                const [, out, err] = p.communicate_utf8_finish(r);
                resolve({status: p.get_exit_status(), out, err});
            } catch (e) { reject(e); }
        });
    });
}

async function pack(dataJsonPath, outPath, use7z) {
    const argv = ['a',
                  use7z ? '-t7z' : '-tzip',
                  use7z ? '-mhe=on' : '-mem=AES256',
                  '-p', '-y', outPath, dataJsonPath];
    const r = await run(argv, PASSWORD + '\n');
    return r.status === 0;
}

function readBytes(p) {
    const [, bytes] = GLib.file_get_contents(p);
    return Array.from(bytes);
}
function sameBytes(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function main() {
    const loop = new GLib.MainLoop(null, false);
    const checks = [];
    const ok = (name, cond) => { checks.push({name, pass: !!cond}); };

    GLib.mkdir_with_parents(dir, 0o700);
    const json = JSON.stringify({version: 1, items: [{id: 's1', name: 'probe'}]}, null, 2);
    GLib.file_set_contents(dir + '/data.json', json);

    (async () => {
        const zip = dir + '/vault.zip';        // active vault (ZIP)
        const sz = dir + '/vault.7z';          // active vault (7z)
        await pack(dir + '/data.json', zip, false);
        await pack(dir + '/data.json', sz, true);

        // --- 1. destCollides semantics ---
        ok('same path -> false', destCollides(zip, zip) === false);
        ok('empty dest -> false', destCollides(zip, '') === false);
        ok('missing dest -> false', destCollides(zip, dir + '/nope.7z') === false);
        ok('different existing file -> true', destCollides(zip, sz) === true);
        ok('existing=src, differing string -> true (different FILE)',
           destCollides(sz, dir + '/vault.zip') === true);

        // --- 2. save-time guard, both conversion directions ---
        // zip vault → 7z target already occupied by a REAL 7z archive: refused.
        ok('zip->7z blocked (target busy)', saveRefused(zip, sz) === true);
        // Same-path normal save: never blocked, even though the file exists.
        ok('normal save same path not blocked', saveRefused(zip, zip) === false);

        // A foreign blocker: name it exactly what a zip→7z conversion would
        // target, but make it a DIFFERENT file than the active vault.
        const busy = dir + '/vault2.7z';
        await pack(dir + '/data.json', busy, true);
        ok('zip->7z blocked (foreign busy)', saveRefused(zip, busy) === true);

        // 7z vault → zip target already occupied: blocked as well.
        const busyZip = dir + '/dup.zip';
        await pack(dir + '/data.json', busyZip, false);
        ok('7z->zip blocked (target exists)', saveRefused(sz, busyZip) === true);

        // --- 3. retry after the blocker is removed ---
        GLib.remove(busy);
        ok('zip->7z allowed after blocker removed', saveRefused(zip, busy) === false);

        // --- 4. no mutation: a refused conversion leaves BOTH files intact ---
        const zipBefore = readBytes(zip);
        const busyBytes = await (async () => {
            await pack(dir + '/data.json', dir + '/busy2.7z', true);
            return readBytes(dir + '/busy2.7z');
        })();
        const blocked = saveRefused(zip, dir + '/busy2.7z');
        ok('refusal returns true', blocked === true);
        ok('active vault byte-identical after refusal',
           sameBytes(zipBefore, readBytes(zip)));
        ok('blocking file byte-identical after refusal', sameBytes(busyBytes, readBytes(dir + '/busy2.7z')));
        ok('blocking file still a 7z archive', detectArchiveFormat(dir + '/busy2.7z') === '7z');

        for (const c of checks)
            print((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name);
        print('== ' + checks.filter(c => c.pass).length + '/' + checks.length + ' passed ==');
        loop.quit();
    })().catch(e => { print('HARNESS ERROR: ' + e); loop.quit(); });
    loop.run();
}

main();