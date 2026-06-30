/**
 * sfi.route_question — the conversational front door.
 *
 * Takes a plain-language question and returns the plane (`vault`/`live`/
 * `hybrid`/`unknown`) and ordered `sfi.*` tools that answer it, so a host can
 * route without the user ever typing a tool name. Read-only; it suggests a
 * route, it does not answer. When the question hits a gap (no good tool yet) it
 * surfaces the gap rather than fabricating a capability; the question text is
 * appended to the local backlog only when the caller explicitly passes
 * `logGap: true` (privacy-first opt-in, off by default — CR-16).
 */

import { createHash } from 'node:crypto';

import type {
  ComponentType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { resolveComponents, type ResolveResult } from '@sf-intelligence/graph';
import { z } from 'zod';

import { renderRouteMarkdown } from '../answer-render.js';
import {
  classifyQuestion,
  logGapIfAny,
  routeForSelectedIntent,
  type RouteResult,
} from '../intent-router.js';
import { semanticCandidates, type ToolCandidate } from '../semantic-funnel.js';
import type { Context } from '../server.js';

import { resolveGlossaryAlias } from './resolve.js';
import { CORE_PROFILE_TOOLS, toolProfile } from './tool-profile.js';

/**
 * Max token count for the bare-component resolve fallback. A short phrase the
 * pure router can't route ("payment object", "evaluation status") is often a
 * component the user named without asking a question. A full out-of-scope
 * sentence ("what do my users think of the UI") runs long, so the token cap is
 * the first, cheap gate BEFORE any vault I/O — it keeps the fallback off the
 * hot path for normal questions and out of reach of wordy nonsense.
 *
 * Capped at 3: a bare component reference is short ("payment object",
 * "evaluation status", "the status picklist" are all ≤3). At 4+, the fuzzy
 * resolver starts returning `ambiguous` for out-of-scope noise ("query my
 * MongoDB collections", "xyzzy quantum flibbertigibbet metadata") — so the cap,
 * not just the resolve gate, is load-bearing for keeping nonsense `unknown`.
 */
const RESOLVE_FALLBACK_MAX_TOKENS = 3;

/**
 * Vault-gated rescue for an `unrouted` route: if the question is a SHORT phrase
 * that resolves to a real vault component (disposition exact|ambiguous), route
 * it to `sfi.resolve` on the vault plane instead of a dead `unknown`. Gated
 * tight on BOTH the token cap AND a confident resolve so genuinely
 * out-of-scope phrases (which resolve to `none`) stay `unknown`. Returns the
 * upgraded route, or null to keep the original. Best-effort: a resolver error
 * never changes the route.
 */
const tryResolveFallback = async (
  ctx: Context,
  question: string,
): Promise<RouteResult | null> => {
  const tokens = question.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > RESOLVE_FALLBACK_MAX_TOKENS) {
    return null;
  }
  const result = await resolveComponents(ctx.graph, question, { limit: 5 });
  if (!result.ok) return null;
  const { disposition, candidates } = result.value;
  if (
    (disposition !== 'exact' && disposition !== 'ambiguous') ||
    candidates.length === 0
  ) {
    return null;
  }
  return {
    question,
    plane: 'vault',
    intent: 'component-lookup',
    tools: ['sfi.resolve'],
    liveRequired: false,
    needsResolve: true,
    reason:
      `Names a component (resolve disposition: ${disposition}) but asks nothing ` +
      `specific yet. Resolve it, then pick the analysis you want.`,
    gap: null,
    confidence: disposition === 'exact' ? 'high' : 'low',
    risk: 'informational',
    alternatives: [],
    clarification:
      disposition === 'ambiguous'
        ? {
            required: true,
            question: 'Several components match. Which component did you mean?',
            options: candidates.slice(0, 5).map((candidate) => candidate.id),
          }
        : null,
    plan: [{
      stepId: 'step-1',
      dependsOn: [],
      question,
      intent: 'component-lookup',
      plane: 'vault',
      tools: ['sfi.resolve'],
    }],
    suggestedArgs: { query: question },
  };
};

