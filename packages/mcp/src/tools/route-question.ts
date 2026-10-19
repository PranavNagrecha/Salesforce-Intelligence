/**
 * sfi.route_question — the conversational front door.
 *
 * Takes a plain-language question and returns the semantic funnel's
 * meaning-ranked `toolCandidates` (offline TF-IDF over the tool catalog) so a
 * host can pick a tool without the user ever typing a tool name. The funnel
 * advises; the host decides. Read-only: it never answers and never runs a tool.
 *
 * What it adds on top of the raw funnel, all derived from the question and the
 * vault — never from a hand-written intent table:
 * - REFUSAL-SHAPE GATES run first, score-independent: a write imperative,
 *   prompt-injection / value exfiltration, unmodeled runtime telemetry, a
 *   non-Salesforce ask, and three honest-gap arms. A refusal is never
 *   executable: no `invoke`, the disclosure in `refusal`, candidates listed only
 *   for transparency (suppressed entirely for injection).
 * - ENTITY RESOLUTION: the component the question names is resolved against the
 *   vault (`entityEvidence`), and an exact winner is bound into every candidate
 *   under that tool's OWN declared arg key (`suggestedArgs`); required args that
 *   could not be bound are named in `missingArgs`. A genuine same-name ambiguity
 *   stops with a `clarification`; a name the vault does not contain gets a
 *   PREMISE CHECK warning and is never bound.
 * - A simulation-vs-readout near-tie at the top of the shortlist stops with a
 *   tool-choice clarification only when the question does not say which it
 *   wants (every tool is read-only; a what-breaks or named-change question
 *   never stops); a vault-vs-live near-tie is decided by the question's own
 *   runtime-data language.
 * - Evidence under the funnel's absolute floor (best cosine, query coverage)
 *   stamps the rows `low` and sets an `out-of-scope` gap.
 * - HOST-PASSED conversation context (`context.previous`, optional): the product
 *   is STATELESS — the host passes what the previous turn was about. A
 *   pronoun/ellipsis follow-up substitutes `previous.componentId` (exact-id
 *   lookup, never fuzzy) and may inherit `previous.tool` at the head of the
 *   shortlist; an ordinal/descriptor pick against `previous.clarification`
 *   re-dispatches through the clarification contract. `contextApplied`
 *   discloses what context changed. `context` absent keeps every code path
 *   byte-identical; a self-contained question ignores context.
 * - A `gap` when nothing can be placed: no word of the question is in the tool
 *   catalog, a pronoun-led fragment arrives with no host context, or a
 *   follow-up is itself gap-shaped. Thin evidence on a shortlist that does
 *   exist is reported by the funnel's own per-row `confidence` band, which the
 *   guidance repeats. The question is appended to the local gap log only with
 *   `logGap: true`.
 */

import { createHash } from 'node:crypto';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, resolveComponents, type ResolveResult } from '@sf-intelligence/graph';
import { z } from 'zod';

import { renderContextApplied, renderShortlistMarkdown } from '../answer-render.js';
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
import { isLivePlaneEnvEnabled } from '../live-plane-env.js';
import { detectRefusalShape, type RefusalKind, type RefusalShape } from '../refusal-gates.js';
import { logGap, type RouteGap } from '../route-gaps.js';
import {
  getPlaneByTool,
  resolveCandidatePlane,
  semanticCandidates,
  shortlistBelowEvidenceFloor,
  type ToolCandidate,
} from '../semantic-funnel.js';
import type { Context } from '../server.js';

import { analysisCategory, oneLiner } from './catalog-gateway.js';
import {
  bindEntityArgs,
  bindQuestionLiterals,
  missingRequiredArgs,
  toolsDeclaringArg,
  type BindableEntity,
} from './entity-arg-binding.js';
import { resolveGlossaryAlias } from './resolve.js';
import { V01_TOOLS } from './roster.js';
import { CORE_PROFILE_TOOLS, toolProfile } from './tool-profile.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** A stop-and-ask: the host must get an answer before running anything. */
export interface RouteClarification {
  /** Stateless challenge id stamped by route_question for safe continuation. */
  readonly id?: string;
  readonly required: boolean;
  readonly question: string;
  /** Component ids (entity ambiguity) or `sfi.*` tool names (tool-choice tie). */
  readonly options: readonly string[];
}

/**
 * Disclosure of how HOST-PASSED conversation context changed this response.
 * Present ONLY when context actually changed it — the mere presence of the
 * `context` input param never emits it.
 */
export interface RouteContextApplied {
  readonly kind:
    | 'entity-substitution'
    | 'continuation'
    | 'reparameterization'
    | 'clarification-selection';
  /** Matched anaphor token, e.g. "it", "what about". */
  readonly anaphor: string;
  /** What was substituted from the previous turn, when an entity was. */
  readonly substitutedComponentId?: string;
  readonly from?:
    | 'previous.componentId'
    | 'previous.objectApiName'
    | 'previous.clarification';
  /** `previous.tool`, when a continuation/re-parameterization inherited it. */
  readonly inheritedTool?: string;
  /** Clarification selection: the option the ordinal/descriptor mapped to. */
  readonly selection?: string;
  /** Fail-open notes: invalid `previous.tool`/`componentId` fields skipped. */
  readonly ignored?: readonly string[];
}

/** One call for a shortlisted tool. */
export interface RouteInvocation {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * Required args of the tool that could not be bound — the step is NOT
   * executable as-is; fill these (e.g. via sfi.resolve) first.
   */
  readonly missingArgs?: readonly string[];
}

/** A shortlist row: the funnel candidate plus the tool's one-line summary. */
export type ShortlistRow = ToolCandidate & { readonly answers: string };

