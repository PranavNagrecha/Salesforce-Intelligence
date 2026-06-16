/**
 * Handler for the `sfi.what_if_make_field_required` MCP tool.
 *
 * v2.3 R2a — the "I want to make this field required — what breaks?"
 * surface. Given a `CustomField:{Object}.{Field}` id, walks the parent
 * object's write paths and flags incomplete writes that would fail at
 * runtime once the field is required:
 *
 *   - **Layouts not displaying the field**: users creating records via
 *     those layouts cannot enter a value through the UI. Surfaces as
 *     `category: 'configuration-only'` (non-blocking but worth review —
 *     the field may be populated automatically).
 *   - **Flows creating records of the parent object WITHOUT setting the
 *     field**: the create will fail at runtime under the new
 *     required-field constraint. `category: 'metadata-blocker'`.
 *   - **Integrations (External Service / External Data Source) targeting
 *     the parent object without including the field**: the integration
 *     write will fail. `category: 'integration-touch'`.
 *
 * **NOT walked: Apex insert/update sites.** Determining whether an Apex
 * `insert acc;` statement sets `acc.Industry__c` requires dataflow
 * analysis — tracking assignments to the `acc` variable through the
 * method body. The v0.3 apex-scanner does not have this capability,
 * and the v2.3 milestone deliberately defers per
 * `WhatIfSemantics.md` § "Apex create coverage — DELIBERATELY NOT
 * IMPLEMENTED". The boundary disclosure surfaces this verbatim.
 *
 * **No-op case.** When the field is already required
 * (`properties.required === true`), the tool returns a `safe` verdict
 * with an empty impacts list and a disclosure noting the no-op.
 *
 * **Aggregate verdict.**
 *   - `safe`: already required, or no impacts.
 *   - `review`: only configuration-only layout findings.
 *   - `risky`: at least one integration-touch finding but no
 *     metadata-blockers.
 *   - `blocking`: at least one Flow create path without the field.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { type CoverageCaveat, type Verdict } from './coverage-trust.js';
import { readFactBlock, type FactsBlock } from './facts-block.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { hybridTrust, type HybridStaleness } from './hybrid-trust.js';
import { assertSoqlIdentifier, checkVaultStaleness, resolveLiveAccess } from './live-plane.js';
import { liveCount } from './live-session.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

const MAKE_REQUIRED_COVERAGE = [
  'CustomField',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'ExternalService',
  'ExternalDataSource',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'FlexiPage',
] as const;

/** Finding category per WhatIfSemantics.md § "Category assignment rules". */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only';

/** One impact entry in the response. */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/**
 * The live production null-rate for the field (P6-required-field-whatif).
 * Present only when the live plane is enabled and the field's object is
 * queryable — the hybrid magnitude behind "make this required".
 */
export interface LiveFieldNullRate {
  readonly totalCount: number;
  readonly nullCount: number;
  readonly populatedCount: number;
  /** Fraction of existing records where the field is currently null (0..1). */
  readonly nullRate: number;
  readonly populationRate: number;
  readonly interpretation: string;
  readonly liveQueriedAt: string;
  readonly cached: boolean;
}