export const routeQuestionInputSchema = z.object({
  /** The user's plain-language question. */
  question: z.string().min(1),
  /**
   * Opt in to appending a gap entry to the local backlog when the route has
   * one. Privacy-first default false — the question text is written to disk only
   * when this is explicitly true (CR-16).
   */
  logGap: z.boolean().optional(),
  /**
   * Stateless response to a clarification previously returned for this exact
   * question and vault state. Both values must match the offered challenge.
   */
  clarificationResponse: z.object({
    clarificationId: z.string().min(1),
    selection: z.string().min(1),
  }).optional(),
  /**
   * CAE-04 output mode — shapes how the host LLM should answer and which candidate
   * tools to favor. 'ask' = a quick grounded answer (the default behavior);
   * 'plan' = an ordered change plan (favors the what_if_* / impact tools);
   * 'assessment' = a full evaluation (favors the *_risk_report / readiness /
   * coverage tools). When set, toolCandidates + a mode-specific guidance line are
   * always attached, regardless of the deterministic route's confidence.
   */
  mode: z.enum(['ask', 'plan', 'assessment']).optional(),
});

export type RouteQuestionInput = z.infer<typeof routeQuestionInputSchema>;

/** One executable call for a routed tool (P13-GW-router-envelope). */
export interface RouteInvocation {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface RouteQuestionOutput {
  readonly route: RouteResult;
  /** True when the client must ask route.clarification before executing tools. */
  readonly executionBlocked: boolean;
  /** Vault-backed evidence about the named entity, when resolution was useful. */
  readonly entityEvidence?: {
    /** Narrow phrase sent to the resolver; never the whole question. */
    readonly query: string;
    /** Route-derived type constraints used to prevent cross-type fuzzy noise. */
    readonly typeHints: readonly ComponentType[];
    readonly disposition: 'exact' | 'ambiguous' | 'none';
    /** Whether candidate competition is strong enough that execution must stop. */
    readonly clarificationRequired: boolean;
    /** Non-blocking warning when matches are weak rather than truly competitive. */
    readonly warning: string | null;
    /** Canonical entity explicitly selected through clarification continuation. */
    readonly selectedComponentId?: string;
    readonly candidates: readonly {
      readonly componentId: string;
      readonly type: string;
      readonly apiName: string;
      readonly label: string | null;
      readonly parentApiName: string | null;
      readonly score: number;
      readonly base: number;
      readonly matchKind: 'exact' | 'substring' | 'fuzzy' | 'glossary-alias';
      readonly evidence: string;
    }[];
  };
  /** Present after a validated clarification response deterministically resumes routing. */
  readonly clarificationResolution?: {
    readonly clarificationId: string;
    readonly selection: string;
    readonly kind: 'intent' | 'entity';
  };
  readonly gapLogged: boolean;
  readonly rendered: string;
  readonly trust: TrustSummary;
  /**
   * Present ONLY when the server runs `SFI_TOOL_PROFILE=core`: the routed
   * tools expressed as executable calls — core-roster tools directly, every
   * other tool as the catalog-gateway envelope
   * `{ tool: 'sfi.run_analysis', args: { name, args } }` (byte-identical
   * output to a direct call), with the route's `suggestedArgs` threaded to
   * the primary tool. Under the default full profile this field is absent
   * and the response is unchanged.
   */
  readonly invoke?: readonly RouteInvocation[];
  /**
   * CAE-03b semantic FUNNEL (PRIMARY in the default hybrid mode): meaning-ranked
   * candidate tools the host LLM chooses from. Present for EVERY routable question
   * — the regex `route` is demoted to a non-authoritative hint. Omitted only when
   * the funnel finds nothing (gibberish) or under `SFI_ROUTER_MODE=offline`, where
   * the deterministic route is authoritative (Design A). Offline TF-IDF over the
   * capability map; no neural model, no network.
   */
  readonly toolCandidates?: readonly ToolCandidate[];
  /**
   * CAE-02 planner contract: present alongside `toolCandidates`. States the loop
   * the host LLM owns — the candidates are primary, the LLM decides: read question →
   * `sfi.resolve` named components → pick/sequence tools from the candidates →
   * run → `sfi.synthesize_answer` grounds.
   */
  readonly guidance?: string;
}

const routeTrust = (): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'heuristic',
  freshness: {},
  completeness: { status: 'complete' },
  limitations: [
    'In the default hybrid mode the meaning-ranked toolCandidates are PRIMARY and the host LLM decides which to run; the deterministic route is a non-authoritative hint, not the answer (SFI_ROUTER_MODE=offline makes the route authoritative for no-LLM hosts). A short phrase that merely names a real vault component is rescued to sfi.resolve so that path also consults the vault. Resolve any named component and confirm the plane before trusting an answer.',
  ],
});