export interface RouteQuestionOutput {
  readonly question: string;
  /**
   * The meaning-ranked shortlist the host picks from. Each row carries
   * `answers` (the tool's one-liner — under the default `core` profile the host
   * has no description for most tools and would otherwise choose between bare
   * names), its plane, whether it needs the live org, the funnel's confidence
   * band, and any `suggestedArgs` / `missingArgs` the resolve step derived.
   * Omitted when the funnel finds nothing, or for a refused injection shape.
   */
  readonly toolCandidates?: readonly ShortlistRow[];
  /** The loop the host owns: resolve → pick → run → ground. Present with candidates. */
  readonly guidance?: string;
  /** Non-null means stop: ask the user, then call again with `clarificationResponse`. */
  readonly clarification: RouteClarification | null;
  /** True when the client must ask `clarification.question` before executing tools. */
  readonly executionBlocked: boolean;
  /**
   * Present ONLY when a score-independent refusal-shape gate fired. A refusal
   * is never executable — there is no `invoke`, and the disclosure says why.
   */
  readonly refusal?: RefusalShape;
  /**
   * Set when the question could not be placed: a refused or gapped ask, an
   * empty shortlist, or a pronoun-led fragment with no host context. Thin
   * evidence on a shortlist that exists is the rows' own `confidence: 'low'`.
   */
  readonly gap: RouteGap | null;
  /**
   * Vault-backed evidence about the named entity, when resolution was useful —
   * including disposition `none`, where it carries the FALSE-PREMISE disclosure
   * (the question named a component the vault does not contain).
   */
  readonly entityEvidence?: {
    /** Narrow phrase sent to the resolver; never the whole question. */
    readonly query: string;
    /** Type constraints derived from the question's own words. */
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
  /** Present after a validated clarification response deterministically resumed. */
  readonly clarificationResolution?: {
    readonly clarificationId: string;
    readonly selection: string;
    /** `entity` picked a component id; `tool` picked one of two tied tools. */
    readonly kind: 'entity' | 'tool';
  };
  /** Present ONLY when host-passed conversation context changed this response. */
  readonly contextApplied?: RouteContextApplied;
  readonly gapLogged: boolean;
  readonly rendered: string;
  readonly trust: TrustSummary;
  /**
   * Present ONLY when the server runs `SFI_TOOL_PROFILE=core` and nothing
   * blocks: the leading candidates expressed as calls — core-roster tools
   * directly, every other tool as the catalog-gateway envelope
   * `{ tool: 'sfi.run_analysis', args: { name, args } }` (byte-identical output
   * to a direct call). A step whose required args could not be bound carries
   * `missingArgs` and is not executable as-is.
   */
  readonly invoke?: readonly RouteInvocation[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const routeQuestionInputSchema = z.object({
  /** The user's plain-language question. */
  question: z.string().min(1),
  /**
   * Opt in to appending a gap entry to the local backlog when the response has
   * one. Privacy-first default false — the question text is written to disk only
   * when this is explicitly true.
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
   * Output mode — shapes how the host LLM should answer and which candidate
   * tools lead. 'ask' = a quick grounded answer (the default behavior); 'plan' =
   * an ordered change plan (favors the what_if_* / impact tools); 'assessment'
   * = a full evaluation (favors the *_risk_report / readiness / coverage tools).
   */
  mode: z.enum(['ask', 'plan', 'assessment']).optional(),
  /**
   * HOST-PASSED conversation context. The product is STATELESS — conversation
   * memory belongs to the host, which passes what the PREVIOUS turn was about so
   * a terse follow-up ("does it fire on delete too?") can be resolved; nothing
   * is stored server-side. `context` absent ⇒ every code path is byte-identical
   * to a call without the feature. Value validation is FAIL-OPEN (an
   * unregistered `tool` / malformed `componentId` is ignored and noted in
   * `contextApplied.ignored`); shape errors reject normally. Context strings are
   * NEVER treated as question text — `previous.question` is only ever
   * re-dispatched through the full handler (refusal gates included) for
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

// ---------------------------------------------------------------------------
// Shortlist facts
// ---------------------------------------------------------------------------

/**
 * Per-tool one-line summary + capability category, keyed by canonical tool
 * name. Under the DEFAULT `core` tool profile the host is advertised a handful
 * of tools, so for every other candidate the shortlist would name a tool whose
 * description is nowhere in the host's context. `sfi.list_analyses` renders the
 * same `oneLiner(description)` + `analysisCategory(name)`; this map plumbs them
 * into the shortlist itself, where the decision is made. No score or order moves.
 */
let candidateFactsCache: ReadonlyMap<string, { oneLiner: string; category: string }> | null = null;
const candidateFacts = (): ReadonlyMap<string, { oneLiner: string; category: string }> => {
  if (candidateFactsCache !== null) return candidateFactsCache;
  const m = new Map<string, { oneLiner: string; category: string }>();
  for (const t of V01_TOOLS) {
    m.set(t.name, { oneLiner: oneLiner(t.description), category: analysisCategory(t.name) });
  }
  candidateFactsCache = m;
  return m;
};

/** Attach `answers` (and backfill a `null` `category`) to every shortlist row. */
const withCandidateFacts = (cands: readonly ToolCandidate[]): ShortlistRow[] => {
  const facts = candidateFacts();
  return cands.map((c) => {
    const f = facts.get(c.tool);
    return {
      ...c,
      ...(c.category === null && f !== undefined ? { category: f.category } : {}),
      answers: f?.oneLiner ?? '',
    };
  });
};

const routeTrust = (): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'heuristic',
  freshness: {},
  completeness: { status: 'complete' },
  limitations: [
    'toolCandidates is a meaning-ranked shortlist from an offline lexical index over the tool catalog; the host decides which to run. A `gap` means the shortlist is a guess, a `clarification` means stop and ask. Resolve any named component and confirm the plane before trusting an answer.',
  ],
});

const clarificationIdFor = (
  sourceTreeHash: string,
  question: string,
  clarification: RouteClarification | null,
): string | null => {
  if (clarification?.required !== true) return null;
  return createHash('sha256')
    .update(JSON.stringify({
      sourceTreeHash,
      question,
      prompt: clarification.question,
      options: clarification.options,
    }))
    .digest('hex')
    .slice(0, 24);
};

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Max token count for the bare-component fallback. A short phrase that names a
 * component without asking anything ("payment object", "explain DataSync") is
 * resolved as a whole; a full sentence runs long, so the cap keeps the fallback
 * off the hot path and out of reach of wordy nonsense (at 4+ tokens the fuzzy
 * resolver starts returning `ambiguous` for out-of-scope noise).
 */
const RESOLVE_FALLBACK_MAX_TOKENS = 3;

/**
 * Does the question hold a token a person types only when NAMING a component:
 * an underscore or dot (`Status__c`, `Account.Industry`), CamelCase
 * (`DataSync`), or a capital that is not the sentence's first letter ("Who
 * changed Account?")? Plain words ("find dead code") never reach the fuzzy
 * resolver, which would otherwise match "code" to every `*_Code__c` field and
 * manufacture a clarification. The words still feed the funnel's text.
 */
const namesAComponent = (question: string): boolean => {
  const tokens = question.trim().split(/\s+/);
  return tokens.some(
    (token, i) =>
      /[_.]|[a-z][A-Z]/.test(token) || (/^["'‘“(]?[A-Z]/.test(token) && (i > 0 || tokens.length === 1)),
  );
};

/**
 * A token that names one of this server's OWN tools ("find_dependency_cycles",
 * "sfi.automation_risk_report") is a TOOL mention, not an org component — a
 * user typing a tool name verbatim must not premise-flag as "no component
 * named find_dependency_cycles exists".
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
const extractEntityQuery = (question: string): string | null => {
  // Three literal API-reference shapes, most-specific first: dotted
  // Object.Field, a __suffix custom name, and a bare UNDERSCORED token —
  // nobody types underscores in prose unless they are naming a component.
  // A token naming one of our own tools is skipped (tool mention, not entity).
  const apiReference = [...question.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)\b|\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x|b|kav)\b|\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b/g,
  )].map((match) => match[0]).find((token) => !isToolNameMention(token));
  if (apiReference !== undefined) {
    // Object-qualified field reference — "Resolution_Code__c on Case". The
    // stated object must SCOPE the entity: emit the dotted Object.Field form
    // the resolver treats as a definitive parent+name hit.
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

  // QUOTED NAME + type noun: "the 'Status' field", "the 'Standard' profile". A
  // quoted VALUE literal ("flips to 'Resolved'") stays ignored: the type noun
  // must follow the closing quote.
  const quotedTyped = question.match(
    /['"‘“]([A-Za-z][A-Za-z0-9_ ]{1,40}?)['"’”]\s+(?:field|object|profile|permission\s+set|flow|record\s+type)\b/i,
  )?.[1];
  if (quotedTyped !== undefined) return quotedTyped.trim();

  const prefixedTypePhrase = question.match(
    /\b((?:validation\s+rule|permission\s+set|record\s+type|page\s+layout|object|field|flow|class|trigger|layout|profile|report|dashboard)\s+(?:named\s+)?[A-Z][A-Za-z0-9_]*(?:\s+[A-Z][A-Za-z0-9_]*){0,5})\b/,
  )?.[1];
  if (prefixedTypePhrase !== undefined) return prefixedTypePhrase.trim();

  // `logic` is in the trailing-noun alternation so "the Order Fulfillment
  // logic" captures a name, but unlike the schema nouns it is a generic
  // implementation word, not a resolver type hint — it is DROPPED from the
  // returned phrase below so the resolver ranks the bare name.
  const typedMatch = question.match(
    /\b(?:the\s+)?([A-Za-z][A-Za-z0-9_]*(?:[\s_-]+[A-Za-z][A-Za-z0-9_]*){0,5}\s+(?:object|field|picklist|checkbox|flow|class|trigger|layout|profile|permission\s+set|record\s+type|validation\s+rule|report|dashboard|logic))(?:\s+(?:on|for|of)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_]*)(?:\s+object)?)?\b/i,
  );
  const typedPhrase = typedMatch?.[1];
  if (typedPhrase === undefined) return null;
  const cleaned = typedPhrase
    .replace(
      // Conditional / action lead-ins ("if I turn off the …", "can I safely
      // delete the …") are verbs of the question, not part of the name.
      /^(?:(?:what|whats|whatever|which|who|whos|where|wheres|when|why|how|hows|is|are|can|does|do|did|show|find|explain|locate|list|walk|through|pull|give|gimme|tell|about|break|down|compare|effective|calls?|invokes?|references?|owns?|edit|read|view|access|change|delete|remove|possible|values?|apex|api|version|data|type|for|of|the|this|that|in|on|to|used|assigned|set|every|all|each|any|me|my|us|a|an|if|i|we|you|turn|turned|off|disable|deactivate|rename|modify|drop|would|will|should|could|safely|happens?|from(?=\s+(?:the|an?)\s)|changing|removing|deleting)\s+)+/i,
      '',
    )
    .trim();
  if (
    /\b(?:and|when|should|use|there|any|that|no|available|tools?|difference|between|required\s+fields?|record\s+types?)\b/i.test(cleaned)
  ) return null;
  const distinctive = cleaned
    .replace(
      /\b(?:object|field|picklist|checkbox|flow|class|trigger|page|layout|profile|permission|set|record|type|validation|rule|report|dashboard|data|logic)\b/gi,
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
 * a risk report on all") — resolving that to `none` says nothing about any
 * premise. A single token is always name-shaped; a multi-word phrase is
 * name-shaped only when every word beyond schema-type nouns and connectors is
 * capitalized ("Zorp Widget", "ZorpAid permission set" — yes; prose fragments
 * with lowercase verbs/pronouns — no).
 */
const NAME_IGNORABLE_WORD =
  /^(?:object|field|picklist|checkbox|flow|class|trigger|page|layout|profile|permission|set|record|type|validation|rule|report|dashboard|logic|named|of|and|or|the|a|an|for)$/i;
export const looksLikeComponentName = (query: string): boolean => {
  const words = query.trim().split(/\s+/);
  if (words.length <= 1) return true;
  const nameWords = words.filter((word) => !NAME_IGNORABLE_WORD.test(word));
  return nameWords.length > 0 && nameWords.every((word) => /^["'‘“(]?[A-Z0-9]/.test(word));
};

/**
 * EXISTENCE-PROBE token extractor: the strongest name-shaped token in a
 * question whose extraction found no entity — a custom-suffixed name
 * (`Ghost_Field__c`) or a multi-part underscored name (`Ghost_Sync_Flow`).
 * DOTTED standard references (`Lead.Amount`) are deliberately EXCLUDED:
 * standard fields are legitimately absent from a metadata vault, so probing
 * them would premise-flag real questions. A token naming one of this server's
 * own tools is skipped as always.
 */
const extractExistenceProbeToken = (question: string): string | null =>
  [...question.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x|b|kav)\b|\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b/g,
  )]
    .map((match) => match[0])
    .find((token) => !isToolNameMention(token) && !/^\d/.test(token)) ?? null;

const inferEntityTypes = (query: string, question: string): readonly ComponentType[] => {
  if (query.includes('.') && !/\sclass$/i.test(query)) return ['CustomField'];
  if (/__(?:mdt|e|x|b|kav)$/i.test(query) || /(?:^object\s|\sobject(?:\s+on\s+\w+)?$)/i.test(query)) return ['CustomObject'];
  // A picklist / checkbox is a field TYPE, so "the Status picklist on Case" is a
  // field reference.
  if (/(?:^(?:field|picklist|checkbox)\s|\s(?:field|picklist|checkbox)(?:\s+on\s+\w+)?$)/i.test(query)) return ['CustomField'];
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
  // sample profile have access to the Sample_Exam__c OBJECT". The user told us
  // the type; scoping resolution to it keeps same-named components of other
  // types (the CustomTab twin, sibling fields) from manufacturing a fake
  // ambiguity.
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
  // query-level type noun, so it is checked last.
  if (/\bfield\b/i.test(question)) return ['CustomField'];
  return [];
};

// ---------------------------------------------------------------------------
// Entity resolution refinements
// ---------------------------------------------------------------------------

/** Loose literal key: lowercase, punctuation/space/underscore-insensitive. */
const normLiteral = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The fuzzy resolver deliberately returns `ambiguous` when nearby names are
 * plausible. A unique literal API/canonical-id match is stronger evidence and
 * is safe to treat as exact:
 * - SPACE-TYPED names ("Alpha Beta Flow" ≈ `Alpha_Beta_Flow`) compare
 *   punctuation-insensitively — but never for a CustomField when the query has
 *   spaces (the "Contact Email" → `Account.Contact_Email__c` decoy family the
 *   resolver deliberately keeps ambiguous).
 * - "Object Field" order ("Case Status" ≈ `Case.Status`): parent+name equals
 *   the whole query — the most specific way to name a field in prose.
 * - A CustomTab literal twin of a CustomObject is NOT a rival: the tab is the
 *   object's UI shell. Dropping twins that leaves ONE literal winner resolves
 *   `exact` instead of blocking.
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
 * QUALIFIED-ENTITY AUTO-RESOLVE: when the ambiguity is a same-named component
 * family differing only by PARENT object (the classic `Resolution_Code__c` on
 * Case/Task/Event), and the QUESTION itself names exactly ONE of those parents
 * as a word, the question already carries the disambiguating qualifier —
 * resolve with it instead of blocking on a clarification the user has
 * effectively pre-answered.
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
 * three different things called Status"). When the resolver agrees
 * (disposition ambiguous), that self-reported multiplicity is the strongest
 * possible clarify signal: junk-tie suppression must not swallow it.
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
   * NARROW CLARIFY: when the leading candidate tool targets a SINGLE named
   * component, a wider near-equal band (top2/top1 ≥ 0.8) fires the
   * clarification — the tool cannot proceed without knowing WHICH component.
   * For scope-vague asks (audits, inventories) only the tight-band / literal
   * collision / self-asserted paths fire.
   */
  leadTargetsSingleComponent = false,
): boolean => {
  // BARE-LABEL EXACT TIE: the resolver can return `exact` for a bare label
  // ("the 'Concentration' field") even when several SAME-named fields on
  // DIFFERENT parents all matched at identical base — its pick of a parent is
  // arbitrary. Only for a bare label (no __ suffix, no dot), only when the
  // question did not name a parent, and only on a true dead heat.
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
  // JUNK-TIE SUPPRESSION: a blocking clarification is only justified when the
  // top rivals look like the NAME the user typed — both non-fuzzy AND both
  // covering at least half their own name. nameCoverage defaults to 1 for
  // legacy candidates without it.
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
  if (leadTargetsSingleComponent) {
    // A genuine same-name family: two DISTINCT components sharing the SAME
    // normalized api-name, both at a high base and within the 0.8 near-equal
    // band. A trailing type word ("the X CLASS") makes the match read `fuzzy`,
    // so the shared name is the discriminator; junk grazes never share one.
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
 * OPTION HYGIENE: the options offered by an entity clarification must be the
 * PLAUSIBLE candidates only. A rival that matched fuzzily (the pure-short-
 * acronym overlap: "ssn" ≈ `{ASN,BSN,MSN}_Professional_Status__c`) or whose
 * base sits well below the top option is junk. Keeps every candidate within
 * 90% of the top base that matched non-fuzzily, always including the top.
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
  return kept.length > 0 && kept[0] === top ? kept : [top, ...kept.filter((c) => c !== top)];
};

/**
 * Clarification option ids for an ambiguous entity. Prefers the hygiene set;
 * when that collapses to <2 options AND the resolve is a genuine SAME-NAME
 * family (e.g. "the ApplicationForm CLASS" reads `fuzzy`), falls back to the
 * distinct components sharing the top candidate's normalized name.
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

// ---------------------------------------------------------------------------
// Tool ↔ entity type compatibility and arg binding
// ---------------------------------------------------------------------------

/** The tool families each output mode favors when reranking the funnel. */
const PLAN_FAMILY = /^sfi\.(what_if_|get_impact|safe_to_delete|downstream_effects|tests_for_change|field_lineage)/;
const ASSESSMENT_FAMILY =
  /(_risk_report$|^sfi\.release_readiness|^sfi\.promotion_readiness|^sfi\.coverage_report|^sfi\.tech_debt_score|^sfi\.governor_limit_risks|^sfi\.crud_fls_audit)/;

/**
 * SINGLE-COMPONENT-TARGET tools: an entity ambiguity genuinely blocks these
 * because the tool cannot proceed without knowing WHICH component the user
 * meant. The `what_if_*` family (all named-target simulations) is matched by
 * prefix. Scope-vague questions (audits, inventories) lead with tools NOT in
 * this set, so the clarify gate stays off them.
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

const targetsSingleComponent = (tool: string | undefined): boolean =>
  tool !== undefined &&
  (SINGLE_COMPONENT_TARGET_TOOLS.has(tool) || tool.startsWith('sfi.what_if_'));

/**
 * Tool ↔ resolved-component-type compatibility. The tools keyed here FAIL
 * CLOSED when handed a component outside their family (an Apex call graph over
 * a Flow id, an object CRUD audit over a Flow) — offering them for a
 * resolved entity of the wrong type is a guaranteed hard error, so they are
 * dropped from the shortlist. Tools not keyed here accept any component type.
 */
const TOOL_COMPATIBLE_TYPES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sfi.call_graph', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.method_reachability', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.explain_apex_method', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.crud_fls_audit', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.who_can_access_object', new Set(['CustomObject'])],
  ['sfi.object_access_audit', new Set(['CustomObject'])],
  ['sfi.field_access_audit', new Set(['CustomField'])],
]);

const compatibleWithType = (tool: string, type: string): boolean => {
  const compatible = TOOL_COMPATIBLE_TYPES.get(tool);
  return compatible === undefined || compatible.has(type);
};

/** A resolved component to bind into every recommended call. */
interface EntityBinding {
  readonly winner: BindableEntity;
  readonly methodName?: string;
}

/**
 * Per-tool args: the resolved entity bound under the tool's OWN declared key
 * (entity-arg-binding.ts). A type-incompatible tool is left unbound — except a
 * field named on an object-only tool, which binds the field's parent object.
 */
const bindToolArgs = (
  tool: string,
  binding: EntityBinding | null,
): Readonly<Record<string, unknown>> => {
  if (binding === null) return {};
  let entity = binding.winner;
  const compatible = TOOL_COMPATIBLE_TYPES.get(tool);
  if (compatible !== undefined && !compatible.has(entity.type)) {
    if (
      entity.type === 'CustomField' &&
      compatible.has('CustomObject') &&
      entity.parentApiName !== null
    ) {
      entity = {
        id: `CustomObject:${entity.parentApiName}`,
        type: 'CustomObject',
        apiName: entity.parentApiName,
        parentApiName: null,
      };
    } else {
      return {};
    }
  }
  return bindEntityArgs(tool, entity, binding.methodName) ?? {};
};

const OBJECT_PROBE_STOPWORDS = new Set([
  'what', 'whats', 'which', 'when', 'where', 'who', 'why', 'how', 'does', 'do', 'did',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'runs', 'run', 'fires',
  'fire', 'happens', 'happen', 'saved', 'save', 'saves', 'saving', 'record', 'records',
  'someone', 'gets', 'get', 'order', 'execution', 'insert', 'inserted', 'update',
  'updated', 'edit', 'edits', 'edited', 'delete', 'deleted', 'created', 'create',
  'automation', 'trigger', 'triggers', 'flow', 'flows', 'all', 'everything', 'out',
  'figure', 'same', 'object', 'objects', 'new', 'one', 'any', 'there', 'are', 'is',
]);

/**
 * The ONE object a question's words name, checked against the vault (api name
 * or label, case-insensitive). `null` when none or several match — never a
 * guess. Bounded: at most 6 probes. Runs only when the extractor found no
 * entity and a leading candidate takes an object ("what runs when a Case is
 * saved" names the object in plain prose).
 */
const probeObjectMention = async (ctx: Context, question: string): Promise<string | null> => {
  const words = [
    ...new Set(
      question
        .split(/[^A-Za-z0-9_]+/)
        .filter((w) => w.length >= 3 && !OBJECT_PROBE_STOPWORDS.has(w.toLowerCase())),
    ),
  ].slice(0, 6);
  const found = new Set<string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    const r = await resolveComponents(ctx.graph, word, { limit: 5, types: ['CustomObject'] });
    if (!r.ok) continue;
    const hit = r.value.candidates.find(
      (c) =>
        c.apiName.toLowerCase() === lower ||
        c.apiName.toLowerCase() === `${lower}__c` ||
        (c.label ?? '').toLowerCase() === lower,
    );
    if (hit !== undefined) found.add(hit.apiName);
  }
  return found.size === 1 ? [...found][0]! : null;
};

/**
 * Live plane switched on for this process (ranking only). Reads the shared env
 * switch alone: the router must not import the live-consent seam (plane import
 * guard). A stored grant without the switch only means live rows sink below
 * vault rows — they stay listed, nothing is hidden.
 */
const livePlaneAvailable = (): boolean =>
  process.env['SFI_TRANSPORT'] !== 'http' && isLivePlaneEnvEnabled();

const HIDDEN_TOOLS: ReadonlySet<string> = new Set(
  V01_TOOLS.filter((t) => t.hidden === true).map((t) => t.name),
);

/**
 * `Class.method`: a dotted reference whose LEFT side is exactly an Apex
 * class/trigger in the vault (and not an object) is a method reference, never
 * `Object.Field`. Returns the class query + method, or null.
 */
const splitApexMethodReference = async (
  ctx: Context,
  query: string,
): Promise<{ readonly classQuery: string; readonly type: ComponentType; readonly methodName: string } | null> => {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(query.trim());
  if (m === null) return null;
  const [, left, right] = m as unknown as [string, string, string];
  if (/__[a-z]+$/i.test(right)) return null;
  const objectHit = await getNodeById(ctx.graph, `CustomObject:${left}` as ComponentId);
  if (objectHit.ok && objectHit.value !== null) return null;
  const r = await resolveComponents(ctx.graph, left, {
    limit: 5,
    types: ['ApexClass', 'ApexTrigger'],
  });
  if (!r.ok) return null;
  const cls = r.value.candidates.find((c) => c.apiName.toLowerCase() === left.toLowerCase());
  return cls === undefined ? null : { classQuery: cls.apiName, type: cls.type, methodName: right };
};

/** Evidence order: an exact winner first, then by score. */
const evidenceOrder = <T extends { readonly score: number; readonly matchKind: string }>(
  rows: readonly T[],
  exactWinnerFirst: boolean,
): T[] => {
  const head = exactWinnerFirst && rows.length > 0 ? [rows[0]!] : [];
  const rest = (exactWinnerFirst ? rows.slice(1) : [...rows]).sort(
    (a, b) =>
      (a.matchKind === 'exact' ? 0 : 1) - (b.matchKind === 'exact' ? 0 : 1) ||
      b.score - a.score,
  );
  return [...head, ...rest];
};

/** A core tool directly, any other through the gateway; unbound required args named. */
const invocationFor = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
): RouteInvocation => {
  const missing = missingRequiredArgs(tool, args);
  const call: RouteInvocation = CORE_PROFILE_TOOLS.has(tool)
    ? { tool, args }
    : { tool: 'sfi.run_analysis', args: { name: tool, args } };
  return missing.length > 0 ? { ...call, missingArgs: missing } : call;
};

/** How many leading candidates become `invoke[]` calls under the core profile. */
const INVOKE_DEPTH = 3;

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
// Shortlist gates: margin clarification, plane tie, evidence bar
// ---------------------------------------------------------------------------

/**
 * Margin-based clarification. When the funnel's top-1 and top-2 scores are
 * within MARGIN AND the two tools answer materially different questions (a
 * change verdict/simulation vs a usage readout) AND the question itself does
 * not say which, stop and ask. Every sf-intelligence tool is read-only; the
 * analysed change is what differs. Scoped TIGHT on purpose: over-triggering
 * (blocking a clear shortlist) is worse than missing a subtle case; a
 * what-breaks / impact question or one that names the change never stops.
 */
export const MARGIN = 0.05;

/**
 * A candidate that simulates a stated change and returns a verdict — the
 * safe-to-delete verdict and the what_if_* simulation family.
 */
const SIMULATION_TOOL = /^sfi\.(safe_to_delete_field|what_if_)/;

/** A candidate that only lists dependency/usage — what the simulation tools are confused with. */
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
 * plane-diverging funnel near-tie WITHOUT a blocking clarification.
 */
const LIVE_DATA_SIGNAL =
  /\bhow\s+many\b|\bcounts?\b|\bfill\s+rate\b|\bpopulat(?:ed|ion)\b|\bstorage\b|\bdata\s+volume\b|\blog(?:ged)?\s?in(?:to)?\b|\blast\s+login\b|\bright\s+now\b|\bcurrently\b|\bas\s+of\s+(?:now|today)\b|\bin\s+prod(?:uction)?\b|\bsample\s+records?\b|\brows?\b|\brecord\s+data\b|\bactual(?:ly)?\s+(?:records?|values?|data|used?|runs?)\b|\bapi\s+usage\b|\blimits?\s+headroom\b/i;

/**
 * Resolve a plane-diverging near-tie by the question's own language instead of
 * blocking: live-data language promotes the live/hybrid candidate to the top
 * (consent disclosure follows from its liveRequired flag); otherwise the vault
 * candidate leads.
 */
export const resolvePlaneTie = (
  cands: readonly ToolCandidate[],
  question: string,
): ToolCandidate[] => {
  const [top, second] = cands;
  if (top === undefined || second === undefined) return [...cands];
  if (top.score - second.score > MARGIN) return [...cands];
  if (!planesDiverge(top, second)) return [...cands];
  const wantsLive = LIVE_DATA_SIGNAL.test(question);
  const topReachesOrg = top.plane === 'live' || top.plane === 'hybrid';
  if (wantsLive === topReachesOrg) return [...cands];
  return [second, top, ...cands.slice(2)];
};

/**
 * COMPOUND VAULT+LIVE ASK: one question that EXPLICITLY asks for both a
 * metadata answer AND a live-runtime verification, joined in one breath. Unlike
 * the plane-tie graze (one meaning, two tool planes), this is TWO asks on
 * different planes — a genuine either-or, so it clarifies.
 */
export const isCompoundPlaneAsk = (question: string): boolean => {
  const liveHalf =
    /\b(?:actually|really)\s+(?:running|firing|executing|live)\b|\bright\s+now\b|\bin\s+production\b/i;
  const vaultHalf =
    /\bwhat\s+(?:breaks?|depends|would\s+break|will\s+break)\b|\bwhat\s+does\b[^.?!]{0,60}\bdo\b|\bschema\b|\bmetadata\b|\bsafe\s+to\s+(?:disable|deactivate|delete|remove)\b|\btell\s+me\s+about\b/i;
  const conjoined = /\b(?:and|also|plus)\b/i;
  return liveHalf.test(question) && vaultHalf.test(question) && conjoined.test(question);
};

/** One candidate simulates a change, the other is an impact/usage readout. */
const readingsDiverge = (a: ToolCandidate, b: ToolCandidate): boolean =>
  (SIMULATION_TOOL.test(a.tool) && INFORMATIONAL_IMPACT_TOOL.test(b.tool)) ||
  (SIMULATION_TOOL.test(b.tool) && INFORMATIONAL_IMPACT_TOOL.test(a.tool));

/**
 * The question already says which reading it wants: an impact ask ("what
 * breaks", "depends on", "affected", "blast radius") or a named change
 * ("delete", "change", "remove", "rename"). Both tied tools answer such a
 * question, so there is nothing to ask.
 */
const QUESTION_SAYS_WHICH =
  /\b(?:what\s+(?:breaks?|would\s+break|will\s+break|depends|happens)|impact|blast\s+radius|affected|depend(?:s|encies|ents)?|used\s+by|safe\s+to|delet(?:e|ing)|remov(?:e|ing)|chang(?:e|ing)|renam(?:e|ing)|deactivat(?:e|ing)|disabl(?:e|ing))\b/i;

/**
 * When the top-2 candidates are within MARGIN, one simulates a change and the
 * other lists usage, AND `question` does not say which it wants, return a
 * tool-choice clarification; otherwise null. `existingClarification`
 * short-circuits the gate — the response already stopped for a stronger
 * reason (entity ambiguity).
 */
export const marginClarification = (
  cands: readonly ToolCandidate[],
  existingClarification: RouteClarification | null,
  question = '',
): RouteClarification | null => {
  if (existingClarification !== null) return null;
  const [top, second] = cands;
  if (top === undefined || second === undefined) return null;
  if (top.score - second.score > MARGIN) return null;
  if (!readingsDiverge(top, second)) return null;
  if (QUESTION_SAYS_WHICH.test(question)) return null;
  const prompt =
    `These two tools are equally likely but answer different questions — ` +
    `\`${top.tool}\` vs \`${second.tool}\`. Do you want the impact/usage readout, ` +
    `or the change simulation and its verdict? Which did you mean?`;
  return {
    required: true,
    question: prompt,
    options: [top.tool, second.tool],
  };
};

/**
 * When a LEADING candidate needs the opt-in live plane, the guidance MUST
 * disclose that up front — name the live plane and the consent step — so the
 * host LLM refuses to invent a number rather than calling a `live_*` tool
 * blindly. A lone live tool buried far down the shortlist must not over-warn.
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

/** The planner contract, tailored to the requested output mode. */
const guidanceForMode = (
  mode: RouteQuestionInput['mode'],
  cands: readonly ToolCandidate[],
  gap: RouteGap | null,
): string => {
  const consent = liveConsentDisclosure(cands) ?? '';
  // The funnel's calibrated band: `low` is its honest thin-evidence signal (a
  // lone matching word, most of the question unknown to the catalog).
  const weak =
    gap === null && cands[0]?.confidence === 'low'
      ? ' LOW CONFIDENCE: the shortlist rests on thin evidence; verify the pick against its `answers`, and if nothing fits say the capability is not built rather than running a lookalike.'
      : '';
  const gapNote =
    gap === null
      ? weak
      : ` GAP: ${gap.note} Treat the shortlist as a guess — if nothing fits, say the capability is not built rather than running a lookalike.`;
  const tail =
    ' The candidates are an advisory shortlist, not a route — YOU pick. Resolve any ' +
    'named component first, ground the final answer with sfi.synthesize_answer, and ' +
    'never answer from a tool name alone.' +
    consent +
    gapNote;
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
        'These toolCandidates are the meaning-ranked shortlist — YOU decide which to run. ' +
        'Read ALL the candidates (up to 8) before picking: the ranking is advisory and the best tool is often mid-list, so never default to the first row. ' +
        'When a candidate carries `suggestedArgs`, they are the component this call resolved from the question, bound under that tool\'s own arg; `missingArgs` names required args you must still supply (usually via sfi.resolve). ' +
        'Plan: read the question → resolve any named component with sfi.resolve → pick the tool(s) to run from the candidates ' +
        '(sequence them if compound) → run them → ground the answer with sfi.synthesize_answer. ' +
        'Never answer from a tool name alone.' +
        consent +
        gapNote
      );
  }
};

