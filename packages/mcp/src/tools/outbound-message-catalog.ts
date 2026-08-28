/**
 * Handler for the `sfi.outbound_message_catalog` MCP tool.
 *
 * The v2.8 async-deep-tier surface for "what SOAP-based outbound
 * messages does my org send, where do they go, and which workflow
 * rule invokes them?". Walks the `OutboundMessage` node family the
 * v2.8 workflow-rule extractor promotes from dangling-by-design
 * references into real nodes (mirroring the v1.5 R1 promotion of
 * NamedCredential / RemoteSiteSetting / ExternalDataSource into the
 * integration-topology tier).
 *
 * Implementation notes:
 *   - `objectFilter` narrows the scan to one parent CustomObject —
 *     useful when an architect wants to focus on "what outbound
 *     messages does Account send?". When omitted every
 *     OutboundMessage in the graph is included. The named object is
 *     RESOLVED AND VERIFIED against the vault first (shared
 *     `resolveExistingObjectScope`), so a typo or an object this
 *     refresh never retrieved is REFUSED rather than answered with a
 *     confident empty catalog, and a wrong-case name is corrected to
 *     the vault's exact casing. A scoped call echoes `appliedScope`
 *     and its disclosure is scoped too — a zero-result for ONE object
 *     is never phrased as an org-wide "this org defines none".
 *   - Each catalog entry surfaces the entry's identity (id, apiName,
 *     name) plus the four extracted endpoint properties
 *     (endpointUrl, includeSessionId, useDeadLetterQueue,
 *     integrationUser), the fields list (the SOAP body's payload
 *     shape), and the parent CustomObject id.
 *   - The `invokedByWorkflowRules` array is computed by walking
 *     incoming `references` edges from WorkflowRule nodes (the
 *     v1.3 reference shape preserved by the v2.8 promotion). Each
 *     entry carries the rule's id + apiName so the renderer can
 *     show "Account.Notify_Sales_On_New_Tier1 invokes
 *     SendOrderToWarehouse" without an extra graph round-trip.
 *   - Honesty axis (verbatim in `disclosure`): the endpoint URL is
 *     captured verbatim — v2.8 does NOT probe the URL, does NOT
 *     validate the destination exists, and does NOT confirm the
 *     message is actually invoked at runtime. The architect verifies
 *     destination reachability separately.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  danglingTargetIdsMatching,
  getNodeById,
  listEdges,
} from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/**
 * How many gap objects the prose enumerates before it summarises the rest.
 * Mirrors `absence-disclosure.ts`'s `MAX_ENUMERATED_CONTAINERS` so two
 * disclosures on one response cannot disagree about how long a list may be.
 */
const MAX_ENUMERATED_GAP_OBJECTS = 10;

/**
 * The node types the workflow-rule extractor actually MINTS out of a
 * `.workflow-meta.xml` file (verified against
 * `packages/extractors/src/workflow-rule.ts`: `buildWorkflowAlertNodes`,
 * `buildOutboundMessageNodes`, and the rule nodes themselves).
 *
 * This is the POSITIVE evidence set: an object with at least one node of these
 * types demonstrably had its workflow metadata retrieved AND parsed by this
 * vault, so a zero-outbound-message answer for it is a scanned zero.
 */
const MODELED_WORKFLOW_NODE_TYPES = [
  'WorkflowRule',
  'WorkflowAlert',
  'OutboundMessage',
] as const;

/**
 * Id prefixes of the workflow ACTION families that are serialized inside a
 * `.workflow-meta.xml` alongside `<outboundMessages>`.
 *
 * READ THIS BEFORE CHANGING THE PREDICATE BELOW. `WorkflowFieldUpdate:` and
 * `WorkflowTask:` are NOT `ComponentType`s — no extractor mints a node for
 * them, so EVERY reference to one dangles on EVERY vault, by design. An
 * unresolved reference is therefore NOT on its own evidence of a gap; treating
 * it as one would raise a blind-spot warning on a perfectly covered org. What
 * these ids are used for here is only their OBJECT prefix: they name the
 * objects whose workflow metadata this vault is known to NEED.
 */
const WORKFLOW_ACTION_ID_PREFIXES = [
  'WorkflowRule:',
  'WorkflowAlert:',
  'WorkflowFieldUpdate:',
  'WorkflowTask:',
  'OutboundMessage:',
] as const;