const clarificationIdFor = (
  sourceTreeHash: string,
  route: RouteResult,
): string | null => {
  const clarification = route.clarification;
  if (clarification?.required !== true) return null;
  return createHash('sha256')
    .update(JSON.stringify({
      sourceTreeHash,
      question: route.question,
      prompt: clarification.question,
      options: clarification.options,
    }))
    .digest('hex')
    .slice(0, 24);
};

/**
 * Bind a canonical entity selected through clarification to the primary
 * analysis. Keep this explicit: emitting a guessed argument key would turn a
 * successful clarification into an executable-looking but invalid call.
 */
const selectedEntityArgsForRoute = (
  route: RouteResult,
  componentId: string,
): Readonly<Record<string, unknown>> | null => {
  if (
    route.intent === 'field-access' ||
    route.intent === 'safe-to-delete' ||
    route.intent === 'what-if-field' ||
    route.intent === 'field-360' ||
    route.intent === 'field-lineage' ||
    route.intent === 'explain-field'
  ) {
    return { ...(route.suggestedArgs ?? {}), fieldId: componentId };
  }
  if (route.intent === 'impact-analysis' || route.intent === 'component-lookup') {
    return { ...(route.suggestedArgs ?? {}), componentId };
  }
  if (route.intent === 'component-usage') {
    return { ...(route.suggestedArgs ?? {}), componentId };
  }
  if (
    route.intent === 'object-access' ||
    route.intent === 'who-can-access-object' ||
    route.intent === 'automation-on-object'
  ) {
    const objectComponentId = componentId.startsWith('CustomObject:')
      ? componentId
      : `CustomObject:${componentId}`;
    if (route.intent === 'automation-on-object') {
      const apiName = objectComponentId.slice('CustomObject:'.length);
      return { ...(route.suggestedArgs ?? {}), objectApiName: apiName };
    }
    return { ...(route.suggestedArgs ?? {}), componentId: objectComponentId };
  }
  return null;
};

/**
 * Resolve only a bounded component phrase. Sending the full natural-language
 * question to the fuzzy resolver creates false ambiguity from action words
 * such as "what", "change", and "access".
 */
const extractEntityQuery = (question: string, intent: string): string | null => {
  const apiReference = question.match(
    /\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)\b|\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x|b|kav)\b/,
  )?.[0];
  if (apiReference !== undefined) {
    if (intent === 'what-if-method-signature' && apiReference.includes('.')) {
      return `${apiReference.slice(0, apiReference.indexOf('.'))} class`;
    }
    return apiReference;
  }

  const prefixedTypePhrase = question.match(
    /\b((?:validation\s+rule|permission\s+set|record\s+type|page\s+layout|object|field|flow|class|trigger|layout|profile|report|dashboard)\s+(?:named\s+)?[A-Z][A-Za-z0-9_]*(?:\s+[A-Z][A-Za-z0-9_]*){0,5})\b/,
  )?.[1];
  if (prefixedTypePhrase !== undefined) return prefixedTypePhrase.trim();

  const typedMatch = question.match(
    /\b(?:the\s+)?([A-Za-z][A-Za-z0-9_]*(?:[\s_-]+[A-Za-z][A-Za-z0-9_]*){0,5}\s+(?:object|field|flow|class|trigger|layout|profile|permission\s+set|record\s+type|validation\s+rule|report|dashboard))(?:\s+(?:on|for|of)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_]*)(?:\s+object)?)?\b/i,
  );
  const typedPhrase = typedMatch?.[1];
  if (typedPhrase === undefined) return null;
  const cleaned = typedPhrase
    .replace(
      /^(?:(?:what|which|who|where|when|why|how|is|are|can|does|do|did|show|find|explain|locate|list|references?|owns?|edit|read|view|access|change|delete|remove|possible|values?|api|version|data|type|for|of|the|this|that|in|on|to|used|assigned|set)\s+)+/i,
      '',
    )
    .trim();
  if (
    /\b(?:and|when|should|use|there|any|that|no|available|tools?|required\s+fields?|record\s+types?)\b/i.test(cleaned)
  ) return null;
  const distinctive = cleaned
    .replace(
      /\b(?:object|field|flow|class|trigger|page|layout|profile|permission|set|record|type|validation|rule|report|dashboard|data)\b/gi,
      '',
    )
    .replace(/[^A-Za-z0-9_]+/g, '');
  if (distinctive.length === 0) return null;
  const parent = typedMatch?.[2];
  return parent === undefined ? cleaned : `${cleaned} on ${parent}`;
};