// ---------------------------------------------------------------------------
// DE-CROWD — untriggered what_if shortlist demotion.
//
// The what_if_* simulation family shares heavy permission/field/flow
// vocabulary with the plain-read tools, so its candidates crowd the top of the
// shortlist on questions that carry NO action or hypothetical language at all.
// The demotion is gated on trigger tokens: a what_if candidate in an ACTIVE
// family keeps its rank ONLY when the question carries a hypothetical marker
// or that family's own action verb; otherwise it is moved below the non-what_if
// candidates (demoted, never deleted).
//
// SCOPE IS MEASURED, NOT PRINCIPLED. See DECROWD_ACTIVE_FAMILIES.
// ---------------------------------------------------------------------------

/** The candidate family the de-crowd demotion applies to. */
export const WHAT_IF_CANDIDATE_FAMILY = /^sfi\.what_if_/;

/**
 * The ONLY what_if tools the de-crowd demotion is active for.
 *
 * Counterfactual pricing (independent replay over the real 3K depth-10 traces
 * + relabeled-v2 gold, 2026-07-13): scoping the demotion to exactly these two
 * tools measures +0.42pp recall@5, 27 turns gained, ZERO turns lost. The broad
 * 11-family scope was MEASURED to be worse (net +0.25pp with 40 turns where
 * gold fell OUT of top-5). DO NOT add a family without a fresh traces-replay
 * measurement (net >= +0.4pp recall@5 AND zero lost turns).
 */
