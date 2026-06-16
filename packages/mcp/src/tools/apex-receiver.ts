/**
 * Shared receiver-resolution heuristics for the heuristic Apex scanner's
 * `readsFrom` / `writesTo` / `callsApex` / `dispatchesAsync` edges.
 *
 * The scanner keys an edge on the TEXTUAL receiver token, so an un-type-resolved
 * local variable or an Apex `this`/`super` member produces an edge to a phantom
 * id (`CustomField:acc.Status__c`, `CustomField:this.y`, `ApexClass:acc`). Every
 * consumer that surfaces these edges — `explain_apex_method`,
 * `what_happens_on_save`, `order_of_execution` — uses these predicates to
 * segregate / drop them so they never read as real components. Centralized here
 * so the three tools can't drift (they previously carried the logic separately).
 */

const FIELD_RECEIVER_RE = /^CustomField:([^.]+)\./;

/**
 * True for a CustomField id whose RECEIVER is an Apex `this`/`super` member or an
 * un-type-resolved local variable (a lowercase single identifier with no
 * namespace / custom `__` marker). PascalCase standard (`Account`), custom
 * (`Payment__c`), and namespaced (`hed__Course__c`) receivers are real fields and
 * return false — even when their node isn't vaulted (the legitimate phantom
 * surface, classified by the phantom taxonomy).
 */
export const isUnresolvedFieldReceiver = (fieldId: string): boolean => {
  const m = FIELD_RECEIVER_RE.exec(fieldId);
  const receiver = m?.[1];
  if (receiver === undefined) return false;
  if (receiver === 'this' || receiver === 'super') return true;
  return /^[a-z]/.test(receiver) && !receiver.includes('__');
};

const APEX_CALL_RE = /^ApexClass:(.+)$/;

/** Context handles / Trigger map tokens the scanner must never treat as classes. */
const HEURISTIC_APEX_CALL_ARTIFACTS = new Set([
  'newMap',
  'oldMap',
  'new',
  'old',
  'this',
  'super',
]);

/**
 * True for a `callsApex` / `dispatchesAsync` target whose class token is an
 * un-type-resolved local variable — a single-token all-lowercase camelCase
 * identifier (`acc`, `map`) or a known context handle (`oldMap`, `newMap`).
 *
 * Real Apex classes that violate PascalCase (e.g. `pkb_Controller`) or carry
 * namespace markers (`ns__Foo`) are NOT flagged — GRF-01.
 */
export const isUnresolvedApexCallTarget = (toId: string): boolean => {
  const m = APEX_CALL_RE.exec(toId);
  const cls = m?.[1];
  if (cls === undefined) return false;
  if (HEURISTIC_APEX_CALL_ARTIFACTS.has(cls)) return true;
  // Underscore-separated names are class api names, not locals (`pkb_Controller`).
  if (cls.includes('_')) return false;
  if (cls.includes('__')) return false;
  // Single-token all-lowercase camelCase → typical local (`acc`, `comment`).
  return /^[a-z][a-zA-Z0-9]*$/.test(cls);
};
