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
 *
 * Router-v2 P2 additions:
 * - REFUSAL-SHAPE GATES run FIRST, score-independent, in both router modes: a
 *   write imperative (`refused-write`, with a read-side alternative offered),
 *   prompt-injection / record-value exfiltration (`refused-injection`, hard —
 *   candidates and guidance suppressed), unmodeled runtime telemetry
 *   (`honest-gap-runtime`), and non-Salesforce asks (`out-of-scope`). All four
 *   return `tools: []` (never executable) with the disclosure as `reason` and
 *   the structured `route.refusal` field; permission/hypothetical READS ("am I
 *   allowed to…", "what if I delete…") are explicit excluders and route
 *   normally.
 * - FUNNEL-PRIMARY advisory fallback: when no deterministic stage places the
 *   question (unrouted, no clarification, premise clean), a PURE-funnel top
 *   candidate scoring ≥ FUNNEL_PRIMARY_MIN_SCORE upgrades the dead `unrouted`
 *   to intent `funnel-advisory` — top-3 funnel tools, confidence `low` by
 *   construction, reason flagged FUNNEL-DERIVED. Advisory, never authoritative.
 *
 * Router-v2 P5 addition — HOST-PASSED conversation context (`context.previous`,
 * optional): the product is STATELESS — conversation memory belongs to the
 * host, which passes what the previous turn was about per call; nothing is
 * stored server-side. A pronoun/ellipsis follow-up with no entity of its own
 * substitutes `previous.componentId` (exact-id lookup, never fuzzy) and, when
 * still unrouted, inherits `previous.tool` as an advisory `context-continuation`
 * route (confidence capped at `medium`); a re-parameterization follow-up
 * ("what about on Contact?") re-runs `previous.tool` against the new target;
 * an ordinal/descriptor pick against `previous.clarification` re-dispatches
 * through the existing clarification-continuation contract. Refusal gates run
 * BEFORE all context logic; a carried id that no longer resolves premise-flags
 * instead of routing; `context` absent keeps every code path byte-identical;
 * a self-contained question ignores context. When context changes the route,
 * `route.contextApplied` discloses what was substituted/inherited.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, resolveComponents, type ResolveResult } from '@sf-intelligence/graph';
import { findRegistryRoot, listRegisteredVaults } from '@sf-intelligence/vault';
import { z } from 'zod';

import { renderContextApplied, renderRouteMarkdown } from '../answer-render.js';
import {
  continuationToolCompatible,
  detectClarificationSelection,
  detectGapShapedFollowUp,
  detectPronounAnchor,
  detectReparamAnchor,
  extractReparamTarget,
  isAnaphorOnly,
  validatePreviousContext,
  type ValidatedContext,
} from '../context-resolution.js';
import {
  classifyQuestion,
  logGapIfAny,
  routeForSelectedIntent,
  type RouteClarification,
  type RouteContextApplied,
  type RouteResult,
} from '../intent-router.js';
import { detectRefusalShape, type RefusalKind, type RefusalShape } from '../refusal-gates.js';
import {
  getPlaneByTool,
  resolveCandidatePlane,
  semanticCandidates,
  type ToolCandidate,
} from '../semantic-funnel.js';
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
 * Intents whose primary tools (`what_happens_on_save` / `order_of_execution` /
 * automation advisors) take an OBJECT api name. For these, entity resolution
 * targets the object the rule derived — never a fuzzy phrase scraped from the
 * question, where bare schema nouns ("trigger", "flow", "validation rule") are
 * intent vocabulary rather than component names.
 */
const SAVE_ORDER_INTENTS: ReadonlySet<string> = new Set([
  'trigger-order',
  'save-behavior',
  'automation-on-object',
  'dlrs-recursion',
]);

/**
 * Single-entity intents: the question names ONE component to explain/fetch, and
 * a trailing comparison/aside clause ("is it the same as X", "vs Y", "or is it
 * Z") is a rhetorical aside about the SAME answer — not a second component to
 * resolve. RESIDUAL 1: the comparison clause was giving the fuzzy resolver a
 * second name to match, turning a cleanly-routed explain into an ambiguity
 * BLOCK. For these intents the aside is stripped before entity extraction so
 * the primary answer routes clean.
 */
const SINGLE_ENTITY_INTENTS: ReadonlySet<string> = new Set([
  'explain-flow',
  'explain-apex',
  'get-component',
]);

/**
 * Strip a trailing comparison/aside clause from a single-entity question so the
 * comparison TARGET is never scraped as a rival entity. Only removes a clause
 * that starts with an explicit comparison connector ("is it the same as…",
 * "vs…", "versus…", "or is it…", "same as…", "compared to…"), so a normal
 * question is left untouched. Conservative: requires the connector to introduce
 * the FINAL clause, and only fires for SINGLE_ENTITY_INTENTS.
 */
const COMPARISON_ASIDE = new RegExp(
  '\\s*(?:,|—|-|;)?\\s*\\b(?:' +
    'is\\s+(?:it|this|that)\\s+the\\s+same\\s+as|' +
    'is\\s+(?:it|this|that)\\s+different\\s+(?:from|to)|' +
    '(?:the\\s+)?same\\s+as|' +
    'compared\\s+to|' +
    'or\\s+is\\s+(?:it|this|that)|' +
    'vs\\.?|versus' +
    ')\\b.*$',
  'i',
);
const stripComparisonAside = (question: string, intent: string): string => {
  if (!SINGLE_ENTITY_INTENTS.has(intent)) return question;
  const stripped = question.replace(COMPARISON_ASIDE, '').trim();
  return stripped.length > 0 ? stripped : question;
};

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
  // P4 option hygiene on the fallback's pick-one prompt too: fuzzy grazes and
  // far-below-top rivals are junk. When hygiene leaves a SINGLE plausible
  // candidate, the ambiguity was junk-manufactured — resolve to it instead of
  // blocking.
  const hygienicOptions =
    disposition === 'ambiguous'
      ? hygienicClarificationOptions(candidates.slice(0, 5))
      : [];
  const effectivelyExact =
    disposition === 'exact' || hygienicOptions.length === 1;
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
    confidence: effectivelyExact ? 'high' : 'low',
    risk: 'informational',
    alternatives: [],
    clarification:
      disposition === 'ambiguous' && !effectivelyExact
        ? {
            required: true,
            question: 'Several components match. Which component did you mean?',
            options: hygienicOptions.map((candidate) => candidate.id),
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
  /**
   * Router-v2 P5: HOST-PASSED conversation context. The product is STATELESS —
   * conversation memory belongs to the host, which passes what the PREVIOUS
   * turn was about so a terse follow-up ("does it fire on delete too?") can be
   * resolved; nothing is stored server-side. `context` absent ⇒ every code
   * path is byte-identical to a call without the feature. Value validation is
   * FAIL-OPEN (an unregistered `tool` / malformed `componentId` is ignored and
   * noted in `contextApplied.ignored`); shape errors reject normally. Context
   * strings are NEVER treated as question text — `previous.question` is only
   * ever re-dispatched through the full handler (refusal gates included) for
   * clarification continuation. A self-contained question IGNORES context.
   */
  context: z.object({
    previous: z.object({
      /** Canonical id the prior answer was about, e.g. "Flow:Order_Sync". */
      componentId: z.string().min(1).max(256).optional(),
      /** Object api name in focus last turn, e.g. "Contact". */
      objectApiName: z.string().min(1).max(256).optional(),
      /** sfi.* tool that produced the prior answer. */
      tool: z.string().regex(/^sfi\.[a-z0-9_]+$/).optional(),
      /** route.intent of the prior turn (advisory only). */
      intent: z.string().min(1).max(64).optional(),
      plane: z.enum(['vault', 'live', 'hybrid']).optional(),
      /** Prior turn's question text — required ONLY for clarification continuation. */
      question: z.string().min(1).max(2000).optional(),
      /** Open disambiguation set from the prior turn's blocking clarification. */
      clarification: z.object({
        clarificationId: z.string().min(1).max(64),
        options: z.array(z.string().min(1).max(256)).min(1).max(10),
      }).strict().optional(),
    }).strict(),
  }).strict().optional(),
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
  /**
   * Vault-backed evidence about the named entity, when resolution was useful —
   * including disposition `none`, where it carries the FALSE-PREMISE disclosure
   * (the question named a component the vault does not contain).
   */
  readonly entityEvidence?: {
    /** Narrow phrase sent to the resolver; never the whole question. */
    readonly query: string;
    /** Route-derived type constraints used to prevent cross-type fuzzy noise. */
    readonly typeHints: readonly ComponentType[];
    readonly disposition: 'exact' | 'ambiguous' | 'none';
    /** Whether candidate competition is strong enough that execution must stop. */
    readonly clarificationRequired: boolean;
    /**
     * Non-blocking warning when matches are weak rather than truly competitive;
     * on disposition `none` this is the premise disclosure ("no component
     * matching '<name>' exists in the vault — verify the name").
     */
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
    /** `tool` resolves an I6 margin (plane/risk) tool-choice clarification. */
    readonly kind: 'intent' | 'entity' | 'tool';
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
 * A token that names one of this server's OWN tools ("find_dependency_cycles",
 * "sfi.automation_risk_report") is a TOOL mention, not an org component — a
 * user typing a tool name verbatim must not premise-flag as "no component
 * named find_dependency_cycles exists" (R3 funnel-primary forensics, q594).
 * Lazy `getPlaneByTool()` is the canonical registered-tool roster.
 */
const isToolNameMention = (token: string): boolean => {
  const bare = token.toLowerCase().replace(/^sfi[._]/, '');
  return getPlaneByTool().has(`sfi.${bare}`);
};

/**
 * Resolve only a bounded component phrase. Sending the full natural-language
 * question to the fuzzy resolver creates false ambiguity from action words
 * such as "what", "change", and "access".
 */
const extractEntityQuery = (question: string, intent: string): string | null => {
  // Three literal API-reference shapes, most-specific first: dotted
  // Object.Field, a __suffix custom name, and (router-v2 P4) a bare
  // UNDERSCORED token ("Clinical_Lead_Student_Assignment_Screen_Flow",
  // "Opportunity_Stage_Date_Update") — nobody types underscores in prose
  // unless they are naming a component, and missing these left the extractor
  // scraping generic phrases ("screen flow") that resolved to junk menus.
  // A token naming one of our own tools is skipped (tool mention, not entity).
  const apiReference = [...question.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)\b|\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x|b|kav)\b|\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b/g,
  )].map((match) => match[0]).find((token) => !isToolNameMention(token));
  if (apiReference !== undefined) {
    if (intent === 'what-if-method-signature' && apiReference.includes('.')) {
      return `${apiReference.slice(0, apiReference.indexOf('.'))} class`;
    }
    // Object-qualified field reference — "Resolution_Code__c on Case". The
    // stated object must SCOPE the entity: emit the dotted Object.Field form
    // the resolver treats as a definitive parent+name hit, so a same-named
    // field on another object can never drag this into a cross-object menu.
    if (!apiReference.includes('.')) {
      const qualifier = question.match(
        new RegExp(
          `\\b${apiReference}\\b\\s+(?:field\\s+)?on\\s+(?:the\\s+)?([A-Za-z][A-Za-z0-9_]*)\\b`,
          'i',
        ),
      )?.[1];
      if (qualifier !== undefined) return `${qualifier}.${apiReference}`;
    }
    return apiReference;
  }

  // QUOTED NAME + type noun (router-v2 R2): "the 'Status' field", "'Name
  // Subject' field — which object?", "the 'Standard' profile". Quote marks
  // break the word-boundary shapes below ("'Status' field" never matched
  // typedMatch), which silently skipped entity resolution — so a user
  // explicitly flagging an ambiguous bare label never got the clarification
  // the same unquoted phrasing gets. A quoted VALUE literal ("flips to
  // 'Resolved'") stays ignored: the type noun must follow the closing quote.
  const quotedTyped = question.match(
    /['"‘“]([A-Za-z][A-Za-z0-9_ ]{1,40}?)['"’”]\s+(?:field|object|profile|permission\s+set|flow|record\s+type)\b/i,
  )?.[1];
  if (quotedTyped !== undefined) return quotedTyped.trim();

  const prefixedTypePhrase = question.match(
    /\b((?:validation\s+rule|permission\s+set|record\s+type|page\s+layout|object|field|flow|class|trigger|layout|profile|report|dashboard)\s+(?:named\s+)?[A-Z][A-Za-z0-9_]*(?:\s+[A-Z][A-Za-z0-9_]*){0,5})\b/,
  )?.[1];
  if (prefixedTypePhrase !== undefined) return prefixedTypePhrase.trim();

  // `logic` is in the trailing-noun alternation so "the Order Fulfillment
  // logic" captures a name (eval family B), but unlike the schema nouns it is
  // a generic implementation word, not a resolver type hint — it is DROPPED
  // from the returned phrase below so the resolver ranks the bare name and the
  // type-guard adapts the route to whatever family it lands on.
  const typedMatch = question.match(
    /\b(?:the\s+)?([A-Za-z][A-Za-z0-9_]*(?:[\s_-]+[A-Za-z][A-Za-z0-9_]*){0,5}\s+(?:object|field|flow|class|trigger|layout|profile|permission\s+set|record\s+type|validation\s+rule|report|dashboard|logic))(?:\s+(?:on|for|of)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_]*)(?:\s+object)?)?\b/i,
  );
  const typedPhrase = typedMatch?.[1];
  if (typedPhrase === undefined) return null;
  const cleaned = typedPhrase
    .replace(
      /^(?:(?:what|whats|whatever|which|who|whos|where|wheres|when|why|how|hows|is|are|can|does|do|did|show|find|explain|locate|list|walk|through|pull|give|gimme|tell|about|break|down|compare|effective|calls?|invokes?|references?|owns?|edit|read|view|access|change|delete|remove|possible|values?|apex|api|version|data|type|for|of|the|this|that|in|on|to|used|assigned|set|every|all|each|any|me|my|us|a|an)\s+)+/i,
      '',
    )
    .trim();
  if (
    /\b(?:and|when|should|use|there|any|that|no|available|tools?|difference|between|required\s+fields?|record\s+types?)\b/i.test(cleaned)
  ) return null;
  const distinctive = cleaned
    .replace(
      /\b(?:object|field|flow|class|trigger|page|layout|profile|permission|set|record|type|validation|rule|report|dashboard|data|logic)\b/gi,
      '',
    )
    .replace(/[^A-Za-z0-9_]+/g, '');
  if (distinctive.length === 0) return null;
  const phrase = cleaned.replace(/\s+logic$/i, '');
  const parent = typedMatch?.[2];
  return parent === undefined ? phrase : `${phrase} on ${parent}`;
};

/**
 * Does an extracted entity phrase actually LOOK like a component name the user
 * asserted exists? The typed-phrase extractor sometimes scrapes prose ("I want
 * a risk report on all", "they say the field", "If someone is assigned the
 * Billing permission set") — resolving that to `none` says nothing about
 * any premise, yet the stage-6 existence flag treated it as a named ghost and
 * BLOCKED funnel-primary (stage 7), eating high-score conversions (R3
 * forensics: 6 of the 8 non-firing eligible misses). A single token is always
 * name-shaped (the api-reference shapes guarantee it); a multi-word phrase is
 * name-shaped only when every word beyond schema-type nouns and connectors is
 * capitalized ("Zorp Widget", "ZorpAid permission set" — yes; prose
 * fragments with lowercase verbs/pronouns — no).
 */
const NAME_IGNORABLE_WORD =
  /^(?:object|field|flow|class|trigger|page|layout|profile|permission|set|record|type|validation|rule|report|dashboard|logic|named|of|and|or|the|a|an|for)$/i;
