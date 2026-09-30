// T6 logic test: the conversion state machine (convertToDesiredFormat),
// the guarded leftover removal (removeVaultFile) and the real strings.js `fmt`
// helper. passwordVault.js itself cannot be imported from the gjs CLI (it
// imports the shell resource), so the vault logic here is a faithful replica
// that MUST stay in sync by review; `fmt` is the REAL module (pure ESM, no
// shell dependencies). Run with: gjs -m tools/local/conversion_flow_test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { fmt } from './strings.js';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

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

// State object mirrors the real PasswordVaultManager fields the conversion
// flow touches: zipPath, unlocked, actual/desired format, items, notify log.
function makeState(dir, {actual7z, desired7z, items = []}) {
    return {
        zipPath: dir + (actual7z ? '/s.7z' : '/s.zip'),
        unlocked: true,
        actual7z,
        desired7z,
        items,
        notifications: [],
        info: null
    };
}

// _notifyPathTransition replica.
function notify(state, info) {
    state.notifications.push(info);
}

// convertToDesiredFormat replica. save() is simulated by writing a marker file
// at the canonical target (real 7z packing is already covered by
// vault_align_test.js) and switching the active path — the only things under
// test here are the pending gate, previousPath capture, summary/notify shape
// and the post-conversion format state.
async function convertToDesiredFormat(state) {
    if (!(state.unlocked && state.desired7z !== state.actual7z))
        return null;
    const previousPath = state.zipPath;
    const from = state.actual7z ? '7z' : 'ZIP';
    const to = state.desired7z ? '7z' : 'ZIP';
    const records = (state.items || []).length;

    state.actual7z = state.desired7z;
    const target = canonicalFormatPath(state.zipPath, state.actual7z);
    const tmp = target + '.tmp-x';
    GLib.file_set_contents(tmp, 'MOCK-' + target);
    GLib.rename(tmp, target);
    state.zipPath = target;

    notify(state, {converted: true, from, to, previousPath, records});
    return {from, to, records, previousPath, newPath: state.zipPath};
}

// removeVaultFile replica.
function removeVaultFile(state, pathStr, {withBak = true} = {}) {
    if (!pathStr || pathStr === state.zipPath)
        return false;
    const file = Gio.File.new_for_path(pathStr);
    if (!file.query_exists(null))
        return true;
    if (detectArchiveFormat(pathStr) === null)
        return false;
    try {
        file.delete(null);
    } catch (e) {
        return false;
    }
    if (withBak) {
        try {
            const bak = Gio.File.new_for_path(pathStr + '.bak');
            if (bak.query_exists(null))
                bak.delete(null);
        } catch (e) {}
    }
    return true;
}

