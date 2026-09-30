// Card reconciliation for the vault service list.
//
// The reconciler's whole job is deciding what has to happen to a card list, so
// these tests drive it through the operations a caller would perform and assert
// on the resulting state: which cards survived, which were rebuilt, which were
// dropped, and — the part that is easy to get wrong — the final display order.
//
// The container below models the real one: an ordered list of child actors, with
// `destroy()` detaching a child and new cards slotted in above the child that
// has to follow them. Keeping that model honest is what makes the ordering
// assertions worth anything.

import { planCardUpdate } from '../cardReconciler.js';

let passed = 0;
let failed = 0;

function ok (cond, label) {
    if (cond) {
        passed++;
    } else {
        failed++;
        print(`  FAIL: ${label}`);
    }
}

function eq (actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${label} (expected ${e}, got ${a})`);
}

// A palette stand-in: identity comparison is all the reconciler does with it.
const DARK = { name: 'dark' };
const LIGHT = { name: 'light' };

// A vault item. The manager rebuilds the whole object on every write, so `edit`
// models "the user saved this service" the way the real manager does it.
function item (id, name = id) {
    return { id, name, updatedAt: 1 };
}

function edit (existing, changes) {
    return { ...existing, ...changes, updatedAt: existing.updatedAt + 1 };
}

function newState () {
    return {
        cards: [],                  // live card records, in display order
        container: [],              // the item container's children, in order
        byActor: new Map(),         // child actor -> card record
        hint: null,                 // the "Type to reveal services…" label
        creations: 0
    };
}

const displayOrder = state => state.container
    .filter(child => state.byActor.has(child))
    .map(child => child.id);

// Inserts `actor` so that it becomes the child right above `sibling`, which is
// what St.BoxLayout's insert_child_below/above do.
function attach (state, actor, sibling) {
    if (sibling === null) {
        state.container.push(actor);
    } else {
        state.container.splice(state.container.indexOf(sibling), 0, actor);
    }
}

// Applies a plan the way PasswordVaultMenuSection._syncCards does.
function apply (state, items, { palette = DARK, styleKey = 'nowarn', inStage = true } = {}) {
    const log = [];
    const plan = planCardUpdate(state.cards, items, { palette, styleKey, inStage });

    // 1. Retire the cards whose service is gone.
    for (const record of plan.removed) {
        log.push(`destroy:${record.id}`);
        state.container.splice(state.container.indexOf(record.card), 1);
        state.byActor.delete(record.card);
    }

    // 2. Refill the cards whose service changed, in place.
    for (const { record, item: it } of plan.update) {
        log.push(`update:${record.id}`);
        record.item = it;
        record.palette = palette;
        record.styleKey = styleKey;
    }

    // 3. Re-apply the palette to the cards whose content is still correct.
    for (const record of plan.restyle) {
        log.push(`restyle:${record.id}`);
        record.palette = palette;
    }

    // 4. Build the new cards, then attach each one above the card that follows
    //    it. Walking backwards guarantees that "the card below" is attached.
    const records = plan.order.map(slot => {
        if (!slot.isNew)
            return slot.record;
        log.push(`create:${slot.item.id}`);
        state.creations++;
        return { id: slot.item.id, item: slot.item, palette, styleKey, card: { id: slot.item.id } };
    });
    for (let i = records.length - 1; i >= 0; i--) {
        if (!plan.order[i].isNew)
            continue;
        const next = records[i + 1];
        attach(state, records[i].card, next ? next.card : state.hint);
    }

    // 5. Reorder, but only the cards that are not already in place.
    if (plan.reordered) {
        log.push('reorder');
        for (let i = records.length - 1; i >= 0; i--) {
            const next = records[i + 1];
            const below = next ? next.card : state.hint;
            const at = state.container.indexOf(records[i].card);
            const belowAt = below ? state.container.indexOf(below) : state.container.length;
            if (at === belowAt - 1)
                continue;
            state.container.splice(at, 1);
            attach(state, records[i].card, below);
        }
    }

    for (const record of records)
        state.byActor.set(record.card, record);

    state.cards = records;
    return { log, plan };
}

print('== opening an already-rendered vault touches nothing ==');
{
    const a = item('a'), b = item('b'), c = item('c');
    const state = newState();
    apply(state, [a, b, c]);
    eq(displayOrder(state), ['a', 'b', 'c'], 'first render creates all three');
    eq(state.creations, 3, 'three cards created');
    eq(state.container.length, 3, 'three children in the container');

    const second = apply(state, [a, b, c]);
    eq(second.log, [], 'second render with unchanged data performs no operations');
    eq(state.creations, 3, 'no card was destroyed and recreated');
    eq(state.container.length, 3, 'the container is untouched');
}

print('== editing one service updates only that card ==');
{
    const a = item('a'), b = item('b'), c = item('c');
    const state = newState();
    apply(state, [a, b, c]);
    const cardA = state.cards[0].card;

    const next = apply(state, [edit(a, { name: 'renamed' }), b, c]);

    eq(next.log, ['update:a'], 'exactly one operation, on the edited service');
    eq(state.cards[0].card, cardA, 'the edited card keeps its actor');
    eq(state.cards[1].card.card, undefined, 'unrelated cards keep theirs');
    eq(state.creations, 3, 'no new card was created');
    eq(state.cards[0].item.name, 'renamed', 'the record now points at the new item');
    eq(displayOrder(state), ['a', 'b', 'c'], 'order unchanged');
}

print('== adding one service creates exactly one card ==');
{
    const a = item('a'), b = item('b');
    const state = newState();
    apply(state, [a, b]);

    // addService() unshifts, so the new service lands at the front.
    const next = apply(state, [item('n'), a, b]);

    eq(next.log, ['create:n'], 'one create, no destroy, no update');
    eq(state.creations, 3, 'exactly one new card');
    eq(displayOrder(state), ['n', 'a', 'b'], 'the new service is first, the rest kept their slots');
}

print('== adding several services keeps the requested order ==');
{
    const a = item('a'), b = item('b');
    const state = newState();
    apply(state, [a, b]);

    // A brand-new list in a completely different order.
    const next = apply(state, [item('z'), item('y'), a, b]);
    eq(next.log, ['create:z', 'create:y'], 'only the two new services are built');
    eq(displayOrder(state), ['z', 'y', 'a', 'b'], 'the new order is respected');
    eq(state.container.length, 4, 'four children');
}

print('== a new card is placed in its slot, not appended ==');
{
    const a = item('a'), b = item('b'), c = item('c');
    const state = newState();
    apply(state, [a, b, c]);

    // A new service between two existing ones, with every other service intact.
    const next = apply(state, [a, b, item('mid'), c]);
    eq(next.log, ['create:mid'], 'one create, nothing else');
    eq(displayOrder(state), ['a', 'b', 'mid', 'c'], 'it landed in the middle, not at the end');
    eq(state.container.length, 4, 'four children');
}

print('== deleting one service destroys exactly one card ==');
{
    const a = item('a'), b = item('b'), c = item('c');
    const state = newState();
    apply(state, [a, b, c]);
    const cardB = state.cards[1].card;

    const next = apply(state, [a, c]);

    eq(next.log, ['destroy:b'], 'one destroy, nothing rebuilt');
    eq(state.byActor.has(cardB), false, 'the deleted card is gone');
    eq(state.container.length, 2, 'the container shrank by one');
    eq(state.creations, 3, 'and nothing was created');
    eq(displayOrder(state), ['a', 'c'], 'the gap closed on its own');
}

print('== deleting several services at once ==');
{
    // The same item objects have to be handed back: the manager only replaces a
    // record when the service was actually written, so a fresh object for an
    // untouched service would (correctly) count as a change.
    const a = item('a'), b = item('b'), c = item('c'), d = item('d');
    const state = newState();
    apply(state, [a, b, c, d]);
    const next = apply(state, [c]);
    eq(next.log, ['destroy:a', 'destroy:b', 'destroy:d'], 'three destroys, no rebuilds');
    eq(displayOrder(state), ['c'], 'only the survivor is left');
    eq(state.container.length, 1, 'one child left');
}

print('== a mixed edit, add and delete in one pass ==');
{
    const a = item('a'), b = item('b'), c = item('c');
    const state = newState();
    apply(state, [a, b, c]);
    const cardC = state.cards[2].card;

    const next = apply(state, [item('n'), edit(a, { name: 'a2' }), c, item('d')]);

    eq(next.log, ['destroy:b', 'update:a', 'create:n', 'create:d'],
        'one destroy, one update, two creates — and nothing else');
    eq(state.byActor.has(cardC), true, 'the survivor c kept its actor');
    eq(displayOrder(state), ['n', 'a', 'c', 'd'], 'final order matches the model');
}

print('== emptying the vault and filling it again ==');
{
    const state = newState();
    apply(state, [item('a'), item('b')]);
    const next = apply(state, []);
    eq(next.log, ['destroy:a', 'destroy:b'], 'everything is dropped');
    eq(state.cards.length, 0, 'no cards left');
    eq(state.container.length, 0, 'the container is empty');

    const again = apply(state, [item('a')]);
    eq(again.log, ['create:a'], 'the vault can be repopulated afterwards');
    eq(displayOrder(state), ['a'], 'and the card is there');
}

print('== the reveal hint stays below every card ==');
{
    // In hide-All mode the hint is added to the same container as the cards and
    // must remain the last child, or a new card appended after it would hide it.
    const a = item('a'), b = item('b');
    const state = newState();
    apply(state, [a, b]);
    state.hint = { id: 'hint' };
    state.container.push(state.hint);
    eq(state.container.map(c => c.id), ['a', 'b', 'hint'], 'the hint is last');

    apply(state, [item('n'), a, b]);
    eq(state.container.map(c => c.id), ['n', 'a', 'b', 'hint'],
        'a new card was placed above the hint, not below it');

    apply(state, [item('m'), item('n'), a, b]);
    eq(state.container.map(c => c.id), ['m', 'n', 'a', 'b', 'hint'],
        'and again with two new cards at once');
}

print('== a theme change restyles in place when the container is in the stage ==');
{
    const a = item('a'), b = item('b');
    const state = newState();
    apply(state, [a, b], { palette: DARK });
    const cardA = state.cards[0].card;

    const next = apply(state, [a, b], { palette: LIGHT });

    eq(next.log, ['restyle:a', 'restyle:b'], 'both cards restyled, none rebuilt');
    eq(state.cards[0].card, cardA, 'the actors survived the re-theme');
    eq(state.creations, 2, 'nothing was rebuilt');

    const third = apply(state, [a, b], { palette: LIGHT });
    eq(third.log, [], 'and the new palette is recorded, so it is not repeated');
}

print('== a theme change rebuilds instead when the container is off stage ==');
{
    const a = item('a');
    const state = newState();
    apply(state, [a], { palette: DARK });

    // Assigning `style` off stage reaches for a theme node that does not exist,
    // so the card has to be built again instead.
    const next = apply(state, [a], { palette: LIGHT, inStage: false });
    eq(next.log, ['update:a'], 'the card is rebuilt, not restyled');

    const third = apply(state, [a], { palette: LIGHT, inStage: true });
    eq(third.log, [], 'the rebuilt card already carries the new palette');
}

print('== a setting that changes what a card contains forces a rebuild ==');
{
    const a = item('a');
    const state = newState();
    apply(state, [a], { styleKey: 'nowarn' });

    // The hidden-edge warning icon is opt-in: with it enabled the card has to
    // gain an icon, which restyling cannot do.
    const next = apply(state, [a], { styleKey: 'warn' });
    eq(next.log, ['update:a'], 'the card is rebuilt, not merely restyled');
}

print('== an item object swapped without a real content change is still a rebuild ==');
{
    // The manager rebuilds the record on every write, so identity is the only
    // sound "has this changed" signal; a structurally equal replacement must not
    // be mistaken for an unchanged card.
    const a = item('a');
    const state = newState();
    apply(state, [a]);
    const next = apply(state, [{ ...a }]);
    eq(next.log, ['update:a'], 'a new object for the same service rebuilds the card');
}

print('== duplicate ids in a hand-edited archive do not share a card ==');
{
    const a = item('dup', 'first');
    const b = item('dup', 'second');
    const state = newState();
    apply(state, [a]);
    const cardOfFirst = state.cards[0].card;

    const next = apply(state, [a, b]);

    eq(next.log, ['create:dup'], 'the duplicate gets its own card');
    eq(state.cards[0].card, cardOfFirst, 'the first card was reused');
    ok(state.cards[0].card !== state.cards[1].card, 'the two entries own different actors');
    eq(state.cards[1].item.name, 'second', 'the second entry points at its own item');
    eq(state.container.length, 2, 'two children, not one shared card');
}

print('== a large vault is only touched where it has to be ==');
{
    const items = Array.from({ length: 1000 }, (_, i) => item(`svc${i}`));

    // Reopening an unchanged vault.
    {
        const state = newState();
        apply(state, items);
        const created = state.creations;
        const next = apply(state, items);
        eq(next.log.length, 0, 'reopening a 1000-service vault performs no operations');
        eq(next.plan.reordered, false, 'and does not report a reorder');
        eq(state.creations, created, 'no card was recreated');
        eq(state.container.length, 1000, 'still 1000 children');
    }

    // Saving one service: the manager replaces exactly that record.
    {
        const state = newState();
        apply(state, items);
        const created = state.creations;
        const edited = items.slice();
        edited[500] = edit(items[500], { name: 'renamed' });
        const next = apply(state, edited);
        eq(next.log, ['update:svc500'], 'saving one service touches exactly one card');
        eq(state.creations, created, 'no card was recreated');
        eq(state.container.length, 1000, 'still 1000 children');
        eq(next.plan.reordered, false, 'and no reorder is reported');
    }

    // Deleting one service.
    {
        const state = newState();
        apply(state, items);
        const created = state.creations;
        const next = apply(state, items.filter(it => it.id !== 'svc7'));
        eq(next.log, ['destroy:svc7'], 'deleting one service destroys exactly one card');
        eq(state.container.length, 999, '999 children left');
        eq(state.creations, created, 'and nothing was rebuilt');
    }

    // Adding one service to a full vault.
    {
        const state = newState();
        apply(state, items);
        const created = state.creations;
        const next = apply(state, [item('brand-new'), ...items]);
        eq(next.log, ['create:brand-new'], 'adding one service creates exactly one card');
        eq(state.creations, created + 1, 'exactly one card was created');
        eq(state.container.length, 1001, '1000 + 1 children');
        eq(displayOrder(state)[0], 'brand-new', 'the new service is first');
        eq(displayOrder(state)[1], 'svc0', 'and the rest follow in the old order');
    }
}

print('== a service moving position is not mistaken for a content change ==');
{
    const a = item('a'), b = item('b');
    const state = newState();
    apply(state, [a, b]);
    const cardA = state.cards[0].card, cardB = state.cards[1].card;

    const next = apply(state, [b, a]);

    eq(next.log, ['reorder'], 'a reorder is reported, and nothing else happens');
    eq(next.plan.reordered, true, 'the plan flags the order change');
    eq(state.cards[0].card, cardB, 'b is first and kept its actor');
    eq(state.cards[1].card, cardA, 'a is second and kept its actor');
    eq(state.creations, 2, 'no card was rebuilt');
    eq(displayOrder(state), ['b', 'a'], 'the container order follows the model');

    // Once the container matches the model, a further refresh must not reorder
    // again.
    const again = apply(state, [b, a]);
    eq(again.plan.reordered, false, 'the second pass finds the order already correct');
    eq(again.log, [], 'and does nothing');
}

print('== a shuffle of many cards converges to the model order ==');
{
    const items = Array.from({ length: 8 }, (_, i) => item(`s${i}`));
    const state = newState();
    apply(state, items);
    const created = state.creations;

    const shuffled = [items[5], items[0], items[7], items[2], items[1], items[6], items[3], items[4]];
    const next = apply(state, shuffled);
    eq(next.plan.reordered, true, 'the shuffle is reported');
    eq(next.log.filter(op => !op.startsWith('reorder')), [], 'no card was rebuilt or created');
    eq(state.creations, created, 'all eight cards are the originals');
    eq(displayOrder(state), ['s5', 's0', 's7', 's2', 's1', 's6', 's3', 's4'],
        'the container ends up in exactly the model order');
}

print('== a shuffle combined with a delete still converges ==');
{
    const items = Array.from({ length: 6 }, (_, i) => item(`s${i}`));
    const state = newState();
    apply(state, items);

    const next = apply(state, [items[4], items[1], items[0]]);
    eq(next.log.filter(op => op !== 'reorder'), ['destroy:s2', 'destroy:s3', 'destroy:s5'],
        'the three removed services are destroyed, nothing else');
    eq(displayOrder(state), ['s4', 's1', 's0'], 'the survivors are in the model order');
}

print(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} assertions failed`);
