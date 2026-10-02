import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';
import { logError } from './logging.js';
import { DebouncedSaver } from './registrySaver.js';
import { budgetBytesFrom, planAddition } from './registryBudget.js';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

// Debounce window for registry.txt persistence: bursts of clipboard events
// (a copy can currently schedule several saves back to back) collapse into one
// asynchronous write per window instead of one synchronous write per event —
// synchronous writes on the clipboard hot path used to turn filesystem latency
// into shell-UI latency.
const SAVE_DEBOUNCE_MS = 150;

// CSS named colors, one shared set. isColor() used to build this 148-entry Set
// on every call — and isColor() runs several times per entry per menu refresh —
// so each classification pass allocated and re-hashed the whole table.
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

// Compiled once at module load instead of on every isColor() call: four regex
// passes per classification are only worth paying for entries that already
// passed the cheap length gate, but recompiling them was pure overhead.
const COLOR_HEX_REGEX = /^[0-9a-f]+$/;
const COLOR_RGB_REGEX = /^rgba?\(\s*\d+\s*[\s,]\s*\d+\s*[\s,]\s*\d+\s*(?:[\s,\/]\s*(?:0?\.\d+|1|0|\d+%))?\s*\)$/;
const COLOR_HSL_REGEX = /^hsla?\(\s*\d+(?:deg)?\s*[\s,]\s*\d+%\s*[\s,]\s*\d+%\s*(?:[\s,\/]\s*(?:0?\.\d+|1|0|\d+%))?\s*\)$/;
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const HEX_LENGTHS = new Set([3, 4, 6, 8]);

// How many cache entries the clear-on-boot sweep removes per async round. Large
// enough that a full cache takes a handful of hops, small enough that a
// round never holds more names in memory than a real cache is worth.
const SWEEP_BATCH_SIZE = 32;