export const looksLikeComponentName = (query: string): boolean => {
  const words = query.trim().split(/\s+/);
  if (words.length <= 1) return true;
  const nameWords = words.filter((word) => !NAME_IGNORABLE_WORD.test(word));
  return nameWords.length > 0 && nameWords.every((word) => /^["'‘“(]?[A-Z0-9]/.test(word));
};

/**
 * R3 §5b — PRE-ROUTE EXISTENCE GATE token extractor. The largest genuine
 * over-route cluster (23) named a proper-noun component and committed a CLEAN
 * route because the intent never ran entity resolution (Router E's premise
 * flag only fires when resolve actually ran). This finds the strongest
 * name-shaped token to existence-probe: a custom-suffixed name
 * (`Ghost_Field__c`) or a multi-part underscored name (`Ghost_Sync_Flow`) —
 * nobody types those in prose unless naming a component. DOTTED standard
 * references (`Lead.Amount`) are deliberately EXCLUDED: standard fields are
 * legitimately absent from a metadata vault, so probing them would
 * premise-flag real questions (the q799 `Case.RecordTypeId` shape). A token
 * naming one of this server's own tools is skipped as always.
 */
const extractExistenceProbeToken = (question: string): string | null =>
  [...question.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x|b|kav)\b|\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b/g,
  )]
    .map((match) => match[0])
    .find((token) => !isToolNameMention(token) && !/^\d/.test(token)) ?? null;

const inferEntityTypes = (
  query: string,
  intent: string,
  question: string,
): readonly ComponentType[] => {
  if (intent === 'what-if-method-signature') return ['ApexClass'];
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
  // QUESTION-level type qualifier RIGHT AFTER the extracted name — "does the
  // sample profile have access to the Sample_Exam__c OBJECT". The
  // user told us the type; scoping resolution to it keeps same-named
  // components of other types (the CustomTab twin, sibling fields) from
  // manufacturing a fake ambiguity (router-v2 P4 qualified-entity shape).
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const qualifier = question.match(
    new RegExp(`\\b${escaped}\\s+(object|flow|field|trigger|profile|permission\\s+set)\\b`, 'i'),
  )?.[1]?.toLowerCase().replace(/\s+/g, ' ');
  if (qualifier === 'object') return ['CustomObject'];
  if (qualifier === 'flow') return ['Flow'];
  if (qualifier === 'field') return ['CustomField'];
  if (qualifier === 'trigger') return ['ApexTrigger'];
  if (qualifier === 'profile') return ['Profile'];
  if (qualifier === 'permission set') return ['PermissionSet'];
  // Question-level "field" is the WEAKEST hint — it must not override a
  // query-level type noun ("the financial aid PROFILE" in a question that
  // also says "field" elsewhere), so it is checked last (router-v2 P4).
  if (/\bfield\b/i.test(question)) return ['CustomField'];
  return [];
};

/** Loose literal key: lowercase, punctuation/space/underscore-insensitive. */
const normLiteral = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The fuzzy resolver deliberately returns `ambiguous` when nearby names are
 * plausible. A unique literal API/canonical-id match is stronger evidence and
 * is safe for the router to treat as exact. Router-v2 P4 widens "literal":
 * - SPACE-TYPED names ("Alpha Beta Flow" ≈ `Alpha_Beta_Flow`)
 *   compare punctuation-insensitively — but never for a CustomField when the
 *   query has spaces (the "Contact Email" → `Account.Contact_Email__c` decoy
 *   family the resolver deliberately keeps ambiguous).
 * - "Object Field" order ("Case Status" ≈ `Case.Status`): parent+name equals
 *   the whole query — the most specific way to name a field in prose.
 * - A CustomTab literal twin of a CustomObject is NOT a rival: the tab is the
 *   object's UI shell, and every routed tool wants the object id (a tab ask
 *   routes to tab-availability which also takes the object). Dropping twins
 *   that leaves ONE literal winner resolves `exact` instead of blocking.
 */
const refineEntityResolution = (query: string, resolution: ResolveResult): ResolveResult => {
  if (resolution.disposition !== 'ambiguous') return resolution;
  const normalized = query.toLowerCase();
  const looseQuery = normLiteral(query);
  const queryHasSpace = /\s/.test(query.trim());
  const exactApi = resolution.candidates.filter((candidate) =>
    candidate.apiName.toLowerCase() === normalized ||
    candidate.id.toLowerCase().endsWith(`:${normalized}`) ||
    (normLiteral(candidate.apiName) === looseQuery &&
      looseQuery.length >= 4 &&
      !(candidate.type === 'CustomField' && queryHasSpace))
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
  // "Object Field" prose order — parent + own name together equal the query
  // ("Case Status" → `CustomField:Case.Status`). Definitive when unique.
  const parentPlusName =
    queryHasSpace && looseQuery.length >= 4
      ? resolution.candidates.filter(
          (candidate) =>
            candidate.type === 'CustomField' &&
            candidate.parentApiName !== null &&
            normLiteral(candidate.parentApiName) +
              normLiteral(candidate.apiName.replace(/__[a-z]+$/i, '')) ===
              looseQuery,
        )
      : [];
  // CustomTab twins of a literally-matched CustomObject are UI shells, not
  // genuine rivals — drop them from the literal set before deciding.
  const objectLiteralNames = new Set(
    exactApi
      .filter((candidate) => candidate.type === 'CustomObject')
      .map((candidate) => normLiteral(candidate.apiName)),
  );
  const exactApiNoTabTwins = exactApi.filter(
    (candidate) =>
      candidate.type !== 'CustomTab' ||
      !objectLiteralNames.has(normLiteral(candidate.apiName)),
  );
  const exact =
    exactParentField.length === 1
      ? exactParentField
      : parentPlusName.length === 1
        ? parentPlusName
        : exactApiNoTabTwins.length === 1
          ? exactApiNoTabTwins
          : exactApi;
  if (exact.length !== 1) return resolution;
  const winner = exact[0]!;
  return {
    ...resolution,
    disposition: 'exact',
    candidates: [winner, ...resolution.candidates.filter((candidate) => candidate.id !== winner.id)],
  };
};

/**
 * QUALIFIED-ENTITY AUTO-RESOLVE (router-v2 P4): when the ambiguity is a
 * same-named component family differing only by PARENT object (the classic
 * `Resolution_Code__c` on Case/Task/Event), and the QUESTION itself names
 * exactly ONE of those parents as a word ("…saving a CASE without a
 * Resolution_Code__c…"), the question already carries the disambiguating
 * qualifier — resolve with it instead of blocking on a clarification the user
 * has effectively pre-answered. Promotes only on a UNIQUE parent mention;
 * zero or several mentioned parents keep the genuine ambiguity.
 */
const resolveParentQualifier = (
  question: string,
  resolution: ResolveResult,
): ResolveResult => {
  if (resolution.disposition !== 'ambiguous') return resolution;
  const top = resolution.candidates[0];
  if (top === undefined) return resolution;
  const family = resolution.candidates.filter(
    (candidate) =>
      candidate.apiName.toLowerCase() === top.apiName.toLowerCase() &&
      candidate.parentApiName !== null,
  );
  if (family.length < 2) return resolution;
  const questionWords = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 0),
  );
  const namesParent = (parentApiName: string): boolean => {
    const full = parentApiName.toLowerCase();
    const bare = full.replace(/__c$/, '').replace(/^[a-z0-9]+__/, '');
    return (
      questionWords.has(full) ||
      questionWords.has(bare) ||
      questionWords.has(`${bare}s`)
    );
  };
  const parentNamed = family.filter((candidate) => namesParent(candidate.parentApiName!));
  if (parentNamed.length !== 1) return resolution;
  const winner = parentNamed[0]!;
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
        nameCoverage: 1,
        matchKind: 'exact' as const,
        evidence: candidate.evidence,
      })),
      ...resolution.candidates.filter((candidate) => !aliasIds.has(candidate.id)),
    ],
  };
};

/**
 * The user's own words ASSERT a same-name family exists ("there are like
 * three different things called Status", "I see a few of these with that
 * name") — router-v2 R2. When the resolver agrees (disposition ambiguous),
 * that self-reported multiplicity is the strongest possible clarify signal:
 * junk-tie suppression must not swallow it. Deliberately narrow — bare
 * counting nouns ("two triggers on Lead") do NOT match; the phrase must
 * assert sameness ("different things CALLED …", "of these", "which one").
 */
export const questionAssertsNameMultiplicity = (question: string): boolean =>
  /\b(?:a\s+few|several|a\s+couple)\s+of\s+(?:these|those|them)\b|\b(?:two|three|four|five|\d+)\s+different\s+(?:things?|ones?|fields?|objects?|components?|versions?)\b|\bmore\s+than\s+one\s+(?:of\s+(?:these|those|them)|with\s+(?:that|this)\s+name)\b|\bwhich\s+one\s+(?:do|should|did)\s+i\b/i.test(
    question,
  );

const entityAmbiguityRequiresClarification = (
  query: string,
  resolution: ResolveResult,
  question?: string,
  /**
   * R4 NARROW CLARIFY (DIAGNOSIS-R4 §2.2): when the winning route targets a
   * SINGLE named component, a wider near-equal band (top2/top1 ≥ 0.8) fires the
   * clarification — this converts the ~55-70 entity-ambiguous misses. When the
   * route is NOT single-component (scope-vague inventory/audit asks), only the
   * existing tight-band / literal-collision / self-asserted paths fire, so the
   * 242 scope-vague turns stay untouched and wrong-clarifies hold ≤87 (T6).
   * Defaults false so every existing caller keeps the pre-R4 behavior exactly.
   */
  routeTargetsSingleComponentTool = false,
): boolean => {
  // BARE-LABEL EXACT TIE (router-v2 R2): the resolver can return `exact` for
  // a bare label ("the 'Concentration' field") even when several SAME-named
  // fields on DIFFERENT parents all matched at identical base — its pick of a
  // parent is arbitrary, and a destructive what-if against the wrong parent
  // is the worst outcome. Only for a bare label (no __ suffix, no dot: API
  // references keep their P4 auto-resolve), only when the question did not
  // name a parent (resolveParentQualifier would have consumed it), and only
  // on a true dead heat (same normalized name + equal base + exact kind).
  if (
    resolution.disposition === 'exact' &&
    resolution.candidates.length >= 2 &&
    !/__|\./.test(query)
  ) {
    const [top, second] = resolution.candidates;
    const sameName =
      top !== undefined &&
      second !== undefined &&
      top.matchKind === 'exact' &&
      second.matchKind === 'exact' &&
      top.base === second.base &&
      top.apiName.toLowerCase() === second.apiName.toLowerCase() &&
      top.parentApiName !== second.parentApiName;
    if (sameName) {
      const promoted = resolveParentQualifier(question ?? '', {
        ...resolution,
        disposition: 'ambiguous',
      });
      if (promoted.disposition === 'ambiguous') return true;
    }
  }
  if (resolution.disposition !== 'ambiguous' || resolution.candidates.length < 2) return false;
  if (question !== undefined && questionAssertsNameMultiplicity(question)) return true;
  const normalized = query.toLowerCase();
  const literalMatches = resolution.candidates.filter((candidate) =>
    candidate.apiName.toLowerCase() === normalized ||
    candidate.id.toLowerCase().endsWith(`:${normalized}`)
  );
  if (literalMatches.length > 1) return true;
  if (/[A-Za-z0-9_]__(?:c|mdt|e|x|b|kav)\b|\w+\.\w+/.test(query)) return false;
  const [top, second] = resolution.candidates;
  // JUNK-TIE SUPPRESSION (router-v2 P4): a blocking clarification is only
  // justified when the top rivals look like the NAME the user typed — both
  // non-fuzzy AND both covering at least half their own name (a generic token
  // like "test" grazing 1-of-4 tokens of `ApplicationPortalTestData` ties at
  // base 1.0 but is vocabulary, not a name; blocking on it turns an answerable
  // question into a dead clarification full of junk options). Genuine
  // same-name families (literal collisions above, full-name ties here) still
  // clarify. nameCoverage defaults to 1 for legacy candidates without it.
  const looksLikeNamedComponent = (candidate: (typeof resolution.candidates)[number]): boolean =>
    candidate.matchKind !== 'fuzzy' && (candidate.nameCoverage ?? 1) >= 0.5;
  if (
    top!.base >= 0.92 &&
    second!.base >= 0.92 &&
    second!.score >= top!.score * 0.97 &&
    looksLikeNamedComponent(top!) &&
    looksLikeNamedComponent(second!)
  ) {
    return true;
  }
  // R4 NARROW CLARIFY (DIAGNOSIS-R4 §2.2): a WIDER near-equal band (top2/top1 ≥
  // 0.8, verbatim from the diagnosis) fires the clarification, but ONLY when
  // the winning route targets a single named component and the top pair are
  // both real-name matches for DISTINCT components. This converts the
  // entity-ambiguous misses the tight 0.97 band left on the table (e.g. "the
  // ApplicationForm class" → controller vs service, "Course Manager" → profile
  // vs app) without touching the scope-vague turns (their routes are not
  // single-component, so this branch is skipped and wrong-clarifies hold ≤87).
  if (routeTargetsSingleComponentTool) {
    // A genuine same-name family: two DISTINCT components sharing the SAME
    // normalized api-name, both at a high base (≥ 0.85) and within the 0.8
    // near-equal score band. Shared-name is the strongest ambiguity signal and
    // exactly the §2.1 shape ("ApplicationForm" controller vs service,
    // "Course Manager" profile vs app, "Concentration" field on two objects) —
    // a trailing type word ("the X CLASS") makes the match read `fuzzy` and
    // drops per-candidate nameCoverage, so neither is a reliable discriminator
    // here; the shared name IS. Junk grazes never share a normalized name.
    const sameName =
      top!.id !== second!.id &&
      top!.apiName.toLowerCase() === second!.apiName.toLowerCase();
    if (
      sameName &&
      top!.base >= 0.85 &&
      second!.base >= 0.85 &&
      second!.score >= top!.score * 0.8
    ) {
      return true;
    }
  }
  return false;
};

/**
 * OPTION HYGIENE (router-v2 P4): the options offered by an entity
 * clarification must be the PLAUSIBLE candidates only. A rival that matched
 * fuzzily (the Bug-2-class pure-short-acronym overlap: "ssn" ≈
 * `{ASN,BSN,MSN}_Professional_Status__c` on a 2-char "SN" graze) or whose base
 * sits well below the top option is junk the resolver itself would never act
 * on — offering it as a pick teaches the user the tool can't tell junk from
 * signal. Keeps every candidate within 90% of the top base that matched
 * non-fuzzily, always including the top option itself.
 */
export const hygienicClarificationOptions = <
  T extends { readonly base: number; readonly matchKind: string },
>(
  candidates: readonly T[],
): T[] => {
  const top = candidates[0];
  if (top === undefined) return [];
  const kept = candidates.filter(
    (candidate) =>
      candidate.matchKind !== 'fuzzy' && candidate.base >= top.base * 0.9,
  );
  // The top option is always offered, whatever its kind — the clarification
  // gate already vetted the top pair before any options are assembled.
  return kept.length > 0 && kept[0] === top ? kept : [top, ...kept.filter((c) => c !== top)];
};

/**
 * Clarification option ids for an ambiguous entity. Prefers the P4 hygiene set;
 * but when that collapses to <2 options AND the resolve is a genuine SAME-NAME
 * family (the R4 narrow-clarify shape — e.g. "the ApplicationForm CLASS" reads
 * `fuzzy`, which hygiene would drop), it falls back to the distinct components
 * sharing the top candidate's normalized name, so the clarification has real
 * options to offer instead of degenerating to a single pick.
 */