const inferEntityTypes = (
  query: string,
  intent: string,
  question: string,
): readonly ComponentType[] => {
  if (intent === 'what-if-method-signature') return ['ApexClass'];
  if (/\bfield\b/i.test(question)) return ['CustomField'];
  if (query.includes('.') && !/\sclass$/i.test(query)) return ['CustomField'];
  if (/__(?:mdt|e|x|b|kav)$/i.test(query) || /(?:^object\s|\sobject(?:\s+on\s+\w+)?$)/i.test(query)) return ['CustomObject'];
  if (/(?:^field\s|\sfield(?:\s+on\s+\w+)?$)/i.test(query)) return ['CustomField'];
  if (/(?:^flow\s|\sflow$)/i.test(query)) return ['Flow'];
  if (/(?:^class\s|\sclass$)/i.test(query)) return ['ApexClass'];
  if (/(?:^trigger\s|\strigger$)/i.test(query)) return ['ApexTrigger'];
  if (/(?:^(?:page\s+)?layout\s|\s(?:page\s+)?layout(?:\s+on\s+\w+)?$)/i.test(query)) return ['Layout'];
  if (/(?:^profile\s|\sprofile$)/i.test(query)) return ['Profile'];
  if (/(?:^permission\s+set\s|\spermission\s+set$)/i.test(query)) return ['PermissionSet'];
  if (/(?:^record\s+type\s|\srecord\s+type$)/i.test(query)) return ['RecordType'];
  if (/(?:^validation\s+rule\s|\svalidation\s+rule$)/i.test(query)) return ['ValidationRule'];
  if (/(?:^report\s|\sreport$)/i.test(query)) return ['Report'];
  if (/(?:^dashboard\s|\sdashboard$)/i.test(query)) return ['Dashboard'];
  return [];
};

/**
 * The fuzzy resolver deliberately returns `ambiguous` when nearby names are
 * plausible. A unique literal API/canonical-id match is stronger evidence and
 * is safe for the router to treat as exact.
 */