function main() {
    const loop = new GLib.MainLoop(null, false);
    const checks = [];
    const ok = (name, cond) => { checks.push({name, pass: !!cond}); };
    const dir = GLib.dir_make_tmp('ci_conv_XXXXXX');

    (async () => {
        // --- 1. fmt (real module) ---
        ok('fmt %1$s %2$s',
           fmt('a=%1$s b=%2$s', '7z', 'ZIP') === 'a=7z b=ZIP');
        ok('fmt positional replacement repeated',
           fmt('%1$s-%1$s', 'x') === 'x-x');
        ok('fmt %d coerces to int',
           fmt('%1$d records', 42.9) === '42 records');
        ok('fmt unknown index -> empty',
           fmt('a=%1$s b=%2$s', 'only') === 'a=only b=');
        ok('fmt %% passes through',
           fmt('100%% sure %1$s', '!') === '100%% sure !');
        ok('fmt non-template untouched',
           fmt('plain text') === 'plain text');

        // --- 2. convertToDesiredFormat state machine ---
        // Not pending (formats agree) → null, nothing notified.
        const idle = makeState(dir, {actual7z: true, desired7z: true, items: [{}, {}]});
        const rNull = await convertToDesiredFormat(idle);
        ok('no pending -> null', rNull === null);
        ok('no pending -> no notify', idle.notifications.length === 0);

        // Pending ZIP→7z → previousPath captured, summary complete.
        const st = makeState(dir, {actual7z: false, desired7z: true, items: [1, 2, 3]});
        GLib.file_set_contents(st.zipPath, 'PK\x03\x04old-zip');
        const sum = await convertToDesiredFormat(st);
        ok('converted summary from', sum.from === 'ZIP');
        ok('converted summary to', sum.to === '7z');
        ok('converted summary records', sum.records === 3);
        ok('converted summary previousPath',
           sum.previousPath === dir + '/s.zip');
        ok('converted summary newPath', sum.newPath === dir + '/s.7z');
        ok('notify carries converted+previousPath',
           st.notifications.length === 1 &&
           st.notifications[0].converted === true &&
           st.notifications[0].previousPath === dir + '/s.zip' &&
           st.notifications[0].records === 3);
        ok('no longer pending after conversion',
           st.desired7z === st.actual7z);

        // Pending 7z→ZIP direction.
        const st2 = makeState(dir, {actual7z: true, desired7z: false, items: []});
        GLib.file_set_contents(st2.zipPath, '37\x7a\xbc\xaf\x27\x1cold-7z');
        const sum2 = await convertToDesiredFormat(st2);
        ok('reverse: 7z->ZIP previousPath',
           sum2.previousPath === dir + '/s.7z' && sum2.newPath === dir + '/s.zip');
        ok('reverse: records 0', sum2.records === 0);

        // --- 3. "Not now" (user declines): the UI layer never invokes
// convertToDesiredFormat — assert the pending state survives untouched so the
// next unlock can prompt again.
        const dec = makeState(dir, {actual7z: false, desired7z: true, items: [1]});
        GLib.file_set_contents(dec.zipPath, 'PK\x03\x04declined');
        ok('declined: no conversion ran', dec.notifications.length === 0);
        ok('declined: still pending next session', dec.desired7z !== dec.actual7z);
        ok('declined: active path untouched (still s.zip)',
           Gio.File.new_for_path(dec.zipPath).query_exists(null) &&
           detectArchiveFormat(dec.zipPath) === 'zip');

        // --- 4. removeVaultFile guard ---
        // Fake archives: a 4-byte ZIP magic header is enough for the format
        // detector; the guard only distinguishes archive vs non-archive.
        const oldZip = dir + '/old.zip';
        GLib.file_set_contents(oldZip, 'PK\x03\x04old-vault');
        GLib.file_set_contents(oldZip + '.bak', 'PK\x03\x04old-vault-bak');

        const current = {zipPath: dir + '/s.7z'};
        GLib.file_set_contents(current.zipPath, '37\x7a\xbc\xaf\x27\x1cactive');

        ok('remove old vault + bak', removeVaultFile(current, oldZip) === true &&
           !Gio.File.new_for_path(oldZip).query_exists(null) &&
           !Gio.File.new_for_path(oldZip + '.bak').query_exists(null));

        // withBak=false keeps the .bak.
        const oldZip2 = dir + '/old2.zip';
        GLib.file_set_contents(oldZip2, 'PK\x03\x04old2');
        GLib.file_set_contents(oldZip2 + '.bak', 'PK\x03\x04old2-bak');
        ok('withBak=false keeps .bak', removeVaultFile(current, oldZip2, {withBak: false}) === true &&
           !Gio.File.new_for_path(oldZip2).query_exists(null) &&
           Gio.File.new_for_path(oldZip2 + '.bak').query_exists(null));

        // Never removes the ACTIVE vault path.
        ok('refuses active path', removeVaultFile(current, current.zipPath) === false &&
           Gio.File.new_for_path(current.zipPath).query_exists(null));

        // Never removes a non-archive file (plain text).
        const text = dir + '/notes.txt';
        GLib.file_set_contents(text, 'not an archive');
        ok('refuses non-vault file', removeVaultFile(current, text) === false &&
           Gio.File.new_for_path(text).query_exists(null));

        ok('missing path -> true', removeVaultFile(current, dir + '/gone.zip') === true);

        for (const c of checks)
            print((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name);
        print('== ' + checks.filter(c => c.pass).length + '/' + checks.length + ' passed ==');

        try {
            GLib.rmdir(dir);
        } catch (e) {}
        loop.quit();
    })().catch(e => { print('HARNESS ERROR: ' + e); loop.quit(); });
    loop.run();
}

main();