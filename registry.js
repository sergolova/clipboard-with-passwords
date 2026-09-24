import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';
import { logError } from './logging.js';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

export class Registry {
    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
    }

    write (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                const filename = this.getEntryFilename(entry);
                item.contents = filename;
                this.writeEntryFile(entry);
            }

            if (entry.getTag()) item.tag = entry.getTag();
            if (entry.isProtected()) item.protected = true;
        }

        this.writeToFile(registryContent);
    }

    writeToFile (registry) {
        let json = JSON.stringify(registry);
        let contents = new GLib.Bytes(json);

        try {
            GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
            let file = Gio.file_new_for_path(this.REGISTRY_PATH);
            file.replace_contents(contents.get_data(), null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            logError('Clipboard Indicator: failed to write registry file', e);
        }
    }

    async read () {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) {
            return [];
        }

        try {
            let file = Gio.file_new_for_path(this.REGISTRY_PATH);
            let CACHE_FILE_SIZE = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);

            const file_info = file.query_info('*', FileQueryInfoFlags.NONE, null);
            if (file_info && file_info.get_size() >= CACHE_FILE_SIZE * 1024 * 1024) {
                let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);
                file.move(destination, FileCopyFlags.OVERWRITE, null, null);
                return [];
            }

            // Async IO (EGO-X-004): avoid blocking the shell main loop while
            // reading the registry file back at startup.
            const [success, contents] = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (src, res) => {
                    try {
                        resolve(src.load_contents_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (!success || !contents) {
                return [];
            }

            let max_size = this.settings.get_int(PrefsFields.HISTORY_SIZE);
            const cacheTextData = new TextDecoder().decode(contents);
            if (cacheTextData.trim().length === 0) {
                return [];
            }

            const registry = JSON.parse(cacheTextData);
            const entriesPromises = registry.map(jsonEntry => ClipboardEntry.fromJSON(jsonEntry));
            let clipboardEntries = await Promise.all(entriesPromises);
            clipboardEntries = clipboardEntries.filter(entry => entry !== null);

            let registryNoFavorite = clipboardEntries.filter(entry => !entry.isFavorite());
            while (registryNoFavorite.length > max_size) {
                let oldestNoFavorite = registryNoFavorite.shift();
                let itemIdx = clipboardEntries.indexOf(oldestNoFavorite);
                clipboardEntries.splice(itemIdx, 1);
                registryNoFavorite = clipboardEntries.filter(entry => !entry.isFavorite());
            }

            return clipboardEntries;
        } catch (e) {
            logError('Clipboard Indicator: failed to read registry file', e);
            return [];
        }
    }

    #entryFileExists (entry) {
        const filename = this.getEntryFilename(entry);
        return GLib.file_test(filename, FileTest.EXISTS);
    }

    async getEntryAsTexture (entry) {
        if (entry.isImage() === false) return null;

        if (this.#entryFileExists(entry) === false) {
            await this.writeEntryFile(entry);
        }

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.asBytes().hash()}`;
    }

    async writeEntryFile (entry) {
        if (this.#entryFileExists(entry)) return;

        let file = Gio.file_new_for_path(this.getEntryFilename(entry));

        return new Promise(resolve => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                               GLib.PRIORITY_DEFAULT, null, (obj, res) => {

                let stream = obj.replace_finish(res);

                stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT,
                                         null, (w_obj, w_res) => {

                    w_obj.write_bytes_finish(w_res);
                    stream.close(null);
                    resolve();
                });
            });
        });
    }

    async deleteEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));

        try {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
        catch (e) {
            logError(e);
        }
    }

    clearCacheFolder() {

        const CANCELLABLE = null;
        try {
            const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
            const enumerator = folder.enumerate_children("", 1, CANCELLABLE);

            let file;
            while ((file = enumerator.iterate(CANCELLABLE)[2]) != null) {
                file.delete(CANCELLABLE);
            }

        }
        catch (e) {
            logError(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;

    static #decode (contents) {
        return Uint8Array.from(contents.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    }

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        let bytes;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(jsonEntry.contents);
        }
        else {
            const filename = jsonEntry.contents;
            if (!GLib.file_test(filename, FileTest.EXISTS)) return null;

            let file = Gio.file_new_for_path(filename);

            // Load the cached file synchronously. The previous implementation
            // used query_info_async() + load_contents_async() inside a
            // Promise.all(); when many image entries were restored at startup
            // (including multi-MB screenshots), those async callbacks could be
            // dispatched while gjs was sweeping the heap during a major GC.
            // The shell then blocks the JS callback ("Attempting to run a JS
            // callback during garbage collection ... AsyncReadyCallback()"),
            // so the promises never resolve and the shell hangs forever at
            // startup. These are all small local cache files, so blocking is
            // cheap (a few ms each).
            const [, contents] = file.load_contents(null);
            if (!contents)
                return null;
            bytes = contents;
        }

        const entry = new ClipboardEntry(mimetype, bytes, favorite);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        // Legacy registry caches stored this flag as `password`; new caches use
        // `protected`. Accept both so already-protected items stay masked after
        // an upgrade (never unmask persisted data silently).
        if (jsonEntry.protected || jsonEntry.password) entry.setProtected(true);
        return entry;
    }

    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
    }

    #encode () {
        if (this.isText()) {
            return this.getStringValue();
        }

        return [...this.#bytes]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.asBytes().hash()}]`;
        }
        return new TextDecoder().decode(this.#bytes);
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    #isProtected = false;

    isProtected () {
        return this.#isProtected;
    }

    setProtected (val) {
        this.#isProtected = !!val;
    }

    getMaskedValue () {
        const text = this.getStringValue();
        if (text.length <= 3) return '***';
        return text.slice(0, -3) + '***';
    }

    isURIList () {
        return this.#mimetype === 'text/uri-list';
    }

    isURL () {
        if (!this.isText() || this.isURIList()) return false;
        const text = this.getStringValue().trim().toLowerCase();
        return text.startsWith('http://') || text.startsWith('https://');
    }

    isEmail () {
        if (!this.isText() || this.isURIList()) return false;
        const text = this.getStringValue().trim();

        // Быстрая проверка: email не может содержать слэши или начинаться с /
        if (text.includes('/') || text.startsWith('.')) return false;

        // Регулярка с запретом спецсимволов и путей
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

        return emailRegex.test(text);
    }

    isMultiline () {
        if (!this.isText() || this.isURIList()) return false;
        return this.getStringValue().trim().includes('\n');
    }

    isColor () {
        const CSS_NAMED_COLORS = new Set([
            'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
            'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue',
            'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan',
            'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
            'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
            'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
            'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
            'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
            'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
            'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
            'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
            'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink',
            'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey',
            'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta',
            'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
            'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
            'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
            'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered',
            'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
            'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
            'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon',
            'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue',
            'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
            'thistle', 'tomato', 'transparent', 'turquoise', 'violet', 'wheat', 'white',
            'whitesmoke', 'yellow', 'yellowgreen'
        ]);

        if (!this.isText() || this.isURIList()) return false;
        const text = this.getStringValue().trim().toLowerCase();

        // Быстрый отсекатель по длине (самое длинное имя 'lightgoldenrodyellow' = 20 символов)
        if (text.length === 0 || text.length > 50) return false;

        // 1. Именованные CSS-цвета
        if (CSS_NAMED_COLORS.has(text)) return true;

        // 2. HEX с альфа-каналом (3, 4, 6, 8 символов; с # или без #)
        // Если начинается с # — подходят любые HEX-символы (включая чисто цифровые, напр. #123)
        // Если без # — обязательно наличие хотя бы одной буквы a-f (чтобы отсеять чисто десятичные числа вроде 123)
        const hasHash = text.startsWith('#');
        const cleanText = hasHash ? text.slice(1) : text;
           
        if ([3, 4, 6, 8].includes(cleanText.length)) {
            if (hasHash && /^[0-9a-f]+$/.test(cleanText)) {
                return true;
            }
            if (!hasHash && /^[0-9a-f]+$/.test(cleanText) && /[a-f]/.test(cleanText)) {
                return true;
            }
        }

        // 3. RGB / RGBA (поддержка классического формата с запятыми и современного без них)
        // Примеры: rgb(255, 0, 0), rgba(255, 0, 0, 0.5), rgb(255 0 0 / 50%)
        const rgbRegex = /^rgba?\(\s*\d+\s*[\s,]\s*\d+\s*[\s,]\s*\d+\s*(?:[\s,\/]\s*(?:0?\.\d+|1|0|\d+%))?\s*\)$/;
        if (rgbRegex.test(text)) return true;

        // 4. HSL / HSLA (поддержка процентов и альфа-канала)
        // Примеры: hsl(120, 100%, 50%), hsla(120, 100%, 50%, 0.3), hsl(180deg 20% 50% / 80%)
        const hslRegex = /^hsla?\(\s*\d+(?:deg)?\s*[\s,]\s*\d+%\s*[\s,]\s*\d+%\s*(?:[\s,\/]\s*(?:0?\.\d+|1|0|\d+%))?\s*\)$/;
        if (hslRegex.test(text)) return true;

        return false;
    }

    needsHashPrefix() {
        if (!this.isColor()) return false;

        const text = this.getStringValue().trim();

        // Если уже есть #, добавка не нужна
        if (text.startsWith('#')) return false;

        // Проверяем, является ли строка HEX-кодом без решётки
        const cleanText = text.toLowerCase();
        const isHexLength = [3, 4, 6, 8].includes(cleanText.length);
        const isPureHex = /^[0-9a-f]+$/.test(cleanText);

        return isHexLength && isPureHex;
    }

    parseURIList () {
        if (!this.isURIList()) return null;
        const text = this.getStringValue();
        const uris = text.trim().split('\n').filter(u => u.trim().length > 0);
        return uris.map(uri => {
            try {
                return decodeURI(uri.replace(/^file:\/\//, ''));
            } catch (e) {
                return uri;
            }
        });
    }

    getURIListDisplay () {
        const paths = this.parseURIList();
        if (!paths || paths.length === 0) return null;

        const commonPath = this.#findCommonPath(paths);
        const prefix = commonPath.endsWith('/') ? commonPath : commonPath + '/';
        const fileNames = paths.map(p =>
            p.startsWith(prefix) ? p.slice(prefix.length) : p
        );

        return {
            count: paths.length,
            commonPath: commonPath,
            fileNames: fileNames
        };
    }

    #findCommonPath (paths) {
        if (paths.length === 0) return '';
        if (paths.length === 1) {
            const lastSlash = paths[0].lastIndexOf('/');
            return lastSlash >= 0 ? paths[0].slice(0, lastSlash) : '';
        }

        let common = paths[0];
        for (let i = 1; i < paths.length; i++) {
            let j = 0;
            while (j < common.length && j < paths[i].length &&
                   common[j] === paths[i][j]) {
                j++;
            }
            common = common.slice(0, j);
        }

        const lastSlash = common.lastIndexOf('/');
        return lastSlash >= 0 ? common.slice(0, lastSlash) : common;
    }

    setText (text) {
        if (!this.isText()) return;
        this.#bytes = new TextEncoder().encode(text);
    }

    #tag = null;

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    asBytes () {
        return GLib.Bytes.new(this.#bytes);
    }

    equals (otherEntry) {
        return this.getStringValue() === otherEntry.getStringValue();
        // this.asBytes().equal(otherEntry.asBytes());
    }
}