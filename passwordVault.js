import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { DEFAULT_VAULT_PATH } from './constants.js';
import {
    MAX_VAULT_ARCHIVE_BYTES,
    MAX_VAULT_JSON_BYTES,
    MAX_VAULT_ITEMS,
    MAX_FIELD_LENGTH,
    MAX_EXTRA_FIELDS,
    STALE_TEMP_MIN_AGE_MS,
    SEVENZ_TIMEOUT_MS
} from './constants.js';
import { logWarn } from './logging.js';
import { cryptoRandomInt, setEntropySource } from './random.js';
import { streamStdoutWithLimit } from './stdoutReader.js';

// Internal sentinel for the pseudo-category "All". It is deliberately NOT the
// translated word (e.g. 'Все'/'All'): such a word could collide with a real
// user category, and translations belong only to the button label in the UI.
export const ALL_CATEGORY = '__all__';

// Entropy source for the CSPRNG in random.js: the OS CSPRNG via /dev/urandom.
// The exact-length loop is defensive — /dev/urandom never short-reads — and
// keeps the pool filling contract ("exactly n fresh bytes") honest. No I/O
// happens here: registration only stores the function reference.
function readEntropyBytes(n) {
    const out = new Uint8Array(n);
    let got = 0;
    const file = Gio.File.new_for_path('/dev/urandom');
    let stream = null;
    try {
        stream = file.read(null);
        while (got < n) {
            const chunk = stream.read_bytes(n - got, null).get_data();
            if (!chunk || chunk.length === 0)
                throw new Error('empty read from /dev/urandom');
            out.set(chunk, got);
            got += chunk.length;
        }
    } finally {
        if (stream) {
            try {
                stream.close(null);
            } catch (e) {
                // already failing or closed; nothing to do about it
            }
        }
    }
    return out;
}
setEntropySource(readEntropyBytes);

