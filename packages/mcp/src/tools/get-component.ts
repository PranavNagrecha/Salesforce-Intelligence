/**
 * Handler for the `sfi.get_component` MCP tool.
 *
 * Surfaces a single component's rendered Markdown by canonical id.
 * Two on-disk artifacts back the response: the graph node (read via
 * `getNodeById`) tells us which markdown file to open and gives us a
 * confidence signal that the id is real; the markdown file at
 * `componentPath(...)` gives us the renderer-produced bytes. A node without
 * a matching file is reported as `component-not-found` with the relative
 * path the caller would have read — this is the degraded-vault state where
 * the graph has been imported but the renderer has not run.
 *
 * Frontmatter is returned as the raw YAML string between the opening and
 * the first closing `---` delimiter; the v0.1 contract does not ship a YAML
 * parser through this surface, leaving structured parsing to clients that
 * want it. Splitting on the *first* `\n---\n` after the opening means
 * markdown horizontal rules inside the body remain part of the body.
 *
 * v0.2 STRUCTURED GROUNDING: `data.properties` exposes the component's typed
 * properties object (the same record stored in the graph node — for
 * ValidationRules this carries `active`, `errorConditionFormula`, `conditions`,
 * `errorMessage`, etc.) and `data.referenceIds` carries the canonical ids of
 * all components this node has outgoing edges to. Both fields are additive: the
 * existing `frontmatter` / `body` strings are byte-identical and always present.
 * This lets `synthesize_answer` (and any LLM caller) lift structured facts
 * without re-parsing YAML, and cite edge targets as real component ids rather
 * than guessing from markdown prose — eliminating false hallucination flags on
 * referenced ids.
 *
 * R6-31 METADATA-PROBE MODE: `maxBodyBytes` historically bounded only `body`.
 * `frontmatter` (the raw rendered YAML) and `properties`/`referenceIds` (the
 * graph node's own data) were always returned in full — fine for an average
 * component, but a Profile with thousands of `fieldPermissions` renders a
 * frontmatter blob and a properties object each well past the ~40 KB global
 * MCP response budget on their own. A caller passing `maxBodyBytes: 0` to
 * probe "does this component exist, what does it look like" (the grounding
 * pattern used by `synthesize_answer` and QA harnesses) got an oversize
 * refusal instead of an answer — the one field it explicitly asked to skip
 * was never the problem. When `maxBodyBytes` is 0 or small (below
 * `METADATA_PROBE_MAX_BODY_BYTES`), the handler now builds the response from
 * a bounded metadata PROJECTION instead: `frontmatter` capped the same way as
 * `body`, `properties` reduced to whichever entries fit a small fixed budget
 * (in practice the scalar fields survive and huge arrays/objects are the ones
 * dropped), and `referenceIds` capped to a fixed budget with the true total
 * disclosed via `referenceCount`. `data.metadataOnly` and `data.disclosure`
 * name exactly what was omitted so the response is honest, never a silent
 * subset. This guarantees `maxBodyBytes: 0` NEVER produces the global
 * `oversize` error. The default call (no `maxBodyBytes`) and any explicit
 * value at or above the threshold are untouched — full `frontmatter` /
 * `properties` / `referenceIds`, exactly as before.
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  UntrustedOrgText,
} from '@sf-intelligence/contracts';
import { err, ok, toRelativePosix, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, SOURCE_CONFLICT_PROPERTY } from '@sf-intelligence/graph';
import {
  renderComponentMarkdown,
  serializeFrontmatter,
} from '@sf-intelligence/renderers';
import { appendDemandHit, componentPath } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { tryReadComponentDoc } from './component-doc-fallback.js';
import {
  buildReservedConceptReasoning,
  CONCEPT_REASONING_SKIPPED_NOTE,
  CONCEPT_REASONING_UNAVAILABLE_NOTE,
  type ConceptReasoningEnvelope,
} from './concept-reasoning.js';
import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { buildReferenceStub } from './phantom-taxonomy.js';
import {
  brandOrgText,
  descriptionFromProperties,
} from './untrusted-org-text.js';

/**
 * Synthetic, file-less graph node types. `ConditionalContext` (a `firesWhen`
 * condition on a validation/approval/flow/rule) and `WorkflowAlert` (an
 * approval/workflow email alert) are emitted into the graph as byproducts of
 * the declarative extractors, but they have no source directory and no
 * file-based extractor, so `renderVault` — which walks only the file-backed
 * supported types — never writes them a markdown file. The graph node is
 * nonetheless real (`getNodeById` succeeds), so `get_component` serves them by
 * rendering the node on the fly rather than returning a misleading
 * `vault-file-missing`. Scoped to exactly these synthetic types so a genuinely
 * drifted/absent file for a normal, file-backed type still surfaces honestly.
 * (CONDITIONAL-CONTEXT-PHANTOM-COMPONENT / WORKFLOW-ALERT-PHANTOM-COMPONENT)
 */
