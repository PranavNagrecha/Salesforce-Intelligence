/**
 * Handler for the `sfi.omniscript_flow` MCP tool.
 *
 * The v3.2 R3 "walk this OmniScript end-to-end" surface. Given an
 * `OmniScript:` canonical id, returns:
 *
 *   - `metadata`: identity + top-level discriminators copied from the
 *     v3.2 R2 extractor's node properties (omniProcessType, versionNumber,
 *     language, subType, type, uniqueName, isActive, isWebCompEnabled).
 *   - `steps`: the ordered `<omniProcessElements>` children (recursive),
 *     parsed at tool-invocation time from `node.sourcePath`. Each step
 *     carries `name`, `type`, `level`, `sequenceNumber`, `isActive` — the
 *     verbatim element discriminants per OmniScript.md §"Body". Steps
 *     are sorted by `level` ASC, then `sequenceNumber` ASC, mirroring the
 *     runtime flow's traversal order.
 *   - `dispatchedActions`: the `dispatchesOmniAction` outgoing edges of
 *     this OmniScript, sourced from the graph. Each entry carries the
 *     calling step's `name` / `type`, the resolved `targetId` (or null
 *     when the target is missing from the vault — dangling reference),
 *     the verbatim `targetRawName` from the XML, and the edge confidence.
 *   - `boundaries[]`: three verbatim disclosures surfaced ALWAYS per
 *     PLAN-v3.2 §4 honesty axes — Native-vs-Vlocity-Legacy detection
 *     heuristic, the OmniProcessElement record-level boundary (Q179
 *     anchor), and the v3.3 Apex-coupling deferral (Q180 anchor).
 *
 * **Composition recipe**: loads the OmniScript node via
 * `getNodeById`, reads `node.sourcePath`, re-parses the XML with
 * fast-xml-parser to recover the per-element shape (the v3.2 R2
 * extractor surfaces summary counts, not the individual elements), then
 * walks `listEdges` filtered to `dispatchesOmniAction` outgoing edges,
 * resolving each `toId` to `componentExistsInVault`. The Native-vs-
 * Vlocity disclosure surfaces verbatim regardless of vault state
 * because v3.2 cannot reliably detect mid-migration orgs (Q180
 * constitutional anchor).
 *
 * **Refusal contract**: `OmniScript:`-prefix violations surface as
 * `invalid-query`; the well-formed id missing from the vault surfaces
 * as `component-not-found` with the canonical `{kind, message, path}`
 * shape. Vault-Vlocity-Legacy hits look exactly like component-not-found
 * because the v3.2 extractor does NOT touch the legacy `vlocity_cmt__`
 * namespace; the boundaries[] disclosure makes that gap visible.
 *
 * @see docs/vendor/salesforce-metadata/OmniScript.md
 * @see PLAN-v3.2.md §4, §7 (Q176 reference question)
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix the tool accepts. */
const OMNISCRIPT_PREFIX = 'OmniScript:';
/** Edge type the tool walks. */
const DISPATCH_EDGE_TYPE = 'dispatchesOmniAction';

/**
 * The Native-vs-Vlocity-Legacy honesty axis 1 disclosure, surfaced
 * verbatim on EVERY response per PLAN-v3.2 §4 honesty axis 1 / Q180
 * constitutional anchor.
 */
const NATIVE_VS_VLOCITY_DISCLOSURE =
  'v3.2 recognizes Industries Native XML shapes (file extensions `.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, `.ouc-meta.xml`, `.decisionTable-meta.xml`). Legacy Vlocity-managed-package components (namespace `vlocity_cmt__`) are NOT extracted by v3.2. Mid-migration orgs may show partial coverage.';

/**
 * The OmniProcessElement record-level boundary disclosure, surfaced
 * verbatim on EVERY `sfi.omniscript_flow` response per PLAN-v3.2 §4
 * honesty axis 2 / Q179 anchor — runtime user-entered state lives in
 * SObject records, NOT in the metadata XML this tool reads.
 */
const RECORD_LEVEL_DISCLOSURE =
  "v3.2 walks the OmniScript / IP / Card metadata XML. The actual user-entered data and runtime state lives in OmniProcessElement and related SObject records; that is record-level data, out of scope for v0.1's read-the-metadata posture.";

/**
 * The v3.3 Apex-coupling deferral disclosure, surfaced verbatim on
 * EVERY `sfi.omniscript_flow` response per PLAN-v3.2 §4 honesty axis 3
 * / Q180 anchor — the 16 vaulted Apex classes that implement
 * `omnistudio.VlocityOpenInterface` produce zero v3.2 edges.
 */
