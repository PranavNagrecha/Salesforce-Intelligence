/**
 * ONE reader for "which literal values does this condition / edge compare or
 * write for a given field?" — shared by every value-sensitive tool
 * (`what_if_remove_picklist_value`, `value_change_audit`), so none of them
 * re-parses the prose `expression` with its own quote assumption.
 *
 * Why not the expression: Flow and workflow criteria render as
 * `Status__c EqualTo Closed` — UNQUOTED — so a `'Closed'` needle never matched
 * a Flow decision, entry filter, or workflow criterion (the picklist-removal
 * tool reported "no impacts" for values active flows test). The extractor now
 * stamps structured `conditionItems` on each ConditionalContext and
 * `assignedValue` / `filterValue` / `literalValues` on Flow field edges; this
 * module reads those, and falls back to a bounded token match on the prose
 * only for a vault built before `conditionItems` existed.
 */

import type { Node } from '@sf-intelligence/contracts';

import { familyWasExtracted } from './absence-disclosure.js';

/** One structured triplet off a ConditionalContext (see the extractor's ConditionItemRecord). */
export interface ConditionItemView {
  readonly field: string;
  readonly fieldId: string | null;
  readonly operator: string;
  readonly value: string | null;
  readonly valueKind?: 'literal' | 'reference';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Type narrowing only — presence is decided by the caller. */
const asList = (v: unknown): readonly unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** The node's structured items, or `null` when the vault predates them. */
export const readConditionItems = (node: Node): readonly ConditionItemView[] | null => {
  // Absent = the vault predates structured items (null); present = extracted.
  if (!familyWasExtracted(node.properties, 'conditionItems')) return null;
  const out: ConditionItemView[] = [];
  for (const item of asList(node.properties['conditionItems'])) {
    if (!isRecord(item)) continue;
    const field = typeof item['field'] === 'string' ? item['field'] : '';
    const operator = typeof item['operator'] === 'string' ? item['operator'] : '';
    const value = typeof item['value'] === 'string' ? item['value'] : null;
    const fieldId = typeof item['fieldId'] === 'string' ? item['fieldId'] : null;
    const valueKind =
      item['valueKind'] === 'literal' || item['valueKind'] === 'reference'
        ? item['valueKind']
        : undefined;
    out.push({ field, fieldId, operator, value, ...(valueKind !== undefined ? { valueKind } : {}) });
  }
  return out;
};

const lastSegment = (path: string): string => {
  const parts = path.split('.');
  return (parts[parts.length - 1] ?? '').toLowerCase();
};

/**
 * Does this triplet test `fieldId`? An exact resolved id wins; a relationship
 * traversal (`$Record.Parent__r.Status__c`) or unresolved path falls back to
 * the leaf name — the caller only asks about conditions already linked to the
 * field by an incoming edge, so the leaf check cannot reach an unrelated object.
 */
const itemTestsField = (item: ConditionItemView, fieldId: string): boolean => {
  const leaf = lastSegment(fieldId.replace(/^CustomField:/, ''));
  if (item.fieldId !== null && /^CustomField:[^.$]+\.[^.]+$/.test(item.fieldId)) {
    if (item.fieldId.toLowerCase() === fieldId.toLowerCase()) return true;
    // A well-formed id on a relationship spelling (`Parent__r.X`) is not an
    // object; anything else that resolved is a DIFFERENT field.
    if (!/^CustomField:[^.]*__r\./i.test(item.fieldId)) return false;
  }
  return lastSegment(item.field) === leaf;
};

/**
 * Split a stored comparison into the individual values it names: multi-select
 * picklists join with `;`, sharing-rule / list-view criteria with `,`.
 */
export const splitCompoundValue = (raw: string, separators: string): readonly string[] =>
  raw
    .split(new RegExp(`[${separators.replace(/[\]\\^-]/g, '\\$&')}]`))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/** True when `candidate` names `value` exactly, alone or inside a `;`-joined multi-select literal. */
export const literalNamesValue = (candidate: string, value: string): boolean =>
  candidate === value || splitCompoundValue(candidate, ';').includes(value);

/**
 * The triplets in a ConditionalContext that compare `fieldId` to the literal
 * `value`. A reference-valued comparison (`EqualTo Get_X.Status__c`) is never
 * a literal match. Returns `null` when the node carries no structured items
 * (pre-upgrade vault) so the caller can fall back to {@link expressionNamesValue}.
 */
export const conditionItemsTestingValue = (
  node: Node,
  fieldId: string,
  value: string,
): readonly ConditionItemView[] | null => {
  const items = readConditionItems(node);
  if (items === null) return null;
  return items.filter(
    (item) =>
      item.value !== null &&
      item.valueKind !== 'reference' &&
      itemTestsField(item, fieldId) &&
      (literalNamesValue(item.value, value) ||
        splitCompoundValue(item.value, ',').includes(value)),
  );
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fallback for a ConditionalContext without structured items: does the prose
 * expression compare the field to `value`? Matches the quoted formula form
 * (`'X'` / `"X"`) and the unquoted criteria form `<path ending in Field> <Op> X`
 * bounded by `)`, ` AND `, ` OR `, or end — so `Flag` never matches `Flagged`.
 */
export const expressionNamesValue = (
  expression: string,
  fieldApiName: string,
  value: string,
): boolean => {
  if (expression.includes(`'${value}'`) || expression.includes(`"${value}"`)) return true;
  const re = new RegExp(
    `(?:^|[\\s(.])${escapeRegex(fieldApiName)}\\s+[A-Za-z]+\\s+${escapeRegex(value)}(?=$|\\)|\\s+(?:AND|OR)\\b)`,
    'i',
  );
  return re.test(expression);
};

// The edge readers live in core so the extractors, the graph import's value
// merge, and every value-aware tool read a write edge the same way.
export { edgeLiteralValues, edgeReferenceValues } from '@sf-intelligence/core';
