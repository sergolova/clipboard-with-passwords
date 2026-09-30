import { logWarn } from './logging.js';

// Cryptographically secure randomness for the extension — pure core with NO
// top-level `gi://` imports, so this module can be imported (and tested) in a
// plain gjs/node process: the entropy source is injected via
// `setEntropySource` instead of being hard-wired to Gio.
//
// Rationale: GJS (mozjs/SpiderMonkey) exposes no Web Crypto (`typeof crypto
// === 'undefined'` in gjs 1.80 / GNOME 46) and GLib's random helpers are a
// PRNG, not a CSPRNG — so the extension draws entropy from /dev/urandom (the
// OS CSPRNG, injected by passwordVault.js) and converts it to unbiased
// integers with rejection sampling (never `byte % max`, which carries a
// modulo bias).

const POOL_BYTES = 512; // 128 uint32 draws per refill

let _pool = null; // Uint8Array of fresh entropy
let _poolPos = 0; // position of the next unused byte
let _source = null; // (n) => Uint8Array, set via setEntropySource

// Register the entropy source. `source(n)` must return a fresh Uint8Array of
// exactly n random bytes or throw. Reset the pool so a swapped source is
// picked up immediately (tests swap sources between groups).
export function setEntropySource(source) {
    _source = source;
    _pool = null;
    _poolPos = 0;
}

function refill() {
    if (typeof _source !== 'function')
        throw new Error('cryptoRandomInt: no entropy source configured (call setEntropySource)');
    try {
        _pool = _source(POOL_BYTES);
    } catch (e) {
        logWarn('CSPRNG: cannot read entropy from source:', e);
        throw e;
    }
    _poolPos = 0;
}

function nextUint32() {
    if (!_pool || _poolPos + 4 > _pool.length)
        refill();
    const v = (_pool[_poolPos] << 24) |
              (_pool[_poolPos + 1] << 16) |
              (_pool[_poolPos + 2] << 8) |
              _pool[_poolPos + 3];
    _poolPos += 4;
    return v >>> 0; // unsigned 32-bit
}

// Uniform integer in [0, maxExclusive) via rejection sampling: draws above
// the largest multiple of `maxExclusive` below 2^32 are rejected, which
// removes the modulo bias completely.
export function cryptoRandomInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0)
        throw new Error('cryptoRandomInt: maxExclusive must be a positive integer');
    if (maxExclusive >= 0x100000000)
        throw new Error('cryptoRandomInt: maxExclusive is too large');
    const limit = 0x100000000 - (0x100000000 % maxExclusive);
    let v;
    do {
        v = nextUint32();
    } while (v >= limit);
    return v % maxExclusive;
}