const FILELESS_SYNTHETIC_TYPES: ReadonlySet<ComponentType> = new Set([
  'ConditionalContext',
  'WorkflowAlert',
]);

/**
 * Zod schema for the `sfi.get_component` tool input. `id` is a non-empty
 * string — the canonical `{Type}:{ApiName}` form is enforced downstream by
 * the graph lookup (an unknown id yields `component-not-found`, not a
 * Zod-level rejection).
 */
export const DEFAULT_COMPONENT_BODY_MAX_BYTES = 30_000;

/**
 * Below this `maxBodyBytes` threshold, `get_component` treats the call as a
 * metadata/existence probe rather than a request for the rendered document
 * and returns the bounded metadata PROJECTION (see R6-31 note above) instead
 * of the full `frontmatter` / `properties` / `referenceIds`. `0` — the
 * grounding-probe convention (`get_component({ id, maxBodyBytes: 0 })`) — is
 * always inside this range; the threshold also covers small explicit values
 * (e.g. a short body preview) so a huge node can't blow the response budget
 * on `properties`/`frontmatter` alone just because the caller asked for a
 * small body. Explicit values at or above this threshold keep the pre-R6-31
 * behavior (full frontmatter/properties/referenceIds) unchanged.
 */
export const METADATA_PROBE_MAX_BODY_BYTES = 2_000;

/**
 * Byte budget for the bounded scalar-properties subset in metadata-probe
 * mode. Deliberately independent of `maxBodyBytes` itself so `maxBodyBytes:
 * 0` still returns the component's small scalar properties (a real answer to
 * "what does this look like"), not an empty object.
 */
const METADATA_PROPERTIES_BUDGET_BYTES = 4_000;

/** Byte budget for the bounded `referenceIds` subset in metadata-probe mode. */
const METADATA_REFERENCE_IDS_BUDGET_BYTES = 2_000;

const getComponentInputBaseSchema = z.object({
  id: z.string().min(1),
  maxBodyBytes: z
    .number()
    .int()
    .min(0)
    .max(DEFAULT_COMPONENT_BODY_MAX_BYTES)
    .optional(),
  // Concept-rule reasoning; DEFAULTS TRUE (opt-OUT). IGNORED on the
  // metadata-probe path — see `conceptReasoning` on the output.
  includeConceptReasoning: z.boolean().optional(),
});

export const getComponentInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [{ canonical: 'id', aliases: ['componentId'] }]),
  getComponentInputBaseSchema,
);

/** Parsed input shape, inferred from `getComponentInputSchema`. */
export type GetComponentInput = z.infer<typeof getComponentInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `id`: the canonical component id the caller passed in, echoed back.
 *   - `type`: the component's type (from the graph node).
 *   - `path`: vault-relative path of the markdown file that was read.
 *   - `frontmatter`: raw YAML body between the leading and first trailing
 *     `---` delimiters. Parsing left to the client (byte-identical with v0.1).
 *   - `body`: response-safe markdown body slice following the frontmatter,
 *     with the leading blank line(s) after the closing delimiter trimmed.
 *   - `properties`: the component's typed properties object — the same record
 *     stored in the graph node and rendered into the frontmatter. For
 *     ValidationRules this carries `active`, `errorConditionFormula`,
 *     `conditions`, `errorMessage`, `errorDisplayField`, etc. Always present
 *     (may be `{}` for components whose extractor emits no typed properties).
 *     Additive: does NOT replace `frontmatter`; the existing string is
 *     preserved byte-for-byte.
 *   - `referenceIds`: canonical ids (`{Type}:{ApiName}`) of every component
 *     this node has a directed outgoing edge to, deduplicated and sorted.
 *     Covers all outgoing edge types (references, triggersOn, firesWhen, etc.)
 *     so callers receive the full outbound neighbourhood as structured values
 *     rather than needing to parse markdown prose. Empty array when this node
 *     has no outgoing edges.
 *   - truncation fields: explicit byte counts so callers know whether the
 *     body was clipped to keep the MCP response consumable.
 */
