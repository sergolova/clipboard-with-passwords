// Logic test harness replicating the exact helper functions and flows from
// passwordVault.js (canonicalFormatPath, detectArchiveFormat, _verifyArchiveWrite,
// alignVaultToContent) against real archives. passwordVault.js itself cannot be
// imported from the gjs CLI (it imports the shell resource), so these are
// faithful replicas — they must stay in sync by review.
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const PASSWORD = 'secret';

// Test data + generated archives live next to this harness (not in /tmp).
// GJS classic scripts have no __dirname; derive it from the invocation path.
const dir = GLib.canonicalize_filename(
    GLib.path_get_dirname(imports.system.programInvocationName) + '/align', null);

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

// _verifyArchiveWrite replica
async function verifyWrite(archivePath, use7z, expectedJson) {
    if (detectArchiveFormat(archivePath) !== (use7z ? '7z' : 'zip'))
        return false;
    const r = await run(['x', '-so', archivePath], PASSWORD + '\n');
    return r.status === 0 && r.out === expectedJson;
}

// save() packing step replica (exact argv of passwordVault.js)
async function pack(dataJsonPath, outPath, use7z) {
    const argv = ['a',
                  use7z ? '-t7z' : '-tzip',
                  use7z ? '-mhe=on' : '-mem=AES256',
                  '-p', '-y', outPath, dataJsonPath];
    const r = await run(argv, PASSWORD + '\n');
    return r.status === 0;
}

function destCollides(srcPath, destPath) {
    if (!destPath || destPath === srcPath)
        return false;
    return Gio.File.new_for_path(destPath).query_exists(null);
}

const alignRes = {renamed: [], blocked: []};
// alignNameToContent replica (rename-only, T1 guard) — mirrors the real
// passwordVault.js split: format *conversion* is deliberately NOT part of
// name alignment anymore (it runs only after user confirmation in the UI
// layer; its state machine is covered by conversion_flow_test.js).
async function alignNameToContent(zipPath) {
    let currentPath = zipPath;
    const actual = detectArchiveFormat(currentPath) === '7z';

    const aligned = canonicalFormatPath(currentPath, actual);
    if (aligned !== currentPath) {
        if (destCollides(currentPath, aligned)) {
            alignRes.blocked.push(aligned);
        } else if (GLib.rename(currentPath, aligned) === 0) {
            currentPath = aligned;
            alignRes.renamed.push(aligned);
        }
    }
    return {currentPath, format: detectArchiveFormat(currentPath), aligned};
}

