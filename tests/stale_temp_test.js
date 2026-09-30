// P2.2 smoke test: stale-temp cleanup mirror of passwordVault.js
// `_cleanupStaleTemp` against real scratch directories.
//
// passwordVault.js cannot be imported from the gjs CLI (it imports the shell
// resource), so this is a faithful replica — it must stay in sync by review.
// It also reproduces STALE_TEMP_MIN_AGE_MS from constants.js by value.
//
// Run from the repo root:  gjs tools/local/stale_temp_test.js
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const STALE_TEMP_MIN_AGE_MS = 60 * 1000; // must match constants.js

// Mirror of passwordVault.js `_cleanupStaleTemp` body (same matchers, same
// age guard, collect-then-delete).
function removeRecursive(file) {
    let type;
    try {
        type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return;
    }
    if (type === Gio.FileType.DIRECTORY) {
        try {
            const kids = file.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = kids.next_file(null)) !== null)
                removeRecursive(file.get_child(info.get_name()));
        } catch (e) {
        }
    }
    try {
        file.delete(null);
    } catch (e) {
    }
}

function cleanupStaleTemp({ tmpDirPath, vaultDirPath, archiveName, now }) {
    const tryDelete = (file) => {
        try {
            removeRecursive(file);
        } catch (e) {
            print('WARN: delete failed for', file.get_path(), String(e));
        }
    };

    const sweep = (dirPath, isCandidate) => {
        const doomed = [];
        try {
            const dir = Gio.File.new_for_path(dirPath);
            if (!dir.query_exists(null))
                return;
            const kids = dir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = kids.next_file(null)) !== null) {
                const name = info.get_name();
                if (!isCandidate(info, name))
                    continue;
                const ageMillis = now - info.get_modification_date_time().to_unix() * 1000;
                if (ageMillis < STALE_TEMP_MIN_AGE_MS)
                    continue;
                doomed.push(dir.get_child(name));
            }
        } catch (e) {
            print('WARN: sweep failed in', dirPath, String(e));
            return;
        }
        doomed.forEach(tryDelete);
    };

    sweep(tmpDirPath, (info, name) => {
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            return /^ci_vault_[A-Za-z0-9]{6}$/.test(name);
        return /^ci_vault_\d+\.json$/.test(name); // legacy flat files
    });

    if (!vaultDirPath)
        return;
    sweep(vaultDirPath, (info, name) => {
        if (!name.startsWith(archiveName + '.tmp-'))
            return false;
        return /^\d+$/.test(name.slice(archiveName.length + '.tmp-'.length));
    });
}

// --------------------------------------------------------------------------- helpers

function writeFile(pathStr, content) {
    GLib.file_set_contents(pathStr, content);
}

function setMtime(pathStr, unixSeconds) {
    Gio.File.new_for_path(pathStr).set_attribute_uint64('time::modified', unixSeconds,
        Gio.FileQueryInfoFlags.NONE, null);
}

function listNames(dirPath) {
    const names = [];
    const dir = Gio.File.new_for_path(dirPath);
    const kids = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = kids.next_file(null)) !== null)
        names.push(info.get_name());
    return names.sort();
}

function assertEqual(actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error('expected ' + e + ' but got ' + a);
}

// --------------------------------------------------------------------------- test

const checks = [];
const ok = (name, cond) => { checks.push({ name, pass: !!cond }); };

const now = Date.now();
const nowSec = Math.floor(now / 1000);
const OLD = nowSec - 3600;                  // 1 h old → stale
const FRESH = Math.max(1, nowSec - 5);      // 5 s old → below the 60 s guard

// Scratch playground (private dirs in the real system temp dir).
const root = GLib.dir_make_tmp('cwp_stale_test_XXXXXX');
const tmpDir = root + '/tmp';
const vaultDir = root + '/vault';
GLib.mkdir_with_parents(tmpDir, 0o700);
GLib.mkdir_with_parents(vaultDir, 0o700);

try {
    // --- T: system temp dir ------------------------------------------------
    // Current-format private dir (dir_make_tmp pattern), stale → must go.
    const oldDir = tmpDir + '/ci_vault_ABC123';
    GLib.mkdir_with_parents(oldDir, 0o700);
    writeFile(oldDir + '/data.json', '{"version":1,"items":[]}');
    setMtime(oldDir, OLD);

    // Current-format private dir, fresh → must survive.
    const freshDir = tmpDir + '/ci_vault_ZZZ999';
    GLib.mkdir_with_parents(freshDir, 0o700);
    writeFile(freshDir + '/data.json', '{}');
    setMtime(freshDir, FRESH);

    // Legacy flat plaintext file from older versions, stale → must go.
    const legacyFile = tmpDir + '/ci_vault_1700000000123.json';
    writeFile(legacyFile, '{"version":1,"items":[]}');
    setMtime(legacyFile, OLD);

    // Almost-our-name decoys → must survive (wrong length / not ours).
    GLib.mkdir_with_parents(tmpDir + '/ci_vault_AB', 0o700);
    writeFile(tmpDir + '/ci_vault_999.json', 'not ours'); // no leading digits after prefix
    writeFile(tmpDir + '/unrelated.log', 'x');

    // --- V: archive directory ----------------------------------------------
    // Stale encrypted half-written archive from an interrupted atomic save.
    writeFile(vaultDir + '/storage.zip.tmp-1700000000000', 'junk');
    setMtime(vaultDir + '/storage.zip.tmp-1700000000000', OLD);
    // Fresh one (would belong to an in-flight save) → must survive.
    writeFile(vaultDir + '/storage.zip.tmp-' + now, 'junk');
    setMtime(vaultDir + '/storage.zip.tmp-' + now, FRESH);
    // Non-digit tail / wrong archive prefix → must survive.
    writeFile(vaultDir + '/storage.zip.tmp-x99', 'junk');
    writeFile(vaultDir + '/other.zip.tmp-123', 'junk');
    // Real archive + backup → must survive.
    writeFile(vaultDir + '/storage.zip', 'archive');
    writeFile(vaultDir + '/storage.zip.bak', 'backup');

    cleanupStaleTemp({ tmpDirPath: tmpDir, vaultDirPath: vaultDir, archiveName: 'storage.zip', now });

    const expectedT = ['ci_vault_999.json', 'ci_vault_AB', 'ci_vault_ZZZ999', 'unrelated.log'];
    ok('system temp: stale ci_vault_* dir removed', !Gio.File.new_for_path(oldDir).query_exists(null));
    ok('system temp: fresh ci_vault_* dir kept', Gio.File.new_for_path(freshDir).query_exists(null));
    ok('system temp: legacy ci_vault_<ts>.json removed', !Gio.File.new_for_path(legacyFile).query_exists(null));
    assertEqual(listNames(tmpDir), expectedT);
    ok('system temp: survivor set exact', true);

    const expectedV = ['other.zip.tmp-123', 'storage.zip', 'storage.zip.bak',
        'storage.zip.tmp-' + now, 'storage.zip.tmp-x99'];
    ok('vault dir: stale .tmp-<ts> removed', !Gio.File.new_for_path(vaultDir + '/storage.zip.tmp-1700000000000').query_exists(null));
    assertEqual(listNames(vaultDir), expectedV);
    ok('vault dir: survivor set exact', true);
} finally {
    removeRecursive(Gio.File.new_for_path(root));
}

checks.forEach(c => print((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name));
print('== ' + checks.filter(c => c.pass).length + '/' + checks.length + ' passed ==');
if (checks.some(c => !c.pass))
    imports.system.exit(1);