export interface GetComponentOutput {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly path: string;
  readonly frontmatter: string;
  readonly body: string;
  /**
   * Structured property bag from the graph node. For ValidationRules:
   * `{ active, errorConditionFormula, conditions, errorMessage, errorDisplayField }`.
   * Additive — `frontmatter` (the raw YAML string) is still present and
   * byte-identical with v0.1.
   */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * DUPLICATE-SOURCE disclosure. Present ONLY when this component exists at
   * more than one path under the vault's `source/` tree AND the copies carry
   * DIFFERENT content — i.e. two retrievals of the same metadata are sitting
   * in the vault and disagree about this component. Names every path, which
   * copy the answer came from, and whether the vault held enough information
   * to order them.
   *
   * Lifted to the top level rather than left inside `properties` on purpose:
   * the metadata-probe projection drops large property entries to fit its
   * budget, and this is the one property that must never be the one dropped.
   * A permission-granting answer about a component carrying this field is NOT
   * settled — the other copy was not merged in, and may be the newer one.
   */
  readonly sourceConflict?: Readonly<Record<string, unknown>>;
  /**
   * Canonical ids of every component this node has an outgoing edge to,
   * deduplicated and sorted. Lets callers cite real component ids without
   * parsing markdown prose.
   */
  readonly referenceIds: readonly ComponentId[];
  readonly bodyTruncated: boolean;
  readonly bodyBytes: number;
  readonly returnedBodyBytes: number;
  readonly omittedBodyBytes: number;
  readonly maxBodyBytes: number;
  /**
   * P13-ANNOT-tools: the component's curated annotations (provenance
   * `annotation` — human-stated/confirmed meaning, never derived from the
   * snapshot). Absent when the component has none, so annotation-free
   * vaults stay byte-identical.
   */
  readonly annotations?: AnnotationsBlock;
  /**
   * R6-31: `true` when this response is a bounded metadata PROJECTION
   * (`maxBodyBytes` 0 or below `METADATA_PROBE_MAX_BODY_BYTES`) rather than
   * the component's full frontmatter/properties/referenceIds. Absent
   * (never `false`) on a normal response — the default call and any
   * `maxBodyBytes` at/above the threshold are unaffected.
   */
  readonly metadataOnly?: true;
  /**
   * R6-31: property keys present on the underlying node but dropped from
   * the bounded `properties` projection because they did not fit the
   * metadata budget (e.g. a Profile's `fieldPermissions`/`objectPermissions`
   * arrays). Sorted. Present only when `metadataOnly` is true AND at least
   * one key was dropped.
   */
  readonly omittedPropertyKeys?: readonly string[];
  /**
   * R6-31: total outgoing edge count on the node, regardless of how many
   * ids the metadata projection could fit into `referenceIds`. Present only
   * when `metadataOnly` is true — on the default path `referenceIds` itself
   * is already the full list, so its `.length` IS the count.
   */
  readonly referenceCount?: number;
  /**
   * R6-31: count of outgoing edges NOT included in `referenceIds` because
   * the metadata projection bounded the list. Present only when
   * `metadataOnly` is true.
   */
  readonly omittedReferenceCount?: number;
  /** R6-31: `true` when `frontmatter` was capped by the metadata projection (present only when `metadataOnly` is true). */
  readonly frontmatterTruncated?: boolean;
  /** R6-31: original frontmatter byte length before capping (present only when `metadataOnly` is true). */
  readonly frontmatterBytes?: number;
  /** R6-31: returned frontmatter byte length after capping (present only when `metadataOnly` is true). */
  readonly returnedFrontmatterBytes?: number;
  /**
   * R6-31: human-readable summary of exactly what the metadata projection
   * omitted to guarantee this response fits the global byte budget, e.g.
   * "Metadata-only response (grounding probe): body omitted (maxBodyBytes=0);
   * frontmatter capped at maxBodyBytes=0; 2 of 4 properties not expanded
   * (fieldPermissions, objectPermissions); 30 of 150 outgoing edges shown
   * (see referenceCount)." Present only when `metadataOnly` is true.
   */
  readonly disclosure?: string;
  /**
   * AUDIT-F8 — graph label branded as untrusted org text. Legacy string
   * fields stay elsewhere; hosts that understand the brand should prefer this.
   */
  readonly labelOrgText?: UntrustedOrgText;
  /**
   * REASONING-REACHABILITY — deterministic concept-rule claims about THIS
   * component, on the shared `EvidenceEnvelopeV2` contract plus a
   * `completeness` report that keeps "checked and found nothing" distinct from
   * "never checked". Present ONLY when the caller passed
   * DEFAULT ON. Absent only when the caller passed
   * `includeConceptReasoning: false`, when the reasoning read failed, or on the
   * metadata-probe path (see below).
   *
   * This is the UNIVERSAL anchor: `get_component` accepts any component type,
   * so it is the only surface through which concept rules bound on the long
   * tail of anchors (Role, SharingRule, Network, DuplicateRule,
   * RestrictionRule …) can be reached at all.
   *
   * THE METADATA-PROBE CARVE-OUT IS A CORRECTNESS BOUNDARY, NOT A DEFAULT.
   * A `maxBodyBytes` at or below `METADATA_PROBE_MAX_BODY_BYTES` selects the
   * bounded grounding PROBE: a deliberately minimal projection whose contract is
   * "the smallest thing that still answers what this component is". A probe that
   * silently returned a multi-kilobyte reasoning block would no longer be a
   * probe — the caller's explicit size bound would be violated by the tool. So
   * the flag is IGNORED there, in BOTH directions, and the probe path returns
   * before reasoning is ever considered. Ask for reasoning with a normal call.
   *
   * Read `completeness.noRuleCoversComponentType` FIRST: when true, no concept
   * rule applies to this component type and an empty `claims` list means
   * NOTHING WAS CHECKED — never "clean".
   */
  readonly conceptReasoning?: ConceptReasoningEnvelope;
  /** AUDIT-F8 — description / inlineHelpText from node properties, branded. */
  readonly descriptionOrgText?: UntrustedOrgText;
}

