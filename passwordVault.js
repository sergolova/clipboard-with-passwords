import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

export class PasswordVaultManager {
    constructor(zipPath) {
        this.zipPath = resolveVaultPath(zipPath);
        this.masterPassword = null;
        this.data = {
            version: 1,
            categories: ['Общее', 'Работа', 'Личное'],
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
        this.data = { version: 1, categories: ['Общее'], items: [] };
        this.recentService = null;
    }

    async unlock(password) {
        const file = Gio.File.new_for_path(this.zipPath);
        if (!file.query_exists(null)) {
            this.masterPassword = password;
            this.unlocked = true;
            this.data = {
                version: 1,
                categories: ['Общее', 'Работа', 'Личное'],
                items: []
            };
            await this.save();
            return true;
        }

        const proc = new Gio.Subprocess({
            argv: ['7z', 'x', `-p${password}`, '-so', this.zipPath],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });

        proc.init(null);

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const status = proc.get_exit_status();
                    if (status !== 0) {
                        reject(new Error(stderr || 'Wrong password or corrupt archive'));
                        return;
                    }

                    let parsedData;
                    try {
                        parsedData = JSON.parse(stdout);
                    } catch (e) {
                        reject(new Error('Archive does not contain valid JSON data'));
                        return;
                    }

                    this.masterPassword = password;
                    this.unlocked = true;
                    this.data = {
                        version: parsedData.version || 1,
                        categories: parsedData.categories || ['Общее'],
                        items: parsedData.items || []
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
            throw new Error('Vault is locked');
        }

        const zipFile = Gio.File.new_for_path(this.zipPath);
        const parentDir = zipFile.get_parent();
        if (parentDir && !parentDir.query_exists(null)) {
            parentDir.make_directory_with_parents(null);
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

        const jsonStr = JSON.stringify(this.data, null, 2);
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
            zipFile.delete(null);
        }

        const proc = new Gio.Subprocess({
            argv: ['7z', 'a', '-tzip', `-p${this.masterPassword}`, '-y', this.zipPath, passwordsJsonPath],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });

        proc.init(null);

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    passwordsJsonFile.delete(null);
                    tmpSubDirFile.delete(null);
                } catch (e) {
                }

                try {
                    const [, , stderr] = proc.communicate_utf8_finish(res);
                    const status = proc.get_exit_status();
                    if (status !== 0) {
                        reject(new Error(stderr || 'Failed to update zip archive'));
                        return;
                    }
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    getCategories() {
        return this.data.categories || ['Общее'];
    }

    addCategory(categoryName) {
        if (!categoryName) return;
        categoryName = categoryName.trim();
        if (!this.data.categories.includes(categoryName)) {
            this.data.categories.push(categoryName);
            this.save();
        }
    }

    getItems(query = '', category = '') {
        let items = this.data.items || [];

        if (category && category !== 'Все') {
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

    async addService(itemData) {
        const item = {
            id: `service_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: itemData.name || 'Новый сервис',
            category: itemData.category || 'Общее',
            description: itemData.description || '',
            login: itemData.login || '',
            password: itemData.password || '',
            extraFields: itemData.extraFields || [],
            updatedAt: Date.now()
        };

        this.addCategory(item.category);
        this.data.items.unshift(item);
        await this.save();
        return item;
    }

    async updateService(id, updatedData) {
        const index = this.data.items.findIndex(item => item.id === id);
        if (index === -1) return null;

        const existing = this.data.items[index];
        const updated = {
            ...existing,
            ...updatedData,
            id: existing.id,
            updatedAt: Date.now()
        };

        if (updated.category) {
            this.addCategory(updated.category);
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