// Async Gio wrappers, private to this module.
//
// They exist because GJS promise-ifies none of the three calls a directory sweep
// needs, and each of the ways it says so is worth writing down, because every
// one of them looks like a working program until it is run:
//
//   * Gio.File.enumerate_children_async requires its callback argument. The
//     promise form is refused outright: «At least 5 arguments required, but only
//     4 passed».
//   * GFileEnumerator has no next_file_async at all — only the plural
//     next_files_async. The singular one gives
//     «TypeError: en.next_file_async is not a function».
//   * The callback's FIRST argument is the object the method was called on, not
//     an error. The `if (src)` reflex therefore reports every successful call as
//     a failure. The error is raised by the matching *_finish() call, which is
//     what a properly promise-ified call would have done for us.
//
// Each wrapper rejects with the GLib error from *_finish().
function enumerateChildrenAsync (folder) {
    return new Promise((resolve, reject) => {
        folder.enumerate_children_async('', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (src, res) => {
                try {
                    resolve(folder.enumerate_children_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// @param {number} max - upper bound on entries per round
// @returns {Promise<Gio.FileInfo[]>} empty array once the directory is exhausted
function nextFilesAsync (enumerator, max) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(max, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                resolve(enumerator.next_files_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function deleteAsync (file) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                file.delete_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class Registry {
    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
        this._saver = new DebouncedSaver({
            debounceMs: SAVE_DEBOUNCE_MS,
            // 3-arg form: GLib.timeout_add(priority, interval_ms, callback) —
            // the 2-arg shorthand throws "At least 3 arguments required" in
            // the shell's GJS, and that throw must never surface on the
            // clipboard hot path.
            scheduleTimer: (ms, cb) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, cb),
            cancelTimer: (sourceId) => GLib.source_remove(sourceId),
            write: (entries) => this._writeNow(entries),
        });
    }

    // Persistence is debounced and asynchronous: every call records the latest
    // snapshot and bursts coalesce into a single future write (see
    // DebouncedSaver for the single-writer / no-stale-overwrite guarantees).
    // Image cache files are still written by _writeNow() as before.
    write (entries) {
        this._saver.schedule(entries);
    }

    // Force the latest snapshot onto disk without waiting for the debounce
    // (explicit history clear / extension shutdown). Never races the async
    // writer: it either starts the single write immediately or queues the
    // fresh snapshot after the one currently in flight.
    flush () {
        this._saver.flush();
    }

    // The one definition of what a registry record for an entry looks like.
    //
    // Both the writer and the size check go through here, deliberately: if they
    // each built the record themselves they would drift, and the size check
    // would quietly measure a different shape than the one that gets written —
    // which is the one way a "this entry fits" answer could stop being true.
    //
    // An image's payload lives in its own cache file, so the record holds a path
    // and this stays cheap for images. A text entry is stored inline, which is
    // what makes a very large text the thing that can blow the ceiling.
    #buildRecord (entry) {
        const item = {
            favorite: entry.isFavorite(),
            mimetype: entry.mimetype()
        };

        if (entry.isText()) {
            item.contents = entry.getStringValue();
        }
        else if (entry.isImage()) {
            item.contents = this.getEntryFilename(entry);
        }

        if (entry.getTag()) item.tag = entry.getTag();
        if (entry.isProtected()) item.protected = true;
        return item;
    }

    // How many bytes this entry will add to the registry file.
    //
    // Measured, not estimated: the escape rules of JSON.stringify are not
    // something to reimplement here, and a per-character guess would be wrong by
    // a factor of six for anything with non-ASCII in it. The cost is one
    // stringify of one record, on the capture path only.
    #recordSizeFor (entry) {
        try {
            return new TextEncoder().encode(
                JSON.stringify(this.#buildRecord(entry))).length;
        } catch (e) {
            // A record that cannot even be serialized would certainly not be
            // written; treat it as not fitting rather than as free.
            return Number.MAX_SAFE_INTEGER;
        }
    }

    // Whether this entry may be added to the history at all, and the numbers
    // behind the answer. The caller uses `fits` to refuse the entry and the rest
    // to tell the user why.
    //
    // The ceiling is a real limit, not a formality: read() moves a registry over
    // it aside and starts from an empty history, so letting an entry past this
    // point is how the user loses everything at the next shell start.
    canStoreEntry (entry) {
        let currentBytes = 0;
        try {
            const info = Gio.file_new_for_path(this.REGISTRY_PATH)
                .query_info('*', FileQueryInfoFlags.NONE, null);
            currentBytes = info.get_size();
        } catch (e) {
            // No file yet, or it cannot be read: the first entry always fits.
            currentBytes = 0;
        }

        const capBytes = budgetBytesFrom(
            this.settings.get_int(PrefsFields.CACHE_FILE_SIZE));
        return planAddition({
            currentBytes,
            recordBytes: this.#recordSizeFor(entry),
            capBytes
        });
    }

    // Runs on the main loop after the debounce window (or on flush): builds
    // the registry payload and writes it with an asynchronous replace, so a
    // big history never blocks the shell while serializing or writing.
    // Failures are logged and swallowed, exactly like the old synchronous
    // path — the in-memory history keeps working regardless.
    async _writeNow (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = this.#buildRecord(entry);
            registryContent.push(item);

            if (entry.isImage()) {
                // The payload file is written on the side; the record only holds
                // its path.
                this.writeEntryFile(entry).catch(e => {
                    logError('Clipboard Indicator: failed to cache image entry', e);
                });
            }
        }

        try {
            let json = JSON.stringify(registryContent);
            let contents = new GLib.Bytes(json);
            GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
            let file = Gio.file_new_for_path(this.REGISTRY_PATH);
            await new Promise((resolve) => {
                // GJS >= 1.73 dropped the io_priority parameter from async GIO
                // methods: the call is (contents, etag, make_backup, flags,
                // cancellable, callback). Passing GLib.PRIORITY_DEFAULT here
                // makes GJS read the number as the cancellable slot and throw.
                file.replace_contents_async(contents, null, false,
                                            Gio.FileCreateFlags.NONE, null,
                                            (src, res) => {
                    try {
                        src.replace_contents_finish(res);
                    } catch (e) {
                        logError('Clipboard Indicator: failed to write registry file', e);
                    }
                    resolve();
                });
            });
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

            // The last-resort guard, not the normal path. canStoreEntry() refuses
            // anything that would push the registry over the ceiling, so arriving
            // here means the ceiling was LOWERED under an existing history, or the
            // file was written by an older version that did not check.
            //
            // It is loud, and deliberately so. This used to move the file aside
            // and return an empty history without a word, which is how 65 records
            // once disappeared with no more explanation than a shorter menu — and
            // the second occurrence would overwrite the first backup, taking the
            // only remaining copy with it.
            const file_info = file.query_info('*', FileQueryInfoFlags.NONE, null);
            if (file_info && file_info.get_size() >= CACHE_FILE_SIZE * 1024 * 1024) {
                let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);
                logError('Clipboard Indicator: the clipboard history file is ' +
                    'larger than the «Cache file size» setting, so it was moved ' +
                    `aside to ${this.BACKUP_REGISTRY_PATH} and the history was ` +
                    'reset to empty. Nothing was deleted — raise «Cache file ' +
                    'size» in the settings and restart to read it back.');
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
            // One unreadable record must cost that record and nothing else.
            // fromJSON() is async and THROWS on a record it cannot make sense of
            // (a mimetype outside text/* and image/* with no contents field
            // reaches GIO with an undefined filename), and a single rejection
            // inside Promise.all() rejects the whole load — which the catch below
            // turns into an empty history. So each record is settled on its own
            // and the bad ones are dropped, which is what the `!== null` filter
            // was always meant to do.
            const entriesPromises = registry.map(jsonEntry =>
                ClipboardEntry.fromJSON(jsonEntry).catch(e => {
                    logError('Clipboard Indicator: dropping an unreadable history record', e);
                    return null;
                }));
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

    // A cache file exists from the moment replace_async starts (truncated to 0),
    // so mere existence is not enough: a file mid-write (or left empty by a
    // failed write) must be rewritten, not read. Valid images are never 0 bytes.
    #entryFileComplete (entry) {
        const filename = this.getEntryFilename(entry);
        if (!GLib.file_test(filename, FileTest.EXISTS))
            return false;
        try {
            const file = Gio.file_new_for_path(filename);
            const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            return !!info && info.get_size() > 0;
        } catch (e) {
            return false;
        }
    }

    async getEntryAsTexture (entry, { width = -1, height = -1 } = {}) {
        if (entry.isImage() === false) return null;

        try {
            // The capture path awaits writeEntryFile() before exposing the entry
            // to the menu, so the file is normally complete here; this check also
            // rewrites a leftover from a failed write (empty file).
            if (this.#entryFileComplete(entry) === false) {
                // Only an entry whose payload is in memory can be restored on
                // the fly — a lazily-restored entry with a missing file has
                // nothing to paste and nothing to rewrite (it is filtered out
                // of the menu by entryHasUsableCache()).
                if (!entry.hasPayload())
                    return null;
                await this.writeEntryFile(entry);
            }

            const file = Gio.file_new_for_path(this.getEntryFilename(entry));
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            // width/height ≤ 0 means natural size. Small previews (e.g. the
            // 1em topbar thumb) pass a size hint so the texture cache does not
            // decode + upload a full 4K screenshot for a 24 px box.
            return St.TextureCache.get_default().load_file_async(file, width, height, scaleFactor, 1.0);
        } catch (e) {
            // Real failure: render the item as an empty preview box; the
            // in-memory entry still pastes fine.
            logError('Clipboard Indicator: failed to load image texture', e);
            return null;
        }
    }

    // An image item is only worth showing when it can actually be delivered:
    // the cache file is complete (lazily-restored entries), or the payload is
    // already in memory (freshly copied entries — getEntryAsTexture() rewrites
    // the cache file on demand). An entry with neither would render as a dead
    // white strip and has nothing to paste.
    entryHasUsableCache (entry) {
        if (!entry.isImage())
            return true;
        if (entry.hasPayload())
            return true;
        return this.#entryFileComplete(entry);
    }

    getEntryFilename (entry) {
        // Lazily-restored images already know their cache path; freshly copied
        // ones derive it from the payload hash.
        if (entry.storedFilename)
            return entry.storedFilename;
        if (!entry.cachedFilename) {
            // Hash once and reuse: the capture path derives the name for the
            // write, then again for the menu-item and topbar textures and on
            // every registry save — each call used to run a full-content pass
            // over the (multi-MB) image on the main loop.
            entry.cachedFilename = `${this.REGISTRY_DIR}/${entry.asBytes().hash()}`;
        }
        return entry.cachedFilename;
    }

    async writeEntryFile (entry) {
        if (this.#entryFileComplete(entry)) return;

        // Always write from the entry's own payload copy. The clipboard's
        // GLib.Bytes must never reach an async write: it is handed to the
        // capture callback with transfer-ownership="none" and is gone by the
        // time this write runs, which made the write fail with a bad address
        // and took the shell down with it.
        const bytes = await entry.asBytesAsync();
        let file = Gio.file_new_for_path(this.getEntryFilename(entry));

        // Capture awaits this write before the entry reaches the menu
        // (extension.js #getClipboardContent), so the first reader — the item
        // preview via getEntryAsTexture() — always finds a fully written file.
        // Failures reject here so the capture path can log and still show the
        // entry (paste works from the in-memory payload).
        return new Promise((resolve, reject) => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                               GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                try {
                    let stream = obj.replace_finish(res);

                    stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT,
                                             null, (w_obj, w_res) => {
                        try {
                            w_obj.write_bytes_finish(w_res);
                            stream.close(null);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
                } catch (e) {
                    reject(e);
                }
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

    /**
     * Empty the cache directory.
     *
     * Asynchronous, and that is not a style choice. Every delete here is a
     * blocking syscall on the Shell's main loop, and this directory holds one
     * file per image the user has copied while image caching is on — a few dozen
     * on a light day, thousands on a heavy one. Doing that synchronously while
     * the panel is being built freezes the compositor for as long as the
     * filesystem takes, and a slow or removable cache directory makes it worse.
     * GNOME's review guidelines call this out explicitly (EGO-X-004).
     *
     * Returns a promise that resolves when the sweep is done. Callers that read
     * the cache afterwards MUST await it: the menu is populated from this
     * directory, so clearing it in the background would let rows the user asked
     * to have cleared appear on this boot.
     *
     * @returns {Promise<void>}
     */
    async clearCacheFolder() {
        try {
            const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
            const enumerator = await enumerateChildrenAsync(folder);

            for (;;) {
                // Batched rather than one at a time: a round costs one async hop
                // however many entries it returns, so a cache holding thousands
                // of image files is emptied in far fewer hops.
                const infos = await nextFilesAsync(enumerator, SWEEP_BATCH_SIZE);
                if (!infos || infos.length === 0)
                    break;

                for (const info of infos) {
                    const child = enumerator.get_child(info);
                    try {
                        // Awaited per entry, not per batch: this await is the only
                        // thing that turns a failed unlink into the logged line
                        // below. Dropping it would leave the rejection unhandled,
                        // and the Shell reports those as criticals rather than
                        // saying anything about a half-cleared cache.
                        await deleteAsync(child);
                    } catch (e) {
                        // One undeletable entry must not abandon the rest. The
                        // synchronous version this replaced had a single try
                        // around the whole loop, so the first failure stopped the
                        // sweep and left the cache half-cleared with nothing
                        // reported about it.
                        logError('Clipboard Indicator: failed to delete a cache entry: ' +
                            child.get_path(), e);
                    }
                }
            }
        } catch (e) {
            logError(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    // Decoded text and the derived forms every classifier needs. One menu
    // refresh used to decode the payload again for clipContents, isColor(),
    // isMultiline(), isURL() and the URL branch — five full TextDecoder passes
    // over the same bytes per entry, plus one more when the registry is
    // serialized. All of them are pure functions of #bytes, so they are
    // computed once and dropped by setText().
    #textCache = null;
    #trimmedCache = null;
    #foldedCache = null;
    // Content-type classification, resolved in one pass and reused: each
    // isX() used to redo trim()/toLowerCase() and re-run its own regex.
    #classification = null;
    // Cache-file path for lazily-restored image entries (set by fromJSON; null
    // for in-memory entries). Lets getEntryFilename()/getStringValue() work
    // without touching the payload.
    #storedFilename = null;
    // Hash-derived cache path, computed once and reused by getEntryFilename():
    // recomputing asBytes().hash() over a multi-MB image on every call stalls
    // the shell main loop in the capture path (write + menu item preview +
    // registry save each recomputed it).
    #cachedFilename = null;
    #favorite;

    static #decode (contents) {
        return Uint8Array.from(contents.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    }

    // A cache file exists from the moment the write starts (it is created
    // empty), so mere existence proves nothing: a write interrupted by a crash
    // or a killed shell leaves a 0-byte file behind, and the registry that was
    // written alongside it still points at it. Such an entry can neither be
    // previewed nor pasted, so it is dropped on read — the history heals itself
    // instead of carrying a permanently dead item (and permanently reserving a
    // slot) forever.
    static #payloadFileIsUsable (filename) {
        if (!GLib.file_test(filename, FileTest.EXISTS))
            return false;
        try {
            const info = Gio.file_new_for_path(filename)
                .query_info('standard::size', FileQueryInfoFlags.NONE, null);
            return info !== null && info.get_size() > 0;
        } catch (e) {
            logError('Clipboard Indicator: could not stat a cache file', e);
            return false;
        }
    }

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        // Defaulted rather than passed through: a record whose mimetype is
        // neither text/* nor image/* carries no contents at all, and handing
        // `undefined` to GIO is an argument-type error, not a missing file. The
        // empty name simply fails the usability check below, so such a record is
        // dropped the same way a record pointing at a deleted payload is.
        const contents = typeof jsonEntry.contents === 'string' ? jsonEntry.contents : '';
        let bytes = null;
        let storedFilename = null;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(contents);
        }
        else {
            const filename = contents;
            if (!ClipboardEntry.#payloadFileIsUsable(filename)) return null;

            // Lazy image restore (EGO-X-004): do not read the payload at
            // startup. Loading every cached image synchronously would stall the
            // shell main loop (and the previous async variant could hang the
            // shell when JS callbacks fired during a major GC sweep). The
            // preview texture is rendered straight from the cache file by
            // getEntryAsTexture(); the bytes load on demand via asBytesAsync()
            // (paste/copy back, cache-file rewrite).
            storedFilename = filename;
        }

        const entry = new ClipboardEntry(mimetype, bytes, favorite, storedFilename);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        // Legacy registry caches stored this flag as `password`; new caches use
        // `protected`. Accept both so already-protected items stay masked after
        // an upgrade (never unmask persisted data silently).
        if (jsonEntry.protected || jsonEntry.password) entry.setProtected(true);
        return entry;
    }

    constructor (mimetype, bytes, favorite, storedFilename = null) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
        this.#storedFilename = storedFilename;
    }

    #encode () {
        if (this.isText()) {
            return this.getStringValue();
        }

        return [...this.#bytes]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
    }

    // The decoded payload, decoded at most once per payload. isImage() is
    // checked first: an image entry's "string" is a synthesized [Image <hash>]
    // placeholder, and building it hashes the whole payload.
    getStringValue () {
        if (this.#textCache !== null)
            return this.#textCache;

        if (this.isImage()) {
            const hash = this.#storedFilename
                ? this.#storedFilename.slice(this.#storedFilename.lastIndexOf('/') + 1)
                : this.asBytes().hash();
            return this.#textCache = `[Image ${hash}]`;
        }
        return this.#textCache = new TextDecoder().decode(this.#bytes);
    }

    // getStringValue().trim() — a pass the classifiers and the renderers both
    // need, so it is cached alongside the decoded text.
    #trimmed () {
        if (this.#trimmedCache === null)
            this.#trimmedCache = this.getStringValue().trim();
        return this.#trimmedCache;
    }

    // getStringValue().trim().toLowerCase() — the folded form the URL and
    // color checks match against.
    #folded () {
        if (this.#foldedCache === null)
            this.#foldedCache = this.#trimmed().toLowerCase();
        return this.#foldedCache;
    }

    // Every classifier in one pass, resolved lazily on first use. The keys
    // depend only on the payload, so they are computed exactly once per entry
    // and never recomputed while the menu re-reads them.
    #classify () {
        if (this.#classification !== null)
            return this.#classification;

        const flags = {
            url: false,
            email: false,
            multiline: false,
            color: false,
            hashPrefix: false
        };

        if (this.isText() && !this.isURIList()) {
            const trimmed = this.#trimmed();
            const folded = this.#folded();

            flags.url = folded.startsWith('http://') || folded.startsWith('https://');
            flags.multiline = trimmed.includes('\n');

            // Email cannot contain a slash or start with a dot — cheap gate
            // before the regex.
            if (!trimmed.includes('/') && !trimmed.startsWith('.'))
                flags.email = EMAIL_REGEX.test(trimmed);

            // Color: length gate first (longest CSS name is
            // 'lightgoldenrodyellow', 20 chars), then named colors, hex, rgb,
            // hsl. Each step only matters once the entry looks like a color.
            if (trimmed.length > 0 && trimmed.length <= 50) {
                const hasHash = folded.startsWith('#');
                const hex = hasHash ? folded.slice(1) : folded;

                if (CSS_NAMED_COLORS.has(folded)) {
                    flags.color = true;
                } else if (HEX_LENGTHS.has(hex.length) && COLOR_HEX_REGEX.test(hex)) {
                    // Hex: with a leading '#' any hex digits qualify, without
                    // it there must be a letter a-f, so pure decimals are not
                    // mistaken for colors.
                    flags.color = hasHash || /[a-f]/.test(hex);
                } else {
                    flags.color = COLOR_RGB_REGEX.test(folded) || COLOR_HSL_REGEX.test(folded);
                }

                // A hex value is a color, and a bare one additionally needs the
                // '#' to be usable as CSS — so this cannot simply be the
                // negation of hasHash: pure decimals like "123" are not colors
                // and must not be flagged.
                flags.hashPrefix = flags.color && !hasHash &&
                    HEX_LENGTHS.has(hex.length) && COLOR_HEX_REGEX.test(hex);
            }
        }

        return this.#classification = flags;
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
        return this.#classify().url;
    }

    isEmail () {
        return this.#classify().email;
    }

    isMultiline () {
        return this.#classify().multiline;
    }

    isColor () {
        return this.#classify().color;
    }

    // True when the entry is a bare hex color that needs a '#' to become a
    // valid CSS value. Both answers are produced by the single cached
    // classification pass instead of re-testing isColor() here.
    needsHashPrefix() {
        return this.#classify().hashPrefix;
    }

    parseURIList () {
        if (!this.isURIList()) return null;
        const text = this.getStringValue();
        // A uri-list is CRLF-terminated (RFC 2483), so splitting on "\n" alone
        // leaves a carriage return welded to the end of every name but the last:
        // "report.pdf\r" is not a PDF to anything that reads a name — the
        // extension is "pdf\r" — and "Documents/\r" no longer looks like a
        // directory. Trim each line, not just the text around the split.
        const uris = text.split('\n')
            .map(u => u.trim())
            .filter(u => u.length > 0);
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
        const fileNames = paths.map(p => {
            const name = p.startsWith(prefix) ? p.slice(prefix.length) : p;
            if (name)
                return name;
            // One directory copied on its own slices down to nothing: the common
            // path of a single path is that path's own parent, so the prefix eats
            // the whole thing. What the user copied is the last segment of the
            // path, and its trailing "/" has to survive — that separator is the
            // only thing in a name that says it is a directory.
            const cut = p.replace(/\/+$/, '').lastIndexOf('/');
            return p.slice(cut + 1);
        });

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
        // The payload is new, so every value derived from it is stale.
        this.#textCache = null;
        this.#trimmedCache = null;
        this.#foldedCache = null;
        this.#classification = null;
    }

    #tag = null;

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    get storedFilename () {
        return this.#storedFilename;
    }

    get cachedFilename () {
        return this.#cachedFilename;
    }

    set cachedFilename (val) {
        this.#cachedFilename = val;
    }

    // Async payload accessor: text entries (and freshly copied images) already
    // hold their bytes in memory; lazily-restored images fetch the payload from
    // the cache file on demand (EGO-X-004 — no synchronous file IO).
    async asBytesAsync () {
        if (this.#bytes)
            return GLib.Bytes.new(this.#bytes);

        const file = Gio.file_new_for_path(this.#storedFilename);
        const [success, contents] = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (src, res) => {
                try {
                    resolve(src.load_contents_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!success || !contents)
            throw new Error(`clipboard image cache file missing: ${this.#storedFilename}`);
        // Caches are deliberately not dropped here: this only ever runs for a
        // lazily-restored image entry, and an image's string value and
        // classification are derived from the cache file *name*, not from these
        // bytes, so nothing that is cached can go stale.
        this.#bytes = contents;
        return GLib.Bytes.new(contents);
    }

    // True when the payload is already in memory (freshly copied entries, or
    // lazily-restored entries after their first asBytesAsync()). Lets the menu
    // builder tell a live entry (cache file deleted mid-session, but the
    // payload is here and the file can be rewritten on demand) from a dead one
    // (no file and no payload — nothing to paste).
    hasPayload () {
        return !!this.#bytes;
    }

    asBytes () {
        if (!this.#bytes)
            throw new Error('entry payload not loaded; use asBytesAsync()');
        return GLib.Bytes.new(this.#bytes);
    }
}