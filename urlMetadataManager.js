import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export class BaseUrlProvider {
    /**
     * @param {string} url
     * @returns {boolean}
     */
    canHandle(url) {
        return false;
    }

    /**
     * @param {string} url
     * @returns {Promise<{title: string, author?: string}>}
     */
    async fetchMetadata(url) {
        throw new Error('Not implemented');
    }
}

export class YouTubeUrlProvider extends BaseUrlProvider {
    #youtubeRegexes = [
        /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]+)/i,
        /^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)/i,
        /^https?:\/\/(?:www\.|m\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/i,
        /^https?:\/\/(?:www\.|m\.)?youtube\.com\/v\/([a-zA-Z0-9_-]+)/i,
        /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i,
    ];

    canHandle(url) {
        if (!url || typeof url !== 'string') return false;
        const trimmed = url.trim();
        return this.#youtubeRegexes.some(rx => rx.test(trimmed));
    }

    async fetchMetadata(url) {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.trim())}&format=json`;

        return new Promise((resolve, reject) => {
            try {
                const session = new Soup.Session();
                const msg = Soup.Message.new('GET', oembedUrl);

                if (!msg) {
                    reject(new Error('Invalid oEmbed request URL'));
                    return;
                }

                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try {
                        const bytes = s.send_and_read_finish(res);
                        const status = msg.get_status();

                        if (status === 200 && bytes) {
                            const decoder = new TextDecoder('utf-8');
                            const text = decoder.decode(bytes.get_data());
                            const json = JSON.parse(text);

                            if (json && json.title) {
                                resolve({
                                    title: json.title,
                                    author: json.author_name || ''
                                });
                            } else {
                                reject(new Error('Missing title in oEmbed response'));
                            }
                        } else {
                            reject(new Error(`HTTP request failed with status ${status}`));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }
}

export class UrlMetadataManager {
    #providers = [];
    #cache = new Map();
    #pendingFetches = new Map();
    #cachePath = null;
    #cacheDir = null;

    constructor(registryDir) {
        this.#cacheDir = registryDir || (GLib.get_user_cache_dir() + '/clipboard-with-passwords@sergolova');
        this.#cachePath = this.#cacheDir + '/url_cache.json';

        // Register default providers
        this.registerProvider(new YouTubeUrlProvider());

        // Asynchronously load saved cache from disk
        this.loadCache();
    }

    registerProvider(provider) {
        if (provider && typeof provider.canHandle === 'function' && typeof provider.fetchMetadata === 'function') {
            this.#providers.push(provider);
        }
    }

    getProvider(url) {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        return this.#providers.find(p => p.canHandle(trimmed)) || null;
    }

    canHandle(url) {
        return this.getProvider(url) !== null;
    }

    getCachedMetadata(url) {
        if (!url) return null;
        const trimmed = url.trim();
        return this.#cache.get(trimmed) || null;
    }

    async fetchMetadataAsync(url) {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();

        // 1. Return from in-memory cache if available
        if (this.#cache.has(trimmed)) {
            return this.#cache.get(trimmed);
        }

        // 2. Prevent duplicate parallel network requests for the same URL
        if (this.#pendingFetches.has(trimmed)) {
            return this.#pendingFetches.get(trimmed);
        }

        const provider = this.getProvider(trimmed);
        if (!provider) return null;

        const fetchPromise = (async () => {
            try {
                const meta = await provider.fetchMetadata(trimmed);
                const cacheEntry = {
                    title: meta.title,
                    author: meta.author || '',
                    timestamp: Date.now()
                };
                this.#cache.set(trimmed, cacheEntry);
                this.saveCache();
                return cacheEntry;
            } catch (err) {
                console.error(`UrlMetadataManager fetch failed for ${trimmed}:`, err);
                const negativeEntry = {
                    failed: true,
                    timestamp: Date.now()
                };
                this.#cache.set(trimmed, negativeEntry);
                this.saveCache();
                return negativeEntry;
            } finally {
                this.#pendingFetches.delete(trimmed);
            }
        })();

        this.#pendingFetches.set(trimmed, fetchPromise);
        return fetchPromise;
    }

    loadCache() {
        if (!GLib.file_test(this.#cachePath, GLib.FileTest.EXISTS)) {
            return;
        }

        try {
            const file = Gio.file_new_for_path(this.#cachePath);
            const [success, contents] = file.load_contents(null);
            if (success && contents) {
                const textData = new TextDecoder('utf-8').decode(contents);
                if (textData.trim().length > 0) {
                    const parsed = JSON.parse(textData);
                    if (parsed && typeof parsed === 'object') {
                        for (const [url, data] of Object.entries(parsed)) {
                            this.#cache.set(url, data);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('UrlMetadataManager: failed to load url cache file', e);
        }
    }

    saveCache() {
        try {
            const cacheObj = {};
            for (const [url, data] of this.#cache.entries()) {
                cacheObj[url] = data;
            }

            const json = JSON.stringify(cacheObj, null, 2);
            const contents = new GLib.Bytes(json);

            GLib.mkdir_with_parents(this.#cacheDir, parseInt('0775', 8));

            const file = Gio.file_new_for_path(this.#cachePath);
            file.replace_contents(contents.get_data(), null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.error('UrlMetadataManager: failed to save url cache', e);
        }
    }

    clearCache() {
        this.#cache.clear();
        if (GLib.file_test(this.#cachePath, GLib.FileTest.EXISTS)) {
            try {
                const file = Gio.file_new_for_path(this.#cachePath);
                file.delete(null);
            } catch (e) {
                console.error('UrlMetadataManager: error deleting cache file', e);
            }
        }
    }
}