const clarificationOptionIds = (
  candidates: readonly ResolveResult['candidates'][number][],
): readonly string[] => {
  const hygienic = hygienicClarificationOptions(
    candidates.map((candidate) => ({
      componentId: candidate.id,
      base: candidate.base,
      matchKind: candidate.matchKind,
    })),
  ).map((candidate) => candidate.componentId);
  if (hygienic.length >= 2) return hygienic;
  const top = candidates[0];
  if (top === undefined) return hygienic;
  const topName = top.apiName.toLowerCase();
  const sameName = candidates
    .filter((candidate) => candidate.apiName.toLowerCase() === topName)
    .map((candidate) => candidate.id);
  return sameName.length >= 2 ? sameName : hygienic;
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

/** Tools the regex route lists as preambles — they never inherit answering args. */
const ROUTE_PREAMBLE_TOOLS = new Set(['sfi.resolve', 'sfi.capabilities']);

/**
 * SINGLE-COMPONENT-TARGET primary tools (DIAGNOSIS-R4 §2.2 rule, condition 2).
 * The narrow clarify rule fires ONLY when the winning route's primary tool
 * operates on exactly ONE named component — an entity ambiguity genuinely
 * blocks these because the tool cannot proceed without knowing WHICH component
 * the user meant. The `what_if_*` family (all named-target simulations) is
 * matched by prefix below rather than enumerated. Scope-vague questions (no
 * single entity — audits, inventories, list/menu asks) route to tools NOT in
 * this set, so the clarify gate stays off them: that is the precision guard
 * that holds wrong-clarifies ≤87 (tripwire T6). The list is the diagnosis's
 * verbatim single-component intents plus their close field/flow/apex kin.
 */
const SINGLE_COMPONENT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  'sfi.explain_flow',
  'sfi.explain_apex_method',
  'sfi.explain_field',
  'sfi.explain_formula',
  'sfi.get_component',
  'sfi.downstream_effects',
  'sfi.component_history',
  'sfi.call_graph',
  'sfi.method_reachability',
  'sfi.safe_to_delete_field',
  'sfi.who_can_run',
  'sfi.field_360',
  'sfi.field_lineage',
  'sfi.what_happens_on_save',
  'sfi.order_of_execution',
  'sfi.field_access_audit',
  'sfi.object_access_audit',
  'sfi.who_can_access_object',
  'sfi.what_if_deactivate_flow',
  'sfi.what_if_disable_trigger',
]);

/**
 * True when the route's PRIMARY tool (first non-preamble tool) targets a
 * single named component, so an entity ambiguity should block with a
 * clarification. `what_if_*` simulations (all named-target) count via prefix.
 * A route with no non-preamble primary (pure resolve/capabilities) is NOT a
 * single-component target — clarifying there is the scope-vague leak.
 */
const routeTargetsSingleComponent = (route: RouteResult): boolean => {
  const primary = route.tools.find((tool) => !ROUTE_PREAMBLE_TOOLS.has(tool));
  if (primary === undefined) return false;
  return (
    SINGLE_COMPONENT_TARGET_TOOLS.has(primary) ||
    primary.startsWith('sfi.what_if_')
  );
};

/**
 * Eval family B — tool ↔ resolved-component-type compatibility. The tools keyed
 * here FAIL CLOSED when handed a component outside their family (an Apex call
 * graph over a Flow id, an object CRUD audit over a Flow) — a route that ships
 * them anyway is a guaranteed hard error, not a wrong-but-plausible answer.
 * Tools not keyed here accept any component type and are never touched.
 */
const TOOL_COMPATIBLE_TYPES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sfi.call_graph', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.method_reachability', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.explain_apex_method', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.who_can_access_object', new Set(['CustomObject'])],
  ['sfi.object_access_audit', new Set(['CustomObject'])],
  ['sfi.field_access_audit', new Set(['CustomField'])],
]);

/** The access-flavored half of the map — their Flow analogue is RUN access. */
const ACCESS_FLAVORED_TOOLS: ReadonlySet<string> = new Set([
  'sfi.who_can_access_object',
  'sfi.object_access_audit',
  'sfi.field_access_audit',
]);

/**
 * Resolve the entity TYPE the guard should act on. `exact` trusts the top
 * candidate. `ambiguous` is treated as typed only when NO candidate could
 * satisfy the route's type-restricted tools — whichever candidate the user
 * turns out to mean, those tools are a guaranteed hard error (verified live:
 * a Flow whose ambiguity rivals are its own conditional contexts and business
 * processes, never an Apex class), so substituting is safe even before the
 * ambiguity resolves. A mixed list with a compatible rival stays untyped —
 * the route may be right once the user picks.
 */
export const resolvedTypeForGuard = (
  route: RouteResult,
  resolution: Pick<ResolveResult, 'disposition' | 'candidates'> | null,
): string | null => {
  if (resolution === null || resolution.candidates.length === 0) return null;
  const top = resolution.candidates[0]!;
  if (resolution.disposition === 'exact') return top.type;
  if (resolution.disposition !== 'ambiguous') return null;
  const guardedCompatibleTypes = new Set(
    route.tools.flatMap((tool) => [...(TOOL_COMPATIBLE_TYPES.get(tool) ?? [])]),
  );
  if (guardedCompatibleTypes.size === 0) return null;
  return resolution.candidates.some((candidate) => guardedCompatibleTypes.has(candidate.type))
    ? null
    : top.type;
};

/**
 * When the question's entity RESOLVES to a Flow but the route carries tools
 * that hard-error on a Flow id, SUBSTITUTE the Flow-appropriate tools instead
 * of routing into the guaranteed error: access asks get who_can_run (flowAccess
 * grants) leading, code/dependency asks get explain_flow (which narrates the
 * Apex the Flow invokes) leading, and both get get_impact for the dependency
 * surface. A substitution, never a block — the question stays answerable, and
 * because the swap happens BEFORE the funnel fusion, explain_flow/get_impact
 * also surface in toolCandidates. Exported for drift-proof unit tests.
 */
export const applyComponentTypeGuard = (
  route: RouteResult,
  resolvedType: string | null,
): RouteResult => {
  if (resolvedType !== 'Flow') return route;
  const incompatible = new Set(
    route.tools.filter((tool) => {
      const compatible = TOOL_COMPATIBLE_TYPES.get(tool);
      return compatible !== undefined && !compatible.has(resolvedType);
    }),
  );
  if (incompatible.size === 0) return route;
  const substitutes = [...incompatible].some((tool) => ACCESS_FLAVORED_TOOLS.has(tool))
    ? ['sfi.who_can_run', 'sfi.explain_flow', 'sfi.get_impact']
    : ['sfi.explain_flow', 'sfi.get_impact'];
  const substituteSet = new Set(substitutes);
  const preamble = route.tools.filter((tool) => ROUTE_PREAMBLE_TOOLS.has(tool));
  const kept = route.tools.filter(
    (tool) =>
      !ROUTE_PREAMBLE_TOOLS.has(tool) && !incompatible.has(tool) && !substituteSet.has(tool),
  );
  const originalTools = route.tools;
  const tools = [...preamble, ...substitutes, ...kept];
  return {
    ...route,
    tools,
    reason:
      `${route.reason} The named entity resolved to a Flow, so tools that require ` +
      `an Apex class, object, or field id were replaced with the Flow-appropriate ones.`,
    plan: route.plan.map((step) =>
      step.tools === originalTools ? { ...step, tools } : step,
    ),
  };
};

/**
 * I2b — the regex route is a FEATURE, not an override. Instead of hard-pinning
 * every regex-named tool to a flat 0.96 (which dwarfed every real cosine and let
 * the regex CAUSALLY decide top-1 — the funnel ranking was cosmetic), a
 * regex-named candidate's fused score is `min(1, cosine + REGEX_BONUS)`: a
 * BOUNDED additive bonus on top of its own meaning score. Consequences:
 *   - a regex tool the funnel ALSO ranked well leads by a real margin (its cosine
 *     PLUS the bonus), and regex tools no longer sit at a flat identical score —
 *     the shortlist score distribution reflects genuine meaning variation;
 *   - a regex tool the funnel did NOT surface (no cosine) sits at exactly
 *     REGEX_BONUS, so a strongly-confident funnel tool (high cosine) can now
 *     OUTRANK it — the funnel OVERRIDES the regex when it is decisively sure.
 *
 * REGEX_BONUS is tuned so (a) the router-goldset stays 128/128 — but note the
 * goldset grades the deterministic `route`, which this fusion never touches — and
 * (b) router-recall / corpus-gen recall@8 do not regress. At 0.25 the bonus keeps
 * regex-route tools competitive in the candidate shortlist without re-pinning them
 * to a flat ceiling: e.g. a route tool with cosine 0.05 fuses to 0.30 and can lose
 * to a non-route funnel tool at cosine 0.32, which is the intended override.
 */
const REGEX_BONUS = 0.25;

/**
 * Registry alias for the vault this server is bound to, when registered.
 * Falls back to `meta/config.json` `targetOrg`, then manifest `sourceOrg`.
 */
