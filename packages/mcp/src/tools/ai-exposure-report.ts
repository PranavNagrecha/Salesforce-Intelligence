/**
 * Handler for the `sfi.ai_exposure_report` MCP tool.
 *
 * The R6-13 flagship: "what data can my org's AI see?" — the audit the product's
 * "the backend your Salesforce AI can trust" positioning always implied but
 * could not answer, because the org's OWN generative-AI surface was unmodeled
 * until the R6-13 extraction tier.
 *
 * It COMPOSES two existing planes:
 *
 *   (a) The extracted Agentforce GenAI surface — `GenAiPromptTemplate`s and
 *       their grounding object/field references, plus the agent action tree
 *       (`GenAiPlannerBundle` → `GenAiPlugin` → `GenAiFunction` → the
 *       `ApexClass`/`Flow` each action invokes and the fields THAT code
 *       reads/writes, and any prompt template an action invokes) — and the
 *       Einstein Bot / Agentforce agent definition (`Bot`) whose
 *       context-variable field mappings and `BotVersion` →
 *       `GenAiPlannerBundle` planner links roll field reach up to the bot.
 *   (b) The `pii-detection` recognizer that backs `sfi.pii_inventory` — run
 *       over every exposed field, so a grounded / action-reachable field
 *       carries the SAME PII classification the inventory tool would assign.
 *
 * The result names, per AI surface, WHICH object/fields it exposes, and flags
 * the ones the recognizer classifies `pii` / `sensitive` — the headline
 * finding "your Reservation agent's prompt template grounds on Contact.SSN__c —
 * PII". A `piiExposures[]` list is the actionable subset; `surfaces[]` is the
 * full per-surface breakdown.
 *
 * FAIL-CLOSED: when the vault carries ZERO GenAI nodes, the disposition is
 * `no-ai-surface-modeled` with a message that names BOTH possibilities — the
 * org genuinely has no Agentforce/GenAI config, OR the vault predates the
 * R6-13 extraction tier (re-run /sfi-refresh). It NEVER implies an empty org.
 *
 * Honesty axis (load-bearing, see `STATIC_BOUNDARIES`):
 *   - The AI-surface wiring is DECLARED metadata (a prompt grounds on a field,
 *     a topic references an action), NOT a runtime trace — it does not prove
 *     the agent ran, selected the topic, or that a grounded field was
 *     populated at inference time.
 *   - PII classification is HEURISTIC (the `pii_inventory` recognizer over the
 *     field's name / type / description). A field the vault does not model (a
 *     standard field, or an object not retrieved) is `unknown` — never
 *     silently "not PII".
 *   - Indirect exposure via an action's Apex/Flow is the field access modeled
 *     on that code (readsFrom / writesTo edges); Apex access is heuristic
 *     static analysis and dynamic/reflective access is invisible.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import {
  detectPiiClassificationWithReason,
  type PiiCategory,
  type PiiClassification,
} from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import { paginate, argsFingerprint, type PaginateBinding } from './page-cursor.js';

const TOOL_NAME = 'sfi.ai_exposure_report';

/** Default and max number of surfaces / pii-exposures returned per list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Page size when walking a node type; the graph layer caps each call at 500. */
const SCAN_PAGE_SIZE = 500;

/**
 * Cap on fields listed per surface. PII / sensitive fields are sorted FIRST
 * and never dropped by the cap (a headline exposure is never hidden); only the
 * `public` / `unknown` tail is truncated, with a per-surface `fieldsTruncated`
 * flag so the count stays honest.
 */
const MAX_FIELDS_PER_SURFACE = 100;

/** The exact fail-closed message — names BOTH possibilities, never implies an empty org. */
const NO_AI_SURFACE_MESSAGE =
  'no AI surface modeled — either the org has none or the vault predates GenAI/Bot extraction (re-run /sfi-refresh)';

