/**
 * The one place a sharing rule's record-match filter is turned into text.
 *
 * A criteria-shaped rule (`criteria`, `guest`, `territory`, `territoryGroup`)
 * stores its filter as `criteriaItems` (field / operation / value) plus an
 * OPTIONAL `booleanFilter` (`1 AND (2 OR 3)`) that Salesforce writes only when
 * the admin typed custom logic. A rule with one criterion, or several joined by
 * AND, has no `booleanFilter` at all. Rendering from `booleanFilter` alone
 * therefore printed "(predicate not extracted)" for most rules on a real org
 * (72 of 81), hiding filters such as `CreatedById startsWith 005` — every
 * user-created record — behind a caveat (SHARING-PREDICATE).
 *
 * Order: criteria items substituted into the custom logic when present, else
 * AND-joined; a `booleanFilter` with no items (a vault refreshed before the
 * extractor stored items) is quoted raw; a count alone says how many criteria
 * the vault could not show; "(predicate not extracted)" only when the node
 * holds neither.
 */

/** The placeholder every consumer prints when the node carries no filter at all. */
const PREDICATE_NOT_EXTRACTED = '(predicate not extracted)';

const renderItem = (item: Record<string, unknown>): string => {
  const value = item['value'];
  const head = `${String(item['field'])} ${String(item['operation'])}`;
  return value === null || value === undefined ? head : `${head} ${String(value)}`;
};

/** Render a sharing rule's filter as one line of text (never empty). */
export const renderSharingPredicate = (rule: {
  readonly properties: Readonly<Record<string, unknown>>;
}): string => {
  const { properties } = rule;
  const bf = properties['booleanFilter'];
  const booleanFilter = typeof bf === 'string' && bf.trim().length > 0 ? bf.trim() : null;
  const items = (Array.isArray(properties['criteriaItems']) ? properties['criteriaItems'] : [])
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && 'field' in i)
    .map(renderItem);
  const count = properties['criteriaItemCount'];
  if (items.length > 0) {
    if (booleanFilter === null) return items.join(' AND ');
    // `1 AND (2 OR 3)` → each 1-based number is its criterion. When the
    // extractor skipped a malformed item the numbering no longer lines up, so
    // the logic is quoted as typed beside the criteria that were extracted.
    if (typeof count === 'number' && count !== items.length) {
      return `${booleanFilter} over ${items.length} of ${count} criteria extracted: ${items.join('; ')}`;
    }
    return booleanFilter.replace(/\d+/g, (n) => items[Number(n) - 1] ?? n);
  }
  if (booleanFilter !== null) return booleanFilter;
  if (typeof count === 'number' && count > 0) return `${count} criteria item(s) ${PREDICATE_NOT_EXTRACTED}`;
  return PREDICATE_NOT_EXTRACTED;
};
