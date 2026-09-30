// Logic test: vault resource-limit enforcement and strict schema
// validation (constants.js caps + type coercion wired into _normalizeVaultData
// / _sanitizeItem in passwordVault.js). passwordVault.js itself cannot be
// imported from the node/gjs CLI (it imports the shell resource), so these are
// faithful replicas that MUST stay in sync by review — exactly the technique
// already used by vault_align_test.js. The numeric caps come from the REAL
// constants.js (pure ESM, importable here), so the limits can never drift
// between the extension and the test.
import {
    MAX_VAULT_ARCHIVE_BYTES,
    MAX_VAULT_JSON_BYTES,
    MAX_VAULT_ITEMS,
    MAX_FIELD_LENGTH,
    MAX_EXTRA_FIELDS,
} from '../constants.js';

// --- replicas of the passwordVault.js limit and schema logic -----------------

let _idCounter = 0;
const _seenIds = new Set();
function _generateId() {
    let id;
    do {
        id = `service_${Date.now()}_${_idCounter++}`;
    } while (_seenIds.has(id));
    return id;
}

function _sanitizeItem(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return null;
    }
    const capField = (value) => {
        if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
            throw new Error('field-too-long');
        }
        return value;
    };
    const str = (v) => (v === undefined || v === null) ? '' : String(v);
    const optTrim = (v) => str(v).trim();

    const rawId = str(data.id);
    const name = str(data.name);
    const item = {
        id: rawId ? capField(rawId) : _generateId(),
        name: name ? capField(name) : 'Untitled',
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
        const extras = data.extraFields
            .filter(f => f && typeof f === 'object' && !Array.isArray(f))
            .map(f => {
                const e = {};
                const label = optTrim(f.label);
                if (label) e.label = capField(label);
                if (f.value !== undefined && f.value !== null && str(f.value).trim() !== '') {
                    e.value = capField(str(f.value));
                }
                if (f.isHidden) e.isHidden = true;
                return e;
            })
            .filter(f => f.label || f.value);
        if (extras.length > MAX_EXTRA_FIELDS) {
            throw new Error('too-many-extras');
        }
        if (extras.length > 0) item.extraFields = extras;
    }
    return item;
}

function _normalizeIds(items) {
    const seen = new Set();
    for (const item of items) {
        if (!item.id || seen.has(item.id)) {
            item.id = _generateId();
        }
        seen.add(item.id);
    }
    return items;
}

function _normalizeVaultData(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('invalid-data');
    }
    if (!Array.isArray(parsed.items)) {
        throw new Error('invalid-data');
    }
    if (parsed.items.length > MAX_VAULT_ITEMS) {
        throw new Error('too-many-items');
    }
    const items = [];
    for (const raw of parsed.items) {
        const it = _sanitizeItem(raw);
        if (it) items.push(it);
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 1;
    if (version > 1) {
        throw new Error('unsupported-version');
    }
    return {
        version: version >= 1 ? version : 1,
        items: _normalizeIds(items)
    };
}

// replicas of the two read-side gates in unlock()
function archiveTooLarge(size) { return size > MAX_VAULT_ARCHIVE_BYTES; }
function payloadTooLarge(stdoutLength) { return stdoutLength > MAX_VAULT_JSON_BYTES; }

// --- tiny test framework -----------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label) {
    if (cond) passed++;
    else { failed++; failures.push(label); console.error('  FAIL:', label); }
}
function throws(fn, tag, label) {
    try {
        fn();
        failed++;
        failures.push(label);
        console.error('  FAIL (no throw):', label);
    } catch (e) {
        if (e.message === tag) passed++;
        else { failed++; failures.push(label); console.error('  FAIL (wrong err):', label, '→', e.message); }
    }
}
const item = (over = {}) => ({ name: 'svc', ...over });

// --- caps ------------------------------------------------------------------

// valid loads: empty / single / multiple / missing optional fields
let r = _normalizeVaultData({ items: [] });
ok(r.items.length === 0 && r.version === 1, 'empty items → empty vault, version 1');

r = _normalizeVaultData({ version: 1, items: [item({ category: ' a ', description: 'b', login: 'x@y', password: 'p', extraFields: [{ label: 'L', value: 'V' }] })] });
ok(r.items.length === 1 && r.items[0].category === 'a' && r.items[0].password === 'p', 'one full item → fields trimmed & kept');
ok(r.items[0].extraFields.length === 1 && r.items[0].extraFields[0].label === 'L', 'extra field survives');

r = _normalizeVaultData({ items: [item(), item(), item()] });
ok(r.items.length === 3, 'three items → count preserved');

r = _normalizeVaultData({ items: [item()] });
ok(r.items[0].id && typeof r.items[0].id === 'string', 'missing id → generated');