/**
 * Lift the import layer's duplicate-source disclosure out of the node's
 * property bag onto the response's top level. Returns `{}` for the normal case
 * (one source path, or copies that agree), so an unaffected component's
 * response is byte-identical to before this field existed.
 */
const sourceConflictField = (
  node: Node,
): Pick<GetComponentOutput, 'sourceConflict'> => {
  const conflict = node.properties[SOURCE_CONFLICT_PROPERTY];
  return typeof conflict === 'object' && conflict !== null
    ? { sourceConflict: conflict as Readonly<Record<string, unknown>> }
    : {};
};

const orgTextFields = (
  node: Node,
): Pick<GetComponentOutput, 'labelOrgText' | 'descriptionOrgText'> => {
  const labelOrgText = brandOrgText(node.label);
  const descriptionOrgText = brandOrgText(
    descriptionFromProperties(node.properties),
  );
  return {
    ...(labelOrgText !== undefined ? { labelOrgText } : {}),
    ...(descriptionOrgText !== undefined ? { descriptionOrgText } : {}),
  };
};

/**
 * The `sfi.get_component` MCP tool. Returns a vault component's rendered
 * Markdown (split into frontmatter and a bounded body slice) by canonical id.
 * Input is already Zod-validated by `dispatchTool` before this handler runs.
 *
 * @example
 *   const r = await getComponentHandler(ctx, { id: 'CustomObject:Account' });
 *   if (r.ok) console.log(r.value.data.body);
 */