function main() {
    const loop = new GLib.MainLoop(null, false);
    const checks = [];
    const ok = (name, cond) => { checks.push({name, pass: !!cond}); };

    // Wipe artifacts of previous runs: with the T1 guard in place a leftover
    // target file would legitimately block a rename and break the test.
    ['data.json', 'v.zip', 'v.7z', 'empty.bin', 'bad.zip',
     'misnamed.7z', 'misnamed.zip', 'clash.7z', 'clash.zip', 'match.zip']
        .forEach(f => { try { GLib.remove(dir + '/' + f); } catch (e) {} });

    GLib.mkdir_with_parents(dir, 0o700);
    const json = JSON.stringify({version: 1, items: [{id: 's1', name: 'probe'}]}, null, 2);
    GLib.file_set_contents(dir + '/data.json', json);

    (async () => {
        // --- 1. detectArchiveFormat on real archives ---
        const zipA = dir + '/v.zip';
        const szA = dir + '/v.7z';
        await pack(dir + '/data.json', zipA, false);
        await pack(dir + '/data.json', szA, true);
        const empty = dir + '/empty.bin';
        GLib.file_set_contents(empty, '');
        ok('detect zip', detectArchiveFormat(zipA) === 'zip');
        ok('detect 7z (with -mhe=on)', detectArchiveFormat(szA) === '7z');
        ok('detect empty -> null', detectArchiveFormat(empty) === null);
        ok('detect missing -> null', detectArchiveFormat(dir + '/nope') === null);

        // --- 2. canonicalFormatPath ---
        ok('canon zip->7z', canonicalFormatPath('/a/pwds.zip', true) === '/a/pwds.7z');
        ok('canon 7z->zip', canonicalFormatPath('/a/pwds.7z', false) === '/a/pwds.zip');
        ok('canon .ZIP->.7z', canonicalFormatPath('/a/pwds.ZIP', true) === '/a/pwds.7z');
        ok('canon .7Z->.zip', canonicalFormatPath('/a/pwds.7Z', false) === '/a/pwds.zip');
        ok('canon no suffix unchanged', canonicalFormatPath('/a/pwds', true) === '/a/pwds');
        ok('canon other ext unchanged', canonicalFormatPath('/a/pwds.dat', false) === '/a/pwds.dat');
        ok('canon keeps dirs', canonicalFormatPath('/mt/data/SERA/pwds.zip', true) === '/mt/data/SERA/pwds.7z');

        // --- 3. verifyWrite ---
        ok('verify real zip', await verifyWrite(zipA, false, json));
        ok('verify real 7z', await verifyWrite(szA, true, json));
        ok('verify fails on empty', (await verifyWrite(empty, false, json)) === false);
        ok('format-vs-expected mismatch fails (zip file, expect 7z)',
           (await verifyWrite(zipA, true, json)) === false);

        // Corrupt round-trip: header looks like an archive but payload is junk.
        const bad = dir + '/bad.zip';
        GLib.file_set_contents(bad, 'PK\x03\x04' + 'junk'.repeat(50));
        ok('verify fails on fake-header zip', (await verifyWrite(bad, false, json)) === false);

        // --- 4. alignNameToContent (rename to match content, T1-guarded) ---
        // 4a: file named .7z but contains ZIP → renamed to .zip, no conversion
        const mis = dir + '/misnamed.7z';
        Gio.File.new_for_path(zipA).copy(Gio.File.new_for_path(mis),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        const r1 = await alignNameToContent(mis);
        ok('4a renamed .7z->.zip', r1.currentPath === dir + '/misnamed.zip');
        ok('4a still ZIP on disk', detectArchiveFormat(r1.currentPath) === 'zip');

        // 4b: rename TARGET already exists (foreign archive) → rename refused,
        // both files unchanged (GLib.rename must never replace it).
        const mis2 = dir + '/clash.7z';          // ZIP content, misnamed .7z
        Gio.File.new_for_path(zipA).copy(Gio.File.new_for_path(mis2),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        const clashZip = dir + '/clash.zip';     // existing foreign ZIP archive
        Gio.File.new_for_path(zipA).copy(Gio.File.new_for_path(clashZip),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        const clashSizeBefore = Gio.File.new_for_path(clashZip)
            .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        const r2 = await alignNameToContent(mis2);
        ok('4b rename blocked when target exists', r2.currentPath === dir + '/clash.7z');
        ok('4b source untouched', detectArchiveFormat(r2.currentPath) === 'zip');
        ok('4b target intact', detectArchiveFormat(clashZip) === 'zip' &&
           Gio.File.new_for_path(clashZip)
               .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() === clashSizeBefore);

        // 4c: name already matches content → no rename, no false positive
        const matching = dir + '/match.zip';
        Gio.File.new_for_path(zipA).copy(Gio.File.new_for_path(matching),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        const r3 = await alignNameToContent(matching);
        ok('4c matching name untouched', r3.currentPath === matching && r3.aligned === matching);

        for (const c of checks)
            print((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name);
        print('== ' + checks.filter(c => c.pass).length + '/' + checks.length + ' passed ==');
        loop.quit();
    })().catch(e => { print('HARNESS ERROR: ' + e); loop.quit(); });
    loop.run();
}

main();