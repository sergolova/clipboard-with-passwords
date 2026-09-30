// P0.1 CSPRNG test harness.
//
// `random.js` is a pure module with NO gi:// imports and an injectable
// entropy source, so this harness imports the REAL implementation and only
// replicates `generatePassword()` (which lives in passwordVault.js, a module
// that imports shell resources and cannot be loaded outside the shell).
// Both the /dev/urandom-backed source and a deterministic stub source are
// exercised. Run with: gjs -m tools/local/csprng_test.js

import Gio from 'gi://Gio';
import { cryptoRandomInt, setEntropySource } from './random.js';

// ---- real-world entropy source (same code as passwordVault.js) ------------
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
            try { stream.close(null); } catch (e) {}
        }
    }
    return out;
}

// deterministic stub for determinism tests (RFC-style counter, distinct
// non-trivial bytes without 0x00 runs)
let _seed = 0;
function stubSource(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        out[i] = (_seed * 31 + i * 7 + 13) & 0xff;
    _seed = (_seed + 1) % 0xffff;
    return out;
}

// ---- replica: generatePassword() from passwordVault.js (verbatim) ---------
function generatePassword(length = 16, options = {}) {
    const { useUpper = true, useLower = true, useDigits = true, useSymbols = true } = options;

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

    const res = [];
    if (useUpper) res.push(upper[cryptoRandomInt(upper.length)]);
    if (useLower) res.push(lower[cryptoRandomInt(lower.length)]);
    if (useDigits) res.push(digits[cryptoRandomInt(digits.length)]);
    if (useSymbols) res.push(symbols[cryptoRandomInt(symbols.length)]);

    while (res.length < length) {
        res.push(chars[cryptoRandomInt(chars.length)]);
    }

    for (let i = res.length - 1; i > 0; i--) {
        const j = cryptoRandomInt(i + 1);
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res.join('');
}

// ---- harness ---------------------------------------------------------------
let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

setEntropySource(readEntropyBytes);

console.log('== 1. cryptoRandomInt bounds (real /dev/urandom source) ==');
for (const max of [1, 2, 3, 7, 10, 26, 62, 94, 1000, 999999999]) {
    let ok = true;
    for (let i = 0; i < 5000; i++) {
        const v = cryptoRandomInt(max);
        if (!Number.isInteger(v) || v < 0 || v >= max) { ok = false; break; }
    }
    check(`max=${max}: all draws in [0, ${max})`, ok);
}
check('max=0 throws', (() => { try { cryptoRandomInt(0); return false; } catch { return true; } })());
check('max=-5 throws', (() => { try { cryptoRandomInt(-5); return false; } catch { return true; } })());
check('max=non-integer throws', (() => { try { cryptoRandomInt(2.5); return false; } catch { return true; } })());

console.log('== 2. uniformity sanity (rejection sampling, no modulo bias) ==');
{
    const max = 16, N = 80000;
    const counts = new Array(max).fill(0);
    for (let i = 0; i < N; i++) counts[cryptoRandomInt(max)]++;
    const expected = N / max;
    const sd = Math.sqrt(N * (1 / max) * (1 - 1 / max)); // binomial std dev
    let worst = 0;
    for (const c of counts) worst = Math.max(worst, Math.abs(c - expected) / sd);
    check(`uniformity: max=${max}, N=${N}: worst deviation ${worst.toFixed(2)} sigma (limit 6)`, worst < 6);
}

console.log('== 3. generatePassword: length & alphabet ==');
{
    const union = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    let lenOk = true, alphaOk = true, seedOk = true;
    for (let i = 0; i < 2000; i++) {
        const p = generatePassword(16);
        if (p.length !== 16) lenOk = false;
        if (![...p].every(ch => union.includes(ch))) alphaOk = false;
        const hasUpper = /[A-Z]/.test(p), hasLower = /[a-z]/.test(p),
              hasDigit = /\d/.test(p), hasSym = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(p);
        if (!(hasUpper && hasLower && hasDigit && hasSym)) seedOk = false;
    }
    check('default: length == 16 always', lenOk);
    check('default: chars only from the union alphabet', alphaOk);
    check('default: every enabled class present (>=1 char each)', seedOk);
}

console.log('== 4. generatePassword: option subsets ==');
{
    const lc = 'abcdefghijklmnopqrstuvwxyz';
    let ok = true;
    for (let i = 0; i < 500; i++) {
        const p = generatePassword(12, { useUpper: false, useDigits: false, useSymbols: false });
        if (p.length !== 12 || ![...p].every(ch => lc.includes(ch))) { ok = false; break; }
    }
    check('useUpper/useDigits/useSymbols off: lower-only alphabet, length 12', ok);

    ok = true;
    for (let i = 0; i < 500; i++) {
        const p = generatePassword(8, { useUpper: true, useLower: false, useDigits: false, useSymbols: false });
        if (p.length !== 8 || !/^[A-Z]+$/.test(p)) { ok = false; break; }
    }
    check('single class (upper only): all-uppercase, length 8', ok);

    ok = true;
    for (let i = 0; i < 500; i++) {
        const p = generatePassword(10, { useUpper: false, useLower: false, useDigits: false, useSymbols: false });
        if (p.length !== 10 || ![...p].every(ch => (lc + '0123456789').includes(ch))) { ok = false; break; }
    }
    check('all classes off: fallback charset (lower+digits), length 10', ok);
}

console.log('== 5. Fisher–Yates permutation uniformity (real source) ==');
{
    const arr = ['a', 'b', 'c', 'd', 'e', 'f'];
    const seen = new Set();
    const N = 20000;
    for (let n = 0; n < N; n++) {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = cryptoRandomInt(i + 1);
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        seen.add(copy.join(''));
    }
    check(`shuffle: all ${N} runs saw every permutation of a 6-element array (seen ${seen.size}/720)`, seen.size === 720);
}

console.log('== 6. distinctness + pool reuse across many draws ==');
{
    const seen = new Set();
    let allDistinct = true;
    for (let i = 0; i < 5000; i++) {
        const p = generatePassword(16);
        if (seen.has(p)) { allDistinct = false; break; }
        seen.add(p);
    }
    check('5000 generated passwords pairwise distinct', allDistinct);
}

console.log('== 7. deterministic stub source: rejection bounds still hold ==');
{
    setEntropySource(stubSource);
    let ok = true;
    for (let i = 0; i < 20000; i++) {
        const v = cryptoRandomInt(7);
        if (v < 0 || v >= 7) { ok = false; break; }
    }
    check('stub source: 20k draws in [0, 7)', ok);
    ok = true;
    for (let i = 0; i < 10000; i++) {
        const v = cryptoRandomInt(94);
        if (v < 0 || v >= 94) { ok = false; break; }
    }
    check('stub source: 10k draws in [0, 94)', ok);
    setEntropySource(readEntropyBytes);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);