/**
 * Zod schema for the `sfi.outbound_message_catalog` tool input.
 *
 *   - `objectFilter`: optional, non-empty string. The CustomObject
 *     apiName to narrow the scan to (e.g., `'Account'`). When
 *     omitted every OutboundMessage in the graph is included.
 */
export const outboundMessageCatalogInputSchema = z.object({
  objectFilter: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `outboundMessageCatalogInputSchema`. */
export type OutboundMessageCatalogInput = z.infer<
  typeof outboundMessageCatalogInputSchema
>;

/**
 * One WorkflowRule that invokes the outbound message. Computed from
 * the incoming `references` edge produced by the v1.3 workflow-rule
 * extractor (preserved verbatim through the v2.8 promotion).
 */
export interface OutboundMessageInvoker {
  readonly workflowRuleId: ComponentId;
  readonly apiName: string;
}

/** One entry in the outbound-message catalog. */
export interface OutboundMessageCatalogEntry {
  readonly outboundMessageId: ComponentId;
  readonly apiName: string;
  readonly name: string;
  readonly parentObjectId: ComponentId | null;
  readonly endpointUrl: string | null;
  readonly includeSessionId: boolean;
  readonly useDeadLetterQueue: boolean;
  readonly integrationUser: string | null;
  readonly fields: readonly string[];
  readonly invokedByWorkflowRules: readonly OutboundMessageInvoker[];
}

/**
 * The measured blind spot behind an outbound-message answer — the TYPED field
 * a machine consumer cannot skip, always present (`null` when there is none).
 *
 * WHY THIS EXISTS. The zero-entry answer used to be certified on ONE manifest
 * row (`summarizeCoverage(manifest, ['WorkflowRule'])`) and then closed the
 * question outright ("do not suggest a refresh"). That row is a per-TYPE
 * retrieve tally; it does not certify that every object's `.workflow-meta.xml`
 * reached the vault, and classic SOAP `<outboundMessages>` live inside those
 * FILES. On a real vault the row read `complete` while retrieved approval
 * processes referenced workflow actions on an object for which the vault holds
 * no modeled workflow component at all.
 */
export interface OutboundMessageCoverageGap {
  /**
   * Object api names that are NAMED by an unresolved workflow-action reference
   * (`WorkflowRule:` / `WorkflowAlert:` / `WorkflowFieldUpdate:` /
   * `WorkflowTask:` / `OutboundMessage:`) while this vault holds NO node of a
   * type the workflow extractor mints for them. Sorted ASC.
   *
   * The honest reading is deliberately narrow, because two causes produce
   * identical offline evidence and the vault cannot separate them: the object's
   * workflow file never reached this vault, or it reached it and contained only
   * children this product does not model. Either way this scan has NO positive
   * evidence that the file was read, so any `<outboundMessages>` inside it is
   * unscanned — which is all that is claimed.
   */
  readonly objectsWithoutModeledWorkflowMetadata: readonly string[];
  /**
   * How many DISTINCT unresolved workflow-action ids stand behind that object
   * list. Counts only ids whose object is in the list above, so a
   * dangling-BY-DESIGN `WorkflowFieldUpdate:` on a fully-modeled object never
   * inflates it.
   */
  readonly unresolvedWorkflowReferenceCount: number;
  /** Up to ten of those ids, sorted, so a reader can follow one. */
  readonly sampleUnresolvedIds: readonly string[];
  /**
   * True when the OutboundMessage walk itself stopped at the shared full-scan
   * residual ceiling with more nodes behind it — a separate axis from the
   * object list, and false for any real org.
   */
  readonly scanIncomplete: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OutboundMessageCatalogOutput {
  /**
   * Present ONLY on an `objectFilter` call — echoes the canonical
   * `CustomObject:` id the catalog was narrowed to, in the VAULT's exact
   * casing (not the caller's), so a host can never read a one-object answer
   * as an org-wide catalog. Absent on the bare call, which keeps that
   * response byte-identical to the pre-scope shape.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  readonly entries: readonly OutboundMessageCatalogEntry[];
  readonly entriesByObject: Readonly<
    Record<string, readonly OutboundMessageCatalogEntry[]>
  >;
  readonly summary: {
    readonly totalEntries: number;
    readonly totalObjects: number;
    readonly entriesWithKnownInvokers: number;
  };
  /**
   * Coverage status of the WorkflowRule family that hosts classic
   * `<outboundMessages>` definitions. Classic SOAP outbound messages
   * live INSIDE `.workflow-meta.xml` (the same source the WorkflowRule
   * extractor retrieves), so when that family's coverage is `complete`
   * a zero-entry result is a DETERMINATE NEGATIVE ("this org defines no
   * outbound messages"), NOT a coverage gap. When coverage is `partial`
   * or `unknown` an empty result is inconclusive — the definitions may
   * simply not have been retrieved. The renderer/host MUST use this to
   * phrase a zero-result honestly instead of defaulting to "refresh the
   * vault".
   *
   * COVERAGE IS ORG-WIDE; the RESULT may be object-scoped. `complete` plus
   * zero entries is a determinate negative about THE ORG only on a bare
   * call — on an `objectFilter` call it is a determinate negative about
   * THAT OBJECT and says nothing about the rest of the org. `disclosure`
   * already carries that distinction; read it, not `coverageStatus` alone.
   *
   * This is the EFFECTIVE status, not the raw manifest row. The manifest's
   * WorkflowRule tally is a PER-TYPE retrieve count and cannot certify that
   * every object's `.workflow-meta.xml` reached the vault, so a manifest
   * `complete` is DOWNGRADED to `partial` whenever {@link
   * OutboundMessageCoverageGap} is non-null. A manifest row that already reads
   * `partial` / `unknown` passes through unchanged — the downgrade only ever
   * lowers the claim.
   */
  readonly coverageStatus: 'complete' | 'partial' | 'unknown';
  /**
   * The measured workflow-metadata blind spot, or `null` when the scan found
   * none. ALWAYS present, so a machine consumer reading `coverageStatus` alone
   * cannot skip past it. When it is non-null, `coverageStatus` has been
   * downgraded and `disclosure` says which objects were not scanned.
   */
  readonly coverageGap: OutboundMessageCoverageGap | null;
  readonly disclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response. The
 * endpoint URL is captured verbatim from the
 * `<outboundMessages><endpointUrl>` element; v2.8 does NOT probe
 * the URL, does NOT validate the destination exists, and does NOT
 * confirm the message is actually invoked at runtime.
 */
const OUTBOUND_MESSAGE_DISCLOSURE =
  'Endpoint URLs are captured verbatim from the `<outboundMessages><endpointUrl>` element and NOT VALIDATED — v2.8 does not probe the URL, does not confirm the destination exists, and does not confirm the message is invoked at runtime. Runtime registration via a custom Apex caller or a programmatically-modified workflow rule is invisible to the offline extractor.';

/**
 * The metadata families whose coverage backs an outbound-message
 * answer. Classic SOAP outbound messages are serialized INSIDE the
 * `.workflow-meta.xml` files under the `<outboundMessages>` element, so
 * the WorkflowRule family's coverage is the authoritative signal for
 * whether a zero-entry result is a determinate negative or a gap.
 */
const OUTBOUND_COVERAGE_TYPES = ['WorkflowRule'] as const;

/**
 * Build the disclosure for a ZERO-entry result. When the backing
 * WorkflowRule coverage is `complete`, the org genuinely defines no
 * outbound messages — say so plainly (a false premise, not a retrieval
 * miss) so the host does not default to "refresh the vault". When
 * coverage is `partial`/`unknown` the empty result is inconclusive.
 */
const buildEmptyDisclosure = (
  coverageStatus: 'complete' | 'partial' | 'unknown',
): string =>
  coverageStatus === 'complete'
    ? 'No outbound message definitions exist in this org. The WorkflowRule family — which is where classic SOAP `<outboundMessages>` are serialized — is confirmed-covered in this vault\'s manifest, AND every object named by an unresolved workflow-action reference does carry modeled workflow metadata here, so this reads as a determinate negative (the org defines none) rather than a coverage gap. BOUND ON THAT: it is a per-type manifest tally plus a reference cross-check — an object whose workflow metadata never reached this vault and is referenced by nothing else in it would leave no trace for either check, so confirm against the org before treating this as final for a migration cutover. ' +
      OUTBOUND_MESSAGE_DISCLOSURE
    : 'No outbound message entries were found, BUT the WorkflowRule family that hosts classic `<outboundMessages>` is only partially covered in this vault, so this result is INCONCLUSIVE — outbound message definitions may exist in the org but were not retrieved. Run `/sfi-refresh` (or check `sfi.coverage_report`) before concluding the org has none. ' +
      OUTBOUND_MESSAGE_DISCLOSURE;

/**
 * Render the gap object list for prose, truncated the same way
 * `absence-disclosure.ts` truncates its container list.
 */
const listGapObjects = (objects: readonly string[]): string => {
  const shown = objects.slice(0, MAX_ENUMERATED_GAP_OBJECTS);
  const rest = objects.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, … and ${rest} more` : shown.join(', ');
};

/**
 * The residual-ceiling sentence. A separate axis from the object list: the
 * OutboundMessage walk itself ran out of budget, so the ENTRIES are a prefix.
 */
const SCAN_INCOMPLETE_SENTENCE =
  'The OutboundMessage walk stopped at the shared full-scan residual ceiling with more nodes behind it, so `entries` is a PREFIX of this org\'s catalog and the counts are lower bounds. ';

/**
 * The gap sentence for an ORG-WIDE (bare) answer. `zeroEntries` decides
 * whether the harm being prevented is a false negative ("the org defines
 * none") or a false total ("this is the whole catalog").
 */
const buildGapSentence = (
  gap: OutboundMessageCoverageGap,
  zeroEntries: boolean,
): string => {
  const parts: string[] = [];
  if (gap.objectsWithoutModeledWorkflowMetadata.length > 0) {
    const objects = listGapObjects(gap.objectsWithoutModeledWorkflowMetadata);
    const n = gap.unresolvedWorkflowReferenceCount;
    const m = gap.objectsWithoutModeledWorkflowMetadata.length;
    parts.push(
      zeroEntries
        ? `No outbound message definitions were found in the workflow metadata this vault HOLDS — and that is NOT the same as the org defining none. ${n} unresolved workflow-action reference(s) name ${m} object(s) for which this vault holds no modeled workflow component at all (${objects}): their \`.workflow-meta.xml\` either never reached this vault or produced nothing this product models, so any \`<outboundMessages>\` inside it was NEVER SCANNED. Read this as "none in the workflow files this vault holds", check \`coverageGap\` and \`sfi.retrieve_blindspot_report\`, and re-run \`/sfi-refresh\` before closing an outbound-message re-pointing question. `
        : `This catalog is NOT exhaustive: ${n} unresolved workflow-action reference(s) name ${m} object(s) for which this vault holds no modeled workflow component at all (${objects}), so outbound messages defined in their workflow metadata are MISSING from the entries above. See \`coverageGap\` and \`sfi.retrieve_blindspot_report\`. `,
    );
  }
  if (gap.scanIncomplete) parts.push(SCAN_INCOMPLETE_SENTENCE);
  return parts.join('');
};

/**
 * The gap sentence for an OBJECT-SCOPED answer whose SCOPED object is itself
 * one of the unscanned ones. The org-wide wording would overstate the reach of
 * the warning; the scoped wording must name the object the reader asked about.
 */
const buildScopedGapSentence = (
  objectApiName: string,
  zeroEntries: boolean,
): string =>
  zeroEntries
    ? `This vault holds NO modeled workflow component for ${objectApiName} while other retrieved metadata references its workflow actions, so ${objectApiName}'s \`.workflow-meta.xml\` was never scanned here and a zero is NOT a checked zero for ${objectApiName}. Re-run \`/sfi-refresh\` (and see \`sfi.retrieve_blindspot_report\`) before concluding ${objectApiName} sends nothing. `
    : `This vault holds NO modeled workflow component for ${objectApiName} while other retrieved metadata references its workflow actions, so the entries above may be an INCOMPLETE view of what ${objectApiName} sends. See \`coverageGap\`. `;

/**
 * The note appended to a scoped answer whose OWN object is fully modeled while
 * OTHER objects are not: the scoped claim stands, and the reader is still told
 * the org-wide `coverageStatus` downgrade is not about them.
 */
const buildScopedElsewhereGapNote = (
  objectApiName: string,
  gap: OutboundMessageCoverageGap,
): string =>
  `Org-wide note: ${gap.objectsWithoutModeledWorkflowMetadata.length} OTHER object(s) have no modeled workflow metadata in this vault (\`coverageGap\`), which is why \`coverageStatus\` is not \`complete\`; that gap does not affect this ${objectApiName}-scoped answer. `;

/**
 * OUTBOUND-MESSAGE-CATALOG-SCOPED-NEGATIVE-READ-AS-ORG-WIDE: the leading
 * sentence on EVERY `objectFilter` answer. `entries` is the count AFTER the
 * narrowing, so without this the reader has no way to tell a one-object
 * catalog from the org's whole catalog — and on a zero-result the old
 * org-wide wording actively told them not to look further.
 */
const scopedPrefix = (objectApiName: string): string =>
  `SCOPED to ${objectApiName}: this catalog covers ONLY outbound messages whose parent object is ${objectApiName} — it is NOT an org-wide count, and says NOTHING about outbound messages on other objects. Re-run without \`objectFilter\` for the org-wide catalog. `;

/**
 * The zero-entry disclosure for an OBJECT-SCOPED call. The determinate
 * negative it can honestly assert is bounded by the scope: "this OBJECT
 * defines none", never "this ORG defines none". Coverage still decides
 * determinate-vs-inconclusive, because the WorkflowRule family is the
 * retrieval unit either way.
 */
const buildScopedEmptyDisclosure = (
  objectApiName: string,
  coverageStatus: 'complete' | 'partial' | 'unknown',
): string =>
  coverageStatus === 'complete'
    ? `No outbound message definitions are attached to ${objectApiName}. The WorkflowRule family — which is where classic SOAP \`<outboundMessages>\` are serialized — is confirmed-covered in this vault's manifest, AND nothing in this vault points at workflow metadata for ${objectApiName} that is missing here, so this is a determinate negative FOR ${objectApiName} (that object defines none) rather than a coverage gap. Other objects in this org may still define outbound messages. `
    : `No outbound message entries were found on ${objectApiName}, BUT the WorkflowRule family that hosts classic \`<outboundMessages>\` is only partially covered in this vault, so this result is INCONCLUSIVE — outbound message definitions may exist on ${objectApiName} but were not retrieved. Run \`/sfi-refresh\` (or check \`sfi.coverage_report\`) before concluding ${objectApiName} has none. `;

/**
 * Read a string property defensively. Returns the verbatim value
 * when it's a string, or null otherwise.
 */
const readOptionalString = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = properties[key];
  return typeof raw === 'string' ? raw : null;
};

/**
 * Read a boolean property defensively. Returns the verbatim value
 * when it's a boolean, or false otherwise. v2.8's producer (the
 * extended workflow-rule extractor) writes both flags explicitly
 * so the empty-property default is also `false`.
 */
const readBoolean = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): boolean => properties[key] === true;