const refineEntityResolution = (query: string, resolution: ResolveResult): ResolveResult => {
  if (resolution.disposition !== 'ambiguous') return resolution;
  const normalized = query.toLowerCase();
  const exactApi = resolution.candidates.filter((candidate) =>
    candidate.apiName.toLowerCase() === normalized ||
    candidate.id.toLowerCase().endsWith(`:${normalized}`)
  );
  const parentQualified = query.match(/^(.+?)\s+field\s+on\s+([A-Za-z][A-Za-z0-9_]*)$/i);
  const normalizedName = parentQualified?.[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const normalizedParent = parentQualified?.[2]?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const exactParentField =
    normalizedName === undefined || normalizedParent === undefined
      ? []
      : resolution.candidates.filter((candidate) =>
          candidate.type === 'CustomField' &&
          candidate.apiName.replace(/__[a-z]+$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase() === normalizedName &&
          candidate.parentApiName?.replace(/[^a-z0-9]/gi, '').toLowerCase() === normalizedParent
        );
  const exact = exactParentField.length === 1 ? exactParentField : exactApi;
  if (exact.length !== 1) return resolution;
  const winner = exact[0]!;
  return {
    ...resolution,
    disposition: 'exact',
    candidates: [winner, ...resolution.candidates.filter((candidate) => candidate.id !== winner.id)],
  };
};

/**
 * Keep route_question's entity evidence consistent with sfi.resolve: confirmed
 * org glossary aliases may rescue a non-exact graph resolution, but never
 * shadow an exact API-name match. Multiple curated targets remain ambiguous.
 */
const applyGlossaryAliases = async (
  ctx: Context,
  query: string,
  types: readonly ComponentType[],
  resolution: ResolveResult,
): Promise<ResolveResult> => {
  if (resolution.disposition === 'exact') return resolution;
  const aliases = await resolveGlossaryAlias(ctx, query, types);
  if (aliases.length === 0) return resolution;
  const aliasIds = new Set(aliases.map((candidate) => candidate.componentId));
  return {
    ...resolution,
    disposition: aliases.length === 1 ? 'exact' : 'ambiguous',
    candidates: [
      ...aliases.map((candidate) => ({
        id: candidate.componentId,
        type: candidate.type,
        apiName: candidate.apiName,
        label: candidate.label,
        parentApiName: candidate.parentApiName,
        score: candidate.score,
        base: candidate.base,
        matchKind: 'exact' as const,
        evidence: candidate.evidence,
      })),
      ...resolution.candidates.filter((candidate) => !aliasIds.has(candidate.id)),
    ],
  };
};

const entityAmbiguityRequiresClarification = (
  query: string,
  resolution: ResolveResult,
): boolean => {
  if (resolution.disposition !== 'ambiguous' || resolution.candidates.length < 2) return false;
  const normalized = query.toLowerCase();
  const literalMatches = resolution.candidates.filter((candidate) =>
    candidate.apiName.toLowerCase() === normalized ||
    candidate.id.toLowerCase().endsWith(`:${normalized}`)
  );
  if (literalMatches.length > 1) return true;
  if (/[A-Za-z0-9_]__(?:c|mdt|e|x|b|kav)\b|\w+\.\w+/.test(query)) return false;
  const [top, second] = resolution.candidates;
  return top!.base >= 0.92 && second!.base >= 0.92 && second!.score >= top!.score * 0.97;
};

interface CompoundClause {
  readonly question: string;
  readonly dependsOnPrevious: boolean;
}

/**
 * Preserve sequencing language while splitting a compound question. Semicolon,
 * question-mark, and "and <question>" boundaries are independent; "then" and
 * "and then" make the next clause depend on the previous routed step.
 */
const splitCompoundQuestion = (question: string): readonly CompoundClause[] => {
  const parts = question.split(
    /(\?|;|\band\s+then\b|\bthen\b|\band\s+(?=who|what|which|how|where|when|why|is|are|can|should|does|do)\b)/i,
  );
  const clauses: CompoundClause[] = [];
  let dependsOnPrevious = false;
  for (const part of parts) {
    const trimmed = part.trim().replace(/^[,\s]+|[,\s]+$/g, '');
    if (trimmed.length === 0) continue;
    if (/^(?:\?|;|and\s+then|then|and)$/i.test(trimmed)) {
      dependsOnPrevious = /then/i.test(trimmed);
      continue;
    }
    clauses.push({ question: trimmed, dependsOnPrevious });
    dependsOnPrevious = false;
  }
  return clauses;
};

/**
 * Some compound questions carry their subject into an elliptical second
 * clause. Treat the bounded "how many objects ... how many records each"
 * shape as an inventory + per-object live-count plan; routing "records each
 * hold" as a generic live_count would require the caller to invent an object.
 */
const mixedInventoryAndStoragePlan = (
  question: string,
): ReadonlyArray<RouteResult['plan'][number]> | null => {
  if (
    !/\bhow\s+many\b[^?;]*\b(?:custom\s+)?objects?\b[^?;]*\band\b[^?;]*\bhow\s+many\s+(?:records?|rows?)\b[^?;]*\b(?:each|per\s+object|those\s+objects?)\b/i.test(
      question,
    )
  ) {
    return null;
  }
  const inventory = classifyQuestion('How many custom objects do we have?');
  const storage = classifyQuestion('What are the record counts per object?');
  if (inventory.intent !== 'metadata-count' || storage.intent !== 'storage-by-object') {
    return null;
  }
  return [
    {
      stepId: 'step-1',
      dependsOn: [],
      question: inventory.question,
      intent: inventory.intent,
      plane: inventory.plane,
      tools: ['sfi.list_components'],
    },
    {
      stepId: 'step-2',
      dependsOn: [],
      question: storage.question,
      intent: storage.intent,
      plane: storage.plane,
      tools: storage.tools,
    },
  ];
};

/** CAE-04: the tool families each output mode favors when reranking the funnel. */
const PLAN_FAMILY = /^sfi\.(what_if_|get_impact|safe_to_delete|downstream_effects|tests_for_change|field_lineage)/;
const ASSESSMENT_FAMILY =
  /(_risk_report$|^sfi\.release_readiness|^sfi\.promotion_readiness|^sfi\.coverage_report|^sfi\.tech_debt_score|^sfi\.governor_limit_risks|^sfi\.crud_fls_audit)/;

/** Stable-rerank the funnel candidates so the requested mode's family leads. */
const rerankForMode = (
  cands: readonly ToolCandidate[],
  mode: RouteQuestionInput['mode'],
): ToolCandidate[] => {
  if (mode === undefined || mode === 'ask') return cands.slice(0, 8);
  const fam = mode === 'plan' ? PLAN_FAMILY : ASSESSMENT_FAMILY;
  const lead = cands.filter((c) => fam.test(c.tool));
  const rest = cands.filter((c) => !fam.test(c.tool));
  return [...lead, ...rest].slice(0, 8);
};

/** CAE-02/04: the planner contract, tailored to the requested output mode. */
const guidanceForMode = (mode: RouteQuestionInput['mode']): string => {
  const tail =
    ' The candidates are an advisory shortlist, not a route — YOU pick. Resolve any ' +
    'named component first, ground the final answer with sfi.synthesize_answer, and ' +
    'never answer from a tool name alone.';
  switch (mode) {
    case 'plan':
      return (
        'PLAN mode: produce an ORDERED change plan. Favor the what_if_* / get_impact / ' +
        'safe_to_delete candidates, sequence them by dependency, and present numbered steps, ' +
        'each with its risk.' + tail
      );
    case 'assessment':
      return (
        'ASSESSMENT mode: produce a full EVALUATION. Favor the *_risk_report / readiness / ' +
        'coverage candidates, run them, and present findings with severity + recommended actions.' +
        tail
      );
    case 'ask':
      return (
        'ASK mode: answer concisely. Pick the candidate(s) that most directly answer, run ' +
        'them, and synthesize ONE short grounded answer.' + tail
      );
    default:
      return (
        'These toolCandidates are the meaning-ranked shortlist — they are PRIMARY and YOU decide. ' +
        'A deterministic `route` is also attached, but only as a HINT (a suggested tool order plus ' +
        'any resolved entity ids / suggestedArgs) — never follow it blindly. Plan: read the question → ' +
        'resolve any named component with sfi.resolve → pick the tool(s) to run from the candidates ' +
        '(sequence them if compound) → run them → ground the answer with sfi.synthesize_answer. ' +
        'Never answer from a tool name alone.'
      );
  }
};

/**
 * CAE-03b router mode. The default `hybrid` is Design B: the semantic FUNNEL is
 * primary — every routable question carries candidates + guidance and the host
 * LLM decides; the regex route rides along only as a non-authoritative hint.
 * `SFI_ROUTER_MODE=offline` restores the deterministic Design A route (regex
 * authoritative, no candidates, no guidance) for no-LLM / CI / air-gapped hosts.
 * The regex engine is never deleted — it is the offline fallback and the hint.
 */
type RouterMode = 'hybrid' | 'offline';
const routerMode = (): RouterMode =>
  (process.env.SFI_ROUTER_MODE ?? '').trim().toLowerCase() === 'offline' ? 'offline' : 'hybrid';

export const routeQuestionHandler = async (
  ctx: Context,
  input: RouteQuestionInput,
): Promise<Result<McpResponse<RouteQuestionOutput>, McpError>> => {
  let route = classifyQuestion(input.question);
  // A short phrase the pure router couldn't place may still name a real
  // component — rescue it to sfi.resolve when (and only when) it resolves.
  if (route.plane === 'unknown' && route.intent === 'unrouted') {
    const upgraded = await tryResolveFallback(ctx, input.question);
    if (upgraded !== null) route = upgraded;
  }
  const clauses = splitCompoundQuestion(input.question);
  if (clauses.length > 1) {
    const clauseRoutes = clauses.map((clause) => ({
      clause,
      route: classifyQuestion(clause.question),
    }));
    const steps: RouteResult['plan'][number][] = [];
    for (const { clause, route: step } of clauseRoutes) {
      if (
        step.plane === 'unknown' ||
        steps.some((candidate) => candidate.intent === step.intent)
      ) continue;
      const previous = steps.at(-1);
      steps.push({
        stepId: `step-${steps.length + 1}`,
        dependsOn:
          clause.dependsOnPrevious && previous !== undefined
            ? [previous.stepId]
            : [],
        question: step.question,
        intent: step.intent,
        plane: step.plane,
        tools: step.tools,
      });
    }
    if (steps.length > 1) {
      const ambiguousStep = clauseRoutes
        .map(({ route: step }) => step)
        .find((step) => step.clarification?.required === true);
      route = {
        ...route,
        plan: steps,
        confidence: ambiguousStep === undefined ? 'high' : 'low',
        alternatives: ambiguousStep?.alternatives ?? [],
        clarification: ambiguousStep?.clarification ?? null,
      };
    }
  }
  const mixedPlan = mixedInventoryAndStoragePlan(input.question);
  if (mixedPlan !== null) {
    route = {
      ...route,
      plane: 'hybrid',
      tools: [...new Set(mixedPlan.flatMap((step) => step.tools))],
      liveRequired: true,
      reason:
        'This asks for both vault metadata inventory and live record counts per object, so both planes are required.',
      confidence: 'high',
      alternatives: [],
      clarification: null,
      plan: mixedPlan,
      suggestedArgs: { type: 'CustomObject' },
    };
  }
  const entityQuery = route.needsResolve ? extractEntityQuery(input.question, route.intent) : null;
  const entityTypes =
    entityQuery === null ? [] : inferEntityTypes(entityQuery, route.intent, input.question);
  const entityResolution = entityQuery !== null
    ? await resolveComponents(ctx.graph, entityQuery, {
        limit: 5,
        ...(entityTypes.length > 0 ? { types: entityTypes } : {}),
      })
    : null;
  const glossaryAwareEntityResolution =
    entityQuery !== null && entityResolution?.ok === true
      ? await applyGlossaryAliases(ctx, entityQuery, entityTypes, entityResolution.value)
      : null;
  const refinedEntityResolution =
    entityQuery !== null && glossaryAwareEntityResolution !== null
      ? refineEntityResolution(entityQuery, glossaryAwareEntityResolution)
      : null;
  const entityClarificationRequired =
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    entityAmbiguityRequiresClarification(entityQuery, refinedEntityResolution);
  let entityEvidence: RouteQuestionOutput['entityEvidence'] =
    refinedEntityResolution !== null && refinedEntityResolution.disposition !== 'none'
      ? {
          query: entityQuery as string,
          typeHints: entityTypes,
          disposition: refinedEntityResolution.disposition,
          clarificationRequired: entityClarificationRequired,
          warning:
            refinedEntityResolution.disposition === 'ambiguous' && !entityClarificationRequired
              ? 'Possible component matches were found, but none is strong enough to interrupt routing. Resolve the component before executing a component-specific analysis.'
              : null,
          candidates: refinedEntityResolution.candidates.slice(0, 5).map((candidate) => ({
            componentId: candidate.id,
            type: candidate.type,
            apiName: candidate.apiName,
            label: candidate.label,
            parentApiName: candidate.parentApiName,
            score: candidate.score,
            base: candidate.base,
            matchKind: candidate.evidence.startsWith('glossary-alias:')
              ? 'glossary-alias' as const
              : candidate.matchKind,
            evidence: candidate.evidence,
          })),
        }
      : undefined;
  if (
    entityClarificationRequired &&
    route.clarification === null
  ) {
    route = {
      ...route,
      confidence: 'low',
      clarification: {
        required: true,
        question: 'Several components match the named entity. Which component did you mean?',
        options: entityEvidence?.candidates.map((candidate) => candidate.componentId) ?? [],
      },
    };
  } else if (
    entityEvidence?.disposition === 'ambiguous' &&
    route.clarification === null
  ) {
    route = { ...route, confidence: 'medium' };
  }

  const clarificationId = clarificationIdFor(ctx.manifest.sourceTreeHash, route);
  if (clarificationId !== null && route.clarification !== null) {
    route = {
      ...route,
      clarification: { ...route.clarification, id: clarificationId },
    };
  }

  let clarificationResolution: RouteQuestionOutput['clarificationResolution'];
  const response = input.clarificationResponse;
  if (response !== undefined) {
    if (route.clarification?.required !== true || clarificationId === null) {
      return err({
        kind: 'invalid-query',
        message:
          'clarificationResponse was supplied, but this question has no active clarification challenge. Route the question again without a response.',
        path: 'clarificationResponse',
      });
    }
    if (response.clarificationId !== clarificationId) {
      return err({
        kind: 'invalid-query',
        message:
          'clarificationResponse.clarificationId is stale or does not belong to this exact question and vault state. Route the question again and use the newly offered challenge.',
        path: 'clarificationResponse.clarificationId',
      });
    }
    if (!route.clarification.options.includes(response.selection)) {
      return err({
        kind: 'invalid-query',
        message:
          `clarificationResponse.selection must be one of the offered options: ${route.clarification.options.join(', ')}`,
        path: 'clarificationResponse.selection',
      });
    }

    const selectedIntent = [route.intent, ...route.alternatives.map((alternative) => alternative.intent)]
      .includes(response.selection);
    if (selectedIntent) {
      const selectedRoute = routeForSelectedIntent(input.question, response.selection);
      if (selectedRoute === null) {
        return err({
          kind: 'invalid-query',
          message: `The selected intent '${response.selection}' is no longer routable. Route the question again.`,
          path: 'clarificationResponse.selection',
        });
      }
      route = selectedRoute;
      clarificationResolution = {
        clarificationId,
        selection: response.selection,
        kind: 'intent',
      };
    } else {
      const selectedArgs = selectedEntityArgsForRoute(route, response.selection);
      if (selectedArgs === null) {
        return err({
          kind: 'invalid-query',
          message:
            `The selected entity is valid, but intent '${route.intent}' has no deterministic entity-to-tool argument binding yet. Route the question again without a response.`,
          path: 'clarificationResponse.selection',
        });
      }
      route = {
        ...route,
        confidence: 'high',
        needsResolve: false,
        clarification: null,
        tools: route.tools.filter((tool) => tool !== 'sfi.resolve'),
        suggestedArgs: selectedArgs,
      };
      entityEvidence = entityEvidence === undefined
        ? undefined
        : {
            ...entityEvidence,
            clarificationRequired: false,
            selectedComponentId: response.selection,
          };
      clarificationResolution = {
        clarificationId,
        selection: response.selection,
        kind: 'entity',
      };
    }
  }

  const executionBlocked = route.clarification?.required === true;
  // Stamp the gap with this server's vault so `feedback export` can scope to
  // the current vault by default (P14-FEEDBACK-gaplog-scope).
  const logged =
    input.logGap === true ? await logGapIfAny(route, undefined, ctx.vaultRoot) : null;
  // P13-GW-router-envelope: under the core profile the client only holds 18
  // schemas, so the route also carries EXECUTABLE calls — gateway envelopes
  // for non-core tools (run_analysis is byte-identical to a direct call).
  // suggestedArgs belong to the PRIMARY ANSWERING tool — the first tool that
  // is not the resolve preamble (or the sole tool, e.g. component-lookup).
  const primaryIdx = (() => {
    const i = route.tools.findIndex((t) => t !== 'sfi.resolve');
    return i === -1 ? 0 : i;
  })();
  const invoke =
    toolProfile() === 'core' && !executionBlocked
      ? route.tools.map((tool, i): RouteInvocation => {
          const args = i === primaryIdx ? (route.suggestedArgs ?? {}) : {};
          return CORE_PROFILE_TOOLS.has(tool)
            ? { tool, args }
            : { tool: 'sfi.run_analysis', args: { name: tool, args } };
        })
      : undefined;
  // CAE-03b semantic funnel is PRIMARY: in the default HYBRID mode, surface the
  // meaning-ranked candidates + guidance for EVERY routable question and let the
  // host LLM decide — the regex `route` rides along only as a non-authoritative
  // hint. SFI_ROUTER_MODE=offline suppresses candidates and returns the
  // deterministic route alone (Design A, for no-LLM / CI / air-gapped hosts).
  // Offline TF-IDF over the capability map; a mode reranks toward its family.
  const wantCandidates = routerMode() === 'hybrid';
  const toolCandidates = wantCandidates
    ? rerankForMode(
        semanticCandidates(input.question, input.mode !== undefined ? 12 : 8),
        input.mode,
      )
    : [];
  const guidance = toolCandidates.length > 0 ? guidanceForMode(input.mode) : undefined;
  return ok({
    data: {
      route,
      executionBlocked,
      ...(entityEvidence !== undefined ? { entityEvidence } : {}),
      ...(clarificationResolution !== undefined ? { clarificationResolution } : {}),
      gapLogged: logged !== null,
      rendered:
        toolCandidates.length > 0
          ? `${renderRouteMarkdown(route)}\n\n**Candidate tools (the shortlist — ranked by meaning; the route above is only a hint). You pick, then run:** ${toolCandidates
              .map((c) => c.tool)
              .join(', ')}`
          : renderRouteMarkdown(route),
      trust: routeTrust(),
      ...(toolCandidates.length > 0 ? { toolCandidates } : {}),
      ...(guidance !== undefined ? { guidance } : {}),
      ...(invoke !== undefined ? { invoke } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
