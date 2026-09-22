import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Internal sentinel for the pseudo-category "All". It is deliberately NOT the
// translated word (e.g. 'Все'/'All'): such a word could collide with a real
// user category, and translations belong only to the button label in the UI.
export const ALL_CATEGORY = '__all__';

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

    let res = '';
    if (useUpper) res += upper[Math.floor(Math.random() * upper.length)];
    if (useLower) res += lower[Math.floor(Math.random() * lower.length)];
    if (useDigits) res += digits[Math.floor(Math.random() * digits.length)];
    if (useSymbols) res += symbols[Math.floor(Math.random() * symbols.length)];

    while (res.length < length) {
        res += chars[Math.floor(Math.random() * chars.length)];
    }

    return res.split('').sort(() => Math.random() - 0.5).join('');
}

export function resolveVaultPath(pathStr) {
    if (!pathStr) {
        pathStr = '~/.config/clipboard-indicator/passwords.zip';
    }
    if (pathStr.startsWith('~')) {
        pathStr = GLib.get_home_dir() + pathStr.slice(1);
    }
    return pathStr;
}

// Archive backends to use for the encrypted ZIP vault, in order of
// preference. The full `7z` (p7zip-full) is the primary backend; the
// standalone `7za` (p7zip) is used as a fallback when `7z` is absent.
// `7zr` is deliberately NOT probed: it only understands the native .7z
// format and reports "Unsupported archive type" for ZIP archives.
const ARCHIVE_BINARIES = ['7z', '7za'];

// Cached so we don't re-probe PATH on every unlock/save. Only a *found*
// binary is cached — a null result is re-probed each time so a binary
// installed after the shell started is picked up.
let _archiveBinary = null;