export const DECROWD_ACTIVE_FAMILIES: ReadonlySet<string> = new Set([
  'sfi.what_if_assign_permset',
  'sfi.what_if_revoke_permset',
]);

/**
 * Hypothetical/simulation markers shared across ALL what_if_* families.
 * DERIVED from the families' own utterance corpora in funnel-utterances.ts.
 */
export const WHAT_IF_HYPOTHETICAL_TRIGGERS =
  /\bwhat\s+(?:if|happens|breaks?)\b|\bhappens?\s+if\b|\bif\s+(?:i|we|someone)\b|\bwould\b|\bimpact\b|\bblast\s+radius\b|\bsimulat(?:e|es|ed|ing|ion)\b|\bconsequences?\b|\bsafe(?:ly)?\s+to\b|\bsafely\b/i;

/**
 * Per-family ACTION verbs, DERIVED from each family's own utterance corpus in
 * funnel-utterances.ts. A question carrying the family's own verb is an action
 * ask for that family, so THAT tool keeps its rank even without a hypothetical
 * marker. Lexicons are kept for ALL 11 families as dormant plumbing, but only
 * DECROWD_ACTIVE_FAMILIES entries gate a demotion today.
 */
export const WHAT_IF_ACTION_TRIGGERS: ReadonlyMap<string, RegExp> = new Map([
  ['sfi.what_if_change_field_value', /\bchang(?:e|es|ed|ing)\b|\bbulk[- ]?updat(?:e|es|ed|ing)\b|\bset(?:s|ting)?\b/i],
  ['sfi.what_if_change_field_type', /\bchang(?:e|es|ed|ing)\b|\bconvert(?:s|ed|ing)?\b|\bmak(?:e|es|ing)\b|\bmade\b|\bdata\s+type\b/i],
  ['sfi.what_if_remove_picklist_value', /\bremov(?:e|es|ed|ing)\b|\bdelet(?:e|es|ed|ing)\b/i],
  ['sfi.what_if_make_field_required', /\bmak(?:e|es|ing)\b|\bmade\b|\brequir(?:e|es|ed|ing)\b|\bmandatory\b/i],
  ['sfi.what_if_deactivate_flow', /\bdeactivat(?:e|es|ed|ing)\b|\bturn(?:s|ed|ing)?\b[^.?!]{0,16}\boff\b|\bswitch(?:es|ed|ing)?\b[^.?!]{0,16}\boff\b/i],
  ['sfi.what_if_disable_trigger', /\bdisabl(?:e|es|ed|ing)\b|\bturn(?:s|ed|ing)?\b[^.?!]{0,16}\boff\b|\bwas\s+off\b/i],
  ['sfi.what_if_change_method_signature', /\bsignature\b|\brenam(?:e|es|ed|ing)\b|\bchang(?:e|es|ed|ing)\b|\b(?:add|remove)\b[^.?!]{0,20}\bparameter\b/i],
  ['sfi.what_if_merge_profiles', /\bmerg(?:e|es|ed|ing)\b|\bcombin(?:e|es|ed|ing)\b|\bconsolidat(?:e|es|ed|ing)\b|\bconflicts?\b|\bcollisions?\b/i],
  ['sfi.what_if_split_profile', /\bsplit(?:s|ting)?\b|\bbreak\b[^.?!]{0,32}\binto\b/i],
  ['sfi.what_if_assign_permset', /\bassign(?:s|ed|ing)?\b|\bgrant(?:s|ed|ing)?\b|\badd(?:s|ed|ing)?\b|\bgain(?:s|ed|ing)?\b|\bgiv(?:e|es|ing)\b|\bgave\b/i],
  ['sfi.what_if_revoke_permset', /\brevok(?:e|es|ed|ing)\b|\bremov(?:e|es|ed|ing)\b|\bunassign(?:s|ed|ing)?\b|\bstrip(?:s|ped|ping)?\b|\btak(?:e|es|ing)\s+away\b|\btook\s+away\b|\blos(?:e|es|ing)\b|\blost\b/i],
]);

