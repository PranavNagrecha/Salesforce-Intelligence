/**
 * Handler for the `sfi.lookup_record` MCP tool.
 *
 * The first of two v1.6 business-user-tier headline tools (per
 * PLAN-v1.6 §4): given a CustomMetadataRecord or CustomSettingRecord
 * canonical id, return the record's label, protected flag, and the
 * full per-field value list the v1.6 R2 extractors materialized into
 * the node's `properties.values` array.
 *
 * The business-user's question this tool answers: "what does this
 * configuration record actually contain?". A v1.6 admin viewing a
 * record-driven feature (an Apex retry policy, a feature-flag matrix,
 * a tenant-specific email template) gets the literal field/value
 * tuples in one call rather than having to open the metadata XML by
 * hand.
 *
 * Implementation notes:
 *   - One `getNodeById(recordId)` call resolves the record. The
 *     handler then projects `node.properties` to the contract output
 *     shape — `label`, `protected`, and the `values` array each
 *     extractor wrote at extraction time.
 *   - Input validation: `recordId` must start with the
 *     `CustomMetadataRecord:` or `CustomSettingRecord:` prefix. Any
 *     other prefix surfaces as `invalid-query` from the handler (not
 *     a Zod-level rejection — Zod cannot express the prefix
 *     constraint here). This mirrors the v1.5
 *     `sfi.event_subscribers` convention of pinning input-axis
 *     prefixes at the handler boundary.
 *   - Unknown ids resolve to `component-not-found`. The graph cannot
 *     distinguish "record file never existed" from "record was
 *     deleted between refresh and lookup"; both share the same
 *     diagnostic.
 *   - **Honesty axis** (per PLAN-v1.6 §3): the v1.6 R2 extractors
 *     collapse Salesforce's managed-package `***` literal to
 *     `{ value: null, isMasked: true }`. The handler passes that
 *     shape through verbatim — it MUST NOT fabricate the underlying
 *     value. Callers rendering the response surface the masked
 *     status to the end user so the missing value is visibly absent
 *     rather than mistaken for `null`.
 *   - The `typeApiName` field on the output carries the parent type's
 *     ApiName with its suffix preserved (`__mdt` for
 *     CustomMetadataRecord, `__c` for CustomSettingRecord). The
 *     suffix matters: it is the cue downstream consumers use to
 *     decide whether to join against CustomField records (for `__mdt`
 *     parents) or against the type's `hierarchyLevel` (for `__c`
 *     parents).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * The two record-typed ComponentTypes the tool accepts as input. v1.6
 * R2 introduced these two extractors together; the tool is the unified
 * query surface that maps to both.
 */
const RECORD_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'CustomMetadataRecord',
  'CustomSettingRecord',
]);

/** Canonical id prefixes that map to the two record node types. */
const CUSTOM_METADATA_RECORD_PREFIX = 'CustomMetadataRecord:';
const CUSTOM_SETTING_RECORD_PREFIX = 'CustomSettingRecord:';

/**
 * Zod schema for the `sfi.lookup_record` tool input.
 *
 *   - `recordId`: required, non-empty string. The canonical record id
 *     (`CustomMetadataRecord:{TypeApiName}.{RecordName}` for CMD or
 *     `CustomSettingRecord:{TypeApiName}.{RecordName}` for CSR).
 *     Invalid prefixes surface as `invalid-query` from the handler,
 *     not a Zod-level rejection — Zod cannot express the prefix
 *     constraint here.
 */
export const lookupRecordInputSchema = z.object({
  recordId: z.string().min(1),
});

/** Parsed input shape, inferred from `lookupRecordInputSchema`. */
export type LookupRecordInput = z.infer<typeof lookupRecordInputSchema>;

/**
 * One field/value tuple in the record. Mirrors the shape both v1.6 R2
 * extractors emit into `properties.values`. `isMasked: true` indicates
 * Salesforce serialized the value as the three-character literal `***`
 * (managed-package masked value); the underlying string/number/boolean
 * is intentionally absent.
 */