function resolveArchiveBinary() {
    if (_archiveBinary) {
        return _archiveBinary;
    }
    for (const name of ARCHIVE_BINARIES) {
        if (GLib.find_program_in_path(name)) {
            _archiveBinary = name;
            return name;
        }
    }
    return null;
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
    }

    setZipPath(pathStr) {
        this.zipPath = resolveVaultPath(pathStr);
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

        const archiveBinary = resolveArchiveBinary();
        if (!archiveBinary) {
            throw new Error(_('7-Zip (7z or 7za) is not installed.') + '\n' + _('Install 7-Zip (p7zip-full or p7zip) and restart the shell.'));
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
            throw new Error(_('7-Zip (7z or 7za) is not installed.') + '\n' + _('Install 7-Zip (p7zip-full or p7zip) and restart the shell.'));
        }

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(`${password}\n`, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const status = proc.get_exit_status();
                    if (status !== 0) {
                        reject(new Error(_('Wrong password or corrupted vault archive.') + '\n' + (stderr || '').trim()));
                        return;
                    }

                    let parsedData;
                    try {
                        parsedData = JSON.parse(stdout);
                    } catch (e) {
                        reject(new Error(_('The vault archive does not contain valid JSON data.')));
                        return;
                    }

                    this.masterPassword = password;
                    this.unlocked = true;
                    // Re-sanitize on load so legacy or hand-edited items get
                    // cleaned the next time the vault is saved.
                    this.data = {
                        version: parsedData.version || 1,
                        items: (parsedData.items || []).map(it => this._sanitizeItem(it, it && it.id))
                    };
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async save() {
        if (!this.unlocked || !this.masterPassword) {
            throw new Error(_('The password vault is locked.'));
        }

        const zipFile = Gio.File.new_for_path(this.zipPath);

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
            } catch (e) {
                console.warn('Failed to create backup:', e);
            }
        }

        const tmpDir = GLib.get_tmp_dir();
        const tmpJsonPath = GLib.build_filenamev([tmpDir, `ci_vault_${Date.now()}.json`]);
        const tmpFile = Gio.File.new_for_path(tmpJsonPath);

        // Always serialize a sanitized copy so empty/false fields never
        // reappear in the stored JSON (e.g. after hand-editing a file).
        const jsonStr = JSON.stringify({
            version: this.data.version || 1,
            items: (this.data.items || []).map(it => this._sanitizeItem(it, it && it.id))
        }, null, 2);
        const stream = tmpFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
        stream.write_all(jsonStr, null);
        stream.close(null);

        const tmpSubDir = GLib.build_filenamev([tmpDir, `ci_vault_dir_${Date.now()}`]);
        const tmpSubDirFile = Gio.File.new_for_path(tmpSubDir);
        tmpSubDirFile.make_directory_with_parents(null);

        const passwordsJsonPath = GLib.build_filenamev([tmpSubDir, 'passwords.json']);
        const passwordsJsonFile = Gio.File.new_for_path(passwordsJsonPath);
        tmpFile.move(passwordsJsonFile, Gio.FileCopyFlags.OVERWRITE, null, null);

        if (zipFile.query_exists(null)) {
            try {
                zipFile.delete(null);
            } catch (e) {
                throw new Error(_('Failed to update the password vault archive.') + '\n' + (e && e.message ? e.message : ''));
            }
        }

        const archiveBinary = resolveArchiveBinary();
        if (!archiveBinary) {
            throw new Error(_('7-Zip (7z or 7za) is not installed.') + '\n' + _('Install 7-Zip (p7zip-full or p7zip) and restart the shell.'));
        }

        let proc;
        try {
            proc = new Gio.Subprocess({
                // `-p` with no value makes 7-Zip read the password from
                // stdin, so the master password never appears in argv /
                // the process list.
                argv: [archiveBinary, 'a', '-tzip', '-p', '-y', this.zipPath, passwordsJsonPath],
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
        } catch (e) {
            throw new Error(_('7-Zip (7z or 7za) is not installed.') + '\n' + _('Install 7-Zip (p7zip-full or p7zip) and restart the shell.'));
        }

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(`${this.masterPassword}\n`, null, (proc, res) => {
                try {
                    passwordsJsonFile.delete(null);
                    tmpSubDirFile.delete(null);
                } catch (e) {
                }

                try {
                    const [, , stderr] = proc.communicate_utf8_finish(res);
                    const status = proc.get_exit_status();
                    if (status !== 0) {
                        reject(new Error(_('Failed to update the password vault archive.') + '\n' + (stderr || '').trim()));
                        return;
                    }
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
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

    // Build a minimal item object: empty/false fields are omitted entirely so
    // the stored JSON stays clean and easy to edit by hand or with other tools.
    _sanitizeItem(data, id) {
        const item = {
            id: data.id || id || `service_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: data.name || _('Untitled'),
            updatedAt: data.updatedAt || Date.now()
        };
        if (data.category && data.category.trim()) item.category = data.category.trim();
        if (data.description && data.description.trim()) item.description = data.description.trim();
        if (data.login && data.login.trim()) item.login = data.login.trim();
        if (data.password) item.password = data.password;
        if (Array.isArray(data.extraFields)) {
            const extras = data.extraFields
                .map(f => {
                    const e = {};
                    if (f.label && f.label.trim()) e.label = f.label.trim();
                    if (f.value !== undefined && f.value !== null && String(f.value).trim() !== '') {
                        e.value = String(f.value).trim();
                    }
                    if (f.isHidden) e.isHidden = true;
                    return e;
                })
                .filter(f => f.label || f.value);
            if (extras.length > 0) item.extraFields = extras;
        }
        return item;
    }

    async addService(itemData) {
        const item = this._sanitizeItem(itemData);
        this.data.items.unshift(item);
        await this.save();
        return item;
    }

    async updateService(id, updatedData) {
        const index = this.data.items.findIndex(item => item.id === id);
        if (index === -1) return null;

        const existing = this.data.items[index];
        const updated = this._sanitizeItem(
            { ...existing, ...updatedData, updatedAt: Date.now() },
            existing.id
        );

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