const APEX_COUPLING_DEFERRAL_DISCLOSURE =
  'v3.2 captures OmniStudio components and intra-OmniStudio call chains (`dispatchesOmniAction`). The Apex-to-OmniProcess coupling (`implements omnistudio.VlocityOpenInterface` etc.) is a v3.3 follow-up — those edges are NOT yet in the graph.';

/**
 * Zod schema for the `sfi.omniscript_flow` tool input.
 *
 *   - `omniScriptId`: required, non-empty string. Must start with
 *     `OmniScript:`; non-matching prefixes surface as `invalid-query` at
 *     the handler boundary.
 *   - `includeChildPropertySetConfig`: optional. When true, each step's
 *     parsed `propertySetConfig` JSON blob is attached to its entry. The
 *     blobs can be large (kilobytes per step); off by default.
 */
export const omniscriptFlowInputSchema = z.object({
  omniScriptId: z.string().min(1),
  includeChildPropertySetConfig: z.boolean().optional(),
});

/** Parsed input shape. */
export type OmniscriptFlowInput = z.infer<typeof omniscriptFlowInputSchema>;

/**
 * One element from the OmniScript's `<omniProcessElements>` body,
 * flattened (the XML's nested `<childElements>` are walked recursively
 * and emitted in source order; consumers re-sort by `(level,
 * sequenceNumber)` for runtime traversal).
 */
export interface OmniScriptStep {
  readonly name: string;
  readonly type: string;
  readonly level: number;
  readonly sequenceNumber: number;
  readonly isActive: boolean;
  /**
   * Only populated when the caller passed
   * `includeChildPropertySetConfig: true`. The verbatim parsed JSON
   * blob from the XML (HTML-entity-escaped in source). `null` when the
   * source XML carried no `<propertySetConfig>` element OR the parse
   * failed (the v3.2 extractor's best-effort JSON parse boundary).
   */
  readonly propertySetConfigParsed?: Readonly<Record<string, unknown>> | null;
}

/**
 * One `dispatchesOmniAction` edge from this OmniScript, expanded with
 * the calling step's identity and the resolved target's vault
 * presence. `targetId` is `null` when the target name is in the XML
 * but no matching node exists in the vault (dangling reference) —
 * common when referencing a managed-package or cross-namespace target.
 */
export interface DispatchedAction {
  readonly stepName: string;
  readonly stepType: string;
  readonly targetId: ComponentId | null;
  readonly targetRawName: string;
  readonly confidence: ConfidenceLevel;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OmniscriptFlowOutput {
  readonly omniScriptId: ComponentId;
  readonly apiName: string;
  readonly metadata: {
    readonly omniProcessType: string | null;
    readonly versionNumber: number | null;
    readonly language: string | null;
    readonly isActive: boolean;
    readonly isWebCompEnabled: boolean;
    readonly uniqueName: string | null;
    readonly subType: string | null;
    readonly type: string | null;
  };
  readonly steps: readonly OmniScriptStep[];
  readonly dispatchedActions: readonly DispatchedAction[];
  readonly boundaries: readonly string[];
}

/** Validate the id prefix. */
const isOmniScriptId = (id: string): boolean => id.startsWith(OMNISCRIPT_PREFIX);

/**
 * Unwrap fast-xml-parser's array-or-scalar shape for elements that are
 * conceptually single-valued. The parser emits an array when an element
 * appears more than once, otherwise the value or object verbatim.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize a possibly-undefined XML child into an array. */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar element to a string, or `null` when absent. */
const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return null;
  const s = String(v);
  return s.length > 0 ? s : null;
};

/** Coerce an XML scalar to boolean; non-`true` values become false. */
const coerceBoolean = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
};

/** Coerce an XML scalar to a finite number; returns `null` when unparseable. */
const toNullableNumber = (value: unknown): number | null => {
  const v = unwrapSingle(value);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Best-effort parse of an HTML-entity-escaped JSON string. Mirrors the
 * v3.2 R2 extractor's parser — fast-xml-parser's default
 * `processEntities` decodes `&quot;` etc. into `"`, so the input is
 * plain JSON. Failures produce `null` rather than aborting.
 */
const parsePropertySetConfig = (
  raw: unknown,
): Readonly<Record<string, unknown>> | null => {
  const v = unwrapSingle(raw);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    if (typeof v === 'object') return v as Readonly<Record<string, unknown>>;
    return null;
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Readonly<Record<string, unknown>>;
    }
    return null;
  } catch {
    return null;
  }
};

/** Inputs the per-step walk emits at every recursion frame. */
interface WalkAccumulator {
  readonly steps: OmniScriptStep[];
  readonly includePsc: boolean;
}

