// Decision half of the vault service-card list update.
//
// The vault menu used to answer every refresh by destroying the whole card
// tree and building it again, so switching into vault mode — or saving a
// single service — cost one actor tree per stored record. This module works
// out, from plain data, what actually has to happen: which cards can be left
// alone, which only need their colours re-applied, which need their contents
// rebuilt, and which are gone. The caller performs the actor work.
//
// It deliberately imports nothing from St/Clutter so it can be exercised in a
// plain gjs process, where no display connection exists.

/**
 * Work out the minimal set of card operations for a new item list.
 *
 * A card survives untouched only when it already shows exactly the item it is
 * asked to show and nothing it bakes into its own appearance has moved.
 * "Shows exactly the same item" is decided by object identity rather than by
 * comparing fields: every write path in the vault manager replaces the record
 * with a freshly built object, so a different object always means different
 * content — and comparing 4096-character passwords field by field would cost
 * more than the actor rebuild this is meant to avoid.
 *
 * Ordering: removals detach themselves and in-place updates keep their slot, so
 * the only thing that can leave the display order stale is the model asking for
 * a different order than the one on screen. That is rare — the vault's own write
 * paths only prepend, insert or remove — so the plan reports it instead of
 * assuming it away, and the caller reorders only when told to.
 *
 * @param {Array<object>} previous - cards currently alive, in display order;
 *   each carries `{ id, item, palette, styleKey, card }`
 * @param {Array<object>} items - the full item list, in the wanted display order
 * @param {object} options
 * @param {object} options.palette - active colour palette, compared by identity
 * @param {string} options.styleKey - changes whenever something besides colour
 *   is baked into a card (e.g. the opt-in hidden-edge warning icon, whose very
 *   presence depends on it)
 * @param {boolean} options.inStage - whether the card container is in the
 *   stage. Assigning `style` to an off-stage widget reaches for a theme node
 *   that does not exist yet, so a palette change is applied by rebuilding the
 *   card instead of restyling it
 * @returns {{order: Array<object>, restyle: Array<object>, update: Array<object>,
 *   removed: Array<object>, reordered: boolean}} the operations to perform;
 *   `order` is the wanted final sequence, one slot per item, with `isNew` set on
 *   the slots that have to be built and attached
 */
export function planCardUpdate (previous, items, { palette, styleKey, inStage }) {
    // A hand-edited archive can repeat an id. The first live card claims the
    // id so a duplicate can never end up driving two entries; later items with
    // the same id fall through to "create", which keeps the UI correct instead
    // of showing one card with two different services.
    const live = new Map();
    for (const record of previous) {
        if (!live.has(record.id))
            live.set(record.id, record);
    }

    const order = [];
    const restyle = [];
    const update = [];
    const claimed = new Set();
    const claimedIds = new Set();

    items.forEach((item, index) => {
        const record = claimedIds.has(item.id) ? undefined : live.get(item.id);
        if (record)
            claimedIds.add(item.id);

        if (!record) {
            order.push({ record: null, item, index, isNew: true });
            return;
        }

        claimed.add(record);

        let action = 'keep';
        if (record.item !== item || record.styleKey !== styleKey) {
            // Content moved, or a setting that decides which rows and icons the
            // card carries moved. Both need the card's children rebuilt.
            action = 'update';
        } else if (record.palette !== palette) {
            action = inStage ? 'restyle' : 'update';
        }

        order.push({ record, item, index, isNew: false, action });
        if (action === 'update')
            update.push({ record, item });
        else if (action === 'restyle')
            restyle.push(record);
    });

    const removed = previous.filter(record => !claimed.has(record));

    // Does the model ask for a different order than the one on screen? Only the
    // surviving cards can be out of place — new ones are attached above the card
    // that has to follow them, which already puts them in the right slot.
    const onScreen = previous.filter(record => claimed.has(record));
    const wanted = order.filter(slot => !slot.isNew).map(slot => slot.record);
    const reordered = onScreen.length !== wanted.length ||
        onScreen.some((record, i) => record !== wanted[i]);

    return { order, restyle, update, removed, reordered };
}