// duplicate / missing ids are made unique (existing invariant preserved)
r = _normalizeVaultData({ items: [item({ id: 'dup' }), item({ id: 'dup' }), item({})] });
ok(r.items[0].id !== r.items[1].id && r.items[2].id, 'duplicate ids made unique');

// item count cap: exactly the limit is fine, one over is rejected
throws(() => _normalizeVaultData({ items: Array.from({ length: MAX_VAULT_ITEMS + 1 }, () => item()) }), 'too-many-items', `item count ${MAX_VAULT_ITEMS + 1} → rejected`);

// field length cap: boundary exact length OK, +1 rejected (behavior preserved)
ok(_normalizeVaultData({ items: [item({ name: 'n'.repeat(MAX_FIELD_LENGTH) })] }).items[0].name.length === MAX_FIELD_LENGTH, `name exactly ${MAX_FIELD_LENGTH} → OK`);
throws(() => _normalizeVaultData({ items: [item({ name: 'n'.repeat(MAX_FIELD_LENGTH + 1) })] }), 'field-too-long', `name ${MAX_FIELD_LENGTH + 1} → rejected`);
throws(() => _normalizeVaultData({ items: [item({ password: 'p'.repeat(MAX_FIELD_LENGTH + 1) })] }), 'field-too-long', `password ${MAX_FIELD_LENGTH + 1} → rejected`);
throws(() => _normalizeVaultData({ items: [item({ category: 'c'.repeat(MAX_FIELD_LENGTH + 1) })] }), 'field-too-long', `category ${MAX_FIELD_LENGTH + 1} → rejected`);
throws(() => _normalizeVaultData({ items: [item({ id: 'i'.repeat(MAX_FIELD_LENGTH + 1) })] }), 'field-too-long', `id ${MAX_FIELD_LENGTH + 1} → rejected`);
throws(() => _normalizeVaultData({ items: [item({ extraFields: [{ label: 'l'.repeat(MAX_FIELD_LENGTH + 1), value: 'v' }] })] }), 'field-too-long', `extra label ${MAX_FIELD_LENGTH + 1} → rejected`);
throws(() => _normalizeVaultData({ items: [item({ extraFields: [{ label: 'l', value: 'v'.repeat(MAX_FIELD_LENGTH + 1) }] })] }), 'field-too-long', `extra value ${MAX_FIELD_LENGTH + 1} → rejected`);

// extra fields cap: boundary exact OK, one over rejected, junk empties don't count
ok(_normalizeVaultData({ items: [item({ extraFields: Array.from({ length: MAX_EXTRA_FIELDS }, (_, i) => ({ label: `f${i}`, value: 'v' })) })] }).items[0].extraFields.length === MAX_EXTRA_FIELDS, `exactly ${MAX_EXTRA_FIELDS} extras → OK`);
throws(() => _normalizeVaultData({ items: [item({ extraFields: Array.from({ length: MAX_EXTRA_FIELDS + 1 }, (_, i) => ({ label: `f${i}`, value: 'v' })) })] }), 'too-many-extras', `${MAX_EXTRA_FIELDS + 1} extras → rejected`);
ok(_normalizeVaultData({ items: [item({ extraFields: Array.from({ length: MAX_EXTRA_FIELDS }, (_, i) => (i % 2 ? { label: `f${i}`, value: 'v' } : { label: '', value: null })) })] }).items[0].extraFields.length === MAX_EXTRA_FIELDS / 2, 'junk empty extras dropped before the cap');

// read-side gates: on-disk archive size + decompressed JSON byte length
ok(!archiveTooLarge(MAX_VAULT_ARCHIVE_BYTES) && archiveTooLarge(MAX_VAULT_ARCHIVE_BYTES + 1), 'archive size gate at the boundary');
ok(!payloadTooLarge(MAX_VAULT_JSON_BYTES) && payloadTooLarge(MAX_VAULT_JSON_BYTES + 1), 'json byte gate at the boundary');
ok(MAX_VAULT_ITEMS === 1000, 'item limit is 1000 (per task)');
ok(MAX_FIELD_LENGTH >= 512 && MAX_EXTRA_FIELDS >= 8, 'generous caps: legit vaults never trip');

// --- malformed payloads: readable errors, never a raw TypeError ---------------

throws(() => _normalizeVaultData(null), 'invalid-data', 'parsed null');
throws(() => _normalizeVaultData('json'), 'invalid-data', 'parsed string');
throws(() => _normalizeVaultData(42), 'invalid-data', 'parsed number');
throws(() => _normalizeVaultData({}), 'invalid-data', 'items absent');
throws(() => _normalizeVaultData({ items: 'nope' }), 'invalid-data', 'items string');
throws(() => _normalizeVaultData({ items: {} }), 'invalid-data', 'items object');

