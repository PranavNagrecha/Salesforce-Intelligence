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
 *   - **Typed absence** (R1): `values: []` is ambiguous on its own, so the
 *     response also carries `valuesState` (`read` / `not-extracted` /
 *     `unreadable`), the extractor's own `valuesCount`, and a `disclosures`
 *     array. A node that does not CARRY the `values` property was built by a
 *     refresh predating the v1.6 R2 extractors — never scanned — and must
 *     never render as a record that was scanned and declares nothing.
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

import {
  familyWasExtracted,
  notExtractedFamilyDisclosure,
} from './absence-disclosure.js';
import { firstNonEmpty } from './input-aliases.js';

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
 * The node property BOTH v1.6 R2 extractors ALWAYS write when they read a
 * record's `<values>` elements — `[]` for a record that declares none
 * (`custom-metadata-record.ts` / `custom-setting-record.ts` both push
 * `values` and `valuesCount` unconditionally). So a node that does not CARRY
 * this property was built by a refresh that predates the extractor: never
 * scanned, NOT scanned-and-clean.
 */
const RECORD_VALUES_SENTINEL = 'values';

/** The extractor's own count of `<values>` entries, written beside the array. */
const RECORD_VALUES_COUNT_PROPERTY = 'valuesCount';

/**
 * The arguments this tool advertises, named once so the refusal can list them.
 * `typeApiName` is an ACCEPTED alias rather than an advertised argument, so it
 * is deliberately absent.
 */
const LOOKUP_RECORD_ADVERTISED_KEYS = ['recordId', 'objectApiName'] as const;

/**
 * Verbatim refusal for a mistyped argument. A silently-stripped key means the
 * answer is about a question the caller did not ask, which is the failure this
 * whole tool surface exists to prevent.
 */
const unrecognizedArgumentMessage = (keys: readonly string[]): string =>
  `Unrecognized argument(s): ${keys
    .map((k) => `\`${k}\``)
    .join(', ')}. \`sfi.lookup_record\` accepts: ${LOOKUP_RECORD_ADVERTISED_KEYS.join(', ')}. A mistyped argument is refused rather than ignored, so the answer is never about a question you did not ask.`;

/**
 * Zod schema for the `sfi.lookup_record` tool input.
 *
 *   - `recordId`: required, non-empty string. The canonical record id
 *     (`CustomMetadataRecord:{TypeApiName}.{RecordName}` for CMD or
 *     `CustomSettingRecord:{TypeApiName}.{RecordName}` for CSR).
 *     Invalid prefixes surface as `invalid-query` from the handler,
 *     not a Zod-level rejection — Zod cannot express the prefix
 *     constraint here.
 *   - `objectApiName` (alias `typeApiName`): OPTIONAL natural selector. When
 *     supplied it must AGREE with the type the record id already names;
 *     disagreement is a named `invalid-query`, never a silent answer about the
 *     other object. Agreement is case-insensitive — Salesforce api names are —
 *     and `appliedScope` echoes the CANONICAL casing from the node.
 *
 * `.strict()`: an unrecognized argument is REFUSED rather than stripped. The
 * enumeration the design required was run before flipping it — nothing in
 * `route-question.ts`, `intent-router.ts`, `funnel-utterances.ts`, `eval/`, or
 * the skills forwards any key to this tool but `recordId`.
 */
export const lookupRecordInputSchema = z
  .object(
    {
      recordId: z.string().min(1),
      objectApiName: z.string().min(1).optional(),
      typeApiName: z.string().min(1).optional(),
    },
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: unrecognizedArgumentMessage(issue.keys) }
          : { message: ctx.defaultError },
    },
  )
  .strict();

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
  /**
   * WHY `values` looks the way it does — the R1 axis, in the payload rather
   * than in a comment:
   *
   *   - `read` — the extractor scanned this record. `values` is the answer,
   *     and `values: []` is a VERIFIED "this record declares no fields".
   *   - `not-extracted` — the node carries no `values` property at all, so
   *     this vault's refresh predates the v1.6 R2 record-values extractors.
   *     `values: []` here is "not modeled", NEVER "no fields".
   *   - `unreadable` — the property is present but is not an array: a corrupt
   *     or partially written vault entry. A blind spot, never a verified zero.
   */
  readonly valuesState: RecordValuesState;
  /**
   * The extractor's OWN count of `<values>` entries (`valuesCount`), or `null`
   * when the node does not carry it. Surfaced so a caller can detect drift
   * between the count and the materialized array — the mechanism this module
   * used to only DESCRIBE in a comment.
   */
  readonly valuesCount: number | null;
  /**
   * Blind-spot sentences. EMPTY when `valuesState` is `read` — hedging a
   * verified zero would be as dishonest as hiding a blind spot.
   */
  readonly disclosures: readonly string[];
  /**
   * What the answer is actually scoped to, per CLAUDE.md's scope-honesty rule.
   * `source` says whether the caller named it or the record id determined it.
   * `objectApiName` is the CANONICAL casing read off the node, not the
   * caller's spelling.
   */
  readonly appliedScope: {
    readonly objectApiName: string;
    readonly source: 'recordId' | 'objectApiName';
  };
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
 * Narrow an ALREADY-PRESENT property value to an entry array, or `null` when
 * the vault wrote something that is not an array.
 *
 * Takes `unknown`, not a node: shape-narrowing is deliberately kept away from
 * the property READ so it can never be mistaken for — or grow back into — an
 * extracted/not-extracted decision. That question is answered once, by
 * `familyWasExtracted`.
 */