const resolveActiveVaultAlias = async (ctx: Context): Promise<string | undefined> => {
  const normalizedRoot = resolve(ctx.vaultRoot);
  const listed = await listRegisteredVaults(findRegistryRoot(ctx.vaultRoot));
  if (listed.ok) {
    for (const entry of listed.value) {
      if (resolve(entry.path) === normalizedRoot) return entry.alias;
    }
  }
  try {
    const raw = await readFile(join(ctx.vaultRoot, 'meta', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { targetOrg?: unknown };
    if (typeof parsed.targetOrg === 'string' && parsed.targetOrg.length > 0) {
      return parsed.targetOrg;
    }
  } catch {
    // config.json is optional on some fixtures
  }
  return ctx.manifest.sourceOrg.length > 0 ? ctx.manifest.sourceOrg : undefined;
};

/**
 * Derive `sfi.interpret`'s `componentId` from the args already resolved for the
 * route's SPECIALIST tool — never a fresh guess. Reuses the canonical id under
 * whichever intent-specific key the specialist bound it to (`componentId` for
 * impact/object intents, `fieldId`/`targetId` for field intents), or lifts a
 * bare object api name — under `objectApiName` (automation_build_advisor /
 * order_of_execution) or `object` (automation_collisions) — to its
 * `CustomObject:` canonical id, since interpret's owd / status-code / collision
 * rules anchor on a CustomObject. Returns null when no resolved id is bound (the
 * host resolves the component itself) — interpret then surfaces with empty args,
 * exactly like the specialist, rather than a guess. interpret's ONLY input key
 * is `componentId` (any canonical id), so re-keying the specialist's resolved id
 * is always valid.
 */
const interpretComponentIdFromArgs = (
  base: Readonly<Record<string, unknown>>,
): string | null => {
  const canonical = base['componentId'] ?? base['fieldId'] ?? base['targetId'];
  if (typeof canonical === 'string' && canonical.length > 0) return canonical;
  const objectApiName = base['objectApiName'] ?? base['object'];
  if (typeof objectApiName === 'string' && objectApiName.length > 0) {
    return objectApiName.startsWith('CustomObject:')
      ? objectApiName
      : `CustomObject:${objectApiName}`;
  }
  return null;
};

/**
 * Per-tool args for every tool in `route.tools` — not just the primary answering
 * tool. Keeps `list_components` filters, field-mapping pairs, and live tools
 * separated when the route stacks multiple calls.
 *
 * Exported for the interpret-binding unit test (`sfi.interpret` stacked onto a
 * reasoning-shaped route must surface with a bound `componentId`).
 */
export const buildRouteToolArgsMap = async (
  route: RouteResult,
  ctx: Context,
): Promise<Map<string, Readonly<Record<string, unknown>>>> => {
  const out = new Map<string, Readonly<Record<string, unknown>>>();
  const base = route.suggestedArgs ?? {};
  const primaryIdx = route.tools.findIndex((t) => !ROUTE_PREAMBLE_TOOLS.has(t));
  const primaryTool = primaryIdx === -1 ? route.tools[0] : route.tools[primaryIdx];
  const vaultAlias =
    route.intent === 'field-mapping' ? await resolveActiveVaultAlias(ctx) : undefined;

  for (const tool of route.tools) {
    if (ROUTE_PREAMBLE_TOOLS.has(tool)) {
      out.set(tool, {});
      continue;
    }
    if (tool === 'sfi.list_components' && base.type !== undefined) {
      out.set(tool, base);
      continue;
    }
    if (tool === 'sfi.field_mapping_between_objects') {
      out.set(tool, {
        ...base,
        ...(vaultAlias !== undefined ? { vault: vaultAlias } : {}),
      });
      continue;
    }
    if (tool === 'sfi.layout_for_user' && Object.keys(base).length > 0) {
      out.set(tool, base);
      continue;
    }
    if (tool === 'sfi.pii_inventory' && Object.keys(base).length > 0) {
      out.set(tool, base);
      continue;
    }
    if (tool === 'sfi.interpret') {
      // RM-wire (step 2): interpret is stacked as a reasoning COMPLEMENT after
      // the specialist. Bind the same resolved component id the specialist got,
      // re-keyed to interpret's sole `componentId` input. Empty when nothing was
      // resolved (host resolves) — never a guessed id.
      const interpretId = interpretComponentIdFromArgs(base);
      out.set(tool, interpretId !== null ? { componentId: interpretId } : {});
      continue;
    }
    if (tool === primaryTool) {
      out.set(tool, base);
      continue;
    }
    out.set(tool, {});
  }
  return out;
};

/** Promote regex route tools into the funnel shortlist with bound suggestedArgs. */
const mergeRouteHintsIntoCandidates = (
  route: RouteResult,
  cands: readonly ToolCandidate[],
  argsByTool: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  k: number,
): ToolCandidate[] => {
  if (route.intent === 'unrouted' || route.intent === 'empty') return cands.slice(0, k);
  const byTool = new Map(cands.map((c) => [c.tool, { ...c }]));
  // Bounded additive fusion, rounded to the funnel's 3-dp score precision.
  const fuse = (cosine: number): number => Math.round(Math.min(1, cosine + REGEX_BONUS) * 1000) / 1000;
  for (const tool of route.tools) {
    if (ROUTE_PREAMBLE_TOOLS.has(tool)) continue;
    const suggestedArgs = argsByTool.get(tool);
    const existing = byTool.get(tool);
    if (existing !== undefined) {
      // FUSED, not pinned: the tool's own meaning score PLUS a bounded regex
      // bonus. A well-ranked route tool leads by a real margin; a poorly-ranked
      // one stays beatable by a decisively-confident funnel tool (the override).
      byTool.set(tool, {
        ...existing,
        score: fuse(existing.score),
        ...(suggestedArgs !== undefined && Object.keys(suggestedArgs).length > 0
          ? { suggestedArgs }
          : {}),
        fromRoute: true,
      });
    } else {
      // INSERTED a route tool the funnel did not surface — its cosine is
      // effectively 0, so its fused score is exactly REGEX_BONUS (the bonus
      // floor). That deliberately keeps it BEATABLE by a high-cosine funnel tool
      // rather than pinning it above everything. It still has no scored
      // plane/liveRequired/confidence, so stamp them: plane + liveRequired from
      // the same authoritative map the funnel uses, and confidence 'high'
      // because a deterministic regex route pinned this tool (I1). Its
      // `cosine: 0` declares the ZERO semantic evidence outright (P2 §4): the
      // 0.25 score is pure regex assertion, and no threshold logic may ever
      // read it as funnel support — the row stays listed as a legitimate HINT.
      const { plane, liveRequired } = resolveCandidatePlane(tool);
      byTool.set(tool, {
        tool,
        score: fuse(0),
        cosine: 0,
        category: null,
        plane,
        liveRequired,
        confidence: 'high',
        ...(suggestedArgs !== undefined && Object.keys(suggestedArgs).length > 0
          ? { suggestedArgs }
          : {}),
        fromRoute: true,
      });
    }
  }
  return [...byTool.values()]
    .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
    .slice(0, k);
};

const invokeFromArgsMap = (
  route: RouteResult,
  argsByTool: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): readonly RouteInvocation[] =>
  route.tools.map((tool): RouteInvocation => {
    const args = argsByTool.get(tool) ?? {};
    return CORE_PROFILE_TOOLS.has(tool)
      ? { tool, args }
      : { tool: 'sfi.run_analysis', args: { name: tool, args } };
  });

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

// ---------------------------------------------------------------------------
// I6 — margin-based clarification.
//
// The 4 hardcoded semanticAlternatives pairs stop execution when a REGEX family
// overlaps a materially different one. That catches the wordings the router was
// hand-tuned for, but it cannot see a NEW high-consequence ambiguity the funnel
// surfaces as a genuine score tie. This gate generalizes: when the funnel's
// top-1 and top-2 fused scores are within MARGIN AND the two tools diverge on a
// high-consequence axis, stop and ask which the user meant — so a host does not
// silently commit to (say) a live count when a vault catalog was just as likely,
// or run a DESTRUCTIVE what-if when the user only wanted the impact readout.
//
// Scoped TIGHT on purpose: over-triggering (blocking a clear route) is worse
// than missing a subtle case. Only TWO divergence axes fire, and only on a real
// near-tie. Same-plane, same-risk near-ties are benign — the host picks fine —
// and never fire. Because the regex route fuses a bounded bonus (I2b) onto the
// routed tool, a routed answer usually leads its rivals by well more than
// MARGIN, so this rarely fires on a confidently-routed question; it is a safety
// net for the genuinely balanced case the regex pairs miss.
//
// At 0.05 the gate held the whole router-goldset at 128/128 (no clear gold
// route becomes executionBlocked) and fired on only a small set of genuinely
// balanced high-consequence ties in the corpus. Widening it re-blocks clear
// routes; that is the wrong trade.
export const MARGIN = 0.05;

/**
 * FUNNEL-PRIMARY advisory threshold (router-v2 P2 §3): when no deterministic
 * stage placed the question, the top PURE-funnel candidate must score at least
 * this to upgrade a dead `unrouted` into an advisory `funnel-advisory` route.
 *
 * The floor mass sits at exactly 0.25 (`REGEX_BONUS` fused over cosine 0 —
 * pure regex assertion, zero semantic evidence): 37/133 labeled over-routes
 * vs 8/529 misses sat there, so the threshold must be strictly above it. That
 * floor relationship is pinned ONCE, by the P2 §4 pure-cosine test — NOT
 * re-checked at the decision site, so the gate reads exactly one threshold
 * and two numbers can never drift apart. The funnel-primary path only ever
 * sees PURE cosines (the merge short-circuits for an unrouted intent — pinned
 * by the same test), so this is a real semantic threshold. 0.26 was adopted
 * in the Phase-7 calibration (was 0.30): labeled cleanToGold 85 → 123 with
 * the over-route tripwire flat (11 executables on the 133-list, 21 confident
 * routes on the full 334 honesty primaries — unchanged from 0.30) and
 * sweep-blocked flat at 8 (clean 414 → 425). Re-run those tripwires before
 * moving it again.
 *
 * WHAT THIS NUMBER CANNOT SEPARATE — measured 2026-08-07 over 30 no-intent
 * questions × 20 advisory-tier real questions (funnel-recall corpus + the
 * P2 §3 positives). A no-intent question carrying ONE high-IDF Salesforce
 * token is not separable from real signal by score, in either direction:
 *
 *   noise  ceiling 0.436  ("the setup here — any opinions")
 *   signal floor   0.261  ("contact has many active record-triggered flows —
 *                           is their execution order deterministic…")
 *
 * The noise ceiling sits ABOVE the signal floor, so NO value of this constant
 * both drops the vibe/setup ask and keeps the advisory tier: raising it past
 * 0.436 leaves ~7/21 real advisories alive. The cause is word-sense collision,
 * not calibration — "setup" the English noun vs Setup the Salesforce menu.
 * `semanticCandidates('setup')`, the bare token, already returns
 * `sfi.live_setup_audit_trail` at 0.436, and "the setup here — any opinions"
 * returns the byte-identical candidate list at the identical score because
 * every other word is a stopword or absent from the index. A bag-of-words
 * cosine cannot resolve that; only a minimum-INTENT gate can.
 *
 * The measured discriminator is evidence BREADTH, not height: summing the
 * candidate scores at ranks 3-8, noise that clears 0.26 spans [0.249, 0.277]
 * while signal that clears 0.26 spans [0.376, 1.672] — a clean 0.099 margin,
 * because a one-token match leaves everything below rank 2 collapsed near
 * zero while a real question spreads support across many index terms. That
 * gate is NOW implemented, as {@link FUNNEL_MIN_EVIDENCE_BREADTH} — this
 * constant stays 0.26 precisely because the fix does not belong on this axis.
 */
export const FUNNEL_PRIMARY_MIN_SCORE = 0.26;

/**
 * Minimum evidence BREADTH for a funnel-advisory upgrade — the second axis of
 * the gate, and the one that actually separates intent from lexical accident.
 *
 * Read as: "does anything BELOW the top two candidates have real support?"
 * Summed over ranks 3-8. A question that merely collides with one high-IDF
 * token lights up one tool and leaves the tail collapsed near zero; a question
 * with genuine Salesforce intent spreads support across many index terms.
 *
 * Measured 2026-08-07, 30 no-intent × 20 advisory-tier questions, over the
 * candidates that ALREADY clear {@link FUNNEL_PRIMARY_MIN_SCORE}:
 *
 *   noise  [0.249, 0.277]
 *   signal [0.376, 1.672]
 *
 * Disjoint, margin 0.099. 0.32 is the centre of that gap, so both sides carry
 * roughly equal slack. Unlike the score axis — where the noise ceiling (0.436)
 * sits ABOVE the signal floor (0.261) and no cut exists — this one separates
 * cleanly, which is why the gate moved here instead of the threshold moving up.
 *
 * HONEST LIMITS — two, and neither is a reason to raise the number:
 *
 * 1. PARTIAL BY CONSTRUCTION. On a 30-question no-intent set this cuts
 *    spurious advisories 6 -> 2. It closes the SINGLE-TOKEN collision class
 *    ("setup", "audit"). It does NOT close multi-token conversational asks —
 *    "how does this compare" (breadth 1.126 -> compare_components) and "can
 *    you help me out" (0.563 -> doc_coverage_report) survive, because those
 *    words genuinely spread across the index and land their breadth INSIDE
 *    the range real questions occupy. Raising the cut past them would cut
 *    measured signal (floor 0.376). That class needs an intent classifier,
 *    not a threshold — do not "fix" it by moving this constant.
 * 2. The margin was measured on a 50-question hand-built corpus, not the
 *    133/334 over-route tripwires FUNNEL_PRIMARY_MIN_SCORE was calibrated
 *    against. It ships because the repo's real tripwires — funnel-recall, the
 *    router goldset, the routing gate — all stay green. Re-run those first.
 */
export const FUNNEL_MIN_EVIDENCE_BREADTH = 0.32;

/**
 * Evidence breadth of a ranked candidate list: the score mass at ranks 3-8.
 * Ranks 1-2 are deliberately excluded — they are what a single token-collision
 * lights up, so including them would measure the very thing being filtered.
 */
export const funnelEvidenceBreadth = (
  candidates: readonly { readonly score: number }[],
): number =>
  candidates.slice(2, 8).reduce((sum, candidate) => sum + candidate.score, 0);

/**
 * A candidate whose tool MUTATES the org if the host acts on the plan it
 * describes — the safe-to-delete verdict and the what_if_* simulation family.
 * Picking one of these when the user wanted a read-only impact/usage readout is
 * a high-consequence misroute (destructive intent inferred from an ambiguous
 * ask), so it is one half of the RISK divergence axis.
 */
const DESTRUCTIVE_TOOL = /^sfi\.(safe_to_delete_field|what_if_)/;

/**
 * A candidate that only READS dependency/usage — the classic informational
 * counterpart the destructive tools are confused with. Kept to the tools that
 * actually collide with the destructive family on a delete/change ask, so the
 * axis stays a genuine either-or (a destructive tool tying an unrelated vault
 * tool is not this ambiguity).
 */
const INFORMATIONAL_IMPACT_TOOL =
  /^sfi\.(get_impact|get_edges|get_subgraph|downstream_effects|find_[a-z_]*usages|find_formula_references|field_lineage)$/;

/** One candidate is vault, the other reaches the org (live) or fuses it (hybrid). */
const planesDiverge = (a: ToolCandidate, b: ToolCandidate): boolean => {
  const planes = new Set([a.plane, b.plane]);
  return planes.has('vault') && (planes.has('live') || planes.has('hybrid'));
};

/**
 * Runtime-DATA language: the question asks about records/values/usage as they
 * exist in the org right now — the live plane's domain. Used to break a
 * plane-diverging funnel near-tie WITHOUT a blocking clarification (router-v2
 * P4): a vault-flavored question ("give me a breakdown of the X flow") whose
 * TF-IDF cosine grazes a live tool ("breakdown" ≈ live_owner_breakdown) is
 * noise, not a genuine plane choice — the vault candidate leads. A question
 * that speaks in record counts / fill rates / logins leads with the live
 * candidate, and the existing liveRequired consent disclosure fires.
 */
const LIVE_DATA_SIGNAL =
  /\bhow\s+many\b|\bcounts?\b|\bfill\s+rate\b|\bpopulat(?:ed|ion)\b|\bstorage\b|\bdata\s+volume\b|\blog(?:ged)?\s?in(?:to)?\b|\blast\s+login\b|\bright\s+now\b|\bcurrently\b|\bas\s+of\s+(?:now|today)\b|\bin\s+prod(?:uction)?\b|\bsample\s+records?\b|\brows?\b|\brecord\s+data\b|\bactual(?:ly)?\s+(?:records?|values?|data|used?|runs?)\b|\bapi\s+usage\b|\blimits?\s+headroom\b/i;

/**
 * Resolve a plane-diverging near-tie by the question's own language instead of
 * blocking: live-data language promotes the live/hybrid candidate to the top
 * of the shortlist (consent disclosure follows from its liveRequired flag);
 * otherwise the vault candidate leads. Regex-route pairs are a coordinated
 * plan and are never reordered.
 */
export const resolvePlaneTie = (
  cands: readonly ToolCandidate[],
  question: string,
): ToolCandidate[] => {
  const [top, second] = cands;
  if (top === undefined || second === undefined) return [...cands];
  if (top.score - second.score > MARGIN) return [...cands];
  if (!planesDiverge(top, second)) return [...cands];
  if (top.fromRoute === true && second.fromRoute === true) return [...cands];
  const wantsLive = LIVE_DATA_SIGNAL.test(question);
  const topReachesOrg = top.plane === 'live' || top.plane === 'hybrid';
  if (wantsLive === topReachesOrg) return [...cands];
  return [second, top, ...cands.slice(2)];
};

/**
 * COMPOUND VAULT+LIVE ASK (router-v2 R2): one question that EXPLICITLY asks
 * for both a metadata answer (what breaks / what it does / the schema) AND a
 * live-runtime verification (actually running / how many records right now /
 * in production), joined in one breath. Unlike the resolvePlaneTie graze
 * (one meaning, two tool planes), this is TWO asks on different planes — a
 * genuine either-or the P4 auto-resolve must not paper over, so it clarifies.
 * All three signals are required; a plain needs-live question ("how many
 * records right now") or a plain impact question ("what breaks if…") never
 * carries both halves plus the conjunction.
 */
export const isCompoundPlaneAsk = (question: string): boolean => {
  const liveHalf =
    /\b(?:actually|really)\s+(?:running|firing|executing|live)\b|\bright\s+now\b|\bin\s+production\b/i;
  const vaultHalf =
    /\bwhat\s+(?:breaks?|depends|would\s+break|will\s+break)\b|\bwhat\s+does\b[^.?!]{0,60}\bdo\b|\bschema\b|\bmetadata\b|\bsafe\s+to\s+(?:disable|deactivate|delete|remove)\b|\btell\s+me\s+about\b/i;
  const conjoined = /\b(?:and|also|plus)\b/i;
  return liveHalf.test(question) && vaultHalf.test(question) && conjoined.test(question);
};

/** One candidate is destructive, the other a read-only impact/usage readout. */
const risksDiverge = (a: ToolCandidate, b: ToolCandidate): boolean =>
  (DESTRUCTIVE_TOOL.test(a.tool) && INFORMATIONAL_IMPACT_TOOL.test(b.tool)) ||
  (DESTRUCTIVE_TOOL.test(b.tool) && INFORMATIONAL_IMPACT_TOOL.test(a.tool));

/**
 * When the top-2 funnel candidates are within MARGIN AND diverge on a
 * high-consequence axis (plane, or destructive-vs-informational), return a
 * tool-choice clarification; otherwise null. `existingClarification` short-
 * circuits the whole gate — the route already stopped for a stronger reason
 * (entity ambiguity, or a hardcoded semantic pair), and a second overlapping
 * "which did you mean" would be noise.
 */
export const marginClarification = (
  cands: readonly ToolCandidate[],
  existingClarification: RouteClarification | null,
): RouteClarification | null => {
  if (existingClarification !== null) return null;
  const [top, second] = cands;
  if (top === undefined || second === undefined) return null;
  if (top.score - second.score > MARGIN) return null;
  // Both top candidates came from the deterministic regex route: the route
  // deliberately STACKED them (e.g. a `hybrid` plan that runs a vault tool AND
  // a live tool together, or an impact route that lists get_impact + advisor).
  // That is a coordinated plan, not competing tools the user must choose
  // between — so the plane/risk "divergence" is intended, and asking would
  // block a correctly-planned route. The gate targets a genuine FUNNEL tie the
  // regex route did not resolve, so require at least one non-route rival.
  if (top.fromRoute === true && second.fromRoute === true) return null;
  // PLANE divergence no longer BLOCKS (router-v2 P4): the tie is resolved by
  // the question's own runtime-data language in resolvePlaneTie — a
  // vault-flavored question whose cosine grazed a live tool routes vault, a
  // live-implying question leads live WITH the consent disclosure. Only the
  // destructive-vs-informational axis still stops execution.
  if (!risksDiverge(top, second)) return null;
  const question =
    `These two tools are equally likely but one is DESTRUCTIVE and one is ` +
    `read-only — \`${top.tool}\` vs \`${second.tool}\`. Do you want the ` +
    `read-only impact/usage readout, or the change/delete simulation? Which ` +
    `did you mean?`;
  return {
    required: true,
    question,
    options: [top.tool, second.tool],
  };
};

/**
 * I3a structural honesty: when the answering candidate needs the opt-in live
 * plane, the guidance MUST disclose that up front — name the live plane and the
 * consent step — so the host LLM refuses to invent a number rather than calling
 * a `live_*` tool blindly and either erroring on a missing arg or (with standing
 * consent) silently spending the org's API budget. Read from the candidates'
 * own `liveRequired` field (I1), not the demoted regex route, so it generalizes
 * across the whole live-needs-consent bucket (counts, field population, samples,
 * stale records, duplicates), not just one phrasing. Fires only when a LEADING
 * candidate is live-required (the top 3 the host is most likely to pick); a lone
 * live tool buried far down the shortlist must not over-warn a vault question.
 */
const LIVE_DISCLOSURE_LOOKAHEAD = 3;
const liveConsentDisclosure = (cands: readonly ToolCandidate[]): string | undefined => {
  const leadIsLive = cands
    .slice(0, LIVE_DISCLOSURE_LOOKAHEAD)
    .some((c) => c.liveRequired === true);
  if (!leadIsLive) return undefined;
  return (
    ' LIVE PLANE / CONSENT: the leading candidate(s) are marked `liveRequired` — ' +
    'answering needs the opt-in, read-only LIVE PLANE that queries the org at call ' +
    'time, which the offline vault cannot do. Do NOT invent or estimate a record ' +
    'count, value, or sample. If the live plane is not enabled the live_* tool will ' +
    'fail-closed with a consent error; relay that honestly. To enable it, the user ' +
    'must grant one-time read-only consent with sfi.live_consent { grant: true } ' +
    '(or pass liveEnabled: true for one call, or set SFI_LIVE_PLANE_ENABLED=1) — ' +
    'state that consent step before running any live query.'
  );
};

/** CAE-02/04: the planner contract, tailored to the requested output mode. */
const guidanceForMode = (
  mode: RouteQuestionInput['mode'],
  cands: readonly ToolCandidate[] = [],
): string => {
  const consent = liveConsentDisclosure(cands) ?? '';
  const tail =
    ' The candidates are an advisory shortlist, not a route — YOU pick. Resolve any ' +
    'named component first, ground the final answer with sfi.synthesize_answer, and ' +
    'never answer from a tool name alone.' +
    consent;
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
        'Read ALL the candidates (up to 8) before picking: the ranking is advisory and the best tool is often mid-list, so never default to the first row. ' +
        'A deterministic `route` is also attached, but only as a HINT (a suggested tool order plus ' +
        'any resolved entity ids / suggestedArgs) — never follow it blindly. When a candidate carries ' +
        '`suggestedArgs`, treat them as heuristic bindings for that tool. Plan: read the question → ' +
        'resolve any named component with sfi.resolve → pick the tool(s) to run from the candidates ' +
        '(sequence them if compound) → run them → ground the answer with sfi.synthesize_answer. ' +
        'Never answer from a tool name alone.' +
        consent
      );
  }
};