/** Does the question license this what_if tool to keep its shortlist rank? */
const whatIfTriggered = (tool: string, question: string): boolean =>
  WHAT_IF_HYPOTHETICAL_TRIGGERS.test(question) ||
  (WHAT_IF_ACTION_TRIGGERS.get(tool)?.test(question) ?? false);

/**
 * Demote every DECROWD_ACTIVE_FAMILIES candidate with no trigger token in the
 * question below all other candidates. Pure REORDER: scores are never touched,
 * rows are never dropped, kept rows preserve their relative order. Runs BEFORE
 * mode-reranking so an explicit `mode: 'plan'` still leads with the plan family.
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
      !whatIfTriggered(candidate.tool, question);
    (parasitic ? demoted : kept).push(candidate);
  }
  return [...kept, ...demoted];
};

/**
 * The ranked shortlist for a question: score the funnel, de-crowd, mode-rerank,
 * break a plane tie. Pure on (question, mode) — the same list the margin gate
 * reads, the evidence bar scores and the response returns, so none can disagree.
 */
export const buildFunnelCandidates = (
  question: string,
  mode: RouteQuestionInput['mode'],
): ToolCandidate[] => {
  const funnelLimit = mode !== undefined ? 12 : 8;
  return resolvePlaneTie(
    rerankForMode(
      demoteUntriggeredWhatIfs(semanticCandidates(question, funnelLimit), question),
      mode,
    ),
    question,
  );
};

// ---------------------------------------------------------------------------
// Stage 0 — refusal-shape gates. Score-independent, run on the RAW question:
// an imperative like "deactivate the X flow for me" must never reach the
// what-if simulator, whatever the host.
// ---------------------------------------------------------------------------