/** Zod schema for the `sfi.ai_exposure_report` tool input. */
export const aiExposureReportInputSchema = z.object({
  objectApiName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type AiExposureReportInput = z.infer<typeof aiExposureReportInputSchema>;

/** The Agentforce GenAI + Bot ComponentTypes this tool composes. */
type AiSurfaceType =
  | 'GenAiPromptTemplate'
  | 'GenAiFunction'
  | 'GenAiPlugin'
  | 'GenAiPlannerBundle'
  | 'Bot';

/** One object/field an AI surface exposes, with its (heuristic) PII verdict. */
export interface ExposedField {
  readonly fieldId: ComponentId;
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  /** Whether the field is a modeled CustomField node (false → classification is `unknown`). */
  readonly modeled: boolean;
  /** The mechanism(s) by which this surface reaches the field, sorted + de-duplicated. */
  readonly via: readonly string[];
  /** Why the classification was assigned (the recognizer's reason, or the not-modeled note). */
  readonly reason: string;
}

/** One AI surface (prompt template / action / topic / agent) and the fields it exposes. */
export interface AiSurface {
  readonly id: ComponentId;
  readonly surfaceType: AiSurfaceType;
  readonly label: string;
  readonly exposedFields: readonly ExposedField[];
  readonly exposedFieldCount: number;
  readonly piiFieldCount: number;
  readonly sensitiveFieldCount: number;
  /** True when the per-surface field list was capped (only public/unknown fields dropped). */
  readonly fieldsTruncated: boolean;
}

/** One flagged (surface, field) pair — the actionable headline of the report. */
export interface PiiExposure {
  readonly surfaceId: ComponentId;
  readonly surfaceType: AiSurfaceType;
  readonly surfaceLabel: string;
  readonly fieldId: ComponentId;
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly classification: 'pii' | 'sensitive';
  readonly category: PiiCategory;
  readonly via: readonly string[];
  readonly reason: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface AiExposureReportOutput {
  readonly scope: {
    readonly mode: 'org-wide' | 'object';
    readonly objectApiName?: string;
  };
  readonly disposition: 'ai-surface-modeled' | 'no-ai-surface-modeled';
  /** Present on `no-ai-surface-modeled` — the fail-closed message. */
  readonly message?: string;
  readonly surfaces: readonly AiSurface[];
  readonly piiExposures: readonly PiiExposure[];
  readonly summary: {
    readonly promptTemplates: number;
    readonly functions: number;
    readonly plugins: number;
    readonly plannerBundles: number;
    readonly bots: number;
    readonly surfacesWithFieldExposure: number;
    readonly fieldsExposed: number;
    readonly piiFieldsExposed: number;
    readonly sensitiveFieldsExposed: number;
    readonly surfacesTruncated: boolean;
    readonly piiExposuresTruncated: boolean;
  };
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

/** A resolved classification for one field id (memoised across surfaces). */
interface FieldVerdict {
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly modeled: boolean;
  readonly reason: string;
}

/** Parse `CustomField:{Object}.{Field}` → its object and field api names. */
const OBJECT_FIELD_RE = /^CustomField:([^.]+)\.(.+)$/;
const splitFieldId = (fieldId: ComponentId): { object: string; field: string } | null => {
  const m = OBJECT_FIELD_RE.exec(fieldId);
  return m?.[1] !== undefined && m[2] !== undefined ? { object: m[1], field: m[2] } : null;
};

/** Walk every page of a node type and return the full list. */
const fetchAllOfType = async (
  ctx: Context,
  type: AiSurfaceType,
): Promise<Result<readonly Node[], string>> => {
  const all: Node[] = [];
  let offset = 0;
  for (;;) {
    const page = await listNodesByType(ctx.graph, type, { limit: SCAN_PAGE_SIZE, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    if (page.value.length < SCAN_PAGE_SIZE) break;
    offset += SCAN_PAGE_SIZE;
  }
  return ok(all);
};

/** Classification severity for sorting — pii/sensitive first so the field cap never hides them. */
const CLASS_RANK: Record<PiiClassification, number> = {
  sensitive: 0,
  pii: 1,
  public: 2,
  unknown: 3,
};

const STATIC_BOUNDARIES: readonly string[] = Object.freeze([
  'The AI-surface wiring is DECLARED metadata — which topic references which action, which object/field a prompt template grounds on. It does NOT prove the agent ran, that the planner selected the topic, or that a grounded field was populated at inference time. This is the org\'s AI configuration, not a runtime trace.',
  'PII classification is HEURISTIC — the same `pii_inventory` recognizer over the field\'s API name, declared data type, and description. A field with no name/description signal classifies `public` even if it holds PII at runtime; treat every flag as a starting point for review, not the final word.',
  'A field the vault does not model (a standard field whose object was not field-enriched, or an object not retrieved) is classified `unknown` with `modeled: false` — never silently "not PII". Re-run /sfi-refresh (and enrich the object) to classify it.',
  'Indirect exposure via an agent action is the field access modeled on the Apex class / Flow the action invokes (readsFrom / writesTo edges). Apex field access is heuristic static analysis; dynamic / reflective access is invisible, and an action may not touch every listed field on every invocation.',
  'Grounding merge-fields whose input is undeclared, a primitive, or a relationship traversal were disclosed at extraction time in the template\'s `unresolvedGroundingRefs` and are NOT counted here (no phantom field is minted from a guessed object).',
  'A Bot surface unions (1) its declared context-variable field mappings (`botContextVariableField` edges — `bot-context-in-prompt` when includeInPrompt is true) and (2) the GenAiPlannerBundle reach of every BotVersion that references a planner. Dialog/intent message trees and unmapped context variables are not walked. BotVersion is not listed as its own surface — reach rolls up to the Bot definition.',
]);

const offlineTrust = (ctx: Context, completeness: TrustSummary['completeness']): TrustSummary => ({
  provenance: 'offline_snapshot',
  // The wiring is `declared`, but the PII verdicts and the Apex-derived
  // action-field access are `heuristic` — the weaker of the two governs.
  confidence: 'heuristic',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness,
  limitations: [...STATIC_BOUNDARIES],
});

/**
 * The `sfi.ai_exposure_report` MCP tool. See the module JSDoc for the
 * composition and the honesty axis.
 *
 * @example
 *   const r = await aiExposureReportHandler(ctx, {});
 *   if (r.ok) for (const e of r.value.data.piiExposures) console.log(e.surfaceLabel, e.fieldApiName);
 */
export const aiExposureReportHandler = async (
  ctx: Context,
  input: AiExposureReportInput,
): Promise<Result<McpResponse<AiExposureReportOutput>, McpError>> => {
  const objectFilter =
    input.objectApiName !== undefined
      ? input.objectApiName.replace(/^CustomObject:/, '')
      : undefined;
  const scope: AiExposureReportOutput['scope'] =
    objectFilter !== undefined ? { mode: 'object', objectApiName: objectFilter } : { mode: 'org-wide' };

  // --- Enumerate the GenAI surface families + Bot (R7-C7 composition). ---
  const [promptTemplatesR, functionsR, pluginsR, plannerBundlesR, botsR] = await Promise.all([
    fetchAllOfType(ctx, 'GenAiPromptTemplate'),
    fetchAllOfType(ctx, 'GenAiFunction'),
    fetchAllOfType(ctx, 'GenAiPlugin'),
    fetchAllOfType(ctx, 'GenAiPlannerBundle'),
    fetchAllOfType(ctx, 'Bot'),
  ]);
  for (const r of [promptTemplatesR, functionsR, pluginsR, plannerBundlesR, botsR]) {
    if (!r.ok) return err({ kind: 'internal', message: `graph query failed: ${r.error}` });
  }
  const promptTemplates = promptTemplatesR.ok ? promptTemplatesR.value : [];
  const functions = functionsR.ok ? functionsR.value : [];
  const plugins = pluginsR.ok ? pluginsR.value : [];
  const plannerBundles = plannerBundlesR.ok ? plannerBundlesR.value : [];
  const bots = botsR.ok ? botsR.value : [];

  const totalSurfaces =
    promptTemplates.length +
    functions.length +
    plugins.length +
    plannerBundles.length +
    bots.length;

  // --- FAIL-CLOSED: no GenAI / Bot metadata modeled. ---
  if (totalSurfaces === 0) {
    return ok({
      data: {
        scope,
        disposition: 'no-ai-surface-modeled',
        message: NO_AI_SURFACE_MESSAGE,
        surfaces: [],
        piiExposures: [],
        summary: {
          promptTemplates: 0,
          functions: 0,
          plugins: 0,
          plannerBundles: 0,
          bots: 0,
          surfacesWithFieldExposure: 0,
          fieldsExposed: 0,
          piiFieldsExposed: 0,
          sensitiveFieldsExposed: 0,
          surfacesTruncated: false,
          piiExposuresTruncated: false,
        },
        boundaries: [...STATIC_BOUNDARIES],
        trust: offlineTrust(ctx, { status: 'unknown' }),
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // Index the prompt templates by id so a function that INVOKES a template
  // (invocationTarget names a GenAiPromptTemplate) inherits its grounding.
  const promptTemplateById = new Map<ComponentId, Node>(promptTemplates.map((n) => [n.id, n]));

  // --- Field classification cache (the pii_inventory recognizer). ---
  const verdictCache = new Map<ComponentId, FieldVerdict>();
  const classifyField = async (fieldId: ComponentId): Promise<FieldVerdict> => {
    const cached = verdictCache.get(fieldId);
    if (cached !== undefined) return cached;
    let verdict: FieldVerdict;
    const nodeR = await getNodeById(ctx.graph, fieldId);
    if (nodeR.ok && nodeR.value !== null && nodeR.value.type === 'CustomField') {
      const det = detectPiiClassificationWithReason(nodeR.value);
      verdict = {
        classification: det.piiClassification,
        category: det.piiCategory,
        modeled: true,
        reason: det.reason,
      };
    } else {
      verdict = {
        classification: 'unknown',
        category: 'unknown',
        modeled: false,
        reason:
          'field not modeled in the vault (a standard field whose object was not field-enriched, or an object not retrieved) — PII classification unavailable',
      };
    }
    verdictCache.set(fieldId, verdict);
    return verdict;
  };

  /** Accumulate field ids → the mechanisms that reach them for one surface. */
  type FieldReach = Map<ComponentId, Set<string>>;
  const mergeReach = (into: FieldReach, from: FieldReach): void => {
    for (const [fieldId, vias] of from) {
      const bucket = into.get(fieldId) ?? new Set<string>();
      for (const v of vias) bucket.add(v);
      into.set(fieldId, bucket);
    }
  };
  const addReach = (into: FieldReach, fieldId: ComponentId, via: string): void => {
    const bucket = into.get(fieldId) ?? new Set<string>();
    bucket.add(via);
    into.set(fieldId, bucket);
  };

  /** The CustomField ids a prompt template grounds on, from its declared references edges. */
  const promptTemplateReach = async (templateId: ComponentId): Promise<FieldReach> => {
    const reach: FieldReach = new Map();
    const edgesR = await listEdges(ctx.graph, templateId, { direction: 'out', edgeType: 'references' });
    if (!edgesR.ok) return reach;
    for (const edge of edgesR.value) {
      if (!edge.toId.startsWith('CustomField:')) continue;
      const kind = edge.properties['referenceKind'];
      const via =
        kind === 'promptTemplateRelatedField' ? 'prompt-related-field' : 'prompt-grounding-field';
      addReach(reach, edge.toId, via);
    }
    return reach;
  };

  /** The CustomField ids one Apex/Flow node reads or writes (an action's code-level field access). */
  const codeFieldReach = async (
    codeId: ComponentId,
    viaPrefix: string,
  ): Promise<FieldReach> => {
    const reach: FieldReach = new Map();
    for (const [edgeType, suffix] of [
      ['readsFrom', 'read'],
      ['writesTo', 'write'],
    ] as const) {
      const edgesR = await listEdges(ctx.graph, codeId, { direction: 'out', edgeType });
      if (!edgesR.ok) continue;
      for (const edge of edgesR.value) {
        if (!edge.toId.startsWith('CustomField:')) continue;
        addReach(reach, edge.toId, `${viaPrefix}-${suffix}`);
      }
    }
    return reach;
  };

  // --- Per-function field reach (memoised — plugins/planners reuse it). ---
  const functionReach = new Map<ComponentId, FieldReach>();
  for (const fn of functions) {
    const reach: FieldReach = new Map();
    const edgesR = await listEdges(ctx.graph, fn.id, { direction: 'out', edgeType: 'references' });
    if (edgesR.ok) {
      for (const edge of edgesR.value) {
        const kind = edge.properties['referenceKind'];
        if (kind === 'genAiFunctionApexTarget') {
          mergeReach(reach, await codeFieldReach(edge.toId, 'apex-action'));
        } else if (kind === 'genAiFunctionFlowTarget') {
          mergeReach(reach, await codeFieldReach(edge.toId, 'flow-action'));
        }
      }
    }
    // An action can INVOKE a prompt template — inherit its grounding fields.
    const target = fn.properties['invocationTarget'];
    if (typeof target === 'string') {
      const tmpl = promptTemplateById.get(`GenAiPromptTemplate:${target}`);
      if (tmpl !== undefined) {
        const tmplReach = await promptTemplateReach(tmpl.id);
        for (const [fieldId] of tmplReach) addReach(reach, fieldId, 'prompt-template-action');
      }
    }
    functionReach.set(fn.id, reach);
  }

  /** Member ids of a surface for a given referenceKind. */
  const memberIds = async (
    surfaceId: ComponentId,
    referenceKinds: readonly string[],
  ): Promise<readonly ComponentId[]> => {
    const edgesR = await listEdges(ctx.graph, surfaceId, { direction: 'out', edgeType: 'references' });
    if (!edgesR.ok) return [];
    return edgesR.value
      .filter((e) => referenceKinds.includes(String(e.properties['referenceKind'])))
      .map((e) => e.toId);
  };

  // --- Per-plugin field reach = union of its member functions. ---
  const pluginReach = new Map<ComponentId, FieldReach>();
  for (const plugin of plugins) {
    const reach: FieldReach = new Map();
    for (const fnId of await memberIds(plugin.id, ['genAiPluginFunction'])) {
      const fnr = functionReach.get(fnId);
      if (fnr !== undefined) mergeReach(reach, fnr);
    }
    pluginReach.set(plugin.id, reach);
  }

  // --- Per-planner field reach (memoised — Bot surfaces reuse it). ---
  const plannerReach = new Map<ComponentId, FieldReach>();
  for (const n of plannerBundles) {
    const reach: FieldReach = new Map();
    for (const pluginId of await memberIds(n.id, ['plannerBundlePlugin'])) {
      const pr = pluginReach.get(pluginId);
      if (pr !== undefined) mergeReach(reach, pr);
    }
    for (const fnId of await memberIds(n.id, ['plannerBundleFunction'])) {
      const fnr = functionReach.get(fnId);
      if (fnr !== undefined) mergeReach(reach, fnr);
    }
    plannerReach.set(n.id, reach);
  }

  // --- Build the surface list. ---
  const rawSurfaces: {
    node: Node;
    surfaceType: AiSurfaceType;
    reach: FieldReach;
  }[] = [];
  for (const n of promptTemplates) {
    rawSurfaces.push({ node: n, surfaceType: 'GenAiPromptTemplate', reach: await promptTemplateReach(n.id) });
  }
  for (const n of functions) {
    rawSurfaces.push({ node: n, surfaceType: 'GenAiFunction', reach: functionReach.get(n.id) ?? new Map() });
  }
  for (const n of plugins) {
    rawSurfaces.push({ node: n, surfaceType: 'GenAiPlugin', reach: pluginReach.get(n.id) ?? new Map() });
  }
  for (const n of plannerBundles) {
    rawSurfaces.push({
      node: n,
      surfaceType: 'GenAiPlannerBundle',
      reach: plannerReach.get(n.id) ?? new Map(),
    });
  }

  // Bot = context-variable fields + union of every BotVersion's planner reach.
  for (const bot of bots) {
    const reach: FieldReach = new Map();
    const ctxEdgesR = await listEdges(ctx.graph, bot.id, {
      direction: 'out',
      edgeType: 'references',
    });
    if (ctxEdgesR.ok) {
      for (const edge of ctxEdgesR.value) {
        if (edge.properties['referenceKind'] !== 'botContextVariableField') continue;
        if (!edge.toId.startsWith('CustomField:')) continue;
        addReach(reach, edge.toId, 'bot-context-variable');
        if (edge.properties['includeInPrompt'] === true) {
          addReach(reach, edge.toId, 'bot-context-in-prompt');
        }
      }
    }
    const versionEdgesR = await listEdges(ctx.graph, bot.id, {
      direction: 'out',
      edgeType: 'parentOf',
    });
    if (versionEdgesR.ok) {
      for (const versionEdge of versionEdgesR.value) {
        if (!versionEdge.toId.startsWith('BotVersion:')) continue;
        for (const plannerId of await memberIds(versionEdge.toId, ['botVersionPlanner'])) {
          const pr = plannerReach.get(plannerId);
          if (pr === undefined) continue;
          for (const [fieldId, vias] of pr) {
            const bucket = reach.get(fieldId) ?? new Set<string>();
            for (const v of vias) bucket.add(v);
            bucket.add('bot-version-planner');
            reach.set(fieldId, bucket);
          }
        }
      }
    }
    rawSurfaces.push({ node: bot, surfaceType: 'Bot', reach });
  }

  // --- Classify every reached field, apply the object filter, assemble output. ---
  const surfaces: AiSurface[] = [];
  const piiExposures: PiiExposure[] = [];
  const globalFieldClasses = new Map<ComponentId, PiiClassification>();

  for (const raw of rawSurfaces) {
    const fields: ExposedField[] = [];
    for (const [fieldId, vias] of raw.reach) {
      const parts = splitFieldId(fieldId);
      if (parts === null) continue;
      if (objectFilter !== undefined && parts.object !== objectFilter) continue;
      const verdict = await classifyField(fieldId);
      fields.push({
        fieldId,
        objectApiName: parts.object,
        fieldApiName: parts.field,
        classification: verdict.classification,
        category: verdict.category,
        modeled: verdict.modeled,
        via: [...vias].sort(),
        reason: verdict.reason,
      });
      globalFieldClasses.set(fieldId, verdict.classification);
    }

    // Object filter: drop a surface that exposes nothing on the target object.
    if (objectFilter !== undefined && fields.length === 0) continue;

    // Sort pii/sensitive first (so the cap never hides them), then by field id.
    fields.sort((a, b) => {
      if (CLASS_RANK[a.classification] !== CLASS_RANK[b.classification]) {
        return CLASS_RANK[a.classification] - CLASS_RANK[b.classification];
      }
      return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0;
    });
    const fieldsTruncated = fields.length > MAX_FIELDS_PER_SURFACE;
    const keptFields = fields.slice(0, MAX_FIELDS_PER_SURFACE);
    const piiFieldCount = fields.filter((f) => f.classification === 'pii').length;
    const sensitiveFieldCount = fields.filter((f) => f.classification === 'sensitive').length;

    const label = raw.node.label ?? raw.node.apiName;
    surfaces.push({
      id: raw.node.id,
      surfaceType: raw.surfaceType,
      label,
      exposedFields: keptFields,
      exposedFieldCount: fields.length,
      piiFieldCount,
      sensitiveFieldCount,
      fieldsTruncated,
    });

    for (const f of fields) {
      if (f.classification === 'pii' || f.classification === 'sensitive') {
        piiExposures.push({
          surfaceId: raw.node.id,
          surfaceType: raw.surfaceType,
          surfaceLabel: label,
          fieldId: f.fieldId,
          objectApiName: f.objectApiName,
          fieldApiName: f.fieldApiName,
          classification: f.classification,
          category: f.category,
          via: f.via,
          reason: f.reason,
        });
      }
    }
  }

  // Sort: surfaces with the most PII first, then sensitive, then id.
  surfaces.sort((a, b) => {
    if (a.piiFieldCount !== b.piiFieldCount) return b.piiFieldCount - a.piiFieldCount;
    if (a.sensitiveFieldCount !== b.sensitiveFieldCount) return b.sensitiveFieldCount - a.sensitiveFieldCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  piiExposures.sort((a, b) => {
    if (CLASS_RANK[a.classification] !== CLASS_RANK[b.classification]) {
      return CLASS_RANK[a.classification] - CLASS_RANK[b.classification];
    }
    if (a.surfaceId !== b.surfaceId) return a.surfaceId < b.surfaceId ? -1 : 1;
    return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0;
  });

  // --- Summary counts over the FULL (pre-pagination) sets. ---
  const fieldsExposed = globalFieldClasses.size;
  const piiFieldsExposed = [...globalFieldClasses.values()].filter((c) => c === 'pii').length;
  const sensitiveFieldsExposed = [...globalFieldClasses.values()].filter((c) => c === 'sensitive').length;
  const surfacesWithFieldExposure = surfaces.filter((s) => s.exposedFieldCount > 0).length;

  // --- Byte-budget + limit the two lists (no resumable cursor exposed — the
  // input contract is just { objectApiName?, limit? }; a truncated list tells
  // the caller to narrow by object or raise `limit`). ---
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const binding: PaginateBinding = {
    tool: TOOL_NAME,
    vaultHash: ctx.manifest.sourceTreeHash,
    argsFingerprint: argsFingerprint(objectFilter !== undefined ? { objectApiName: objectFilter } : {}),
  };
  const surfacesPage = paginate(surfaces, { limit, binding });
  const piiPage = paginate(piiExposures, { limit, binding });
  const surfacesTruncated = surfacesPage.pageInfo.hasMore || surfacesPage.byteTrimmed;
  const piiExposuresTruncated = piiPage.pageInfo.hasMore || piiPage.byteTrimmed;

  const boundaries = [...STATIC_BOUNDARIES];
  if (surfacesTruncated) {
    boundaries.push(
      `Surfaces truncated to ${surfacesPage.items.length} of ${surfaces.length} — raise \`limit\` (max ${MAX_LIMIT}) or filter by \`objectApiName\` to see more.`,
    );
  }
  if (piiExposuresTruncated) {
    boundaries.push(
      `PII exposures truncated to ${piiPage.items.length} of ${piiExposures.length} — raise \`limit\` (max ${MAX_LIMIT}) to see more.`,
    );
  }

  const anyUnknown = [...verdictCache.values()].some((v) => !v.modeled);
  const completeness: TrustSummary['completeness'] = anyUnknown
    ? {
        status: 'partial',
        missingCoverage: [
          'One or more exposed fields are standard fields / fields on objects the vault did not field-enrich — classified `unknown`, not "not PII".',
        ],
      }
    : {
        status: 'partial',
        missingCoverage: [
          'Runtime agent behaviour and Bot dialog/intent message trees are out of scope — only declared context-variable fields and planner-action field reach are composed.',
        ],
      };

  return ok({
    data: {
      scope,
      disposition: 'ai-surface-modeled',
      surfaces: surfacesPage.items,
      piiExposures: piiPage.items,
      summary: {
        promptTemplates: promptTemplates.length,
        functions: functions.length,
        plugins: plugins.length,
        plannerBundles: plannerBundles.length,
        bots: bots.length,
        surfacesWithFieldExposure,
        fieldsExposed,
        piiFieldsExposed,
        sensitiveFieldsExposed,
        surfacesTruncated,
        piiExposuresTruncated,
      },
      boundaries,
      trust: offlineTrust(ctx, completeness),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