const asEntryArray = (raw: unknown): readonly unknown[] | null =>
  Array.isArray(raw) ? (raw as readonly unknown[]) : null;

/**
 * The three ways a record's `values` list can come back. See
 * {@link LookupRecordOutput.valuesState} for what each one licenses a reader
 * to conclude.
 */
export type RecordValuesState = 'read' | 'not-extracted' | 'unreadable';

/** What {@link readRecordValues} resolved, and why. */
interface RecordValuesRead {
  readonly state: RecordValuesState;
  readonly values: readonly RecordFieldValue[];
  readonly valuesCount: number | null;
}

/**
 * Read the record's per-field values array from `node.properties`, reporting
 * WHY it is unusable when it is.
 *
 * The decision is made by {@link familyWasExtracted} — whether the node
 * CARRIES the property at all — never by whether an array is empty. Both v1.6
 * R2 extractors write `values` unconditionally (`[]` for a record with no
 * `<values>` elements), so `Array.isArray(raw) ? ... : []` collapsed
 * NEVER-SCANNED into SCANNED-AND-CLEAN: a record from a pre-v1.6 vault and a
 * record that genuinely declares nothing both rendered as `values: []`, and a
 * business user asking what a feature-flag record contains was told it was
 * empty.
 */
const readRecordValues = (node: Node): RecordValuesRead => {
  const countRaw = node.properties[RECORD_VALUES_COUNT_PROPERTY];
  const valuesCount = typeof countRaw === 'number' ? countRaw : null;
  // PRESENCE decides extracted-vs-never-extracted. Shape only ever decides
  // readable-vs-corrupt, and only AFTER presence has been established — the
  // two questions are never asked by the same expression.
  if (!familyWasExtracted(node.properties, RECORD_VALUES_SENTINEL)) {
    return { state: 'not-extracted', values: [], valuesCount };
  }
  const entries = asEntryArray(node.properties[RECORD_VALUES_SENTINEL]);
  if (entries === null) {
    return { state: 'unreadable', values: [], valuesCount };
  }
  return { state: 'read', values: entries.map(normalizeValueEntry), valuesCount };
};

/**
 * The ONE place this tool's record-values blind spot is worded (R6). The
 * never-extracted half is the shared `notExtractedFamilyDisclosure` template
 * so it cannot drift from the same sentence elsewhere in the tree; the
 * corrupt half gets its own clause because "carries no extracted `values`
 * property" would be a FALSE statement about a record that carries a
 * malformed one.
 *
 * Returns `[]` for `read` — an empty `values` that was actually scanned is a
 * verified answer and must not be hedged.
 */
const recordValuesDisclosures = (
  recordId: ComponentId,
  read: RecordValuesRead,
): readonly string[] => {
  if (read.state === 'not-extracted') {
    return [
      notExtractedFamilyDisclosure({
        subject: 'Record field values',
        verb: 'read',
        pluralSubject: true,
        sentinelProperty: RECORD_VALUES_SENTINEL,
        containers: [recordId],
        surface: '`values`',
        zeroReading: '"this record declares no fields"',
      }),
    ];
  }
  if (read.state === 'unreadable') {
    return [
      `Record \`${recordId}\` carries a \`${RECORD_VALUES_SENTINEL}\` property that is NOT an ` +
        'array and could not be read — a corrupt or partially written vault entry. Its field ' +
        'values are a BLIND SPOT here, NEVER a verified "this record declares no fields". ' +
        'Re-run `/sfi-refresh`.',
    ];
  }
  return [];
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

  // Scope honesty. `objectApiName` used to be STRIPPED by the non-strict
  // schema, so a caller who scoped the question to the wrong object got a
  // confident answer about a different one.
  const canonicalTypeApiName = readTypeApiName(node);
  const suppliedObject = firstNonEmpty(input.objectApiName);
  const suppliedType = firstNonEmpty(input.typeApiName);
  if (
    suppliedObject !== undefined &&
    suppliedType !== undefined &&
    suppliedObject.toLowerCase() !== suppliedType.toLowerCase()
  ) {
    return err({
      kind: 'invalid-query',
      message: `object selectors name different targets (\`${suppliedObject}\` vs \`${suppliedType}\`); pass exactly one of objectApiName / typeApiName`,
      path: 'objectApiName',
    });
  }
  const supplied = suppliedObject ?? suppliedType;
  if (
    supplied !== undefined &&
    supplied.toLowerCase() !== canonicalTypeApiName.toLowerCase()
  ) {
    return err({
      kind: 'invalid-query',
      message: `\`objectApiName\` names \`${supplied}\`, but record \`${input.recordId}\` belongs to \`${canonicalTypeApiName}\`. Pass the matching object api name, or omit \`objectApiName\` — the record id already determines the scope.`,
      path: 'objectApiName',
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

  const valuesRead = readRecordValues(node);

  return ok({
    data: {
      recordId: node.id,
      type: node.type,
      typeApiName: canonicalTypeApiName,
      label,
      protected: isProtected,
      values: valuesRead.values,
      valuesState: valuesRead.state,
      valuesCount: valuesRead.valuesCount,
      disclosures: recordValuesDisclosures(node.id, valuesRead),
      appliedScope: {
        objectApiName: canonicalTypeApiName,
        source: supplied !== undefined ? 'objectApiName' : 'recordId',
      },
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