/** Payload wrapped in the `McpResponse` envelope on success. */
export interface WhatIfMakeFieldRequiredOutput {
  readonly fieldId: ComponentId;
  readonly alreadyRequired: boolean;
  readonly impacts: readonly WhatIfImpactItem[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  /** Live production null-rate when consented + queryable (P6-required-field-whatif). */
  readonly liveNullRate?: LiveFieldNullRate;
  readonly staleness?: HybridStaleness;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  /**
   * P13-FACTS-consumers: captured fill rate for this field (`data_snapshot`),
   * when one exists. CONTEXT ONLY — the verdict is computed purely from the
   * metadata graph and NEVER moves toward safe because of a sampled
   * observation (a high sampled fill rate does not soften the verdict).
   */
  readonly dataShape?: FactsBlock;
}

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * dataflow-analysis boundary per `WhatIfSemantics.md` § "Apex create
 * coverage — DELIBERATELY NOT IMPLEMENTED".
 */
const DISCLOSURE =
  "the analysis checks layouts (UI input paths), Flow create paths, and integration write surfaces. Apex `insert acc;` sites that may or may not set the field are invisible — determining whether `acc.Industry__c` was assigned before the insert requires dataflow analysis. If your org has Apex create paths, verify the field is set before making required.";

const coverageCaveatFor = (ctx: Context): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, MAKE_REQUIRED_COVERAGE);
  if (coverage.status === 'complete') return undefined;
  const missingCoverage = coverage.missingCoverage.length > 0
    ? coverage.missingCoverage
    : [...MAKE_REQUIRED_COVERAGE];
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage,
    message:
      `Required-field impact is incomplete because the vault lacks coverage for: ${missingCoverage.join(', ')}. Absence of failing create paths in those families means "not checked", not "safe".`,
  };
};

const trustFor = (
  ctx: Context,
  impacts: readonly WhatIfImpactItem[],
  coverageCaveat: CoverageCaveat | undefined,
): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: impacts.some((impact) => impact.confidence === 'heuristic')
    ? 'heuristic'
    : 'parsed',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: {
    status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
    ...(coverageCaveat !== undefined
      ? { missingCoverage: coverageCaveat.missingCoverage }
      : {}),
  },
  limitations: [
    DISCLOSURE,
    ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
  ],
});

/** The live result threaded into the answer when the live plane is on (P6-required-field-whatif). */
interface LiveEnrichment {
  readonly liveNullRate: LiveFieldNullRate;
  readonly staleness: HybridStaleness | undefined;
}

/**
 * Compute the field's production null-rate via the live plane, gated by consent.
 * Returns `null` when live is not enabled, the field's object is not queryable,
 * or the query errors — the offline verdict always stands on its own. Goes
 * through the session cache + budget; also runs the staleness check so the
 * hybrid answer can lead with a vault-drift warning.
 */
const computeLiveNullRate = async (
  ctx: Context,
  fieldNode: Node,
  input: WhatIfMakeFieldRequiredInput,
  exec?: ExecCommand,
): Promise<LiveEnrichment | null> => {
  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;
  const access = await resolveLiveAccess(org, input.liveEnabled);
  if (!access.allowed) return null;

  const parentId = fieldNode.parentId;
  if (parentId === null || !parentId.startsWith('CustomObject:')) return null;
  const obj = assertSoqlIdentifier(parentId.slice('CustomObject:'.length), 'object');
  const field = assertSoqlIdentifier(fieldNode.apiName, 'field');
  if (!obj.ok || !field.ok) return null;

  const totalR = await liveCount(org, `SELECT COUNT() FROM ${obj.value}`, exec);
  if (!totalR.ok) return null;
  const nullR = await liveCount(
    org,
    `SELECT COUNT() FROM ${obj.value} WHERE ${field.value} = null`,
    exec,
  );
  if (!nullR.ok) return null;

  const totalCount = totalR.value.count;
  const nullCount = nullR.value.count;
  const populatedCount = Math.max(0, totalCount - nullCount);
  const nullRate = totalCount === 0 ? 0 : Math.round((nullCount / totalCount) * 1000) / 1000;
  const populationRate = totalCount === 0 ? 0 : Math.round((populatedCount / totalCount) * 1000) / 1000;

  const interpretation =
    totalCount === 0
      ? 'The object has no records, so making the field required affects no existing data — only future creates/edits.'
      : nullCount === 0
        ? `All ${totalCount} existing record(s) already populate this field — making it required is data-safe for the current population (new and edited records will still be required to set it).`
        : `${nullCount} of ${totalCount} existing record(s) (${Math.round(nullRate * 100)}%) currently have this field NULL. Existing records are NOT retroactively forced to fill it, but every new or edited record — and any automation/integration that creates a record without it — will now require a value.`;

  const stale = await checkVaultStaleness(org, ctx.manifest.refreshedAt, exec);
  const staleness: HybridStaleness | undefined = stale.ok
    ? {
        vaultStale: stale.value.vaultStale,
        driftCount: stale.value.driftCount,
        checkedTypes: stale.value.checkedTypes,
        warning: stale.value.warning,
      }
    : undefined;

  return {
    liveNullRate: {
      totalCount,
      nullCount,
      populatedCount,
      nullRate,
      populationRate,
      interpretation,
      liveQueriedAt: totalR.value.queriedAt,
      cached: totalR.value.cached && nullR.value.cached,
    },
    staleness,
  };
};