/**
 * Recursively flatten `<omniProcessElements>` (which may carry nested
 * `<childElements>`) into a single step list. Source order is preserved
 * during the walk; the caller re-sorts the final list by
 * `(level, sequenceNumber)` for runtime traversal.
 */
const walkElements = (raw: unknown, acc: WalkAccumulator): void => {
  for (const entry of toArray(raw)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const name = toNullableString(obj['name']);
    const type = toNullableString(obj['type']);
    const level = toNullableNumber(obj['level']);
    const sequenceNumber = toNullableNumber(obj['sequenceNumber']);
    const isActive = coerceBoolean(obj['isActive']);
    // Skip elements with no name+type — those are XML noise (defensive;
    // the v3.2 extractor's malformed-input check should already catch
    // genuine corruption upstream).
    if (name === null || type === null) continue;
    const baseStep = {
      name,
      type,
      level: level ?? 0,
      sequenceNumber: sequenceNumber ?? 0,
      isActive,
    };
    const step: OmniScriptStep = acc.includePsc
      ? {
          ...baseStep,
          propertySetConfigParsed: parsePropertySetConfig(
            obj['propertySetConfig'],
          ),
        }
      : baseStep;
    acc.steps.push(step);
    // Recurse into nested `<childElements>` (Step / Block / Edit Block
    // containers hold their child widgets there).
    walkElements(obj['childElements'], acc);
  }
};

/**
 * Read and parse the OmniScript's source XML, returning the flattened
 * step list. Wraps fast-xml-parser with the same options the v3.2 R2
 * `omniscript` extractor uses so the two surfaces produce structurally
 * identical step views — only the storage location differs (extractor
 * persists counts to node properties; this tool re-parses for full
 * step shape).
 */
const readSteps = async (
  sourcePath: string,
  includePsc: boolean,
): Promise<Result<OmniScriptStep[], string>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(sourcePath, 'utf-8');
  } catch (cause: unknown) {
    return err(
      `failed to read OmniScript source at ${sourcePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 100000 },
  });
  let parsedDoc: Record<string, unknown>;
  try {
    parsedDoc = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err(
      `failed to parse OmniScript XML at ${sourcePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  const root = unwrapSingle(parsedDoc['OmniScript']);
  if (typeof root !== 'object' || root === null) {
    return err(`expected <OmniScript> root at ${sourcePath}`);
  }
  const rootObj = root as Record<string, unknown>;
  const acc: WalkAccumulator = { steps: [], includePsc };
  walkElements(rootObj['omniProcessElements'], acc);
  // Stable order: level ASC, sequenceNumber ASC, then name as tiebreaker.
  // Mirrors the runtime flow's traversal order per OmniScript.md.
  acc.steps.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    if (a.sequenceNumber !== b.sequenceNumber)
      return a.sequenceNumber - b.sequenceNumber;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return ok(acc.steps);
};

/**
 * Pull a per-property accessor that handles null / type-erased shapes
 * deterministically. The graph's `properties_json` round-trip stores
 * everything as `unknown`; this widens the failure surface back to
 * `null` so the metadata payload is uniformly typed.
 */
const readStringProp = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const v = props[key];
  return typeof v === 'string' ? v : null;
};

const readNumberProp = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): number | null => {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

const readBoolProp = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): boolean => {
  const v = props[key];
  return typeof v === 'boolean' ? v : false;
};

/**
 * Comparator for `DispatchedAction`: stable ordering by stepName then
 * stepType then targetRawName. Tests rely on deterministic output.
 */
const compareDispatched = (
  a: DispatchedAction,
  b: DispatchedAction,
): number => {
  if (a.stepName !== b.stepName) return a.stepName < b.stepName ? -1 : 1;
  if (a.stepType !== b.stepType) return a.stepType < b.stepType ? -1 : 1;
  if (a.targetRawName !== b.targetRawName)
    return a.targetRawName < b.targetRawName ? -1 : 1;
  return 0;
};

/**
 * The `sfi.omniscript_flow` MCP tool. Walks one OmniScript end-to-end,
 * returning the step sequence plus the downstream IP / DataRaptor / OS
 * dispatches resolved through `dispatchesOmniAction` edges. Surfaces
 * three verbatim boundary disclosures (Native-vs-Vlocity heuristic,
 * record-level data out of scope, Apex coupling deferred to v3.3) on
 * EVERY response per PLAN-v3.2 §4 / Q176-Q180 anchors.
 *
 * @example
 *   const r = await omniscriptFlowHandler(ctx, {
 *     omniScriptId: 'OmniScript:AccountLinking_Existing_English_1',
 *   });
 *   if (r.ok) console.log(r.value.data.steps.length);
 */