/** Gap record per refusal kind, so `logGap: true` still records the demand. */
const REFUSAL_GAP: Readonly<Record<RefusalKind, RouteGap>> = {
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

const vaultState = (ctx: Context): McpResponse<RouteQuestionOutput>['vaultState'] => ({
  sourceTreeHash: ctx.manifest.sourceTreeHash,
  refreshedAt: ctx.manifest.refreshedAt,
});

/**
 * Assemble the full response for a refusal shape. Candidates ride along for
 * transparency EXCEPT for injection/exfiltration, which suppresses candidates
 * and guidance entirely. Never an `invoke`.
 */
const refusalResponse = async (
  ctx: Context,
  input: RouteQuestionInput,
  shape: RefusalShape,
): Promise<Result<McpResponse<RouteQuestionOutput>, McpError>> => {
  const cands =
    shape.kind !== 'injection-exfiltration'
      ? withCandidateFacts(buildFunnelCandidates(input.question, input.mode))
      : [];
  // The runtime honest-gap discloses its nearest reads inline, so the text is
  // self-contained even for a host that never renders the candidate list.
  const disclosure =
    shape.kind === 'runtime-analytics' && cands.length > 0
      ? `${shape.disclosure} Nearest reads: ${cands.slice(0, 3).map((c) => c.tool).join(', ')}.`
      : shape.disclosure;
  const refusal: RefusalShape = { ...shape, disclosure };
  const gap = REFUSAL_GAP[shape.kind];
  const logged =
    input.logGap === true ? await logGap(input.question, gap, undefined, ctx.vaultRoot) : null;
  const data: RouteQuestionOutput = {
    question: input.question,
    ...(cands.length > 0 ? { toolCandidates: cands } : {}),
    ...(cands.length > 0
      ? { guidance: `${disclosure} Do not execute any tool to satisfy the refused action.` }
      : {}),
    clarification: null,
    executionBlocked: false,
    refusal,
    gap,
    gapLogged: logged !== null,
    rendered: '',
    trust: routeTrust(),
  };
  return ok({
    data: { ...data, rendered: renderShortlistMarkdown(data) },
    vaultState: vaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** Minimal resolved-entity shape (a resolver candidate or a graph node). */
interface Winner {
  readonly id: string;
  readonly type: string;
  readonly apiName: string;
  readonly parentApiName: string | null;
}

const toEvidenceRows = (
  candidates: readonly ResolveResult['candidates'][number][],
): NonNullable<RouteQuestionOutput['entityEvidence']>['candidates'] =>
  candidates.slice(0, 5).map((candidate) => ({
    componentId: candidate.id,
    type: candidate.type,
    apiName: candidate.apiName,
    label: candidate.label,
    parentApiName: candidate.parentApiName,
    score: candidate.score,
    base: candidate.base,
    matchKind: candidate.evidence.startsWith('glossary-alias:')
      ? ('glossary-alias' as const)
      : candidate.matchKind,
    evidence: candidate.evidence,
  }));

const WEAK_MATCH_WARNING =
  'Possible component matches were found, but none is strong enough to interrupt routing. Resolve the component before executing a component-specific analysis.';

const PREMISE_TAIL =
  `Verify the name (a typo, or metadata newer than the last refresh; /sfi-refresh may help). ` +
  `A tool fails closed on an unknown component; do not present its error as an answer about a real component.`;

/** Put `tool` at the head of the shortlist, inserting a zero-evidence row if the funnel missed it. */
const leadWith = (
  cands: readonly ToolCandidate[],
  tool: string,
  confidence: ToolCandidate['confidence'],
): ToolCandidate[] => {
  const existing = cands.find((c) => c.tool === tool);
  const head: ToolCandidate =
    existing !== undefined
      ? { ...existing, confidence }
      : { tool, score: 0, cosine: 0, category: null, ...resolveCandidatePlane(tool), confidence };
  return [head, ...cands.filter((c) => c.tool !== tool)];
};

export const routeQuestionHandler = async (
  ctx: Context,
  input: RouteQuestionInput,
): Promise<Result<McpResponse<RouteQuestionOutput>, McpError>> => {
  // Stage 0 — refusal-shape gates FIRST: a hit short-circuits everything (no
  // entity resolve, no margin gate). Gates run on the WHOLE question, so a
  // compound turn with a refusal clause refuses the whole turn.
  const refusalShape = detectRefusalShape(input.question);
  if (refusalShape !== null) {
    if (input.clarificationResponse !== undefined) {
      return err({
        kind: 'invalid-query',
        message:
          'clarificationResponse was supplied, but this question has no active clarification challenge. Route the question again without a response.',
        path: 'clarificationResponse',
      });
    }
    return refusalResponse(ctx, input, refusalShape);
  }

  // Host-passed conversation context. Everything context-related is inside
  // `input.context` guards — `context` absent keeps every code path
  // byte-identical. Refusal gates already ran on the RAW text above: context
  // never bypasses them. Value validation is FAIL-OPEN.
  const contextInput = input.context;
  const validatedContext: ValidatedContext | null =
    contextInput !== undefined
      ? validatePreviousContext(contextInput.previous, (tool) => getPlaneByTool().has(tool))
      : null;

  // CLARIFICATION CONTINUATION — the question is an ordinal / descriptor pick
  // ("the second one", "the Contact one") against the prior turn's open
  // clarification. Map it to the offered option and re-dispatch INTERNALLY
  // through the FULL handler (recursion depth 1 — the inner call carries no
  // context), so every existing validation applies unchanged. 0 or ≥2
  // descriptor matches / an out-of-range ordinal re-asks — NEVER guess. This is
  // the ONLY use of `previous.question`.
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
                clarificationId: validatedContext.previous.clarification.clarificationId,
                selection: selected.selection,
              },
            })
          : await routeQuestionHandler(ctx, { question: validatedContext.previous.question });
      if (!inner.ok) return inner;
      const contextApplied: RouteContextApplied = {
        kind: 'clarification-selection',
        anaphor: selected.anaphor,
        from: 'previous.clarification',
        ...(selected.kind === 'selected' ? { selection: selected.selection } : {}),
        ...(validatedContext.ignored.length > 0 ? { ignored: validatedContext.ignored } : {}),
      };
      return ok({
        ...inner.value,
        data: {
          ...inner.value.data,
          contextApplied,
          rendered: `${inner.value.data.rendered}\n\n${renderContextApplied(contextApplied)}`,
        },
      });
    }
  }

  // The shortlist. Pure on (question, mode); everything below refines it.
  let cands = buildFunnelCandidates(input.question, input.mode);

  // Entity extraction: the bounded component phrase the question names.
  let entityQuery = extractEntityQuery(input.question);
  let entityTypes: readonly ComponentType[] =
    entityQuery === null ? [] : inferEntityTypes(entityQuery, input.question);
  // A SHORT phrase with no extractable entity ("explain DataSync", "payment
  // object") is often a component named without a question around it —
  // resolve the whole phrase, and keep it as the entity only when the vault
  // recognises it. Genuinely out-of-scope phrases resolve to `none` and stay
  // entity-less.
  let shortPhraseFallback = false;
  if (entityQuery === null) {
    const tokens = input.question.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length > 0 && tokens.length <= RESOLVE_FALLBACK_MAX_TOKENS && namesAComponent(input.question)) {
      const probe = await resolveComponents(ctx.graph, input.question, { limit: 5 });
      if (probe.ok && probe.value.disposition !== 'none' && probe.value.candidates.length > 0) {
        entityQuery = input.question;
        shortPhraseFallback = true;
      }
    }
  }
  // Plain-prose object mention ("what runs when a Case is saved"): when no
  // name-shaped entity was found and a leading candidate takes an object, ask
  // the VAULT which word of the question names exactly one object.
  const OBJECT_TOOLS = new Set(toolsDeclaringArg(['objectApiName']));
  if (entityQuery === null && cands.slice(0, 3).some((c) => OBJECT_TOOLS.has(c.tool))) {
    const objectApiName = await probeObjectMention(ctx, input.question);
    if (objectApiName !== null) {
      entityQuery = objectApiName;
      entityTypes = ['CustomObject'];
    }
  }

  // ENTITY SUBSTITUTION — a PRONOUN anchor with NO real entity of the
  // question's own ("does it fire on delete too") is filled from host-passed
  // context. The carried componentId is resolved by EXACT id (never fuzzy):
  // found ⇒ it feeds in as the entity resolution; missing ⇒ a premise flag
  // below (stale context must never bind).
  const pronounAnchor = validatedContext !== null ? detectPronounAnchor(input.question) : null;
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
    if (previous.componentId !== undefined) {
      const carried = await getNodeById(ctx.graph, previous.componentId as ComponentId);
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
              node.parentId === null ? null : node.parentId.slice(node.parentId.indexOf(':') + 1),
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
    } else if (previous.objectApiName !== undefined) {
      // The previous turn was about an OBJECT: substitute it through the
      // normal resolve path, exactly like a question-derived object.
      entityQuery = previous.objectApiName;
      entityTypes = ['CustomObject'];
      contextSubstitution = { anaphor: pronounAnchor, from: 'previous.objectApiName' };
    }
  }

  // `Class.method` is a method reference, not Object.Field — resolve the CLASS
  // and carry the method so it can be bound (methodName).
  let methodRef: string | undefined;
  if (entityQuery !== null && contextExactResolution === null) {
    const apexRef = await splitApexMethodReference(ctx, entityQuery);
    if (apexRef !== null) {
      entityQuery = apexRef.classQuery;
      entityTypes = [apexRef.type];
      methodRef = apexRef.methodName;
    } else if (/\s+class$/i.test(entityQuery)) {
      const bareClass = entityQuery.replace(/\s+class$/i, '');
      const dotted = new RegExp(`\\b${bareClass.replace(/[^A-Za-z0-9_]/g, '')}\\.([A-Za-z][A-Za-z0-9_]*)\\b`).exec(
        input.question,
      );
      if (dotted?.[1] !== undefined) methodRef = dotted[1];
    }
  }

  const entityResolution =
    entityQuery !== null && contextExactResolution === null
      ? await resolveComponents(ctx.graph, entityQuery, {
          limit: 5,
          ...(entityTypes.length > 0 ? { types: entityTypes } : {}),
        })
      : null;
  const glossaryAwareEntityResolution =
    entityQuery !== null && entityResolution?.ok === true
      ? await applyGlossaryAliases(ctx, entityQuery, entityTypes, entityResolution.value)
      : null;
  // `let`: the premise check may REPLACE a type-scoped `none` with the unscoped
  // resolution when the name exists as a DIFFERENT component family.
  let refinedEntityResolution =
    contextExactResolution ??
    (entityQuery !== null && glossaryAwareEntityResolution !== null
      ? resolveParentQualifier(
          input.question,
          refineEntityResolution(entityQuery, glossaryAwareEntityResolution),
        )
      : null);

  // The resolved TYPE gates the shortlist: a tool that fails closed on this
  // component family is dropped (an Apex call graph over a Flow id, the
  // field-only access audit over an object), so it is never offered or bound.
  const resolvedExactType =
    refinedEntityResolution?.disposition === 'exact'
      ? refinedEntityResolution.candidates[0]?.type ?? null
      : null;
  if (resolvedExactType !== null) {
    cands = cands.filter((c) => compatibleWithType(c.tool, resolvedExactType));
  }

  let clarification: RouteClarification | null = null;
  const entityClarificationRequired =
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    (shortPhraseFallback
      ? refinedEntityResolution.disposition === 'ambiguous' &&
        hygienicClarificationOptions(refinedEntityResolution.candidates.slice(0, 5)).length >= 2
      : entityAmbiguityRequiresClarification(
          entityQuery,
          refinedEntityResolution,
          input.question,
          targetsSingleComponent(cands[0]?.tool),
        ));
  let entityEvidence: RouteQuestionOutput['entityEvidence'] =
    refinedEntityResolution !== null && refinedEntityResolution.disposition !== 'none'
      ? {
          query: entityQuery as string,
          typeHints: entityTypes,
          disposition: refinedEntityResolution.disposition,
          clarificationRequired: entityClarificationRequired,
          warning:
            refinedEntityResolution.disposition === 'ambiguous' && !entityClarificationRequired
              ? WEAK_MATCH_WARNING
              : null,
          candidates: toEvidenceRows(refinedEntityResolution.candidates),
        }
      : undefined;
  if (entityClarificationRequired) {
    clarification = {
      required: true,
      question: 'Several components match the named entity. Which component did you mean?',
      options: clarificationOptionIds(refinedEntityResolution?.candidates ?? []),
    };
  }

  // Margin gate — a simulation/readout near-tie at the head of the shortlist
  // the question does not settle; the entity clarification above always wins.
  clarification ??= marginClarification(cands, null, input.question);

  // COMPOUND VAULT+LIVE gate: an explicit metadata ask AND an explicit
  // live-runtime ask in one breath is a genuine plane choice — offer the
  // leading candidate of each plane as a tool-choice clarification.
  if (clarification === null && isCompoundPlaneAsk(input.question)) {
    const vaultTop = cands.find((candidate) => candidate.plane === 'vault');
    // A vault-dominated shortlist can carry no live rival at all; the
    // runtime-verification half still needs a live tool to offer — fall back
    // to the canonical execution-trace tool when the live half speaks of
    // something running/firing.
    const liveTop =
      cands.find((candidate) => candidate.plane === 'live' || candidate.plane === 'hybrid') ??
      (/\b(?:running|firing|executing|fired?|ran)\b/i.test(input.question)
        ? { tool: 'sfi.live_automation_fired' }
        : undefined);
    if (vaultTop !== undefined && liveTop !== undefined) {
      clarification = {
        required: true,
        question:
          `This asks for BOTH a vault-metadata answer AND a live-org verification — ` +
          `\`${vaultTop.tool}\` answers from the offline vault; \`${liveTop.tool}\` ` +
          `queries the org right now and needs the opt-in live plane. Which should ` +
          `lead? (Pick one; the other can run as a follow-up.)`,
        options: [vaultTop.tool, liveTop.tool],
      };
    }
  }

  // FALSE PREMISE. The question NAMED a specific entity but the resolver found
  // nothing: the host must not answer as if the component exists. The
  // candidates stay listed (the tools fail closed on an unknown id); the
  // entity is never bound and the warning is attached.
  let premiseFlagged = false;
  if (entityResolution !== null && !entityResolution.ok) {
    // A graph-query error must not collapse into the same shape as a resolve
    // that ran and found nothing. This does NOT claim the component is absent
    // (we genuinely do not know), so it does not set `premiseFlagged` — it only
    // makes the unchecked case distinguishable from a confirmed absence and
    // from a silent pass.
    entityEvidence = {
      query: entityQuery as string,
      typeHints: entityTypes,
      disposition: 'none',
      clarificationRequired: false,
      warning:
        `PREMISE CHECK INCONCLUSIVE: the existence check for '${entityQuery}' could not run ` +
        `(${entityResolution.error.message}) — the premise was NOT verified either way; treat it as ` +
        `unconfirmed rather than as a pass.`,
      candidates: [],
    };
  } else if (
    entityQuery !== null &&
    refinedEntityResolution !== null &&
    refinedEntityResolution.disposition === 'none'
  ) {
    // The extracted query can carry a schema noun the graph resolver does not
    // strip ("PaymentProcessor class"): retry the BARE name before flagging.
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
      bareRetry?.ok === true && bareRetry.value.disposition !== 'none' ? bareRetry.value : null;
    // TYPE-CONFUSION PREMISE: the resolve was TYPE-SCOPED ("the <X> permission
    // set") and found nothing under that type. Before declaring the component
    // nonexistent, retry UNSCOPED: when the name is a strong match under a
    // DIFFERENT family, the premise error is the STATED TYPE, not existence.
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
      refinedEntityResolution = crossTypeResolution;
      entityEvidence = {
        query: entityQuery,
        typeHints: entityTypes,
        disposition: crossTypeResolution.disposition,
        clarificationRequired: false,
        warning:
          `TYPE CHECK: no ${statedTypes} named '${entityQuery}' exists in the vault, but the name ` +
          `matches ${real.id} (a ${real.type}). The question's stated component type appears to be ` +
          `wrong — answer about the component that actually exists, and say so.`,
        candidates: toEvidenceRows(crossTypeResolution.candidates),
      };
    } else if (bareResolution !== null) {
      // The bare name IS real — surface it as evidence instead of a premise flag.
      refinedEntityResolution = bareResolution;
      entityEvidence = {
        query: bareQuery,
        typeHints: entityTypes,
        disposition: bareResolution.disposition,
        clarificationRequired: false,
        warning: bareResolution.disposition === 'ambiguous' ? WEAK_MATCH_WARNING : null,
        candidates: toEvidenceRows(bareResolution.candidates),
      };
    } else if (looksLikeComponentName(entityQuery)) {
      premiseFlagged = true;
      entityEvidence = {
        query: entityQuery,
        typeHints: entityTypes,
        disposition: 'none',
        clarificationRequired: false,
        warning: `PREMISE CHECK: no component matching '${entityQuery}' exists in the vault — ${PREMISE_TAIL}`,
        candidates: [],
      };
    } else {
      // PROSE-SHAPED extraction: the extractor scraped a sentence fragment, not
      // a name the user asserted — a `none` resolve on junk is NOT a false
      // premise. Record the evidence without a warning.
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
    // reference is an unambiguous NAME, and refineEntityResolution already
    // promotes a literal hit to exact — so an ambiguous literal means the
    // NAMED component does not exist and the rivals are fuzzy lookalikes.
    premiseFlagged = true;
    if (entityEvidence !== undefined) {
      entityEvidence = {
        ...entityEvidence,
        warning:
          `PREMISE CHECK: no component named '${entityQuery}' exists in the vault — the listed ` +
          `candidates are fuzzy lookalikes, not the component you named. ${PREMISE_TAIL}`,
      };
    }
  }

  // CONTEXT PREMISE — the componentId carried from the previous turn no longer
  // resolves (deleted, renamed, or newer than the last refresh). Stale context
  // must never bind or inherit a tool.
  if (contextGhostComponentId !== null) {
    premiseFlagged = true;
    entityEvidence = {
      query: contextGhostComponentId,
      typeHints: [],
      disposition: 'none',
      clarificationRequired: false,
      warning:
        `PREMISE CHECK: the component carried from the previous turn ` +
        `(${contextGhostComponentId}) no longer exists in the vault (deleted, renamed, ` +
        `or newer than the last refresh; /sfi-refresh may help). Do not answer as if it ` +
        `exists — re-ask with the component named explicitly.`,
      candidates: [],
    };
  }

  // EXISTENCE GATE: the question names an api-shaped component (custom-suffixed
  // or multi-part underscored) but extraction found no entity. Probe the name:
  // no literal match in the vault ⇒ the same premise flag as a resolved `none`,
  // with the nearest matches as explicitly-labeled lookalikes. A resolvable
  // name passes untouched. Dotted standard references are never probed.
  if (!premiseFlagged && entityQuery === null && clarification === null) {
    const probeToken = extractExistenceProbeToken(input.question);
    if (probeToken !== null) {
      const probe = await resolveComponents(ctx.graph, probeToken, { limit: 5 });
      if (!probe.ok) {
        // A graph-query error must not collapse into the same shape as a probe
        // that ran and found the name clean. This does NOT claim the component
        // is absent (we genuinely do not know), so it does not set
        // `premiseFlagged` — it only makes the unchecked case distinguishable.
        entityEvidence = {
          query: probeToken,
          typeHints: [],
          disposition: 'none',
          clarificationRequired: false,
          warning:
            `PREMISE CHECK INCONCLUSIVE: the existence check for '${probeToken}' could not run ` +
            `(${probe.error.message}) — the premise was NOT verified either way; treat it as ` +
            `unconfirmed rather than as a pass.`,
          candidates: [],
        };
      } else {
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
          entityEvidence = {
            query: probeToken,
            typeHints: [],
            disposition: 'none',
            clarificationRequired: false,
            warning:
              `PREMISE CHECK: no component named '${probeToken}' exists in the vault — any ` +
              `listed candidates are fuzzy lookalikes, not the component you named. ${PREMISE_TAIL}`,
            candidates: toEvidenceRows(probe.value.candidates),
          };
        }
      }
    }
  }

  // Which component gets bound: an EXACT, unblocked, premise-clean winner.
  let winner: Winner | null =
    !premiseFlagged && refinedEntityResolution?.disposition === 'exact'
      ? refinedEntityResolution.candidates[0] ?? null
      : null;

  // CONTEXT: continuation / re-parameterization / gap-shaped follow-up.
  let gap: RouteGap | null = null;
  let contextApplied: RouteContextApplied | null = null;
  if (validatedContext !== null && clarification === null && !premiseFlagged) {
    const previous = validatedContext.previous;
    const reparamAnchor = detectReparamAnchor(input.question);
    const followUpShaped =
      pronounAnchor !== null || reparamAnchor !== null || entityQuery === null;
    // GAP DETECTION BEFORE CONTINUATION: a follow-up that is ITSELF gap-shaped
    // — a judgment ("should they be able to?"), delivery ("as a file?"),
    // tool-self-capability, or deployment-status ask about the carried
    // component — must NOT inherit the previous turn's tool.
    const gapFollowUpFamily = followUpShaped ? detectGapShapedFollowUp(input.question) : null;
    if (gapFollowUpFamily !== null) {
      const gapDescription: Record<string, string> = {
        judgment:
          'a normative judgment (should/normal/risky) — sf-intelligence reads org metadata and has no opinion to offer',
        delivery: 'file export or message delivery, which the product does not perform',
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
      gap = {
        category: 'context-gap-followup',
        note:
          `HONEST GAP (context follow-up): this follow-up asks for ` +
          `${gapDescription[gapFollowUpFamily] ?? gapFollowUpFamily}.${carried}`,
      };
      winner = null;
    } else if (previous.tool !== undefined) {
      // RE-PARAMETERIZATION — a REPARAM anchor re-asks the PREVIOUS tool against
      // a NEW target ("what about on Contact?"). The new target is the
      // question's own exact resolution (when not itself the context
      // substitution), else the anchor-stripped remainder through the NORMAL
      // resolver — an ambiguous new entity still blocks.
      let target: Winner | null = null;
      let kind: 'reparameterization' | 'continuation' | null = null;
      let from: RouteContextApplied['from'] | undefined;
      if (reparamAnchor !== null) {
        if (contextSubstitution === null && winner !== null) {
          target = winner;
        } else if (contextSubstitution === null) {
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
                  targetsSingleComponent(previous.tool),
                )
              ) {
                clarification = {
                  required: true,
                  question: 'Several components match the named entity. Which component did you mean?',
                  options: hygienicClarificationOptions(refinedTarget.candidates.slice(0, 5)).map(
                    (candidate) => candidate.id,
                  ),
                };
              }
            }
          }
        }
        if (target !== null) kind = 'reparameterization';
      }
      // CONTINUATION — a PRONOUN anchor (or a REPARAM anchor with no new
      // entity) inherits the previous turn's tool, bound to the substituted
      // entity. Requires the substitution to have resolved EXACT, or no
      // componentId to have been carried at all.
      if (kind === null && clarification === null && (pronounAnchor ?? reparamAnchor) !== null) {
        const substitutedExact = contextSubstitution !== null && winner !== null;
        if (substitutedExact || previous.componentId === undefined) {
          target = substitutedExact ? winner : null;
          kind = 'continuation';
          if (substitutedExact) from = contextSubstitution!.from;
        }
      }
      if (
        kind !== null &&
        (target === null || continuationToolCompatible(previous.tool, target.type))
      ) {
        const anchor = (kind === 'reparameterization' ? reparamAnchor : pronounAnchor ?? reparamAnchor)!;
        cands = leadWith(cands, previous.tool, target !== null ? 'medium' : 'low');
        if (target !== null) winner = target;
        contextApplied = {
          kind,
          anaphor: anchor,
          ...(target !== null ? { substitutedComponentId: target.id } : {}),
          ...(from !== undefined ? { from } : {}),
          inheritedTool: previous.tool,
        };
      }
    }
    // ENTITY SUBSTITUTION alone (no tool inherited): disclose it.
    if (contextApplied === null && contextSubstitution !== null && winner !== null) {
      contextApplied = {
        kind: 'entity-substitution',
        anaphor: contextSubstitution.anaphor,
        substitutedComponentId: winner.id,
        from: contextSubstitution.from,
      };
    }
  }

  // Can anything be placed? An ANAPHOR-ONLY fragment with NO host context
  // ("does it call an invocable apex at least?") cannot be: the pronoun is
  // unresolvable, and a cosine graze would dress it up as a route. An empty
  // shortlist means no word of the question is in the catalog. Thin evidence
  // on a shortlist that exists is the rows' own `confidence` band.
  if (gap === null && contextApplied === null) {
    const questionHead = input.question.trim().split(/\s+/).slice(0, 5).join(' ');
    const anaphorOnlyFragment =
      validatedContext === null &&
      detectPronounAnchor(questionHead) !== null &&
      (entityQuery === null || isAnaphorOnly(entityQuery));
    if (anaphorOnlyFragment) {
      gap = {
        category: 'unrouted',
        note: 'The question refers to something ("it", "they") the host did not pass as context, so no tool can be placed; pass `context.previous` or re-ask with the component named.',
      };
    } else if (cands.length === 0) {
      gap = {
        category: 'unrouted',
        note: 'No tool matched any word of the question; the vocabulary is unknown to the tool catalog.',
      };
    } else if (entityEvidence === undefined && shortlistBelowEvidenceFloor(input.question, cands)) {
      // The same floor that stamps the rows `low`: nothing in the question
      // names a component and the best tool matched only a stray word.
      gap = {
        category: 'out-of-scope',
        note: 'The question shares almost no vocabulary with the tool catalog; it is probably outside what the vault answers. The shortlist is a guess.',
      };
    }
  }

  // Clarification challenge id + a stateless response to an earlier one.
  const clarificationId = clarificationIdFor(ctx.manifest.sourceTreeHash, input.question, clarification);
  if (clarificationId !== null && clarification !== null) {
    clarification = { ...clarification, id: clarificationId };
  }
  let clarificationResolution: RouteQuestionOutput['clarificationResolution'];
  const response = input.clarificationResponse;
  if (response !== undefined) {
    if (clarification?.required !== true || clarificationId === null) {
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
    if (!clarification.options.includes(response.selection)) {
      return err({
        kind: 'invalid-query',
        message:
          `clarificationResponse.selection must be one of the offered options: ${clarification.options.join(', ')}`,
        path: 'clarificationResponse.selection',
      });
    }
    if (response.selection.startsWith('sfi.')) {
      // A tool-choice clarification offered TOOL names. The user picking one
      // pins the shortlist to that tool: it leads, the losing rival is dropped.
      const losers = new Set(clarification.options.filter((o) => o !== response.selection));
      cands = leadWith(cands.filter((c) => !losers.has(c.tool)), response.selection, 'high');
      clarificationResolution = { clarificationId, selection: response.selection, kind: 'tool' };
    } else {
      // An entity clarification offered COMPONENT ids. The pick is looked up by
      // exact id and becomes the bound winner — never a guessed key.
      const picked = await getNodeById(ctx.graph, response.selection as ComponentId);
      if (!picked.ok || picked.value === null) {
        return err({
          kind: 'invalid-query',
          message: `The selected component '${response.selection}' is no longer in the vault. Route the question again.`,
          path: 'clarificationResponse.selection',
        });
      }
      const node = picked.value;
      winner = {
        id: node.id,
        type: node.type,
        apiName: node.apiName,
        parentApiName:
          node.parentId === null ? null : node.parentId.slice(node.parentId.indexOf(':') + 1),
      };
      cands = cands.filter((c) => compatibleWithType(c.tool, node.type));
      if (entityEvidence !== undefined) {
        entityEvidence = {
          ...entityEvidence,
          clarificationRequired: false,
          selectedComponentId: response.selection,
        };
      }
      clarificationResolution = { clarificationId, selection: response.selection, kind: 'entity' };
    }
    clarification = null;
  }

  const executionBlocked = clarification?.required === true;
  if (executionBlocked) winner = null;

  // Bind the resolved component into every candidate under the tool's own
  // declared key; literals the question states (a quoted picklist value, a
  // "to <type>" target) bind to the tool's required value args.
  const binding: EntityBinding | null =
    winner !== null
      ? {
          winner: {
            id: winner.id,
            type: winner.type,
            apiName: winner.apiName,
            parentApiName: winner.parentApiName,
          },
          ...(methodRef !== undefined ? { methodName: methodRef } : {}),
        }
      : null;
  const argsFor = (tool: string): Readonly<Record<string, unknown>> =>
    bindQuestionLiterals(tool, bindToolArgs(tool, binding), input.question);
  const withArgs = (row: ToolCandidate): ToolCandidate => {
    const args = argsFor(row.tool);
    const missing = missingRequiredArgs(row.tool, args);
    const { suggestedArgs: _prev, missingArgs: _prevMissing, ...rest } = row;
    return {
      ...rest,
      ...(Object.keys(args).length > 0 ? { suggestedArgs: args } : {}),
      ...(missing.length > 0 ? { missingArgs: missing } : {}),
    };
  };
  // A hidden retired alias is not invocable under core — never offer it.
  const bound = cands.filter((c) => !HIDDEN_TOOLS.has(c.tool)).map(withArgs);

  // "what does Class.method do?": the class resolved exactly and the method was
  // parsed, so the tools that take a method (derived from their schemas) are
  // appended, bound, at low confidence — executable first, at most 3.
  let methodRows: ToolCandidate[] = [];
  if (
    binding?.methodName !== undefined &&
    (binding.winner.type === 'ApexClass' || binding.winner.type === 'ApexTrigger')
  ) {
    const present = new Set(bound.map((c) => c.tool));
    const rows = toolsDeclaringArg(['methodName', 'method'])
      .filter((tool) => !HIDDEN_TOOLS.has(tool) && !present.has(tool))
      .map((tool) =>
        withArgs({
          tool,
          score: 0,
          cosine: 0,
          category: null,
          ...resolveCandidatePlane(tool),
          confidence: 'low',
        }),
      );
    methodRows = [
      ...rows.filter((r) => r.missingArgs === undefined),
      ...rows.filter((r) => r.missingArgs !== undefined),
    ].slice(0, 3);
    bound.push(...methodRows);
  }

  // With the live plane OFF for this process, a live-only tool cannot answer —
  // keep it listed (consent can be granted) but below every vault row.
  const liveOk = bound.some((c) => c.liveRequired) ? livePlaneAvailable() : true;
  const toolCandidates = withCandidateFacts(
    liveOk ? bound : [...bound.filter((c) => !c.liveRequired), ...bound.filter((c) => c.liveRequired)],
  );

  if (entityEvidence !== undefined) {
    entityEvidence = {
      ...entityEvidence,
      candidates: evidenceOrder(entityEvidence.candidates, entityEvidence.disposition === 'exact'),
    };
  }

  // Under the core profile the client only holds the core schemas, so the
  // leading candidates also come as calls — gateway envelopes for non-core
  // tools; a step with unbound required args says so. A bound Class.method
  // question runs its method tools first.
  const runnableMethodRows = methodRows.filter((r) => r.missingArgs === undefined);
  const invoke =
    toolProfile() === 'core' && !executionBlocked && toolCandidates.length > 0
      ? [
          ...runnableMethodRows,
          ...toolCandidates.filter((c) => !runnableMethodRows.some((m) => m.tool === c.tool)),
        ]
          .slice(0, INVOKE_DEPTH)
          .map((c) => invocationFor(c.tool, c.suggestedArgs ?? {}))
      : undefined;

  const logged =
    input.logGap === true && gap !== null
      ? await logGap(input.question, gap, undefined, ctx.vaultRoot)
      : null;
  const data: RouteQuestionOutput = {
    question: input.question,
    ...(toolCandidates.length > 0 ? { toolCandidates } : {}),
    ...(toolCandidates.length > 0 ? { guidance: guidanceForMode(input.mode, toolCandidates, gap) } : {}),
    clarification,
    executionBlocked,
    gap,
    ...(entityEvidence !== undefined ? { entityEvidence } : {}),
    ...(clarificationResolution !== undefined ? { clarificationResolution } : {}),
    ...(contextApplied !== null
      ? {
          contextApplied: {
            ...contextApplied,
            ...(validatedContext !== null && validatedContext.ignored.length > 0
              ? { ignored: validatedContext.ignored }
              : {}),
          },
        }
      : {}),
    gapLogged: logged !== null,
    rendered: '',
    trust: routeTrust(),
    ...(invoke !== undefined ? { invoke } : {}),
  };
  return ok({
    data: { ...data, rendered: renderShortlistMarkdown(data) },
    vaultState: vaultState(ctx),
  });
};