export const getComponentHandler = async (
  ctx: Context,
  input: GetComponentInput,
): Promise<Result<McpResponse<GetComponentOutput>, McpError>> => {
  const nodeResult = await getNodeById(ctx.graph, input.id);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    const doc = await tryReadComponentDoc(ctx.vaultRoot, input.id);
    if (doc !== null) {
      const split = { frontmatter: doc.frontmatter, body: doc.body.trimStart() };
      const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_COMPONENT_BODY_MAX_BYTES;
      const boundedBody = truncateUtf8(split.body, maxBodyBytes);
      // R6-31: this fallback already returns empty properties/referenceIds, so
      // the only field that can blow the response budget in metadata-probe
      // mode is `frontmatter` — bound it the same way `body` already is.
      const isMetadataProbe =
        input.maxBodyBytes !== undefined &&
        input.maxBodyBytes <= METADATA_PROBE_MAX_BODY_BYTES;
      const boundedFrontmatter = isMetadataProbe
        ? truncateUtf8(split.frontmatter, maxBodyBytes)
        : null;
      return ok({
        data: {
          id: input.id as ComponentId,
          type: doc.type,
          path: doc.path,
          frontmatter: boundedFrontmatter?.text ?? split.frontmatter,
          body: boundedBody.text,
          properties: {},
          referenceIds: [],
          bodyTruncated: boundedBody.truncated,
          bodyBytes: boundedBody.originalBytes,
          returnedBodyBytes: boundedBody.returnedBytes,
          omittedBodyBytes: boundedBody.originalBytes - boundedBody.returnedBytes,
          maxBodyBytes,
          // R3 — the DOC-FALLBACK path (a component whose markdown is on disk
          // but which has NO graph node) can never run concept reasoning: the
          // engine needs a node to anchor on. Say so rather than returning a
          // block-less payload that reads as "nothing found".
          disclosure:
            (isMetadataProbe && boundedFrontmatter !== null
              ? `${buildMetadataDisclosure({
                  maxBodyBytes,
                  omittedPropertyKeys: [],
                  totalPropertyKeys: 0,
                  omittedReferenceCount: 0,
                  totalReferenceCount: 0,
                })} `
              : '') +
            'This component was read from its vault document; it has no graph node, so concept-rule ' +
            'reasoning could not be anchored and NO concept layer was checked. That is "not ' +
            'checked", not "nothing found".',
          ...(isMetadataProbe && boundedFrontmatter !== null
            ? {
                metadataOnly: true as const,
                referenceCount: 0,
                frontmatterTruncated: boundedFrontmatter.truncated,
                frontmatterBytes: boundedFrontmatter.originalBytes,
                returnedFrontmatterBytes: boundedFrontmatter.returnedBytes,
              }
            : {}),
        },
        vaultState: {
          sourceTreeHash: ctx.manifest.sourceTreeHash,
          refreshedAt: ctx.manifest.refreshedAt,
        },
      });
    }
    // A bare "no node with id X" reads as "this doesn't exist". But an id that
    // is REFERENCED by retrieved components (e.g. a permission-set grant to a
    // managed-package or standard CustomObject that was never pulled) is a
    // PHANTOM — it exists in the org, just not in this vault. Disclose that
    // instead of a silent-looking not-found (B29).
    const id = input.id as ComponentId;
    const kindLabel = input.id.includes(':')
      ? input.id.slice(0, input.id.indexOf(':'))
      : 'component';
    // P7-reference-stub-nodes: when the id is a PHANTOM (referenced but never
    // retrieved), attach the classified stub + remedy so the caller gets a
    // structured insufficient-knowledge signal, not a bare not-found. Null when
    // the id has no inbound edges (a genuinely-unknown id).
    const stub = await buildReferenceStub(ctx, id);
    // P13-STAGED-demand-queue: an automation-critical phantom HIT is demand
    // signal — a real question needed this component. Queue it so
    // `sfi refresh --drain-demand-queue` (or the watch daemon) pulls exactly
    // what was asked for. Best-effort: a queue write never breaks the answer.
    if (stub !== null && stub.classification === 'automation-critical') {
      await appendDemandHit(ctx.vaultRoot, id, stub.classification, 'get_component');
    }
    // UNRESOLVED-PROFILE-GET-MISFRAMED-AS-RETRIEVE-GAP (fixture-vs-real gap): the
    // prior fix classified the `stub` correctly (`unresolved-profile-id`) but the
    // PRIMARY human-facing `message` still flowed through the generic
    // `phantomAwareNotFoundMessage`, which frames every phantom as "typically a
    // managed-package component or one outside the retrieve scope. Run `sfi
    // refresh`…" — the exact retrieve-widen misframing this finding is about, and
    // the field a host LLM reads first. Override the message for THIS
    // classification only (itself keyed on the `UnresolvedProfile:` namespace AND
    // the RestrictionRule/DuplicateRule Profile-Id-unresolved provenance, so it
    // cannot capture any other kind) and reuse `stub.remedy` verbatim so the
    // message and the structured stub can never contradict. Every other missing
    // id keeps the byte-identical generic message.
    const message =
      stub !== null && stub.classification === 'unresolved-profile-id'
        ? `\`${id}\` is a Profile Id referenced by ${stub.referenceCount} RestrictionRule/DuplicateRule ` +
          `component(s) that this vault could not resolve to a Profile api name — it is NOT a missing ` +
          `retrievable component. ${stub.remedy}`
        : await phantomAwareNotFoundMessage(ctx, id, kindLabel);
    return err({
      kind: 'component-not-found',
      message,
      path: input.id,
      ...(stub !== null ? { stub } : {}),
    });
  }
  const node = nodeResult.value;

  const parentApiName = parseParentApiName(node.parentId);
  const fullPath = componentPath(
    ctx.vaultRoot,
    node.type,
    parentApiName,
    node.apiName,
  );
  const relPath = toRelativePath(ctx.vaultRoot, fullPath);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch {
    // Synthetic, file-less node types (ConditionalContext / WorkflowAlert) have
    // a real graph node but never a rendered vault file, so the read always
    // ENOENTs. Serve them by rendering the node on the fly. For every other
    // (file-backed) type a missing file is genuine vault drift and still
    // surfaces as `vault-file-missing`, tagged with the path operators can
    // inspect.
    if (!FILELESS_SYNTHETIC_TYPES.has(node.type)) {
      return err({
        kind: 'component-not-found',
        message: 'vault file missing',
        path: relPath,
      });
    }
    try {
      const outEdgesForRender = await listEdges(ctx.graph, node.id, {
        direction: 'out',
      });
      const rendered = renderComponentMarkdown(
        node,
        outEdgesForRender.ok ? outEdgesForRender.value : [],
      );
      if (!rendered.ok) {
        throw new Error(rendered.error.message);
      }
      raw = `---\n${serializeFrontmatter(rendered.value.frontmatter)}\n---\n\n${rendered.value.body}\n`;
    } catch {
      // On-the-fly render failed unexpectedly: fall back to the honest
      // not-present signal rather than throwing out of the handler.
      return err({
        kind: 'component-not-found',
        message: 'vault file missing',
        path: relPath,
      });
    }
  }

  const split = splitFrontmatter(raw);
  if (split === null) {
    return err({
      kind: 'internal',
      message: `malformed frontmatter at ${relPath}`,
      path: relPath,
    });
  }
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_COMPONENT_BODY_MAX_BYTES;
  const boundedBody = truncateUtf8(split.body, maxBodyBytes);
  const annotations = await annotationsBlockFor(ctx, node.id);

  // Fetch outgoing edges for structured grounding: `referenceIds` gives callers
  // canonical component ids without needing to parse markdown prose, eliminating
  // false hallucination flags in synthesize_answer on referenced ids.
  const edgesResult = await listEdges(ctx.graph, node.id, { direction: 'out' });
  const allReferenceIds: ComponentId[] = edgesResult.ok
    ? [...new Set(edgesResult.value.map((e) => e.toId))].sort()
    : [];

  // R6-31: `maxBodyBytes` 0 or small means the caller is probing existence /
  // key metadata, not asking for the rendered document. Below this
  // threshold, build the response from a bounded metadata PROJECTION so a
  // huge node (a Profile with thousands of `fieldPermissions`) can never
  // trip the global response-size guard on a probe call — see the R6-31
  // header note for the full rationale.
  const isMetadataProbe =
    input.maxBodyBytes !== undefined &&
    input.maxBodyBytes <= METADATA_PROBE_MAX_BODY_BYTES;

  if (isMetadataProbe) {
    const boundedFrontmatter = truncateUtf8(split.frontmatter, maxBodyBytes);
    const propertyKeys = Object.keys(node.properties);
    const propProjection = projectPropertiesForMetadata(
      node.properties,
      METADATA_PROPERTIES_BUDGET_BYTES,
    );
    const refProjection = projectReferenceIdsForMetadata(
      allReferenceIds,
      METADATA_REFERENCE_IDS_BUDGET_BYTES,
    );
    return ok({
      data: {
        id: node.id,
        type: node.type,
        path: relPath,
        frontmatter: boundedFrontmatter.text,
        body: boundedBody.text,
        properties: propProjection.properties,
        referenceIds: refProjection.referenceIds,
        bodyTruncated: boundedBody.truncated,
        bodyBytes: boundedBody.originalBytes,
        returnedBodyBytes: boundedBody.returnedBytes,
        omittedBodyBytes: boundedBody.originalBytes - boundedBody.returnedBytes,
        maxBodyBytes,
        metadataOnly: true,
        ...sourceConflictField(node),
        ...(propProjection.omittedKeys.length > 0
          ? { omittedPropertyKeys: propProjection.omittedKeys }
          : {}),
        referenceCount: allReferenceIds.length,
        omittedReferenceCount: refProjection.omittedCount,
        frontmatterTruncated: boundedFrontmatter.truncated,
        frontmatterBytes: boundedFrontmatter.originalBytes,
        returnedFrontmatterBytes: boundedFrontmatter.returnedBytes,
        disclosure:
          buildMetadataDisclosure({
            maxBodyBytes,
            omittedPropertyKeys: propProjection.omittedKeys,
            totalPropertyKeys: propertyKeys.length,
            omittedReferenceCount: refProjection.omittedCount,
            totalReferenceCount: allReferenceIds.length,
          }) +
          // A carve-out has to be STATED. A metadata probe never attaches the
          // concept-reasoning block — its contract is a minimal payload, and
          // honouring the flag here would violate the caller's own size bound —
          // but dropping it silently would read as "nothing was found".
          ' Concept-rule reasoning is NOT run on a metadata probe (the `includeConceptReasoning` ' +
          'flag is ignored here, in both directions) because a probe must stay minimal — so no ' +
          'concept layer was checked. Re-query without `maxBodyBytes` to get it.',
        ...(annotations !== undefined ? { annotations } : {}),
        ...orgTextFields(node),
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // REASONING-REACHABILITY — opt-in concept-rule reasoning over ANY component
  // type. Never reached on the metadata-probe path above (that returns first),
  // so the grounding probe keeps its minimal payload.
  const conceptReasoning: ConceptReasoningEnvelope | null =
    input.includeConceptReasoning === false
      ? null
      : ((await buildReservedConceptReasoning(ctx, node.id, { rootNode: node }))?.envelope ??
        null);
  // R3 — an absent block is never silent on any path.
  const conceptNote =
    conceptReasoning !== null
      ? null
      : input.includeConceptReasoning === false
        ? CONCEPT_REASONING_SKIPPED_NOTE
        : CONCEPT_REASONING_UNAVAILABLE_NOTE(node.id);

  return ok({
    data: {
      id: node.id,
      type: node.type,
      path: relPath,
      frontmatter: split.frontmatter,
      body: boundedBody.text,
      // Structured properties from the graph node (already parsed JSON, never
      // re-derived from the YAML string). For ValidationRules carries `active`,
      // `errorConditionFormula`, `conditions`, `errorMessage`, etc.
      properties: node.properties,
      // Canonical ids of every outgoing neighbour, deduplicated + sorted.
      referenceIds: allReferenceIds,
      bodyTruncated: boundedBody.truncated,
      bodyBytes: boundedBody.originalBytes,
      returnedBodyBytes: boundedBody.returnedBytes,
      omittedBodyBytes: boundedBody.originalBytes - boundedBody.returnedBytes,
      maxBodyBytes,
      ...sourceConflictField(node),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(conceptReasoning !== null ? { conceptReasoning } : {}),
      ...(conceptNote !== null ? { disclosure: conceptNote } : {}),
      ...orgTextFields(node),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Recover the parent's apiName from a canonical parent id like
 * `CustomObject:Account`. Returns `null` when the node has no parent, which
 * is the shape `componentPath` expects for top-level components.
 */
const parseParentApiName = (parentId: ComponentId | null): string | null => {
  if (parentId === null) return null;
  const colonIdx = parentId.indexOf(':');
  // No colon means the id is malformed upstream; treat it as "no parent
  // segment" rather than crashing — the file lookup will then miss and
  // surface as `component-not-found`, which is the right diagnostic for
  // a vault out of sync with the graph.
  return colonIdx >= 0 ? parentId.substring(colonIdx + 1) : null;
};

/**
 * Trim the vault-root prefix from an absolute component path. The MCP
 * contract reports paths relative to the vault so clients can recombine
 * them with whatever root they have on their own filesystem.
 */
const toRelativePath = (vaultRoot: string, fullPath: string): string =>
  // `fullPath` is `join()`-built, so on Windows it is backslash-separated while
  // the hand-rolled prefix ended in `/` — the strip never fired and the wire
  // field carried an ABSOLUTE native path where the contract above promises a
  // vault-relative one. `toRelativePosix` also renders the separator, so this
  // field and `component-doc-fallback`'s no longer disagree on Windows.
  toRelativePosix(vaultRoot, fullPath);

/**
 * Pull the YAML frontmatter and Markdown body out of a renderer-produced
 * file. Returns `null` when the leading `---\n` or its first matching
 * `\n---\n` is absent; the caller maps that to an `internal` error since
 * the renderer is supposed to write this shape unconditionally.
 *
 * Splitting on the *first* `\n---\n` after position 4 means a markdown
 * horizontal rule inside the body never confuses the parser.
 */
const splitFrontmatter = (
  raw: string,
): { frontmatter: string; body: string } | null => {
  if (!raw.startsWith('---\n')) return null;
  const endIdx = raw.indexOf('\n---\n', 4);
  if (endIdx < 0) return null;
  const frontmatter = raw.substring(4, endIdx);
  const body = raw.substring(endIdx + 5).replace(/^\n+/, '');
  return { frontmatter, body };
};

const truncateUtf8 = (
  text: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly returnedBytes: number;
} => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }
  const sliced = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return {
    text: sliced,
    truncated: true,
    originalBytes,
    returnedBytes: Buffer.byteLength(sliced, 'utf8'),
  };
};

/** JSON byte length of a value, tolerating values `JSON.stringify` can't encode (falls back to `'null'`, matching `JSON.stringify`'s own behavior when such a value sits inside an object). */
const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/**
 * R6-31: build a byte-budgeted PROJECTION of a node's `properties` for the
 * metadata-probe response shape. Entries are considered smallest-first, so
 * in practice the scalar fields (`active`, `description`, `userLicense`, …)
 * survive and whichever large arrays/objects don't fit the budget (a
 * Profile's `fieldPermissions`, `objectPermissions`, …) are the ones
 * dropped — never silently truncated in place, always named in
 * `omittedKeys` so the caller knows exactly what wasn't expanded. Surviving
 * entries keep the node's own key order.
 */
const projectPropertiesForMetadata = (
  properties: Readonly<Record<string, unknown>>,
  maxBytes: number,
): {
  readonly properties: Record<string, unknown>;
  readonly omittedKeys: readonly string[];
} => {
  const entries = Object.entries(properties);
  const bySize = entries
    .map(([key, value]) => ({
      key,
      bytes: jsonBytes(key) + jsonBytes(value) + 1, // +1 for the `:` separator
    }))
    .sort((a, b) => a.bytes - b.bytes);

  const kept = new Set<string>();
  let used = 2; // '{' + '}'
  for (const { key, bytes } of bySize) {
    const separator = kept.size > 0 ? 1 : 0; // ','
    if (used + separator + bytes <= maxBytes) {
      kept.add(key);
      used += separator + bytes;
    }
  }

  const boundedProperties: Record<string, unknown> = {};
  const omittedKeys: string[] = [];
  for (const [key, value] of entries) {
    if (kept.has(key)) {
      boundedProperties[key] = value;
    } else {
      omittedKeys.push(key);
    }
  }
  return { properties: boundedProperties, omittedKeys: omittedKeys.sort() };
};

/**
 * R6-31: build a byte-budgeted PREFIX of `referenceIds` for the
 * metadata-probe response shape. `referenceIds` is already sorted for
 * determinism, so keeping a byte-budgeted prefix (rather than resorting by
 * size) keeps the truncation itself deterministic and cheap.
 */
const projectReferenceIdsForMetadata = (
  referenceIds: readonly ComponentId[],
  maxBytes: number,
): {
  readonly referenceIds: readonly ComponentId[];
  readonly omittedCount: number;
} => {
  const kept: ComponentId[] = [];
  let used = 2; // '[' + ']'
  for (const id of referenceIds) {
    const separator = kept.length > 0 ? 1 : 0; // ','
    const bytes = jsonBytes(id);
    if (used + separator + bytes > maxBytes) break;
    kept.push(id);
    used += separator + bytes;
  }
  return { referenceIds: kept, omittedCount: referenceIds.length - kept.length };
};

/**
 * R6-31: compose the honest, human-readable summary attached as
 * `data.disclosure` on every metadata-probe response — names exactly what
 * was omitted (body, frontmatter, which property keys, how many edges)
 * rather than leaving the caller to infer it from field absence.
 */
const buildMetadataDisclosure = (opts: {
  readonly maxBodyBytes: number;
  readonly omittedPropertyKeys: readonly string[];
  readonly totalPropertyKeys: number;
  readonly omittedReferenceCount: number;
  readonly totalReferenceCount: number;
}): string => {
  const bodyPart =
    opts.maxBodyBytes === 0
      ? 'body omitted (maxBodyBytes=0)'
      : `body capped at maxBodyBytes=${opts.maxBodyBytes}`;
  const propsPart =
    opts.omittedPropertyKeys.length > 0
      ? `${opts.omittedPropertyKeys.length} of ${opts.totalPropertyKeys} properties not expanded (${opts.omittedPropertyKeys
          .slice(0, 8)
          .join(', ')}${opts.omittedPropertyKeys.length > 8 ? ', …' : ''})`
      : `all ${opts.totalPropertyKeys} properties included`;
  const edgesPart =
    opts.omittedReferenceCount > 0
      ? `${
          opts.totalReferenceCount - opts.omittedReferenceCount
        } of ${opts.totalReferenceCount} outgoing edges shown (see referenceCount)`
      : `all ${opts.totalReferenceCount} outgoing edges shown`;
  return (
    `Metadata-only response (grounding probe): ${bodyPart}; frontmatter capped ` +
    `at maxBodyBytes=${opts.maxBodyBytes}; ${propsPart}; ${edgesPart}.`
  );
};