/** Hybrid trust when the live null-rate is present, carrying both planes' freshness + staleness. */
const hybridTrustFor = (
  ctx: Context,
  impacts: readonly WhatIfImpactItem[],
  coverageCaveat: CoverageCaveat | undefined,
  live: LiveEnrichment,
): TrustSummary =>
  hybridTrust({
    vaultRefreshedAt: ctx.manifest.refreshedAt,
    liveQueriedAt: live.liveNullRate.liveQueriedAt,
    vaultConfidence: impacts.some((impact) => impact.confidence === 'heuristic')
      ? 'heuristic'
      : 'parsed',
    completeness: {
      status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
      ...(coverageCaveat !== undefined
        ? { missingCoverage: coverageCaveat.missingCoverage }
        : {}),
    },
    limitations: [
      DISCLOSURE,
      ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
      ...(live.staleness !== undefined && live.staleness.warning !== null
        ? [live.staleness.warning]
        : []),
    ],
    ...(live.staleness !== undefined ? { staleness: live.staleness } : {}),
  });

/**
 * Zod schema for the `sfi.what_if_make_field_required` tool input.
 *
 *   - `fieldId`: required, non-empty CustomField id. Prefix check
 *     happens at the handler.
 */
export const whatIfMakeFieldRequiredInputSchema = z.object({
  fieldId: z.string().min(1),
  /** Opt-in live plane: include the production null-rate for the field (P6-required-field-whatif). */
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type WhatIfMakeFieldRequiredInput = z.infer<
  typeof whatIfMakeFieldRequiredInputSchema
>;

/**
 * Read a node's `parentId` and resolve it. Used to find the parent
 * CustomObject of a CustomField so the layout / Flow / integration
 * scan can scope to fields under that object.
 */
const resolveParentObjectId = (fieldNode: Node): ComponentId | null => {
  return fieldNode.parentId;
};

/**
 * Determine whether a layout displays the target field. Walks the
 * layout's outgoing `usedInLayout` edges; if any target the field, the
 * layout displays it.
 */
const layoutDisplaysField = async (
  ctx: Context,
  layoutId: ComponentId,
  fieldId: ComponentId,
): Promise<Result<boolean, string>> => {
  const edgesResult = await listEdges(ctx.graph, layoutId, {
    direction: 'out',
    edgeType: 'usedInLayout',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  for (const edge of edgesResult.value) {
    if (edge.toId === fieldId) return ok(true);
  }
  return ok(false);
};

/**
 * Return the operation under which a Flow sets the target FIELD, or null
 * when it never sets it.
 *
 * The Flow extractor emits a FIELD-level `writesTo` edge
 * (`toId = CustomField:{Object}.{Field}`) for each `<inputAssignments>`
 * inside a `<recordCreates>` / `<recordUpdates>`, tagged with
 * `properties.operation`. This walks the Flow's outgoing `writesTo` edges and
 * matches that field-level target. When a Flow sets the field on BOTH create
 * and update, `recordCreate` is preferred — that is the operation that proves
 * the create path populates the field (the dedup pass normally collapses the
 * pair to the create edge, but the preference does not rely on edge ordering).
 */
const flowWritesToField = async (
  ctx: Context,
  flowId: ComponentId,
  fieldId: ComponentId,
): Promise<Result<string | null, string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  let firstOp: string | null = null;
  for (const edge of edgesResult.value) {
    if (edge.toId !== fieldId) continue;
    const op = edge.properties['operation'];
    const opStr = typeof op === 'string' ? op : 'write';
    if (opStr === 'recordCreate' || opStr === 'create') return ok(opStr);
    if (firstOp === null) firstOp = opStr;
  }
  return ok(firstOp);
};

/**
 * For a Flow, determine whether it creates records of the parent object.
 *
 * Detection is via the OBJECT-level write edge the Flow extractor emits per
 * `<recordCreates>` (`toId = CustomObject:{Object}`,
 * `properties.operation === 'recordCreate'`). This is deliberately the
 * object-level edge, not a field-level one: a Flow that creates a record but
 * sets the target field on a LATER update (or sets no fields the vault models)
 * still creates records of the object — and the create path that omits the
 * now-required field is exactly the failure this tool must surface. The
 * separate {@link flowWritesToField} check then decides whether the field is
 * actually set on that create.
 *
 * Returns true when at least one object-level create-write to the parent is
 * observed.
 */
const flowCreatesParentRecords = async (
  ctx: Context,
  flowId: ComponentId,
  parentObjectId: ComponentId,
): Promise<Result<boolean, string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  for (const edge of edgesResult.value) {
    const op = edge.properties['operation'];
    const isCreate = op === 'recordCreate' || op === 'create';
    if (isCreate && edge.toId === parentObjectId) return ok(true);
  }
  return ok(false);
};

/**
 * For an integration (ExternalService / ExternalDataSource), determine
 * whether the integration's outgoing `references` edges touch any
 * field on the parent object. The integration's schema is encoded as
 * `references` edges per the v1.5 integration topology extractor.
 *
 * Returns true when the integration references at least one field on
 * the parent — used as a coarse proxy for "this integration writes to
 * the parent object". v2.3 deliberately does not walk the integration's
 * payload schema in detail; the boundary disclosure surfaces this.
 */
const integrationReferencesParent = async (
  ctx: Context,
  integrationId: ComponentId,
  parentObjectId: ComponentId,
): Promise<Result<boolean, string>> => {
  const edgesResult = await listEdges(ctx.graph, integrationId, {
    direction: 'out',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  for (const edge of edgesResult.value) {
    if (edge.toId === parentObjectId) return ok(true);
    // Also check whether the integration references a field on the
    // parent.
    const targetResult = await getNodeById(ctx.graph, edge.toId);
    if (!targetResult.ok) return err(targetResult.error.message);
    const targetNode = targetResult.value;
    if (targetNode === null) continue;
    if (
      targetNode.type === 'CustomField' &&
      targetNode.parentId === parentObjectId
    ) {
      return ok(true);
    }
  }
  return ok(false);
};

/**
 * Aggregate the per-impact verdicts into the headline severity.
 */
const aggregateVerdict = (
  impacts: readonly WhatIfImpactItem[],
): Verdict => {
  if (impacts.length === 0) return 'safe';
  let sawBlocker = false;
  let sawIntegration = false;
  let sawConfigOnly = false;
  for (const i of impacts) {
    if (i.category === 'metadata-blocker') sawBlocker = true;
    else if (i.category === 'integration-touch') sawIntegration = true;
    else if (i.category === 'configuration-only') sawConfigOnly = true;
  }
  if (sawBlocker) return 'blocking';
  if (sawIntegration) return 'risky';
  if (sawConfigOnly) return 'review';
  return 'review';
};

/**
 * The `sfi.what_if_make_field_required` MCP tool.
 *
 * @example
 *   const r = await whatIfMakeFieldRequiredHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
export const whatIfMakeFieldRequiredHandler = async (
  ctx: Context,
  input: WhatIfMakeFieldRequiredInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<WhatIfMakeFieldRequiredOutput>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(
      suggestionResult.value as unknown as McpResponse<WhatIfMakeFieldRequiredOutput>,
    );
  }

  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }

  const fieldNode = nodeResult.value;

  // P6-required-field-whatif: the live production null-rate, when consented.
  // null when live is off or the object is not queryable — the offline verdict
  // always stands. Computed once, threaded into whichever return fires.
  const live = await computeLiveNullRate(ctx, fieldNode, input, exec);
  const liveExtras = live !== null
    ? {
        liveNullRate: live.liveNullRate,
        ...(live.staleness !== undefined ? { staleness: live.staleness } : {}),
      }
    : {};

  // No-op case: already required.
  const requiredProp = fieldNode.properties['required'];
  const alreadyRequired = requiredProp === true;
  if (alreadyRequired) {
    const coverageCaveat = coverageCaveatFor(ctx);
    const impacts: readonly WhatIfImpactItem[] = [];
    return ok({
      data: {
        fieldId,
        alreadyRequired: true,
        impacts,
        verdict: coverageCaveat === undefined ? 'safe' : 'review',
        ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
        ...liveExtras,
        trust: live !== null
          ? hybridTrustFor(ctx, impacts, coverageCaveat, live)
          : trustFor(ctx, impacts, coverageCaveat),
        disclosure: DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // Field-type guard: Formula / Roll-Up Summary / Auto Number fields are
  // computed or auto-generated — never user-entered — so Salesforce offers no
  // "Required" option for them. Walking write paths would return a misleading
  // verdict for an operation that cannot be performed (mirrors
  // what_if_remove_picklist_value's wrong-field-type guard). A formula field's
  // `dataType` is its RETURN type, so detect it via the non-null `formula`
  // property rather than a dataType literal.
  const formulaProp = fieldNode.properties['formula'];
  const dataTypeProp = fieldNode.properties['dataType'];
  const notRequirableReason =
    typeof formulaProp === 'string' && formulaProp.length > 0
      ? 'is a formula (computed) field'
      : dataTypeProp === 'Summary'
        ? 'is a roll-up summary (computed) field'
        : dataTypeProp === 'AutoNumber'
          ? 'is an auto-number (auto-generated) field'
          : null;
  if (notRequirableReason !== null) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} ${notRequirableReason}; such fields cannot be made required`,
      path: 'fieldId',
    });
  }

  const parentObjectId = resolveParentObjectId(fieldNode);
  if (parentObjectId === null) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} has no parent object; cannot scope the layout / Flow / integration scan`,
      path: 'fieldId',
    });
  }

  const impacts: WhatIfImpactItem[] = [];

  // === Layout coverage ===
  // Find every Layout whose parentId matches the parent object. For
  // each, check whether the layout displays the field; if not, emit a
  // configuration-only finding.
  const layoutsResult = await listNodesByType(ctx.graph, 'Layout', {
    parentId: parentObjectId,
    limit: 500,
  });
  if (!layoutsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${layoutsResult.error.message}`,
    });
  }
  for (const layout of layoutsResult.value) {
    const displaysResult = await layoutDisplaysField(ctx, layout.id, fieldId);
    if (!displaysResult.ok) {
      return err({ kind: 'internal', message: displaysResult.error });
    }
    if (displaysResult.value) continue;
    impacts.push({
      category: 'configuration-only',
      componentId: layout.id,
      componentType: layout.type,
      apiName: layout.apiName,
      confidence: 'declared',
      explanation: `Layout '${layout.apiName}' does not display this field; users creating records via this layout cannot enter a value through the UI.`,
    });
  }

  // === Flow create coverage ===
  // For every Flow that creates records on the parent object, check
  // whether the Flow writes to the target field. When it does not, the
  // Flow's create will fail at runtime under the new required-field
  // constraint.
  const flowsResult = await listNodesByType(ctx.graph, 'Flow', { limit: 500 });
  if (!flowsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${flowsResult.error.message}`,
    });
  }
  for (const flow of flowsResult.value) {
    const createsResult = await flowCreatesParentRecords(
      ctx,
      flow.id,
      parentObjectId,
    );
    if (!createsResult.ok) {
      return err({ kind: 'internal', message: createsResult.error });
    }
    if (!createsResult.value) continue;
    const writesResult = await flowWritesToField(ctx, flow.id, fieldId);
    if (!writesResult.ok) {
      return err({ kind: 'internal', message: writesResult.error });
    }
    // The Flow creates records on the parent. If we observe a writesTo
    // edge to THIS field with operation 'recordCreate', the Flow sets
    // the field — NOT a finding. If we don't, the create path doesn't
    // set the field — emit a metadata-blocker.
    const op = writesResult.value;
    const setsThisFieldOnCreate = op === 'recordCreate' || op === 'create';
    if (setsThisFieldOnCreate) continue;
    impacts.push({
      category: 'metadata-blocker',
      componentId: flow.id,
      componentType: flow.type,
      apiName: flow.apiName,
      confidence: 'parsed',
      explanation: `Flow '${flow.apiName}' creates records on the parent object but does not set this field; the create will fail at runtime under the new required-field constraint.`,
    });
  }

  // === Integration write coverage ===
  // For every ExternalService / ExternalDataSource referencing the
  // parent object, emit an integration-touch finding. The v1.5
  // integration extractor populates `references` edges; the boundary
  // disclosure covers the schema-detail gap.
  for (const integrationType of ['ExternalService', 'ExternalDataSource'] as const) {
    const integrationsResult = await listNodesByType(
      ctx.graph,
      integrationType,
      { limit: 500 },
    );
    if (!integrationsResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${integrationsResult.error.message}`,
      });
    }
    for (const integration of integrationsResult.value) {
      const refsResult = await integrationReferencesParent(
        ctx,
        integration.id,
        parentObjectId,
      );
      if (!refsResult.ok) {
        return err({ kind: 'internal', message: refsResult.error });
      }
      if (!refsResult.value) continue;
      // The integration touches the parent object; whether its payload
      // includes this field cannot be determined precisely from the
      // v1.5 surface, so flag it for migration coordination.
      impacts.push({
        category: 'integration-touch',
        componentId: integration.id,
        componentType: integration.type,
        apiName: integration.apiName,
        confidence: 'declared',
        explanation: `${integration.type} '${integration.apiName}' targets the parent object; verify the integration sends this field before making it required.`,
      });
    }
  }

  // === ListView filter / column coverage (bug 16) ===
  // A ListView that references this field — as a filter or a column — can
  // change which records appear, or show blank values, once the field is
  // required (records created before the constraint may still be null). The
  // enterprise-metadata extractor emits a `references` edge ListView → field;
  // walk the field's incoming references and surface any ListView source.
  const fieldRefEdges = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!fieldRefEdges.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fieldRefEdges.error.message}`,
    });
  }
  for (const refEdge of fieldRefEdges.value) {
    const srcResult = await getNodeById(ctx.graph, refEdge.fromId);
    if (!srcResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${srcResult.error.message}`,
      });
    }
    const src = srcResult.value;
    if (src === null || src.type !== 'ListView') continue;
    impacts.push({
      category: 'configuration-only',
      componentId: src.id,
      componentType: src.type,
      apiName: src.apiName,
      confidence: 'declared',
      explanation: `ListView '${src.apiName}' references this field (filter or column); making it required can change which records appear, or surface blank values for records created before the constraint.`,
    });
  }

  // Deterministic order by componentId.
  const sortedImpacts = [...impacts].sort((a, b) =>
    a.componentId < b.componentId ? -1
      : a.componentId > b.componentId ? 1
      : 0,
  );

  const coverageCaveat = coverageCaveatFor(ctx);
  const rawVerdict = aggregateVerdict(sortedImpacts);
  const verdict = rawVerdict === 'safe' && coverageCaveat !== undefined
    ? 'review'
    : rawVerdict;

  const dataShape = await readFactBlock(ctx, fieldId, 'fillRate');

  return ok({
    data: {
      fieldId,
      alreadyRequired: false,
      impacts: sortedImpacts,
      verdict,
      ...(dataShape !== undefined ? { dataShape } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...liveExtras,
      trust: live !== null
        ? hybridTrustFor(ctx, sortedImpacts, coverageCaveat, live)
        : trustFor(ctx, sortedImpacts, coverageCaveat),
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
