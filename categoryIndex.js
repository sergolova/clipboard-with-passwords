// Category membership and counts for the vault, in a single pass.
//
// Both the filter bar and its labels need to know which categories exist and
// how many records each one holds. Asking for that one category at a time
// means re-walking every record per category: a vault with 1000 records in 200
// categories did 200 000 comparisons to answer a question one pass already had
// the answer to. This module produces the whole picture at once — the category
// list, in order of first appearance, plus an O(1) count lookup — and the
// caller caches the result until the records change.
//
// It deliberately imports nothing from St/Clutter so it can be exercised in a
// plain gjs process, where no display connection exists.

/**
 * Summarise a vault's records by category.
 *
 * A record with no category contributes to the total but names no category,
 * which is what a caller asking for "how many records" and a caller asking for
 * "how many in Work" each expect.
 *
 * @param {Array<object>} items - the vault records, in display order
 * @returns {{categories: string[], counts: Map<string, number>, total: number}}
 *   `categories` lists each distinct non-empty category once, in the order it
 *   first appears; `counts` maps a category to the number of records carrying
 *   it; `total` is the number of records, including the uncategorized ones
 */
export function buildCategoryIndex(items) {
    const categories = [];
    const counts = new Map();
    let total = 0;

    // A missing record list reads as "no records", the way the item lookup has
    // always treated it: a locked or half-initialized vault must not throw.
    for (const item of items ?? []) {
        total++;
        const category = item?.category;
        if (!category)
            continue;
        // A Map cannot answer "is this category new?" without a lookup, and a
        // second Set would double the bookkeeping: the count of zero is unique
        // to a category that has just been met, because the counter only ever
        // grows from there.
        const count = counts.get(category);
        if (count === undefined) {
            categories.push(category);
            counts.set(category, 1);
        } else {
            counts.set(category, count + 1);
        }
    }

    return {categories, counts, total};
}

/**
 * The number of records in one category, with the same meaning the item lookup
 * gives it: an empty category name and the bar's pseudo-category both count
 * every record rather than none, because the lookup does not filter on either.
 *
 * @param {{counts: Map<string, number>, total: number}} index
 * @param {string} category
 * @param {string} allCategory - the pseudo-category name, passed in so this
 *   module stays free of the sentinel's definition
 * @returns {number}
 */
export function categoryCount(index, category, allCategory) {
    if (!category || category === allCategory)
        return index.total;
    return index.counts.get(category) ?? 0;
}