// non-object item entries → dropped (record count reflects survivors)
r = _normalizeVaultData({ items: [null] });
ok(r.items.length === 0, 'item null → dropped, vault still loads');
r = _normalizeVaultData({ items: ['str', 42, true, [], {}] });
ok(r.items.length === 1 && r.items[0].name === 'Untitled', 'item string/number/bool/array → dropped, empty object → Untitled card');
r = _normalizeVaultData({ items: [null, item({ name: 'x' }), 'junk'] });
ok(r.items.length === 1 && r.items[0].name === 'x', 'mixed garbage + valid → only valid survives');

// non-object extra entries → skipped, not fatal
r = _normalizeVaultData({ items: [item({ extraFields: [null, { label: 'ok', value: 'v' }, 'junk', 5] })] });
ok(r.items[0].extraFields.length === 1 && r.items[0].extraFields[0].label === 'ok', 'extra null / string / number → skipped, valid extra kept');

// extraFields not an array → ignored
r = _normalizeVaultData({ items: [item({ extraFields: 'nope' }), item({ extraFields: { label: 'x' } })] });
ok(!r.items[0].extraFields && !r.items[1].extraFields, 'non-array extraFields ignored');

// --- type coercion -----------------------------------------------------------

r = _normalizeVaultData({ items: [item({ name: 123 })] });
ok(r.items[0].name === '123', 'name number → coerced string');
r = _normalizeVaultData({ items: [item({ name: null }), item({ name: '' }), { id: 'no-name' }] });
ok(r.items.every(i => i.name === 'Untitled'), 'name null/empty/missing → Untitled');

r = _normalizeVaultData({ items: [item({ updatedAt: 'yesterday' })] });
ok(Number.isFinite(r.items[0].updatedAt), 'updatedAt string → replaced with Date.now()');
r = _normalizeVaultData({ items: [item({ updatedAt: 1700000000000 })] });
ok(r.items[0].updatedAt === 1700000000000, 'updatedAt finite number → kept');
r = _normalizeVaultData({ items: [item({ updatedAt: 0 })] });
ok(r.items[0].updatedAt === 0, 'updatedAt 0 → kept (finite number)');

r = _normalizeVaultData({ items: [item({ id: 42 })] });
ok(r.items[0].id === '42', 'numeric id → coerced string');
r = _normalizeVaultData({ items: [item({ id: '' }), item({ id: null })] });
ok(r.items.every(i => i.id), 'empty/null id → generated');

r = _normalizeVaultData({ items: [item({ category: 5, description: 6, login: 7, password: 8 })] });
ok(r.items[0].category === '5' && r.items[0].description === '6' && r.items[0].login === '7' && r.items[0].password === '8', 'category/description/login/password numbers → coerced strings');
r = _normalizeVaultData({ items: [item({ category: '', description: null, login: '  ', password: null })] });
ok(!('category' in r.items[0]) && !('description' in r.items[0]) && !('login' in r.items[0]) && !('password' in r.items[0]), 'whitespace/null optional fields → omitted');

r = _normalizeVaultData({ items: [item({ extraFields: [{ label: 9, value: 10 }] })] });
ok(r.items[0].extraFields[0].label === '9' && r.items[0].extraFields[0].value === '10', 'extra label/value numbers → coerced strings');
r = _normalizeVaultData({ items: [item({ extraFields: [{ label: 'h', value: 'v', isHidden: 'yes' }] })] });
ok(r.items[0].extraFields[0].isHidden === undefined || r.items[0].extraFields[0].isHidden === true, 'extra isHidden truthy → true (coerced)');
r = _normalizeVaultData({ items: [item({ extraFields: [{ label: 'h', value: 'v', isHidden: false }] })] });
ok(!r.items[0].extraFields[0].isHidden, 'extra isHidden false → omitted');

// --- version handling ---------------------------------------------------------

ok(_normalizeVaultData({ items: [] }).version === 1, 'absent version → 1');
ok(_normalizeVaultData({ version: 1, items: [] }).version === 1, 'version 1 → kept');
ok(_normalizeVaultData({ version: 0, items: [] }).version === 1, 'version 0 → legacy default 1');
ok(_normalizeVaultData({ version: '1.5', items: [] }).version === 1, 'string version → coerced to 1');
throws(() => _normalizeVaultData({ version: 2, items: [] }), 'unsupported-version', 'version 2 → rejected');
throws(() => _normalizeVaultData({ version: 99, items: [] }), 'unsupported-version', 'version 99 → rejected');

// The caps must still reject even with the coercion applied: coercion exists to
// accept well-formed equivalents, never to rescue an oversized archive.
throws(() => _normalizeVaultData({ items: [item({ name: 'n'.repeat(MAX_FIELD_LENGTH + 1) })] }), 'field-too-long', 'caps still reject after coercion');

// --- summary -----------------------------------------------------------------

console.log(`\nvault limits & schema: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
}