export function generatePassword(length = 16, options = {}) {
    const {
        useUpper = true,
        useLower = true,
        useDigits = true,
        useSymbols = true
    } = options;

    let chars = '';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    if (useUpper) chars += upper;
    if (useLower) chars += lower;
    if (useDigits) chars += digits;
    if (useSymbols) chars += symbols;

    if (!chars) chars = lower + digits;

    // Guarantee at least one character of every enabled class, drawn from the
    // CSPRNG (see random.js — Math.random is not cryptographically secure).
    const res = [];
    if (useUpper) res.push(upper[cryptoRandomInt(upper.length)]);
    if (useLower) res.push(lower[cryptoRandomInt(lower.length)]);
    if (useDigits) res.push(digits[cryptoRandomInt(digits.length)]);
    if (useSymbols) res.push(symbols[cryptoRandomInt(symbols.length)]);

    while (res.length < length) {
        res.push(chars[cryptoRandomInt(chars.length)]);
    }

    // Fisher–Yates with the same CSPRNG: without a shuffle the seed characters
    // would sit in fixed positions, and a `sort` with a Math.random comparator
    // would be both biased and non-secure.
    for (let i = res.length - 1; i > 0; i--) {
        const j = cryptoRandomInt(i + 1);
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res.join('');
}

// Default location of the encrypted vault archive (shared with the schema
// default): "storage.zip" for the archive, "data.json" for the JSON payload
// inside it — see DEFAULT_VAULT_PATH in constants.js.
const VAULT_MEMBER_NAME = 'data.json';

export function resolveVaultPath(pathStr) {
    if (!pathStr) {
        pathStr = DEFAULT_VAULT_PATH;
    }
    if (pathStr.startsWith('~')) {
        pathStr = GLib.get_home_dir() + pathStr.slice(1);
    }
    return pathStr;
}

// Magic bytes that identify archive containers — the *content* of the vault
// file, never its name, is the source of truth. A 7z archive stored in a
// `.zip`-named file is detected here and renamed to match, so the extension
// always "answers to the content" it keeps. (The 7z signature is plaintext
// even with header encryption enabled, and the PK\x03\x04 local-file header
// is present on AES-encrypted ZIPs too.)
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

export function detectArchiveFormat(pathStr) {
    const file = Gio.File.new_for_path(pathStr);
    if (!file.query_exists(null)) {
        return null;
    }
    let stream;
    try {
        stream = file.read(null);
        const head = stream.read_bytes(8, null).toArray();
        if (head.length >= 4 &&
            head[0] === ZIP_MAGIC[0] && head[1] === ZIP_MAGIC[1] &&
            head[2] === ZIP_MAGIC[2] && head[3] === ZIP_MAGIC[3]) {
            return 'zip';
        }
        if (head.length >= 6 && SEVENZ_MAGIC.every((b, i) => head[i] === b)) {
            return '7z';
        }
        return null; // exists, but not a recognizable archive header
    } catch (e) {
        return null;
    } finally {
        try {
            if (stream) stream.close(null);
        } catch (e) {
        }
    }
}

// The canonical archive file name for a format: a path ending in `.zip` or
// `.7z` (case-insensitive) has its suffix swapped to match the format. Any
// other name (extension-less, `.dat`, …) is returned unchanged — it neither
// claims nor contradicts a container, and the user's naming choice wins.
export function canonicalFormatPath(pathStr, use7z) {
    const suffix = /\.(zip|7z)$/i.exec(pathStr);
    if (!suffix) {
        return pathStr;
    }
    return pathStr.slice(0, -suffix[0].length) + (use7z ? '.7z' : '.zip');
}

// Archive backends to use for the encrypted ZIP vault, in order of
// preference. The full `7z` (p7zip-full) is the primary backend; the
// standalone `7za` (p7zip) is used as a fallback, and `7zz` (the standalone
// official 7-Zip, package `7zip` on modern Debian/Ubuntu/Arch) is probed
// last for systems that only ship that binary.
// `7zr` is deliberately NOT probed: it only understands the native .7z
// format and reports "Unsupported archive type" for ZIP archives.
const ARCHIVE_BINARIES = ['7z', '7za', '7zz'];

// System locations checked *before* the user's PATH. The PATH of a shell
// session can be tampered with (a fake `7z` earlier in the search order
// would be executed with the user's privileges); these paths are under
// root's control and cover Debian/Ubuntu/Fedora/Arch layouts.
const ARCHIVE_BINARY_PATHS = [
    '/usr/bin/7z',
    '/usr/bin/7za',
    '/usr/bin/7zz',
    '/bin/7z',
    '/bin/7za',
    '/bin/7zz',
];

// Cached so we don't re-probe PATH on every unlock/save. Only a *found*
// binary is cached — a null result is re-probed each time so a binary
// installed after the shell started is picked up.
let _archiveBinary = null;

// A usable backend must be an executable file that is not a directory.
// Regular binaries and symlinks to them (e.g. `7za -> 7z` on Arch) both
// qualify; a directory with the exec bits set does not.
function isUsableArchiveBinary(path) {
    if (!path) return false;
    const isFile = GLib.file_test(path, GLib.FileTest.IS_REGULAR) ||
                   GLib.file_test(path, GLib.FileTest.IS_SYMLINK);
    if (!isFile) return false;
    return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

function resolveArchiveBinary() {
    if (_archiveBinary) {
        return _archiveBinary;
    }
    // 1. Fixed system paths first — cannot be swapped by a user's PATH.
    for (const path of ARCHIVE_BINARY_PATHS) {
        if (isUsableArchiveBinary(path)) {
            _archiveBinary = path;
            return path;
        }
    }
    // 2. Only then fall back to the user's PATH (unusual install locations).
    for (const name of ARCHIVE_BINARIES) {
        const path = GLib.find_program_in_path(name);
        if (isUsableArchiveBinary(path)) {
            _archiveBinary = path;
            return path;
        }
    }
    return null;
}

// Bytes → UTF-8 string for the decrypted vault payload (unlock) and the
// post-save verify round-trip. TextDecoder is available in the shell's gjs
// (1.72+, mozjs) — it is the same engine the stdoutReader harness runs
// against. A malformed payload does not throw here: it produces U+FFFD and
// fails the JSON.parse / string comparison a step later, as before.
function decodeUtf8(bytes) {
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return '';
    }
}

export class PasswordVaultManager {
    constructor(zipPath) {
        this.zipPath = resolveVaultPath(zipPath);
        this.masterPassword = null;
        this.data = {
            version: 1,
            items: []
        };
        this.unlocked = false;
        this.recentService = null;
        // Operating container: what save() actually writes. Split from the
        // *desired* format (the setting) so the manager can always answer to
        // the content: after unlock this field mirrors the archive really on
        // disk, and the file name is aligned to it.
        this.archiveFormat7z = false;
        this._desiredFormat7z = false;
        // Optional callback wired by the extension: fired when the vault file
        // is renamed / converted, so the stored path and the user-facing
        // notification stay honest.
        this.onVaultPathChanged = null;
    }

    setZipPath(pathStr) {
        this.zipPath = resolveVaultPath(pathStr);
    }

    // The user's *desired* container for the vault (settings toggle). ZIP =
    // false (portable), 7z = true (encrypted headers). It steers what a fresh
    // vault is created as and what a conversion produces; an existing vault is
    // converted when `alignVaultToContent()` runs.
    //
    // W1: `userSet` tells whether the user explicitly picked a format (the
    // key differs from its default). While they never chose one, an existing
    // archive on disk stays the source of truth — a change of the *default*
    // (7z going forward) must not silently convert legacy ZIP vaults. A vault
    // that does not exist yet (new install) follows the setting/default.
    setArchiveFormat(use7z, { userSet = true } = {}) {
        this._desiredFormat7z = !!use7z;
        if (!userSet) {
            const file = Gio.File.new_for_path(this.zipPath);
            if (file.query_exists(null)) {
                this._desiredFormat7z = detectArchiveFormat(this.zipPath) === '7z';
            }
        }
    }

    // True when the vault is open and the on-disk format differs from the
    // one selected in settings — i.e. a conversion should happen now.
    isFormatConversionPending() {
        return this.unlocked && this._desiredFormat7z !== this.archiveFormat7z;
    }

    // Make the on-disk archive "answer to its content": detect the actual
    // container from the file bytes, rename the file so its name matches the
    // format, and — when the user selected another format in settings —
    // convert (rewrite the whole archive) in that format. Best-effort: a
    // failure here never fails the unlock itself or destroys the previous
    // archive; the next save / unlock retries the alignment.
    async alignVaultToContent() {
        const actual = detectArchiveFormat(this.zipPath) === '7z';
        this.archiveFormat7z = actual;

        const aligned = canonicalFormatPath(this.zipPath, actual);
        if (aligned !== this.zipPath) {
            if (GLib.rename(this.zipPath, aligned) < 0) {
                logWarn('Failed to rename vault archive to match its format: ' + aligned);
            } else {
                this.zipPath = aligned;
                this._notifyPathTransition({ renamed: true });
            }
        }

        if (this._desiredFormat7z !== this.archiveFormat7z) {
            const from = this.archiveFormat7z ? '7z' : 'ZIP';
            this.archiveFormat7z = this._desiredFormat7z;
            await this.save(); // rewrites the whole archive in the desired format
            this._notifyPathTransition({ converted: true, from, to: this._desiredFormat7z ? '7z' : 'ZIP' });
        }
    }

    _notifyPathTransition(info) {
        if (this.onVaultPathChanged) {
            try {
                this.onVaultPathChanged(this.zipPath, info);
            } catch (e) {
                logWarn('Vault path transition callback failed:', e);
            }
        }
    }

    isUnlocked() {
        return this.unlocked && this.masterPassword !== null;
    }

    lock() {
        this.masterPassword = null;
        this.unlocked = false;
        this.data = { version: 1, items: [] };
        this.recentService = null;
    }

    async unlock(password) {
        const file = Gio.File.new_for_path(this.zipPath);
        if (!file.query_exists(null)) {
            // Fresh vault (first run or file was deleted): the target
            // directory must be creatable/writable, otherwise a clear error
            // is raised instead of a silent failure.
            this._ensureWritableDirectory(file);

            this.masterPassword = password;
            this.unlocked = true;
            this.data = {
                version: 1,
                items: []
            };
            // A freshly created vault uses the format selected in settings,
            // and save() aligns the archive name to it (storage.7z, not a
            // `.zip`-named 7z archive).
            this.archiveFormat7z = this._desiredFormat7z;
            await this.save();
            return true;
        }

        // Existing file: resolve obvious path/writability problems up front,
        // with messages the unlock dialog can display as-is.
        if (this._isDirectory(file)) {
            throw new Error(_('The password vault path points to a directory.') + '\n' + this.zipPath);
        }
        if (this._isReadOnly(file)) {
            throw new Error(_('The password vault file is read-only and cannot be updated.') + '\n' + this.zipPath);
        }

        // P1.3: cheap on-disk pre-check — stop archive bombs before 7-Zip even
        // unpacks them. The mid-stream byte cap (streamStdoutWithLimit, below)
        // is the second line of defense once decompression starts.
        let archiveSize = 0;
        try {
            archiveSize = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
                .get_size();
        } catch (e) {
            // stat failed (unlikely: the file passed the existence/read/write
            // checks above) — let the subsequent flow surface the real error.
        }
        if (archiveSize > MAX_VAULT_ARCHIVE_BYTES) {
            throw new Error(_('The vault archive is too large.') + '\n' + this.zipPath);
        }

        const archiveBinary = resolveArchiveBinary();
        if (!archiveBinary) {
            throw new Error(_('7-Zip (7z, 7za or 7zz) is not installed.') + '\n' + _('Install 7-Zip (7zip or p7zip-full) and restart the shell.'));
        }

        let proc;
        try {
            proc = new Gio.Subprocess({
                // No `-p` here: for an encrypted archive 7-Zip asks for the
                // password and reads it from stdin. Passing the master
                // password on the command line (argv) would leak it into the
                // process list (`ps aux`), so it is sent via the stdin pipe.
                argv: [archiveBinary, 'x', '-so', this.zipPath],
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
        } catch (e) {
            // Gio.Subprocess throws when the binary cannot be spawned.
            throw new Error(_('7-Zip (7z, 7za or 7zz) is not installed.') + '\n' + _('Install 7-Zip (7zip or p7zip-full) and restart the shell.'));
        }

        return streamStdoutWithLimit(proc, {
            // W2 (P1.2): the byte ceiling is enforced MID-STREAM — the
            // process is force-killed the moment stdout surpasses it, before
            // the shell can ever buffer an archive bomb into memory.
            maxBytes: MAX_VAULT_JSON_BYTES,
            // W3 (P1.3): hard runtime ceiling — a hung 7-Zip cannot block the
            // unlock flow forever.
            timeoutMs: SEVENZ_TIMEOUT_MS,
            // Send the master password via stdin, never argv.
            input: `${password}\n`
        }).then(async ({exitStatus, data, stderr}) => {
            if (exitStatus !== 0) {
                // Raw 7-Zip stderr is only logged for debugging: it can
                // leak internal archive member names into the UI, which
                // the user must never see.
                if (stderr) logWarn('7z unlock stderr:', stderr.trim());
                throw new Error(this._unlockFailureHint());
            }

            // W2 step 2: streamStdoutWithLimit capped the BYTE count
            // mid-stream; the UTF-16 check below is the semantic ceiling on
            // the decoded string (for ASCII bytes ≥ chars; for multibyte
            // payloads the byte cap was the stricter one — both are honouring
            // the same MAX_VAULT_JSON_BYTES bound).
            const stdout = decodeUtf8(data);
            if (stdout.length > MAX_VAULT_JSON_BYTES) {
                throw new Error(_('The vault archive contains too much data.'));
            }

            let parsedData;
            try {
                parsedData = JSON.parse(stdout);
            } catch (e) {
                throw new Error(_('The vault archive does not contain valid JSON data.'));
            }

            // Validate + bound the payload BEFORE committing state: an
            // oversized or malformed archive must reject the unlock
            // without leaving the vault half-unlocked with stale data
            // (P1.3). Any _normalizeVaultData Error is already a
            // user-readable message, so it is passed through as-is.
            let normalized;
            try {
                normalized = this._normalizeVaultData(parsedData);
            } catch (e) {
                throw e;
            }
            this.masterPassword = password;
            this.unlocked = true;
            this.data = normalized;
            // Align the on-disk archive with its content (rename to a
            // matching name, convert to the selected format) without
            // failing the unlock — the vault data is already loaded.
            // Awaited (not fire-and-forget) so a conversion save can
            // never race a save the user triggers right after unlock.
            try {
                await this.alignVaultToContent();
            } catch (err) {
                logWarn('Vault content alignment failed:', err);
            }
            // P2.2: a save that died mid-way (crash / kill / power loss)
            // leaves temp artifacts behind — clean up ours now that the
            // vault is unlocked, so read-only sessions also self-heal.
            this._cleanupStaleTemp();
            return true;
        }).catch(e => {
            // Map streamReader rejection codes to user-facing errors; anything
            // else (JSON / normalize failures) already carries its message.
            if (e && e.code === 'timeout')
                throw new Error(_('7-Zip did not finish in time (timeout). Try again.'));
            if (e && e.code === 'too-large')
                throw new Error(_('The vault archive contains too much data.'));
            if (e && e.code === 'read-error')
                throw new Error(this._unlockFailureHint());
            throw e;
        });
    }

    async save() {
        if (!this.unlocked || !this.masterPassword) {
            throw new Error(_('The password vault is locked.'));
        }

        // P2.2: remove temp artifacts a previous save may have left behind
        // (crash / kill / power loss) before writing anything new.
        this._cleanupStaleTemp();

        const zipFile = Gio.File.new_for_path(this.zipPath);
        // The archive name always follows the container: if the active format
        // is 7z but the path still ends in `.zip` (or vice versa), the new
        // archive is written under the matching name and this.zipPath / the
        // stored setting are updated after the atomic rename.
        const targetPath = canonicalFormatPath(this.zipPath, this.archiveFormat7z);

        // Validate the target before touching anything, so misuse of the
        // "Password Vault File Path" setting surfaces as a clear error.
        if (this._isDirectory(zipFile)) {
            throw new Error(_('The password vault path points to a directory.') + '\n' + this.zipPath);
        }
        this._ensureWritableDirectory(zipFile);
        if (zipFile.query_exists(null) && this._isReadOnly(zipFile)) {
            throw new Error(_('The password vault file is read-only and cannot be updated.') + '\n' + this.zipPath);
        }

        if (zipFile.query_exists(null)) {
            const bakFile = Gio.File.new_for_path(this.zipPath + '.bak');
            try {
                zipFile.copy(bakFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                // `copy` creates the .bak with 0644/0664 (umask); the backup
                // is a full copy of the encrypted vault — tighten it to 0600.
                bakFile.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                logWarn('Failed to create backup:', e);
            }
        }

        // Private temporary directory for the plaintext JSON. `dir_make_tmp`
        // creates it inside G_TMP_DIR with mode 0700, so no other local user
        // can read or even list the file while `7z a` is packing it (the
        // previous flat `ci_vault_<ts>.json` in /tmp was world-readable
        // ~0644). The template is a bare basename without any "XXXXXX"
        // substitution of its own.
        const tmpSubDir = GLib.dir_make_tmp('ci_vault_XXXXXX');
        const tmpSubDirFile = Gio.File.new_for_path(tmpSubDir);
        const dataJsonPath = GLib.build_filenamev([tmpSubDir, VAULT_MEMBER_NAME]);
        const dataJsonFile = Gio.File.new_for_path(dataJsonPath);

        // Remove the private dir again on any early failure (and in the
        // `7z a` callback) so no plaintext JSON is left behind in /tmp.
        const cleanupTmp = () => {
            try {
                dataJsonFile.delete(null);
            } catch (e) {
            }
            try {
                tmpSubDirFile.delete(null);
            } catch (e) {
            }
        };

        let jsonStr;
        try {
            // Always serialize a sanitized copy so empty/false fields never
            // reappear in the stored JSON (e.g. after hand-editing a file).
            jsonStr = JSON.stringify({
                version: this.data.version || 1,
                items: (this.data.items || []).map(it => this._sanitizeItem(it))
            }, null, 2);
            const stream = dataJsonFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
            stream.write_all(jsonStr, null);
            stream.close(null);
            // Belt & suspenders on top of the 0700 dir: the JSON itself is
            // readable by the owner only. A failure here (exotic filesystem)
            // must not abort the save — the private dir already shields it.
            try {
                dataJsonFile.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
            } catch (chmodErr) {
                logWarn('Failed to tighten temp vault JSON permissions:', chmodErr);
            }
        } catch (e) {
            cleanupTmp();
            throw e;
        }

        // Write the new archive to a temporary file *next to the destination*
        // (same directory ⇒ same filesystem), then atomically rename it into
        // place. If the machine crashes / loses power mid-`7z a`, the previous
        // archive and its .bak stay intact — unlike the old delete-then-write
        // flow, which left a window where `this.zipPath` was missing or half
        // written. A unique name also keeps `7z a` from updating a stale tmp
        // archive, so the result always contains exactly one member.
        const tmpArchivePath = targetPath + '.tmp-' + Date.now();
        const tmpArchiveFile = Gio.File.new_for_path(tmpArchivePath);
        const cleanupTmpArchive = () => {
            try {
                tmpArchiveFile.delete(null);
            } catch (e) {
            }
        };

        const archiveBinary = resolveArchiveBinary();
        if (!archiveBinary) {
            cleanupTmpArchive();
            cleanupTmp();
            throw new Error(_('7-Zip (7z, 7za or 7zz) is not installed.') + '\n' + _('Install 7-Zip (7zip or p7zip-full) and restart the shell.'));
        }

        let proc;
        try {
            proc = new Gio.Subprocess({
                // `-p` with no value makes 7-Zip read the password from
                // stdin, so the master password never appears in argv /
                // the process list.
                // ZIP (compatibility): `-tzip -mem=AES256` (WinZip AES,
                // PBKDF2-HMAC-SHA1) instead of the default ZipCrypto, which
                // is attackable via known-plaintext. Portable — any ZIP tool
                // can open the archive — but the member name ("data.json")
                // and sizes are visible.
                // 7z (default): `-t7z -mhe=on` — AES-256 with encrypted
                // headers, so the member name and sizes stay hidden;
                // reading it requires 7z support (`7z`, `7za` or `7zz`).
                argv: [archiveBinary, 'a',
                       this.archiveFormat7z ? '-t7z' : '-tzip',
                       this.archiveFormat7z ? '-mhe=on' : '-mem=AES256',
                       '-p', '-y', tmpArchivePath, dataJsonPath],
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
        } catch (e) {
            cleanupTmpArchive();
            cleanupTmp();
            throw new Error(_('7-Zip (7z, 7za or 7zz) is not installed.') + '\n' + _('Install 7-Zip (7zip or p7zip-full) and restart the shell.'));
        }

        return streamStdoutWithLimit(proc, {
            // W3 (P1.3): a hung `7z a` must not block the save flow — same
            // hard deadline as unlock/verify. `7z a` writes only a few banner
            // lines to stdout; the cap is generous and only ever fires on a
            // pathologically broken binary.
            maxBytes: MAX_VAULT_ARCHIVE_BYTES,
            timeoutMs: SEVENZ_TIMEOUT_MS,
            input: `${this.masterPassword}\n`
        }).then(async ({exitStatus, stderr}) => {
            cleanupTmp();

            if (exitStatus !== 0) {
                // Same as unlock(): raw stderr goes to the (gated) log
                // only, never into a user-facing message.
                if (stderr) logWarn('7z save stderr:', stderr.trim());
                cleanupTmpArchive();
                throw new Error(_('Failed to update the password vault archive.'));
            }

            // `7z a` creates/recreates the archive with 0644/0664
            // (umask) — tighten it to 0600 so other local users
            // cannot read (and offline-crack) the encrypted vault.
            try {
                tmpArchiveFile.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
            } catch (chmodErr) {
                logWarn('Failed to tighten vault archive permissions:', chmodErr);
            }

            // Verify the freshly packed archive *before* it can
            // replace the previous one: correct container magic,
            // and it decrypts back to exactly what we serialized.
            // A `7z a` that died mid-write or produced an empty /
            // truncated archive (e.g. a 0-byte file after a drive
            // hiccup) is caught here, and the previous archive +
            // .bak are left untouched.
            const verified = await this._verifyArchiveWrite(
                tmpArchivePath, this.archiveFormat7z, jsonStr);
            if (!verified) {
                cleanupTmpArchive();
                logWarn('Vault archive verification failed — previous archive kept.');
                throw new Error(_('Failed to update the password vault archive.'));
            }

            // Atomic replacement: same directory ⇒ same filesystem,
            // so GLib.rename cannot fail with EXDEV. On any other
            // failure the previous archive is left untouched.
            if (GLib.rename(tmpArchivePath, targetPath) < 0) {
                cleanupTmpArchive();
                logWarn('Failed to atomically replace the vault archive.');
                throw new Error(_('Failed to update the password vault archive.'));
            }
            if (targetPath !== this.zipPath) {
                // The archive now lives under a name that matches
                // its format: keep the manager and the stored
                // setting in sync so the next unlock does not look
                // for a fresh vault at the stale path.
                this.zipPath = targetPath;
                this._notifyPathTransition({ pathChanged: true });
            }
            return true;
        }).catch(e => {
            // A stream-level kill (timeout / stdout overflow) or any tail
            // failure (chmod, verify, rename) all land here: the tmp archive
            // and the plaintext JSON must never survive a failed save, and the
            // user gets the generic save error (or the explicit timeout
            // message) — never raw 7-Zip output.
            cleanupTmp();
            cleanupTmpArchive();
            if (e && e.code === 'timeout')
                throw new Error(_('7-Zip did not finish in time (timeout). Try again.'));
            if (e && e.code === 'too-large')
                throw new Error(_('Failed to update the password vault archive.'));
            if (e && e.code === 'read-error') {
                logWarn('7z save stream read error:', e);
                throw new Error(_('Failed to update the password vault archive.'));
            }
            logWarn('Vault save tail failed:', e);
            throw e;
        });
    }

    // ---------------------------------------------------------------- helpers

    // Ensure the parent directory of `file` exists (created on demand) and is
    // writable, throwing a user-facing error otherwise.
    _ensureWritableDirectory(file) {
        const parent = file.get_parent();
        if (!parent) {
            return;
        }
        if (!parent.query_exists(null)) {
            try {
                parent.make_directory_with_parents(null);
                // A freshly created vault directory is private by default
                // (0700 instead of 0755). Pre-existing directories are left
                // untouched — only the files inside are hardened.
                try {
                    parent.set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
                } catch (chmodErr) {
                    logWarn('Failed to tighten vault directory permissions:', chmodErr);
                }
            } catch (e) {
                throw new Error(_('Cannot create the password vault directory.') + '\n' + parent.get_path());
            }
        }
        if (this._isReadOnly(parent)) {
            throw new Error(_('The password vault directory is not writable.') + '\n' + parent.get_path());
        }
    }

    _isReadOnly(file) {
        try {
            const info = file.query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null);
            if (info) {
                return !info.get_attribute_boolean('access::can-write');
            }
        } catch (e) {
        }
        return false;
    }

    _isDirectory(file) {
        try {
            return file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY;
        } catch (e) {
            return false;
        }
    }

    // P2.2: remove temporary artifacts left behind by a save that died mid-way
    // (crash / kill / power loss). The normal cleanup callbacks always run on
    // the success and failure paths, but not on abnormal termination, so two
    // kinds of leftovers can survive:
    //   * in the system temp dir: the private `ci_vault_XXXXXX` directory with
    //     the plaintext JSON, plus legacy flat `ci_vault_<ts>.json` files from
    //     older versions of the extension;
    //   * next to the archive: `<vault>.tmp-<ts>` encrypted half-written
    //     archives from an atomic save that never reached the rename.
    // Deleting is strictly scoped: only this extension's exact naming patterns
    // AND entries older than STALE_TEMP_MIN_AGE_MS qualify, so a live write or
    // an arbitrary file can never be touched. Best-effort — never throws; a
    // failure is logged and the caller proceeds.
    _cleanupStaleTemp() {
        const now = Date.now();
        // Gio has no recursive delete in this environment, so remove the
        // contents first, then the entry itself. Symbolic links are never
        // followed (their type is SYMBOLIC_LINK, and delete removes the link).
        const removeRecursive = (file) => {
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
                    while ((info = kids.next_file(null)) !== null) {
                        removeRecursive(file.get_child(info.get_name()));
                    }
                } catch (e) {
                }
            }
            try {
                file.delete(null);
            } catch (e) {
            }
        };
        const tryDelete = (file) => {
            try {
                removeRecursive(file);
            } catch (e) {
                logWarn('Failed to remove stale temp artifact:', e);
            }
        };

        // Collect first, delete after iteration — never mutate a directory
        // while enumerating it.
        const sweep = (dirPath, isCandidate) => {
            const doomed = [];
            try {
                const dir = Gio.File.new_for_path(dirPath);
                if (!dir.query_exists(null)) {
                    return;
                }
                const kids = dir.enumerate_children('standard::name,time::modified',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = kids.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (!isCandidate(info, name)) {
                        continue;
                    }
                    const ageMillis = now - info.get_modification_date_time().to_unix() * 1000;
                    if (ageMillis < STALE_TEMP_MIN_AGE_MS) {
                        continue; // younger than the guard — treat as a live write
                    }
                    doomed.push(dir.get_child(name));
                }
            } catch (e) {
                logWarn('Stale temp cleanup failed in', dirPath, ':', e);
                return;
            }
            for (const file of doomed) {
                tryDelete(file);
            }
        };

        // 1) Plaintext JSON leftovers in the system temp dir. The current
        //    format is a private directory `ci_vault_XXXXXX` (dir_make_tmp
        //    pattern); earlier versions wrote flat `ci_vault_<ts>.json`.
        sweep(GLib.get_tmp_dir(), (info, name) => {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                return /^ci_vault_[A-Za-z0-9]{6}$/.test(name);
            }
            return /^ci_vault_\d+\.json$/.test(name);
        });

        // 2) Encrypted half-written temp archives next to the destination.
        const zipFile = Gio.File.new_for_path(this.zipPath);
        const parent = zipFile.get_parent();
        if (!parent) {
            return;
        }
        const archiveName = zipFile.get_basename();
        sweep(parent.get_path(), (info, name) => {
            if (!name.startsWith(archiveName + '.tmp-')) {
                return false;
            }
            return /^\d+$/.test(name.slice(archiveName.length + '.tmp-'.length));
        });
    }

    // Turn a failed decrypt / corrupt-archive error into a message that
    // actually helps: an empty (0-byte) file — e.g. a save that died
    // mid-write on a failing drive — gets an explicit "restore" hint, and a
    // surviving `.bak` is pointed out so the user can recover manually.
    _unlockFailureHint() {
        let msg = _('Wrong password or corrupted vault archive.');
        try {
            const f = Gio.File.new_for_path(this.zipPath);
            const size = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
                .get_size();
            if (size === 0) {
                msg += '\n' + _('The vault file is empty (0 bytes). Restore it from the .bak file or a backup.');
            } else if (Gio.File.new_for_path(this.zipPath + '.bak').query_exists(null)) {
                msg += '\n' + _('A previous version exists as a .bak file next to the archive — restore it manually.');
            }
        } catch (e) {
        }
        return msg;
    }

    // Confirm that a freshly packed archive is (a) really the requested
    // container (magic bytes in the header) and (b) decrypts back to exactly
    // the JSON that was just serialized. Resolves false on any failure — the
    // caller then keeps the previous archive instead of replacing it with a
    // bad (possibly 0-byte) one.
    _verifyArchiveWrite(archivePath, use7z, expectedJson) {
        if (detectArchiveFormat(archivePath) !== (use7z ? '7z' : 'zip')) {
            return Promise.resolve(false);
        }
        const binary = resolveArchiveBinary();
        if (!binary) {
            return Promise.resolve(false);
        }
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv: [binary, 'x', '-so', archivePath],
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
        } catch (e) {
            return Promise.resolve(false);
        }
        return streamStdoutWithLimit(proc, {
            maxBytes: MAX_VAULT_JSON_BYTES,
            timeoutMs: SEVENZ_TIMEOUT_MS,
            input: `${this.masterPassword}\n`
        }).then(({exitStatus, data, stderr}) => {
            if (exitStatus !== 0) {
                if (stderr) logWarn('7z verify stderr:', stderr.trim());
                return false;
            }
            // Same decode as unlock: byte cap already enforced mid-stream;
            // the string comparison is exact (===), never a prefix check.
            return decodeUtf8(data) === expectedJson;
        }).catch(e => {
            // Timeout / overflow / pipe failure on the *fresh tmp archive*
            // also means "not verified": the previous archive stays in place.
            logWarn('7z verify failed:', e);
            return false;
        });
    }

    getCategories() {
        // Categories are derived dynamically from the items themselves,
        // in order of first appearance (newest items first).
        const seen = [];
        (this.data.items || []).forEach(item => {
            const cat = item.category;
            if (cat && !seen.includes(cat)) {
                seen.push(cat);
            }
        });
        return seen;
    }

    getItems(query = '', category = '') {
        let items = this.data.items || [];

        if (category && category !== ALL_CATEGORY) {
            items = items.filter(item => item.category === category);
        }

        if (query) {
            const q = query.toLowerCase();
            items = items.filter(item => {
                const matchName = item.name && item.name.toLowerCase().includes(q);
                const matchLogin = item.login && item.login.toLowerCase().includes(q);
                const matchCategory = item.category && item.category.toLowerCase().includes(q);
                const matchDescription = item.description && item.description.toLowerCase().includes(q);
                const matchExtra = item.extraFields && item.extraFields.some(f =>
                    (f.label && f.label.toLowerCase().includes(q)) ||
                    (f.value && f.value.toLowerCase().includes(q))
                );
                return matchName || matchLogin || matchCategory || matchDescription || matchExtra;
            });
        }

        return items;
    }

    // P1.3 + P2.4: turn raw parsed-unlock payload into a bounded, trusted
    // shape. The README explicitly allows hand-editing data.json, so the
    // policy is two-sided:
    //   * P1.3 caps (items count, per-field length, per-item extra-field
    //     count) and an unsupported format version REJECT with a user-readable
    //     Error — never silent truncation;
    //   * P2.4 malformed TYPES are coerced and fixed (see _sanitizeItem),
    //     non-object item entries are dropped — a broken hand-edit must not
    //     lock the user out of the vault or crash with a raw TypeError.
    // Called BEFORE the manager commits unlocked state, so a rejected payload
    // never leaves the vault half-unlocked.
    _normalizeVaultData(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            throw new Error(_('The vault archive contains invalid data.'));
        }
        if (!Array.isArray(parsed.items)) {
            throw new Error(_('The vault archive contains invalid data.'));
        }
        if (parsed.items.length > MAX_VAULT_ITEMS) {
            throw new Error(_('The vault contains too many items (max 1000).'));
        }
        const items = [];
        for (const raw of parsed.items) {
            const it = this._sanitizeItem(raw);
            if (it) items.push(it); // non-object garbage is dropped, not fatal
        }
        const version = typeof parsed.version === 'number' ? parsed.version : 1;
        if (version > 1) {
            throw new Error(_('The vault archive uses an unsupported format version.'));
        }
        return {
            // version < 1 / NaN → legacy default (old code treated 0 as 1)
            version: version >= 1 ? version : 1,
            // Missing/duplicated ids (a common outcome of hand-editing data.json:
            // omitted id, or copy-pasted records) are made unique here — every
            // record survives, no card is lost.
            items: this._normalizeIds(items)
        };
    }

    // Build a minimal item object: empty/false fields are omitted entirely so
    // the stored JSON stays clean and easy to edit by hand or with other tools.
    //
    // P2.4 — the README explicitly allows hand-editing data.json, so this
    // COERCES AND FIXES malformed entries instead of crashing:
    //   * a non-object entry (null / string / number / array) returns null —
    //     _normalizeVaultData drops it, garbage carries no card data;
    //   * name / id / category / description / login / password / extra
    //     label&value are coerced to strings; updatedAt is kept only when it
    //     is a finite number; isHidden is coerced to boolean;
    //   * P1.3 caps still REJECT (never silent truncation): a field longer
    //     than MAX_FIELD_LENGTH or more than MAX_EXTRA_FIELDS extra fields
    //     rejects the whole load.
    _sanitizeItem(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return null;
        }
        const capField = (value) => {
            if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
                throw new Error(_('A vault item contains a field that is too long.'));
            }
            return value;
        };
        // Coerce a value to a string, treating absent values as empty.
        const str = (v) => (v === undefined || v === null) ? '' : String(v);
        const optTrim = (v) => str(v).trim();

        const rawId = str(data.id);
        const name = str(data.name);
        const item = {
            id: rawId ? capField(rawId) : this._generateId(),
            name: name ? capField(name) : _('Untitled'),
            updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : Date.now()
        };
        const category = optTrim(data.category);
        if (category) item.category = capField(category);
        const description = optTrim(data.description);
        if (description) item.description = capField(description);
        const login = optTrim(data.login);
        if (login) item.login = capField(login);
        const password = str(data.password);
        if (password) item.password = capField(password);
        if (Array.isArray(data.extraFields)) {
            // Non-object extra entries (null, strings…) are junk — skipped.
            const extras = data.extraFields
                .filter(f => f && typeof f === 'object' && !Array.isArray(f))
                .map(f => {
                    const e = {};
                    const label = optTrim(f.label);
                    if (label) e.label = capField(label);
                    // Keep the stored value verbatim (no trim): leading/trailing
                    // invisible junk must survive so the (opt-in) edge-warning
                    // icon in the card can flag it. Only the label is trimmed.
                    if (f.value !== undefined && f.value !== null && str(f.value).trim() !== '') {
                        e.value = capField(str(f.value));
                    }
                    if (f.isHidden) e.isHidden = true;
                    return e;
                })
                .filter(f => f.label || f.value);
            // The cap applies to the *normalized* list (empty entries are
            // dropped first), so a record with junk extra fields is not
            // penalised for them.
            if (extras.length > MAX_EXTRA_FIELDS) {
                throw new Error(_('A vault item contains too many extra fields.'));
            }
            if (extras.length > 0) item.extraFields = extras;
        }
        return item;
    }

    // Generate a fresh service id. `seen` (optional) contains the ids already
    // taken, so the caller can enforce uniqueness on the first try; the
    // `do/while` guard makes collisions impossible even without it.
    _generateId(seen = new Set()) {
        let id;
        do {
            id = `service_${Date.now()}_${cryptoRandomInt(1000000000)}`;
        } while (seen.has(id));
        return id;
    }

    // Enforce the "unique id" invariant on data coming from outside the
    // extension (hand-edited vault JSON). A record without an id is loaded
    // as-is with a freshly generated id; a record that collides with an
    // earlier one gets a fresh id too — both cards survive, and id-based
    // operations (edit / delete / recent-service) keep pointing at exactly
    // one record instead of silently affecting both.
    _normalizeIds(items) {
        const seen = new Set();
        for (const item of items) {
            if (!item.id || seen.has(item.id)) {
                item.id = this._generateId(seen);
            }
            seen.add(item.id);
        }
        return items;
    }

    async addService(itemData) {
        const item = this._sanitizeItem(itemData);
        if (!item) {
            throw new Error(_('The vault archive contains invalid data.'));
        }
        // The edit dialog never submits an id, so this is defensive: never
        // let a freshly created record collide with an existing id.
        const ids = new Set(this.data.items.map(i => i.id));
        if (ids.has(item.id)) {
            item.id = this._generateId(ids);
        }
        this.data.items.unshift(item);
        await this.save();
        return item;
    }

    async updateService(id, updatedData) {
        const index = this.data.items.findIndex(item => item.id === id);
        if (index === -1) return null;

        const existing = this.data.items[index];
        const updated = this._sanitizeItem(
            { ...existing, ...updatedData, updatedAt: Date.now() }
        );
        if (!updated) {
            throw new Error(_('The vault archive contains invalid data.'));
        }
        this.data.items[index] = updated;

        if (this.recentService && this.recentService.id === id) {
            this.recentService = { ...updated };
        }

        await this.save();
        return updated;
    }

    async deleteService(id) {
        this.data.items = this.data.items.filter(item => item.id !== id);
        if (this.recentService && this.recentService.id === id) {
            this.recentService = null;
        }
        await this.save();
    }

    setRecentService(item) {
        if (!item) {
            this.recentService = null;
            return;
        }
        this.recentService = { ...item };
    }
}