export const omniscriptFlowHandler = async (
  ctx: Context,
  input: OmniscriptFlowInput,
): Promise<Result<McpResponse<OmniscriptFlowOutput>, McpError>> => {
  if (!isOmniScriptId(input.omniScriptId)) {
    return err({
      kind: 'invalid-query',
      message: `omniScriptId must start with '${OMNISCRIPT_PREFIX}'; got '${input.omniScriptId}'`,
      path: 'omniScriptId',
    });
  }
  const omniScriptId = input.omniScriptId as ComponentId;
  const includePsc = input.includeChildPropertySetConfig === true;

  const nodeRes = await getNodeById(ctx.graph, omniScriptId);
  if (!nodeRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeRes.error.message}`,
    });
  }
  if (nodeRes.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, omniScriptId, 'OmniScript'),
      path: omniScriptId,
    });
  }
  const node = nodeRes.value;
  if (node.type !== 'OmniScript') {
    // The id prefix matches but the resolved node is some other type —
    // defensive against future id collisions. Surface as invalid-query
    // because the caller's input semantically misidentifies the kind.
    return err({
      kind: 'invalid-query',
      message: `id '${omniScriptId}' resolved to type '${node.type}', not 'OmniScript'`,
      path: 'omniScriptId',
    });
  }

  // Walk outgoing dispatchesOmniAction edges and expand each into a
  // DispatchedAction. Each edge's properties carry the caller's
  // stepName / stepType / targetRawName per the v3.2 R2 extractor.
  const edgeRes = await listEdges(ctx.graph, omniScriptId, {
    direction: 'out',
    edgeType: DISPATCH_EDGE_TYPE,
  });
  if (!edgeRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgeRes.error.message}`,
    });
  }
  const dispatchedActions: DispatchedAction[] = [];
  for (const edge of edgeRes.value) {
    const props = edge.properties;
    const stepName =
      typeof props['stepName'] === 'string' ? props['stepName'] : '';
    const stepType =
      typeof props['stepType'] === 'string' ? props['stepType'] : '';
    const targetRawName =
      typeof props['targetRawName'] === 'string'
        ? props['targetRawName']
        : edge.toId.includes(':')
          ? edge.toId.slice(edge.toId.indexOf(':') + 1)
          : edge.toId;
    // Resolve `targetId` by checking whether the target exists in the
    // vault. Dangling references surface as `targetId: null` so the
    // renderer can flag them (Vlocity-Legacy / cross-namespace cases).
    const targetRes = await getNodeById(ctx.graph, edge.toId);
    if (!targetRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${targetRes.error.message}`,
      });
    }
    dispatchedActions.push({
      stepName,
      stepType,
      targetId: targetRes.value === null ? null : edge.toId,
      targetRawName,
      confidence: edge.confidence,
    });
  }
  dispatchedActions.sort(compareDispatched);

  // Re-parse the source XML for the per-step shape (the v3.2 R2
  // extractor stores only summary counts). When the source file has
  // moved / been deleted between refresh and query, surface the failure
  // as `internal` so the renderer can fall back to dispatchedActions
  // alone rather than wedging the response.
  const stepsRes = await readSteps(
    resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
    includePsc,
  );
  if (!stepsRes.ok) {
    return err({ kind: 'internal', message: stepsRes.error });
  }
  const steps = stepsRes.value;

  // Pull metadata from the v3.2 R2 extractor's properties surface. The
  // extractor populates these from top-level XML elements (uniqueName,
  // omniProcessType, versionNumber, language, subType, type) plus the
  // boolean flags (isActive, isWebCompEnabled).
  const props = node.properties;
  const metadata = {
    omniProcessType: readStringProp(props, 'omniProcessType'),
    versionNumber: readNumberProp(props, 'versionNumber'),
    language: readStringProp(props, 'language'),
    isActive: readBoolProp(props, 'isActive'),
    isWebCompEnabled: readBoolProp(props, 'isWebCompEnabled'),
    uniqueName: readStringProp(props, 'uniqueName'),
    subType: readStringProp(props, 'subType'),
    type: readStringProp(props, 'type'),
  };

  return ok({
    data: {
      omniScriptId,
      apiName: node.apiName,
      metadata,
      steps,
      dispatchedActions,
      boundaries: [
        NATIVE_VS_VLOCITY_DISCLOSURE,
        RECORD_LEVEL_DISCLOSURE,
        APEX_COUPLING_DEFERRAL_DISCLOSURE,
      ],
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