// ---------------------------------------------------------------------------
// ROUTER DE-CROWD (0.2.0) — untriggered what_if shortlist demotion.
//
// The what_if_* simulation family shares heavy permission/field/flow
// vocabulary with the plain-read tools, so its candidates crowd the top of the
// shortlist on questions that carry NO action or hypothetical language at all.
// The demotion is gated on trigger tokens: a non-`fromRoute` what_if candidate
// in an ACTIVE family keeps its rank ONLY when the question carries a
// hypothetical marker or that family's own action verb; otherwise it is moved
// below the non-what_if candidates (demoted, never deleted — it can still
// appear at the tail of the shortlist).
//
// SCOPE IS MEASURED, NOT PRINCIPLED. See DECROWD_ACTIVE_FAMILIES below: only
// the two tools whose demotion was counterfactually PRICED on the real 3K
// depth-10 traces are active. The mechanism (trigger check, fromRoute
// exemption, reorder) and the corpus-derived lexicons for all 11 families are
// kept so widening the scope is a one-line, measurement-gated change.
// ---------------------------------------------------------------------------

/** The candidate family the de-crowd demotion applies to. */
export const WHAT_IF_CANDIDATE_FAMILY = /^sfi\.what_if_/;

/**
 * The ONLY what_if tools the de-crowd demotion is active for.
 *
 * Counterfactual pricing (independent replay of the built demote function over
 * the real 3K depth-10 traces + relabeled-v2 gold, 2026-07-13): scoping the
 * demotion to exactly these two tools measures +0.42pp recall@5, 27 turns
 * gained, ZERO turns lost. These are precisely the top-2 measured slot
 * parasites from the 0.2.0 audit — what_if_assign_permset /
 * what_if_revoke_permset held 487+236 parasitic top-5 slots with zero gold
 * questions corpus-wide (ROUTER-0.2.0-AUDIT-AND-ROADMAP.md item 2).
 *
 * The broad 11-family scope was MEASURED to be worse: net +0.25pp (below the
 * +0.4pp bar) with 40 turns where gold fell OUT of top-5 — 34 of them
 * follow-up turns whose action verb lives in the PREVIOUS turn (the funnel
 * only sees the current turn's text) and 6 lexicon gaps.
 *
 * DO NOT add a family to this set without a fresh traces-replay measurement
 * first (net >= +0.4pp recall@5 AND zero lost turns on the current trace
 * corpus — see ROUTER-0.2.0-AUDIT-AND-ROADMAP.md item 2).
 */
export const DECROWD_ACTIVE_FAMILIES: ReadonlySet<string> = new Set([
  'sfi.what_if_assign_permset',
  'sfi.what_if_revoke_permset',
]);

/**
 * Hypothetical/simulation markers shared across ALL what_if_* families.
 * DERIVED from the families' own utterance corpora in funnel-utterances.ts
 * (`sfi.what_if_*` blocks) — these are the framings those utterances actually
 * use ("what happens if…", "what would break…", "if I…", "impact of…",
 * "blast radius", "can I safely…", "simulate…", "consequences of…"), not a
 * hand-invented list. Any one of them marks the question as an
 * action/hypothetical ask, so every what_if candidate keeps its rank.
 */
export const WHAT_IF_HYPOTHETICAL_TRIGGERS =
  /\bwhat\s+(?:if|happens|breaks?)\b|\bhappens?\s+if\b|\bif\s+(?:i|we|someone)\b|\bwould\b|\bimpact\b|\bblast\s+radius\b|\bsimulat(?:e|es|ed|ing|ion)\b|\bconsequences?\b|\bsafe(?:ly)?\s+to\b|\bsafely\b/i;

/**
 * Per-family ACTION verbs, DERIVED from each family's own utterance corpus in
 * funnel-utterances.ts (the verbs those utterances actually use — e.g. the
 * `sfi.what_if_assign_permset` corpus says assign/grant/add/gain/give, the
 * `sfi.what_if_revoke_permset` corpus says revoke/remove/unassign/strip/
 * take away/lose). A question carrying the family's own verb is an action ask
 * for that family, so THAT tool keeps its rank even without a hypothetical
 * marker. Keyed by tool name; a family with no entry falls back to the shared
 * hypothetical markers only. Lexicons are kept for ALL 11 families as dormant
 * plumbing, but only DECROWD_ACTIVE_FAMILIES entries gate a demotion today.
 */
export const WHAT_IF_ACTION_TRIGGERS: ReadonlyMap<string, RegExp> = new Map([
  // corpus verbs: change/changing, bulk-update, set…to, simulate
  ['sfi.what_if_change_field_value', /\bchang(?:e|es|ed|ing)\b|\bbulk[- ]?updat(?:e|es|ed|ing)\b|\bset(?:s|ting)?\b/i],
  // corpus verbs: change (the type), convert, make…a <type>, data type
  ['sfi.what_if_change_field_type', /\bchang(?:e|es|ed|ing)\b|\bconvert(?:s|ed|ing)?\b|\bmak(?:e|es|ing)\b|\bmade\b|\bdata\s+type\b/i],
  // corpus verbs: delete, remove
  ['sfi.what_if_remove_picklist_value', /\bremov(?:e|es|ed|ing)\b|\bdelet(?:e|es|ed|ing)\b/i],
  // corpus verbs: make…required, mandatory, requiring, set…to required
  ['sfi.what_if_make_field_required', /\bmak(?:e|es|ing)\b|\bmade\b|\brequir(?:e|es|ed|ing)\b|\bmandatory\b/i],
  // corpus verbs: deactivate, turn off / turn it off, switch off
  ['sfi.what_if_deactivate_flow', /\bdeactivat(?:e|es|ed|ing)\b|\bturn(?:s|ed|ing)?\b[^.?!]{0,16}\boff\b|\bswitch(?:es|ed|ing)?\b[^.?!]{0,16}\boff\b/i],
  // corpus verbs: disable, turn off, was off
  ['sfi.what_if_disable_trigger', /\bdisabl(?:e|es|ed|ing)\b|\bturn(?:s|ed|ing)?\b[^.?!]{0,16}\boff\b|\bwas\s+off\b/i],
  // corpus verbs: change (signature), rename, add/remove a parameter
  ['sfi.what_if_change_method_signature', /\bsignature\b|\brenam(?:e|es|ed|ing)\b|\bchang(?:e|es|ed|ing)\b|\b(?:add|remove)\b[^.?!]{0,20}\bparameter\b/i],
  // corpus verbs/nouns: merge, combine, consolidate, conflicts, collisions
  ['sfi.what_if_merge_profiles', /\bmerg(?:e|es|ed|ing)\b|\bcombin(?:e|es|ed|ing)\b|\bconsolidat(?:e|es|ed|ing)\b|\bconflicts?\b|\bcollisions?\b/i],
  // corpus verbs: split, break…into
  ['sfi.what_if_split_profile', /\bsplit(?:s|ting)?\b|\bbreak\b[^.?!]{0,32}\binto\b/i],
  // corpus verbs: assign, grant, add, gain, give
  ['sfi.what_if_assign_permset', /\bassign(?:s|ed|ing)?\b|\bgrant(?:s|ed|ing)?\b|\badd(?:s|ed|ing)?\b|\bgain(?:s|ed|ing)?\b|\bgiv(?:e|es|ing)\b|\bgave\b/i],
  // corpus verbs: revoke, remove, unassign, strip, take away, lose/lost
  ['sfi.what_if_revoke_permset', /\brevok(?:e|es|ed|ing)\b|\bremov(?:e|es|ed|ing)\b|\bunassign(?:s|ed|ing)?\b|\bstrip(?:s|ped|ping)?\b|\btak(?:e|es|ing)\s+away\b|\btook\s+away\b|\blos(?:e|es|ing)\b|\blost\b/i],
]);

/** Does the question license this what_if tool to keep its shortlist rank? */
const whatIfTriggered = (tool: string, question: string): boolean =>
  WHAT_IF_HYPOTHETICAL_TRIGGERS.test(question) ||
  (WHAT_IF_ACTION_TRIGGERS.get(tool)?.test(question) ?? false);

/**
 * Demote every DECROWD_ACTIVE_FAMILIES candidate that (a) was NOT promoted by
 * the deterministic route (`fromRoute` rows are exempt — the regex route is a
 * coordinated plan) and (b) has no trigger token in the question, below all
 * other candidates. what_if families OUTSIDE the active set are never touched
 * (their demotion measured net-negative on the traces — see
 * DECROWD_ACTIVE_FAMILIES). Pure REORDER: scores/cosines are never touched
 * (the unrouted funnel-primary path keeps its pure-cosine invariant), rows are
 * never dropped, and kept rows preserve their relative order. Runs BEFORE
 * mode-reranking so an explicit `mode: 'plan'` (an action intent by
 * construction) still leads with the plan family.
 */
export const demoteUntriggeredWhatIfs = (
  cands: readonly ToolCandidate[],
  question: string,
): ToolCandidate[] => {
  const kept: ToolCandidate[] = [];
  const demoted: ToolCandidate[] = [];
  for (const candidate of cands) {
    const parasitic =
      DECROWD_ACTIVE_FAMILIES.has(candidate.tool) &&
      candidate.fromRoute !== true &&
      !whatIfTriggered(candidate.tool, question);
    (parasitic ? demoted : kept).push(candidate);
  }
  return [...kept, ...demoted];
};

/**
 * Build the ranked funnel candidates for a route + question: score the funnel,
 * fuse the regex route hints (I2b bounded bonus), then mode-rerank. Shared by
 * the I6 margin gate (which reads the top-2 to decide ambiguity), the
 * funnel-primary fallback (P2 §3), and the final response, so all see the
 * identical shortlist. LOAD-BEARING INVARIANT (P2 §4, pinned by test): for an
 * `unrouted`/`empty` intent the merge short-circuits, so this returns PURE
 * cosines — no regex bonus, no 0.25 floor mass, no `fromRoute` rows — which is
 * what makes FUNNEL_PRIMARY_MIN_SCORE a real semantic threshold. Exported for
 * that regression test.
 */