export interface RecordFieldValue {
  readonly field: string;
  readonly value: unknown;
  readonly valueType: string;
  readonly isMasked: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface LookupRecordOutput {
  readonly recordId: ComponentId;
  readonly type: ComponentType;
  readonly typeApiName: string;
  readonly label: string;
  readonly protected: boolean;
  readonly values: readonly RecordFieldValue[];
}

/**
 * Decide whether `recordId` carries one of the two record-type
 * prefixes. Returns the type the prefix maps to on success, `null`
 * otherwise. The handler surfaces a `null` return as `invalid-query`.
 */
const classifyRecordId = (recordId: string): ComponentType | null => {
  if (recordId.startsWith(CUSTOM_METADATA_RECORD_PREFIX)) {
    return 'CustomMetadataRecord';
  }
  if (recordId.startsWith(CUSTOM_SETTING_RECORD_PREFIX)) {
    return 'CustomSettingRecord';
  }
  return null;
};

/**
 * Normalize one entry from `node.properties.values` to the contract
 * output shape. Defends against the graph round-trip dropping a key
 * or changing a type — every field is coerced to its expected shape
 * with a conservative fallback (empty string / null / `'unknown'` /
 * `false`) so the handler never throws on a malformed value entry.
 */
const normalizeValueEntry = (raw: unknown): RecordFieldValue => {
  if (typeof raw !== 'object' || raw === null) {
    return { field: '', value: null, valueType: 'unknown', isMasked: false };
  }
  const entry = raw as Record<string, unknown>;
  const field = typeof entry['field'] === 'string' ? entry['field'] : '';
  const valueType =
    typeof entry['valueType'] === 'string' ? entry['valueType'] : 'unknown';
  const isMasked = entry['isMasked'] === true;
  // `value` is `unknown` in the contract — pass through verbatim
  // (including `null`, numbers, booleans, strings) so the caller sees
  // exactly what the extractor wrote.
  const value = entry['value'] === undefined ? null : entry['value'];
  return { field, value, valueType, isMasked };
};

/**
 * Read the record's per-field values array from `node.properties`.
 * Returns an empty array when the property is missing or has an
 * unrecognised shape — the v1.6 R2 extractors always emit a
 * `values: []` even for empty records, so a missing property
 * indicates an upstream extraction issue rather than a record with
 * no fields. The empty-array fallback keeps the response shape
 * stable and lets the caller distinguish "no values" from
 * "extractor produced an unexpected shape" via the `valuesCount`
 * the extractor also wrote (callers can compare `values.length` to
 * `valuesCount` if they want to detect that drift).
 */
const readRecordValues = (node: Node): readonly RecordFieldValue[] => {
  const raw = node.properties['values'];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeValueEntry);
};

/**
 * Read the record's `typeApiName` property — the parent type's
 * ApiName with its suffix (`__mdt` / `__c`) preserved. The v1.6 R2
 * extractors always write this property; the fallback to the parent
 * id's tail handles the unlikely case where a node has been imported
 * from an older extractor schema that lacked the property.
 */
const readTypeApiName = (node: Node): string => {
  const raw = node.properties['typeApiName'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  // Fallback: derive from `parentId` (`CustomObject:{TypeApiName}`).
  if (node.parentId !== null) {
    const colonIdx = node.parentId.indexOf(':');
    if (colonIdx >= 0) return node.parentId.slice(colonIdx + 1);
  }
  return '';
};

/**
 * The `sfi.lookup_record` MCP tool. Returns one record's label,
 * protected flag, parent type ApiName, and the full per-field value
 * list. See the module JSDoc for the input-axis validation rules and
 * the honesty-axis design for masked values.
 *
 * @example
 *   const r = await lookupRecordHandler(ctx, {
 *     recordId: 'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default',
 *   });
 *   if (r.ok) console.log(r.value.data.values.length);
 */
export const lookupRecordHandler = async (
  ctx: Context,
  input: LookupRecordInput,
): Promise<Result<McpResponse<LookupRecordOutput>, McpError>> => {
  const recordType = classifyRecordId(input.recordId);
  if (recordType === null) {
    return err({
      kind: 'invalid-query',
      message: `recordId must start with '${CUSTOM_METADATA_RECORD_PREFIX}' or '${CUSTOM_SETTING_RECORD_PREFIX}'; got '${input.recordId}'`,
      path: 'recordId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.recordId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: `no record with id ${input.recordId}`,
      path: input.recordId,
    });
  }

  // Defensive: the prefix already pins the expected type, but the
  // graph round-trip could in principle return a node with a
  // different `type`. Treat that as `component-not-found` since the
  // caller's request cannot be satisfied by what the vault holds.
  if (!RECORD_NODE_TYPES.has(node.type)) {
    return err({
      kind: 'component-not-found',
      message: `node ${input.recordId} is not a record node (type=${node.type})`,
      path: input.recordId,
    });
  }

  const protectedRaw = node.properties['protected'];
  const isProtected = protectedRaw === true;
  const labelRaw = node.properties['label'];
  const label =
    typeof labelRaw === 'string'
      ? labelRaw
      : node.label !== null
        ? node.label
        : '';

  return ok({
    data: {
      recordId: node.id,
      type: node.type,
      typeApiName: readTypeApiName(node),
      label,
      protected: isProtected,
      values: readRecordValues(node),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
