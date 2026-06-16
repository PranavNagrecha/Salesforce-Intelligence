/**
 * Shared accessors for CustomField `Node.properties`.
 *
 * **Why this exists.** The CustomField extractor writes the field's
 * Salesforce data type under `properties.dataType` (see
 * `packages/extractors/src/custom-field.ts` `buildProperties` — the key
 * is `dataType`, and `properties.type` is never populated). Several
 * field-facing MCP tools historically read `properties.type` directly,
 * which silently resolved to `undefined` → `'Unknown'`, poisoning their
 * verdicts (`what_if_change_field_type` hard-returned `breaking`;
 * `what_if_remove_picklist_value` rejected real picklists with a bogus
 * `has type 'Unknown'` error). Centralising the read here — `dataType`
 * first, `type` as a defensive fallback for any legacy/hand-rolled
 * vault — keeps the four field tools from drifting apart again.
 */

import type { Node } from '@sf-intelligence/contracts';

/** Sentinel returned when neither property carries a string data type. */
export const UNKNOWN_FIELD_TYPE = 'Unknown';

/**
 * Resolve a CustomField's Salesforce data type from its node
 * properties. Prefers `properties.dataType` (the extractor's canonical
 * key); falls back to `properties.type` for resilience against older or
 * hand-authored vaults; returns `UNKNOWN_FIELD_TYPE` when neither is a
 * string.
 */
export const readFieldDataType = (node: Node): string => {
  const dataType = node.properties['dataType'];
  if (typeof dataType === 'string') return dataType;
  const legacyType = node.properties['type'];
  if (typeof legacyType === 'string') return legacyType;
  return UNKNOWN_FIELD_TYPE;
};