export const buildFunnelCandidates = (
  route: RouteResult,
  question: string,
  routeToolArgs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  mode: RouteQuestionInput['mode'],
): ToolCandidate[] => {
  const funnelLimit = mode !== undefined ? 12 : 8;
  return resolvePlaneTie(
    rerankForMode(
      // De-crowd AFTER the regex-hint fusion (so `fromRoute` rows are stamped
      // and exempt) and BEFORE the mode rerank + final slice(0, 8).
      demoteUntriggeredWhatIfs(
        mergeRouteHintsIntoCandidates(
          route,
          semanticCandidates(question, funnelLimit),
          routeToolArgs,
          funnelLimit,
        ),
        question,
      ),
      mode,
    ),
    question,
  );
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

// ---------------------------------------------------------------------------
// Stage 0 — refusal-shape gates (router-v2 P2 §2). Score-independent, run on
// the RAW question BEFORE classifyQuestion, in BOTH router modes: an
// imperative like "deactivate the X flow for me" must never reach the
// what-if simulator, whatever the host. A refusal is NEVER an executable
// route: `tools: []` is what makes it non-executable (`executionBlocked`
// stays false — that flag remains clarification-derived).
// ---------------------------------------------------------------------------

/** Stable intent label per refusal kind (new `route.intent` string values). */
const REFUSAL_INTENT: Readonly<Record<RefusalKind, string>> = {
  'write-imperative': 'refused-write',
  'injection-exfiltration': 'refused-injection',
  'identity-gap': 'honest-gap-identity',
  'forecast-gap': 'honest-gap-forecast',
  'provenance-gap': 'honest-gap-provenance',
  'runtime-analytics': 'honest-gap-runtime',
  'out-of-scope': 'out-of-scope',
};

/** Gap record per refusal kind, so `logGap: true` still records the demand. */
const REFUSAL_GAP: Readonly<Record<RefusalKind, NonNullable<RouteResult['gap']>>> = {
  'write-imperative': {
    category: 'write-request',
    note: 'org mutation requested; refused (read-only product)',
  },
  'injection-exfiltration': {
    category: 'injection',
    note: 'prompt-injection/exfiltration shape refused',
  },
  'identity-gap': {
    category: 'identity-gap',
    note: 'first-person capability ask; no session-user identity — declined with a which-user clarify pointer',
  },
  'forecast-gap': {
    category: 'forecast-gap',
    note: 'future/forecast ask; no time-series or forecasting model — honest gap, current snapshot offered',
  },
  'provenance-gap': {
    category: 'provenance-gap',
    note: 'creator/authorship ask; vault has LastModified, never CreatedBy — honest gap disclosed',
  },
  'runtime-analytics': {
    category: 'runtime-analytics',
    note: 'runtime/ops telemetry the product does not model; honest gap disclosed',
  },
  'out-of-scope': {
    category: 'out-of-scope',
    note: 'outside the Salesforce-metadata boundary; refused',
  },
};

/**
 * Assemble the full response for a refusal shape. Candidates ride along for
 * transparency (`tools: []` keeps the route non-executable) EXCEPT for
 * injection/exfiltration, which suppresses candidates and guidance entirely —
 * the one exception to candidates-for-transparency. Offline mode omits
 * candidates as always; the refusal itself (route shape + disclosure) is
 * mode-independent.
 */
const refusalResponse = async (
  ctx: Context,
  input: RouteQuestionInput,
  shape: RefusalShape,
): Promise<Result<McpResponse<RouteQuestionOutput>, McpError>> => {
  const wantCands = routerMode() === 'hybrid' && shape.kind !== 'injection-exfiltration';
  const cands = wantCands
    ? rerankForMode(semanticCandidates(input.question, input.mode !== undefined ? 12 : 8), input.mode)
    : [];
  // The runtime honest-gap discloses its nearest reads inline, so the text is
  // self-contained even for a host that never renders the candidate list.
  const disclosure =
    shape.kind === 'runtime-analytics' && cands.length > 0
      ? `${shape.disclosure} Nearest reads: ${cands.slice(0, 3).map((c) => c.tool).join(', ')}.`
      : shape.disclosure;
  const refusal: RefusalShape = { ...shape, disclosure };
  const route: RouteResult = {
    question: input.question,
    plane: 'unknown',
    intent: REFUSAL_INTENT[shape.kind],
    tools: [],
    liveRequired: false,
    needsResolve: false,
    reason: disclosure,
    gap: REFUSAL_GAP[shape.kind],
    confidence: 'high', // confident IN the refusal, not in any tool
    risk: 'informational',
    alternatives: [],
    clarification: null,
    plan: [],
    refusal,
  };
  const logged =
    input.logGap === true ? await logGapIfAny(route, undefined, ctx.vaultRoot) : null;
  const guidance = wantCands
    ? `${disclosure} Do not execute any tool to satisfy the refused action.`
    : undefined;
  return ok({
    data: {
      route,
      executionBlocked: false,
      gapLogged: logged !== null,
      rendered:
        cands.length > 0
          ? `${renderRouteMarkdown(route)}\n\n**Candidate tools (transparency only — the request itself is refused/gapped; do not execute them to satisfy it):** ${cands
              .map((c) => c.tool)
              .join(', ')}`
          : renderRouteMarkdown(route),
      trust: routeTrust(),
      ...(cands.length > 0 ? { toolCandidates: cands } : {}),
      ...(guidance !== undefined ? { guidance } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// Router-v2 P5 — host-passed conversation context. All of the helpers below
// run ONLY under `input.context !== undefined` guards in the handler; the
// no-context path never touches them (byte-identical requirement).
// ---------------------------------------------------------------------------

/** Minimal resolved-entity shape the context arg-binding needs. */
interface ContextWinner {
  readonly id: string;
  readonly type: string;
  readonly apiName: string;
  readonly parentApiName: string | null;
}

/**
 * Save-order primaries take an OBJECT api name, keyed by TOOL because a
 * context continuation's intent is `context-continuation`, not a save-order
 * intent name.
 */
const CONTEXT_SAVE_ORDER_TOOLS: ReadonlySet<string> = new Set([
  'sfi.what_happens_on_save',
  'sfi.order_of_execution',
]);

/**
 * Known non-default argument keys for context binding — the same
 * never-guess-a-key principle as `selectedEntityArgsForRoute`: keys listed
 * here are the tool's REAL Zod input key; everything else falls back to the
 * `componentId` default of the advisory-args logic.
 */
const CONTEXT_TOOL_ARG_KEYS: ReadonlyMap<string, string> = new Map([
  ['sfi.field_access_audit', 'fieldId'],
  ['sfi.safe_to_delete_field', 'fieldId'],
  ['sfi.field_360', 'fieldId'],
  ['sfi.field_lineage', 'fieldId'],
  ['sfi.explain_field', 'fieldId'],
  ['sfi.explain_flow', 'flowId'],
]);

/**
 * Generic schema/list intents a re-parameterization anchor may override when
 * the route is NOT high-confidence: they answer "what is there", so "what
 * about on Contact?" re-running the PREVIOUS tool is the likelier reading.
 * A confident intent match is never overridden (the self-contained negative).
 */
const GENERIC_SCHEMA_INTENTS: ReadonlySet<string> = new Set([
  'schema',
  'metadata-count',
  'component-lookup',
]);

/**
 * Bind a context-substituted entity to the route's primary tool using the
 * advisory-args key logic (P5 §2a): `objectApiName` (the id's object) for the
 * save-order family, the tool's known key where we have it (fieldId/flowId),
 * `componentId` otherwise. Returns null when no binding is derivable (e.g. a
 * field-less object for a save-order tool) — never guess.
 */
const contextArgsFor = (
  route: RouteResult,
  winner: ContextWinner,
): Readonly<Record<string, unknown>> | null => {
  const primary = route.tools.find((tool) => !ROUTE_PREAMBLE_TOOLS.has(tool));
  if (primary === undefined) return null;
  if (SAVE_ORDER_INTENTS.has(route.intent) || CONTEXT_SAVE_ORDER_TOOLS.has(primary)) {
    const objectApiName =
      winner.type === 'CustomObject' ? winner.apiName : winner.parentApiName;
    if (objectApiName === null || objectApiName === undefined) return null;
    return { ...(route.suggestedArgs ?? {}), objectApiName };
  }
  const key = CONTEXT_TOOL_ARG_KEYS.get(primary) ?? 'componentId';
  return { ...(route.suggestedArgs ?? {}), [key]: winner.id };
};

/**
 * Build a CONTEXT-CONTINUATION route (P5 §2b/2c): the previous turn's tool
 * re-run for this follow-up, with the substituted/new entity bound per the
 * advisory-args logic. Plane and liveRequired always come from the live tool
 * registry (`resolveCandidatePlane`), NEVER from `previous.plane`.
 * `applyComponentTypeGuard` runs on the result; if the primary tool is still
 * type-incompatible with the entity afterwards (e.g. explain_flow inherited
 * against an ApexClass id — a mismatch the Flow-only guard table cannot fix),
 * returns null so the caller falls THROUGH to funnel-primary — never an
 * executable tool bound to an id that guarantees a hard error.
 * Confidence: `medium` when the entity resolved exact AND the tool passed the
 * guard unchanged; `low` otherwise. Never `high` — a context route is advisory.
 */
const buildContextContinuation = (
  question: string,
  inheritedTool: string,
  winner: ContextWinner | null,
  anaphor: string,
  prependResolve: boolean,
): RouteResult | null => {
  const entry = resolveCandidatePlane(inheritedTool);
  const tools = prependResolve ? ['sfi.resolve', inheritedTool] : [inheritedTool];
  const base: RouteResult = {
    question,
    plane: entry.plane,
    intent: 'context-continuation',
    tools,
    liveRequired: entry.liveRequired,
    needsResolve: prependResolve,
    reason:
      `CONTEXT-DERIVED (advisory): no deterministic intent matched this follow-up on its ` +
      `own; '${anaphor}' was resolved from host-passed conversation context` +
      (winner !== null ? ` to ${winner.id}` : '') +
      `, and the previous turn's tool ${inheritedTool} was inherited. Verify the pick, ` +
      `resolve any named component first, and ground with sfi.synthesize_answer.`,
    gap: null,
    confidence: 'low',
    risk: DESTRUCTIVE_TOOL.test(inheritedTool) ? 'destructive' : 'informational',
    alternatives: [],
    clarification: null,
    plan: [{
      stepId: 'step-1',
      dependsOn: [],
      question,
      intent: 'context-continuation',
      plane: entry.plane,
      tools,
    }],
  };
  const boundArgs = winner !== null ? contextArgsFor(base, winner) : null;
  const withArgs = boundArgs !== null ? { ...base, suggestedArgs: boundArgs } : base;
  const guarded = applyComponentTypeGuard(withArgs, winner?.type ?? null);
  const primary = guarded.tools.find((tool) => !ROUTE_PREAMBLE_TOOLS.has(tool));
  if (primary === undefined) return null;
  if (winner !== null && !continuationToolCompatible(primary, winner.type)) {
    return null;
  }
  const passedGuardUnchanged = primary === inheritedTool;
  const finalEntry = resolveCandidatePlane(primary);
  return {
    ...guarded,
    plane: finalEntry.plane,
    liveRequired: finalEntry.liveRequired,
    confidence: winner !== null && passedGuardUnchanged ? 'medium' : 'low',
    risk: DESTRUCTIVE_TOOL.test(primary) ? 'destructive' : 'informational',
    plan: guarded.plan.map((step) => ({ ...step, plane: finalEntry.plane })),
  };
};

export const routeQuestionHandler = async (
  ctx: Context,
  input: RouteQuestionInput,
): Promise<Result<McpResponse<RouteQuestionOutput>, McpError>> => {
  // Stage 0 — refusal-shape gates FIRST (P2 §1): a hit short-circuits
  // everything (no entity resolve, no margin gate, no funnel-primary). Gates
  // run on the WHOLE question, so a compound turn with a refusal clause
  // refuses the whole turn.
  const refusalShape = detectRefusalShape(input.question);
  if (refusalShape !== null) {
    if (input.clarificationResponse !== undefined) {
      // Same contract as any question with no active clarification challenge.
      return err({
        kind: 'invalid-query',
        message:
          'clarificationResponse was supplied, but this question has no active clarification challenge. Route the question again without a response.',
        path: 'clarificationResponse',
      });
    }
    return refusalResponse(ctx, input, refusalShape);
  }

  // -------------------------------------------------------------------------
  // Router-v2 P5 — host-passed conversation context. The product is
  // STATELESS: the host passes what the previous turn was about; nothing is
  // stored server-side. Everything below is inside `input.context` guards —
  // `context` absent keeps every code path byte-identical to today. Refusal
  // gates already ran on the RAW text above: context never bypasses them, and
  // a refused follow-up returns before any context logic (contextApplied
  // absent). Value validation is FAIL-OPEN: a stale tool / malformed id is
  // ignored with a note, never a hard error.
  // -------------------------------------------------------------------------
  const contextInput = input.context;
  const validatedContext: ValidatedContext | null =
    contextInput !== undefined
      ? validatePreviousContext(contextInput.previous, (tool) =>
          getPlaneByTool().has(tool),
        )
      : null;

  // (P5 §2d) CLARIFICATION CONTINUATION — the question is an ordinal /
  // descriptor pick ("the second one", "the Contact one") against the prior
  // turn's open clarification. Map it to the offered option and re-dispatch
  // INTERNALLY through the FULL handler (recursion depth 1 — the inner call
  // carries no context), so every existing validation applies unchanged: the
  // id must hash-match previous.question + vault state (stale ⇒ the existing
  // stale-id error), the selection must be an offered option. 0 or ≥2
  // descriptor matches / an out-of-range ordinal re-asks the prior
  // clarification — NEVER guess. This is the ONLY use of `previous.question`.
  if (
    validatedContext !== null &&
    validatedContext.previous.clarification !== undefined &&
    validatedContext.previous.question !== undefined &&
    input.clarificationResponse === undefined
  ) {
    const selected = detectClarificationSelection(
      input.question,
      validatedContext.previous.clarification.options,
    );
    if (selected !== null) {
      const inner =
        selected.kind === 'selected'
          ? await routeQuestionHandler(ctx, {
              question: validatedContext.previous.question,
              clarificationResponse: {
                clarificationId:
                  validatedContext.previous.clarification.clarificationId,
                selection: selected.selection,
              },
            })
          : await routeQuestionHandler(ctx, {
              question: validatedContext.previous.question,
            });
      if (!inner.ok) return inner;
      const contextApplied: RouteContextApplied = {
        kind: 'clarification-selection',
        anaphor: selected.anaphor,
        from: 'previous.clarification',
        ...(selected.kind === 'selected' ? { selection: selected.selection } : {}),
        ...(validatedContext.ignored.length > 0
          ? { ignored: validatedContext.ignored }
          : {}),
      };
      return ok({
        ...inner.value,
        data: {
          ...inner.value.data,
          route: { ...inner.value.data.route, contextApplied },
          rendered: `${inner.value.data.rendered}\n\n${renderContextApplied(contextApplied)}`,
        },
      });
    }
  }

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
  // Save-order/automation intents take an OBJECT. Their phrasings are full of
  // bare schema nouns ("the Contact trigger", "every trigger, flow, and
  // validation rule") that are intent signals, not component names — fed to
  // the fuzzy resolver they produce a menu of unrelated ApexTriggers and block
  // a perfectly clear question (eval family A). Resolve exactly the object the
  // routed tool needs (already derived into suggestedArgs), or nothing.
  const saveOrderIntent = SAVE_ORDER_INTENTS.has(route.intent);
  const suggestedObject = route.suggestedArgs?.['objectApiName'];
  // RESIDUAL 1: for a single-entity explain/fetch, a trailing comparison aside
  // ("…, is it the same as the bar calc?") is rhetoric about the SAME answer,
  // not a second component — strip it before extraction so it cannot seed a
  // rival entity and turn a clean route into an ambiguity block.
  const entityExtractionSource = stripComparisonAside(input.question, route.intent);
  let entityQuery = !route.needsResolve
    ? null
    : saveOrderIntent
      ? (typeof suggestedObject === 'string' ? suggestedObject : null)
      : extractEntityQuery(entityExtractionSource, route.intent);
  let entityTypes: readonly ComponentType[] =
    entityQuery === null
      ? []
      : saveOrderIntent
        ? ['CustomObject']
        : inferEntityTypes(entityQuery, route.intent, input.question);

  // (P5 §2a) ENTITY SUBSTITUTION — a PRONOUN anchor with NO real entity of the
  // question's own ("does it fire on delete too") is filled from host-passed
  // context. If the question's OWN extraction found a real phrase, context
  // does NOT touch it (the self-contained negative). The carried componentId
  // is resolved by EXACT id (never fuzzy): found ⇒ it feeds in as the refined
  // entity resolution so everything downstream (type guard, premise check,
  // arg binding) is unchanged code; missing ⇒ a context-specific premise flag
  // below blocks stages 6.5 and 7 — stale context must never advisory-route.
  const pronounAnchor =
    validatedContext !== null ? detectPronounAnchor(input.question) : null;
  let contextExactResolution: ResolveResult | null = null;
  let contextSubstitution:
    | { readonly anaphor: string; readonly from: 'previous.componentId' | 'previous.objectApiName' }
    | null = null;
  let contextGhostComponentId: string | null = null;
  if (
    pronounAnchor !== null &&
    validatedContext !== null &&
    (entityQuery === null || isAnaphorOnly(entityQuery))
  ) {
    const previous = validatedContext.previous;
    if (saveOrderIntent && previous.objectApiName !== undefined) {
      // Save-order intents take an OBJECT api name: substitute it through the
      // normal resolve path, exactly like a question-derived object.
      entityQuery = previous.objectApiName;
      entityTypes = ['CustomObject'];
      contextSubstitution = { anaphor: pronounAnchor, from: 'previous.objectApiName' };
    } else if (!saveOrderIntent && previous.componentId !== undefined) {
      const carried = await getNodeById(
        ctx.graph,
        previous.componentId as ComponentId,
      );
      if (carried.ok && carried.value !== null) {
        const node = carried.value;
        contextExactResolution = {
          disposition: 'exact',
          candidates: [{
            id: node.id,
            type: node.type,
            apiName: node.apiName,
            label: node.label,
            parentApiName:
              node.parentId === null
                ? null
                : node.parentId.slice(node.parentId.indexOf(':') + 1),
            score: 1,
            base: 1,
            matchKind: 'exact',
            nameCoverage: 1,
            evidence: `context: exact id carried from the previous turn (${node.id})`,
          }],
          queryTokens: [],
        };
        entityQuery = node.apiName;
        entityTypes = [node.type];
        contextSubstitution = { anaphor: pronounAnchor, from: 'previous.componentId' };
      } else if (carried.ok) {
        contextGhostComponentId = previous.componentId;
      }
      // A graph read error is FAIL-OPEN: context simply is not applied.
    }
  }

  const entityResolution = entityQuery !== null && contextExactResolution === null
    ? await resolveComponents(ctx.graph, entityQuery, {
        limit: 5,
        ...(entityTypes.length > 0 ? { types: entityTypes } : {}),
      })
    : null;
  const glossaryAwareEntityResolution =
    entityQuery !== null && entityResolution?.ok === true
      ? await applyGlossaryAliases(ctx, entityQuery, entityTypes, entityResolution.value)
      : null;
  // `let`: the stage-6 premise check may REPLACE a type-scoped `none` with the
  // unscoped resolution when the name exists as a DIFFERENT component family
  // (the type-confusion premise) — stages 6.5/7 then see the real component.
  let refinedEntityResolution =
    contextExactResolution ??
    (entityQuery !== null && glossaryAwareEntityResolution !== null
      ? resolveParentQualifier(
          input.question,
          refineEntityResolution(entityQuery, glossaryAwareEntityResolution),
        )
      : null);
  const entityClarificationRequired =
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    // component-type asks ("is X a flow or a trigger?") are EXEMPT: a
    // same-name cross-type collision is the ANSWER to that question, not an
    // obstacle — sfi.resolve enumerates the types and the host explains.
    route.intent !== 'component-type' &&
    entityAmbiguityRequiresClarification(
      entityQuery,
      refinedEntityResolution,
      input.question,
      routeTargetsSingleComponent(route),
    );
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
        // P4 option hygiene (fuzzy grazes / far-below-top rivals are junk),
        // with the R4 same-name fallback so a genuine same-name family whose
        // match reads `fuzzy` (the narrow-clarify shape) still offers ≥2 picks.
        options: clarificationOptionIds(refinedEntityResolution?.candidates ?? []),
      },
    };
  } else if (
    entityEvidence?.disposition === 'ambiguous' &&
    route.clarification === null
  ) {
    route = { ...route, confidence: 'medium' };
  } else if (
    route.intent === 'component-lookup' &&
    route.clarification !== null &&
    refinedEntityResolution?.disposition === 'exact'
  ) {
    // The resolve-fallback blocked on a whole-phrase ambiguity, but the
    // NARROW entity extraction resolved EXACT (e.g. a dotted
    // `Object.Field__c` reference inside a 3-token phrase). The specific
    // reference wins over the phrase-level noise — clear the block.
    const winner = refinedEntityResolution.candidates[0]!;
    route = {
      ...route,
      confidence: 'high',
      clarification: null,
      suggestedArgs: { ...(route.suggestedArgs ?? {}), componentId: winner.id },
    };
  }

  // Eval family B — the resolved TYPE gates the routed tools. When the entity
  // resolves to a Flow (exact, or ambiguous with no candidate the guarded
  // tools could accept), a route carrying Apex-/object-/field-only tools
  // would hard-error, so swap in the Flow-appropriate tools BEFORE the args
  // map, the funnel fusion, and the margin gate see the route.
  route = applyComponentTypeGuard(
    route,
    resolvedTypeForGuard(route, refinedEntityResolution),
  );

  // (P5 §2a) bind the context-substituted entity into suggestedArgs with the
  // advisory-args key logic, so a MATCHED intent's tool runs against the
  // carried entity without the host re-deriving it. Records the substitution
  // for the `contextApplied` disclosure. Unrouted questions bind in stage 6.5
  // instead (context continuation), never here.
  let contextEntityApplied: RouteContextApplied | null = null;
  if (
    contextSubstitution !== null &&
    route.intent !== 'unrouted' &&
    refinedEntityResolution?.disposition === 'exact'
  ) {
    const winner = refinedEntityResolution.candidates[0]!;
    const bound = contextArgsFor(route, winner);
    if (bound !== null) {
      route = { ...route, suggestedArgs: bound };
      contextEntityApplied = {
        kind: 'entity-substitution',
        anaphor: contextSubstitution.anaphor,
        substitutedComponentId: winner.id,
        from: contextSubstitution.from,
      };
    }
  }

  // I6 — margin-based clarification. Only in hybrid mode (candidates exist).
  // Runs BEFORE the clarificationId is stamped so a tool-choice clarification
  // participates in the stateless continuation contract exactly like an intent
  // or entity clarification. Reuses the same routeToolArgs/candidates the final
  // response returns, so the gate and the shortlist can never disagree.
  const marginRouteToolArgs = await buildRouteToolArgsMap(route, ctx);
  // The margin gate targets FUNNEL-primary ties the deterministic route did not
  // confidently resolve. When the route already placed the question at HIGH
  // confidence, a close NON-route funnel candidate is noise, not a genuine
  // choice — clarifying there re-introduces the round-trip cost on a clear
  // question (e.g. "how many users assigned to profile X" is a confident live
  // count; a spuriously-close vault rival cannot answer it at all). Trust a
  // confident deterministic route; only gate the lower-confidence funnel ties.
  if (routerMode() === 'hybrid' && route.confidence !== 'high') {
    const gateCandidates = buildFunnelCandidates(
      route,
      input.question,
      marginRouteToolArgs,
      input.mode,
    );
    const marginClar = marginClarification(gateCandidates, route.clarification);
    if (marginClar !== null) {
      route = { ...route, confidence: 'low', clarification: marginClar };
    }
  }

  // COMPOUND VAULT+LIVE gate (router-v2 R2): the question carries an explicit
  // metadata ask AND an explicit live-runtime ask in one breath ("what breaks
  // AND is it actually running in production", "the schema AND how many
  // records right now"). That is a genuine plane choice, independent of the
  // funnel margin — offer the leading candidate of each plane as a tool-choice
  // clarification (same continuation contract as the I6 gate: the selection
  // pins that tool). Runs at any confidence — a confident single-plane route
  // over a two-plane ask is precisely the failure this catches.
  if (
    routerMode() === 'hybrid' &&
    route.clarification === null &&
    isCompoundPlaneAsk(input.question)
  ) {
    const compoundCands = buildFunnelCandidates(
      route,
      input.question,
      marginRouteToolArgs,
      input.mode,
    );
    const vaultTop = compoundCands.find((candidate) => candidate.plane === 'vault');
    // A vault-dominated shortlist can carry no live rival at all ("is the
    // trigger safe to disable AND is it actually running in production" ranks
    // impact tools 1..8). The runtime-verification half still needs a live
    // tool to offer — fall back to the canonical execution-trace tool when
    // the live half speaks of something running/firing.
    const liveTop =
      compoundCands.find(
        (candidate) => candidate.plane === 'live' || candidate.plane === 'hybrid',
      ) ??
      (/\b(?:running|firing|executing|fired?|ran)\b/i.test(input.question)
        ? { tool: 'sfi.live_automation_fired' }
        : undefined);
    if (vaultTop !== undefined && liveTop !== undefined) {
      route = {
        ...route,
        confidence: 'low',
        clarification: {
          required: true,
          question:
            `This asks for BOTH a vault-metadata answer AND a live-org verification — ` +
            `\`${vaultTop.tool}\` answers from the offline vault; \`${liveTop.tool}\` ` +
            `queries the org right now and needs the opt-in live plane. Which should ` +
            `lead? (Pick one; the other can run as a follow-up.)`,
          options: [vaultTop.tool, liveTop.tool],
        },
      };
    }
  }

  // Tracks whether either FALSE-PREMISE branch below disclosed: the contract
  // order "refusal → premise → intent" is realized logically, not by moving
  // code — the stage-6 premise verdict recorded here blocks funnel-primary
  // (stage 7) before it can advisory-route an existence-negative (P2 §1/§3).
  let premiseFlagged = false;
  // Eval family E — FALSE PREMISE. The question NAMED a specific entity but the
  // resolver found nothing (disposition `none`): the route must not present as
  // clean + high-confidence, or the host answers as if the component exists.
  // Downgrade confidence and attach a premise disclosure — but keep routing:
  // the routed tool fails closed on an unknown id (the honesty stack is
  // unchanged), so this is a warning, never an execution block. Runs AFTER the
  // margin gate on purpose: the gate's inputs stay identical to a resolvable
  // question, so a premise problem never manufactures a tool-choice tie.
  if (
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    refinedEntityResolution.disposition === 'none'
  ) {
    // The extracted query can carry a schema noun the graph resolver does not
    // strip ("PaymentProcessor class"): retry the BARE name before flagging,
    // so a real component is never accused of not existing over a type word.
    const bareQuery = entityQuery
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(
        /\s+(?:class(?:es)?|trigger(?:s)?|field(?:s)?|object(?:s)?|flow(?:s)?|component(?:s)?|layout(?:s)?|profile(?:s)?|report(?:s)?|dashboard(?:s)?|rule(?:s)?)$/i,
        '',
      );
    const bareRetry =
      bareQuery !== entityQuery && bareQuery.length > 0
        ? await resolveComponents(ctx.graph, bareQuery, {
            limit: 5,
            ...(entityTypes.length > 0 ? { types: entityTypes } : {}),
          })
        : null;
    const bareResolution =
      bareRetry?.ok === true && bareRetry.value.disposition !== 'none'
        ? bareRetry.value
        : null;
    // TYPE-CONFUSION PREMISE (router-v2 R2): the resolve was TYPE-SCOPED
    // ("the <X> permission set") and found nothing under that type. Before
    // declaring the component nonexistent, retry UNSCOPED: when the name is a
    // strong match under a DIFFERENT family (a validation rule the user
    // called a permission set, a flow they called an object), the premise
    // error is the STATED TYPE, not existence — disclose the real type and
    // keep routing on the component that actually exists. A weak/absent
    // unscoped match falls through to the existence premise flag unchanged.
    let crossTypeResolution: ResolveResult | null = null;
    if (bareResolution === null && entityTypes.length > 0) {
      const unscopedQuery = bareQuery.length > 0 ? bareQuery : entityQuery;
      const unscopedRetry = await resolveComponents(ctx.graph, unscopedQuery, { limit: 5 });
      if (
        unscopedRetry.ok &&
        unscopedRetry.value.disposition !== 'none' &&
        (unscopedRetry.value.candidates[0]?.base ?? 0) >= 0.9
      ) {
        crossTypeResolution = unscopedRetry.value;
      }
    }
    if (crossTypeResolution !== null) {
      const real = crossTypeResolution.candidates[0]!;
      const statedTypes = entityTypes.join('/');
      const typeWarning =
        `TYPE CHECK: no ${statedTypes} named '${entityQuery}' exists in the vault, but the name ` +
        `matches ${real.id} (a ${real.type}). The question's stated component type appears to be ` +
        `wrong — answer about the component that actually exists, and say so.`;
      route = {
        ...route,
        confidence: 'low',
        reason: `${route.reason} ${typeWarning}`,
      };
      // Feed the REAL component to stages 6.5/7 (type guard, advisory
      // type-filter, arg binding) so downstream behaves as if the user had
      // named the right family.
      refinedEntityResolution = crossTypeResolution;
      entityEvidence = {
        query: entityQuery,
        typeHints: entityTypes,
        disposition: crossTypeResolution.disposition,
        clarificationRequired: false,
        warning: typeWarning,
        candidates: crossTypeResolution.candidates.slice(0, 5).map((candidate) => ({
          componentId: candidate.id,
          type: candidate.type,
          apiName: candidate.apiName,
          label: candidate.label,
          parentApiName: candidate.parentApiName,
          score: candidate.score,
          base: candidate.base,
          matchKind: candidate.matchKind,
          evidence: candidate.evidence,
        })),
      };
    } else if (bareResolution !== null) {
      // The bare name IS real — surface it as evidence instead of a premise flag.
      entityEvidence = {
        query: bareQuery,
        typeHints: entityTypes,
        disposition: bareResolution.disposition,
        clarificationRequired: false,
        warning:
          bareResolution.disposition === 'ambiguous'
            ? 'Possible component matches were found, but none is strong enough to interrupt routing. Resolve the component before executing a component-specific analysis.'
            : null,
        candidates: bareResolution.candidates.slice(0, 5).map((candidate) => ({
          componentId: candidate.id,
          type: candidate.type,
          apiName: candidate.apiName,
          label: candidate.label,
          parentApiName: candidate.parentApiName,
          score: candidate.score,
          base: candidate.base,
          matchKind: candidate.matchKind,
          evidence: candidate.evidence,
        })),
      };
    } else if (looksLikeComponentName(entityQuery)) {
      premiseFlagged = true;
      const premiseWarning =
        `PREMISE CHECK: no component matching '${entityQuery}' exists in the vault — ` +
        `verify the name (a typo, or metadata newer than the last refresh; /sfi-refresh may help). ` +
        `The routed tool fails closed on an unknown component; do not present its error as an answer about a real component.`;
      route = {
        ...route,
        confidence: 'low',
        reason: `${route.reason} ${premiseWarning}`,
      };
      entityEvidence = {
        query: entityQuery,
        typeHints: entityTypes,
        disposition: 'none',
        clarificationRequired: false,
        warning: premiseWarning,
        candidates: [],
      };
    } else {
      // PROSE-SHAPED extraction (R3 funnel-primary firing bug): the extractor
      // scraped a sentence fragment, not a name the user asserted — a `none`
      // resolve on junk is NOT a false premise. Record the evidence without a
      // warning and WITHOUT premiseFlagged, so stage 7 stays reachable. Real
      // ghost names (underscored, CamelCase, Title Case) still flag above.
      entityEvidence = {
        query: entityQuery,
        typeHints: entityTypes,
        disposition: 'none',
        clarificationRequired: false,
        warning: null,
        candidates: [],
      };
    }
  } else if (
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    refinedEntityResolution.disposition === 'ambiguous' &&
    (/__(?:c|mdt|e|x|b|kav)\b/i.test(entityQuery) || entityQuery.includes('.')) &&
    !refinedEntityResolution.candidates.some(
      (candidate) =>
        candidate.apiName.toLowerCase() === entityQuery.toLowerCase() ||
        candidate.id.toLowerCase().endsWith(`:${entityQuery.toLowerCase()}`),
    )
  ) {
    // Same FALSE-PREMISE family, literal form: a dotted / suffixed API
    // reference ("Case.F__c", "F__c") is an unambiguous NAME, and
    // refineEntityResolution already promotes a literal hit to exact — so an
    // ambiguous literal means the NAMED component does not exist and the
    // rivals are merely fuzzy lookalikes. Large vaults almost never return
    // `none` (something always fuzzy-matches), so without this branch a
    // literal false premise presented as a routine weak-match warning. Keep
    // the lookalikes as suggestions; downgrade and disclose.
    premiseFlagged = true;
    const premiseWarning =
      `PREMISE CHECK: no component named '${entityQuery}' exists in the vault — the listed ` +
      `candidates are fuzzy lookalikes, not the component you named. Verify the name ` +
      `(a typo, or metadata newer than the last refresh; /sfi-refresh may help). ` +
      `The routed tool fails closed on an unknown component; do not present its error as an answer about a real component.`;
    route = {
      ...route,
      confidence: 'low',
      reason: `${route.reason} ${premiseWarning}`,
    };
    if (entityEvidence !== undefined) {
      entityEvidence = { ...entityEvidence, warning: premiseWarning };
    }
  }

  // (P5 §3) CONTEXT PREMISE — the componentId carried from the previous turn
  // no longer resolves (deleted, renamed, or newer than the last refresh).
  // Same FALSE-PREMISE family, context-specific disclosure: the flag blocks
  // stage 6.5 AND stage 7 exactly as premise flags do today — stale context
  // must never advisory-route.
  if (contextGhostComponentId !== null) {
    premiseFlagged = true;
    const premiseWarning =
      `PREMISE CHECK: the component carried from the previous turn ` +
      `(${contextGhostComponentId}) no longer exists in the vault (deleted, renamed, ` +
      `or newer than the last refresh; /sfi-refresh may help). Do not answer as if it ` +
      `exists — re-ask with the component named explicitly.`;
    route = {
      ...route,
      confidence: 'low',
      reason: `${route.reason} ${premiseWarning}`,
    };
    entityEvidence = {
      query: contextGhostComponentId,
      typeHints: [],
      disposition: 'none',
      clarificationRequired: false,
      warning: premiseWarning,
      candidates: [],
    };
  }

  // R3 §5b — PRE-ROUTE EXISTENCE GATE: the question names an api-shaped
  // component (custom-suffixed or multi-part underscored) but no stage above
  // resolved it (the intent carried no entity extraction, or extraction found
  // nothing) — the 23-question false-premise over-route cluster committed
  // clean routes exactly here. Probe the name pre-commit: no literal match in
  // the vault ⇒ the same premise flag as a resolved `none` (downgrade +
  // disclosure + nearest matches as explicitly-labeled lookalikes), which
  // also blocks the stage-7 advisory upgrade. A resolvable name passes
  // untouched, so this costs no recall (0 of the 400 labeled misses were
  // premise-flagged). Dotted standard references are never probed (see
  // extractExistenceProbeToken).
  if (
    !premiseFlagged &&
    entityQuery === null &&
    route.clarification === null &&
    route.intent !== 'empty' &&
    route.intent !== 'component-lookup'
  ) {
    const probeToken = extractExistenceProbeToken(input.question);
    if (probeToken !== null) {
      const probe = await resolveComponents(ctx.graph, probeToken, { limit: 5 });
      if (probe.ok) {
        const lowered = probeToken.toLowerCase();
        const loose = normLiteral(probeToken);
        const literalHit = probe.value.candidates.some(
          (candidate) =>
            candidate.apiName.toLowerCase() === lowered ||
            candidate.id.toLowerCase().endsWith(`:${lowered}`) ||
            normLiteral(candidate.apiName) === loose,
        );
        if (probe.value.disposition === 'none' || !literalHit) {
          premiseFlagged = true;
          const premiseWarning =
            `PREMISE CHECK: no component named '${probeToken}' exists in the vault — any ` +
            `listed candidates are fuzzy lookalikes, not the component you named. Verify the name ` +
            `(a typo, or metadata newer than the last refresh; /sfi-refresh may help). ` +
            `The routed tool fails closed on an unknown component; do not present its error as an answer about a real component.`;
          route = {
            ...route,
            confidence: 'low',
            reason: `${route.reason} ${premiseWarning}`,
          };
          entityEvidence = {
            query: probeToken,
            typeHints: [],
            disposition: 'none',
            clarificationRequired: false,
            warning: premiseWarning,
            candidates: probe.value.candidates.slice(0, 5).map((candidate) => ({
              componentId: candidate.id,
              type: candidate.type,
              apiName: candidate.apiName,
              label: candidate.label,
              parentApiName: candidate.parentApiName,
              score: candidate.score,
              base: candidate.base,
              matchKind: candidate.matchKind,
              evidence: candidate.evidence,
            })),
          };
        }
      }
    }
  }

  // Stage 6.5 — CONTEXT CONTINUATION / RE-PARAMETERIZATION (router-v2 P5
  // §2b/2c), immediately BEFORE funnel-primary and gated identically (no
  // clarification, clean premise) plus the context-specific conditions.
  // When 6.5 fires the intent leaves `unrouted`, so stage 7 is skipped; when
  // it does not, stage 7 behaves exactly as today.
  let contextRouteApplied: RouteContextApplied | null = null;
  if (validatedContext !== null && route.clarification === null && !premiseFlagged) {
    const previous = validatedContext.previous;
    const stillUnrouted = route.intent === 'unrouted' && route.plane === 'unknown';
    // GAP DETECTION BEFORE CONTINUATION (round-2 honesty seam 2, mirroring
    // how refusal gates precede all context logic at stage 0): a follow-up
    // that is ITSELF gap-shaped — a judgment ("should they be able to?"),
    // delivery ("as a file?"), tool-self-capability, or deployment-status ask
    // about the carried component — must NOT inherit the previous turn's
    // tool. It becomes a non-executable honest-gap route instead; both
    // continuation arms below are skipped (the guard on each). Only reachable
    // when the question is STILL unrouted deterministically, so a follow-up
    // with its own real route ("is it safe to delete?") is never touched.
    const gapFollowUpFamily = stillUnrouted
      ? detectGapShapedFollowUp(input.question)
      : null;
    if (gapFollowUpFamily !== null) {
      const gapDescription: Record<string, string> = {
        judgment:
          'a normative judgment (should/normal/risky) — sf-intelligence reads org metadata and has no opinion to offer',
        delivery:
          'file export or message delivery, which the product does not perform',
        'tool-self-capability':
          "the product's own capability boundary — sfi.capabilities answers what is and is not built",
        'deployment-status':
          'deployment/pending-change status, runtime telemetry the vault does not model',
        'runtime-analytics':
          'runtime org data (login history, API-call logs, approval-instance history, record field-history, subscription recipients, chatter posts, sandbox-refresh/deployment logs, or execution traces) — this is live runtime telemetry, not vault metadata',
      };
      const carried =
        previous.componentId !== undefined
          ? ` The component carried from the previous turn (${previous.componentId}) was noted but the previous tool was NOT inherited — inheriting it would execute a read that cannot answer this ask.`
          : '';
      route = {
        question: input.question,
        plane: 'unknown',
        intent: 'context-gap-followup',
        tools: [],
        liveRequired: false,
        needsResolve: false,
        reason:
          `HONEST GAP (context follow-up): this follow-up asks for ` +
          `${gapDescription[gapFollowUpFamily] ?? gapFollowUpFamily}.${carried}`,
        gap: {
          category: 'context-gap-followup',
          note: `gap-shaped follow-up (${gapFollowUpFamily}); context continuation suppressed rather than inheriting the previous tool`,
        },
        confidence: 'high',
        risk: 'informational',
        alternatives: [],
        clarification: null,
        plan: [],
      };
    }
    const reparamAnchor =
      gapFollowUpFamily !== null ? null : detectReparamAnchor(input.question);
    // (c) RE-PARAMETERIZATION — a REPARAM anchor re-asks the PREVIOUS tool
    // against a NEW target ("what about on Contact?"). Only from a weak own
    // route: `unrouted`, or a generic schema/list intent below high
    // confidence — a CONFIDENT self-contained route ignores context.
    const ownRouteWeak =
      stillUnrouted ||
      (GENERIC_SCHEMA_INTENTS.has(route.intent) && route.confidence !== 'high');
    if (reparamAnchor !== null && ownRouteWeak && previous.tool !== undefined) {
      // The new target: the question's own extraction when it resolved exact
      // (and was not itself the context substitution), else the anchor-
      // stripped remainder through the NORMAL resolver — clarification rules
      // intact, an ambiguous new entity still blocks.
      let target =
        contextSubstitution === null &&
        refinedEntityResolution?.disposition === 'exact'
          ? refinedEntityResolution.candidates[0]!
          : null;
      let newEntityBlocked = false;
      if (target === null) {
        const phrase = extractReparamTarget(input.question);
        if (phrase !== null) {
          const resolvedTarget = await resolveComponents(ctx.graph, phrase, { limit: 5 });
          if (resolvedTarget.ok) {
            const refinedTarget = refineEntityResolution(phrase, resolvedTarget.value);
            if (refinedTarget.disposition === 'exact') {
              target = refinedTarget.candidates[0]!;
            } else if (
              refinedTarget.disposition === 'ambiguous' &&
              entityAmbiguityRequiresClarification(
                phrase,
                refinedTarget,
                undefined,
                // The re-parameterization inherits previous.tool; the widened
                // R4 band applies when THAT tool is single-component-target.
                previous.tool !== undefined &&
                  (SINGLE_COMPONENT_TARGET_TOOLS.has(previous.tool) ||
                    previous.tool.startsWith('sfi.what_if_')),
              )
            ) {
              route = {
                ...route,
                confidence: 'low',
                clarification: {
                  required: true,
                  question:
                    'Several components match the named entity. Which component did you mean?',
                  options: hygienicClarificationOptions(
                    refinedTarget.candidates.slice(0, 5),
                  ).map((candidate) => candidate.id),
                },
              };
              newEntityBlocked = true;
            }
          }
        }
      }
      if (!newEntityBlocked && target !== null) {
        const continuation = buildContextContinuation(
          input.question,
          previous.tool,
          target,
          reparamAnchor,
          false,
        );
        if (continuation !== null) {
          route = continuation;
          contextRouteApplied = {
            kind: 'reparameterization',
            anaphor: reparamAnchor,
            substitutedComponentId: target.id,
            inheritedTool: previous.tool,
          };
        }
      }
      // A REPARAM anchor with NO new entity degrades to (b) semantics below.
    }
    // (b) CONTEXT CONTINUATION — a PRONOUN anchor (or a degraded REPARAM
    // anchor) on a STILL-unrouted follow-up inherits the previous turn's
    // tool, bound to the §2a-substituted entity. Requires the substitution to
    // have resolved EXACT, or no componentId to have been carried at all.
    if (
      contextRouteApplied === null &&
      route.clarification === null &&
      stillUnrouted &&
      route.intent === 'unrouted' &&
      previous.tool !== undefined
    ) {
      const anchor = pronounAnchor ?? reparamAnchor;
      const substitutedExact =
        contextSubstitution !== null &&
        refinedEntityResolution?.disposition === 'exact';
      if (anchor !== null && (substitutedExact || previous.componentId === undefined)) {
        const winner = substitutedExact
          ? refinedEntityResolution!.candidates[0]!
          : null;
        // Prepend sfi.resolve when the question ALSO named a fresh entity the
        // continuation is not bound to — the host must resolve it first.
        const newEntityAppeared =
          contextSubstitution === null &&
          entityQuery !== null &&
          !isAnaphorOnly(entityQuery);
        const continuation = buildContextContinuation(
          input.question,
          previous.tool,
          winner,
          anchor,
          newEntityAppeared,
        );
        if (continuation !== null) {
          route = continuation;
          contextRouteApplied = {
            kind: 'continuation',
            anaphor: anchor,
            ...(winner !== null
              ? {
                  substitutedComponentId: winner.id,
                  from: contextSubstitution!.from,
                }
              : {}),
            inheritedTool: previous.tool,
          };
        }
      }
    }
  }

  // Stage 7 — FUNNEL-PRIMARY advisory fallback (router-v2 P2 §3). Fires ONLY
  // when every deterministic stage passed and the question is STILL dead:
  // no refusal gate (stage 0 returned early), no intent match, no resolve
  // rescue, no compound/mixed plan, no clarification (the margin gate and
  // entity ambiguity always win), and the premise is clean — an
  // existence-negative that disclosed above must never advisory-route. It
  // never overrides an intent match. The candidates here are PURE cosines
  // (the merge short-circuits for an unrouted intent — no regex bonus, no
  // 0.25 floor mass), so FUNNEL_PRIMARY_MIN_SCORE is a real semantic bar and
  // is the SINGLE threshold this gate reads. A redundant `top.score > 0.25`
  // used to sit alongside it as assert-style floor protection; two numbers
  // that can disagree is a worse failure mode than the one it guarded, so the
  // floor is now pinned once as an invariant by the P2 §4 test instead. The
  // `fromRoute` guard stays — it is a different assertion (pure-cosine path),
  // not a second threshold. Computed ONCE and reused for the final response
  // so gate and output cannot disagree.
  let advisoryCandidates: readonly ToolCandidate[] | null = null;
  // R3 catch-all narrowing: an ANAPHOR-ONLY fragment with NO host context
  // ("does it call an invocable apex at least?", "if it doesn't exist just
  // say so") cannot be answered — the pronoun is unresolvable, and a cosine
  // graze advisory-routing it was the funnel-advisory over-route family on
  // the R2 honesty holdouts. With host context, stage 6.5 already handled it;
  // without, stay honestly unrouted. Scoped to a SUBJECT-position pronoun
  // (within the first five words): a trailing "…all of it" on a full,
  // self-contained question is rhetoric, not the subject (the q154 shape).
  // A question with its OWN extracted entity is never touched either.
  const questionHead = input.question.trim().split(/\s+/).slice(0, 5).join(' ');
  const anaphorOnlyFragment =
    validatedContext === null &&
    detectPronounAnchor(questionHead) !== null &&
    (entityQuery === null || isAnaphorOnly(entityQuery));
  if (
    route.intent === 'unrouted' &&
    route.plane === 'unknown' &&
    route.clarification === null &&
    !premiseFlagged &&
    !anaphorOnlyFragment
  ) {
    const cands = buildFunnelCandidates(route, input.question, marginRouteToolArgs, input.mode);
    advisoryCandidates = cands;
    const resolvedExact =
      refinedEntityResolution?.disposition === 'exact'
        ? refinedEntityResolution.candidates[0]
        : undefined;
    // A resolved entity TYPE that CONTRADICTS a candidate's compatible-type
    // set drops that candidate (the tool hard-errors on this id) and promotes
    // the next — which must independently clear the threshold, else the route
    // stays unrouted. Untyped tools are never dropped.
    const usable =
      resolvedExact === undefined
        ? cands
        : cands.filter((candidate) => {
            const compatible = TOOL_COMPATIBLE_TYPES.get(candidate.tool);
            return compatible === undefined || compatible.has(resolvedExact.type);
          });
    const top = usable[0];
    if (
      top !== undefined &&
      top.score >= FUNNEL_PRIMARY_MIN_SCORE &&
      top.fromRoute !== true &&
      // Minimum-INTENT gate. Height alone cannot tell a real question from a
      // one-token lexical collision ("…the setup here" → live_setup_audit_trail
      // at 0.436, above every genuine advisory). Breadth can: see
      // FUNNEL_MIN_EVIDENCE_BREADTH. Without this, "empty is not none" leaks —
      // a question the product genuinely cannot place gets dressed up as an
      // advisory route instead of an honest unrouted.
      funnelEvidenceBreadth(usable) >= FUNNEL_MIN_EVIDENCE_BREADTH
    ) {
      const tools = usable.slice(0, 3).map((candidate) => candidate.tool);
      // Bind the stage-3 resolver output only when it is EXACT and the key is
      // knowable: a typed tool gets the id under its known key; an untyped
      // tool gets `componentId` only when its name says it takes a component.
      // Never guess an arg key (same principle as selectedEntityArgsForRoute).
      let advisoryArgs: Readonly<Record<string, unknown>> | null = null;
      if (resolvedExact !== undefined) {
        const compatible = TOOL_COMPATIBLE_TYPES.get(top.tool);
        if (compatible !== undefined && compatible.has(resolvedExact.type)) {
          advisoryArgs =
            top.tool === 'sfi.field_access_audit'
              ? { fieldId: resolvedExact.id }
              : { componentId: resolvedExact.id };
        } else if (
          compatible === undefined &&
          /get_impact|get_edges|component/.test(top.tool)
        ) {
          advisoryArgs = { componentId: resolvedExact.id };
        }
      }
      route = {
        question: input.question,
        plane: top.plane,
        intent: 'funnel-advisory',
        tools,
        liveRequired: top.liveRequired,
        needsResolve: entityQuery !== null,
        reason:
          'No deterministic intent matched. This route is FUNNEL-DERIVED (advisory): the ' +
          'semantic funnel ranked these tools by meaning alone. Confidence is low by construction — ' +
          'verify the pick, resolve any named component first, and ground with sfi.synthesize_answer.',
        gap: null,
        confidence: 'low',
        risk: DESTRUCTIVE_TOOL.test(top.tool) ? 'destructive' : 'informational',
        alternatives: [],
        clarification: null,
        plan: [{
          stepId: 'step-1',
          dependsOn: [],
          question: input.question,
          intent: 'funnel-advisory',
          plane: top.plane,
          tools,
        }],
        ...(advisoryArgs !== null ? { suggestedArgs: advisoryArgs } : {}),
      };
    }
  }

  // (P5 §4) contextApplied disclosure — attached ONLY when context actually
  // changed the route (a continuation/re-parameterization wins over a bare
  // entity substitution); mere presence of the param never emits it. The
  // fail-open `ignored` notes ride along when another context action fired.
  const contextApplied = contextRouteApplied ?? contextEntityApplied;
  if (contextApplied !== null) {
    route = {
      ...route,
      contextApplied: {
        ...contextApplied,
        ...(validatedContext !== null && validatedContext.ignored.length > 0
          ? { ignored: validatedContext.ignored }
          : {}),
      },
    };
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

    // I6 continuation: a margin (plane/risk) clarification offers TOOL names.
    // The user picking one pins the route to exactly that tool — keep any
    // leading `sfi.resolve` preamble so a named component is still resolved
    // first, but drop the losing rival and the ambiguity. This is validated
    // above (the selection MUST be one of the offered options), so it can only
    // ever pin a tool the gate itself surfaced.
    const selectedTool =
      response.selection.startsWith('sfi.') &&
      route.tools.includes(response.selection) === false
        ? response.selection
        : null;
    const selectedIntent = [route.intent, ...route.alternatives.map((alternative) => alternative.intent)]
      .includes(response.selection);
    if (selectedTool !== null && !selectedIntent) {
      const preamble = route.tools.filter((tool) => ROUTE_PREAMBLE_TOOLS.has(tool));
      const { plane, liveRequired } = resolveCandidatePlane(selectedTool);
      route = {
        ...route,
        plane,
        liveRequired,
        confidence: 'high',
        clarification: null,
        tools: [...preamble, selectedTool],
        plan: [{
          stepId: 'step-1',
          dependsOn: [],
          question: input.question,
          intent: route.intent,
          plane,
          tools: [...preamble, selectedTool],
        }],
      };
      clarificationResolution = {
        clarificationId,
        selection: response.selection,
        kind: 'tool',
      };
    } else if (selectedIntent) {
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
  const routeToolArgs = await buildRouteToolArgsMap(route, ctx);
  // P13-GW-router-envelope: under the core profile the client only holds 18
  // schemas, so the route also carries EXECUTABLE calls — gateway envelopes
  // for non-core tools (run_analysis is byte-identical to a direct call).
  const invoke =
    toolProfile() === 'core' && !executionBlocked
      ? invokeFromArgsMap(route, routeToolArgs)
      : undefined;
  // CAE-03b semantic funnel is PRIMARY: in the default HYBRID mode, surface the
  // meaning-ranked candidates + guidance for EVERY routable question and let the
  // host LLM decide — the regex `route` rides along only as a non-authoritative
  // hint. SFI_ROUTER_MODE=offline suppresses candidates and returns the
  // deterministic route alone (Design A, for no-LLM / CI / air-gapped hosts).
  // Offline TF-IDF over the capability map; a mode reranks toward its family.
  const wantCandidates = routerMode() === 'hybrid';
  // A funnel-advisory route reuses the EXACT candidate list stage 7 gated on
  // (P2 §3): recomputing over the replaced route would re-enter the regex-bonus
  // fusion (intent is no longer 'unrouted') and let gate and output disagree.
  const toolCandidates = wantCandidates
    ? advisoryCandidates ?? buildFunnelCandidates(route, input.question, routeToolArgs, input.mode)
    : [];
  const guidance =
    toolCandidates.length > 0 ? guidanceForMode(input.mode, toolCandidates) : undefined;
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