/**
 * Read the `fields` property as a string array, defensively. v2.8's
 * producer writes the SOAP payload's per-field list; other shapes
 * pass through as the empty array.
 */
const readFields = (
  properties: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const raw = properties['fields'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Read the `name` property as a string, defensively. The v2.8
 * producer writes the verbatim `<fullName>` value; absent or
 * non-string values fall back to the entry's apiName tail.
 */
const readName = (
  properties: Readonly<Record<string, unknown>>,
  apiName: string,
): string => {
  const raw = properties['name'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const dot = apiName.lastIndexOf('.');
  return dot === -1 ? apiName : apiName.slice(dot + 1);
};

/**
 * Compute the parent CustomObject apiName from the OutboundMessage's
 * apiName, which is shaped as `{ObjectApiName}.{Name}`. Used both
 * for `objectFilter` matching and for the `entriesByObject` group-by
 * key. Returns the empty string when the apiName has no `.` (a
 * defensive case the v2.8 producer never emits).
 */
const apiNameToObjectKey = (apiName: string): string => {
  const dot = apiName.indexOf('.');
  return dot === -1 ? '' : apiName.slice(0, dot);
};

/**
 * Walk every incoming `references` edge to the OutboundMessage node
 * and narrow to those originating from WorkflowRule nodes (the v1.3
 * producer of these references). Each surviving caller is resolved
 * to its identity for the catalog entry.
 */
const collectInvokers = async (
  ctx: Context,
  outboundMessageId: ComponentId,
): Promise<Result<readonly OutboundMessageInvoker[], string>> => {
  const edgesResult = await listEdges(ctx.graph, outboundMessageId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const invokers: OutboundMessageInvoker[] = [];
  for (const edge of edgesResult.value) {
    if (!edge.fromId.startsWith('WorkflowRule:')) continue;
    const nodeResult = await getNodeById(ctx.graph, edge.fromId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    invokers.push({ workflowRuleId: node.id, apiName: node.apiName });
  }
  return ok(invokers);
};

/**
 * The object api name an id like `WorkflowAlert:Obj__c.Notify` is scoped to,
 * or `null` for a shape the extractors never emit. Every workflow-action
 * family is object-scoped as `{Prefix}:{ObjectApiName}.{Name}`.
 */
const workflowActionIdToObject = (id: string): string | null => {
  const prefix = WORKFLOW_ACTION_ID_PREFIXES.find((p) => id.startsWith(p));
  if (prefix === undefined) return null;
  const tail = id.slice(prefix.length);
  const dot = tail.indexOf('.');
  const object = dot === -1 ? tail : tail.slice(0, dot);
  return object.length === 0 ? null : object;
};

/**
 * Measure the workflow-metadata blind spot behind this answer.
 *
 * Two sets, and the DIFFERENCE is the finding:
 *   - NEEDED — every object named by an unresolved workflow-action id, read
 *     with the shared `danglingTargetIdsMatching` anti-join (the same raw
 *     signal behind `sfi.retrieve_blindspot_report`). The COMPLETE set, not a
 *     per-group sample, so a late-sorting object cannot fall out of it.
 *   - HELD — every object with at least one node of a type the workflow
 *     extractor actually mints, walked with the shared `scanAllNodesOfTypes`
 *     so the answer is not an alphabetical first page.
 *
 * NEEDED minus HELD is the set this scan has no positive evidence of having
 * read. The subtraction is what keeps the check honest: an unresolved
 * `WorkflowFieldUpdate:` alone would flag every vault ever built, because that
 * family is dangling BY DESIGN.
 */
const measureCoverageGap = async (
  ctx: Context,
  scanIncomplete: boolean,
): Promise<Result<OutboundMessageCoverageGap | null, string>> => {
  const unresolved: string[] = [];
  for (const prefix of WORKFLOW_ACTION_ID_PREFIXES) {
    const found = await danglingTargetIdsMatching(ctx.graph, prefix);
    if (!found.ok) return err(found.error.message);
    // `danglingTargetIdsMatching` is a LOOSE `ILIKE %needle%` pre-filter by
    // contract; the authoritative prefix rule is applied here.
    for (const id of found.value) if (id.startsWith(prefix)) unresolved.push(id);
  }

  const heldResult = await scanAllNodesOfTypes(ctx.graph, [
    ...MODELED_WORKFLOW_NODE_TYPES,
  ]);
  if (!heldResult.ok) return err(heldResult.error.message);
  const held = new Set<string>();
  for (const node of heldResult.value.nodes) {
    const key = apiNameToObjectKey(node.apiName);
    if (key.length > 0) held.add(key.toLowerCase());
  }

  const gapObjects = new Set<string>();
  const gapIds = new Set<string>();
  for (const id of unresolved) {
    const object = workflowActionIdToObject(id);
    if (object === null) continue;
    if (held.has(object.toLowerCase())) continue;
    gapObjects.add(object);
    gapIds.add(id);
  }

  if (gapObjects.size === 0 && !scanIncomplete) return ok(null);
  const objects = [...gapObjects].sort();
  const ids = [...gapIds].sort();
  return ok({
    objectsWithoutModeledWorkflowMetadata: objects,
    unresolvedWorkflowReferenceCount: ids.length,
    sampleUnresolvedIds: ids.slice(0, MAX_ENUMERATED_GAP_OBJECTS),
    scanIncomplete,
  });
};

/**
 * Deterministic entry comparator: outboundMessageId ASC.
 */
const compareEntries = (
  a: OutboundMessageCatalogEntry,
  b: OutboundMessageCatalogEntry,
): number =>
  a.outboundMessageId < b.outboundMessageId
    ? -1
    : a.outboundMessageId > b.outboundMessageId
      ? 1
      : 0;

/**
 * Deterministic invoker comparator: workflowRuleId ASC.
 */
const compareInvokers = (
  a: OutboundMessageInvoker,
  b: OutboundMessageInvoker,
): number =>
  a.workflowRuleId < b.workflowRuleId
    ? -1
    : a.workflowRuleId > b.workflowRuleId
      ? 1
      : 0;

/**
 * The `sfi.outbound_message_catalog` MCP tool. Returns one entry per
 * OutboundMessage node (the v2.8 promotion of the v1.3
 * dangling-by-design references), with endpoint URL, payload
 * shape, integration user, and the WorkflowRules that invoke it.
 *
 * @example
 *   const r = await outboundMessageCatalogHandler(ctx, { objectFilter: 'Account' });
 *   if (r.ok) console.log(r.value.data.summary.totalEntries);
 */
export const outboundMessageCatalogHandler = async (
  ctx: Context,
  input: OutboundMessageCatalogInput,
): Promise<Result<McpResponse<OutboundMessageCatalogOutput>, McpError>> => {
  // OUTBOUND-MESSAGE-CATALOG-UNVERIFIED-OBJECT-SCOPE: `objectFilter` used to
  // be a case-SENSITIVE `===` against the apiName prefix with no check that
  // the object exists, so `account`, `Acount__c` and an object this refresh
  // never retrieved ALL fell through to a zero-entry answer that was then
  // dressed up as an ORG-WIDE determinate negative. It now goes through the
  // one shared `resolveExistingObjectScope`, which verifies the object EXISTS
  // in the vault, rewrites it to the vault's exact casing, and REFUSES what it
  // cannot resolve instead of answering about the empty set.
  let scopedObject: string | null = null;
  let appliedScope: { readonly object: string; readonly mode: 'component' } | null =
    null;
  if (input.objectFilter !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: input.objectFilter,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    const scope = scopeResult.value;
    // `objectFilter` is `min(1)`, so the resolver cannot report "no object
    // named"; the null branch exists only so the type is honoured.
    if (scope !== null) {
      scopedObject = scope.object;
      appliedScope = { object: scope.componentId, mode: 'component' };
    }
  }

  // The scan used to be ONE `listNodesByType` page: the graph serves that as
  // `ORDER BY id ASC LIMIT ? OFFSET 0`, so entry 501+ was unreachable by any
  // re-slice while the summary counts still read as a whole-org total. The
  // shared walk windows the OFFSET forward and reports its own residual
  // ceiling, which is folded into `coverageGap.scanIncomplete`.
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, ['OutboundMessage']);
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error.message}`,
    });
  }

  const entries: OutboundMessageCatalogEntry[] = [];
  let entriesWithKnownInvokers = 0;
  for (const node of nodesResult.value.nodes as readonly Node[]) {
    const objectKey = apiNameToObjectKey(node.apiName);
    // Salesforce api names are case-INSENSITIVE: `Account` and `account` name
    // the same object, and the OutboundMessage apiName prefix is whatever the
    // source file spelled. Compare case-folded against the vault-resolved
    // name so the narrowing agrees with the resolution above.
    if (
      scopedObject !== null &&
      objectKey.toLowerCase() !== scopedObject.toLowerCase()
    ) {
      continue;
    }
    const invokersResult = await collectInvokers(ctx, node.id);
    if (!invokersResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${invokersResult.error}`,
      });
    }
    const invokers = [...invokersResult.value].sort(compareInvokers);
    if (invokers.length > 0) entriesWithKnownInvokers++;
    entries.push({
      outboundMessageId: node.id,
      apiName: node.apiName,
      name: readName(node.properties, node.apiName),
      parentObjectId: node.parentId,
      endpointUrl: readOptionalString(node.properties, 'endpointUrl'),
      includeSessionId: readBoolean(node.properties, 'includeSessionId'),
      useDeadLetterQueue: readBoolean(node.properties, 'useDeadLetterQueue'),
      integrationUser: readOptionalString(node.properties, 'integrationUser'),
      fields: readFields(node.properties),
      invokedByWorkflowRules: invokers,
    });
  }

  const sorted = entries.sort(compareEntries);
  const byObject: Record<string, OutboundMessageCatalogEntry[]> = {};
  for (const entry of sorted) {
    const key = apiNameToObjectKey(entry.apiName);
    const bucket = byObject[key] ?? [];
    bucket.push(entry);
    byObject[key] = bucket;
  }

  // OUTBOUND-MESSAGE-CATALOG-CERTIFIES-AN-UNCHECKED-WORKFLOW-CORPUS: the
  // manifest's WorkflowRule row is a PER-TYPE retrieve tally and was being read
  // as proof that every object's `.workflow-meta.xml` reached the vault. It is
  // not, and classic SOAP `<outboundMessages>` live inside those FILES — so the
  // certification is now backed by a MEASUREMENT as well, and a manifest
  // `complete` is downgraded when the measurement finds an unscanned object.
  const gapResult = await measureCoverageGap(ctx, nodesResult.value.scanIncomplete);
  if (!gapResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${gapResult.error}`,
    });
  }
  const coverageGap = gapResult.value;
  const manifestCoverage = summarizeCoverage(
    ctx.manifest,
    OUTBOUND_COVERAGE_TYPES,
  ).status;
  // The downgrade only ever LOWERS the claim; a row that already reads
  // `partial` / `unknown` passes through untouched.
  const coverageStatus: 'complete' | 'partial' | 'unknown' =
    coverageGap !== null && manifestCoverage === 'complete'
      ? 'partial'
      : manifestCoverage;

  // Is the gap ABOUT the object the caller scoped to? An org-wide gap does not
  // license hedging a scoped answer for an object that IS fully modeled — that
  // would be the opposite over-correction, a warning the reader cannot act on.
  const scopeIsUnscanned =
    scopedObject !== null &&
    coverageGap !== null &&
    coverageGap.objectsWithoutModeledWorkflowMetadata.some(
      (o) => o.toLowerCase() === scopedObject.toLowerCase(),
    );

  const empty = sorted.length === 0;
  const scopedBody = (): string => {
    if (scopedObject === null) return '';
    if (scopeIsUnscanned) return buildScopedGapSentence(scopedObject, empty);
    // `manifestCoverage`, NOT the downgraded `coverageStatus`: the downgrade
    // was caused by OTHER objects, and hedging this object's answer on it
    // would both misstate what is known about this object and hand the reader
    // a warning they cannot act on. The org-wide note below carries the
    // downgrade instead, where it is true.
    const base = empty
      ? buildScopedEmptyDisclosure(scopedObject, manifestCoverage)
      : '';
    return coverageGap === null
      ? base
      : base + buildScopedElsewhereGapNote(scopedObject, coverageGap);
  };

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(appliedScope !== null ? { appliedScope } : {}),
      entries: sorted,
      entriesByObject: byObject,
      summary: {
        totalEntries: sorted.length,
        totalObjects: Object.keys(byObject).length,
        entriesWithKnownInvokers,
      },
      coverageStatus,
      coverageGap,
      // Three axes, and ALL THREE have to be right:
      //  - the MEASURED gap decides whether a zero is a checked zero at all. It
      //    outranks the manifest: an unscanned object means the corpus behind
      //    the answer was never read, so no coverage row can certify it;
      //  - coverage then decides determinate-negative vs inconclusive, which
      //    stops a "refresh the vault" framing on an org that simply has none;
      //  - SCOPE decides what the negative is ABOUT. `sorted.length` is the
      //    count AFTER the `objectFilter` narrowing, so the org-wide wording
      //    is reachable ONLY on a bare call. A scoped answer — empty or not —
      //    always says so.
      disclosure:
        scopedObject !== null
          ? scopedPrefix(scopedObject) + scopedBody() + OUTBOUND_MESSAGE_DISCLOSURE
          : coverageGap !== null
            ? buildGapSentence(coverageGap, empty) + OUTBOUND_MESSAGE_DISCLOSURE
            : empty
              ? buildEmptyDisclosure(coverageStatus)
              : OUTBOUND_MESSAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
