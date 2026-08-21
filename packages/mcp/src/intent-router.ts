/**
 * Intent router — the front-door brain.
 *
 * Maps a plain-language admin/dev/architect question to the plane that can
 * answer it (`vault` | `live` | `hybrid`) and the ordered `sfi.*` tools that do
 * the work, so the admin never has to know a tool name. It is deliberately a
 * DETERMINISTIC, rule-based classifier (ordered shape rules, first match wins)
 * — not an LLM guess — so it is regression-testable and never fabricates a
 * route. When nothing matches, or a question needs a capability we have not
 * built yet, it returns `plane: 'unknown'` / a `gap` and points at
 * `sfi.resolve` / `sfi.capabilities` instead of pretending. The gap is appended
 * to the local backlog only when the `route_question` caller explicitly opts in
 * with `logGap: true` (privacy-first, off by default — CR-16).
 *
 * Coverage goal: the org has ~120 read-only tools spanning schema, automation,
 * order-of-execution, code quality, security/sharing, PII, integration,
 * cleanup, what-if impact, docs, change/diff, CPQ/OmniStudio, and the live
 * plane. This router's job is to EXPOSE that surface from natural language —
 * every family below routes to a real tool — and to honestly surface the long
 * tail it does not yet cover (logged to the backlog only on explicit opt-in) so
 * the library grows toward real demand.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RefusalShape } from './refusal-gates.js';

/** The intelligence plane a question is best answered from. */
export type Plane = 'vault' | 'live' | 'hybrid' | 'knowledge' | 'unknown';

/** A logged "we don't have a great tool for this yet" signal. */
export interface RouteGap {
  /** Stable category key for aggregating demand (e.g. `reports-usage`). */
  readonly category: string;
  /** One-line, human note on what is missing and the honest fallback. */
  readonly note: string;
}

export type RouteConfidence = 'high' | 'medium' | 'low';
export type RouteRisk = 'informational' | 'change-planning' | 'security-sensitive' | 'destructive';

export interface RouteAlternative {
  readonly intent: string;
  readonly plane: Plane;
  readonly tools: readonly string[];
  readonly reason: string;
}

export interface RouteClarification {
  /** Stateless challenge id stamped by route_question for safe continuation. */
  readonly id?: string;
  readonly required: boolean;
  readonly question: string;
  readonly options: readonly string[];
  /** Provisional route a client may use only after clarification cannot be obtained. */
  readonly fallback?: {
    readonly intent: string;
    readonly warning: string;
  };
}

export interface RoutePlanStep {
  readonly stepId: string;
  /** Other plan steps whose result/context is required before this step. */
  readonly dependsOn: readonly string[];
  readonly question: string;
  readonly intent: string;
  readonly plane: Plane;
  readonly tools: readonly string[];
}

/**
 * Disclosure of how HOST-PASSED conversation context changed this route
 * (router-v2 P5). Present ONLY when context actually changed the route — the
 * mere presence of the `context` input param never emits it. The product
 * stays stateless: the host passes context per call; nothing is stored
 * server-side.
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

/** The router's verdict for one question. */
export interface RouteResult {
  readonly question: string;
  readonly plane: Plane;
  /** Stable intent label (e.g. `record-count`, `field-access`). */
  readonly intent: string;
  /** Ordered `sfi.*` tools to call; empty for `unknown`. */
  readonly tools: readonly string[];
  /** Does answering require the opt-in live plane? */
  readonly liveRequired: boolean;
  /** Does the question name a component informally (resolve FIRST)? */
  readonly needsResolve: boolean;
  /** Short why-this-route explanation, surfaced to the user. */
  readonly reason: string;
  /** Set when the question hit a known gap or could not be routed. */
  readonly gap: RouteGap | null;
  /** Confidence in the route selection, distinct from answer/data confidence. */
  readonly confidence: RouteConfidence;
  /** Consequence class used to decide whether ambiguity must stop for clarification. */
  readonly risk: RouteRisk;
  /** Other rule families that also plausibly matched the same wording. */
  readonly alternatives: readonly RouteAlternative[];
  /** Clarification prompt; required for ambiguous high-consequence routes. */
  readonly clarification: RouteClarification | null;
  /** Distinct route steps extracted from an explicit compound question. */
  readonly plan: readonly RoutePlanStep[];
  /**
   * Per-intent argument hints the agent can pass straight to the routed tool —
   * e.g. `{ event: 'update' }` for a save-order question so the caller need not
   * guess the DML event `what_happens_on_save` requires. Heuristic and present
   * only when the intent has derivable args (absent otherwise).
   */
  readonly suggestedArgs?: Readonly<Record<string, unknown>>;
  /**
   * Present ONLY when a score-independent refusal-shape gate fired (router-v2
   * P2): a write imperative (`refused-write`), prompt-injection / record-value
   * exfiltration (`refused-injection`), unmodeled runtime telemetry
   * (`honest-gap-runtime`), or a non-Salesforce ask (`out-of-scope`). A refusal
   * route is NEVER executable — `tools` is empty and the disclosure is the
   * route's `reason`. Additive: hosts reading `route.intent` are unaffected.
   */
  readonly refusal?: RefusalShape;
  /**
   * Present ONLY when host-passed conversation context changed this route
   * (router-v2 P5): what was substituted/inherited and from which
   * `context.previous` field. Absent whenever context was not passed, or was
   * passed but did not change the route (a self-contained question ignores
   * context). Additive and purely a disclosure.
   */
  readonly contextApplied?: RouteContextApplied;
}

interface Rule {
  readonly intent: string;
  readonly plane: Exclude<Plane, 'unknown'>;
  readonly tools: readonly string[];
  readonly liveRequired: boolean;
  readonly needsResolve: boolean;
  readonly reason: string;
  readonly patterns: readonly RegExp[];
  /** When present, this route is honest about a missing dedicated tool. */
  readonly gap?: RouteGap;
  /**
   * Optional derivation of `suggestedArgs` from the (lowercased) route text —
   * e.g. parse the DML event for a save-order route. Returns undefined when
   * nothing can be inferred.
   */
  readonly suggestArgs?: (
    q: string,
    question?: string,
  ) => Readonly<Record<string, unknown>> | undefined;
}

const riskForIntent = (intent: string): RouteRisk => {
  if (
    intent.startsWith('safe-to-delete') ||
    intent.startsWith('what-if') ||
    intent === 'profile-migration'
  ) return 'destructive';
  if (
    /access|permission|security|sharing|compliance|pii|why-cant|over-permission/.test(intent)
  ) return 'security-sensitive';
  if (/impact|risk|release-readiness|value-change|tests-for-change/.test(intent)) {
    return 'change-planning';
  }
  return 'informational';
};

const routeFromRule = (question: string, q: string, rule: Rule): RouteResult => {
  const suggestedArgs = rule.suggestArgs?.(q, question);
  return {
    question,
    plane: rule.plane,
    intent: rule.intent,
    tools: rule.tools,
    liveRequired: rule.liveRequired,
    needsResolve: rule.needsResolve,
    reason: rule.reason,
    gap: rule.gap ?? null,
    confidence: 'high',
    risk: riskForIntent(rule.intent),
    alternatives: [],
    clarification: null,
    plan: [],
    ...(suggestedArgs !== undefined ? { suggestedArgs } : {}),
  };
};

/**
 * Rebuild a route for an explicitly selected intent. Used only after
 * route_question validates that the intent was one of the clarification
 * options it offered; never use this as a free-form intent override.
 */
export const routeForSelectedIntent = (
  question: string,
  intent: string,
): RouteResult | null => {
  const rule = RULES.find((candidate) => candidate.intent === intent);
  if (rule === undefined) return null;
  const route = routeFromRule(question, routeText(question), rule);
  return {
    ...route,
    confidence: 'high',
    clarification: null,
    plan: [
      {
        stepId: 'step-1',
        dependsOn: [],
        question,
        intent: route.intent,
        plane: route.plane,
        tools: route.tools,
      },
    ],
  };
};

// Normalize smart/curly apostrophes (’ ‘ ʼ) to ASCII ' so patterns like
// `can'?t` match "can’t" — IDEs, docs, and copy-paste routinely produce the
// curly form, which silently broke why-cant-see routing (P12-UX-capabilities-
// router-contract).
const normalize = (q: string): string =>
  q.trim().toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');

/**
 * Source for a "the question NAMES a component" regex fragment (lowercased). A
 * token carrying at least two underscores — e.g. `rt_cu_as_create_new_advising_
 * case`, `application_save_rt_orch`, `populate_program_of_interest_on_lead` — is
 * unambiguously a Salesforce API name, never English prose (real words never
 * stack two underscores). Used only in conjunction with a narration/behavior
 * verb so it fires solely on "explain/summarize/walk-through/does <Name> fire"
 * shapes, and it deliberately excludes the `hed__`/`__c`/`__mdt`/`__e`
 * double-underscore custom-suffix forms (those are objects/fields, handled by
 * the schema rules) via the leading `(?!\w*__)` guard on the first token. Kept
 * as a string so callers can embed it in a larger anchored pattern.
 */
const NAMED_COMPONENT_ID = '(?!\\w*__)[a-z][a-z0-9]*_[a-z0-9]+_[a-z0-9_]*[a-z0-9]';

/**
 * Source for a "the question NAMES a specific field" regex fragment
 * (lowercased). Matches either the dotted `<Object>.<field>` form
 * (`case.foo_code__c`, `lead.bar_id__c`, `opportunity.amount`) OR a
 * bare custom-field api name carrying the `__c` suffix
 * (`widget_status__c`, `order_flag__c`). This is the
 * field-forensics analogue of NAMED_COMPONENT_ID: it fires ONLY on an explicit
 * field reference, so a field-lineage / field-provenance / safe-to-delete /
 * what-if rule built on it cannot steal a bare-English question (which carries
 * neither a dot nor a `__c`). Kept as a string so callers can embed it in a
 * larger anchored pattern. The dotted branch requires a lowercase-letter start
 * so a decimal ("3.5") is never mistaken for a field ref.
 */
const NAMED_FIELD_ID =
  '(?:[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*|[a-z][a-z0-9_]*__c)';

/**
 * Infer the DML event a save-order question is about, so the router can hand
 * `what_happens_on_save` the `event` arg it REQUIRES instead of the caller
 * guessing. Order matters: 'undelete' is checked before 'delete'. Defaults to
 * 'update' — the most common ask and the safe default when the verb is implicit
 * ("what runs on save", "when a Case status changes"). Input is the already
 * lowercased route text.
 */
const deriveSaveEvent = (
  q: string,
): 'insert' | 'update' | 'delete' | 'undelete' => {
  if (/\b(undelet|restor)/.test(q)) return 'undelete';
  if (/\b(creat|insert)/.test(q)) return 'insert';
  if (/\b(delet|remov)/.test(q)) return 'delete';
  return 'update';
};

/**
 * Map a greenfield/best-practice question to a `KNOWLEDGE_TOPICS` key for the
 * `knowledge` plane, so the router can hand `sfi.guidance` the right `topic`.
 * Only the clearest non-org-specific asks are mapped; returns undefined when no
 * topic is confident (guidance then lists the catalog). Input is lowercased.
 */
const deriveKnowledgeTopic = (q: string): string | undefined => {
  if (/\b(flow\s+(vs\.?|versus|or)\s+apex|apex\s+(vs\.?|versus|or)\s+flow)\b/.test(q)) return 'flow-vs-apex';
  if (/\bwhen\s+(should\s+i|to)\s+use\b.*\bflow\b/.test(q)) return 'flow-vs-apex';
  if (/\b(apex\s+)?trigger\s+framework\b/.test(q)) return 'trigger-framework';
  if (
    /\basync(hronous)?\s+apex\b/.test(q) ||
    /\b(future|queueable|batch|schedulable)\b.*\b(vs\.?|versus|when\s+to|which\s+to|each\s+appropriate|options?)\b/.test(q)
  )
    return 'async-apex';
  if (/\b(sfdx|source[-\s]driven\s+development|scratch\s+orgs?)\b/.test(q)) return 'sfdx-source-driven-dev';
  if (/\bunlocked\s+packages?\b/.test(q)) return 'package-strategy';
  if (/\bsingle[-\s]org\b.*\bmulti[-\s]org\b/.test(q)) return 'single-vs-multi-org';
  if (/\bdata\s+(retention|archiv)/.test(q)) return 'data-retention-archiving';
  if (/\b(large\s+data\s+volumes?|\bldv\b)/.test(q)) return 'large-data-volumes';
  if (/\bnaming\s+conventions?\b/.test(q)) return 'naming-conventions';
  if (/\b(test\s+classes?|test\s+data\s+factory|structure\s+apex\s+test)\b/.test(q)) return 'apex-testing';
  if (/\bstandard\s+profiles?\b.*\b(ship|new\s+org)\b/.test(q)) return 'profiles-vs-permission-sets';
  // Concept ask about the ACCESS PRIMITIVES themselves ("what is a profile") —
  // the indefinite-article form names no org component, so it is knowledge,
  // not a Profile-record lookup (eval family A over-clarify). The generic
  // "difference between a profile and a permission set" phrasing deliberately
  // stays on compare-profiles (see the access-surface fixture) — that route
  // just must never raise an entity menu for the bare type words.
  if (/\bwhat\s+is\s+an?\s+(?:profile|permission\s+set)\b/.test(q)) return 'profiles-vs-permission-sets';
  if (/\b(person\s+accounts?)\b/.test(q)) return 'standard-vs-custom-objects';
  if (/\b(ci\/cd|source\s+control|deployment\s+(and\s+)?release)\b/.test(q)) return 'release-management';
  if (/\bsandboxes?\b.*\b(refresh|managed)\b/.test(q)) return 'sandbox-environment-strategy';
  if (/\benvironment\s+and\s+release\s+strategy\b/.test(q)) return 'sandbox-environment-strategy';
  return undefined;
};

/**
 * Derive a `list_components` `type` filter from a schema enumeration question, so
 * the router can hand `sfi.list_components` the `type` it REQUIRES (the v0.1
 * contract errors `type is required` when omitted) instead of the caller hitting
 * a missing-param error on a discovery ask (e.g. "duplicate rules on Lead" →
 * `DuplicateRule`). Conservative: returns a type only when the question clearly
 * names a component *family to enumerate*; returns undefined for shapes that
 * need a parent (e.g. "what fields does Account have") where an unfiltered,
 * org-wide list would be the wrong answer. Input is lowercased route text. The
 * emitted strings are valid `list_components` ComponentTypes.
 */
const deriveListType = (q: string): string | undefined => {
  // Rule families + other directly-enumerable types. Patterns are mutually
  // exclusive in practice, so first match wins.
  const byKeyword: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bduplicate\s+rules?\b/, 'DuplicateRule'],
    [/\bmatching\s+rules?\b/, 'MatchingRule'],
    [/\bvalidation\s+rules?\b/, 'ValidationRule'],
    [/\bsharing\s+rules?\b/, 'SharingRule'],
    [/\bworkflow\s+rules?\b/, 'WorkflowRule'],
    [/\bassignment\s+rules?\b/, 'AssignmentRule'],
    [/\bescalation\s+rules?\b/, 'EscalationRule'],
    [/\bauto[-\s]?response\s+rules?\b/, 'AutoResponseRule'],
    [/\brecord\s+types?\b/, 'RecordType'],
    [/\bstatic\s+resources?\b/, 'StaticResource'],
    [/\bcustom\s+labels?\b/, 'CustomLabel'],
    [/\bpermission\s+set\s+groups?\b/, 'PermissionSetGroup'],
    [/\breport\s+types?\b/, 'ReportType'],
    [/\b(lightning\s+web\s+components?|lwcs?)\b/, 'LightningComponentBundle'],
    [/\b(aura\s+components?|aura\s+bundles?)\b/, 'AuraDefinitionBundle'],
    [/\bvisualforce\s+pages?\b/, 'ApexPage'],
    [/\bpublic\s+groups?\b/, 'Group'],
    [/\bqueues?\b/, 'Queue'],
    [/\btest\s+classes?\b/, 'ApexClass'],
    [/\bprocess\s+builder\b/, 'Flow'],
  ];
  for (const [re, type] of byKeyword) if (re.test(q)) return type;
  // "list (all) X" enumerations — only the explicit list forms, so "fields of X"
  // (which needs a parent id) is deliberately left undefined.
  const listed = q.match(
    /\blist\s+(?:all\s+)?(objects?|flows?|classes?|profiles?|permission\s+sets?|layouts?|queues?|groups?|labels?)\b/,
  );
  const w = listed?.[1];
  if (w !== undefined) {
    if (/object/.test(w)) return 'CustomObject';
    if (/flow/.test(w)) return 'Flow';
    if (/class/.test(w)) return 'ApexClass';
    if (/permission/.test(w)) return 'PermissionSet';
    if (/profile/.test(w)) return 'Profile';
    if (/layout/.test(w)) return 'Layout';
    if (/queue/.test(w)) return 'Queue';
    if (/group/.test(w)) return 'Group';
    if (/label/.test(w)) return 'CustomLabel';
  }
  // "what custom objects do we have" — a common schema enumeration with no parent.
  if (/\bcustom\s+objects?\b/.test(q)) return 'CustomObject';
  if (/\bapex\s+classes?\b/.test(q) && /\btest\b/.test(q)) return 'ApexClass';
  return undefined;
};

/** Common standard objects for parent-scoped field inventory routing. */
const FIELD_PARENT_OBJECTS = [
  'Account',
  'Contact',
  'Opportunity',
  'Lead',
  'Case',
  'Campaign',
  'User',
] as const;

/**
 * When a question enumerates fields ON a named object ("what fields does Account
 * have", "standard fields on Lead"), return `list_components` parentId so the
 * router can suggest `{ type: 'CustomField', parentId }` instead of an org-wide
 * CustomField list (which errors without a parent in v0.1).
 */
const deriveFieldListParent = (q: string): string | undefined => {
  if (!/\bfields?\b/.test(q)) return undefined;
  for (const objectApi of FIELD_PARENT_OBJECTS) {
    if (new RegExp(`\\b${objectApi}\\b`, 'i').test(q)) {
      return `CustomObject:${objectApi}`;
    }
  }
  return undefined;
};

/**
 * Parent object for metadata families scoped to one object (duplicate rules on
 * Lead, validation rules on Contact, flows on hed__Application__c).
 */
const deriveMetadataParentId = (q: string, question?: string): string | undefined => {
  const fieldParent = deriveFieldListParent(q);
  if (fieldParent !== undefined) return fieldParent;
  const source = question ?? q;
  const onObject = source.match(
    /\b(?:on|for|configured\s+on|access\s+to)\s+(?:the\s+|an\s+|a\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt)?)\b/,
  );
  if (onObject?.[1] !== undefined) return `CustomObject:${onObject[1]}`;
  return undefined;
};

/**
 * Prepositional captures that are DML/schema nouns, not object names — "what
 * happens on SAVE for a Contact" must skip "save" and bind Contact, not emit
 * `objectApiName: 'save'`.
 */
const NON_OBJECT_CAPTURES: ReadonlySet<string> = new Set([
  'save', 'saves', 'saving', 'insert', 'update', 'delete', 'undelete',
  'create', 'creation', 'edit', 'record', 'records', 'object', 'objects',
  'it', 'this', 'that', 'them', 'each', 'every', 'all',
]);

/** Extract a Salesforce object apiName from a routed question phrase. */
const deriveObjectApiFromQuestion = (q: string, question?: string): string | undefined => {
  const source = question ?? q;
  const toolObject = source.match(
    /\b(?:automation_build_advisor|order_of_execution|apex_build_advisor)\b\s+(?:on\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\b/i,
  );
  if (toolObject?.[1] !== undefined) return toolObject[1];
  const onObjectRe =
    /\b(?:on|for|to|access\s+to)\s+(?:the\s+|an\s+|a\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\b/gi;
  for (const match of source.matchAll(onObjectRe)) {
    const capture = match[1];
    if (capture !== undefined && !NON_OBJECT_CAPTURES.has(capture.toLowerCase())) {
      return capture;
    }
  }
  const dmlObject = source.match(
    /\b(?:update|insert|delete|save|create|edit)\s+(?:a\s+|an\s+|the\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\b/,
  );
  if (dmlObject?.[1] !== undefined) return dmlObject[1];
  const objectBeforeDml = source.match(
    /\b([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\s+(?:insert|update|delete|save|create)\b/i,
  );
  if (objectBeforeDml?.[1] !== undefined) return objectBeforeDml[1];
  const custom = source.match(/\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e))\b/);
  return custom?.[1];
};

/** Optional hop depth from `get_impact … hops=2` phrasing. */
const deriveImpactHops = (q: string): number | undefined => {
  const match = q.match(/\bhops\s*[=:]\s*(\d+)/);
  if (match === null) return undefined;
  const hops = Number(match[1]);
  return Number.isFinite(hops) ? hops : undefined;
};

const FIELD_MAP_OBJECT =
  '(Lead|Contact|Account|Opportunity|Case|[A-Za-z][A-Za-z0-9_]*(?:__c|__mdt)?)';

/**
 * Bind `field_mapping_between_objects` from Lead→Contact / between A and B phrasing.
 * Vault alias is injected by `route_question` from the active vault registry.
 */
const deriveFieldMappingArgs = (
  q: string,
  question?: string,
): Readonly<Record<string, unknown>> | undefined => {
  const source = question ?? q;
  const arrow = source.match(
    new RegExp(`\\b${FIELD_MAP_OBJECT}\\s*(?:→|->|>|\\sto\\s)\\s*${FIELD_MAP_OBJECT}\\b`, 'i'),
  );
  if (arrow?.[1] !== undefined && arrow[2] !== undefined) {
    return { objectA: arrow[1], objectB: arrow[2] };
  }
  const between = source.match(
    new RegExp(
      `\\b(?:between|from)\\s+${FIELD_MAP_OBJECT}\\s+(?:and|to)\\s+${FIELD_MAP_OBJECT}\\b`,
      'i',
    ),
  );
  if (between?.[1] !== undefined && between[2] !== undefined) {
    return { objectA: between[1], objectB: between[2] };
  }
  const mapPhrase = source.match(
    new RegExp(
      `\\bmap(?:ping|ped)?\\s+(?:from\\s+)?${FIELD_MAP_OBJECT}\\s+(?:to|into)\\s+${FIELD_MAP_OBJECT}\\b`,
      'i',
    ),
  );
  if (mapPhrase?.[1] !== undefined && mapPhrase[2] !== undefined) {
    return { objectA: mapPhrase[1], objectB: mapPhrase[2] };
  }
  return undefined;
};

/** Profile id hints for layout_for_user from natural-language profile names. */
const deriveLayoutForUserArgs = (
  q: string,
  question?: string,
): Readonly<Record<string, unknown>> | undefined => {
  const source = (question ?? q).toLowerCase();
  const objectApiName = deriveObjectApiFromQuestion(q, question);
  let profileId: string | undefined;
  if (/\bfaculty[-\s]?profile\b|\bfaculty\b/.test(source)) {
    profileId = 'Profile:Faculty';
  } else if (/\b(system\s+administrator|admin)\s+profile\b|\badmin\b/.test(source)) {
    profileId = 'Profile:System Administrator';
  } else if (/\bintegration\b|\bapi\b.*\buser\b/.test(source)) {
    profileId = 'Profile:Minimum Access - Salesforce';
  }
  const args: Record<string, unknown> = {};
  if (objectApiName !== undefined) args.objectApiName = objectApiName;
  if (profileId !== undefined) args.profileId = profileId;
  return Object.keys(args).length > 0 ? args : undefined;
};

/** Scope pii_inventory to an object when the question names one. */
const derivePiiInventoryArgs = (
  q: string,
  question?: string,
): Readonly<Record<string, unknown>> | undefined => {
  const objectApiName = deriveObjectApiFromQuestion(q, question);
  return objectApiName !== undefined ? { objectApiName } : undefined;
};

/**
 * `list_components` narrows for metadata-count questions about flows on an object.
 */
const deriveMetadataCountArgs = (
  q: string,
  question?: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (/\bvalidation\s+rules?\b/.test(q)) {
    const parentId = deriveMetadataParentId(q, question);
    if (parentId !== undefined) return { type: 'ValidationRule', parentId };
    return { type: 'ValidationRule' };
  }
  if (/\bhow\s+many\b.*\b(custom\s+)?fields?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'CustomField', parentId: `CustomObject:${objectApi}` };
    return { type: 'CustomField' };
  }
  if (/\bhow\s+many\b.*\blist\s+views?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'ListView', parentId: `CustomObject:${objectApi}` };
    return { type: 'ListView' };
  }
  if (/\b(page\s+)?layouts?\b/.test(q) && /\b(exist|how\s+many|what|which)\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'Layout', parentId: `CustomObject:${objectApi}` };
  }
  if (/\bcompact\s+layouts?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'CompactLayout', parentId: `CustomObject:${objectApi}` };
  }
  if (/\bhow\s+many\b.*\b(apex\s+)?triggers?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'ApexTrigger', parentId: `CustomObject:${objectApi}` };
    if (/\bstandard\s+objects?\b/.test(q)) return { type: 'ApexTrigger' };
  }
  if (/\bhow\s+many\b.*\brecord\s+types?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'RecordType', parentId: `CustomObject:${objectApi}` };
  }
  if (/\bquick\s+actions?\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'QuickAction', parentId: `CustomObject:${objectApi}` };
  }
  if (/\b(web\s+links?|custom\s+buttons?)\b/.test(q)) {
    const objectApi = deriveObjectApiFromQuestion(q, question);
    if (objectApi !== undefined) return { type: 'WebLink', parentId: `CustomObject:${objectApi}` };
    return { type: 'WebLink' };
  }
  if (!/\bflows?\b/.test(q)) return undefined;
  const triggerObject = deriveObjectApiFromQuestion(q, question);
  const recordTriggered =
    /\brecord[-\s]?triggered\b/.test(q) || /\brecordtriggered\b/.test(q);
  if (!recordTriggered && triggerObject === undefined) return undefined;
  const args: Record<string, unknown> = { type: 'Flow' };
  if (/\bactive\b/.test(q) || recordTriggered) args.status = 'Active';
  if (recordTriggered) args.recordTriggered = true;
  if (triggerObject !== undefined) args.triggerObject = triggerObject;
  return args;
};

/**
 * Map an OmniStudio discovery question to the `list_components` `type` for its
 * sub-family, so a "what OmniScripts / Integration Procedures / DataRaptors /
 * FlexCards exist" ask can be answered from the catalog — the per-component
 * breakdown tools (`omniscript_flow`, `integration_procedure_chain`, …) need a
 * specific component id the router cannot derive from a discovery question.
 * Defaults to OmniScript. Input is lowercased route text.
 */
const deriveOmniType = (q: string): string => {
  if (/\bintegration\s+procedures?\b/.test(q)) return 'OmniIntegrationProcedure';
  if (/\bdataraptors?\b/.test(q)) return 'OmniDataTransform';
  if (/\bflexcards?\b/.test(q)) return 'OmniUiCard';
  return 'OmniScript';
};

/**
 * Users often wrap the actual ask in role/context instructions. Route on the
 * ask after the colon so wrapper words like "impact review" do not steal the
 * route from the real question.
 */
const routeText = (question: string): string => {
  const normalized = normalize(question).replace(/\s*\[[^\]]+\]\s*$/, '');
  const stripped = normalized.replace(
    /^.*?\b(answer this|route this|do not guess|tell me|include|show what|fail closed|flag anything|use the safest|state what)\b[^:]*:\s*/,
    '',
  );
  return stripped.length > 0 ? stripped : normalized;
};

/**
 * Ordered rules — MOST SPECIFIC FIRST. The first rule with any matching pattern
 * wins, so narrow live/operational and named-entity shapes are checked before
 * broad vault ones (e.g. "is this field actually populated" must beat the
 * generic schema rule; "...layout" must beat the generic "who has access").
 */
const RULES: readonly Rule[] = [
  // === ARCHITECT GREENFIELD STRATEGY (knowledge plane, checked FIRST) ========
  // P12-ROUTER-architect-synthesis: prescriptive "what X strategy/model should I
  // design/establish for a NEW/greenfield org" questions are best-practice
  // guidance, not org lookups — but late-rule guidance (topic-specific) missed
  // them, so 7 went `unrouted` and 2 were stolen by descriptive org intents
  // (automation-on-object / integration-map). High precision (a prescriptive
  // modal AND a greenfield frame) so it never steals a descriptive "what IS our
  // X" org question, which carries neither signal. Routes to the knowledge plane
  // → sfi.guidance returns a curated framework instead of a route-only dead end.
  {
    intent: 'guidance',
    plane: 'knowledge',
    tools: ['sfi.guidance'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Greenfield/new-org design-strategy question — sfi.guidance returns curated best-practice (not org data); the org has no answer because nothing is built yet.',
    suggestArgs: (q) => {
      const topic = deriveKnowledgeTopic(q);
      return topic !== undefined ? { topic } : undefined;
    },
    patterns: [
      /\bshould\s+i\b.*\b(greenfield|new\s+org|new\s+implementation|new\s+project|from\s+day\s+one|day\s+one|before\s+anyone\s+builds?|before\s+building\s+a\s+new|when\s+designing\s+a\s+new|designing\s+a\s+new|standing\s+up|for\s+a\s+new\s+(org|project|implementation))\b/,
      /\bwill\s+this\s+new\s+(implementation|org|project)\b/,
    ],
  },
  // === EXPLICIT TOOL INVOCATION (power-user / admin QA phrasing) ===========
  // Battery questions name `tool_name — …` directly. Natural-language rules
  // below expect prose; these literal tokens must win without funnel or harness
  // tool-name injection (admin-edge differential loop).
  {
    intent: 'vault-health',
    plane: 'vault',
    tools: ['sfi.health_check', 'sfi.coverage_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit coverage_report invocation.',
    patterns: [/\bcoverage_report\b/],
  },
  {
    intent: 'automation-on-object',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.automation_build_advisor', 'sfi.get_edges', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit automation_build_advisor invocation.',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [/\bautomation_build_advisor\b/],
  },
  {
    intent: 'apex-build-advisor',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.apex_build_advisor'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit apex_build_advisor invocation — pre-build trigger/Apex briefing.',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [/\bapex_build_advisor\b/],
  },
  {
    // OWNER DIRECTIVE (offline deterministic fallback for the new flow tools):
    // sfi.flow_trace gets its own 'flow-trace' intent, placed EARLY — and BEFORE
    // its 'flow-structure' sibling — so a RECORD-STATE simulation ask ("what
    // happens to this record in <Flow> if Status is Active", "trace <Flow> with
    // these field values", "which branch runs when …", "simulate <Flow> for a
    // record where …") wins first-match. Precision-tuned to trace/simulate +
    // record-value vocabulary so it does NOT steal flow_graph's STRUCTURE asks
    // (structure / connector-graph / branches — none carry record-value tokens),
    // explain_flow's "what does <Flow> DO / explain / walk me through" narration,
    // nor what_happens_on_save's "what happens ON SAVE for a <Object>" save-order
    // (the record-scoped "to (this|a) record" shape never matches "on save").
    intent: 'flow-trace',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.flow_trace'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Honest projection of a Flow over a caller-supplied record state — which path executes and what it writes, evaluating the tractable subset (decisions / assignments / formulas / loops over supplied collections) and marking Apex/subflow/unknown-data branches unevaluated. flow_trace simulates over your values; flow_graph exposes the raw structure; explain_flow gives the plain-business summary.',
    patterns: [
      // "what happens to (this|a|the) record …" — the record-state debugger. The
      // "to <det> record" shape never matches what_happens_on_save's "on save".
      /\bwhat\s+happens\s+to\s+(?:this|that|a|the|my)\s+record\b/,
      // "trace … with (these) (field) values" / "trace … record state|values".
      /\btrace\b[^.?!]{0,80}\b(?:with\s+(?:these\s+)?(?:field\s+)?values|record\s+state|record\s+values|these\s+(?:field\s+)?values|field\s+values)\b/,
      // "simulate … (record|values|for a record|where)".
      /\bsimulate\b[^.?!]{0,90}\b(?:record\b|values\b|field\s+values\b|for\s+a\s+record\b|a\s+record\s+where\b|record\s+where\b)/,
      // "which (branch|path|rule|decision branch) runs|fires|executes|is taken|does … (when|if)".
      /\bwhich\s+(?:branch|path|rule|decision\s+branch)\b[^.?!]{0,80}\b(?:runs?|fires?|executes?|is\s+taken|does)\b[^.?!]{0,60}\b(?:when|if)\b/,
      // "what does <flow> write … (when|if|for a record)".
      /\bwhat\s+(?:does|will|would)\b[^.?!]{0,70}\bwrite\b[^.?!]{0,70}\b(?:when|if|for\s+(?:a|this|the)\s+record)\b/,
      // A concrete record-STATE assertion — a <Field>__c with a specific value
      // ("is 'High'", "= 25", "set to 'Escalated'") next to a trace/simulate/run
      // verb — is the record-state debugger regardless of the flow-name shape.
      // Distinct from schema (a field with no value) and what_if (no trace verb).
      /\b(?:trace|simulate|run|walk\s+through)\b[^.?!]{0,90}\b\w+__c\b[^.?!]{0,30}\b(?:is\b|=|equals?\b|set\s+to\b)/,
      // "feed a record (with …) into <flow>" — feeding a record IN is a trace.
      /\bfeed\b[^.?!]{0,40}\ba\s+record\b/,
      // "which (branch|path) does it take | is taken" — the executed path over a record.
      /\bwhich\s+(?:branch|path)\b[^.?!]{0,40}\b(?:does\s+.{0,15}?take|is\s+taken)\b/,
      // NAMED-flow record-state asks (>=2-underscore api-name anchor, either order).
      new RegExp(
        `\\b(?:trace|simulate)\\b[^.?!]{0,60}\\b${NAMED_COMPONENT_ID}\\b[^.?!]{0,60}\\b(?:record|values|field\\s+values|where|if|when)\\b`,
      ),
      new RegExp(
        `\\b(?:record\\s+state|these\\s+(?:field\\s+)?values|field\\s+values)\\b[^.?!]{0,60}\\b(?:trace|simulate|run|walk)\\b[^.?!]{0,50}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
    ],
  },
  {
    // OWNER DIRECTIVE (the offline deterministic fallback must route the new flow
    // tools, not leave them funnel-only): sfi.flow_graph gets its own
    // 'flow-structure' intent, placed EARLY (before trigger-order / scheduled-jobs
    // / schema / onboarding-doc) so a STRUCTURAL flow ask wins first-match over
    // those siblings — a flow named "Onboarding" must not be stolen by
    // generate_onboarding_doc, "scheduled paths" not by scheduled_job_catalog,
    // "what runs next" not by what_happens_on_save. Precision-tuned to
    // structure / connector-graph / branches / element-graph vocabulary so it does
    // NOT steal explain_flow's "what does <Flow> DO / explain / walk me through"
    // narration (which carries none of those tokens), nor flow_fault_audit's
    // "missing fault connector". A narration ask falls through to explain_flow.
    intent: 'flow-structure',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.flow_graph'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'The faithful, lossless structural graph of a Flow — every element by its real name, the full element-to-element connector graph (what runs next), decision rule branches, loops, formulas, and variables. flow_graph exposes the RAW graph; explain_flow gives the plain-business summary.',
    patterns: [
      // "structure / element graph / connector graph OF a flow" (either order).
      /\b(?:structure|element\s+graph|connector\s+graph)\b[^.?!]{0,50}\bflows?\b/,
      /\bflows?\b[^.?!]{0,50}\b(?:structure|element\s+graph|connector\s+graph)\b/,
      // "decision / rule branches" (or bare "branches") of a flow.
      /\b(?:decision\s+branches|rule\s+branches|branches)\b[^.?!]{0,50}\bflows?\b/,
      /\bflows?\b[^.?!]{0,50}\b(?:decision\s+branches|rule\s+branches)\b/,
      // "map out / trace / show / walk me through THE connector graph|connectors"
      // — but NOT "missing/no/without fault connector" (that is flow_fault_audit).
      /\b(?:map\s+out|trace|show(?:\s+me)?|walk\s+me\s+through)\b[^.?!]{0,40}\b(?:the\s+)?(?:connector\s+graph|connectors)\b(?![^.?!]{0,30}\b(?:fault|missing|without|no)\b)/,
      // "every / all the / the full elements|connectors ... flow".
      /\b(?:every|all\s+the|the\s+full)\s+(?:elements?|connectors?)\b[^.?!]{0,40}\bflows?\b/,
      // "what are the branches / connectors / elements in <a flow>".
      /\bwhat\s+(?:are|is)\b[^.?!]{0,30}\b(?:branches|connectors?|elements?)\b[^.?!]{0,30}\bflows?\b/,
      // "what runs next / after <an element> in <a flow>" — an intra-flow walk.
      /\bwhat\s+runs\s+(?:next|after)\b[^.?!]{0,80}\b(?:flow|assignment|decision|screen|element|step|loop)\b/,
      // "scheduled paths ... <a flow>" — a flow's scheduled-path branches (NOT
      // scheduled_job_catalog, which lists cron jobs org-wide).
      /\bscheduled\s+paths?\b[^.?!]{0,60}\bflows?\b/,
      // NAMED-flow structural asks (>=2-underscore api-name anchor, either order).
      new RegExp(
        `\\b(?:structure|connector\\s+graph|element\\s+graph|decision\\s+branches|rule\\s+branches)\\b[^.?!]{0,60}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
      new RegExp(
        `\\b${NAMED_COMPONENT_ID}\\b[^.?!]{0,60}\\b(?:structure|connector\\s+graph|element\\s+graph|decision\\s+branches|rule\\s+branches)\\b`,
      ),
    ],
  },
  {
    // FLOW-side bulkification: DML / Get Records inside a Loop body (+ filterless
    // Get Records) — the complement of the Apex-only governor_limit_risks scan.
    // Placed BEFORE the trigger / governor-risks rules so a FLOW-scoped loop ask
    // wins first-match over the Apex governor rule's generic
    // `(soql|dml|query) ... in loop` pattern. Every pattern anchors on "flow(s)"
    // so it never steals the Apex governor / automation-collision asks.
    intent: 'flow-bulkification',
    plane: 'vault',
    tools: ['sfi.flow_bulkification_audit'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Static Flow bulkification audit — record DML / Get Records inside a Loop body (one operation per iteration) plus filterless Get Records, read from the declared connector graph. The Flow-side sibling of the Apex-only governor_limit_risks scan.',
    patterns: [
      /\bflow_bulkification_audit\b/,
      // "flow(s) ... bulkif*" (either order).
      /\bflows?\b[^.?!]{0,60}\bbulkif\w*\b/,
      /\bbulkif\w*\b[^.?!]{0,60}\bflows?\b/,
      // "DML / create / update / delete / get records ... in a loop ... flow" —
      // the loop anti-pattern, scoped to flows.
      /\bflows?\b[^.?!]{0,80}\b(?:dml|create|update|delete|get\s+records|record\s+lookup|soql|quer(?:y|ies))\b[^.?!]{0,40}\b(?:in\s+(?:a\s+)?loop|inside\s+(?:a\s+)?loop|loops?)\b/,
      /\b(?:dml|create|update|delete|get\s+records|record\s+lookup|soql|quer(?:y|ies))\b[^.?!]{0,40}\b(?:in\s+(?:a\s+)?loop|inside\s+(?:a\s+)?loop|loops?)\b[^.?!]{0,60}\bflows?\b/,
      // "flow(s) ... filterless / unbounded / no filter Get Records".
      /\bflows?\b[^.?!]{0,60}\b(?:filterless|unbounded|no\s+filter|without\s+(?:a\s+)?filter)\b[^.?!]{0,30}\b(?:get\s+records|quer(?:y|ies))\b/,
    ],
  },
  {
    // INDEX-AWARE non-selective SOQL — Apex queries whose WHERE clause is a
    // full-scan shape (filters only on non-indexed fields, leading-wildcard LIKE,
    // negative-only, or no WHERE). A SELECTIVITY axis, distinct from the RUNTIME
    // governor_limit_risks in-loop scan. Anchored on "non-selective" / "selective
    // query" / "full (table) scan" / "time out ... at scale" / "index" + "query"
    // so it never steals the governor in-loop asks (which anchor on loops).
    intent: 'nonselective-soql',
    plane: 'vault',
    tools: ['sfi.nonselective_soql'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Index-aware non-selective SOQL audit — Apex queries whose WHERE clause filters only on non-indexed fields, uses a leading-wildcard LIKE, is negative-only, or is absent (full-scan / timeout risk at scale). A selectivity axis distinct from the governor_limit_risks in-loop scan.',
    patterns: [
      /\bnonselective_soql\b/,
      /\bnon[-\s]?selective\b/,
      /\bselective\s+quer(?:y|ies)\b/,
      // "full (table) scan" query risk.
      /\bfull[-\s]?(?:table\s+)?scan\b/,
      // "queries / SOQL ... time out / timeout ... at scale / large data".
      /\b(?:quer(?:y|ies)|soql)\b[^.?!]{0,50}\b(?:time\s*out|timeout|full\s+scan|non[-\s]?selective)\b/,
      // "queries filtering on non-indexed / unindexed field(s)".
      /\b(?:quer(?:y|ies)|soql|filter(?:s|ing)?)\b[^.?!]{0,40}\b(?:non[-\s]?indexed|un[-\s]?indexed|no\s+index)\b/,
      // "leading wildcard" LIKE.
      /\bleading[-\s]?wildcard\b/,
    ],
  },
  {
    // CONFIGURATION limit headroom — metadata counts vs per-object / per-org
    // Salesforce config ceilings, ranked worst-first (the offline Optimizer
    // limit report). Anchored on "headroom" / "limit report" / "Optimizer" /
    // "approaching|close to|running out of ... limit(s)" / "how many ... left",
    // so it never steals the Apex governor_limit_risks asks (which anchor on
    // governor / SOQL-DML-in-loop) — those are RUNTIME per-transaction limits,
    // a different question from these config CEILINGS.
    intent: 'limit-headroom',
    plane: 'vault',
    tools: ['sfi.limit_headroom_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Offline configuration-limit headroom report — metadata counts vs per-object / per-org Salesforce config ceilings, ranked worst-first (the vault-only replacement for the Salesforce Optimizer limit report). Distinct from the Apex governor_limit_risks RUNTIME scan.',
    patterns: [
      /\blimit_headroom_report\b/,
      /\bheadroom\b/,
      /\blimit\s+report\b/,
      /\boptimizer\b/,
      // "approaching / close to / nearing / almost at ... limit(s)". Deliberately
      // EXCLUDES the governor-collision verbs (hit / hitting / exceed), which
      // belong to the RUNTIME governor_limit_risks scan ("hitting governor
      // limits"), not the config-CEILING headroom report.
      /\b(?:approaching|close\s+to|near(?:ing)?|almost\s+at|running\s+out\s+of)\b[^.?!]{0,40}\blimits?\b/,
      // "custom field / object / tab / app limit" — config-limit vocabulary.
      /\bcustom\s+(?:field|object|tab|app|application)s?\b[^.?!]{0,20}\blimits?\b/,
      // "how many (custom) fields / objects / ... (left|remaining)".
      /\bhow\s+many\b[^.?!]{0,40}\b(?:left|remaining)\b/,
      // "running out of ... (fields|slots|record types|relationships)".
      /\brunning\s+out\s+of\b[^.?!]{0,30}\b(?:fields?|slots?|record\s+types?|relationships?|objects?)\b/,
    ],
  },
  {
    // Org-wide picklist VALUE-SET INTEGRITY scan — orphaned / stale / renamed
    // value references in formulas, validation rules, and flow decisions. Keyed
    // on integrity / orphaned / stale / dead / renamed vocabulary so it never
    // steals `what_if_remove_picklist_value` (remove/delete a value),
    // `live_picklist_usage` (never-used / usage counts), or `picklist-values`
    // (what values are in X). Placed EARLY so the specific integrity framing wins
    // first-match over the generic picklist rules further down.
    intent: 'picklist-integrity',
    plane: 'vault',
    tools: ['sfi.picklist_integrity_scan'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Org-wide picklist value-set integrity scan — literals in formulas / validation rules / flow decisions that reference a value the field does not define (orphaned) or defines only as inactive. Distinct from what_if_remove_picklist_value (single-value blast radius) and live_picklist_usage (runtime value counts).',
    patterns: [
      /\bpicklist_integrity_scan\b/,
      /\bpicklist\b[^.?!]{0,40}\bintegrit\w*\b/,
      /\bintegrit\w*\b[^.?!]{0,40}\bpicklist\b/,
      /\bvalue\s+sets?\b[^.?!]{0,30}\bintegrit\w*\b/,
      // "orphaned / stale / dead / renamed / missing ... picklist value(s)".
      /\b(?:orphaned|stale|dead|renamed|non-?existent|invalid)\b[^.?!]{0,30}\bpicklist\b/,
      /\bpicklist\b[^.?!]{0,40}\b(?:orphaned|stale|no\s+longer\s+exists?|renamed\s+away|deactivated)\b/,
      // "orphaned value(s)" / "stale value(s)" (value-set framing without the word picklist).
      /\borphaned\s+(?:picklist\s+)?(?:value|literal|reference)s?\b/,
      /\bstale\s+(?:picklist\s+)?values?\b/,
      // "value(s) that (no longer|don't) exist ... on the field / picklist".
      /\bvalues?\b[^.?!]{0,30}\b(?:no\s+longer\s+exists?|do(?:es)?n['’]?t\s+exist|been\s+renamed)\b[^.?!]{0,30}\b(?:field|picklist)\b/,
    ],
  },
  {
    // Permission-set CONSOLIDATION — redundant / duplicate / subset / overlapping
    // permission sets that could be merged, from DECLARED grants. Keyed on
    // redundant/duplicate/consolidate/merge/subset/overlap + permission set(s) so
    // it never steals `unassigned_permission_sets` (who HOLDS a set — assignment)
    // or `permission_risk_report` (god-mode / over-privilege — how DANGEROUS a
    // grant is). Placed EARLY so the consolidation framing wins first-match over
    // generic permission asks.
    intent: 'permission-set-consolidation',
    plane: 'vault',
    tools: ['sfi.permission_set_consolidation'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Offline permission-set consolidation candidates from declared grants — empty / strict-subset / near-duplicate permission sets ranked by consolidation opportunity. Distinct from unassigned_permission_sets (who holds a set) and permission_risk_report (over-privilege / god-mode).',
    patterns: [
      /\bpermission_set_consolidation\b/,
      // "redundant / duplicate / consolidate / merge / overlapping ... permission set(s)".
      /\b(?:redundant|duplicate|consolidat\w*|overlapping|near-?duplicate)\b[^.?!]{0,40}\bpermission\s+sets?\b/,
      /\bpermission\s+sets?\b[^.?!]{0,40}\b(?:redundant|duplicate|consolidat\w*|overlapping|near-?duplicate|subset)\b/,
      // "merge / combine ... permission set(s)".
      /\b(?:merge|combine)\b[^.?!]{0,30}\bpermission\s+sets?\b/,
      // "permission set(s) ... (that are a )subset of / contained in another".
      /\bpermission\s+sets?\b[^.?!]{0,40}\b(?:subset\s+of|contained\s+in)\b/,
      // "empty permission set(s)".
      /\bempty\s+permission\s+sets?\b/,
    ],
  },
  {
    intent: 'trigger-order',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_happens_on_save', 'sfi.order_of_execution'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit order_of_execution invocation.',
    suggestArgs: (q, question) => {
      const args: Record<string, unknown> = { event: deriveSaveEvent(q) };
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      if (objectApiName !== undefined) args.objectApiName = objectApiName;
      return args;
    },
    patterns: [/\border_of_execution\b/],
  },
  {
    intent: 'field-mapping',
    plane: 'vault',
    tools: ['sfi.field_mapping_between_objects', 'sfi.datatransform_field_map'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit field_mapping_between_objects invocation.',
    suggestArgs: deriveFieldMappingArgs,
    patterns: [/\bfield_mapping_between_objects\b/, /\blead\s*(?:→|->|>)\s*contact\b/],
  },
  {
    intent: 'test-coverage',
    plane: 'vault',
    tools: ['sfi.apex_test_coverage', 'sfi.test_coverage_gaps', 'sfi.meaningful_test_audit'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit apex_test_coverage / meaningful_test_audit invocation.',
    patterns: [/\bapex_test_coverage\b/, /\bmeaningful_test_audit\b/],
  },
  {
    intent: 'impact-analysis',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.field_change_advisor', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit get_impact invocation.',
    suggestArgs: (q) => {
      const hops = deriveImpactHops(q);
      return hops !== undefined ? { hops } : undefined;
    },
    patterns: [/\bget_impact\b/],
  },
  {
    intent: 'field-change-advisor',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_change_advisor', 'sfi.get_impact', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit field_change_advisor invocation.',
    patterns: [/\bfield_change_advisor\b/],
  },
  {
    intent: 'disambiguate-concepts',
    plane: 'vault',
    tools: ['sfi.disambiguate_concepts'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit disambiguate_concepts invocation — same vs distinct field/status concepts.',
    patterns: [/\bdisambiguate_concepts\b/],
  },
  {
    intent: 'field-provenance',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_provenance', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit field_provenance invocation — who/what sets a field value.',
    patterns: [/\bfield_provenance\b/],
  },
  {
    intent: 'cmdt-record-values',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.lookup_record', 'sfi.explain_field'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit lookup_record invocation for CMDT / custom-setting record values.',
    patterns: [/\blookup_record\b/],
  },
  {
    intent: 'last-modified',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.last_modified'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit last_modified invocation.',
    patterns: [/\blast_modified\b/],
  },
  {
    intent: 'field-population',
    plane: 'hybrid',
    tools: ['sfi.resolve', 'sfi.live_field_population'],
    liveRequired: true,
    needsResolve: true,
    reason: 'Explicit live_field_population invocation.',
    patterns: [/\blive_field_population\b/],
  },
  {
    intent: 'value-change',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.value_change_audit', 'sfi.what_if_change_field_value'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit value_change_audit / what_if_change_field_value invocation.',
    patterns: [/\bwhat_if_change_field_value\b/, /\bvalue_change_audit\b/],
  },
  {
    intent: 'call-graph',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.call_graph', 'sfi.method_reachability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit call_graph / method_reachability invocation.',
    patterns: [/\bcall_graph\b/, /\bmethod_reachability\b/],
  },
  {
    // M23 — is <Method> REACHABLE from an entry point (flow / trigger / active
    // automation). Both call-graph rules carry [resolve, call_graph,
    // method_reachability] with call_graph first, so method_reachability can
    // never lead there. This narrow reachable+entry-point rule leads with it.
    intent: 'method-reachability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.method_reachability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Whether a method is reachable from an entry point (flow / trigger / active automation) — method_reachability leads, not call_graph.',
    patterns: [/\breachab\w*\b[^?!]{0,40}\b(flows?|triggers?|automations?|active)\b/],
  },
  {
    intent: 'tests-for-change',
    plane: 'vault',
    tools: ['sfi.tests_for_change'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit tests_for_change invocation.',
    patterns: [/\btests_for_change\b/],
  },
  {
    intent: 'downstream-effects',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.downstream_effects', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit downstream_effects invocation.',
    patterns: [
      /\bdownstream_effects\b/,
      // "downstream effects of changing X" — the natural phrasing. Previously
      // caught only by pii-flow's bare \bdownstream\b catch-all (eval family E
      // demoted that), so the dedicated tool now owns its own noun phrase.
      /\b(?:downstream|ripple)\s+effects?\b/,
    ],
  },
  {
    intent: 'package-impact',
    plane: 'vault',
    tools: ['sfi.package_impact'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit package_impact invocation.',
    patterns: [/\bpackage_impact\b/],
  },
  {
    intent: 'pii-flow',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_lineage'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit field_lineage invocation.',
    patterns: [/\bfield_lineage\b/],
  },
  {
    intent: 'field-meaning',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_field', 'sfi.field_360'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit field_360 invocation.',
    patterns: [/\bfield_360\b/],
  },
  {
    intent: 'safe-to-delete',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit safe_to_delete_field invocation.',
    patterns: [/\bsafe_to_delete_field\b/],
  },
  {
    intent: 'what-if-field',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_make_field_required', 'sfi.what_if_change_field_type', 'sfi.what_if_remove_picklist_value', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit what-if field schema simulators.',
    patterns: [
      /\bwhat_if_make_field_required\b/,
      /\bwhat_if_change_field_type\b/,
      /\bwhat_if_remove_picklist_value\b/,
    ],
  },
  // === R3 §5b — what-if CHANGE-TYPE WHITELIST honest routes ================
  // The what_if_* simulators cover a fixed change-type list (field type /
  // required / picklist value, flow deactivation, trigger disable, method
  // signature, profile merge/split). A what-if ask about a change type with
  // NO simulator (remove a record type, change a layout assignment, change a
  // flow variable's type) must not be absorbed by the nearest-neighbor
  // what_if_* — these rules catch those shapes FIRST and route the honest
  // dependency read (get_impact & friends) with an explicit no-simulator
  // disclosure, mirroring `permission-set-deactivation-impact`.
  {
    intent: 'record-type-removal-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.recordtype_availability'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'No what_if simulator exists for removing a record type, so this routes honestly to the dependency read: get_impact surfaces the flows, layouts, validation rules, and profiles referencing the record type, and recordtype_availability shows who can see it today — the truthful stand-in for a removal blast radius, not a fabricated simulation.',
    patterns: [
      /\b(?:remov\w+|delet\w+|dropp?\w*|consolidat\w+|retir\w+)\b[^.?!]{0,50}\brecord\s+types?\b/,
      /\brecord\s+types?\b[^.?!]{0,50}\b(?:is|are|was|were|gets?|being)\s+(?:removed|deleted|dropped|consolidated|retired)\b/,
    ],
  },
  {
    intent: 'layout-assignment-change-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.layout_assignments', 'sfi.get_impact'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'No what_if simulator exists for changing a page-layout assignment, so this routes honestly to the current state: layout_assignments shows the Profile × RecordType assignments the change would rewire, plus get_impact for the dependency surface — a lookup plus impact read, not a fabricated simulation.',
    patterns: [
      /\b(?:chang\w+|swapp?\w*|reassign\w*|switch\w*)\b[^.?!]{0,60}\blayout\s+assignments?\b/,
      /\bwhat\s+(?:if|happens|breaks)\b[^.?!]{0,80}\blayout\s+assignments?\b/,
    ],
  },
  {
    intent: 'flow-variable-type-change-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.explain_flow'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "No what_if simulator models changing a flow variable's type (e.g. single record to collection), so this routes honestly to the callers: get_impact surfaces the flows/processes invoking it (whose passed values a type change breaks), and explain_flow the variable's uses inside — an interface-impact read, not a fabricated simulation.",
    patterns: [
      /\b(?:input|output)\s+variable\b[^.?!]{0,60}\btype\b/,
      /\bvariable\s+type\b[^.?!]{0,60}\bflow\b/,
      /\bflow\b[^.?!]{0,60}\bvariable\s+type\b/,
    ],
  },
  {
    // R3 §5b — ENUMERATION-vs-ID gate: `cpq_rule_chain` and
    // `cpq_quote_template_breakdown` REQUIRE a specific canonical id, so an
    // org-wide ask ("map the whole CPQ rule chain", "what quote template does
    // the org use?") must route the ENUMERATION path — the id-free dependency
    // map plus list_components — never commit an id-required tool without an
    // id. Hoisted ABOVE the call-graph/"map the chain" family and the generic
    // `cpq` rule (first-match): only org-wide CPQ phrasings land here; a
    // named rule/template still gets the per-id chain tools.
    intent: 'cpq-enumeration',
    plane: 'vault',
    tools: ['sfi.cpq_dependency_map', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Org-wide CPQ enumeration: cpq_dependency_map maps the whole rule/template surface with no id needed, and list_components enumerates the CPQ rules/templates themselves. The per-id tools (cpq_rule_chain, cpq_quote_template_breakdown) need a specific named rule or template — pick one from the enumeration first.',
    patterns: [
      /\bmap\s+the\b[^.?!]{0,40}\bcpq\b|\bcpq\b[^.?!]{0,40}\brule\s+chain\b[^.?!]{0,60}\b(?:evaluation\s+order|all|every|org-?wide|whole)\b/,
      /\b(?:what|which)\s+(?:cpq\s+)?quote\s+templates?\b[^.?!]{0,50}\b(?:do(?:es)?\s+(?:we|the\s+org)|org)\s*use\b/,
      /\b(?:all|every|list)\b[^.?!]{0,30}\b(?:price|product|discount)\s+rules?\b[^.?!]{0,50}\b(?:evaluation\s+order|and\s+their)\b/,
    ],
  },
  {
    intent: 'async-chain-depth',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.async_chain_depth'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit async_chain_depth invocation.',
    patterns: [
      /\basync_chain_depth\b/,
      // NL async-chain shapes (flow-family REACH). High precision: an explicit
      // async-chain-depth / async-Apex-limit concern (queueable→queueable /
      // future/batch chaining against the 5-deep / async-Apex governor limit).
      /\basync\s+chain\b/,
      /\basync[-\s]?apex[-\s]?limit\b/,
      /\basync[-\s]apex[-\s]limit\b/,
      /\bhow\s+deep\b[^.?!]{0,40}\basync\b/,
      /\b(queueable|future|batch)\b[^.?!]{0,40}\bchain\w*\b[^.?!]{0,40}\b(depth|deep|limit)\b/,
    ],
  },
  {
    intent: 'compliance',
    plane: 'vault',
    tools: ['sfi.generate_compliance_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit generate_compliance_report invocation.',
    patterns: [/\bgenerate_compliance_report\b/],
  },
  {
    intent: 'layout-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.layout_for_user', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit layout_for_user invocation.',
    suggestArgs: deriveLayoutForUserArgs,
    patterns: [/\blayout_for_user\b/],
  },
  {
    intent: 'app-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.app_access'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit app_access invocation.',
    patterns: [/\bapp_access\b/],
  },
  {
    intent: 'user-ability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.user_ability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit user_ability invocation.',
    patterns: [/\buser_ability\b/],
  },
  {
    intent: 'governor-risks',
    plane: 'vault',
    tools: ['sfi.governor_limit_risks'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit governor_limit_risks invocation.',
    patterns: [/\bgovernor_limit_risks\b/],
  },
  {
    intent: 'crud-fls-audit',
    plane: 'vault',
    tools: ['sfi.crud_fls_audit'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit crud_fls_audit invocation.',
    patterns: [/\bcrud_fls_audit\b/],
  },
  // === METADATA / APEX / FLOW ANALYSIS routing (checked BEFORE live_*) =======
  // QA-Bundle-2 (ROUTING): validation-rule / save-behavior / flow-trigger /
  // DLRS-recursion questions were being stolen by the broad live_* and
  // inactive-* rules below — `inactive-users` over-fires on the bare word
  // "user"/"license", `inactive-validation-rules` on "validation rule", and
  // the live record/limit rules on counts — so a metadata/Apex/flow question
  // routed to live_inactive_users / governor_limit_risks / integration_map /
  // live_org_limits / live_stale_records, none relevant. These three
  // high-precision rules sit FIRST so the analysis tools win. Each is anchored
  // to its own NOUN+verb so it never steals a real live record/login question.
  {
    // A "does the save succeed / is the save blocked" question about a
    // validation rule (often quoting `$User`, `$Profile`, or a whitelist of
    // who may save) is a SAVE-BEHAVIOR analysis — what runs on save and which
    // VR formula gates it — NOT a login-activity/inactive-users lookup. The
    // presence of "$User"/"$Profile"/"whitelist"/"save succeeds" together with
    // a validation-rule frame routes to what_happens_on_save + the rule's own
    // formula (get_component) and explain_formula, so the cascade reaches the
    // VR formulas without the caller hand-entering a componentId.
    intent: 'save-behavior',
    plane: 'vault',
    tools: [
      'sfi.resolve',
      'sfi.what_happens_on_save',
      'sfi.get_component',
      'sfi.explain_formula',
    ],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Whether a save succeeds under a validation rule is offline metadata: what_happens_on_save reconstructs the save-order, and the VR's own formula (get_component / explain_formula) shows the $User/$Profile/whitelist condition that gates it. Not a live login-activity lookup.",
    suggestArgs: (q) => ({ event: deriveSaveEvent(q) }),
    patterns: [
      // A validation-rule frame + a save-outcome/whitelist/context-variable ask.
      // Bounded clauses keep the two signals near each other so it never steals
      // a generic "list inactive validation rules" enumeration.
      /\bvalidation\s+rules?\b[^.?!]{0,80}\b(save\s+(succeed|success|go\s+through|work|fail|block)|whitelist|allow(ed|s)?\s+to\s+save|let[s]?\b.*\bsave|\$user\b|\$profile\b|\$record\b)/,
      /\b(save\s+(succeed|success|go\s+through|fail|block)|whitelist|\$user\b|\$profile\b)[^.?!]{0,80}\bvalidation\s+rules?\b/,
      // "does the save succeed for <whom>" / "will the save go through" — a
      // save-outcome question even when "validation rule" sits in an earlier
      // clause. Requires the save-outcome verb so a plain record save (which is
      // a live DML event) does not collapse here.
      /\b(does|will|can|would)\b.*\bsave\b.*\b(succeed|go\s+through|be\s+(blocked|allowed)|fail)\b/,
    ],
  },
  {
    // "When does this flow fire, and what permission set / license lets it run"
    // is a Flow-trigger + permission-context question. The word "user"/
    // "license"/"permission set" was pulling it onto inactive-users /
    // license-usage; route it to explain_flow (the flow's trigger) +
    // what_happens_on_save so the profile/permission gate is reachable in the
    // normal cascade. High precision: requires a FLOW noun next to a
    // fire/run/trigger verb AND a permission/license context term.
    intent: 'flow-trigger-context',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_flow', 'sfi.what_happens_on_save'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'When a flow fires and which profile / permission set / license can run it is offline metadata: explain_flow narrates the trigger, and what_happens_on_save places it in save-order. Not a live login/license-usage lookup.',
    suggestArgs: (q) => ({ event: deriveSaveEvent(q) }),
    patterns: [
      /\bflows?\b[^.?!]{0,80}\b(fire|fires|run|runs|trigger|triggers|execute)[^.?!]{0,80}\b(permission\s+set|profile|license|licence|run\s+the\s+flow)\b/,
      /\b(permission\s+set|profile|license|licence)\b[^.?!]{0,80}\b(run|fire|trigger|execute)\b[^.?!]{0,40}\bflows?\b/,
      /\bwhat\s+(permission\s+set|profile|license|licence)\b.*\b(run|fire|trigger)\b.*\bflows?\b/,
    ],
  },
  {
    // A DLRS (Declarative Lookup Rollup Summary) / recursive-rollup question —
    // e.g. the CountCET3 rollup that re-enters its own trigger. The recursive
    // path lives in automation/order-of-execution analysis (a custom-metadata
    // rollup that writes the parent and re-fires the child trigger, suppressed
    // only by a CheckRecursive static guard, not the platform). Route to
    // automation_risk_report + order_of_execution + what_happens_on_save, and
    // surface the dlrs__LookupRollupSummary2 custom-metadata record via
    // lookup_record / search_components so CountCET3 is named in the cascade.
    intent: 'dlrs-recursion',
    plane: 'vault',
    tools: [
      'sfi.resolve',
      'sfi.search_components',
      'sfi.lookup_record',
      'sfi.automation_risk_report',
      'sfi.order_of_execution',
      'sfi.what_happens_on_save',
    ],
    liveRequired: false,
    needsResolve: true,
    reason:
      'A DLRS / recursive-rollup question is automation analysis: the rollup config is a dlrs__LookupRollupSummary2 custom-metadata record (search_components / lookup_record), and the recursive trigger path it drives is reconstructed by automation_risk_report / order_of_execution / what_happens_on_save.',
    suggestArgs: (q) => ({ event: deriveSaveEvent(q) }),
    patterns: [
      /\bdlrs[\w]*/i,
      /\blookup\s*rollup\s*summary\b/,
      /\b(recursive|recursion|re-?enter|re-?fire)\b.*\b(rollup|roll[-\s]?up|trigger)\b/,
      /\b(rollup|roll[-\s]?up)\b.*\b(recursive|recursion|re-?enter|re-?fire)\b/,
    ],
  },
  {
    intent: 'hardcoded-values-anywhere',
    plane: 'vault',
    tools: ['sfi.find_hardcoded_values_anywhere'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Cross-corpus hardcoded-value search scans Apex, formulas, validation rules, and workflow rules for the explicitly requested literal category.',
    suggestArgs: (q) => {
      if (/\b(ids?|identifiers?)\b/.test(q)) return { category: 'id' };
      if (/\bemails?\b/.test(q)) return { category: 'email' };
      if (/\bdates?\b/.test(q)) return { category: 'date' };
      if (/\b(numeric|numbers?|integers?|decimals?)\b/.test(q)) return { category: 'numeric' };
      return undefined;
    },
    patterns: [
      /\bhard[-\s]?cod(ed|ing|e)\b.*\b(ids?|identifiers?|emails?|dates?|numeric|numbers?|integers?|decimals?)\b.*\b(anywhere|across|formulas?|validation\s+rules?|workflow\s+rules?|configuration|metadata)\b/,
      /\b(anywhere|across|formulas?|validation\s+rules?|workflow\s+rules?|configuration|metadata)\b.*\bhard[-\s]?cod(ed|ing|e)\b.*\b(ids?|identifiers?|emails?|dates?|numeric|numbers?|integers?|decimals?)\b/,
    ],
  },
  {
    intent: 'hardcoded-values',
    plane: 'vault',
    tools: ['sfi.find_hardcoded_values'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Hardcoded IDs/URLs/names found by static scan of Apex/Flow source.',
    patterns: [
      /\bhard[-\s]?cod(ed|ing|e)\b/,
      /\b(hardcoded|literal)\b.*\b(id|url|profile|record\s?type|values?)\b/,
    ],
  },
  {
    intent: 'inactive-validation-rules',
    plane: 'vault',
    tools: ['sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Validation-rule active status is deployed metadata in the vault; enumerate ValidationRule components and inspect their active property.',
    suggestArgs: () => ({ type: 'ValidationRule' }),
    patterns: [
      /\b(inactive|disabled|not\s+active)\b.*\bvalidation\s+rules?\b/,
      /\bvalidation\s+rules?\b.*\b(inactive|disabled|not\s+active)\b/,
    ],
  },
  {
    intent: 'reports-inventory',
    plane: 'vault',
    tools: ['sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Counting or listing deployed Reports is vault metadata inventory; report run history is a separate live usage question.',
    suggestArgs: () => ({ type: 'Report' }),
    patterns: [
      /\bhow\s+many\s+reports?\b.*\b(exist|are\s+there|do\s+we\s+have|in\s+this\s+org)\b/,
      /\b(list|show|what|which)\b.*\breports?\b.*\b(exist|available|inventory|in\s+this\s+org)\b/,
    ],
  },
  {
    intent: 'integration-capacity-risk',
    plane: 'hybrid',
    tools: ['sfi.integration_map', 'sfi.live_org_limits'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Integration capacity risk combines vault integration topology with live API-limit headroom; neither plane alone answers it.',
    patterns: [
      /\bapi\s+limits?\b.*\b(risk|at\s+risk|headroom|capacity)\b.*\b(integration|volume|traffic|calls?)\b/,
      /\b(integration|api)\s+(volume|traffic|calls?)\b.*\b(api\s+)?limits?\b/,
    ],
  },
  {
    intent: 'page-performance',
    plane: 'vault',
    tools: ['sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'The vault can rank FlexiPage structural density, but actual page load times require runtime browser/Lightning performance telemetry that is not captured.',
    gap: {
      category: 'runtime-page-performance',
      note: 'Partial answer only: list FlexiPage metadata and compare structural density (for example rawReferenceCount). Actual slowest load times require runtime Lightning/browser performance telemetry outside the vault.',
    },
    suggestArgs: () => ({ type: 'FlexiPage' }),
    patterns: [
      /\bpages?\b.*\b(slowest|load\s+times?|performance|latency)\b/,
      /\b(slowest|load\s+times?|page\s+performance|page\s+latency)\b.*\bpages?\b/,
    ],
  },
  // === LIVE / operational (record-level, runtime state) =====================
  {
    intent: 'profile-assignment-count',
    plane: 'live',
    tools: ['sfi.live_group_count'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'User-to-profile assignments are runtime User records, so count Users grouped by ProfileId in the live org.',
    suggestArgs: () => ({ objectApiName: 'User', groupByField: 'ProfileId' }),
    patterns: [
      /\bhow\s+many\s+users?\b.*\bassigned\s+to\b.*\bprofiles?\b/,
      /\bhow\s+many\s+users?\b.*\bprofiles?\b.*\bassigned\b/,
      /\busers?\b.*\bassigned\s+to\b.*\bprofiles?\b.*\b(count|how\s+many|number)\b/,
      // "how many users are ON the X profile" — membership phrasing without the
      // word "assigned" (P0a). Same runtime User-record count grouped by
      // ProfileId; the metadata-count lookahead already refuses to steal it.
      /\bhow\s+many\s+users?\b.*\bon\b.*\bprofiles?\b/,
    ],
  },
  {
    // ENGINE-ARC §2c (NEW arm): "zombie accounts" — active users with login
    // access but ZERO permission-set/PSG assignments. This is the User × PSA
    // anti-join (sfi.live_zombie_accounts), an explicit DELTA over
    // live_inactive_users: dormancy-only phrasings ("who hasn't logged in")
    // carry no permission-set-absence noun and fall through to inactive-users.
    // Every pattern requires either the literal "zombie" or a
    // no/zero/without + permission-set frame, so genuine holder-roster asks
    // ("which users have permission set X" — no negative) never land here.
    // Sits BEFORE profile-user-roster so "users with nothing assigned beyond
    // their profile" is not stolen by the profile-roster grammar.
    intent: 'zombie-accounts',
    plane: 'live',
    tools: ['sfi.live_zombie_accounts'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Active users with NO permission-set/PSG assignments is a live User × PermissionSetAssignment anti-join (live_zombie_accounts). Note: a "zombie" still holds everything its PROFILE grants — the tool discloses that.',
    patterns: [
      /\bzombie\s+(?:accounts?|users?)\b/,
      // "which active users have no/zero permission sets (assigned)?" /
      // "users with zero permission set or group assignments" / "can log in
      // but have no permission set assignments"
      /\b(?:users?|accounts?)\b[^.?!]{0,50}\b(?:no|zero|without|not\s+any)\b[^.?!]{0,15}\bpermission\s+sets?\b/,
      // "which users have nothing assigned beyond their profile?"
      /\bnothing\s+assigned\s+beyond\b[^.?!]{0,25}\bprofiles?\b/,
      // "login access but no perm sets" (perm-set abbreviation variant)
      /\b(?:no|zero|without)\b[^.?!]{0,15}\bperm\s+sets?\b/,
    ],
  },
  {
    // "list everyone with the X profile" is a USER ROSTER ask: user-to-profile
    // assignment is runtime User-record state, not vault metadata — the schema
    // list rule used to claim it via "list ... profiles" and answer with the
    // Profile METADATA catalog (eval family D). ENGINE-ARC §4: the name-by-name
    // roster IS now built — sfi.live_permset_holders (kind:'profile') lists the
    // users live; live_group_count keeps the count side and live_inactive_users
    // the login-activity side. The old partial-answer gap block is DELETED.
    intent: 'profile-user-roster',
    plane: 'live',
    tools: ['sfi.live_permset_holders', 'sfi.live_group_count', 'sfi.live_inactive_users'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Which users hold a profile is runtime User-record state: live_permset_holders (kind: profile) lists the roster name-by-name from the live org; live_group_count covers per-profile counts and live_inactive_users the login-activity side.',
    suggestArgs: () => ({ kind: 'profile' }),
    patterns: [
      /\b(list|show|who\s+are)\b[^.?!]{0,20}\b(everyone|everybody|all\s+(the\s+)?users?|the\s+users?|people)\b[^.?!]{0,40}\b(with|on|assigned|holding|having)\b[^.?!]{0,40}\bprofile\b/,
      /\b(which|what)\s+users?\b[^.?!]{0,40}\b(have|hold|are\s+on|with|assigned)\b[^.?!]{0,40}\bprofile\b/,
      /\bwho\s+(has|holds|is\s+assigned)\b[^.?!]{0,40}\bprofile\b/,
      /\beveryone\b[^.?!]{0,30}\b(with|on|assigned)\b[^.?!]{0,40}\bprofile\b/,
    ],
  },
  {
    intent: 'stale-metadata',
    plane: 'vault',
    tools: ['sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Metadata age comes from component lastModifiedDate captured during a Tooling-API-enriched refresh; null dates mean the vault cannot rank stale components yet.',
    suggestArgs: (q) => {
      if (/\b(apex\s+)?classes?\b/.test(q)) return { type: 'ApexClass' };
      if (/\bflows?\b/.test(q)) return { type: 'Flow' };
      if (/\bvalidation\s+rules?\b/.test(q)) return { type: 'ValidationRule' };
      return undefined;
    },
    patterns: [
      /\b(classes?|flows?|validation\s+rules?|metadata|components?)\b.*\b(not|never|haven'?t|have\s+not)\b.*\b(modified|updated|changed)\b/,
      /\b(stale|old|outdated)\b.*\b(classes?|flows?|validation\s+rules?|metadata|components?)\b/,
    ],
  },
  {
    intent: 'license-usage',
    plane: 'live',
    tools: ['sfi.live_license_usage'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'License provisioning/usage and reclaimable seats are live org state (UserLicense / PermissionSetLicense + login activity).',
    patterns: [
      // Guarded (eval family C — qualifier hijack): "seats"/"license" as a
      // TRAILING modifier must not drag a permission-set ASSIGNMENT question
      // ("who is assigned the X permission set — are we wasting seats?") onto
      // the live license counter. When the question mentions a permission set
      // that is NOT the literal "permission set license" (PSL) noun, the
      // perm-set rules below own it; genuine PSL asks keep the third pattern.
      /^(?!.*\bpermission\s+sets?\b(?!\s+licen[sc]e)).*\b(licen[sc]e|seat)s?\b.*\b(usage|used|unused|utili[sz]ation|utilized|reclaim|reclaimable|available|free|provision|assigned|wasted|cost|optimi[sz])/,
      /^(?!.*\bpermission\s+sets?\b(?!\s+licen[sc]e)).*\b(usage|utili[sz]ation|utilized|reclaim|reclaimable|unused|provision|assigned|wasted)\b.*\b(licen[sc]e|seat)s?\b/,
      /\bpermission\s+set\s+licen[sc]e/,
      /\bhow\s+many\s+(licen[sc]e|seat)s?\b/,
      // DISCOVERY/META REACH: "how many <LicenseType> and <LicenseType>
      // licenses are we actually USING vs what we're PAYING for" — the
      // provisioning-vs-consumption ask. The base patterns above keyed on
      // `used`/`usage` (not the gerund "using") and on "how many licenses"
      // adjacent, so "how many Salesforce and Community licenses … using"
      // fell through. Anchor on "how many … licenses … using/paying" (the
      // provisioned-vs-paid frame), still guarded off a perm-set-assignment
      // question by the leading negative lookahead style used above.
      /^(?!.*\bpermission\s+sets?\b(?!\s+licen[sc]e)).*\bhow\s+many\b[^.?!]{0,60}\blicen[sc]es?\b[^.?!]{0,60}\b(?:using|use|paying|pay|provision\w*|actually\s+us\w*)\b/,
    ],
  },
  {
    // ROUTE-INACTIVE-AUTOMATION-WORD-MISBINDS-USERS — a save-failure incident
    // that asks whether an INACTIVE *automation* (a Draft/Obsolete flow, a
    // deactivated trigger/workflow/process, an inactive validation/duplicate
    // rule) blocked the save is a metadata/save-order question — NOT a
    // login-activity roster lookup. The bare word "user" (the person hitting the
    // error) sitting next to "inactive" (describing the automation) used to bind
    // the `inactive-users` rule below and divert the incident to
    // live_inactive_users (inactive USER ACCOUNTS). This high-precision rule
    // sits FIRST — it requires ALL THREE signals together: a save-failure /
    // blocked-save frame, an automation NOUN, and an inactive/draft/off token —
    // so it never steals a genuine "which users are inactive / haven't logged
    // in" question (no automation noun, no save frame) nor a plain "list
    // inactive flows" inventory ask (no save frame). Save-behavior (VR
    // whitelist) and inactive-validation-rules rules precede it and still win
    // their shapes; this catches the flow/trigger/automation residue that would
    // otherwise leak to inactive-users. Routes to the save-order + reasoning
    // path the finding's oracle prefers.
    intent: 'inactive-automation-save',
    plane: 'vault',
    tools: ['sfi.what_happens_on_save', 'sfi.interpret', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "Whether an INACTIVE automation blocked a save is offline metadata: what_happens_on_save reconstructs the save-order (inactive Flows are excluded as abort suspects), interpret reasons over the status-code / inactiveConfigured evidence, and list_components enumerates the Draft/Obsolete/inactive automations. Not a live inactive-USER-account roster lookup.",
    suggestArgs: (q) => ({ event: deriveSaveEvent(q) }),
    patterns: [
      // inactive/off token → automation noun (either near each other), with a
      // save-failure / blocked-save frame present anywhere in the question.
      /(?=.*\b(?:save|saving|saved|won'?t\s+save|can'?t\s+save|cannot\s+save|record\s+won'?t|blocks?|blocked|blocking|fail|failed|abort|aborted)\b).*\b(?:inactive|draft|obsolete|disabled|deactivated|not\s+active|turned\s+off|switched\s+off)\b[^.?!]{0,50}\b(?:flows?|triggers?|workflow(?:\s+rules?)?|process\s+builder|approval\s+process(?:es)?|automations?|duplicate\s+rules?|validation\s+rules?)\b/,
      // automation noun → inactive/off token, same save-failure frame guard.
      /(?=.*\b(?:save|saving|saved|won'?t\s+save|can'?t\s+save|cannot\s+save|record\s+won'?t|blocks?|blocked|blocking|fail|failed|abort|aborted)\b).*\b(?:flows?|triggers?|workflow(?:\s+rules?)?|process\s+builder|approval\s+process(?:es)?|automations?|duplicate\s+rules?|validation\s+rules?)\b[^.?!]{0,50}\b(?:inactive|draft|obsolete|disabled|deactivated|not\s+active|turned\s+off|switched\s+off)\b/,
    ],
  },
  {
    // ROUTE-COMMUNITY-LOGIN-MISBINDS-INACTIVE-USERS — "what communities does
    // this org have and who can log into them?" is a PURE OFFLINE METADATA
    // question (Network + CustomSite), but the `inactive-users` rule below
    // binds on `who … log in` and sent it to the LIVE inactive-user roster,
    // which answered `confidence: high, plane: live` and then returned a
    // consent error. This rule sits IMMEDIATELY ABOVE it and is additive: every
    // pattern requires an Experience-Cloud NOUN (community / experience cloud /
    // experience site / customer|partner|self-service portal) or the
    // unambiguous `self registration` token, so a genuine "which users haven't
    // logged in" / "list dormant users" roster question — which carries no such
    // noun — still falls through to `inactive-users` unchanged.
    intent: 'community-access',
    plane: 'vault',
    tools: ['sfi.community_catalog', 'sfi.guest_exposure_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Which communities exist and who is DECLARED able to log into them (member profiles and permission sets, self-registration and the profile it grants, internal-user login) is offline Network + CustomSite metadata: community_catalog joins the two, and guest_exposure_report covers the unauthenticated guest half. Not a live login-activity roster lookup — no live plane or consent is involved. Which named PEOPLE hold a community login is record data and is not answerable from the vault.',
    patterns: [
      // ACTIVITY-GUARDED (patterns 2-3). A community noun sitting within 60
      // chars of a login verb ALSO matches a genuine LastLoginDate roster
      // question scoped to a community — "which community users haven't
      // logged in for 90 days" — which belongs to `inactive-users` on the
      // LIVE plane. The stated guard ("a roster question carries no
      // community noun") is false whenever the asker scopes it. So the two
      // slack patterns additionally REFUSE the dormancy vocabulary that
      // `inactive-users` binds on. Pattern 1 (inventory) and pattern 4
      // (self-registration) need no guard — neither can be read as an
      // activity question — CORRECTED: pattern 1 needs it too. "which community
      // users haven't logged in for 90 days" opens with `which` and carries
      // `community` within 40 chars, so the INVENTORY frame claimed it. All
      // three slack patterns are guarded; only `self registration` is not,
      // because that token cannot appear in an activity question.
      // INVENTORY frame: "what/which/list/show … communities".
      /^(?!.*(?:\bhaven'?t\b|\bhasn'?t\b|\bnever\b|\blast\s+login\b|\bdormant\b|\bstale\b|\binactive\b|\bin\s+\d+\s+(?:days?|weeks?|months?)\b)).*\b(?:what|which|list|show|how\s+many)\b[^.?!]{0,40}\b(?:communit(?:y|ies)|experience\s+cloud(?:\s+sites?)?|experience\s+sites?)\b/,
      // COMMUNITY noun -> login / membership / signup frame.
      /^(?!.*(?:\bhaven'?t\b|\bhasn'?t\b|\bnever\b|\blast\s+login\b|\bdormant\b|\bstale\b|\binactive\b|\bin\s+\d+\s+(?:days?|weeks?|months?)\b)).*\b(?:communit(?:y|ies)|experience\s+cloud|experience\s+site|(?:customer|partner|self[-\s]?service)\s+portal)\b[^.?!]{0,60}\b(?:log\s?ins?|log(?:ged|ging)?\s?in(?:to)?|sign\s?in|sign(?:s|ed)?\s+(?:themselves\s+)?up|regist(?:er|ration)\w*|members?|member\s+profiles?|url\s+path)\b/,
      // login / membership / signup frame -> COMMUNITY noun.
      /^(?!.*(?:\bhaven'?t\b|\bhasn'?t\b|\bnever\b|\blast\s+login\b|\bdormant\b|\bstale\b|\binactive\b|\bin\s+\d+\s+(?:days?|weeks?|months?)\b)).*\b(?:log\s?in(?:to)?|log(?:ged|ging)?\s?in(?:to)?|sign\s?in|sign(?:s|ed)?\s+(?:themselves\s+)?up|regist(?:er|ration)\w*|members?)\b[^.?!]{0,60}\b(?:communit(?:y|ies)|experience\s+cloud|experience\s+site|(?:customer|partner|self[-\s]?service)\s+portal)\b/,
      // `self registration` / `selfRegProfile` is unambiguously the community
      // self-signup switch — no other Salesforce surface carries the term.
      /\bself[-\s]?regist(?:er|ration)\w*\b|\bselfregprofile\b/,
    ],
  },
  {
    intent: 'inactive-users',
    plane: 'live',
    tools: ['sfi.live_inactive_users'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Login activity (LastLoginDate) is runtime state that lives only in the org.',
    patterns: [
      // `in(to)?` — "which users logged INTO the org last week" is the same
      // LastLoginDate read; the bare `in\b` missed the fused "into" (P4).
      /\b(who|users?|people)\b.*\b(log(ged)?\s?in(to)?|login|active|inactive|dormant)\b/,
      /\b(inactive|dormant|stale|unused)\b.*\busers?\b/,
      /\bhaven'?t\b.*\blog(ged)?\s?in\b/,
      /\blast\s+login\b/,
      // Login-activity counts only — bare "how many users" is a live record
      // count (record-count) or a permission audit (over-permission), not dormancy.
      /\bhow\s+many\b.*\b(inactive|dormant|stale)\b.*\busers?\b/,
      /\bhow\s+many\b.*\busers?\b.*\b(inactive|dormant|stale|haven'?t\s+logged|not\s+logged)\b/,
      // Same permission-set guard as license-usage (eval family C): a seat
      // modifier on a perm-set-assignment ask must not land on login activity.
      /^(?!.*\bpermission\s+sets?\b(?!\s+licen[sc]e)).*\b(license|seat)s?\b.*\b(reclaim|unused|free|available)\b/,
    ],
  },
  {
    intent: 'field-population',
    plane: 'hybrid',
    tools: ['sfi.resolve', 'sfi.live_field_population'],
    liveRequired: true,
    needsResolve: true,
    reason: 'Whether a field is actually filled needs live record data, joined to vault schema.',
    patterns: [
      // "populated"/"filled" are field-specific; "empty/blank/null" only count
      // near a field/value (so "empty queues" doesn't get swallowed here).
      /\b(populated|filled)\b/,
      // "field population for X" / "population rate" — the noun "population"
      // (vs the adjective "populated"). Battery gap. Guarded (P4): "the FLOW
      // THAT fires the 'General Population RR Group' step" uses "population"
      // inside a quoted flow-step name — a flow-search ask, not field fill.
      /^(?!.*\bflows?\s+that\b).*\b(field\s+)?population\b/,
      // `fields?`/`values?` — `\b(field|value)\b` missed the PLURALS, so
      // "which Account fields are empty" fell through to metadata-count
      // (vault plane) instead of this hybrid live-data intent.
      /\b(empty|blank|null)\b.*\b(fields?|values?)\b/,
      /\b(fields?|values?)\b.*\b(empty|blank|null|populated|filled)\b/,
      /\bhow\s+many\b.*\b(have|with|without)\b.*\b(field|value|filled|set)\b/,
      /\b(actually|really)\s+(populated|filled)\b/,
      // Router-v2 P4 needs-live reachability: "fill rate", "completeness of
      // key fields", and "how many X have a blank Y" are all the same live
      // per-field population read. Queue/group emptiness and missing
      // DESCRIPTIONS stay vault (excluded).
      /\bfill\s+rates?\b/,
      /\bcompleteness\b.*\b(fields?|data|records?)\b|\b(fields?|data)\b.*\bcompleteness\b/,
      /\bhow\s+many\b(?!.*\b(queues?|groups?|descriptions?|help\s+text)\b)[^.?!]*\b(blank|null|missing)\b/,
    ],
  },
  {
    intent: 'org-limits',
    plane: 'live',
    tools: ['sfi.live_org_limits'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Storage, API usage, and governor headroom are live org telemetry.',
    patterns: [
      // "governor limits" → live runtime headroom, BUT not when the question is
      // about static Apex risk ("governor limit risks in our Apex", "SOQL in
      // loops") — that's the vault governor-risks scan (NI-7 misroute fix).
      // Guard scans the WHOLE question (not just forward): any static Apex / code
      // token anywhere means the vault governor-risks scan owns it, never live
      // org-limits (fixes ROUTE-GOVERNOR-APEX-MISBINDS-LIVE-ORG-LIMITS, where the
      // code tokens preceded "governor limits" and slipped past the forward-only
      // lookahead).
      /^(?!.*\b(?:risks?|apex|loops?|soql|dml|static|trigger|class(?:es)?|quer(?:y|ies)|bulkif\w*|injection|large\s+data\s+volumes?)\b).*\b(?:org|governor)\s+limits?\b/,
      /\b(api|daily)\s+(usage|calls?|limit)\b/,
      /\b(data|file)\s+storage\b/,
      /\bhow\s+much\s+(storage|api|data)\b/,
      /\b(headroom|quota|capacity)\b/,
    ],
  },
  {
    // decision 5 — live ownership/data skew: which owner (or grouping-field)
    // value holds more than N records of an object (the LDV concentration
    // check). Record counts are runtime-only, never in the offline vault, so
    // this is inherently a live_org read. "skew" is a rare, high-signal token
    // absent from every earlier rule — a low-collision addition.
    intent: 'data-skew',
    plane: 'live',
    tools: ['sfi.live_data_skew'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Ownership/data skew — which owner (or field) value concentrates more than the threshold records of an object — is live runtime telemetry (record counts are never in the offline vault).',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [
      /\b(?:data|ownership|owner|record|account)\s+skew\b/,
      /\bskew(?:ed)?\b[^.?!]{0,40}\b(?:records?|owner|account|object|data)\b/,
      /\b(?:ownership|owner)\b[^.?!]{0,40}\bconcentrat\w*\b/,
    ],
  },
  {
    // decision 5 — live security exposure: the runtime COUNT of ModifyAll /
    // ViewAll / AuthorApex permission-set grants + who currently holds Modify
    // All Data, via SOQL COUNT. Distinct from the offline permission_risk_report
    // (vault metadata); anchored on the "security exposure" phrase + live/runtime
    // cues that the permission-risk rule never uses.
    intent: 'live-security-exposure',
    plane: 'live',
    tools: ['sfi.live_security_exposure'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'A LIVE count of ModifyAll/ViewAll/AuthorApex grants (and current Modify-All-Data holders) via SOQL COUNT — the runtime security-exposure snapshot, distinct from the offline permission_risk_report over vault metadata.',
    patterns: [
      /\b(?:live|current|runtime)\b[^.?!]{0,40}\bsecurity\s+exposure\b/,
      /\bsecurity\s+exposure\b[^.?!]{0,40}\b(?:live|scan|check|report|org|right\s+now)\b/,
      /\blive\b[^.?!]{0,40}\b(?:modify\s*all|view\s*all|author\s*apex)\b[^.?!]{0,40}\bgrants?\b/,
    ],
  },
  {
    intent: 'sample-records',
    plane: 'live',
    tools: ['sfi.live_sample'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Returning example rows requires querying the live org (read-only, capped).',
    patterns: [
      // CMDT / Custom Setting records are VAULT data (sfi.lookup_record), not
      // live rows — carve them out so "show the values in the X__mdt records"
      // never burns live consent (P14-ROUTER-cmdt-record-values). No leading
      // \b before __mdt: suffixed api names have no boundary at underscores.
      // R7-W6: a record ACCESS/SHARING ask ("show me the sharing rows on
      // record X", "who is this record shared with") is live-record-access /
      // live-record-shares (below), not a generic sample-rows dump — carved
      // out the same way so the bare "rows"/record-id patterns here don't
      // swallow it.
      /^(?!.*(__mdt\b|\bcustom\s+metadata\b|\bcustom\s+settings?\b|\bshared?\s+with\b|\bsharing\s+rows?\b|\bshare\s+rows?\b|\beffective\s+access\b|\brecord[-\s]level\s+access\b)).*\b(show|give|sample|example)s?\b.*\b(records?|rows?)\b/,
      /\b(show|give)\s+me\s+\d+\b/,
      /\bsample\s+\d+\b/,
      /\b\d+\s+(sample|example)\s+\w+\b/,
      // Router-v2 P4: a literal Salesforce record ID (15/18 chars, leading 0 +
      // keyprefix — "did lead 00Q5x000004abcd convert?") is a live row lookup;
      // the vault never holds record data. R7-W6: excludes the same
      // access/sharing vocabulary so "show the sharing rows on record
      // 001XX0000123ABC" is not stolen from live-record-shares.
      /^(?!.*\b(?:shared?\s+with|sharing\s+rows?|share\s+rows?|effective\s+access|record[-\s]level\s+access)\b).*\b0[0-9a-z]{2}[0-9a-z]{12}(?:[0-9a-z]{3})?\b/,
    ],
  },
  {
    intent: 'owner-breakdown',
    plane: 'live',
    tools: ['sfi.live_owner_breakdown'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Record counts per owner need live OwnerId GROUP BY plus User/Queue names.',
    patterns: [
      /\b(records?|accounts?|contacts?|opportunit|cases?|leads?)\b.*\b(by|per)\s+owner\b/,
      /\bowner\b.*\b(breakdown|distribution|how\s+many|count)\b/,
      /\bwho\s+owns\b.*\b(most|the\s+most|records?)\b/,
      /\brecords?\s+by\s+owner\b/,
    ],
  },
  {
    // Save-order step counts — must precede metadata-count, which steals
    // "how many … validation rules" parentheticals on automation-step asks.
    intent: 'trigger-order',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_happens_on_save', 'sfi.order_of_execution'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Counting automation steps on save is a what_happens_on_save / order_of_execution reconstruction — not a list_components metadata count.',
    suggestArgs: (q, question) => {
      const args: Record<string, unknown> = { event: deriveSaveEvent(q) };
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      if (objectApiName !== undefined) args.objectApiName = objectApiName;
      return args;
    },
    patterns: [
      /\bhow\s+many\b.*\b(automation\s+steps?|save[-\s]order\s+steps?)\b/,
      /\bhow\s+many\b.*\b(before-save|after-save|post-save|pre-save|async)\b.*\b(flows?|steps?|paths?)\b/,
    ],
  },
  {
    // METADATA counts are vault, not live. "How many layouts / fields / objects
    // / profiles / validation rules ... [per X]" was stolen by the live
    // group-count/record-count rules and misrouted to live GROUP BY (B30.1).
    // Record counts (accounts, contacts, rows) fall through to the live rules
    // below. Placed AFTER field-population so "how many fields are populated"
    // stays hybrid/live.
    intent: 'metadata-count',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Counting metadata components (layouts, fields, objects, profiles, validation rules, flows, classes, record types, list views) is a vault list_components count — not live record data.',
    suggestArgs: deriveMetadataCountArgs,
    patterns: [
      // Negative lookahead `(?!.*\busers?\b)` scopes the metadata-component
      // count to EXCLUDE user-assignment phrasings ("how many USERS are on /
      // assigned to the X profile") — those are runtime User-record counts
      // (profile-assignment-count, live), not a count of Profile metadata
      // components. Without this, "how many users are on the System
      // Administrator profile?" was confidently WRONG: it counted Profile
      // components (P0a). Keyed on the word "users" alone — metadata-count
      // questions ("how many profiles / layouts / … , and which is assigned to
      // each profile") never say "users", so they still fire here.
      // The second lookahead (P4): "how many RECORDS per record type" is a
      // live GROUP BY over record data — the metadata noun ("record type") is
      // the grouping key, not the thing being counted.
      /\bhow\s+many\b(?!.*\busers?\b)(?!.*\brecords?\s+(?:per|by|for\s+each)\b).*\b(page\s+layouts?|layouts?|custom\s+objects?|profiles?|permission\s+sets?|validation\s+rules?|flows?|(apex\s+)?classes?|triggers?|record\s+types?|list\s+views?|report\s+types?|record\s+pages?|flexipages?|approval\s+process(es)?|custom\s+settings?|quick\s+actions?|sharing\s+rules?|named\s+credentials?|picklists?)\b/,
      /\bhow\s+many\b.*\blayouts?\b.*\b(per|for\s+each|by)\b.*\bprofiles?\b/,
      /\blayouts?\b.*\b(per|for\s+each|by)\b.*\bprofiles?\b/,
      // fields, but NOT field usage/population (those are unused-fields / field-population)
      /\bhow\s+many\b.*\b(custom\s+)?fields?\b(?!.*\b(used|populated|filled|actually|unused|empty|blank|set|values?)\b)/,
      /\b(which|what)\s+standard\s+objects?\b.*\b(triggers?|apex)\b/,
      /\bstandard\s+objects?\b.*\b(at\s+least\s+one\s+)?(apex\s+)?triggers?\b/,
    ],
  },
  {
    // ENGINE-ARC §4 (NEW arm): runtime queue / public-group MEMBERSHIP asks
    // ("who's in the Support queue", "members of the X public group", "can the
    // X queue own Case"). GroupMember rows are runtime state the vault does not
    // model — sfi.live_group_members reads them live (polymorphic user/group/
    // role split, QueueSobject supported objects, vault-drift cross-check).
    // Sits BEFORE group-count, which used to claim "who's in the X queue" with
    // a generic GROUP BY count; the roster tool now owns that vocabulary.
    // Boundary notes: "which queues are EMPTY" (declared-metadata hygiene
    // sweep) stays on empty-queues-groups; the neutral "which queues does
    // X_Queue route to and who are the members" stays on queue-membership
    // (vault get_component — declared members); a PSG "member of" ask never
    // lands here (patterns require the literal queue / public group noun).
    intent: 'queue-group-member-roster',
    plane: 'live',
    tools: ['sfi.live_group_members'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Who is actually IN a queue or public group is runtime GroupMember data — live_group_members lists the current roster (users, nested groups, roles) from the live org and cross-checks the vault-declared member count.',
    patterns: [
      // "who's / who is / who are ... in|on|member of ... the X queue|public group"
      /\bwho(?:'?s|\s+is|\s+are)?\b[^.?!]{0,30}\b(?:in|on|member\s+of)\b[^.?!]{0,40}\b(?:queues?|public\s+groups?)\b/,
      // "which users are in the Support queue?"
      /\b(?:which|what)\s+users?\b[^.?!]{0,30}\b(?:in|on|belong\s+to)\b[^.?!]{0,40}\b(?:queues?|public\s+groups?)\b/,
      // "members of the X queue" / "list the members of the Y public group"
      /\bmembers?\s+of\b[^.?!]{0,40}\b(?:queues?|public\s+groups?)\b/,
      // "the current membership of the X queue"
      /\bmembership\s+of\b[^.?!]{0,40}\b(?:queues?|public\s+groups?)\b/,
      // q267: "can the ADA_Team_Queue own Case records?" / "what objects does
      // the X queue support?" — QueueSobject supported objects.
      /\bcan\s+(?:the\s+)?\S+\s*queue\s+own\b/,
      /\bqueues?\b[^.?!]{0,30}\b(?:own|support)\b[^.?!]{0,30}\b(?:case|lead|objects?|records?)\b/,
      /\bobjects?\s+(?:does|can)\b[^.?!]{0,40}\bqueue\s+(?:support|own)\b/,
    ],
  },
  {
    intent: 'group-count',
    plane: 'live',
    tools: ['sfi.live_group_count'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Breakdowns by field value (Status, Stage, Industry) need live GROUP BY counts.',
    patterns: [
      /\bhow\s+many\b.*\b(by|per|each|grouped\s+by|breakdown)\b/,
      /\b(breakdown|distribution|split)\b.*\b(by|per)\b/,
      /\b(by|per)\s+(status|stage|type|industry|record\s+type)\b/,
      /\bhow\s+many\b.*\b(in|with)\s+(each|every)\b/,
      // "how many Applications with status Submitted" — filtered live COUNT, not vault metadata-count (B21).
      /\bhow\s+many\b.*\bwith\s+(status|stage|type|record\s+type)\b/,
      // Router-v2 P4: imperative "count X grouped by Y" / "count of X by Y" /
      // "count X records by Y" — the same live GROUP BY, phrased without
      // "how many".
      /\bcount\b[^.?!]{0,60}\bgrouped?\s+by\b/,
      /\bcount\s+of\b[^.?!]{0,60}\bby\b/,
      /\bcount\b[^.?!]{0,60}\brecords?\s+by\b/,
      // NOTE (ENGINE-ARC §4): "who's in the ADA Team Queue" used to land here
      // as a generic GROUP BY count; the queue-group-member-roster arm ABOVE
      // now owns that vocabulary with the dedicated live_group_members roster.
    ],
  },
  {
    intent: 'field-aggregate',
    plane: 'live',
    tools: ['sfi.live_aggregate'],
    liveRequired: true,
    needsResolve: false,
    reason: 'MIN/MAX/AVG/SUM on a numeric field requires live aggregate SOQL.',
    patterns: [
      /\b(average|avg|mean|minimum|min|maximum|max|sum|total)\b.*\b(field|value|amount|revenue|score)\b/,
      /\bwhat\s+is\s+the\b.*\b(average|avg|min|max|sum)\b/,
      /\bhow\s+(big|large|small)\b.*\b(on\s+average|average)\b/,
      // Router-v2 P4: "average number of X per Y" — a live AVG/GROUP BY ask
      // that named no field noun.
      /\baverage\s+number\s+of\b/,
    ],
  },
  {
    intent: 'duplicate-check',
    plane: 'live',
    tools: ['sfi.live_duplicate_check'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Duplicate detection needs live GROUP BY + HAVING on field values.',
    patterns: [
      // `duplicat\w*` — "most DUPLICATED email domain" is the same live GROUP
      // BY + HAVING read; the bare `duplicate` missed the participle (P4).
      /\bduplicat\w*\b.*\b(records?|values?|emails?|domains?|contacts?|accounts?|fields?|rows?)\b/,
      // Guarded: "which FIELDS are duplicated" is a SCHEMA-redundancy ask
      // (vault), not live record duplicates — exclude the fields subject.
      /^(?!.*\bfields?\b[^.?!]{0,40}\bduplicat)\b.*\b(records?|values?|emails?|domains?|contacts?|accounts?)\b.*\bduplicat\w*\b/,
      /\bsame\b.*\b(email|phone|name|value)\b/,
    ],
  },
  {
    intent: 'storage-by-object',
    plane: 'live',
    tools: ['sfi.live_storage_by_object'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Record counts per object are live-only; EntityDefinition discovery plus COUNT().',
    patterns: [
      /\b(which|what)\b.*\bobjects?\b.*\b(most|biggest|largest|highest)\b.*\b(records?|rows?|data|storage)\b/,
      /\brecord\s+counts?\b.*\b(per|by|across)\b.*\bobjects?\b/,
      /\bstorage\b.*\b(by|per)\b.*\bobject\b/,
      /\bdata\s+volume\b.*\bobject\b/,
      /\btop\b.*\bobjects?\b.*\b(by|with)\b.*\b(records?|rows?)\b/,
      // "which custom objects are essentially empty in prod" — whether an
      // object holds records is the SAME live per-object COUNT read from the
      // other end (zero/near-zero instead of most); it was unrouted and the
      // vault cannot answer it at all (eval family D).
      /\b(which|what)\b[^.?!]{0,40}\bobjects?\b[^.?!]{0,50}\bempty\b/,
      /\bempty\b[^.?!]{0,20}\b(custom\s+)?objects?\b/,
      /\bobjects?\b[^.?!]{0,40}\b(no|zero|barely\s+any|hardly\s+any)\s+(records?|rows?|data)\b/,
      // Router-v2 P4: growth and per-object size asks are the same live
      // per-object COUNT read ("which objects have grown the fastest",
      // "inventory of every custom object and roughly how big each is").
      /\bobjects?\b[^.?!]{0,60}\b(grown|growth|growing)\b/,
      /\b(grown|growth|growing)\b[^.?!]{0,60}\bobjects?\b/,
      /\bobjects?\b[^.?!]{0,60}\bhow\s+big\b/,
      /\bhow\s+big\b[^.?!]{0,60}\bobjects?\b/,
    ],
  },
  {
    intent: 'record-count',
    plane: 'live',
    tools: ['sfi.live_count'],
    liveRequired: true,
    needsResolve: false,
    reason: 'A record COUNT is live data; the offline vault holds metadata only.',
    patterns: [
      /\bhow\s+many\b.*\b(records?|rows?|accounts?|contacts?|opportunit(?:y|ies)?|leads?|cases?)\b/,
      /\b(count|number)\s+of\b.*\b(records?|rows?)\b/,
      // Router-v2 P4: imperative "count <X> records" (no "of", no "how many").
      /\bcount\b[^.?!]{0,60}\brecords?\b/,
      /\bhow\s+many\b.*\bin\s+(the\s+)?(org|production|prod)\b/,
      /\blive\s+count\b/,
      // A TEMPORAL qualifier cues live data regardless of the noun — "how
      // many open applications do we have right now" was unrouted because
      // the noun list above can never name every object (the last Phase-14
      // gallery miss; P14-ROUTER-live-count-temporal). Metadata nouns still
      // win: the metadata-count rule sits earlier. fired/ran/logged forms
      // are excluded so automation/login activity asks don't collapse into
      // a bare record count.
      /\bhow\s+many\b(?!.*\b(fired|ran|executed|triggered|logged)\b).*\b(right\s+now|currently|at\s+the\s+moment|as\s+of\s+(now|today)|today|this\s+(term|semester|quarter))\b/,
      /\b(count|number)\s+of\b.*\b(right\s+now|currently|at\s+the\s+moment|today)\b/,
      // Named sObject totals without the word "records" — "how many Opportunities
      // are there" (TEST-SANDBOX-ROUTER-first-user). Exclude non-SF platforms
      // (battery-wrong: "how many SAP tables do we have" → unknown).
      /\bhow\s+many\b(?!.*\b(sap|workday|oracle|netsuite|servicenow)\b).*\b(are\s+there|do\s+we\s+have|exist)\b/,
      // Permission audits ("how many users have Modify All Data") use over-permission.
      /\bhow\s+many\b(?!.*\b(modify\s+all|view\s+all)\b).*\b(active\s+)?users?\b/,
    ],
  },
  {
    intent: 'stale-records',
    plane: 'live',
    tools: ['sfi.live_stale_records'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Stale/untouched records are identified from live date fields (LastModifiedDate etc.).',
    patterns: [
      /\b(stale|untouched|not\s+(touched|updated|modified)|inactive)\b.*\b(records?|accounts?|contacts?|opportunit|cases?|leads?)\b/,
      /\b(records?|accounts?|contacts?)\b.*\b(not\s+(updated|modified|touched)|stale|old|inactive)\b/,
      /\bwhich\b.*\b(records?|accounts?|contacts?|opportunit|cases?|leads?)\b.*\b(haven'?t|have\s+not)\b.*\b(been\s+)?(updated|modified|touched)\b/,
    ],
  },
  {
    intent: 'recent-activity',
    plane: 'live',
    tools: ['sfi.live_recent_activity'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Recently created or modified records are live-only runtime state.',
    patterns: [
      // R7-W6: excludes Setup-CONFIG vocabulary (field-level security / sharing
      // settings / OWD / session settings / password policy / MFA / profile /
      // permission set / setup audit trail) — "who modified the field-level
      // security … most recently" is a SetupAuditTrail ask (live-setup-audit-
      // trail, below), not a record-activity sweep over a business object.
      /^(?!.*\b(?:field-?level\s+security|\bfls\b|sharing\s+settings?|org-?wide\s+defaults?|\bowd\b|session\s+settings?|password\s+polic\w*|\bmfa\b|permission\s+sets?|profiles?|setup\s+audit\s+trail)\b).*\b(recent(ly)?|last\s+\d+\s+days?|this\s+week|past\s+week)\b.*\b(created|modified|updated|changed|added)\b/,
      /^(?!.*\b(?:field-?level\s+security|\bfls\b|sharing\s+settings?|org-?wide\s+defaults?|\bowd\b|session\s+settings?|password\s+polic\w*|\bmfa\b|permission\s+sets?|profiles?|setup\s+audit\s+trail)\b).*\b(created|modified|updated|new)\b.*\b(recent(ly)?|last\s+\d+\s+days?|this\s+week)\b/,
      /\bwhat\s+(was|were)\b.*\b(created|modified|updated|changed)\b.*\b(recent|last)\b/,
      // Router-v2 P4: "who's been making the most changes lately" / "busiest
      // user by record edits" — the same recent-modified read, cut by editor.
      /\bwho\b[^.?!]{0,40}\b(making|made)\b[^.?!]{0,30}\bchanges\b/,
      /\bbusiest\s+users?\b/,
    ],
  },
  {
    // Live picklist VALUE USAGE — "which Case.Status values are never used",
    // "distribution of Status values", "most common Resolution_Code__c".
    // Distinct from picklist-values (vault, DECLARED value set): usage /
    // distribution / most-common language means live GROUP BY counts per
    // value (router-v2 P4 needs-live reachability). Placed in the live block
    // so it wins over the vault picklist-values rule further down.
    intent: 'picklist-usage',
    plane: 'live',
    tools: ['sfi.live_picklist_usage'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'How picklist/field VALUES are actually used across records (counts per value, never-used values) is live GROUP BY data — the vault only declares the value set.',
    // NOTE the distance windows allow an interior dot (`Case.Status`) — a
    // dotted field reference must not break the sentence-bounded window.
    patterns: [
      /\bpicklist\b(?:[^.?!]|\.(?=\w)){0,80}\b(never\s+used|actually\s+used|usage|distribut\w+|frequen\w+)\b/,
      /\bvalues?\b(?:[^.?!]|\.(?=\w)){0,60}\b(never|rarely)\s+used\b/,
      /\b(distribution|breakdown)\s+of\b(?:[^.?!]|\.(?=\w)){0,60}\bvalues?\b/,
      /\bhow\s+are\b(?:[^.?!]|\.(?=\w)){0,40}\bvalues?\b(?:[^.?!]|\.(?=\w)){0,40}\bdistributed\b/,
      /\b(most|least)\s+common\b(?:[^.?!]|\.(?=\w)){0,50}\b(value|status|code|__c)\b/,
      /\b(?:whats?|what\s+is)\s+the\s+most\s+common\b/,
    ],
  },
  {
    // Live automation execution — "did the flow FIRE yesterday?" is a runtime
    // question about actual executions (FlowInterview / job traces), not the
    // automation catalog (router-v2 P4). Temporal anchor required so the
    // metadata asks ("what fires on save") never land here.
    intent: 'automation-fired',
    plane: 'live',
    tools: ['sfi.live_automation_fired'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Whether an automation actually RAN (and when) is runtime execution state — live_automation_fired reads it; the vault only holds the automation definitions.',
    patterns: [
      /\b(flow|trigger|automation|process|it)\b[^.?!]{0,60}\bfired\b[^.?!]{0,50}\b(yesterday|today|last\s+\w+|this\s+\w+|recently)\b/,
      /\bfired\b[^.?!]{0,30}\b(yesterday|today|last\s+night|recently)\b/,
      /\bdid\b[^.?!]{0,60}\b(flow|trigger|automation)\b[^.?!]{0,50}\b(fire|run|execute|actually\s+fire)\b/,
      /\b(flow|trigger|automation)\b[^.?!]{0,40}\b(actually\s+(ran|fired|executed))\b/,
    ],
  },
  {
    // M25 — a QUICK health snapshot = org_pulse. The org-health rule below owns
    // "health snapshot" and leads with live_org_health; the ONLY distinguisher
    // between the two goldset siblings is the word "quick".
    intent: 'org-pulse',
    plane: 'live',
    tools: ['sfi.org_pulse'],
    liveRequired: true,
    needsResolve: false,
    reason: 'A quick org pulse / health snapshot (org_pulse), distinct from the fuller live_org_health.',
    patterns: [
      /\bquick\b[^?!]{0,30}\b(health|pulse)\b/,
      /\borg[_\s]?pulse\b/,
    ],
  },
  {
    intent: 'org-health',
    plane: 'live',
    tools: ['sfi.live_org_health'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Failed jobs, paused flows, and limit headroom are live operational telemetry.',
    patterns: [
      /\b(org|org'?s?)\b.*\b(on\s+fire|unhealthy|health|healthy)\b/,
      /\b(failed|faulted|stuck)\b.*\b(jobs?|batch|async|apex\s+job)\b/,
      /\bpaused\b.*\bflows?\b/i,
      /\bis\s+my\s+org\b.*\b(ok|fine|broken|failing)\b/,
      // Router-v2 P4: "give me a health snapshot of the org" — the noun order
      // put "health" before "org", which the first pattern missed, and the
      // word "snapshot" was stolen by the vault snapshot-diff rule.
      /\bhealth\s+snapshot\b/,
    ],
  },
  {
    // Fleet sweep FIRST — its patterns are narrow (fleet/registry/refresh-first/
    // rank-orgs-by-drift/most-behind), so a single-org "is my vault stale" still
    // falls through to drift-check below; but "fleet drift" / "rank my orgs by
    // drift" must not be swallowed by drift-check's bare \bdrift\b.
    intent: 'fleet-drift-ranking',
    plane: 'live',
    tools: ['sfi.fleet_drift_ranking'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Ranks registered vaults by how far each is behind its live org (which to refresh first) — a per-org consent-gated live staleness sweep across the registry.',
    patterns: [
      /\bwhich\b.*\b(org|vault)s?\b.*\brefresh\s+first\b/,
      /\b(fleet|registry|orgs)\b.*\bdrift\b/,
      /\bdrift\b.*\b(fleet|across\s+(my\s+)?(orgs|vaults)|rank)/,
      /\bwhich\b.*\b(org|vault)s?\b.*\bmost\b.*\b(behind|stale|drift)/,
      /\brank\b.*\b(org|vault)s?\b.*\b(drift|stale|behind)\b/,
    ],
  },
  {
    intent: 'drift-check',
    plane: 'hybrid',
    tools: ['sfi.resolve', 'sfi.live_drift_check'],
    liveRequired: true,
    needsResolve: true,
    reason: 'Comparing the snapshot to the org needs both planes.',
    patterns: [
      // Vault-vs-live only. Org-vs-org ("UAT vs prod") is cross-org-diff, so
      // require a vault/snapshot/metadata side here.
      /\bdrift\b/,
      /\b(vault|snapshot|metadata|offline)\b.*\b(match|matches|differ|current|stale|out\s+of\s+date|up\s?to\s?date)\b/,
      /\bdoes\b.*\b(vault|snapshot)\b.*\bmatch\b/,
    ],
  },

  // === Reports / folders / email templates (catalog demand → Wave 1) ========
  {
    intent: 'report-type-inventory',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Report TYPE definitions (ReportType metadata) are vault catalog items — distinct from live report LastRunDate usage or Report bodies that may not be retrieved.',
    suggestArgs: () => ({ type: 'ReportType' }),
    patterns: [
      /\b(which|what|are\s+there|how\s+many)\b.*\breport\s+types?\b/,
      /\breport\s+types?\b.*\b(based\s+on|join|joining|defined|include|custom|standard)\b/,
      /\bcustom\s+report\s+types?\b/,
      /\breport\s+types?\b.*\b(to|→|->)\b.*\b(account|contact|opportunity|case)\b/,
    ],
  },
  {
    intent: 'report-catalog-gap',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Report and dashboard DEFINITIONS are vault catalog items when retrieved. The vault may model ReportTypes without Report bodies — never answer from live LastRunDate when the question asks for report/dashboard inventory or field usage in reports.',
    suggestArgs: (q) => {
      if (/\bdashboards?\b/.test(q)) return { type: 'Dashboard' };
      return { type: 'Report' };
    },
    patterns: [
      /\bhow\s+many\b.*\breports?\b(?!.*\breport\s+types?\b)(?!.*\b(useless|unused|stale|dead|old|never\s+run|not\s+used|broken)\b)/,
      /\bhow\s+many\b.*\bdashboards?\b/,
      /\bwhich\s+reports?\b.*\b(use|using|reference|include)\b/,
      /\breports?\b.*\b(use|using|reference)\b.*\b(field|__c)\b/,
      /\breports?\b.*\b(filters?|filter criteria)\b/,
      /\b(scheduled|subscription|email)\b.*\breports?\b/,
      /\breports?\b.*\b(scheduled|subscription|email)\b/,
      /\bwhich\b.*\bfields?\b.*\b(report|dashboard)\b/,
      /\bfields?\b.*\bfeed\b.*\b(report|dashboard)\b/,
      /\bdashboard\b.*\b(running[-\s]?user|folder|visibility)\b/,
      /\breport\s+folders?\b/,
    ],
  },
  {
    intent: 'reports-usage',
    plane: 'hybrid',
    tools: ['sfi.live_report_usage', 'sfi.list_components'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Report inventory is in the vault; stale/unused needs live LastRunDate.',
    patterns: [
      /\breports?\b.*\b(useless|unused|stale|dead|old|never\s+run|not\s+used|broken)\b/,
      // Guarded (eval family C): "compliance report … who touches the X field"
      // uses "report" as the requested DELIVERABLE, not the subject — the
      // head question is field access, so a compliance/who-touches frame must
      // not land on live report run-history.
      /^(?!.*\b(?:compliance|who\s+touch)\w*\b).*\b(reports?|dashboards?)\b.*\b(cover|covers|about|for)\b(?!.*\breport\s+types?\b)/,
      /\b(useless|unused|stale|dead)\b.*\breports?\b/,
      /\b(dashboards?)\b.*\b(unused|stale|broken|refresh)\b/,
      /\breports?\b.*\b(not\s+run|haven'?t\s+been\s+run)\b/,
      /\breports?\b.*\b(last\s+year|in\s+the\s+last)\b/,
      // "which reports are ACTUALLY USED" — run-history is live LastRunDate
      // (router-v2 P4; previously a funnel plane near-tie that BLOCKED).
      /\breports?\b[^.?!]{0,40}\bactually\s+used\b/,
      // Router-v2 P4: "reports/dashboards nobody looks at / no one uses" —
      // the colloquial unused-ask without the word "unused".
      /\b(reports?|dashboards?)\b[^.?!]{0,60}\b(nobody|no\s+one)\b[^.?!]{0,40}\b(looks?|uses?|runs?|view\w*|open\w*)\b/,
    ],
  },
  {
    intent: 'folder-access',
    plane: 'live',
    tools: ['sfi.live_folder_access'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Report / dashboard / document / email-template ACCESS is folder-gated: who can see them is the Folder’s share settings (FolderShare), which are live Folder metadata. The offline vault holds only the folder/report/dashboard NAMES (catalog), not the folder shares — so this needs the live plane. (List-view visibility IS offline — see list_view_sharing.)',
    gap: {
      category: 'folder-access',
      note: 'Offline boundary: a report/dashboard/document folder’s access (who can view it) is runtime FolderShare metadata not retrieved into the vault — the offline plane has only the names. Enable the live plane and use live_folder_access for actual folder access. This is NOT the same as list-view sharing (offline, via list_view_sharing) or record access (object_access_audit / why_cant_user_see_record).',
    },
    patterns: [
      /\bfolders?\b.*\b(access|share|shared|permission|who\s+can|public|private)\b/,
      /\b(who\s+can|access\s+to)\b.*\bfolders?\b/,
      // Folder-gated artifacts asked about by ACCESS without the word "folder":
      // "who can see/access/view this report/dashboard/document".
      /\bwho\s+can\s+(access|see|view|open|run)\b.*\b(reports?|dashboards?|documents?)\b/,
      /\b(access|visib(le|ility))\b.*\b(reports?|dashboards?|documents?)\s+folders?\b/,
      /\b(dashboards?|reports?)\b.*\bshared\b.*\b(with|to)\b/,
    ],
  },
  {
    intent: 'email-template-usage',
    plane: 'hybrid',
    tools: ['sfi.live_email_template_usage', 'sfi.list_components'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Template usage and Classic-vs-Lightning signals need live EmailTemplate fields.',
    patterns: [
      /\bemail\s+templates?\b/,
      /\b(classic|legacy)\b.*\btemplates?\b/,
      // Bounded gap: an unbounded `.*` here matched ACROSS clauses of a long
      // compound question ("…application templates … named credentials USED
      // by…") and dragged a vault security ask onto this live-required email
      // tool (P14-ROUTER-community-security-compound). Real asks keep the
      // verb near the noun ("which templates are unused").
      /\btemplates?\b[^.?!]{0,40}\b(used|unused|migrate|move|legacy)\b/,
    ],
  },

  // === Security / access / sharing / PII / compliance (vault) ===============
  // P12-ROUTER-new-tool-intents: the P11 access/UI tools shipped without router
  // entries, so their questions went `unrouted` or were stolen by broader
  // intents (field-access / trigger-order / list-views / schema). Placed FIRST
  // in this cluster so a tool-specific question wins; each is anchored to its
  // tool's NOUN (flow-run / app / tab / list-view-sharing / record-type /
  // object-CRUD / effective-permission / value-transition) so it never steals
  // the generic field / record / layout questions below.
  {
    intent: 'user-ability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.user_ability'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What a Profile / PermissionSet can RUN or DO — runnable Flows, action permissions, login restrictions — is modeled from the vault (user_ability).',
    patterns: [
      /\bwhat\s+(flows?|reports?|automation)\b.*\bcan\b.*\b(profile|permission\s+set|permset|user)\b.*\brun\b/,
      /\bwhat\s+can\b.*\b(profile|permission\s+set|permset)\b.*\b(run|do|execute)\b/,
      /\b(runnable\s+flows?)\b/,
      /\bwhat\s+(flows?|things?)\s+can\b.*\b(the\s+)?\w+\s+(user|profile)\b.*\brun\b/,
      // "which profiles can run reports" — reverse direction (baseline-300 gap).
      /\b(which|what)\s+profiles?\b.*\bcan\b.*\brun\b.*\breports?\b/,
      // API-enabled login profiles.
      /\b(which|what)\s+profiles?\b.*\b(api|log\s+in|login)\b/,
      /\bprofiles?\b.*\b(log\s+in|login)\b.*\bapi\b/,
      // REACH (permissions/access cluster) — FORWARD run-access: "which screen
      // flows are exposed / available / visible / assigned to the <Named>
      // profile / perm set". This is the granter's OWN runnableFlows list
      // (user_ability), not the reverse who_can_run (which starts from a flow).
      // "exposed to <profile>" is the natural phrasing the existing
      // "what flows can X run" templates missed.
      /\bwhich\s+(?:screen\s+)?flows?\b[^.?!]{0,40}\b(?:exposed|available|visible|assigned)\s+to\b[^.?!]{0,30}\b(?:profile|perm\s*sets?|permission\s+sets?|user)\b/,
      // M43 — "what the <X> user can do" (a named USER, not profile/permset, and
      // no "run" verb) is the granter's own ability roster; the templates above
      // missed this phrasing so it fell through to unrouted/capabilities.
      /\bwhat\b[^.?!]{0,30}\buser\s+can\s+do\b/,
    ],
  },
  {
    intent: 'who-can-run',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.who_can_run'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Which Profiles / PermissionSets grant RUN access to a Flow — the reverse of user-ability — from flowAccess grants in the vault (who_can_run).',
    patterns: [
      /\bwho\s+can\s+run\b.*\bflow/,
      /\b(which|what)\s+(profiles?|permission\s+sets?|permsets?)\b.*\brun\b.*\bflow/,
      /\bwho\s+(can|is\s+able\s+to)\s+run\b.*\bflow/,
      // REACH (permissions/access cluster): the existing templates broke on
      // (1) an adverb between who/can and run ("who EXACTLY can run …",
      // "who ACTUALLY can run …") and (2) a Flow named by its API id with a
      // `_flow` / `_screen_flow` suffix but no separate bare word "flow"
      // ("run Some_Named_Screen_Flow"). `FLOWREF` matches the bare word
      // "flow(s)", the `_flow` suffix (no leading `\b`, so it fires inside a
      // multi-underscore API name), or "screen flow(s)". Two shapes:
      //   (a) who [adverb] can run … <flow>
      //   (b) can the <profile/perm set/user> run … <flow>
      // Both require the RUN verb + a flow reference, so they never steal a
      // record/object/field access ask (no "run … flow" there).
      /\bwho\b[^.?!]{0,20}\bcan\b[^.?!]{0,15}\brun\b[^.?!]{0,60}(?:\bflows?\b|_flow\b|screen\s+flows?\b)/,
      /\bcan\b[^.?!]{0,40}\b(?:profile|perm\s*sets?|permission\s+sets?|user)\b[^.?!]{0,20}\brun\b[^.?!]{0,60}(?:\bflows?\b|_flow\b|screen\s+flows?\b)/,
    ],
  },
  {
    intent: 'app-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.app_access'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "A CustomApplication's tabs + who can open / defaults to it, from applicationVisibilities in the vault (app_access).",
    patterns: [
      /\bwho\s+can\s+(open|access|use|see|launch)\b.*\bapp(lication)?\b/,
      /\bwhat('?s|\s+is)?\b.*\bin\b\s+the\b.*\bapp(lication)?\b/,
      // "application" used ATTRIBUTIVELY ("application templates/records/
      // object/history") names a business OBJECT, not a Salesforce app — a
      // long community-security question was stolen onto this intent through
      // the bare \bapp prefix + unbounded gaps (P14-ROUTER-community-
      // security-compound). Gaps bounded to one clause; attributive uses
      // excluded.
      /\bwhich\s+(profiles?|users?|permission\s+sets?)\b[^.?!]{0,40}\b(open|default|access)\b[^.?!]{0,30}\bapp(lication)?s?\b(?!\s+(templates?|records?|objects?|history|data|fields?))/,
      /\b(tabs?\s+(in|of|for))\b.*\bapp/,
      /\bwhat\s+apps?\b.*\b(can|does)\b.*\b(profile|user|permission\s+set)\b.*\b(open|access|use)\b/,
      // "what apps are visible to the Marketing profile" — the INVERSE
      // direction app_access answers from the granter's own
      // applicationVisibilities (P14-APP-default-reverse; a top
      // baseline-300 unrouted cluster).
      /\bwhat\s+apps?\b.*\b(visible|available)\b.*\b(profiles?|permission\s+sets?|users?)\b/,
      /\b(default)\s+app\b.*\b(profiles?|permission\s+sets?)\b/,
      // REVERSE direction (P1a): "which apps is profile X assigned to?" /
      // "which applications are assigned to profile X?" — the app→profile
      // grammar; app_access answers it from the granter's own
      // applicationVisibilities, same as the forward "which profiles can open X".
      // Matches "app" or "application(s)" and BOTH word orders (assigned-to
      // before or after the profile noun).
      /\bwhich\s+app(lication)?s?\b.*\bprofiles?\b.*\b(assigned|available)\b/,
      /\bwhich\s+app(lication)?s?\b.*\b(assigned|available)\s+to\b.*\bprofiles?\b/,
    ],
  },
  {
    intent: 'tab-availability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.tab_availability'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Which tabs a Profile / PermissionSet can see (tabVisibilities), modeled from the vault (tab_availability).',
    patterns: [
      /\bwhat\s+tabs?\b.*\b(can|does|profile|permission\s+set|see|visible|available)\b/,
      /\bwhich\s+tabs?\b.*\b(profile|permission\s+set|user|can\s+see|visible)\b/,
      /\btab\s+(visibility|availability|settings?)\b/,
    ],
  },
  {
    intent: 'list-view-sharing',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_view_sharing'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "A list view's <sharedTo> visibility scope (the groups/roles it is shared with), modeled from the vault (list_view_sharing).",
    patterns: [
      /\b(list\s+views?|listviews?)\b.*\b(shared\s+with|sharing|shared|visib(le|ility))\b/,
      /\b(shared|sharing|visib(le|ility))\b.*\blist\s+views?\b/,
      /\bwho\s+(is|can\s+see)\b.*\blist\s+views?\b/,
    ],
  },
  {
    intent: 'recordtype-availability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.recordtype_availability'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Which record types a Profile / PermissionSet can create / see (recordTypeVisibilities), from the vault (recordtype_availability).',
    patterns: [
      /\b(what|which)\s+record\s+types?\b.*\b(can|profile|permission\s+set|user)\b.*\b(create|see|use|select|pick)\b/,
      /\bwhat\s+record\s+types?\b.*\b(the\s+)?\w+\s+(profile|user|permission\s+set)\b/,
      /\brecord\s+type\s+(visibility|availability)\b/,
      /\bdefault\s+record\s+type\b/,
      /\brecord\s+types?\b.*\bno\s+profile\b.*\baccess/,
      /\b(which|what)\s+(profiles?|permission\s+sets?)\b.*\baccess\b.*\brecord\s+types?\b/,
      // REVERSE direction (P1a): "which record types are available to profile X?"
      // — the recordtype→profile grammar the forward templates above missed. Same
      // recordTypeVisibilities modeling, answered from the profile side.
      /\bwhich\s+record\s+types?\b.*\b(available|access|assigned)\s+to\b.*\bprofiles?\b/,
      /\b(available|access|assigned)\s+to\b.*\bprofiles?\b.*\brecord\s+types?\b/,
      // REACH (permissions/access cluster) — "why can't / won't <user> create /
      // pick / select the <X> RECORD TYPE" is a recordTypeVisibilities gap: the
      // container simply doesn't have that record type visible-for-create. The
      // literal "record type" / "recordtypeid" noun keeps this off why-cant-see
      // (record SHARING) and off object-access (object CRUD) — both of which
      // lack the record-type noun.
      /\bwhy\s+(?:can'?t|won'?t|cannot)\b[^.?!]{0,60}\b(?:create|pick|select|use|choose|see|open)\b[^.?!]{0,40}\brecord\s+type\b/,
      /\brecord\s?type\s?id\b[^.?!]{0,60}\b(?:pick|select|choose|create|use)\b/,
    ],
  },
  {
    // ENGINE-ARC §4 (NEW arm): the REVERSE user→grantors direction — "what
    // permission sets does USER Jane hold". A different contract from the
    // holder-roster direction (permset-user-roster below) and from the vault
    // GRANTS direction: PermissionSetAssignment rows for one assignee are
    // runtime state, so sfi.live_user_permsets reads them live (direct sets vs
    // via-PSG, expirations, profile named). The ordered pair with vault
    // sfi.effective_permissions is deliberate DUAL PROVENANCE: live = WHICH
    // grantors she holds; vault = WHAT those grantors grant. Sits BEFORE
    // effective-permissions, which used to first-match these phrasings and
    // could only describe grants, never the user's actual assignments.
    intent: 'user-permset-holdings',
    plane: 'live',
    tools: ['sfi.live_user_permsets', 'sfi.effective_permissions'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'What a named USER holds (their PermissionSetAssignment rows) is runtime state: live_user_permsets lists the direct sets and via-PSG assignments from the live org; effective_permissions then expands what those grantors grant (dual provenance).',
    patterns: [
      // Permission sets assigned to a named user (moved here from
      // effective-permissions — the router used to first-match these to the
      // vault GRANTS tool, which cannot know a user's assignments).
      /\bpermission\s+sets?\b.*\bassigned\b.*\buser\b/,
      /\bwhat\s+permission\s+sets?\b.*\bassigned\b/,
      // "what permission sets does Jane Doe have / hold" — requires the
      // PERMISSION SET(S) noun phrase, so "what permissions does the X profile
      // have" (grants direction) stays on effective-permissions. The
      // `(?!\s+group)` lookahead keeps "which permission set GROUPS are
      // assigned to nobody" on the unassigned-permset-groups hygiene arm.
      /\b(?:what|which)\s+(?:permission\s+sets?|perm\s+sets?)(?!\s+group)\b[^.?!]{0,20}\b(?:does|do|is|are)\b[^.?!]{0,50}\b(?:have|hold|holds|assigned|carry)\b/,
      // "which permission set groups is <UserName> a member of?" — anchored on
      // the literal "member of" so "which PSGs are assigned to NOBODY" (the
      // unassigned-permset-groups hygiene ask, a later rule) is never stolen.
      // [^?!] (not [^.?!]): usernames are email-shaped and contain dots.
      /\bwhich\s+permission\s+set\s+groups?\s+(?:is|are)\b[^?!]{0,60}\bmember\s+of\b/,
      // "which permission sets is jane.doe@example.com assigned right now?" —
      // the grantee token sits between is/are and "assigned"; \S+ spans the
      // email-shaped username that clause-bounded classes cannot.
      /\bpermission\s+sets?\s+(?:is|are)\s+\S+(?:\s+\S+)?\s+assigned\b/,
      // "what does the user Jane hold — direct sets and via groups?"
      /\bwhat\s+does\s+(?:the\s+)?user\b[^.?!]{0,40}\bhold\b/,
      // "show me every permission set assigned to <UserName>" — the grantee is
      // named after "assigned to" (holder-direction phrasings name the SET
      // after the users noun and never match this). The lookahead excludes
      // "assigned to NOBODY / no one / anyone" — that is the vault
      // unassigned-permsets hygiene sweep, not a user's holdings.
      /\b(?:every|all|each)\s+permission\s+sets?\s+assigned\s+to\s+(?!nobody\b|no\s+one\b|noone\b|anyone\b|anybody\b)/,
      // "list <UserName>'s permission set and PSG assignments"
      /\S+'s\s+permission\s+sets?\b/,
      // "does <UserName> have any expiring permission set assignments?"
      /\bexpir\w+\s+permission\s+set\s+assignments?\b/,
    ],
  },
  {
    // R7-W6: a user's ACTUAL/EFFECTIVE access to ONE record, right now, from
    // the live sharing calculation (UserRecordAccess) — the runtime resolver
    // for why_cant_user_see_record's `unknown` verdict. Sits BEFORE
    // effective-permissions, which used to first-match "effective access" —
    // that vault rule answers the profile+permset GRANT union, not a live
    // per-record read, so the "record" anchor here must win first-match. Does
    // NOT steal why-cant-see's negative "why can't X see" framing (a later
    // rule, vault) — these patterns require a POSITIVE actual/current/live
    // framing instead.
    intent: 'live-record-access',
    plane: 'live',
    tools: ['sfi.live_record_access'],
    liveRequired: true,
    needsResolve: false,
    reason:
      "A user's EFFECTIVE access to ONE record right now (Read/Edit/Delete/Transfer/Full) is runtime sharing state — live_record_access reads UserRecordAccess directly; it never falls back to the vault's declared sharing model.",
    patterns: [
      /\beffective\s+access\b[^.?!]{0,40}\brecord\b/,
      /\brecord\b[^.?!]{0,40}\beffective\s+access\b/,
      /\bcan\b[^.?!]{0,60}\b(?:edit|access|see|view|delete|read)\b[^.?!]{0,40}\brecord\b[^.?!]{0,30}\b(?:right\s+now|currently|today)\b/,
      /\bhave\s+(?:delete|edit|read|transfer|full)?\s*access\s+to\s+(?:this|that|a)?\s*record\b/,
      /\bcheck\s+(?:whether|if)\b[^.?!]{0,60}\b(?:access|see|view|edit|read)\b[^.?!]{0,40}\brecord\b/,
      /\bactually\s+(?:read|see|access|edit)\b[^.?!]{0,40}\brecord\b/,
      /\brecord[-\s]level\s+access\b/,
      /\blive_record_access\b/,
      // M40 — "who can access this/that/the record" is single-record effective
      // access (runtime UserRecordAccess), not the OBJECT-level who_can_access_object.
      /\bwho\s+can\s+access\s+(?:this|that|the)\s+record\b/,
    ],
  },
  {
    // R7-W6: the explicit sharing ROWS on ONE record ({Object}Share: Owner /
    // Manual / Rule / Team / Apex) — the complement to live-record-access
    // (a user's flags) enumerating WHO/WHY. Sits BEFORE sharing-model, whose
    // bare "how is X shared" pattern would otherwise swallow "how is this
    // record shared" — the "record" anchor here keeps the org-level OWD/
    // sharing-rule config question on sharing-model and the one-record
    // question here.
    intent: 'live-record-shares',
    plane: 'live',
    tools: ['sfi.live_record_shares'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'The explicit sharing rows on ONE record (Owner / Manual / Rule / Team / Apex-managed) are runtime {Object}Share state — live_record_shares enumerates them; the vault never holds record-level share rows.',
    patterns: [
      /\bwho\s+is\s+(?:this|that|the)\s+record\s+shared\s+with\b/,
      /\brecord\b[^.?!]{0,40}\bshared\s+with\b/,
      /\bhow\s+is\b[^.?!]{0,20}\brecord\b[^.?!]{0,20}\bshared\b/,
      /\b(?:sharing\s+rows?|share\s+rows?)\b[^.?!]{0,40}\brecord\b/,
      /\brecord\b[^.?!]{0,40}\b(?:sharing\s+rows?|share\s+rows?)\b/,
      /\bshares?\s+(?:exist|apply)\b[^.?!]{0,40}\brecord\b/,
      /\bexplicit\s+shares?\b[^.?!]{0,40}\brecord\b/,
      /\bmanually\s+shar\w*\b[^.?!]{0,40}\brecord\b/,
      /\bwho\s+(?:has\s+been\s+granted|was\s+granted)\s+access\s+to\s+(?:this|that|the)\s+record\b/,
      /\blive_record_shares\b/,
    ],
  },
  {
    // PLATFORM-ACCESS-ORACLE: the META question — "is our OWN offline
    // permission answer right?" — not "who can access X". Sits AFTER the two
    // record-level live rules (so "verify record-level access …" keeps
    // first-matching live-record-access) and BEFORE effective-permissions
    // (whose bare "effective access" pattern would otherwise swallow a parity
    // ask and answer it from the vault — the very answer under audit).
    //
    // Every pattern carries an anchor NO other intent owns: parity / oracle /
    // the literal UserEntityAccess, or a verify/cross-check verb explicitly
    // paired with our-side vocabulary (offline / vault / computed / our). It
    // deliberately does NOT match generic "who can access" or "what
    // permissions does X have" — those belong to the specialists whose output
    // this tool audits.
    intent: 'platform-access-oracle',
    plane: 'live',
    tools: ['sfi.live_access_oracle'],
    liveRequired: true,
    needsResolve: false,
    reason:
      "Whether the OFFLINE permission engine is actually right is a parity question, not an access question: live_access_oracle asks Salesforce for its own UserEntityAccess verdict on the same user and objects and reports where the two disagree. It never replaces effective_permissions — it audits it.",
    patterns: [
      /\blive_access_oracle\b/,
      /\buserentityaccess\b/,
      /\b(?:access|permission)\s+parity\b/,
      /\bparity\s+(?:check|oracle)\b/,
      /\baccess\s+oracle\b/,
      // "verify / prove / cross-check OUR (offline|vault|computed) permission
      // answer" — the verb alone is far too generic, so an our-side noun is
      // required in the same clause.
      /\b(?:verify|prove|cross[-\s]check|double[-\s]check)\b[^.?!]{0,60}\b(?:offline|vault|computed|our)\b[^.?!]{0,60}\b(?:permission|access)\w*\b/,
      /\b(?:offline|vault|computed|our)\b[^.?!]{0,40}\b(?:permission|access)\w*\b[^.?!]{0,60}\b(?:verify|prove|cross[-\s]check|double[-\s]check)\b/,
      // "am I overstating / are we understating this user's access"
      /\b(?:overstat|understat)\w*\b[^.?!]{0,40}\baccess\b/,
      // "where does our access model disagree with the live org"
      /\baccess\s+model\b[^.?!]{0,40}\b(?:disagree|differ|contradict)\w*\b/,
    ],
  },
  {
    intent: 'effective-permissions',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.effective_permissions'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "A user's EFFECTIVE access: the union of a profile + assigned permission sets (max-wins), from the vault (effective_permissions).",
    patterns: [
      /\beffective\s+(permissions?|access)\b/,
      /\b(combined|union|total|net)\b.*\b(permissions?|access)\b.*\b(profile|permission\s+set|user)\b/,
      // "what permissions does the Sales User profile have" — a top
      // baseline-300 unrouted cluster (P14-ROUTER-goldset-expand).
      /\bwhat\s+permissions?\s+(does|do)\b.*\b(profiles?|permission\s+sets?|users?)\b/,
      // NOTE (ENGINE-ARC §4): the "permission sets assigned to a user"
      // phrasings moved to the user-permset-holdings arm ABOVE — a user's
      // actual assignments are runtime state (live_user_permsets); this vault
      // arm keeps the GRANTS direction only.
      // REACH (permissions/access cluster): "does/can the <Named> profile /
      // <Named> perm set have|give|grant|read|edit|create|delete|access|see|
      // change <object>". These name a SPECIFIC granter (a profile/permission
      // set) and ask what access it confers — the exact effective_permissions
      // ask, which no earlier rule caught (the existing templates required the
      // literal "effective/combined access" or the generic word "permissions").
      // Anchored on the interrogative verb `does|can` PLUS the granter noun
      // (profile|perm set) PLUS an access verb, all clause-bounded (`[^.?!]`) so
      // one sentence's verb can't reach across into the next. The `(?<!\bwhy\s)`
      // lookbehind keeps "why can't the X profile see the record" on
      // why-cant-see; "who can …" field asks (no does/can-led granter) stay on
      // field-access; enumerative "which permission sets grant …" stays on
      // object-access (no does/can lead). recordtype-availability and
      // profile-security sit EARLIER, so a record-type / session-security
      // phrasing still wins by first-match. The leading `^(?!.*\blayouts?\b)`
      // yields any "which layout does the X profile SEE" question to
      // layout-access (a later rule) — "layout" anywhere disqualifies this
      // permission route.
      /^(?!.*\blayouts?\b).*?(?<!\bwhy\s)\b(?:does|can)\b[^.?!]{0,60}\b(?:profile|perm\s*sets?|permission\s+sets?)\b[^.?!]{0,60}\b(?:have|give|gives?|grant|grants?|read|edit|create|delete|access|see|change)\b/,
      // "which perm sets are stacked on top of / assigned on top of the <Named>
      // profile" — a union-of-containers ask (what the stack effectively grants).
      /\bwhich\s+perm\s*sets?\b[^.?!]{0,40}\b(?:stacked|stack|on\s+top\s+of|added\s+to|layered)\b/,
      // "for <PermSetA>, <PermSetB>, <PermSetC> perm sets, what does each
      // contribute" — the division-of-access breakdown across a bundle.
      /\bperm\s*sets?\b[^.?!]{0,20},[^.?!]{0,80}\bwhat\s+does\s+each\s+(?:contribute|grant|add|allow)\b/,
    ],
  },
  {
    // P1b: "what CRUD / permissions / access does {profile|permission set}
    // allow / grant / have (on {object})" — verb templates the effective-
    // permissions and object-access tools already answer, but that no regex
    // routed. Sits AFTER effective-permissions (which keeps "what permissions
    // does X have" via first-match) and BEFORE object-access, so it only
    // catches the genuinely-unrouted allow/grant/have-on-object phrasings.
    intent: 'what-permissions-profile-has',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.effective_permissions', 'sfi.object_access_audit'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What CRUD / field permissions a profile or permission set has on an object — the union view (effective_permissions) plus the object CRUD matrix (object_access_audit).',
    patterns: [
      // Anchored on "what (crud|permissions|access)" and clause-bounded
      // (`[^.?!]`) so a sprawling compound question ("… we need to know what
      // Community_Login_Flow does … which profiles and permission sets grant
      // access to application templates …") is NOT stolen from field-access —
      // there "what" is followed by a component name, not a permission noun.
      /\bwhat\s+(crud\s+)?(crud|permissions?|access)\b[^.?!]{0,60}\b(profiles?|permission\s+sets?)\b[^.?!]{0,40}\bhave\b[^.?!]{0,20}\bon\b[^.?!]{0,20}\b(objects?|records?)\b/,
      /\bwhat\s+(crud\s+)?(crud|permissions?|access)\b[^.?!]{0,60}\b(profiles?|permission\s+sets?)\b[^.?!]{0,40}\b(allow|grant|have)\b/,
    ],
  },
  {
    intent: 'object-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.object_access_audit'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Who can create / read / edit / delete an OBJECT (object-level CRUD + View/Modify All), modeled from the vault (object_access_audit).',
    patterns: [
      // "create" / "delete" are OBJECT-level (fields have FLS read/edit only), so
      // a create-bearing multi-verb question is object CRUD, not field-access.
      /\bwho\s+can\b.*\bcreate\b.*\b(read|edit|delete|view)\b/,
      /\b(object\s+(access|permission|crud)|crud\s+(matrix|audit))\b/,
      /\bwho\s+can\s+(create|read|edit|delete)\b.*\brecords?\s+(of|in|for)\b/,
      // SINGLE-verb create/delete asks are object-level too — "who can create
      // an Account record?" was unrouted (gallery miss, P14-ROUTER-object-
      // create-access). Past tense ("who deleted …") has a word boundary
      // mismatch so audit-trail phrasings stay untouched; edit/read/view
      // single-verb RECORD asks keep who-can-access-object (later rule, but
      // these patterns require create|insert|delete so they never fire there).
      /\bwho\s+(can|is\s+able\s+to)\s+(create|insert|delete)\b/,
      /\b(which|what)\s+(profiles?|permission\s+sets?|users?)\b.*\bcan\s+(create|insert|delete)\b/,
      /\b(which|what)\s+(profiles?|permission\s+sets?)\b.*\b(grant|allow)\b.*\b(create|delete)\b/,
      /\b(which|what)\s+permission\s+sets?\b.*\bgrant\b.*\b(access|object)\b/,
      /\bpermission\s+sets?\b.*\bgrant\b.*\bobject\s+access\b/,
      /\b(which|what)\s+(profiles?|permission\s+sets?)\b.*\b(modify\s+all|view\s+all)\b/,
      /\b(which|what)\s+(profiles?|permission\s+sets?)\b.*\bgrant\b.*\b(modify\s+all|view\s+all)\b/,
    ],
  },
  {
    // ACTION-CHAIN: `sfi.action_chain` is STACKED LAST here (the 99fdbf29
    // pattern), never as a new rule and never as the primary. This intent's own
    // patterns already match `converted` / `approved` / `on <Entity>
    // conversion`, and `lifecycle_process`'s own disclosure says those distinct
    // record ACTIONS are OUTSIDE its insert/update view — so the specialist
    // answers the save-time slice and the chain tool completes it. A separate
    // early rule would have STOLEN these phrasings from the grounded specialist;
    // stacking cannot, because the primary is unchanged.
    intent: 'lifecycle-process',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.lifecycle_process', 'sfi.action_chain'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What happens when {Object}.{field} becomes {value} — the automation coupled to a value/stage transition, from the vault (lifecycle_process). For the distinct record ACTIONS lifecycle_process excludes (Lead convert, approval submission), action_chain composes the documented action sequence.',
    patterns: [
      /\bwhat\s+happens\s+when\b.*\b(becomes?|turns?|changes?\s+to|is\s+set\s+to|reaches?)\b/,
      // Up to three optional adverb words between the verb and "when" — "what
      // runs AUTOMATICALLY when a Lead is converted" / "what fires IN THE
      // BACKGROUND when …" were unrouted (eval lifecycle family). The DML-event
      // save-order rule stays disjoint: its verb list has no transition verbs
      // (converted / closed won / approved), so nothing is stolen either way.
      /\bwhat\s+(?:happens|runs|fires)\b(?:\s+\w+){0,3}\s+when\b.*\b(closed\s+won|closed\s+lost|converted|approved|activated)\b/,
      // Nominalized transition — "what runs ON Lead CONVERSION?" / "what fires
      // upon Case escalation to closed" has no "when …is converted" clause at
      // all; the nominal "on/upon <Entity> conversion" form routes the same.
      /\bwhat\s+(?:happens|runs|fires|occurs|triggers)\b[^.?!]{0,40}\b(?:on|upon|during|after)\s+(?:an?\s+|the\s+)?\w+\s+conversion\b/,
      // P1e — generic state-transition verbs beyond the Opportunity/Lead
      // hardcoded list: "submitted", "disqualified", "completed", "enrolled" are
      // common transitions on other objects (Applications, Enrollments,
      // Requests). Verb-symmetry ("happens|runs|fires|occurs|triggers") plus a
      // transition verb ("is/gets submitted", "transitions to", "reaches"), so
      // "what runs when an Enrollment is disqualified" now routes.
      /\bwhat\s+(?:happens|runs|fires|occurs|triggers)\s+when\b.*\b(?:transitions?\s+to|is\s+(?:submitted|disqualified|completed|enrolled|approved|activated|closed|converted)|gets?\s+(?:submitted|disqualified|completed|enrolled|approved|activated|closed|converted))\b/,
      /\b(value.?coupl\w*|coupled)\b.*\b(StageName|Closed Won|stage|transition)\b/,
      /\bStageName\b.*\b(Closed Won|closed won|transition)\b/,
      /\bClosed Won\b.*\b(automation|flow|trigger|coupl)\b/,
    ],
  },
  {
    // REVERSE of why-cant-see (single user, forward): WHO (profiles/permsets/
    // roles/groups) can see/edit an object's RECORDS. Anchored to "records" so it
    // wins over field-access (fields, no "records") but never steals a field
    // question (P12-ROUTER-disambiguation: forward vs reverse).
    intent: 'who-can-access-object',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.who_can_access_object', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "WHO (profiles / permission sets / roles / groups) can see or edit an object's RECORDS — the reverse of why_cant_user_see_record — composed from OWD, object grants, god-mode, and sharing-rule targets in the vault (who_can_access_object).",
    patterns: [
      /\bwho\s+(can|is\s+able\s+to|has\s+access)\b.*\b(see|access|view|edit|read)\b.*\brecords?\b/,
      /\bwho\s+can\s+(see|access|view|edit|read)\b.*\b(all|every)\b.*\brecords?\b/,
      /\b(which|what)\s+(profiles?|permission\s+sets?|roles?|groups?)\b.*\b(see|access|edit)\b.*\brecords?\b/,
      // Object-level access without the word "records" — must beat field-access.
      /\bwho\s+can\s+access\b(?!.*\bfield\b)/,
      // Enumerative SINGULAR phrasings — "list every profile with delete
      // permission on Contact", "show me every profile that can access Case".
      // The bare noun "profile" is an intent signal here, not a named entity;
      // these fell through to the generic schema list rule (eval family A).
      /\b(?:list|show)\b.*\bevery\s+profiles?\b.*\b(?:permission|access)/,
      /\bevery\s+profiles?\s+(?:that|who|with)\b.*\b(?:access|see|view|edit|read|delete|create)\b/,
      /\b(?:which|what)\s+profiles?\b.*\b(?:create|read|edit|delete|view)\s+permission\b/,
      // REACH (permissions/access cluster): "is <Object__c> visible / accessible
      // to the <Named> profile / perm set / role" — the forward object-record
      // access ask, which who_can_access_object answers (the agent reads whether
      // that container is among the granters). `__c`-anchored + "visible/…
      // to <container>" so it never grabs a layout ("is Account.Name visible on
      // the layout") or a schema ("is Payment__c an object") question.
      /\bis\b[^.?!]{0,20}\b\w+__c\b[^.?!]{0,20}\b(?:visible|accessible|available|readable|editable)\b[^.?!]{0,20}\bto\b[^.?!]{0,30}\b(?:profile|perm\s*sets?|permission\s+sets?|role|user)\b/,
    ],
  },
  {
    // R6-17: unauthenticated GUEST-user exposure across Experience Cloud / Site
    // communities. Anchored on the guest/community/unauthenticated vocabulary so
    // it does not steal a generic object-access ("who can access") question,
    // which who_can_access_object owns.
    intent: 'guest-exposure',
    plane: 'vault',
    tools: ['sfi.guest_exposure_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "What UNAUTHENTICATED guest users can see across the org's Experience Cloud / Site communities — each site's guest profile object CRUD, PII FLS, Apex, and guest sharing rules, ranked (guest_exposure_report).",
    patterns: [
      // Plural "guest users"/"guest profiles" matches too — a compound clause
      // ("…and can guest users see Cases too?") must route here so the compound
      // planner stacks guest_exposure_report alongside the layout tool rather
      // than silent-dropping the guest sub-intent (ROUTE-COMPOUND-DROPS-GUEST-
      // CLAUSE). `users?` keeps the singular behaviour byte-identical.
      /\bguest\s+(users?|profiles?|access|exposure)\b/,
      // Bare interrogative "can/could/do guest users see/access Cases" (no
      // leading "what") — the natural second-clause phrasing.
      /\b(can|could|do|does|will)\b[^.?!]{0,20}\bguest\s+users?\b[^.?!]{0,20}\b(see|access|read|view|reach|get)\b/,
      /\bwhat\s+can\s+(the\s+)?guest\s+users?\s+(see|access|read|do)\b/,
      /\bunauthenticated\b.*\b(access|user|audit|expos)/,
      /\b(experience\s+cloud|community|communities|portal|public\s+site)\b.*\b(leak|expos|guest|secur)/,
      /\b(leak|expos|secur)\w*\b.*\b(experience\s+cloud|community|communities|guest)\b/,
    ],
  },
  {
    intent: 'why-cant-see',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.why_cant_user_see_record', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Walks the sharing cascade (OWD → permission → role hierarchy → sharing rules) from the vault.',
    patterns: [
      /\bwhy\s+(can'?t|cannot|can\s+not)\b.*\b(see|view|access)\b.*\b(record|account|case|contact|lead|opportunity)\b/,
      /\bcan'?t\s+(see|view|access)\b.*\b(record|account|case|opportunity|contact|lead)\b/,
      /\bwhy\s+(can'?t|cannot|can\s+not)\b.*\b(see|view|access)\b.*\b(an?\s+)?(account|case|contact|lead|opportunity)\b/,
      // REACH (permissions/access cluster): the existing templates used a
      // SINGULAR `\brecord\b` and only see/view/access, so a plural "records"
      // ask ("why can't the Manager ROLE see Enrollment RECORDS", "why can't a
      // user EDIT Order__c RECORDS") fell through. Add plural
      // `records?` + the `edit|read` verbs — this is still the record-sharing
      // cascade (OWD → sharing → role hierarchy), the honest tool for a
      // "why can't X see/edit these RECORDS" question. The literal "records"
      // keeps it OFF field-access (a named FIELD, no "records").
      /\bwhy\s+(?:can'?t|won'?t|cannot|can\s+not)\b[^.?!]{0,60}\b(?:see|view|access|edit|read)\b[^.?!]{0,60}\brecords?\b/,
      // Negative-contrast visibility — "why can a <user> see A records BUT NOT
      // B" — the same sharing-cascade question phrased as a see-one-not-the-other
      // puzzle. The "but not" tail distinguishes it from a plain who-can-see.
      /\bwhy\s+can\b[^.?!]{0,60}\b(?:see|view|access)\b[^.?!]{0,60}\brecords?\b[^.?!]{0,40}\bbut\s+not\b/,
    ],
  },
  {
    // P12-ROUTER-layout-assignments: the REVERSE of layout-access. "What is this
    // layout assigned to" / "which profiles use the Account Layout" start FROM a
    // page Layout and ask which (Profile × RecordType) assignments target it —
    // the `sfi.layout_assignments` tool, not the forward `layout_for_user`. Must
    // sit BEFORE layout-access so the reverse phrasing wins (first-match wins);
    // forward "which layout does USER see" has no "assigned to"/"profiles use".
    intent: 'layout-assignments',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.layout_assignments'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Reverse layout assignment (which profiles / record types are assigned a given page Layout) is modeled in the vault layoutAssignments surface.',
    patterns: [
      // "what is this layout assigned to", "what is the Account Layout assigned to"
      /\blayouts?\b.*\bassigned\s+to\b/,
      /\bassigned\s+to\b.*\blayouts?\b/,
      // "layout assignments [for X]" as a reverse-enumeration noun phrase
      /\blayouts?\s+assignments?\b/,
      // "which profiles use|have|are assigned [the] X layout"
      /\bwhich\s+profiles?\b.*\b(use|using|have|assigned)\b.*\blayouts?\b/,
      // "who uses|is assigned [the] X layout"
      /\bwho\b.*\b(uses?|is\s+assigned|are\s+assigned)\b.*\blayouts?\b/,
      // Record-type ↔ layout reverse lookups (baseline-300 gap).
      /\brecord\s+types?\b.*\buses?\b.*\blayout/,
      /\bpage\s+layout\b.*\bassociated\b.*\brecord\s+type/,
      /\bwhich\s+record\s+types?\b.*\blayout/,
    ],
  },
  {
    intent: 'layout-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.layout_for_user', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Page-layout routing (profile → record type → layout) is modeled in the vault.',
    suggestArgs: deriveLayoutForUserArgs,
    patterns: [
      /\b(page\s+)?layouts?\b.*\b(who|access|assigned|profile|sees?|user)\b/,
      /\bwho\s+(sees|has|can)\b.*\blayouts?\b/,
      /\bwhich\s+layout\b/,
      // "what/which (page) layouts show|contain|have a FIELD" — a field->layout
      // question (vs the who-sees-layout above) used to fall through (B21).
      /\b(what|which)\s+(page\s+)?layouts?\b.*\b(show|contain|display|include|have|with|for)\b.*\bfield\b/,
    ],
  },
  {
    // Fields present in schema but absent from every page layout — crosswalk,
    // not a fuzzy resolve of the whole question (edge-171).
    intent: 'field-layout-coverage',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Fields that exist in schema but are not placed on any page layout are a vault crosswalk (CustomField inventory vs Layout field placements).',
    suggestArgs: () => ({ type: 'CustomField' }),
    patterns: [
      /\bfields?\b.*\b(not\s+(placed|on)|without being on)\b.*\blayout\b/,
      /\b(not\s+placed|unplaced|hidden)\b.*\blayout\b/,
      /\bfields?\b.*\bexist\b.*\b(not\s+on|no)\b.*\blayout\b/,
    ],
  },
  {
    // Layout INVENTORY + CONTENTS (vs layout-access's who-sees-which). "How many
    // layouts exist for X", "what fields / related lists / quick actions are on
    // the Y layout" used to fall through to generic schema or unrouted (B21.1).
    intent: 'layout-inventory',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Page-layout inventory (how many / which layouts on an object) and contents (fields, related lists, quick actions on a named layout) are modeled in the vault — Layout is a covered type.',
    suggestArgs: (q, question) => {
      if (/\bcompact[-\s]layouts?\b/.test(q)) {
        const objectApi = deriveObjectApiFromQuestion(q, question);
        if (objectApi !== undefined) {
          return { type: 'CompactLayout', parentId: `CustomObject:${objectApi}` };
        }
        return { type: 'CompactLayout' };
      }
      if (/\bhow\s+many\b.*\blayouts?\b/.test(q)) {
        const objectApi = deriveObjectApiFromQuestion(q, question);
        if (objectApi !== undefined) {
          return { type: 'Layout', parentId: `CustomObject:${objectApi}` };
        }
      }
      return deriveMetadataCountArgs(q, question);
    },
    patterns: [
      /\bhow\s+many\b.*\blayouts?\b/,
      /\b(what|which|list)\b.*\b(page\s+)?layouts?\b.*\b(exist|are\s+there|for\s+the|on\s+the|does|available)\b/,
      /\bwhat\b.*\b(fields?|related\s+lists?|quick\s+actions?|sections?|buttons?)\b.*\bon\b.*\blayout\b/,
      /\b(related\s+lists?|quick\s+actions?)\b.*\b(on|appear|for)\b.*\blayout\b/,
      // "Is Account.Name in any page layouts?" — field-on-layout inventory (B21).
      /\b(in\s+any|on\s+any)\b.*\b(page\s+)?layouts?\b/,
      /\bis\b.*\bin\s+any\b.*\blayouts?\b/,
      /\b(what|which)\s+quick\s+actions?\b.*\b(on|for|defined)\b/,
      /\bcompact[-\s]layouts?\b/,
      /\bcompact[-\s]layout\b.*\b(vs|versus|highlights?|full)\b/,
      /\bhighlights?\b.*\b(vs|versus|full)\b.*\blayout\b/,
    ],
  },
  {
    // COMPONENT-TYPE CONFUSION (router-v2 R2, type-confusion trap family):
    // "is <Name> a flow or a trigger?", "is that an Apex class or a flow?",
    // "the name has 'Trigger' in it but is it actually a test class?", "what
    // type is that?". The user is unsure WHAT KIND of component a name is —
    // resolve answers the type question, and the two explainers cover
    // whichever family it lands on (the stage-5 type guard swaps the
    // incompatible one once the entity resolves). MUST precede
    // automation-on-object, whose "triggers … on <object>" pattern otherwise
    // steals "…an actual trigger on Contact?".
    intent: 'component-type',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_flow', 'sfi.explain_apex_method'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'The question asks WHICH KIND of component a name is (flow vs trigger vs Apex class vs test class). Resolve the name to its actual type first; then explain it with the family-appropriate tool — the resolver output, not the name, decides which.',
    patterns: [
      // Two component-family nouns joined by "or" inside one clause:
      // "is <name>/that/it (actually) a flow … or (an actual) trigger".
      /\bis\s+(?:that|this|it|[a-z0-9_]+)\s+(?:actually\s+)?(?:an?\s+)?(?:apex(?:\s+(?:class|test\s+class|logging))?|flow|trigger|test\s+class)\b[^.?!]{0,40}\bor\s+(?:an?\s+)?(?:actual(?:ly)?\s+a?\s*)?(?:apex(?:\s+class)?|flow|trigger|test\s+class|something\s+else)/,
      // Name-vs-nature: "…but is it actually a test class?"
      /\bbut\s+is\s+(?:it|that)\s+(?:actually\s+)?an?\s+(?:test\s+class|trigger|flow|apex\s+class)\b/,
      // "what type is that / what type of component is <name>" — `that/this`
      // only (not `it`), and never when the question names a __c FIELD:
      // "what type is it?" about CON_...__c asks the field's DATA type, not
      // the component family (the cov3-029 negative).
      /^(?!.*__c\b)(?=[\s\S]*\bwhat\s+type\s+(?:is\s+(?:that|this)|of\s+component\s+is)\b)/,
    ],
  },
  {
    intent: 'field-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_access_audit', 'sfi.get_edges'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Field-level access (who reads/edits) is modeled from PermissionSet/Profile XML.',
    patterns: [
      /\bwho\s+can\s+(see|read|view|edit|access)\b.*\b(field|object|record)\b/,
      /\bwho\s+can\s+(see|read|view|edit|access)\b\s+[\w\s.]+[?.!]?$/,
      /\b(access|permission|fls|field[-\s]level\s+security)\b.*\b(field|object)\b/,
      /\bwho\s+has\s+access\s+to\b/,
      // "allow|read|view" added: "which permission sets allow read on X" was a
      // router gap (the verbs grant/access/see/edit didn't cover it).
      /\bwhich\s+(profiles?|permission\s+sets?)\b.*\b(grant|allow|access|see|read|view|edit)\b/,
      // "field access audit for Email" / "field access for X" — "field access"
      // with the field named after (the (field|object)-after-access patterns
      // missed it). Battery gap.
      /\bfield[-\s]access\b/,
      // Eval family C — qualifier hijack. "which fields are only ever written
      // BY an integration user" is a field WRITE-access audit (who can edit),
      // not integration topology: the "integration" qualifier was dragging it
      // onto integration_map.
      /\b(?:which|what)\s+fields?\b[^.?!]{0,80}\b(?:written|edited|updated|writable)\b[^.?!]{0,40}\bby\b/,
      // "compliance report … who touches the <X> field" — who-touches-a-field
      // is FLS edit access, not report run-history (the "report" qualifier was
      // dragging it onto reports-usage).
      /\bwho\s+touch(?:es)?\b[^.?!]{0,60}\b(?:fields?\b|__c\b)/,
      // REACH (permissions/access cluster) — FLS on a NAMED field:
      // (a) "who [adverb] can see/read/view/edit/access <Field__c or
      //     Object.field>" — the existing who-can-see template broke on an
      //     adverb ("who can ACTUALLY see Some_Field__c"). Field-anchored
      //     (dotted or `__c`) and clause-guarded against "records" so a
      //     who-can-see-RECORDS ask stays on who-can-access-object.
      /\bwho\s+can\b(?![^.?!]*\brecords?\b)[^.?!]{0,25}\b(?:see|read|view|edit|access)\b[^.?!]{0,40}(?:\b\w+\.\w+\b|\b\w+__c\b)/,
      // (b) "can/does <someone> edit/see <Object.field>" — FLS on a DOTTED
      //     field ref ("Can Analytics edit Opportunity.Amount"). Restricted to a
      //     dotted ref (or a bare `__c` accompanied by the word "field") so a
      //     bare `__c` OBJECT ("can a user see Payment__c?") is NOT mistaken for
      //     a field; the `(?<!\bwhy\s)` and no-"records" guards keep why-cant /
      //     record asks off this rule, and effective-permissions (earlier) still
      //     wins any granter-worded "does the X profile …" phrasing.
      /(?<!\bwhy\s)\b(?:can|does)\b(?![^.?!]*\brecords?\b)[^.?!]{0,40}\b(?:see|read|view|edit|access)\b[^.?!]{0,30}(?:\b\w+\.\w+\b|\b\w+__c\b[^.?!]{0,25}\bfields?\b|\bfields?\b[^.?!]{0,25}\b\w+__c\b)/,
      // (c) "why can't <someone> edit/see <Object.field or Field__c>" — an FLS
      //     gap on a named FIELD (no "records"), which why_cant_user_see_record
      //     (record sharing) does not answer; field_access_audit shows who holds
      //     read/edit on the field. The no-"records" guard routes the RECORD
      //     variant ("why can't X see <Object> records") to why-cant-see instead.
      //     "access" is deliberately EXCLUDED from the verb list here — the noun
      //     phrase "<managed-package> access" (in a "why can't they run the
      //     managed-package action" question) would otherwise be misread as an
      //     FLS verb.
      /\bwhy\s+can'?t\b(?![^.?!]*\brecords?\b)[^.?!]{0,40}\b(?:see|read|view|edit)\b[^.?!]{0,40}(?:\b\w+\.\w+\b|\b\w+__c\b)/,
    ],
  },
  {
    intent: 'crud-fls-audit',
    plane: 'vault',
    tools: ['sfi.crud_fls_audit'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Org-wide CRUD + field-level-security audit from permission metadata.',
    patterns: [
      /\b(crud|fls)\b.*\baudit\b/,
      /\bobject\s+permissions?\b/,
      /\b(read|create|edit|delete)\s+permissions?\b.*\b(all|every|across)\b/,
      /\bcrud_fls_audit\b/,
      /\bfield[-\s]level\s+security\b.*\b(managed|across|sensitive)/,
      /\b(apex|classes?)\b.*\b(enforce|enforces|CRUD|FLS|SECURITY_ENFORCED|stripInaccessible)\b/,
      /\bdoes\b.*\bapex\b.*\b(enforce|CRUD|FLS)\b/,
    ],
  },
  {
    // Deactivate-a-permission-set what-if (RESIDUAL 2). There is NO dedicated
    // what_if_* simulator for permission sets in the vault tier, so this is an
    // HONEST route to permission_risk_report (+ its impact edges via get_impact
    // once the set is resolved): the report surfaces what access the set grants
    // and who depends on it — the closest truthful answer to "does anything
    // break if we deactivate it". needsResolve so the named permission set is
    // resolved first. Sits before over-permission so a deactivation ask beats
    // the generic god-mode phrasing; requires the deactivate/turn-off verb + a
    // permission-set noun, so it never steals a plain over-privilege question.
    intent: 'permission-set-deactivation-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.permission_risk_report', 'sfi.get_impact'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'No what_if simulator exists for permission sets, so this routes honestly to permission_risk_report (what the set grants + who depends on it) with get_impact for the dependency surface — the truthful stand-in for a deactivation blast radius, not a fabricated simulation.',
    patterns: [
      /\b(?:deactivat\w+|disabl\w+|turn(?:ed|ing)?\s+off|remov\w+|delet\w+)\b[^.?!]{0,60}\bpermission\s+sets?\b/,
      /\bpermission\s+sets?\b[^.?!]{0,60}\b(?:is|are|was|were|gets?|being)\s+(?:deactivated|disabled|turned\s+off|removed|deleted)\b/,
    ],
  },
  {
    intent: 'over-permission',
    plane: 'vault',
    tools: ['sfi.permission_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'God-mode / over-permission detection is a vault permission synthesis.',
    patterns: [
      /\b(over[-\s]?(permission(ed|s)?|privilege[ds]?)|god[-\s]?mode|too\s+much\s+access|modify\s+all|view\s+all)\b/,
      /\bhow\s+many\b.*\busers?\b.*\b(modify\s+all|view\s+all)\b/,
      /\bwho\s+is\s+(an?\s+)?admin\b/,
      /\b(permission|access)\s+(risk|sprawl|hygiene)\b/,
      // Specific high-risk system permissions — "who can author apex / customize
      // the application / manage users / modify metadata / view setup" — all
      // answered by the permission_risk_report over-privilege pass.
      /\bwho\s+(can|has)\b.*\b(author\s+apex|customi[sz]e\s+(the\s+)?application|manage\s+(users|sharing|roles|profiles)|modify\s+metadata|view\s+setup)\b/,
      /\bpermission_risk_report\b/,
      // Admin-level / least-privilege / security-gap phrasings (baseline-300).
      /\b(which|what)\s+users?\b.*\badmin\b/,
      /\busers?\b.*\badmin[-\s]level\b/,
      // "do we have too many admins" (router-v2 P4).
      /\btoo\s+many\s+admins?\b/,
      /\bleast\s+privilege\b/,
      /\bsecurity\s+gaps?\b.*\b(profile|permission)/,
      /\bpermission\s+sets?\b.*\binstead\s+of\b.*\bprofiles?\b/,
    ],
  },
  {
    // ORG-WIDE trusted IP ranges (`<networkAccess><ipRanges>`), placed BEFORE
    // `profile-security` because that rule's broad `\bip ranges?\b` pattern
    // otherwise claims the org-level reading too. The vocabulary here is
    // org-EXCLUSIVE: "Trusted IP Ranges" is the org network-access list, while a
    // profile's control is labelled "Login IP Ranges" — so this steals nothing
    // from the profile phrasings ("IP relaxation", "login IP", "profiles ...").
    intent: 'org-trusted-ip-security',
    plane: 'vault',
    tools: ['sfi.security_settings'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Org-wide trusted IP ranges are declared in settings/Security.settings-meta.xml <networkAccess>, not on any profile — security_settings reads them (per-profile login IP ranges remain profile_security).',
    patterns: [
      /^(?!.*\bprofiles?\b).*\btrusted\s+ip\s+(?:ranges?|addresses?|list)\b/,
      /\bip\s+(?:ranges?|addresses?)\b[^.?!]{0,30}\bfor\s+the\s+(?:whole\s+|entire\s+)?org(?:ani[sz]ation)?\b/,
      /\borgs?[-\s]?wide\s+ip\s+(?:ranges?|addresses?|restrictions?)\b/,
    ],
  },
  {
    // Profile login/session security — IP ranges ("IP relaxation"), login
    // hours, session settings (sfi.profile_security). Eval family C: the
    // "integration users" qualifier in "do any profiles have IP relaxation
    // that would block integration users" dragged this onto integration_map;
    // the head noun is the PROFILE security posture. Enumerative asks list
    // Profiles then drill per profile (profile_security requires a profileId).
    intent: 'profile-security',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.profile_security'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "Profile login/session security (login IP ranges — 'IP relaxation' — login hours, org session settings) is declared Profile metadata: list_components(type Profile) enumerates, then profile_security per profile reads the posture.",
    suggestArgs: () => ({ type: 'Profile' }),
    patterns: [
      /\bip\s+(?:relaxation|relaxed|ranges?|restrictions?|whitelists?|allowlists?)\b/,
      /\blogin\s+(?:ip|hours?)\b/,
      /\bprofiles?\b[^.?!]{0,50}\b(?:session\s+(?:timeout|settings?)|login\s+restrictions?)\b/,
      // REACH (permissions/access cluster): MFA / password-policy / session
      // security compared ACROSS profiles ("which profiles have MFA or session
      // security settings weaker than the rest", "what password policies and
      // session timeout are set per profile"). Both word orders (profile→setting
      // and setting→profile). These are Profile login/session posture — the
      // profile_security surface — which the IP/login-hours templates above did
      // not cover. The `\bprofiles?\b` co-anchor keeps a generic "what is MFA"
      // knowledge question on guidance.
      /\bprofiles?\b[^.?!]{0,60}\b(?:mfa|multi[-\s]?factor|password\s+polic\w*|session\s+(?:security|timeout|settings?))\b/,
      /\b(?:mfa|multi[-\s]?factor|password\s+polic\w*|session\s+(?:security|timeout|settings?))\b[^.?!]{0,60}\bprofiles?\b/,
    ],
  },
  {
    // ORG-WIDE security settings (sfi.security_settings). Deliberately placed
    // AFTER `profile-security`: any question that names a PROFILE is claimed
    // there first (first match in array order wins), so this rule only sees the
    // org-level reading. Before 0.3.1 there was no tool to route to — the file
    // was on disk and unparsed — and "what is my org password policy and
    // session timeout?" fell through to `unrouted`.
    intent: 'org-security-settings',
    plane: 'vault',
    tools: ['sfi.security_settings'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Org-wide password policy, session timeout, trusted IP ranges, clickjack/CSRF and the org security toggles are declared metadata in settings/Security.settings-meta.xml — security_settings reads both org-level singletons and enumerates what it cannot see.',
    patterns: [
      // Org-anchored, either word order.
      /\b(?:org|orgs?[-\s]?wide|company|organi[sz]ations?)\b[^.?!]{0,40}\b(?:security\s+settings?|password\s+polic\w*|session\s+(?:timeout|settings?))\b/,
      /\b(?:security\s+settings?|password\s+polic\w*|session\s+(?:timeout|settings?))\b[^.?!]{0,40}\b(?:org|orgs?[-\s]?wide|company|organi[sz]ations?)\b/,
      // Vocabulary that only exists at org level — no profile reading competes.
      /^(?!.*\bprofiles?\b).*\btrusted\s+ip\s+(?:ranges?|addresses?|list)\b/,
      /\bclickjack\w*/,
      /\bredirect\s+block\w*/,
      /\b(?:require|requires|requiring)\s+https\b/,
      /\blog\s*in\s+as\s+any\s+user\b/,
      /^(?!.*\bprofiles?\b).*\bmin(?:imum)?\s+password\s+length\b/,
      /^(?!.*\bprofiles?\b).*\bpassword\s+(?:expir\w+|complexity|history)\b/,
      /^(?!.*\bprofiles?\b).*\bmax(?:imum)?\s+(?:failed\s+)?login\s+attempts?\b/,
      /^(?!.*\bprofiles?\b).*\blockout\s+interval\b/,
      /\bsessions?\s+times?\s+out\b/,
      /\bsecurity_settings\b/,
    ],
  },
  {
    // EARLY PRECISION RULE (P14-ROUTER-safe-delete-misroute): a long
    // compound delete-verdict question enumerates nouns ("every layout,
    // validation rule, flow, formula field, and permission set…") and the
    // first broad noun rule in array order was winning — unassigned-permsets,
    // then explain-validation-rule, then flow-search, depending on which
    // pattern got bounded. The phrases below are unambiguous PRODUCT
    // vocabulary ("safe-to-delete verdict", "would block deletion", "before
    // deleting"), so they outrank every noun enumeration. Ordinary "can I
    // delete X" phrasings keep their existing precedence via the later
    // safe-to-delete rule (same intent + tools).
    intent: 'safe-to-delete',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Whether a specific field is safe to delete — coverage-aware dependency check.',
    patterns: [
      /\bsafe(?:[\s_-]+to[\s_-]+delete|_to_delete_field)\b/,
      /\b(block|prevent)\w*\b[^.?!]{0,30}\bdeletion\b/,
      /\bbefore\s+deleting\b/,
      // "can I SAFELY delete X, Y, Z or are they referenced somewhere" — the
      // adverb "safely" sits between "can i" and "delete", so the later
      // `can\s+i\s+delete` pattern misses it. The safe/safely + delete/remove
      // frame is the honest safe_to_delete_field ask (FIELD-FORENSICS REACH).
      /\bcan\s+i\s+safely\s+(delete|remove)\b/,
      /\bsafely\s+(delete|remove)\b[^.?!]{0,80}\breferenced\b/,
    ],
  },
  {
    intent: 'unassigned-permsets',
    plane: 'vault',
    tools: ['sfi.unassigned_permission_sets'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Permission sets with no assignments — cleanup candidates from the vault.',
    patterns: [
      // Clause-bounded: an unbounded gap matched "…is UNUSED legacy text …
      // every … PERMISSION SET that still references…" across two sentences
      // and stole a safe-to-delete-field question onto this cleanup intent
      // (P14-ROUTER-safe-delete-misroute; same overreach class as the
      // community-security compound fix).
      // Negative lookahead `(?!\s+groups?)` excludes "permission set GROUPS":
      // "which permission set groups are assigned to nobody?" was confidently
      // WRONG here — unassigned_permission_sets covers PermissionSet only, not
      // PermissionSetGroup (P0b). The dedicated unassigned-permset-groups gap
      // rule below catches that phrasing honestly.
      /\b(unassigned|unused|orphan)\b[^.?!]{0,40}\bpermission\s+sets?\b(?!\s+groups?)\b/,
      /\bpermission\s+sets?\b(?!\s+groups?)\b[^.?!]{0,40}\b(no\s+one|nobody|unassigned|unused)\b/,
      /\bunassigned_permission_sets\b/,
    ],
  },
  {
    // PARTIAL FLIP (ENGINE-ARC §4, was HONEST GAP P0b): PermissionSetGroup
    // ASSIGNMENT is now answerable live per group — sfi.live_permset_holders
    // (kind:'permissionSetGroup') returns the true holder count and roster for
    // a NAMED PSG, so "is PSG X assigned to nobody" is a live zero-holder
    // check. What is still unbuilt is an enumerate-ALL mode (vault PSG list
    // minus a live GROUP BY PermissionSetGroupId sweep in one call) — the gap
    // note is DOWNGRADED to that partial until Deferred-2 ships. Must sit
    // AFTER unassigned-permsets: the lookahead above already refuses
    // "permission set groups", so this rule catches it on the fall-through.
    intent: 'unassigned-permset-groups',
    plane: 'live',
    tools: ['sfi.live_permset_holders'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Whether a permission set group is assigned to anyone is runtime PermissionSetAssignment state: live_permset_holders (kind: permissionSetGroup) returns the true holder count per named PSG.',
    gap: {
      category: 'unassigned-permset-groups',
      note: 'Partial: live_permset_holders checks ONE named permission set group at a time (a zero effectiveTotal = unassigned). A single-call sweep of ALL PSGs is not built yet — enumerate the vault PSG list first, then check candidates live. Do not substitute unassigned_permission_sets, which covers PermissionSet only.',
    },
    suggestArgs: () => ({ kind: 'permissionSetGroup' }),
    patterns: [
      /\b(unassigned|unused|empty)\b[^.?!]{0,40}\bpermission\s+set\s+groups?\b/,
      /\bpermission\s+set\s+groups?\b[^.?!]{0,40}\b(no\s+one|nobody|unassigned|unused|assigned\s+to\s+nobody)\b/,
    ],
  },
  {
    // FULL FLIP (ENGINE-ARC §4, was HONEST GAP eval family D): "which USERS
    // have permission set X" is a holder ROSTER — PermissionSetAssignment is
    // runtime assignment data the vault does not model, and it is now answered
    // LIVE by sfi.live_permset_holders (kinds permissionSet | permissionSetGroup
    // | profile | auto; PSG-trap-aware: direct holders vs via-group holders,
    // deduped effectiveTotal). The gap block is DELETED. The
    // do-not-substitute warning stays in `reason`: effective_permissions /
    // object_access_audit describe what a permission set GRANTS, not who HOLDS
    // it. The reverse direction ("what permission sets does user X have") is
    // the user-permset-holdings arm (live_user_permsets).
    intent: 'permset-user-roster',
    plane: 'live',
    tools: ['sfi.live_permset_holders'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'Which users hold a permission set is runtime PermissionSetAssignment state: live_permset_holders lists the roster live, including holders via permission set groups. Do not substitute effective_permissions or object_access_audit — they describe what a permission set GRANTS, not who holds it.',
    patterns: [
      // "perm set(s)" / "permset(s)" ride along with the full "permission
      // set(s)" spelling — q1213 ("who has the View_Fraud_Score_Component
      // perm set", the design doc's grounding miss) uses the abbreviation,
      // and the user-permset-holdings arm above already accepts it.
      /\b(which|what|list)\s+users?\b[^.?!]{0,40}\b(have|hold|with|assigned)\b[^.?!]{0,40}\b(?:permission\s+sets?|perm\s+sets?|permsets?)\b/,
      /\bwho\s+(has|holds|is\s+assigned)\b[^.?!]{0,50}\b(?:permission\s+sets?|perm\s+sets?|permsets?)\b/,
      /\b(everyone|everybody|all\s+users?)\b[^.?!]{0,30}\bwith\b[^.?!]{0,40}\b(?:permission\s+sets?|perm\s+sets?|permsets?)\b/,
      /\busers?\b[^.?!]{0,30}\bassigned\b[^.?!]{0,30}\b(?:permission\s+sets?|perm\s+sets?|permsets?)\b/,
    ],
  },
  {
    // PARTIAL FLIP (ENGINE-ARC §4, was HONEST GAP round-2 q1948/q1559):
    // "which PSG grants the X custom permission / the Y role" is a
    // PermissionSetGroup COMPOSITION lookup. live_permset_holders now surfaces
    // PSG composition live via PermissionSetGroupComponent (probing a
    // permission SET reports which PSGs contain it), so the roster/containment
    // half is answerable. The 2-hop chain "which PSG grants custom permission
    // X" (custom permission → permission set → PSG, q1916) remains an honest
    // gap — the slimmed note below keeps it — and roles are not granted by
    // PSGs at all, so substituting object_access_audit / effective_permissions
    // would still be confidently wrong. Requires the GROUP noun: "which
    // permission SETS grant edit on X" (no `group`) stays on the real
    // field/effective-permissions routes.
    intent: 'permset-group-grants',
    plane: 'live',
    tools: ['sfi.live_permset_holders'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'PSG composition is runtime state: live_permset_holders reads PermissionSetGroupComponent live (probe the permission SET to see which PSGs contain it). Roles are never granted by PSGs.',
    gap: {
      category: 'permset-group-grants',
      note: 'Partial: live_permset_holders surfaces which PSGs CONTAIN a given permission set (PermissionSetGroupComponent). The 2-hop chain "which PSG grants custom permission X" (custom permission → permission set → PSG) is still unbuilt — resolve the custom permission to its granting permission sets in the vault first, then probe each set live. Do not substitute effective_permissions or object_access_audit for the PSG-composition step.',
    },
    patterns: [
      // Tempered verb→grants gap: "which permission set groups REFERENCE a
      // permission set that grants X" is a graph-edge read (answerable) — a
      // reference/contain/include verb between the PSG noun and `grants`
      // breaks the match, so only the PSG-as-grantor ask gaps. `not` breaks it
      // too: "why would a PSG NOT grant expected access" is a troubleshooting
      // ask that stays on its pre-round-2 route (sweep-parity pin).
      /\b(?:which|what)\s+(?:permission\s+set\s+groups?|psgs?)\b(?:(?!\b(?:references?|referencing|contains?|containing|includes?|including|not)\b)[^.?!]){0,60}\bgrants?\b/,
      /\b(?:permission\s+set\s+groups?|psgs?)\b(?:(?!\b(?:references?|referencing|contains?|containing|includes?|including|not)\b)[^.?!]){0,40}\bgrants?\b[^.?!]{0,60}\b(?:custom\s+permission|permission|role|access)\b/,
    ],
  },
  {
    intent: 'empty-queues-groups',
    // ENGINE-ARC §4: vault scan stays PRIMARY; sfi.live_group_members is
    // appended as the optional runtime-verification secondary (declared
    // metadata can drift from runtime GroupMember rows — the live tool
    // measures that drift per queue/group). Hybrid like unused-fields:
    // liveRequired stays false, the vault half answers alone.
    plane: 'hybrid',
    tools: ['sfi.empty_queues_and_groups', 'sfi.live_group_members'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Queues / public groups with no members — vault membership scan first; live_group_members optionally verifies a candidate against runtime GroupMember rows (declared metadata can drift).',
    patterns: [
      /\b(empty|unused)\b.*\b(queues?|groups?)\b/,
      /\b(queues?|public\s+groups?)\b.*\b(empty|no\s+members?|unused)\b/,
      /\b(which|what)\s+queues?\b.*\b(set\s+up|for|exist)\b/,
      /\bpublic\s+groups?\b.*\b(exist|who\s+is)\b/,
      /\bwhat\s+public\s+groups?\b/,
      // DISCOVERY/META REACH: routing-trap SYMPTOM questions. When work "isn't
      // getting picked up" / members "can't see cases routed to them", the
      // HONEST first check is whether the queue actually HAS members — exactly
      // what empty_queues_and_groups reports (memberCount / unknownMemberCount).
      // Every pattern REQUIRES the literal "queue(s)" AND a NEGATIVE/failure
      // frame (can't / not / isn't picked up / sitting in / exist-challenge),
      // so a neutral "which queues does X route to and who are the members"
      // stays a get_component ask (handled by the queue-membership rule below),
      // and a record-sharing ("why can't X see an Account") question — which
      // carries no "queue" — never lands here.
      // "why can (members of) <queue> NOT see … routed to them"
      new RegExp(
        `\\bqueues?\\b[^.?!]{0,80}\\b(?:can'?t|cannot|not\\s+(?:see|get|pick|able)|isn'?t|aren'?t)\\b`,
      ),
      // Queue named only by its `_Queue` API-name suffix (no standalone "queue"
      // word — underscore is a word char so `\bqueue\b` misses "ada_team_queue")
      // WITH a member/routing symptom. "why can members of <X>_Queue not see …
      // cases ROUTED to them" — the routing-trap membership check.
      // Failure-framed only ("NOT see", "can't", "isn't picked up") — a neutral
      // "which queues does <X>_Queue ROUTE to and who are the members" stays a
      // get_component ask (route/routed deliberately excluded here).
      /_queue\b[^.?!]{0,80}\b(?:not\s+(?:see|get|pick|able)|can'?t|cannot|isn'?t\s+(?:getting|picked))\b/,
      /\bmembers?\s+of\b[^.?!]{0,30}_queue\b[^.?!]{0,80}\b(?:not|can'?t|cannot)\b/,
      new RegExp(
        `\\b(?:can'?t|cannot|not\\s+(?:see|get|pick|able)|isn'?t|aren'?t)\\b[^.?!]{0,80}\\bqueues?\\b`,
      ),
      // "why is the Lead SITTING IN <queue> instead of getting PICKED UP —
      // queue members exist, right?" — the stuck-in-queue symptom.
      /\bsitting\s+in\b[^.?!]{0,40}\bqueues?\b/,
      /\bqueues?\b[^.?!]{0,40}\b(?:picked\s+up|getting\s+picked)\b/,
      /\bqueue\s+members?\b[^.?!]{0,30}\bexist\b/,
      // "why can't a user REASSIGN a Case to <Named>? They can touch every
      // other QUEUE" — reassignment-to-a-queue trouble; the membership /
      // queue-access check is the honest first probe. Requires a can't/cannot
      // failure frame co-occurring with "reassign" and "queue".
      new RegExp(
        `\\b(?:can'?t|cannot)\\b[^.?!]{0,40}\\breassign\\w*\\b.*\\bqueues?\\b`,
      ),
    ],
  },
  {
    // P1d — the role hierarchy STRUCTURE ("which roles report up to X") was
    // unrouted: sharing-model only anchored to the literal phrase "role
    // hierarchy". Reports-to / parent / superior phrasings now route here.
    // Sits BEFORE sharing-model (both vault, both generate_sharing_summary) so
    // bare "role hierarchy" and reports-to grammar land on the same tool; broad
    // sharing questions ("org-wide sharing model") have no role/report words and
    // still fall through to sharing-model.
    intent: 'role-hierarchy-structure',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.generate_sharing_summary'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Role hierarchy structure (which roles report to others) is modeled in the vault sharing model.',
    patterns: [
      /\brole\s+hierarchy\b/,
      /\b(which|what)\s+roles?\b.*\b(report\s+to|report\s+up|under|parent|superior|above)\b/,
      /\broles?\b.*\b(parent|superior|higher|report)\b/,
    ],
  },
  {
    intent: 'sharing-model',
    plane: 'vault',
    tools: ['sfi.generate_sharing_summary', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: false,
    reason: 'OWD, sharing rules, role hierarchy, groups — the sharing model from the vault.',
    patterns: [
      /\b(sharing\s+(model|summary)|owd|org[-\s]?wide\s+defaults?|sharing\s+rules?|role\s+hierarchy)\b/,
      /\bhow\s+is\s+sharing\b/,
      // "how is Account SHARED" — an object name between "how is" and "shared"
      // (the bare "how is sharing" pattern missed it). Question-battery gap.
      /\bhow\s+is\b.*\bshared\b/,
      /\bgenerate_sharing_summary\b/,
      /\bhow\s+is\b.*\brecord\s+access\b.*\bcontrolled\b/,
      /\bsharing\s+recalculation\b/,
      /\brole\s+of\b.*\buser\b/,
      /\bwhat\s+is\s+the\s+role\b.*\buser\b/,
      /\bpublic\s+groups?\b.*\b(broad|overly)\b.*\bmembership/,
    ],
  },
  {
    // M4 — profile MERGE what-if. The profile-migration rule below is a COMBINED
    // rule whose graded top-1 is always permission_risk_report, so merge can never
    // win there. Distinct verb "merge" keeps it off the permission_risk_report golds.
    intent: 'what-if-merge-profiles',
    plane: 'vault',
    tools: ['sfi.what_if_merge_profiles', 'sfi.permission_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Simulated profile MERGE blast radius (what_if_merge_profiles leads; the combined migration rule grades permission_risk_report first).',
    patterns: [
      /\bmerg\w*\b[^.?!]{0,40}\bprofiles?\b/,
      /\bprofiles?\b[^.?!]{0,40}\b(are|were)\s+merg\w*/,
    ],
  },
  {
    // M5 — profile SPLIT what-if. what_if_split_profile is NOT in the
    // profile-migration tools array, so every split ask currently routes to
    // permission_risk_report. The target also matches profile-migration's
    // /profiles.*into.*permission sets/, so this MUST sit earlier.
    intent: 'what-if-split-profile',
    plane: 'vault',
    tools: ['sfi.what_if_split_profile', 'sfi.permission_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Simulated profile SPLIT into permission sets (what_if_split_profile leads; otherwise unreachable via the migration rule).',
    patterns: [
      /\bsplit\w*\b[^.?!]{0,50}\bprofiles?\b/,
      /\bprofiles?\b[^.?!]{0,40}\b(are|were)\s+split/,
    ],
  },
  {
    intent: 'profile-migration',
    plane: 'vault',
    tools: ['sfi.permission_risk_report', 'sfi.what_if_merge_profiles'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Profile→permission-set migration / merge-split planning from permission metadata.',
    patterns: [
      /\bprofiles?\b.*\b(to|into|vs)\b.*\bpermission\s+sets?\b/,
      // `\bmerge\b` never matched the PAST tense "merged" (no boundary after
      // "merge"), so "what would break if I MERGED the A and B profiles" fell
      // through to unrouted. `merg\w*` catches merge/merged/merging; the two
      // named profiles + the plural "profiles" keep it precise (USAGE/impact
      // REACH — profiles/access family).
      /\b(merg\w*|split|splitting|consolidat\w*)\b.*\bprofiles?\b/,
      /\bprofile\s+migration\b/,
      // PASSIVE voice (P1c): "what if two profiles are merged / were consolidated"
      // — the active templates above ("if I merge profiles") missed the passive
      // form. Same merge/split/consolidate planning intent.
      /\bprofiles?\b.*\b(are|were)\s+(merged?|split|consolidat)/,
      /\bwhat\s+if\b.*\bprofiles?\b.*\b(are|were)\s+(merged?|split|consolidat)/,
    ],
  },
  {
    // The NET access a user GAINS by ASSIGNING a permission set to their current
    // baseline (profile + already-assigned sets), max-wins so a perm already
    // held elsewhere is not double-counted. Placed AFTER the unassigned /
    // holder / migration rules so those keep their heads; every pattern pairs an
    // ASSIGN/GRANT verb with the permission-set noun so it never grazes a
    // roster/inventory ask. Hypothetical READ — routes normally (not a refusal).
    intent: 'permset-assign-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_assign_permset'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Net access a user would GAIN by assigning a permission set on top of a baseline (profile + current sets); max-wins, so a permission already held via the profile or another set is not counted as gained (what_if_assign_permset).',
    patterns: [
      /\b(assign|assigning|grant|granting|adding|give|giving)\b[^.?!]*\b(permission\s+sets?|perm\s?sets?|permsets?)\b/,
      /\b(permission\s+sets?|perm\s?sets?|permsets?)\b[^.?!]*\b(assign|assigning|grant|granting)\b/,
      /\b(delta|impact|gains?|new\s+access)\b[^.?!]*\bgrant\w*\b[^.?!]*\b(permission\s+sets?|perm\s?sets?|permsets?)\b/,
      /\bwhat\b[^.?!]*\b(gains?|get|new\s+access)\b[^.?!]*\b(permission\s+sets?|perm\s?sets?|permsets?)\b/,
    ],
  },
  {
    // The mirror: the NET access a user LOSES by REVOKING a permission set from
    // their baseline. Max-wins, so a perm ALSO granted by the profile or another
    // set is not counted as lost. Same verb+noun discipline as the assign rule;
    // a conditional "what is lost if I remove X" is a hypothetical READ, so it
    // is an explicit excluder from the write-imperative refusal gate.
    intent: 'permset-revoke-impact',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_revoke_permset'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Net access a user would LOSE by revoking a permission set from a baseline; max-wins, so a permission also granted by the profile or another set is not counted as lost (what_if_revoke_permset).',
    patterns: [
      /\b(revoke|revoking|remove|removing|unassign|unassigning|strip|stripping|take\s+away|taking\s+away)\b[^.?!]*\b(permission\s+sets?|perm\s?sets?|permsets?)\b/,
      /\b(permission\s+sets?|perm\s?sets?|permsets?)\b[^.?!]*\b(revoked?|revoking|removed?|removing|unassign\w*|stripped?|lose|lost)\b/,
      /\bwhat\b[^.?!]*\b(lose|lost)\b[^.?!]*\b(permission\s+sets?|perm\s?sets?|permsets?)\b/,
    ],
  },
  {
    // R7-W6: AI/Agentforce exposure — "what data can my org's own AI see".
    // Anchored on Agentforce/GenAI/prompt-template/AI-agent vocabulary so it
    // never steals a generic PII/sensitive-data question (pii-inventory,
    // below) — a bare "sensitive data" or "pii" ask with no AI noun keeps
    // falling through to pii-inventory / compliance as before. Placed BEFORE
    // pii-flow/pii-inventory/compliance so an "is my AI agent exposing PII"
    // ask — which also carries the bare "pii" keyword those rules key on —
    // resolves to the AI-specific audit first.
    intent: 'ai-exposure',
    plane: 'vault',
    tools: ['sfi.ai_exposure_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "What data the org's own Agentforce/GenAI surface (prompt templates, agent actions) can reach, cross-referenced against the PII/sensitive classifier (ai_exposure_report).",
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [
      /\b(agentforce|genai|gen\s*ai)\b/,
      /\bcopilot\b[^.?!]{0,60}\b(leak\w*|expos\w*|pii|sensitive|access|see|read|ground\w*)\b/,
      /\b(ai|einstein)\s+agents?\b[^.?!]{0,60}\b(access|see|expose|exposure|read|ground\w*|leak\w*|pii|sensitive|have|has)\b/,
      /\bwhat\s+data\s+can\s+(my|our|the)\s+(ai|agent|agentforce|copilot)\b/,
      /\bai\s+exposure\b/,
      /\bprompt\s+templates?\b[^.?!]{0,60}\b(field|data|use|read|ground\w*|access)\b/,
      /\bai_exposure_report\b/,
    ],
  },
  {
    // Checked before pii-inventory: a "...flow/lineage/downstream" question is
    // about movement, not just the "ssn"/"pii" keyword inventory.
    intent: 'pii-flow',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_lineage'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Traces where a field flows (upstream/downstream) across Apex, flows, integrations.',
    // DEMOTED from catch-all (eval family E): field_lineage was the default
    // for any field-adjacent question carrying "flow(s)" or a bare
    // "upstream/downstream". Every pattern now requires an explicit
    // lineage/provenance/movement frame, so the earlier field-access /
    // explain-flow / save-order rules keep their heads and only genuine
    // "where does this data come from / flow to" questions land here.
    patterns: [
      /\b(data\s+flow|lineage)\b/,
      /\bwhere\s+does\b.*\b(field|data|pii|it)\b.*\b(flow|go|come\s+from)\b/,
      /\bfield\b[^.?!]{0,50}\bflows?\s+(?:to|into|out|through|downstream|between)\b/,
      // A change/delete/disable verb marks an IMPACT question, not lineage —
      // "what breaks downstream if I delete the X field" stays impact-analysis.
      /^(?!.*\b(?:break|delet|disabl|deactivat|remov|chang)\w*\b).*\b(upstream|downstream)\b[^.?!]{0,40}\b(?:fields?|data)\b/,
      /^(?!.*\b(?:break|delet|disabl|deactivat|remov|chang)\w*\b).*\b(?:fields?|data)\b[^.?!]{0,40}\b(upstream|downstream)\b/,
    ],
  },
  {
    // EncryptedText field TYPE inventory — list CustomField components and filter
    // by metadata type (edge-145). Must sit before pii-inventory, which classifies
    // PII heuristically and does not enumerate EncryptedText types.
    intent: 'schema',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component', 'sfi.search_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'EncryptedText field inventory is a CustomField type filter on the vault catalog — not PII classification.',
    suggestArgs: (q, question) => {
      const objectApi = deriveObjectApiFromQuestion(q, question);
      if (objectApi !== undefined) {
        return { type: 'CustomField', parentId: `CustomObject:${objectApi}` };
      }
      return { type: 'CustomField' };
    },
    patterns: [
      /\b(list|which|what)\b.*\bencrypted\s*text\b.*\bfields?\b/,
      /\bencrypted\s*text\b.*\bfields?\b/,
      /\bencryptedtext\b.*\bfields?\b/,
    ],
  },
  {
    intent: 'pii-inventory',
    plane: 'vault',
    tools: ['sfi.pii_inventory'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Classifies every field for PII/sensitive data from the vault.',
    suggestArgs: derivePiiInventoryArgs,
    patterns: [
      /\b(pii|personally\s+identifiable|sensitive\s+data|ssn|social\s+security)\b/,
      /\bwhat\s+(personal|sensitive)\b.*\b(data|fields?|information)\b/,
      // "which fields hold personal data" — the noun "fields" before the PII
      // keyword (the pattern above wanted "what personal ... fields"). Battery gap.
      /\b(which|what)\s+fields?\b.*\b(personal|sensitive|pii|private)\b/,
      /\bpii_inventory\b/,
      /\brun\s+pii\b/,
    ],
  },
  {
    intent: 'compliance',
    plane: 'vault',
    tools: ['sfi.generate_compliance_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Compliance/exposure report (FERPA/GDPR/audit) synthesized from the vault.',
    patterns: [
      /\b(ferpa|gdpr|hipaa|compliance|audit\s+report|exposure)\b/,
      /\bare\s+we\b.*\b(compliant|exposed)\b/,
    ],
  },

  // === Automation / order-of-execution (vault) ==============================
  {
    // Disable-a-trigger what-if (eval family C): "blast radius if I disable
    // trigger T" was hijacked by qualifier words — "integration"/vendor-sync
    // onto integration_map, bare "downstream" onto field_lineage — when the
    // head question is the dedicated what_if_disable_trigger simulation.
    // Sits FIRST in the automation cluster so a disable ask beats the generic
    // trigger-order/automation-on-object phrasings; those carry no
    // disable/turn-off verb, so nothing is stolen from them.
    intent: 'what-if-disable-trigger',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_disable_trigger'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What stops firing / breaks if a named trigger is disabled — the dedicated what_if_disable_trigger simulation over the vault graph (not integration topology, not generic lineage).',
    patterns: [
      /\bdisabl\w+\b[^.?!]{0,40}\btriggers?\b/,
      /\btriggers?\b[^.?!]{0,40}\b(?:is|was|were|gets?|being)\s+disabled\b/,
      /\b(?:turn(?:ed|ing)?\s+off|switch(?:ed|ing)?\s+off)\b[^.?!]{0,40}\btriggers?\b/,
    ],
  },
  {
    // Deactivate-a-flow what-if (RESIDUAL 2): "what breaks if I deactivate the
    // Onboarding flow" / "if I turn off FlowA and FlowB, does anything break".
    // The dedicated what_if_deactivate_flow simulator owns these — before it,
    // the deactivate-flow phrasing fell to generic impact-analysis (get_impact,
    // not the flow-specific simulator) and the "turn off … does anything break"
    // shape went unrouted entirely. Sits with the disable-trigger rule ahead of
    // trigger-order/automation-on-object: those carry no deactivate/turn-off
    // verb, so nothing is stolen from a save-order question. The deactivate/
    // turn-off verb + FLOW noun is the discriminator; needsResolve so the named
    // flow (or the first of several) is resolved before the simulation.
    intent: 'what-if-deactivate-flow',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_deactivate_flow'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What stops running / breaks if a named flow is deactivated — the dedicated what_if_deactivate_flow simulation over the vault graph (not a generic get_impact walk).',
    patterns: [
      /\b(?:deactivat\w+|disabl\w+|turn(?:ed|ing)?\s+off|switch(?:ed|ing)?\s+off)\b[^.?!]{0,60}\bflows?\b/,
      /\bflows?\b[^.?!]{0,60}\b(?:is|are|was|were|gets?|being)\s+(?:deactivated|disabled|turned\s+off)\b/,
      /\bflows?\b[^.?!]{0,60}\b(?:deactivat\w+|turn(?:ed|ing)?\s+off)\b/,
      // API-name form: "turn off Discount_Flow and Pricing_Flow, does anything
      // break" — the flow names carry the `_Flow` suffix rather than a standalone
      // "flow" word, so anchor on a deactivate/turn-off verb next to a *_Flow
      // component name (the whole-word "flow" alternations above miss this).
      /\b(?:deactivat\w+|disabl\w+|turn(?:ed|ing)?\s+off|switch(?:ed|ing)?\s+off)\b[^.?!]{0,40}\b[A-Za-z][A-Za-z0-9]*_Flow\b/i,
      // Flow-family API-name suffixes beyond `_Flow` (flow-family REACH): a
      // deactivate/turn-off verb next to a `_Process` / `_Orch` / `_Screen_Flow`
      // component name (e.g. Application_Save_RT_Orch). The SINGULAR flow-family
      // suffix (`_flow`, not the plural `_flows`) keeps the existing guard that a
      // plural embedded-Flow name like `ADA_Accom_Flow_Attribute_Flows` stays on
      // impact-analysis.
      /\b(?:deactivat\w+|disabl\w+|turn(?:ed|ing)?\s+off|switch(?:ed|ing)?\s+off)\b[^.?!]{0,60}\b[a-z][a-z0-9_]*_(?:process|orch|screen_flow)\b/i,
      // "what would happen if I deactivated <flow-suffix name>" — the explicit
      // what-if frame with a flow-family-named component.
      /\bwhat\s+would\s+happen\s+if\s+i\s+deactivat\w+\b[^.?!]{0,60}\b[a-z][a-z0-9_]*_(?:flow|process|orch|screen_flow)\b/i,
      // "suppose we deactivated <NamedComponent> versus <NamedComponent>" — the
      // "suppose … deactivated" lead is absent from the "what if we deactivate"
      // impact-analysis guard, so a >=2-underscore API name is safe here.
      new RegExp(
        `\\bsuppose\\s+we\\s+deactivat\\w+\\b[^.?!]{0,60}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
    ],
  },
  {
    // "how do records of this object get created" — the record-provenance
    // trace (which automations INSERT records of an object + which triggers
    // fire on it). Distinct from trigger-order/what_happens_on_save (the full
    // save-time automation tree): this answers the narrower who-inserts-this
    // question, anchored on create/insert PROVENANCE vocabulary rather than the
    // "what runs on save" frame, so it does not shadow the save-order rule
    // below (checked first only because it is more specific).
    intent: 'record-creation-paths',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.record_creation_paths'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'How records of an object get created — the Flow record-creates (writesTo operation=recordCreate) plus the triggers that fire on it (record_creation_paths). Apex DML inserts are NOT modeled, so an Apex-only creator reports zero — cross-check Apex before concluding nothing creates it.',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [
      /\bhow\s+(?:do|does|are)\b[^.?!]{0,40}\brecords?\b[^.?!]{0,40}\b(?:created|inserted|get\s+created)\b/,
      /\bwhat\s+(?:creates|inserts)\b[^.?!]{0,40}\brecords?\b/,
      /\b(?:record\s+creation\s+paths?|creation\s+paths?)\b/,
      /\bwhich\s+(?:automations?|flows?)\b[^.?!]{0,40}\b(?:create|insert)\b[^.?!]{0,40}\brecords?\b/,
    ],
  },
  {
    // Flow error-handling hygiene: which flows have a DML/action element with
    // no fault path. Anchored on "fault" + flow vocabulary (and flow + missing
    // error handling) — none of which the save-order / flow-apex-bridge /
    // flow-metadata rules use — a low-collision addition.
    intent: 'flow-fault-audit',
    plane: 'vault',
    tools: ['sfi.flow_fault_audit'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Which flows have a faultable DML/action element with no fault path (flow_fault_audit). An unhandled fault is surfaced, not silent — the tool flags missing fault connectors, worst-first.',
    patterns: [
      /\bflows?\b[^.?!]{0,60}\bfaults?\b/,
      /\bfaults?\b[^.?!]{0,60}\bflows?\b/,
      /\bflows?\b[^.?!]{0,60}\b(?:no|missing|without|lack\w*)\b[^.?!]{0,30}\b(?:fault|error\s+handling|error\s+path|error\s+connector)\b/,
      /\bflows?\b[^.?!]{0,60}\berror\s+handling\b/,
    ],
  },
  {
    intent: 'trigger-order',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_happens_on_save', 'sfi.order_of_execution'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Order of execution / what runs on save is reconstructed from the vault graph. what_happens_on_save needs an explicit DML event — default to 'update' (or insert/delete to match the question) when none is stated.",
    suggestArgs: (q, question) => {
      const args: Record<string, unknown> = { event: deriveSaveEvent(q) };
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      if (objectApiName !== undefined) args.objectApiName = objectApiName;
      return args;
    },
    patterns: [
      /\b(trigger\s+order|order\s+of\s+execution)\b/,
      // One optional adverb between "what" and the verb — "what ACTUALLY
      // happens on save" fell through to unrouted (eval OVER-CLARIFY family A).
      /\bwhat\s+(?:\w+\s+)?(happens|runs|fires)\b.*\b(on\s+save|when\b.*\b(created|saved|updated|inserted|deleted|undeleted|restored))\b/,
      // "what happens when I update Contact" — present-tense DML without "on save"
      /\bwhat\s+(happens|runs|fires)\b.*\bwhen\b.*\b(i\s+)?(update|insert|delete|save|create|edit)\b/,
      // "which/what flows|triggers|VRs|workflows run|fire when ..." — the
      // "which" phrasing was a router gap (e.g. "which flows run when a Case is
      // created"), so the question fell through to unrouted.
      /\b(what|which)\s+(triggers?|automation|flows?|validation\s+rules?|workflows?)\b.*\b(fire|run|execute|happen)\b/,
      /\b(flows?|triggers?|automation)\b.*\bwhen\b.*\b\w+\s+is\b.*\b(created|updated|inserted|deleted|saved)\b/,
      // "what APEX/code/class runs when ..." — a noun between "what" and the
      // verb (vs the adjacent "what runs") used to fall through (B21).
      /\bwhat\s+(apex|code|class(es)?)\b.*\bruns?\b.*\bwhen\b/,
      // "what happens when a Case STATUS CHANGES" — a status/stage change is a
      // save-order event the "(created|updated|...)" verb list missed (B21).
      /\bwhat\s+(happens|runs|fires)\b.*\b(status|stage)\b.*\bchang/,
      // "What runs on Account insert?" — DML event without "on save" / "when"
      // (B21). Verb-symmetric "fires"/"happens" too: "what FIRES on X insert
      // during the integration load — what runs bulk" is a save-order head
      // question; the bulk/load/integration qualifiers must not drag it onto
      // governor_limit_risks or integration_map (eval family C).
      // ("what happens IF I delete…" is an impact/what-if frame, not a DML
      // save-order ask — the immediate "if" is excluded so it falls through.)
      /\bwhat\s+(?:runs|fires|happens)\b(?!\s+if\b).*\b(insert|update|delete|undelete)\b/,
      // "what happens when I SAVE an Evaluation" — present-tense "save"/"saves"/
      // "saving" (the verb list above only had past-tense "saved"). Question-
      // battery gap.
      /\bwhat\s+(happens|runs|fires)\b.*\bwhen\b.*\bsav(e|es|ing)\b/,
      // "When X is inserted, do TriggerA and TriggerB both fire?" — differential edge-03.
      /\bwhen\b.*\b(is\s+)?(inserted|updated|deleted|created)\b.*\b(trigger|fire)\b/,
      /\bdo\b[^.?!]{0,120}\b(trigger|triggers)\b[^.?!]{0,80}\bfire\b/,
      /\b(trigger|triggers)\b.*\b(both|and)\b.*\bfire\b/,
      /\b(same\s+transaction|rollup)\b.*\b(after[-\s]?insert|DLRS|dlrs)/i,
      // FULL SAVE-ORDER / whole-transaction reconstruction (flow-family REACH).
      // "walk me through everything that fires in order", "list every/all
      // automation that fires when …", "full save order on X", "before-vs-after
      // -save breakdown of every automation" — the whole-order ask, distinct
      // from lifecycle-process (transition-value coupled) which owns the
      // "…becomes/is set to <value>" shapes above it.
      /\b(everything|every\s+automation|all\s+(?:the\s+)?automation)\b[^.?!]{0,60}\b(fires?|runs?|happens?)\b/,
      /\b(fires?|runs?|happens?)\b[^.?!]{0,40}\bin\s+order\b/,
      /\b(list|give\s+me)\b[^.?!]{0,40}\b(?:every|all)\b[^.?!]{0,20}\bautomation\b[^.?!]{0,50}\b(fires?|runs?|when)\b/,
      /\bfull\s+save\s+order\b/,
      /\bsave\s+order\b[^.?!]{0,40}\b(?:on|for)\b/,
      /\bbefore[-\s]?(?:vs[-\s]?)?after[-\s]?save\b[^.?!]{0,40}\b(breakdown|every\s+automation|automation)\b/,
      // "what order do validation rules and record-triggered flows evaluate" —
      // an explicit ordering question over multiple automation families.
      /\bwhat\s+order\b[^.?!]{0,90}\b(evaluate|run|fire|execute)\b/,
      // "run order between <FlowA> and <flow>" — the pairwise ordering ask.
      /\brun\s+order\s+between\b/,
      // "which apex classes are triggered when a X is inserted/created" — the
      // "apex classes" phrasing the "(apex|code|class)" pattern above missed
      // because it requires the singular "runs" verb, not "are triggered".
      /\b(?:which|what)\s+apex\s+classes?\b[^.?!]{0,40}\b(triggered|fire|run)\b[^.?!]{0,40}\b(insert|update|delete|save|creat)/,
      // "does anything run on X update that would collide with <Flow>" — an
      // impact-on-save question framed as "does anything run … on <dml>".
      /\bdoes\s+anything\s+(run|fire|happen)\b[^.?!]{0,40}\b(update|insert|save|edit|creat)/,
      // "what else fires on the same X save transaction" — co-firing on the same
      // transaction as a named automation.
      /\bwhat\s+else\s+(fires?|runs?|happens?)\b[^.?!]{0,60}\bsave\s+transaction\b/,
      // "assignment rules … run before or after the record-triggered flows" — the
      // classic order-of-execution question about where assignment rules sit.
      /\bassignment\s+rules?\b[^.?!]{0,60}\b(before|after)\b[^.?!]{0,40}\b(?:record[-\s]?triggered\s+)?flows?\b/,
      // "will it fight/collide/conflict with HEDA" when ADDING an after-save flow
      // — the build-planning ask whose answer is the existing save-order.
      /\b(?:after[-\s]?save|before[-\s]?save)\s+flow\b[^.?!]{0,80}\b(fight|collide|conflict|clash)\b/,
      // ORDER-OF-EXECUTION: "which TDTM/handler/trigger classes fire on X insert
      // and in what order" — the ordered trigger-handler question (HEDA TDTM
      // handlers register per DML event). "in what order" is the discriminator.
      /\b(?:which|what)\b[^.?!]{0,60}\b(?:tdtm|handler|trigger)\s+classes?\b[^.?!]{0,50}\bfire\b[^.?!]{0,50}\b(?:in\s+what\s+order|what\s+order|order)\b/,
      // "does <NamedFlow> run before or after <the> lead conversion" — a pairwise
      // ordering ask relative to a conversion; order_of_execution reconstructs it.
      // (lifecycle-process owns "what runs WHEN a Lead is converted"; this "run
      // before/after conversion" shape carries no such "what happens when" head,
      // so the two stay disjoint.)
      /\bruns?\s+(?:before|after)\b[^.?!]{0,60}\b(?:lead\s+conversion|converts?\s+the\s+lead|conversion)\b/,
    ],
  },
  {
    intent: 'why-field-changed',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.why_field_changed'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Traces every automation that writes a field — the root-cause for "why did/didn\'t it change".',
    patterns: [
      /\bwhy\s+(did|didn'?t|does|doesn'?t)\b.*\b(field|value)\b.*\b(change|update|set)\b/,
      /\bwhat\s+(writes?|updates?|sets?)\b.*\bfield\b/,
      /\bwhat\s+changed\b.*\bfield\b.*\bon\s+save\b/,
      // M34 — "which flows write to <field>" = the writers-fabric of a field.
      // (Intentionally pre-empts the universal component-usage dispatcher, which
      // sits later in RULES and would otherwise claim this on find_component_usages.)
      /\bwhich\s+flows?\b[^?!]{0,25}\bwrite(?:s)?\s+to\b/,
    ],
  },
  {
    // Validation-rule family enumeration (values protected, alias exempt) — list
    // rules on the named object; must precede explain-validation-rule (enforce/does).
    intent: 'validation-rule-family',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'A validation-rule family question needs the rules on the object (list_components) and optionally individual rule formulas (get_component).',
    suggestArgs: (q, question) => {
      const parentApi = deriveObjectApiFromQuestion(q, question);
      if (parentApi !== undefined) {
        return { type: 'ValidationRule', parentId: `CustomObject:${parentApi}` };
      }
      return { type: 'ValidationRule' };
    },
    patterns: [
      /\bvalidation\s+rule\s+family\b/i,
      /\bContactCategorySecurity\b/i,
      /\bvalidation\s+rules?\b.*\b(which|what)\b.*\b(values?|protect|protected|exempt|alias|editable)\b/i,
      /\bOn\s+Lead\b.*\bvalidation\s+rule/i,
    ],
  },
  {
    // What a validation rule enforces / its error — get_component on the rule.
    // MUST precede automation-on-object, which else steals "what does the X
    // validation rule on <object> enforce" (it has "validation rule … on
    // account") and sends it to automation_build_advisor instead of the rule's
    // formula+error (NI-11). "What validation rules exist/run" stays schema /
    // trigger-order (those lack the enforce/does/error verbs below).
    intent: 'explain-validation-rule',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "A validation rule's condition and error message are in the vault — resolve the rule, then get_component for its formula and error text.",
    patterns: [
      // Clause-bounded (P14-ROUTER-safe-delete-misroute): unbounded gaps let
      // "…validation rule, flow, … and whether the platform would BLOCK
      // deletion…" (and "validation rule … Account.Description") drag a
      // safe-to-delete-field question onto this explainer — the third
      // instance of the cross-clause overreach class.
      /\bvalidation\s+rules?\b[^.?!]{0,50}\b(enforce|does|do\b|check|mean|prevent|block|error|message|stop)\b/,
      /\bwhat\s+(does|error|message)\b.*\bvalidation\s+rule\b/,
      /\b(error|message)\b.*\bvalidation\s+rule\b.*\b(show|display|return)\b/,
      /\bvalidation\b[^.?!]{0,30}\b(open|application|account)\b/,
      /\b\w+edit\b.*\bvalidation\b/,
    ],
  },
  {
    intent: 'automation-on-object',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.automation_build_advisor', 'sfi.get_edges', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'What automation already exists on an object — the pre-build briefing.',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { objectApiName } : undefined;
    },
    patterns: [
      /\bwhat\s+automation\b/,
      /\b(before\s+i\s+build|before\s+adding|building)\b.*\b(automation|flow|trigger)\b/,
      /\b(what|which|list)\b.*\bapex\s+triggers?\b.*\b(fire|run|on|for)\b/,
      /\b(what|which)\s+triggers?\b.*\b(fire|run)\b.*\bon\b/,
      /^(?!.*\b(list|how\s+many)\b).*\b(triggers?|flows?|validation\s+rules?|workflows?)\b.*\bon\b.*\b(object|account|contact|case|opportunity)\b/,
      /\bemail\s+alerts?\b.*\b(sent|automation|Case|workflow|flow)\b/,
      /\bwhat\s+email\s+alerts?\b/,
    ],
  },
  {
    intent: 'pb-wfr-migration',
    plane: 'vault',
    tools: ['sfi.process_builder_migration_candidates'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Process Builder / Workflow Rule migration candidates from the vault.',
    patterns: [
      /\b(process\s+builder|workflow\s+rules?)\b.*\b(migrat|convert|move|deprecat|consolidat|should)\b/,
      /\bwhat\s+(should\s+i\s+)?migrate\b.*\bflow\b/,
      /\b(migrate|convert)\b.*\bto\s+flow\b/,
      /\bprocess\s+builder\b.*\bmigration\b/,
      /\bshould\s+be\s+migrated\b.*\bflow\b/,
      /\bconsolidated?\s+into\s+flow\b/,
      /\bworkflow\s+rules?\b.*\b(or\s+only|only)\b.*\bflows?\b/,
      /\bdoes\b.*\bhave\b.*\b(active\s+)?workflow\s+rules?\b/,
    ],
  },
  {
    // R7-W6: the RUNTIME schedule registry (CronTrigger) — what is ACTUALLY
    // scheduled right now. Anchored on a temporal/actual cue (mirrors the
    // automation-fired / picklist-usage live-vs-vault idiom) or a literal
    // CronTrigger/CronJobDetail API name, so a bare "what jobs are scheduled"
    // (no actual/currently/right-now cue) still defaults to the offline
    // scheduled_job_catalog below (Schedulable-CAPABLE classes; schedule-
    // capable != scheduled) — placed BEFORE it so the temporal cue wins.
    intent: 'live-scheduled-jobs',
    plane: 'live',
    tools: ['sfi.live_scheduled_jobs'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'What is ACTUALLY scheduled right now (CronTrigger + CronJobDetail, next fire times, recent AsyncApexJob status) is live runtime state — live_scheduled_jobs reads it; the vault only lists Schedulable-CAPABLE Apex classes.',
    patterns: [
      /\b(?:currently|actually|right\s+now|today|recently)\b[^.?!]{0,40}\bscheduled\b/,
      /\bscheduled\b[^.?!]{0,40}\b(?:currently|actually|right\s+now|today|recently)\b/,
      /\bcron\s*trigger(?:s)?\b/,
      /\bcronjobdetail\b/,
      /\bnext\s+fire\s+times?\b/,
      /\blive\s+scheduled\s+(?:jobs?|apex)\b/,
      /\bwhat(?:'?s| is)\s+running\s+on\s+a\s+schedule\b/,
      /\bcron\b[^.?!]{0,30}\bregist(?:er|ered|ry)\b/,
      /\blive_scheduled_jobs\b/,
    ],
  },
  {
    intent: 'scheduled-jobs',
    plane: 'vault',
    tools: ['sfi.scheduled_job_catalog'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Scheduled Apex / schedulable jobs catalog from the vault.',
    patterns: [
      /\b(scheduled|schedulable|cron)\b.*\b(jobs?|apex|classes?|flows?)\b/,
      /\bwhat\s+(jobs?|apex|flows?)\b.*\bscheduled\b/,
      /\b(apex|classes?)\b.*\bscheduled\b.*\brun\b/,
      /\bbatch\s+jobs?\b.*\bscheduled\b/,
      /\bscheduled\b.*\bflows?\b.*\b(when|run)\b/,
    ],
  },
  {
    intent: 'explain-flow',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_flow'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Plain-English narration of a Flow\'s trigger, decisions, and actions.',
    patterns: [
      /\bwhat\s+does\b.*\bflows?\b.*\bdo\b/,
      /\bexplain\b.*\bflows?\b/,
      /\bhow\s+does\b.*\bflows?\b.*\bwork\b/,
      /\bwhen\s+does\b.*\b(run|fire|execute|trigger)\b/,
      /\bwhen\s+does\s+it\s+run\b/,
      /\bdoes\b.*\bflow\b.*\b(system\s+mode|without\s+sharing|with\s+sharing)\b/,
      /\b(system\s+mode|without\s+sharing|sharing\s+bypass)\b.*\bflow\b/,
      /\b(run|runs|running)\b.*\b(system\s+mode|without\s+sharing)\b.*\bflow\b/,
      // NAMED-FLOW narration (flow-family REACH). A question that NAMES a
      // component by its API name (NAMED_COMPONENT_ID — a >=2-underscore token,
      // never English prose) AND asks to narrate/summarize/walk-through it is an
      // explain_flow ask. Each pattern REQUIRES the named id so a generic
      // "explain the sharing model" never lands here. resolve binds the entity
      // and the type-guard keeps explain_flow on a real Flow.
      // A COMPARE frame ("explain the difference between A and B", "compare …")
      // is NOT single-flow narration — explain_flow narrates ONE flow, so a
      // two-flow comparison must fall through (it stays a compare/unrouted gap
      // rather than a forced bad route). The `(?!…difference/compare/versus…)`
      // lookahead on the narration patterns below enforces that.
      new RegExp(
        `^(?!.*\\b(?:difference|differences|compare|comparison|versus|vs\\.?)\\b).*\\b(explain|summariz(?:e|ing)|walk\\s+me\\s+through|walkthrough|plain[-\\s]english\\s+walkthrough|purpose\\s+of)\\b[^.?!]{0,60}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
      new RegExp(
        `\\b${NAMED_COMPONENT_ID}\\b[^.?!]{0,60}\\b(in\\s+plain\\s+(?:terms|english)|end\\s+to\\s+end|step\\s+by\\s+step)\\b`,
      ),
      // Narration verbs where the named id sits BEFORE the verb clause — e.g.
      // "Summarize <Name> and what it's calculating", "Explain <Name> and what
      // a 'flag' means", "What does <Name> copy from …". Same compare-frame
      // guard so "explain the difference between <A> and <B>" is not stolen.
      new RegExp(
        `^(?!.*\\b(?:difference|differences|compare|comparison|versus|vs\\.?)\\b).*\\b(?:explain|summarize|walk\\s+me\\s+through)\\b[^.?!]{0,20}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
      new RegExp(
        `\\bwhat\\s+does\\b[^.?!]{0,20}\\b${NAMED_COMPONENT_ID}\\b[^.?!]{0,40}\\b(do|does|copy|copies|write|writes|calculat\\w*)\\b`,
      ),
      // "Does <Name> fire/run/write/have/send …" — a behavior question about a
      // NAMED flow (does it fire on insert+update, run every time, write to X,
      // have fault connectors, send texts). The named id as grammatical subject
      // of a flow-behavior verb keeps it precise.
      new RegExp(
        `\\bdoes\\s+(?:the\\s+)?${NAMED_COMPONENT_ID}\\b[^.?!]{0,80}\\b(fire|fires|run|runs|write|writes|have|has|send|sends|execute|re-?trigger)\\b`,
      ),
      // "Is <Name> a before-save/after-save/fast-field/scheduled/screen flow …" —
      // a flow-shape classification question about a named flow.
      new RegExp(
        `\\bis\\s+(?:the\\s+)?${NAMED_COMPONENT_ID}\\b[^.?!]{0,60}\\b(before[-\\s]?save|after[-\\s]?save|fast[-\\s]?field|scheduled\\s+path|screen\\s+flow|record[-\\s]?triggered)\\b`,
      ),
      // "What entry condition(s)/entry criteria gate/on <Name>" and "why would
      // <Name> skip a record" — entry-gate and skip-behavior narration.
      /\bentry\s+conditions?\b[^.?!]{0,20}\b(gate|on)\b/,
      /\bwhat(?:'s| is)?\s+the\s+entry\s+condition\b/,
      new RegExp(`\\bwhy\\s+would\\s+${NAMED_COMPONENT_ID}\\b[^.?!]{0,60}\\bskip\\b`),
      // "Does <Name> have any active version" / "why is it named like that" — the
      // active-version + naming question about a named flow.
      new RegExp(
        `\\bdoes\\s+${NAMED_COMPONENT_ID}\\b[^.?!]{0,40}\\b(active\\s+version|any\\s+active)\\b`,
      ),
      // M36 — "(pull up / show me) an explanation of the <Flow> flow". The
      // \bexplain\b anchors miss "explanation", and NAMED_COMPONENT_ID needs a
      // >=2-underscore token so a no-underscore CamelCase flow name is invisible.
      new RegExp('\\bexplanation\\s+of\\b[^.?!]{0,60}\\bflow\\b'),
    ],
  },
  {
    // R7-W6: FIELD-LEVEL write-collision + save-recursion cycle detector for
    // ONE object — "is my org fighting itself on this object?". Its phrasing
    // space heavily overlaps automation-risk's ORG-WIDE "overlapping/duplicate/
    // conflict automation" language (R6-15 grandfather note), so this rule is
    // anchored SPECIFICALLY on same-FIELD write collisions and recursion/loop
    // language — vocabulary automation-risk's patterns never use (it keys on
    // "overlapping"/"duplicate"/"conflict"/"same object", never "same field" or
    // "recursion"/"loop"/"fighting itself") — and placed BEFORE automation-risk
    // so the narrower field-level ask wins first-match; a genuine object-wide
    // "are there overlapping automations that might conflict" question still
    // falls through untouched.
    intent: 'automation-collisions',
    plane: 'vault',
    tools: ['sfi.automation_collisions', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Field-level write collisions (2+ automations writing the SAME field) and save-recursion cycles on ONE object are a targeted diagnosis automation_risk_report does not compute — automation_collisions walks the writesTo edges of the same firer set.',
    suggestArgs: (q, question) => {
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      return objectApiName !== undefined ? { object: objectApiName } : undefined;
    },
    patterns: [
      /\b(?:write|writes|writing|update|updates|updating|set|sets|setting)\b[^.?!]{0,40}\bsame\s+field\b/,
      /\bfield[-\s]level\b[^.?!]{0,40}\b(?:collision|conflict|overwrit\w*)/,
      /\b(?:save\s+)?recursion\s+(?:cycle|loop)\b/,
      /\bsave\s+recursion\b/,
      /\brecursion\s+between\b/,
      /\b(?:automation|flow|workflow)\s+loop\b/,
      /\bre-?trigger\w*\s+itself\b/,
      /\boverwrit\w*\b[^.?!]{0,40}\bfield\b/,
      /\bfighting\s+itself\b/,
      /\bautomation_collisions\b/,
    ],
  },
  {
    // AUTOMATION-SPRAWL-MODE — the org-wide, per-OBJECT automation-density
    // ranking ("which objects have the most automation / where is sprawl
    // worst"). Placed BEFORE the generic automation-risk rule so a sprawl
    // phrasing wins first-match and routes with `mode: 'sprawl'`; every other
    // automation-risk ask still falls through to the per-finding synthesis
    // below. The patterns key on sprawl / density / most-automation-per-object
    // vocabulary the risk rule never uses.
    intent: 'automation-sprawl',
    plane: 'vault',
    tools: ['sfi.automation_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Org-wide per-object automation-density ranking — a prioritized triage queue (where is automation sprawl worst first), the sprawl MODE of automation_risk_report.',
    suggestArgs: () => ({ mode: 'sprawl' }),
    patterns: [
      /\bautomation\s+sprawl\b/,
      /\bflow\s+sprawl\b/,
      /\bsprawl\b[^.?!]{0,30}\b(?:automation|flows?|objects?)\b/,
      /\b(?:automation|flow)\s+density\b/,
      /\b(?:which|what)\s+objects?\b[^.?!]{0,40}\bmost\s+(?:automation|flows?|triggers?)\b/,
      /\bmost\s+(?:automation|flows?|triggers?)\b[^.?!]{0,25}\bobjects?\b/,
      /\brank\s+(?:the\s+)?objects?\b[^.?!]{0,30}\b(?:automation|flow|density)\b/,
      /\bwhere\s+is\b[^.?!]{0,30}\bsprawl\b/,
    ],
  },
  {
    intent: 'automation-risk',
    plane: 'vault',
    tools: ['sfi.automation_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Org-wide automation risk synthesis (overlapping triggers, order-of-execution hotspots).',
    patterns: [
      /\bautomation\s+risk\b/,
      /\brun\s+automation\s+risk\b/,
      /\b(run\s+)?[au]?tomation\s+risk\b/,
      /\boverlapping\b.*\bautomation/,
      /\bduplicate\s+automation/,
      /\bmultiple\s+(triggers?|automation|flows?)\b.*\b(same\s+object|object)\b/,
      /\bconflict\b.*\bautomation/,
      /\bautomation\s+(strategy|landscape)\b/,
      /\blegacy\s+(tools?|automation)/,
      /\bpercentage\b.*\b(automation|flow|legacy)/,
      /\brace\s+conditions?\b.*\b(flows?|triggers?)/,
      /\bbulkification\b.*\bautomation/,
      /\berror\s+handling\b.*\bautomation/,
      /\bhow\s+is\b.*\b(error\s+handling|automation\s+error)\b/,
      /\bcustom\s+code\b.*\b(replaced|replace)\b.*\b(declarative|flow)/,
      /\brecord[-\s]triggered\s+flows?\b.*\b(combined|combine|performance)/,
      /\bautomation\s+tools?\b.*\bfiring\b.*\bsame\s+object/,
      /\bobjects?\b.*\bmost\s+validation\s+rules/,
      /\bstacked\s+automation\b/,
    ],
  },
  {
    // M16 — browse the org's Decision Tables. The omnistudio rule below lists
    // "decision tables?" but leads with list_components; decision_table_browse
    // is not in its tools.
    intent: 'decision-table-browse',
    plane: 'vault',
    tools: ['sfi.decision_table_browse', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Browse the OmniStudio Decision Tables in the org (decision_table_browse).',
    patterns: [/\bdecision\s+tables?\b/],
  },
  {
    // M22 — the OmniStudio Integration Procedure CHAIN for a named IP. The
    // omnistudio rule lists "integration procedures?" but leads with
    // list_components (integration_procedure_chain is tools[2], never top-1).
    intent: 'integration-procedure-chain',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.integration_procedure_chain'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Per-IP Integration Procedure chain traversal (integration_procedure_chain), not the org-wide list.',
    patterns: [/\bintegration\s+procedures?\b[^.?!]{0,25}\bchain\b/],
  },
  {
    // M24 — walk the OmniScript FLOW for a named OmniScript. The generic
    // omnistudio rule leads with list_components for any "omniscript" mention.
    intent: 'omniscript-flow',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.omniscript_flow'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Named OmniScript flow breakdown (omniscript_flow), not the org-wide OmniScript list.',
    patterns: [
      /\bomni\s?scripts?\b[^?!]{0,40}\bflow\b/,
      /\bwalk\s+me\s+through\b[^?!]{0,30}\bomni\s?script\b/,
    ],
  },
  {
    // MUST precede flow-search: "OmniScript flow" contains the word "flow".
    intent: 'omnistudio',
    plane: 'vault',
    tools: [
      'sfi.list_components',
      'sfi.omniscript_flow',
      'sfi.integration_procedure_chain',
      'sfi.omniuicard_widget_breakdown',
    ],
    liveRequired: false,
    needsResolve: false,
    reason:
      'List the OmniStudio components for the named sub-family (OmniScripts / Integration Procedures / DataRaptors / FlexCards), then break down a specific OmniScript flow, IP chain, or FlexCard once one is named.',
    suggestArgs: (q) => ({ type: deriveOmniType(q) }),
    patterns: [
      // Plurals + the two-word "data raptor" spelling were missed: `\bomniscript\b`
      // does not match "omniscript<s>" and `dataraptors?` does not match "data
      // raptors" (space) — both fell to `unrouted` (P12-ROUTER-omni-cpq).
      /\b(omni\s?scripts?|omni\s?studio|integration\s+procedures?|flex\s?cards?|data\s?raptors?|decision\s+tables?)\b/,
    ],
  },
  {
    intent: 'inactive-flows',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Inactive Flow inventory (Draft / Obsolete / non-Active status) from vault Flow nodes — list_components type Flow, then inspect properties.status.',
    suggestArgs: () => ({ type: 'Flow' }),
    patterns: [
      /\b(inactive|draft|obsolete)\b.*\bflows?\b/,
      /\bflows?\b.*\b(inactive|draft|obsolete|not\s+active)\b/,
      /\bwhich\s+flows?\b.*\b(inactive|draft|obsolete|not\s+active)\b/,
    ],
  },
  {
    intent: 'flow-search',
    plane: 'vault',
    tools: ['sfi.search_flow_metadata'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Text grep over Flow XML for a literal reference.',
    // search_flow_metadata REQUIRES `query` — without suggestedArgs every
    // routed call died on the missing arg and the regression bank scored
    // honest `route_only` (P14-ROUTER-stress-20). Derive the grep text by
    // stripping the routing scaffolding words; what remains is the content
    // the user actually named ("traa partner account affiliate stamping").
    suggestArgs: (q) => {
      const query = q
        .replace(/\b(which|what|the|a|an|that|flows?|search|find|list|show|me|do|does|references?|uses?|mentions?|touch(es)?|calls?|on|for|in|of|to)\b/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return query.length > 0 ? { query } : undefined;
    },
    patterns: [
      /\b(which|what)\s+flows?\b.*\b(references?|uses?|mentions?|touch(es)?|calls?)\b/,
      /\bflows?\b.*\b(that|which)\b.*\b(references?|uses?)\b/,
      // Router-v2 P4: "pull the flow that FIRES/SENDS/CREATES the '<step
      // name>' step" — find-a-flow-by-what-it-does is a Flow-XML grep.
      /\bflows?\s+that\s+(fires?|sends?|creates?|assigns?|updates?|contains?|does)\b/,
      /\b(sync|stamping|affiliate|marketo|applicant|partner|budget)\b.*\bflows?\b/,
      /\bflows?\b.*\b(sync|stamping|affiliate|marketo|applicant|partner|budget)\b/,
      /\bflows?\b.*\b(send|sends|email)\b/,
      /\b(send|sends|email)\b.*\bflows?\b/,
      /\bsubflows?\b/,
      /\bwhat\s+subflows?\b/,
    ],
  },
  {
    intent: 'flow-apex-bridge',
    plane: 'vault',
    // STEP-2: find_apex_usages retired to a hidden alias; the survivor
    // find_code_usages (Apex-narrowable superset) leads this rule now. The
    // repointed gold row ("Which flows invoke Apex classes?") expects it here.
    tools: ['sfi.find_code_usages', 'sfi.search_flow_metadata', 'sfi.resolve'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Which Apex classes a Flow invokes (and the reverse) — flow XML action nodes plus Apex usage edges in the vault.',
    patterns: [
      /\b(apex|classes?)\b.*\b(invoked|called)\b.*\bflows?\b/,
      /\bflows?\b.*\b(invoke|call)\b.*\b(apex|classes?)\b/,
    ],
  },

  // === Apex / code (vault) ==================================================
  {
    // Finding #40: decode a PASTED Apex DEBUG LOG / runtime governor-limit
    // exception back to the class/trigger/flow that ran (explain_debug_log).
    // Placed BEFORE explain-error so a runtime LimitException / debug-log paste
    // (which explain-error's generic `System.<X>Exception` pattern would
    // otherwise catch) routes here. Anchored on debug-log STRUCTURE markers
    // (pipe-delimited event tokens) and RUNTIME limit-exception signatures with
    // their concrete `: N` counts — NOT the bare phrase "governor limit(s)",
    // which stays with governor_limit_risks' proactive "which of my queries
    // MIGHT hit limits" ask. Low-collision: no earlier rule uses these tokens.
    intent: 'explain-debug-log',
    plane: 'vault',
    tools: ['sfi.explain_debug_log'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Decoding a pasted Apex debug log / runtime governor-limit exception back to the class/trigger/flow that ran is a ranked resolution over the log\'s stack frames + a cross-reference against the static governor_limit_risks scan (explain_debug_log). Needs the raw logText — supply the pasted log/exception verbatim.',
    patterns: [
      // Debug-log structure markers (pipe-delimited event tokens) — a pasted log.
      /\|(?:CODE_UNIT_STARTED|METHOD_ENTRY|LIMIT_USAGE(?:_FOR_NS)?|CUMULATIVE_LIMIT_USAGE|FATAL_ERROR|EXCEPTION_THROWN|SOQL_EXECUTE_BEGIN|DML_BEGIN|USER_DEBUG)\|/,
      // Runtime governor-LIMIT exception signatures (a limit that ALREADY fired).
      /\bsystem\.limitexception\b/i,
      /\btoo many (?:soql queries|dml statements|dml rows|query rows|callouts|future calls|email invocations)\s*:/i,
      /\bapex cpu time limit exceeded\b/i,
      /\bapex heap size too large\b/i,
      /\bmaximum (?:trigger|stack) depth\b/i,
      // Explicit "debug log" asks.
      /\b(?:explain|read|decode|interpret|walk me through|what(?:'s| is) in)\b[^.?!]{0,30}\bdebug log\b/i,
      /\bdebug log\b[^.?!]{0,30}\b(?:mean|say|show|point|caus)/i,
      /\bexplain_debug_log\b/,
    ],
  },
  {
    // R7-W6: decode a PASTED Salesforce error string back to its source
    // component — the support-desk "what does this error mean" ask. Anchored
    // on the concrete error-signature vocabulary (status-code taxonomy tokens,
    // Apex stack frames, flow-fault-email shapes) plus generic explain/decode
    // verbs on "this error" — none of which any earlier rule uses (the
    // explain-validation-rule intent narrates a NAMED rule's condition, not a
    // pasted error string), so this is a low-collision addition.
    intent: 'explain-error',
    plane: 'vault',
    tools: ['sfi.explain_error', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Decoding a pasted error/fault-email/stack-trace string back to the org component that produced it is a ranked heuristic match over validation rules, flows, Apex, and the status-code taxonomy (explain_error). Needs the raw errorText — supply the pasted error verbatim.',
    patterns: [
      /\b(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|REQUIRED_FIELD_MISSING|UNABLE_TO_LOCK_ROW|INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY|CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY|DUPLICATE_VALUE|STORAGE_LIMIT_EXCEEDED|MIXED_DML_OPERATION)\b/i,
      /\bsystem\.\w*exception\b/i,
      /\bclass\.\w+\.\w+\s*:\s*line\s*\d+/i,
      /\btrigger\.\w+\s*:\s*line\s*\d+/i,
      /\ban\s+error\s+occurred\s+at\s+element\b/i,
      /\bflow\s+api\s+name\s*:/i,
      /\bwhat\s+does\s+this\s+error\s+mean\b/,
      /\b(?:explain|decode)\s+this\s+(?:error|stack\s+trace)\b/,
      /\bwhy\s+(?:did|do)\s+i\s+(?:get|see)\s+this\s+error\b/,
      /\bwhat\s+caused\s+this\s+error\b/,
      /\bwhich\s+(?:rule|flow|class|trigger|component)\b[^.?!]{0,40}\b(?:threw|caused|blocked|fired)\b[^.?!]{0,40}\berror\b/,
      /\btrace\s+this\s+(?:save\s+)?error\b/,
      /\bexplain_error\b/,
    ],
  },
  {
    intent: 'tests-for-change',
    plane: 'vault',
    tools: ['sfi.tests_for_change'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Minimal test set that exercises the changed Apex (static call graph), plus the changed classes no test reaches.',
    patterns: [
      /\b(which|what)\s+tests?\b.*\b(run|chang|modif|deploy|impact|diff|edit)/,
      /\btests?\b.*\bfor\s+(my|this|the|these)\s+(change|changes|diff|deploy|branch|pr|edit|edits)\b/,
      /\b(test\s+impact|impacted\s+tests?|test\s+selection|minimal\s+(set\s+of\s+)?tests?|test\s+subset)\b/,
      /\bwhat\s+(do\s+i|should\s+i|to)\s+(run|test)\b.*\b(chang|deploy|diff)/,
      // "which/what test class COVERS <X> (and does it test the bulk case)" —
      // which tests exercise a named class is the tests_for_change call-graph
      // walk; the trailing "bulk" qualifier must not drag it onto
      // governor_limit_risks (eval family C).
      /\b(?:which|what)\s+test\s+class(?:es)?\b[^.?!]{0,20}\bcovers?\b/,
    ],
  },
  {
    intent: 'test-coverage',
    plane: 'vault',
    tools: ['sfi.apex_test_coverage', 'sfi.test_coverage_gaps', 'sfi.meaningful_test_audit'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Static test-reference coverage + untested-class backlog from the vault.',
    patterns: [
      /\b(test\s+coverage|untested|uncovered)\b/,
      /\bwhat\b.*\b(classes?|apex)\b.*\b(not\s+tested|no\s+tests?)\b/,
      /\b(apex\s+)?classes?\b.*\bwithout\b.*\btest\b/,
      /\b(no|without)\s+test\s+classes?\b/,
      /\bcoverage\s+gaps?\b/,
      // Test QUALITY (meaningful_test_audit): "fake assertions", "tests with no
      // real assertions", "meaningless tests". Battery gap (no route existed).
      /\b(fake|meaningless|empty|no\s+(real\s+)?)\s*assert/,
      /\btests?\b.*\bno\s+(real\s+)?assert/,
      /\bassertion\s+(quality|coverage)\b/,
      // "meaningful test audit on <X>" — the tool's own name as a natural-language
      // ask (USAGE/test-forensics REACH). Plus the classic no-op assertion tell
      // `System.assert(true)` / `assert(true)` that flags a rubber-stamp test.
      /\bmeaningful\s+test\s+audit\b/,
      /\bassert\w*\s*\(\s*true\s*\)/,
      /\b(less\s+than|below|under)\b.*\b\d+\s*%\b.*\bcoverage\b/,
      /\b(coverage|percent)\b.*\b(less\s+than|below|under)\b/,
      // "list apex classes below 75% coverage" — the `%\b` above never matches
      // "75% coverage" (%→space is not a word boundary), so the phrasing fell
      // through to the schema list rule and answered with get_component instead
      // of the coverage tools (eval family D).
      /\b(below|under|less\s+than)\s+\d+\s*(?:%|percent)?\s*(?:code\s+|test\s+)?coverage\b/,
      /\bcoverage\b[^.?!]{0,25}\b(below|under|less\s+than)\s+\d+/,
      /\bwhich\s+apex\s+classes\b.*\bcoverage\b/,
      /\bseealldata\s*=\s*true\b/i,
      /\bsee\s+all\s+data\b/i,
      /\btest\s+classes?\b.*\b(exist|in\s+this\s+org)\b/,
      /\bwhat\s+test\s+classes?\b/,
      /\btest\s+(methods?|classes?)\b.*\b(failing|fail)\b/,
      /\btest\s+(methods?|classes?)\b.*\b(do\s+not|without|no)\s+(contain\s+)?\b(system\.\s*)?assert/,
      /\btest\s+data\s+factory\b/,
      /\b(test\s+classes?|apex\s+tests?)\b.*\b(exercise|actually\s+test)\b/,
      /\bapex\s+tests?\b.*\b(take|duration|how\s+long)\b/,
    ],
  },
  {
    intent: 'trigger-quality',
    plane: 'vault',
    tools: ['sfi.automation_risk_report', 'sfi.code_quality_audit', 'sfi.governor_limit_risks'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Trigger inventory / quality — multiple triggers per object, handler-vs-body logic, recursion risk, and resource hotspots from vault synthesis + static analysis.',
    patterns: [
      /\bmore\s+than\s+one\s+trigger/,
      /\bmultiple\s+triggers?\b.*\b(object|on)\b/,
      /\bobjects?\b.*\bmore\s+than\s+one\s+trigger/,
      /\bbusiness\s+logic\b.*\btrigger\s+body/,
      /\btrigger\s+body\b.*\b(handler|logic)\b/,
      /\btriggers?\b.*\b(recursion|recursive)\b/,
      /\b(recursion|recursive)\b.*\btriggers?\b/,
      /\bresource[-\s]intensive\b.*\btrigger/,
      /\bmost\s+resource[-\s]intensive\b.*\btrigger/,
    ],
  },
  {
    intent: 'governor-risks',
    plane: 'vault',
    tools: ['sfi.governor_limit_risks', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Static governor-limit risks (SOQL/DML in loops, unbounded queries) from Apex source.',
    patterns: [
      /\bgovernor\s+(limit|risk)/,
      /\bovernor\s+limit\b/,
      /\b(soql|dml|query|queries)\b.*\b(in\s+(a\s+)?loop|loops?)\b/,
      // "show performance risks in apex" — performance/scale risk phrasing the
      // governor-limit recognizer answers. Battery gap.
      /\bperformance\s+(risk|issue|problem|concern|bottleneck)s?\b/,
      // "bulk" is a MODIFIER, not a head noun (eval family C): when the head
      // question is save-order ("what fires/runs/happens on X insert … what
      // runs bulk") or test coverage ("which test class covers Y … the bulk
      // case"), those earlier rules win by order — this guard keeps the bare
      // word from firing even when their patterns miss a phrasing.
      // …and "WHICH CLASS HANDLES the Boomi integration for BULK loads" is a
      // find-the-class source grep (apex-search), not a limit report (P4).
      /^(?!.*\b(?:what\s+(?:fires|runs|happens)|test\s+class|(?:which|what)\s+(?:apex\s+)?class(?:es)?\s+(?:handles?|processes?|implements?))\b).*\b(bulk|bulkif|unbounded)\b/,
      /\bcpu\s+time\b/,
      /\bheap\s+size\b/,
      /\bmost\s+dml\b/,
      /\bdml\s+operations?\b/,
      /\b50000|50,000\b.*\brecords?\b/,
      /\bquery\b.*\bmore\s+than\b.*\brecords?\b/,
      /\bat\s+risk\b.*\b(cpu|limit|governor)/,
      /\bselect\s+(all|\*)\b.*\bfields?\b/,
      /\bsoql\b.*\bwithout\b.*\blimit\b/,
      /\bleast\s+selective\b/,
      /\bquer(y|ies)\b.*\b(scale|won't|will\s+not)\b/,
      /\bquer(y|ies)\b.*\b(hit|exceed|approach)\b.*\b(governor\s+)?limits?\b/,
      /\b10x\b.*\b(data\s+volume|volume)/,
    ],
  },
  {
    intent: 'dependency-cycles',
    plane: 'vault',
    tools: ['sfi.find_dependency_cycles'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Cyclic Apex dependency clusters (Tarjan SCC) from the call graph.',
    patterns: [
      /\b(circular|cyclic|cycle|recursion|recursive)\b.*\b(dependenc(y|ies)|apex|class|call)\b/,
      /\b(dependenc(y|ies))\b.*\b(circular|cyclic)\b/,
      /\bdependency\s+cycles?\b/,
    ],
  },
  {
    // ROUTE-DEPLOY-PACKAGE-WORD-MISBINDS-PACKAGE-IMPACT — "is it safe to remove
    // this Flow FROM the package/changeset?" is a CHANGE-RISK question about a
    // deploy artifact (an unlocked/deploy package or change set you are pulling
    // a component OUT of), NOT a managed-package uninstall blast-radius question.
    // The bare word "package" next to "remove" used to bind the package-impact
    // rule below (namespace/InstalledPackage inventory). Cousin of the closed
    // ROUTE-INACTIVE-AUTOMATION-WORD-MISBINDS-USERS. This high-precision rule
    // sits FIRST and requires BOTH a metadata COMPONENT noun AND either (a) an
    // unambiguous deploy artifact (changeset / change set / deployment) with a
    // remove/promote/deploy verb, or (b) the "<verb> … FROM … package" container
    // framing — pulling a component out of a package. A managed-package retire
    // ("uninstall the acme package", "which classes does the package touch if we
    // remove it") never says "from the package" and keeps "uninstall"/"upgrade"
    // (absent here) so it still falls through to package-impact below.
    intent: 'review-change',
    plane: 'vault',
    tools: ['sfi.review_change'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Removing/promoting a specific component (Flow, Trigger, class, field) from a deploy package or change set is a per-component change-risk review (review_change: blocking/risky/review/safe + dependents + tests-to-run), not a managed-package uninstall footprint.',
    patterns: [
      // (a) unambiguous deploy artifact (changeset / deployment) + a remove/
      //     promote/deploy verb + a component noun — order-independent.
      /(?=.*\b(remov\w*|delet\w*|drop\w*|promot\w*|deploy\w*|ship\w*|revert\w*|back\s*out|exclud\w*|pull\w*)\b)(?=.*\b(flows?|triggers?|apex|class(?:es)?|component|field|validation\s+rule|layout|permission\s+set)\b).*\b(changeset|change\s+set|deployment)\b/,
      // (b) "<verb> … FROM … (the) package/changeset" container framing, with a
      //     component noun present — pulling a component OUT of a deploy package.
      /(?=.*\b(flows?|triggers?|apex|class(?:es)?|component|field|validation\s+rule|layout|permission\s+set)\b)\b(remov\w*|delet\w*|drop\w*|pull\w*|exclud\w*)\b[^.?!]{0,50}\bfrom\b[^.?!]{0,30}\b(the\s+)?(deploy(?:ment)?\s+|unlocked\s+)?(package|changeset|change\s+set)\b/,
    ],
  },
  {
    intent: 'package-impact',
    plane: 'vault',
    tools: ['sfi.package_impact'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Managed-package boundary surface — your components that reference a namespace (the uninstall blast radius), from the vault graph.',
    patterns: [
      /\b(managed\s+package|appexchange|installed\s+packages?)\b/,
      /\b(uninstall|upgrade|remove|removing)\b.*\bpackage\b/,
      /\bpackage\b.*\b(impact|depend|touch|safe|uninstall|upgrade|footprint)\b/,
      /\bnamespace\b.*\b(depend|impact|component|package|footprint)\b/,
      /\bwhat\b.*\b(does|breaks?)\b.*\b(package|namespace)\b/,
      // Extension-first phrasing (P12-ROUTER-extension-first): "what components
      // extend the X package" — your customizations grafted onto a managed
      // package's objects (the package_impact extensionCount surface).
      /\b(what|which)\s+(of\s+(my|our)\s+)?(components?|metadata|customizations?|objects?|fields?)\b.*\bextends?\b/,
      /\bextends?\b.*\b(package|namespace|managed)\b/,
      // "what custom fields did <Package> INJECT across <objects>? Inventory for
      // UNINSTALL" — a managed-package boundary/uninstall inventory named by the
      // package rather than the literal word "package". The uninstall/inventory
      // frame + the inject/add-across verb keep it on package_impact and off the
      // generic field-usage tools (USAGE/IMPACT REACH — package boundary).
      /\b(inject\w*|add\w*|install\w*)\b[^.?!]{0,40}\bacross\b[^.?!]{0,60}\b(objects?|lead|contact|account|case|opportunity)\b[^]*\b(uninstall|inventory)\b/,
      /\binventory\s+for\s+uninstall\b/,
    ],
  },
  {
    intent: 'dead-code',
    plane: 'vault',
    tools: ['sfi.find_dead_code'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Unreferenced / unreachable Apex from static analysis.',
    // B23 reconciliation: find_dead_code is the ONE canonical dead-code tool.
    // Catch the dead/unused/unreachable/never-called phrasings in BOTH word
    // orders, scoped to CODE units (apex/class/method/trigger/code) so this
    // never steals the field-specific (`unused-fields`) or broad-component
    // (`unused-components`) intents that follow.
    patterns: [
      /\b(dead|unreachable|unused)\s+code\b/,
      /\b(unused|dead|unreachable)\b.*\b(apex|class(?:es)?|method(?:s)?|trigger(?:s)?)\b/,
      /\b(apex|class(?:es)?|method(?:s)?|trigger(?:s)?)\b.*\b(unused|dead|unreachable|never\s+(?:called|used|invoked|run|reached)|not\s+(?:called|used|invoked|reached))\b/,
      /\bnever\s+(?:called|used|invoked|reached)\b.*\b(apex|class(?:es)?|method(?:s)?|code)\b/,
      /\bno\s+longer\s+referenced\b/,
      /\b(not\s+referenced|unreferenced)\b.*\banywhere\b/,
    ],
  },
  {
    intent: 'clone-patterns',
    plane: 'vault',
    tools: ['sfi.find_clone_patterns'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Copy-paste / near-duplicate Apex from the vault.',
    patterns: [
      /\b(clone|duplicate|copy[-\s]?paste|near[-\s]?duplicate)\b.*\b(code|apex|class|logic|flows?)\b/,
      /\bduplicated?\s+(logic|code)\b/,
      /\bcopy_of_\b/,
    ],
  },
  {
    intent: 'subgraph',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_subgraph'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Bounded dependency subgraph around a named component — BFS slice of the vault graph.',
    patterns: [/\bsubgraph\b/],
  },
  {
    // M14 — a CPQ price/product/discount RULE CHAIN for a specific product.
    // The vault call-graph rule below catches "rule chain" via /\w+\s+chain/ and
    // leads with call_graph. Require pric*/product/discount immediately before
    // "rule chain" so the org-wide "whole CPQ rule chain" (cpq_dependency_map)
    // stays put.
    intent: 'cpq-rule-chain',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.cpq_rule_chain'],
    liveRequired: false,
    needsResolve: true,
    reason: 'The CPQ price/product/discount rule chain for a specific product (cpq_rule_chain).',
    patterns: [
      new RegExp('\\bcpq\\b[^.?!]{0,30}\\b(pric\\w+|product|discount)\\s+rules?\\s+chain\\b'),
    ],
  },
  {
    intent: 'call-graph',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.call_graph', 'sfi.method_reachability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'What calls / is reachable from a method — call-graph traversal.',
    patterns: [
      /\bwhat\s+calls?\b/,
      /\b(call\s+graph|reachab|who\s+calls)\b/,
      /\bis\b.*\b(reachable|called)\b/,
      /\b(bootstrap|callers?)\b.*\b(path)\b/,
      /\bpath\b.*\b(and\s+)?callers?\b/,
      /\b\w+\s+chain\b/,
      /\bdependency\s+tree\b/,
      /\bfull\s+dependency\b.*\btrigger/,
    ],
  },
  {
    intent: 'lwc-dependencies',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_code_usages', 'sfi.call_graph'],
    liveRequired: false,
    needsResolve: true,
    reason: 'What Apex/flows an LWC bundle depends on — scanner edges + call graph.',
    patterns: [
      /\b(lwc|lightning\s+web\s+component)\b.*\b(depend|uses?|calls?)\b/,
      /\bwhat\b.*\b(apex|flows?)\b.*\b(lwc|lightning)\b.*\b(depend|uses?|calls?)\b/,
      /\blwc\s+bundles?\b/,
      /\blwc\s+bundle\b.*\bnot\s+a\s+flow\b/,
      /\bwhich\s+lwcs?\b.*\bcall\b.*\bapex\b/,
      /\blwcs?\b.*\b(lightning\s+data\s+service|\blds\b)/i,
      /\b(lightning\s+data\s+service|\blds\b).*\blwcs?\b/i,
      /\bcustom\s+labels?\b.*\b(in|referenced).*\b(lwc|lightning)/i,
      /\bvisualforce\b.*\b(migrat|should\s+be\s+migrated)\b.*\blwc/i,
      /\bwhich\s+aura\s+components?\b.*\b(in\s+use|still)\b/,
    ],
  },
  {
    intent: 'explain-apex',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_apex_method'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Plain-English narration of an Apex class/method.',
    patterns: [
      /\bwhat\s+does\b.*\b(class|method|trigger|apex)\b.*\bdo\b/,
      /\bexplain\b.*\b(class|method|trigger|apex)\b/,
      // Named triggers like OpportunityTrigger — \btrigger\b misses the suffix token.
      /\bwhat\s+does\b.*\b\w+Trigger\b.*\bdo\b/i,
      /\bwhat\s+does\b.*\bthe\b.*\b(lwc|component)\b.*\bdo\b/i,
      // M37 — "what the <method> method does" is "what ... method ... does", not
      // the "what does ... do" the patterns above require. Ends-with-"?" golds
      // ("what tests cover the <M> method?") can't cross the "?" to a trailing do/does.
      /\bwhat\b[^.?!]{0,40}\bmethod\b[^.?!]{0,15}\bdo(?:es)?\b/,
    ],
  },
  {
    intent: 'code-quality',
    plane: 'vault',
    tools: ['sfi.code_quality_audit'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Static code-quality audit (standards, anti-patterns) from the vault.',
    patterns: [
      /\bcode\s+quality\b/,
      /\bode\s+quality\b/,
      /\b(anti[-\s]?patterns?|code\s+smell|best\s+practices?)\b/,
      /\bhow\s+(good|clean)\b.*\bcode\b/,
      /\bquality\s+audit\b/,
      /\b(security\s+issues?|security\s+risks?)\b.*\b(apex|classes?)\b/,
      /\b(apex\s+)?classes?\b.*\b(security\s+issues?|security\s+risks?)\b/,
      /\bwithout\s+sharing\b.*\b(apex|classes?)\b/,
      /\b(apex\s+)?classes?\b.*\bwithout\s+sharing\b/,
    ],
  },
  {
    // R7-W6: pre-deploy change review over a CALLER-ASSEMBLED change set (a
    // PR / package.xml / git diff) — never a bare question's primary answer
    // since it needs the `components` array as input, but the deploy-gate
    // vocabulary ("review this PR/changeset", "is this deploy safe", "what
    // does this PR break") is distinct CI/deploy language no earlier rule
    // claims. Anchored on a NAMED deploy artifact (PR/changeset/deployment/
    // package.xml/diff) so it never fires on the ORG-WIDE "is the org ready to
    // go live" ask (release-readiness, below) — none of these patterns use
    // "ready"/"readiness". Placed BEFORE release-readiness so the specific
    // artifact-scoped ask wins first-match.
    intent: 'review-change',
    plane: 'vault',
    tools: ['sfi.review_change'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'A per-component risk verdict (blocking/risky/review/safe), direct dependents, and tests-to-run for a SPECIFIC change set — review_change composes get_impact + tests_for_change over the components a host assembles from a PR / package.xml / git diff. Needs that `components` array supplied by the caller.',
    patterns: [
      /\breview\s+(?:this|my|the)\s+(?:changeset|change\s+set|deploy(?:ment)?|pr|pull\s+request|package)\b/,
      /\bis\s+(?:this|my)\s+deploy(?:ment)?\s+safe\b/,
      /\bis\s+it\s+safe\s+to\s+(?:ship|deploy)\b/,
      /\bwhat\s+(?:does|will|would)\s+this\s+(?:pr|pull\s+request|change\s*set|deploy(?:ment)?)\s+break\b/,
      /\bpre[-\s]?deploy(?:ment)?\s+(?:review|risk\s+check|gate)\b/,
      /\bgate\s+my\s+deploy\b/,
      /\brisk\s+check\s+on\s+(?:my|this)\s+diff\b/,
      /\bwhich\s+of\s+(?:my|these)\s+changes\s+are\s+(?:blocking|risky|safe)\b/,
      /\breview\s+(?:the\s+)?components?\s+in\s+(?:this\s+|my\s+)?package\.xml\b/,
      /\breview_change\b/,
      // Access-parity ("ships for nobody") phrasings — the grant-completeness
      // half of the deploy gate. Anchored on a deploy/release artifact so they
      // never steal from the field/object access-audit rules (which key on a
      // SPECIFIC object/field, not a release/changeset/PR).
      /\bships?\s+for\s+nobody\b/,
      /\bdid\s+i\s+forget\s+(?:the\s+)?permission\s+set\b/,
      /\bdoes\s+(?:this|my)\s+(?:release|deploy(?:ment)?|changeset|change\s+set|pr|pull\s+request)\b[^.?!]{0,40}\bship\b[^.?!]{0,20}\bpermissions?\b/,
      /\bdid\s+(?:this|my|the)\s+(?:release|deploy(?:ment)?|changeset|change\s+set|pr|pull\s+request)\b[^.?!]{0,40}\b(?:include|ship|grant)\b[^.?!]{0,30}\b(?:access|permissions?|permission\s+set|profile)\b/,
    ],
  },
  {
    // M27 — sandbox → production PROMOTION readiness. The release-readiness rule
    // below leads with org_risk_report and its (ready|readiness).*production
    // pattern swallows this; key on the specific promote-to-prod verb instead.
    intent: 'promotion-readiness',
    plane: 'vault',
    tools: ['sfi.promotion_readiness'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Sandbox-to-production promotion readiness (promotion_readiness), distinct from the generic release-readiness synthesis.',
    patterns: [
      /\b(promote|promotion)\b[^?!]{0,30}\b(prod|production)\b/,
      /\bsandbox\b[^?!]{0,30}\bpromote\b/,
    ],
  },
  {
    intent: 'release-readiness',
    plane: 'vault',
    // STEP-2: release_readiness_report retired to a hidden alias; org_risk_report
    // (its `gate: true` MODE emits ready+blockers) leads this rule now.
    tools: ['sfi.org_risk_report', 'sfi.tech_debt_score'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Release / go-live readiness is a vault synthesis (org_risk_report gate mode + tech debt).',
    patterns: [
      /\brelease\s+readiness\b/,
      /\b(ready|readiness)\b.*\b(release|deploy|go[-\s]?live|cutover|production)\b/,
      /\bpre[-\s]?release\b.*\b(check|review|audit)\b/,
      /\bgo[-\s]?live\b.*\b(risk|readiness|checklist)\b/,
      // DISCOVERY/META REACH: "is this org release-ready for the summer push,
      // or are there blockers" — the hyphenated "release-ready" adjective and
      // the "blockers" framing the patterns above missed (they keyed on
      // "release readiness"/"ready … [to] release"). Co-anchored on
      // release/deploy/ship so a generic "are we ready for the demo" (no
      // release verb) does not match.
      /\brelease[-\s]?ready\b/,
      /\b(?:blockers?|showstoppers?)\b[^.?!]{0,40}\b(?:release|deploy|ship|go[-\s]?live|production|cutover)\b/,
      /\b(?:release|deploy|ship|go[-\s]?live|production|cutover)\b[^.?!]{0,40}\b(?:blockers?|showstoppers?)\b/,
    ],
  },
  // === Vault health / freshness / coverage (vault) ==========================
  {
    intent: 'vault-health',
    plane: 'vault',
    tools: ['sfi.health_check', 'sfi.coverage_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Vault health, freshness, and metadata coverage are self-reported by health_check / coverage_report.',
    patterns: [
      // "is the vault healthy" — health_check had NO route at all. Battery gap.
      /\bis\s+the\s+(vault|org|data|graph)\b.*\bhealth/,
      /\b(vault|graph)\b.*\b(health(y)?|stale|out[-\s]of[-\s]date)\b/,
      /\bhealth[-\s]?check\b/,
      // "how fresh is the data" — freshness of the snapshot.
      /\bhow\s+(fresh|old|stale|current|recent)\b.*\b(data|vault|refresh|snapshot)\b/,
      /\bis\s+the\s+vault\s+fresh\b/,
      /\bvault\s+fresh\b/,
      // "what is covered in this vault" — coverage scope (tied to vault/metadata
      // so it doesn't collide with the earlier test-coverage route).
      /\bcovered\b.*\b(vault|metadata)\b/,
      /\bwhat\b.*\bcovered\b.*\b(vault|org)\b/,
      /\bnotmodeled\b/,
      /\bnever[-\s]?modeled\b/,
    ],
  },
  {
    // M21 — multi-org fleet search ("which orgs across the fleet have <package>").
    // package-inventory below claims "package installed" for the single-org
    // catalog; require an orgs+fleet frame AND a package/component token so the
    // fleet-drift-ranking gold ("which orgs in our fleet have drifted") is untouched.
    intent: 'fleet-find',
    plane: 'vault',
    tools: ['sfi.fleet_find'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Search the org fleet for those matching a criterion (fleet_find), not the single-org package catalog.',
    patterns: [
      new RegExp('\\borgs?\\b[^.?!]{0,20}\\bfleet\\b[^.?!]{0,50}\\b(installed|package|component|using|use)\\b'),
    ],
  },
  {
    intent: 'package-inventory',
    plane: 'vault',
    tools: ['sfi.installed_package_catalog', 'sfi.coverage_report', 'sfi.org_overview'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Installed managed/unlocked packages are catalogued from InstalledPackage metadata by installed_package_catalog (namespace + version); coverage_report / org_overview give the broader namespace footprint. Not live data.',
    patterns: [
      /\b(managed\s+)?packages?\b.*\b(installed|in\s+(this|the)\s+org)\b/,
      /\binstalled\s+(managed\s+)?packages?\b/,
      /\bwhat\s+packages?\b.*\b(installed|namespaces?)\b/,
      /\bhow\s+many\b.*\bpackages?\b.*\b(installed|managed)\b/,
      /\bwhat\s+is\s+the\s+namespace\b/,
      /\bnamespace\b.*\b(this\s+)?org\b/,
    ],
  },
  {
    // Components REFERENCED by the org's automation/code/config but never
    // retrieved — the honest backing for absence answers. Narrow patterns so
    // this never steals the `test-coverage` intent (it owns "coverage gaps").
    intent: 'retrieve-blindspot',
    plane: 'vault',
    tools: ['sfi.retrieve_blindspot_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Referenced-but-unretrieved components (the vault\'s blind spots) are reported by retrieve_blindspot_report — the honest backing for absence answers.',
    patterns: [
      /\bblind[-\s]?spots?\b/,
      /\breferenced\b.*\b(but|yet)\b.*\b(not\s+)?(retrieved|pulled|modeled|in\s+the\s+(vault|manifest))\b/,
      /\b(what|which)\b.*\b(refresh|retrieve|manifest)\b.*\b(miss(ed|ing)?|skip(ped)?|never\s+(pulled|retrieved))\b/,
      /\bretrieve[-\s]?manifest\s+gaps?\b/,
      /\bnot\s+being\s+pulled\b/,
      // M30 — "what metadata types are we NOT tracking/deploying/retrieving" is a
      // retrieve blind-spot; the existing anchors ("blind spot", "referenced but
      // not retrieved", "not being pulled") missed this framing.
      new RegExp('\\b(what|which)\\s+metadata\\s+types?\\b[^?!]{0,40}\\b(not|aren.?t|never)\\b[^?!]{0,20}\\b(track|deploy|retriev|pull)'),
    ],
  },
  {
    // DOCUMENTATION-COVERAGE gap meter — where the org's metadata is
    // undocumented (missing `description` / `inlineHelpText`), ranked
    // worst-covered first and weighted by graph edge-degree. Anchored on
    // documentation-coverage / undocumented / missing-descriptions /
    // missing-help-text vocabulary so it never steals the test-coverage route
    // ("coverage gaps" / "test coverage") or the single-field explain_field
    // help-text lookup ("what is the help text for X" — a BARE help-text mention
    // with no gap/coverage qualifier stays with explain_field). Placed before
    // tech-debt so a documentation-coverage ask lands on the doc axis
    // tech_debt_score lacks, not the generic debt score.
    intent: 'doc-coverage',
    plane: 'vault',
    tools: ['sfi.doc_coverage_report'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Offline documentation-coverage gap meter — which custom metadata lacks a description / inline help text, ranked worst-covered first and weighted by graph edge-degree. The documentation axis sfi.tech_debt_score lacks; distinct from the Apex test-coverage tools.',
    patterns: [
      /\bdoc_coverage_report\b/,
      // "documentation coverage / gaps / debt / completeness / quality / health".
      /\bdocumentation\s+(coverage|gaps?|debt|completeness|quality|health)\b/,
      /\bdocs?\s+coverage\b/,
      // "undocumented" (fields / objects / metadata / components).
      /\bun-?documented\b/,
      // "(which|what) ... (fields|objects|components|metadata) ... not/never documented".
      /\b(fields?|objects?|components?|metadata)\b[^.?!]{0,40}\b(not|aren.?t|never)\s+documented\b/,
      // "(lack|missing|without|no) ... description(s) / documentation".
      /\b(lack|lacks|lacking|missing|without|no)\b[^.?!]{0,30}\b(descriptions?|documentation)\b/,
      // "description(s) ... (missing|blank|empty|absent|coverage|gaps)".
      /\bdescriptions?\b[^.?!]{0,25}\b(missing|blank|empty|absent|coverage|gaps?)\b/,
      // Help text WITH a gap/coverage qualifier — a bare "help text for X" lookup
      // stays with explain_field (which owns the single-field help-text bubble).
      /\b(missing|no|without|lacks?|lacking|blank|empty)\b[^.?!]{0,25}\b(inline\s+)?help\s*text\b/,
      /\b(inline\s+)?help\s*text\b[^.?!]{0,25}\b(coverage|missing|gaps?|blank|empty|completeness)\b/,
    ],
  },
  {
    intent: 'tech-debt',
    plane: 'vault',
    tools: ['sfi.tech_debt_score', 'sfi.org_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Org tech-debt / risk score synthesized from the vault.',
    patterns: [
      /\b(tech(nical)?\s+debt|apex\s+score)\b/,
      /\bdebt\s+score\b/,
      /\bech\s+debt\b/,
      /\bhow\s+(healthy|bad|risky)\b.*\borg\b/,
      /\borg\s+(risk|health)\b/,
      // "what should we clean up" — general cleanup ask (the cleanup-FIELDS route
      // above only matched "clean up ... fields"). Battery gap.
      /\bwhat\b.*\b(clean\s+up|cleanup)\b/,
      /\boverall\s+health\b.*\borg\b/,
      /\btop\s+risks?\b/,
      /\btechnical\s+roadmap\b/,
      /\broadmap\s+recommendation\b/,
      /\bis\s+(this\s+)?org\b.*\bwell[-\s]?architected\b/,
      /\bgovernance\s+gaps?\b/,
      /\bmaintainability\b/,
      /\bhighest[-\s]priority\b.*\b(address|fix|items?)\b/,
      /\bbest[-\s]practice\b.*\bbenchmark/,
      /\borg\s+consolidat/,
      /\bcompare\b.*\bbest\s+practices?\b/,
      /\bfeatures?\b.*\b(paid\s+for\s+but\s+not\s+used|unused)\b/,
      /\bmetadata\b.*\b(documented|documentation)\b/,
    ],
  },
  {
    // API-version hygiene ("any apex still on API version below 50?") was
    // unrouted — the schema rule only covers the single-component "what is the
    // api version of X" lookup (eval family D). tech_debt_score carries the
    // roll-up (apexBelowApiVersion30/40/50Count) and list_components(type:
    // ApexClass) enumerates the classes with each node's apiVersion.
    intent: 'api-version-audit',
    plane: 'vault',
    tools: ['sfi.tech_debt_score', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Old-API-version inventory: tech_debt_score counts Apex below API version 30/40/50, and list_components(type: ApexClass) carries each class apiVersion.',
    suggestArgs: () => ({ type: 'ApexClass' }),
    patterns: [
      /\bapi\s+versions?\b[^.?!]{0,25}\b(below|under|older|before|less\s+than)\b/,
      /\b(old|outdated|legacy|ancient)\b[^.?!]{0,15}\bapi\s+versions?\b/,
      /\b(apex|class(es)?|components?|metadata|flows?|triggers?)\b[^.?!]{0,40}\b(still\s+on|stuck\s+on|running\s+on)\b[^.?!]{0,15}\bapi\s+version/,
      /\b(upgrad|updat|bump)\w*\b[^.?!]{0,25}\bapi\s+versions?\b/,
      /\bapi\s+versions?\b[^.?!]{0,25}\b(upgrad|updat|bump)/,
    ],
  },
  {
    // "Which classes implement <interface>" (Batchable, Schedulable, Queueable,
    // RestResource, ...) — grep Apex source for the implements clause. The
    // apex-search verbs (uses/references) didn't cover "implement" (B21.16/17,
    // E.4-6 / BL-13 interface filters).
    intent: 'interface-implementers',
    plane: 'vault',
    tools: ['sfi.search_apex_source', 'sfi.find_code_usages'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Classes implementing an interface (Batchable / Schedulable / Queueable / RestResource) are found by grepping Apex source for the implements clause.',
    patterns: [
      /\b(which|what)\s+(classes?|apex)\b.*\bimplements?\b/,
      /\bimplements?\b.*\b(batchable|schedulable|queueable|database\.\w+|interface)\b/,
      /\b(batchable|schedulable|queueable)\b.*\b(classes?|implement)\b/,
      /\b(batchable|schedulable|queueable)\b.*\b(jobs?|exist)\b/,
      /\bwhat\s+(queueable|batchable|schedulable)\b.*\b(jobs?|exist)\b/,
    ],
  },
  {
    intent: 'apex-search',
    plane: 'vault',
    tools: ['sfi.search_apex_source', 'sfi.find_code_usages'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Text grep over Apex source + usage edges.',
    // A dotted CODE LITERAL in the question ("System.debug") is the grep text —
    // bind it so the routed search_apex_source call is executable as-is.
    suggestArgs: (q) => {
      const literal = q.match(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/)?.[0];
      return literal !== undefined ? { query: literal } : undefined;
    },
    patterns: [
      /\bfind\b.*\b(class|apex|code)\b.*\b(mentions?|references?|uses?|calls?|reads?|writes?|with)\b/,
      /\b(which|what)\s+(classes?|apex)\b.*\b(mentions?|references?|uses?|touch(es)?|reads?|writes?|calls?|invokes?)\b/,
      /\bsearch\b.*\b(apex|code)\b/,
      // Router-v2 P4 (q522 family): a CODE-LITERAL search — "does anything
      // call System.debug", "leftover System.debug statements" — is a source
      // grep, never the runtime-audit-trail fallback ("debug logs" in the
      // prose must not swallow it; this rule sits earlier, so the literal
      // wins).
      /\bsystem\.debug\b/,
      /\b(?:calls?|calling|invokes?|references?)\b[^.?!]{0,40}\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\s*\(/,
      // "which apex class HANDLES the Boomi integration" — find-the-class-by-
      // what-it-does is a source/usage grep, not a code-quality report.
      /\b(?:which|what)\s+(?:apex\s+)?class(?:es)?\b[^.?!]{0,60}\b(?:handles?|processes?|implements?|integrates?|owns?)\b/,
      // "which classes make HTTP callouts and what endpoints do they hit" —
      // HTTP callouts live in Apex SOURCE, so the answer is a source grep,
      // not the outbound endpoint catalog and never field lineage (eval
      // family C). "What endpoints do we call out to?" (no "callout" noun,
      // no HTTP) stays on the outbound endpoints catalog below.
      /\bhttp\s+callouts?\b/,
      /\bcallouts?\b[^.?!]{0,50}\bendpoints?\b/,
    ],
  },
  {
    // "Does <the named class/job> run async — in its own transaction?" is a
    // question about ONE component's actual implementation (its @future /
    // Queueable / Batchable shape, read from its source via get_component),
    // not a best-practice lecture — the "async" qualifier was dragging it
    // onto the generic knowledge-plane guidance rule (eval family C).
    intent: 'async-transaction-context',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Whether a named component runs async in its own transaction is read from its OWN source/metadata (resolve it, then get_component shows the @future/Queueable/Batchable shape) — not generic async guidance.",
    patterns: [
      /\basync\w*\b[^.?!]{0,80}\bown\s+transaction\b/,
      /\bown\s+transaction\b[^.?!]{0,80}\basync\w*/,
      /\bin\s+its\s+own\s+transaction\b/,
    ],
  },

  // === Integration (vault) ==================================================
  {
    // Named-credential reference/orphan checks — must precede integration-map
    // (which also matches "named credential" generically).
    intent: 'component-usage',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_component_usages', 'sfi.integration_map'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Whether a named credential is referenced is a usage lookup (find_component_usages), not a topology catalog question.',
    suggestArgs: (q, question) => {
      const src = question ?? q;
      const nc = src.match(/\bnamed\s+credential\s+([A-Za-z0-9_]+)/i)?.[1];
      if (nc !== undefined) return { componentId: `NamedCredential:${nc}` };
      return undefined;
    },
    patterns: [
      /\b(named\s+credential|namedcredential)\b.*\b(referenced|orphan|orphaned|zero\s+reference|no\s+reference|unreferenced|used)\b/i,
      /\b(referenced|orphan|orphaned|zero\s+reference|unreferenced)\b.*\b(named\s+credential|namedcredential)\b/i,
    ],
  },
  {
    // M3 — "is it safe to change <field> VALUES — what integrations would desync".
    // integration-map fires first on the bare "integrations" token; key on the
    // value/desync framing to the RIGHT of the dotted field name (the period in
    // Contact.Email blocks any left-spanning anchor).
    intent: 'what-if-change-field-value',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_change_field_value', 'sfi.value_change_audit'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Blast radius of changing a field VALUE (what_if_change_field_value) — which integrations/automations desync.',
    patterns: [
      /\bvalues?\b[^.?!]{0,45}\bde-?sync\w*/,
      /\bvalues?\b[^.?!]{0,45}\bintegrations?\s+would\b/,
    ],
  },
  {
    intent: 'integration-map',
    plane: 'vault',
    tools: ['sfi.integration_map'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Topology of the org\'s integration surfaces (named creds, connected apps, remote sites, external services).',
    // Guarded (eval family C — qualifier hijack): "integration"/vendor-sync
    // words are MODIFIERS when the head question is a what-if simulation
    // ("if the field type changed, what integrations blow up"), a blast
    // radius ("blast radius if I disable trigger T"), a field-write audit,
    // or profile IP security — those heads route earlier / later on their
    // own rules, so the bare noun must not force the topology catalog.
    patterns: [
      /^(?!.*\b(?:what\s+if|blast\s+radius|what\s+breaks|blows?\s+up|field\s+type|data\s+type|written\s+(?:only\s+)?by|only\s+ever\s+written|ip\s+relax\w*|disabl\w+)\b).*\b(integrations?|named\s+credentials?|connected\s+apps?|remote\s+sites?|external\s+services?|auth\s+providers?)\b/,
      /^(?!.*\b(?:what\s+if|blast\s+radius|what\s+breaks|blows?\s+up|field\s+type|data\s+type|written\s+(?:only\s+)?by|only\s+ever\s+written|ip\s+relax\w*|disabl\w+)\b).*\bwhat\b.*\bintegrat/,
      /\bapi\b.*\b(connections?|surfaces?)\b/,
    ],
  },
  {
    // LANE-E — CHANGE DATA CAPTURE, both frames.
    //
    // The SUBSCRIBER frame ("who subscribes to CDC on Account") already
    // routed; the ENABLEMENT frame ("which objects have change data capture
    // enabled in this org?") — the way the question is actually asked —
    // matched nothing, fell through to `unrouted`, and the funnel's top pick
    // blew the response budget so the user got an oversize error and no
    // answer. Both frames now land on `sfi.event_topology`, which reports
    // enablement (the channel-member selection), the code that reacts, and
    // whether a zero is a CHECKED zero.
    //
    // `sfi.cdc_subscribers` is a hidden back-compat alias and is deliberately
    // NOT routed here (a retired roster entry keeps working by name only).
    intent: 'cdc-subscribers',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.event_topology', 'sfi.event_subscribers'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Change Data Capture: which entities have it enabled and what reacts to the stream (event_topology), distinct from platform-event subscribers.',
    patterns: [
      /\b(change\s+data\s+capture|cdc)\b[^.?!]{0,40}\b(subscrib\w*|listen\w*|consum\w*)\b/,
      /\b(subscrib\w*|listen\w*|consum\w*)\b[^.?!]{0,30}\b(change\s+data\s+capture|cdc)\b/,
    ],
  },
  {
    // LANE-E — the CDC ENABLEMENT frame, which had NO rule at all.
    //
    // "Which objects have change data capture enabled in this org?" is the
    // owner's own phrasing and it fell through to `unrouted`; the funnel's
    // top pick then blew the ~40 KB response budget, so the user got an
    // `oversize` error and no answer. The SUBSCRIBER frame above routed fine
    // the whole time — the gap was the frame, not the capability.
    //
    // Separate rule rather than more patterns on the rule above because this
    // frame names NO component (`needsResolve: false`): telling the host to
    // resolve a component the user never mentioned is the same defect the D6
    // event-catalog fix removed. `event_topology` narrows by `objectApiName`
    // when one IS named, so a bare call stays correct either way.
    //
    // Deliberately keyed on the STATE ("turned on", "enabled", "selected"),
    // never the ACT ("turning on CDC for Contact"), so the fan-out question
    // that legitimately belongs to the subscriber rule above is untouched.
    intent: 'cdc-enablement',
    plane: 'vault',
    tools: ['sfi.event_topology'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Which entities have Change Data Capture enabled — read from the PlatformEventChannelMember selections, with the coverage that makes a zero readable as checked or unchecked (event_topology).',
    patterns: [
      /\b(change\s+data\s+capture|cdc)\b[^.?!]{0,40}\b(enabled?|turned\s+on|switched\s+on|selected)\b/,
      /\b(enabled?|turned\s+on|switched\s+on|selected)\b[^.?!]{0,30}\b(change\s+data\s+capture|cdc)\b/,
      /\b(objects?|entities|entity|sobjects?)\b[^.?!]{0,40}\b(change\s+data\s+capture|cdc)\b/,
      /\b(change\s+data\s+capture|cdc)\b[^.?!]{0,40}\b(objects?|entities|entity|sobjects?)\b/,
    ],
  },
  {
    intent: 'event-subscribers',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.event_subscribers', 'sfi.cdc_subscribers'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Who subscribes to a specific platform event / change data capture channel.',
    patterns: [
      /\b(platform\s+events?|change\s+data\s+capture|cdc)\b.*\b(subscrib|listen|consum)\b/,
      /\bwho\s+(subscribes?|listens?)\b/,
      /\b(subscribers?|subscriptions?)\b.*\bevents?\b/,
      /\bshow\s+event\s+subscribers?\b/,
      // CDC fan-out / subscriber discovery (flow-family REACH). "what's
      // SUBSCRIBING TO Change Data Capture" (verb precedes the noun, so the
      // noun→verb pattern above misses it), "if turning on CDC for X will fan
      // out", and "CDC or platform-event subscribers feeding Marketo" (hyphenated
      // "platform-event" the space-only alternation above misses). Anchored to a
      // CDC/platform-event noun so a generic "who subscribes" is unaffected.
      /\b(subscrib\w*)\b[^.?!]{0,30}\b(change\s+data\s+capture|cdc|platform[-\s]?events?)\b/,
      /\b(turn\w*\s+on|enabl\w+)\s+cdc\b/,
      /\bcdc\b[^.?!]{0,40}\bfan\s+out\b/,
      /\b(cdc|change\s+data\s+capture|platform[-\s]?events?)\b[^.?!]{0,40}\bsubscribers?\b/,
    ],
  },
  {
    // "What platform events does this org publish / exist?" → CATALOG mode
    // (event_subscribers with NO eventId). No named component to resolve —
    // distinct from who-subscribes-to-EVENT-X above. NI-1: follow-up to the D6
    // catalog fix so the route stops telling the agent to resolve a component
    // that was never named.
    intent: 'event-catalog',
    plane: 'vault',
    // LANE-E: repointed from `event_subscribers` (which answers the Platform
    // Event half confidently and silently drops the CDC half, and says
    // nothing about the events the org NAMES but the vault never retrieved)
    // to the front door that answers both and reports retrieval coverage as
    // data. `event_subscribers` stays second for the single-event follow-up.
    tools: ['sfi.event_topology', 'sfi.event_subscribers'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "The org's event plane: every Platform Event with its publishers/subscribers, the entities with Change Data Capture enabled, the channels carrying both, and the events referenced but never retrieved (event_topology).",
    patterns: [
      /\bwhat\s+(platform\s+events?|cdc\s+channels?)\b/,
      /\b(platform\s+events?)\b.*\b(publish|emit|defined|exist|list|are\s+there)\b/,
      /\bplatform\s+events?\b(?:\s+in\s+(?:this\s+)?(?:the\s+)?org)?\b/,
      // "event channels" — the owner's second goal, previously unrouted.
      /\bevent\s+channels?\b/,
      /\bplatform\s*event\s*channel\s*members?\b/,
    ],
  },
  {
    // Inbound Apex REST (@RestResource) — "what REST endpoints are exposed".
    // MUST precede the outbound `endpoints` rule, which would otherwise grab
    // "endpoints" and misroute to the outbound catalog (B21.15).
    intent: 'rest-endpoints',
    plane: 'vault',
    tools: ['sfi.search_apex_source', 'sfi.find_code_usages'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Inbound Apex REST endpoints are @RestResource/@Http* classes — grep Apex source for the annotations.',
    patterns: [
      /\b(apex\s+)?rest\s+(endpoints?|resources?|services?|api)\b/,
      /\b@?restresource\b/,
      /\b(inbound|exposed|expose)\b.*\brest\b/,
      /\brest\b.*\b(endpoints?|resources?)\b.*\b(expose|exposed|apex|class)\b/,
      /\b@?auraenabled\b/,
      /\b(apex\s+)?methods?\b.*\b(exposed|expose)\b.*\b(apex|lwc|aura|lightning|class)\b/,
      /\bwhat\s+methods?\b.*\b(exposed|expose)\b.*\b(class|apex|rest)\b/,
    ],
  },
  {
    // M26 — the OUTBOUND MESSAGE catalog. The endpoints rule below leads with
    // endpoint_catalog and its pattern matches "outbound messages"; key on the
    // distinct outbound-message noun so outbound_message_catalog leads.
    intent: 'outbound-messages',
    plane: 'vault',
    tools: ['sfi.outbound_message_catalog'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Configured Outbound Messages (outbound_message_catalog), distinct from the broader endpoint catalog.',
    patterns: [/\boutbound\s+messages?\b/],
  },
  {
    intent: 'endpoints',
    plane: 'vault',
    tools: ['sfi.endpoint_catalog', 'sfi.outbound_message_catalog'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Outbound endpoints / callouts / outbound messages catalog from the vault.',
    patterns: [
      /\b(endpoints?|callouts?|outbound\s+messages?)\b/,
      /\bwhat\b.*\b(external\s+(urls?|endpoints?|systems?))\b/,
      /\bwhere\s+do\s+we\s+(call|send)\b/,
    ],
  },

  // === Cleanup / impact / what-if (vault, hybrid) ===========================
  {
    // M17 — "which fields can we SAFELY DELETE" = ranked cleanup roster
    // (field_cleanup_candidates). Currently unrouted: unused-fields needs
    // unused/dead/cleanup; unused-components needs "can we delete"; safe-to-delete
    // needs "safe to delete"/"can i delete" — none match "which fields ... safely delete".
    intent: 'field-cleanup-candidates',
    plane: 'vault',
    tools: ['sfi.field_cleanup_candidates', 'sfi.unused_fields_deep'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Ranked field cleanup candidates safe to delete (field_cleanup_candidates).',
    patterns: [/\b(which|what)\s+fields?\b[^.?!]{0,25}\bsafely\s+delete\b/],
  },
  {
    intent: 'unused-fields',
    plane: 'hybrid',
    // STEP-2: field_cleanup_candidates retired to a hidden alias; its ranked
    // cleanup roster is now unused_fields_deep's `format: 'cleanup'` MODE, so the
    // survivor (already leading) absorbs the cleanup phrasings.
    tools: ['sfi.unused_fields_deep', 'sfi.live_field_population'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Dead-vs-alive: vault references say "unreferenced"; live population confirms truly unused.',
    patterns: [
      /\b(unused|dead|orphan|cleanup|clean\s+up)\b.*\bfields?\b/,
      /\bfields?\b.*\b(unused|dead|not\s+used|never\s+used|cleanup)\b/,
      /\bhow\s+many\b.*\bfields?\b.*\b(used|populated|actually)\b/,
      /\bexcessive\b.*\b(custom\s+)?fields?\b/,
      /\b(same\s+information|duplicate\s+information)\b.*\b(fields?|objects?)\b/,
      // M33 — "which fields on <obj> have ZERO DATA and aren't referenced" =
      // unused_fields_deep; the unused/dead/never-used anchors missed "zero data".
      /\bfields?\b[^?!]{0,60}\bzero\s+data\b/,
    ],
  },
  {
    intent: 'unused-components',
    plane: 'vault',
    tools: ['sfi.unused_components'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Components with no incoming dependency edges — cleanup candidates.',
    // Code units (apex/class/method/trigger) are claimed by `dead-code` above;
    // this catches the broader component/metadata/object/flow phrasings in
    // either word order (so "what components are unused" routes, not just
    // "unused components").
    patterns: [
      /\b(unused|orphan|dead)\b.*\b(components?|metadata|objects?|flows?)\b/,
      /\b(components?|metadata|objects?|flows?)\b.*\b(unused|orphan|dead|never\s+used)\b/,
      /\bwhat\b.*\b(can\s+(i|we)\s+delete|safe\s+to\s+remove)\b/,
      // M32 — bare "not used / used nowhere" phrasing the unused/orphan/dead
      // anchors above missed (dead-code needs "not referenced"+"anywhere").
      /\b(components?|metadata|objects?|flows?)\b[^?!]{0,30}\b(not\s+used|used\s+nowhere)\b/,
    ],
  },
  {
    intent: 'safe-to-delete',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Whether a specific field is safe to delete — coverage-aware dependency check.',
    patterns: [
      // Only explicit "safe/can/ok to delete"; the broader "what breaks if I
      // delete" goes to impact-analysis (whole-graph blast radius). The
      // high-precision verdict cues (hyphenated safe-to-delete, "block
      // deletion", "before deleting") live in the EARLY precision rule above
      // unassigned-permsets (P14-ROUTER-safe-delete-misroute).
      /\b(safe(?:[\s_-]+to[\s_-]+delete|_to_delete_field)|can\s+i\s+delete|ok\s+to\s+(delete|remove))\b/,
    ],
  },
  {
    // MUST precede impact-analysis + what-if-field: a question about changing a
    // field's stored VALUE (not its type/required/deletion) routes to the
    // value-change tier. The discriminator is the word "value(s)" near a
    // change/impact verb; schema what-ifs say "field type" / "delete" / "required".
    intent: 'value-change',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.value_change_audit', 'sfi.what_if_change_field_value'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Changing a field's stored VALUE (not its schema) has a distinct blast radius — identity / integration-key / uniqueness / automation / cross-object — surfaced by value_change_audit (a set of fields on an object) or what_if_change_field_value (one field). Distinct from the type/required/delete what-ifs.",
    patterns: [
      /\bvalue[-\s]changes?\b/,
      // R7-W6: excludes the HISTORICAL "old value … new value" / "what was the
      // value before" framing — that is a runtime read of an actual past
      // change (live-field-history, earlier), not this HYPOTHETICAL what-if-
      // change-the-value simulator ask.
      /^(?!.*\b(?:old\s+value|previous\s+value|new\s+value|what\s+was\s+the\s+(?:old|previous)\s+value)\b).*\b(chang|updat|edit|modif|bulk[-\s]?updat)\w*\b[^.?!]{0,40}\bvalues?\b/,
      /\bvalues?\b[^.?!]{0,40}\b(impact|affect|break|desync|safe|risk)\w*/,
      /\b(impact|affect|safe|risky?)\b[^.?!]{0,70}\b(chang|updat|edit|modif)\w*\b[^.?!]{0,40}\bvalues?\b/,
    ],
  },
  {
    // METHOD-SIGNATURE changes have a specialist simulator the generic
    // blast-radius rule below was swallowing ("what breaks if I change the
    // signature of a method in X" → get_impact, class-granular). The phrase
    // "method signature" / "signature of …" is unambiguous, so this sits
    // BEFORE impact-analysis (P14-ROUTER-method-signature-impact;
    // what_if_change_method_signature leaves the grandfather list).
    intent: 'what-if-method-signature',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_change_method_signature'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Simulated method-signature change — callers of the class are walked from the vault (class-granularity: heuristic callsApex edges name the class, not the method; the tool discloses that).',
    patterns: [
      /\bmethod\s+signature\b/,
      /\bsignature\s+of\b.*\b(method|[a-z0-9_]+\.[a-z0-9_]+)/,
      /\b(change|changing|modify|alter)\b.*\bsignature\b/,
    ],
  },
  {
    // M8 — an explicit "LIVE blast radius" is the live tool blast_radius_live,
    // which no rule currently routes to; impact-analysis' /blast radius/ takes it
    // to the vault get_impact. Lead with blast_radius_live, get_impact as fallback.
    intent: 'blast-radius-live',
    plane: 'hybrid',
    tools: ['sfi.resolve', 'sfi.blast_radius_live', 'sfi.get_impact'],
    liveRequired: true,
    needsResolve: true,
    reason: 'A LIVE blast radius (blast_radius_live) — runtime impact, with the vault get_impact as fallback.',
    patterns: [
      /\blive\s+blast\s+radius\b/,
      /\bblast\s+radius\b[^.?!]{0,40}\blive\b/,
    ],
  },
  {
    intent: 'impact-analysis',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.field_change_advisor', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Blast radius is whole-graph dependency traversal over the vault.',
    patterns: [
      /\bwhat\s+breaks?\b/,
      /\b(impact|blast\s+radius)\b/,
      // A field-TYPE / required / picklist-value what-if is `what-if-field`, not a
      // generic blast-radius walk — exclude that phrasing so it falls through
      // (P12-ROUTER-disambiguation: "what if I change X to a text field").
      /\bif\s+i\s+(change|rename|remove|deactivate|modify|delete)\b(?!.*\b(to\s+a\b.*\bfield|field\s+type|picklist\s+value|required)\b)/,
      /\bwhat\s+if\b.*\bdeactivat/,
      // "what uses / references / depends on X" are USAGE verbs → component-usage
      // (P12-USAGE-router, §C3): impact-analysis keeps the CHANGE/DELETE blast-radius
      // verbs only ("what breaks if I change/delete"), not "where is X used".
      /\bdeactivating\b.*\b(break|would)\b/,
      /\breplacing\b.*\bwith\b.*\b(lwc|aura)\b/,
      /\baffected\b.*\b(removing|remove)\b.*\brecord\s+type/,
      /\bwhat\s+would\s+break\b.*\b(changed|change)\b/,
      // "what if I REMOVED the <X> record type … which page layouts and flows
      // assume it exists" — a record-type deletion blast radius (IMPACT REACH).
      // `\bremove\b` misses the PAST tense "removed", so this fell through to
      // unrouted. High-precision: the remove/delete verb must co-occur with the
      // literal "record type" AND a what-if/assume/kept frame, so it never steals
      // a field-type what-if (those say "field"/"required"/"picklist value").
      /\b(remov\w*|delet\w*|drop\w*)\b[^.?!]{0,40}\brecord\s+type\b[^]*\b(assume|assumes?|kept|keep|rely|relies|reference|expect)\w*/,
      /\bwhat\s+if\s+i\s+(remov\w*|delet\w*|drop\w*)\b[^.?!]{0,40}\brecord\s+type\b/,
    ],
  },
  {
    // M1 — field-TYPE change what-if. The combined what-if-field rule below grades
    // top-1 = what_if_make_field_required, so change-field-type can never win there.
    // Key on the field-type framing (from-picklist-to-<type> / "field type" / "data type").
    intent: 'what-if-change-field-type',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_change_field_type', 'sfi.what_if_make_field_required'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Simulated field-TYPE change with blast radius (what_if_change_field_type).',
    patterns: [
      /\bfrom\s+(?:a\s+)?picklist\s+to\s+(?:a\s+)?(?:text|number|formula|lookup|date|currency|checkbox|multi[-\s]?select)\b/,
      /\bchang\w*\b[^.?!]{0,40}\bfield\s+type\b/,
      /\bfield\s+type\b[^.?!]{0,40}\bchang\w*/,
      /\bchang\w*\b[^.?!]{0,40}\bdata\s+type\b/,
    ],
  },
  {
    // M2 — remove-picklist-VALUE what-if. Same combined-rule top-1 problem as M1.
    // Key on a remove/delete verb + "picklist value".
    intent: 'what-if-remove-picklist-value',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_remove_picklist_value', 'sfi.what_if_make_field_required'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Simulated removal of a picklist VALUE with blast radius (what_if_remove_picklist_value).',
    patterns: [
      /\b(remov\w*|delet\w*|drop\w*|retir\w*)\b[^.?!]{0,40}\bpicklist\s+value\b/,
      /\bpicklist\s+value\b[^.?!]{0,40}\b(remov\w*|delet\w*|drop\w*|retir\w*)\b/,
    ],
  },
  {
    intent: 'what-if-field',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_make_field_required', 'sfi.what_if_change_field_type', 'sfi.what_if_remove_picklist_value', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Simulated field change (required / type / picklist value) with blast radius.',
    patterns: [
      /\bwhat\s+if\b.*\b(field|picklist)\b/,
      /\bmake\b.*\bfield\b.*\brequired\b/,
      // "what if I make Contact.Email required" — "make X required" without the
      // literal word "field" (the field is named, e.g. Contact.Email). Battery gap.
      /\bmake\b.*\brequired\b/,
      /\b(change|convert)\b.*\bfield\s+type\b/,
      /\b(change|changed)\b.*\bdata\s+type\b/,
      /\bdata\s+type\b.*\bchange/,
      // PASSIVE / noun-first form — "if the field type CHANGED, what
      // integrations blow up": \bchange\b never matches "changed", so the
      // phrasing fell through and the "integrations" qualifier hijacked it
      // onto integration_map (eval family C).
      /\bfield\s+type\b[^.?!]{0,60}\bchang/,
      /\bremove\b.*\bpicklist\s+value\b/,
      // FIELD-FORENSICS REACH (what_if_make_field_required / _change_field_type).
      // The `\bmake\b` and `\bchange\b` verb anchors above miss the PAST tense
      // ("if we MADE X required", "if I CHANGED X") and the noun form
      // ("required-field validation"), so these fell to unrouted. Each new
      // pattern REQUIRES a required/field-type/picklist frame near the verb, so
      // it stays a schema what-if and never steals a value-change or usage ask.
      // "if we made <field> required" / "made X required but left Y optional".
      /\bmade\b[^.?!]{0,40}\brequired\b/,
      // "adding a required-field validation on <Field>" — making a field
      // mandatory expressed as a validation-rule ask; the required frame keeps
      // it on what_if_make_field_required.
      /\brequired[-\s]field\b/,
      /\b(add\w*|making|makes)\b[^.?!]{0,30}\brequired\b/,
      // "what happens if I change <field> FROM a picklist TO a text field" — a
      // field-TYPE conversion named by the from/to types (picklist→text) rather
      // than the literal "field type". The from-X-to-Y frame around a field-type
      // noun (picklist/text/number/checkbox/formula/lookup/date/currency) is
      // unambiguously a type change.
      new RegExp(
        `\\b(chang\\w*|convert\\w*)\\b[^.?!]{0,60}\\bfrom\\b[^.?!]{0,40}\\bto\\b[^.?!]{0,40}\\b(picklist|text|number|checkbox|formula|lookup|date|currency|multi[-\\s]?select)\\b`,
      ),
      new RegExp(
        `\\bfrom\\s+a\\s+picklist\\s+to\\s+a\\s+(?:text|number|formula|lookup|date|currency)\\b`,
      ),
    ],
  },
  {
    intent: 'formula-references',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_formula_references'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Which formulas reference a field — incoming `references` edges (formula fields and validation-rule formulas both produce them).',
    patterns: [
      // "which validation rules reference the Stage field" belongs here too:
      // VR formulas produce the same incoming `references` edges
      // (P14-ROUTER-goldset-expand). Noun-final phrasings ("what references
      // the X validation rule") have no verb AFTER the noun, so they keep
      // component-usage.
      /\b(formulas?|formula\s+fields?|validation\s+rules?)\b.*\b(reference|use|depend)\b/,
      /\bwhat\s+formulas?\b.*\b(use|reference)\b/,
      // "what references X IN FORMULAS / validation rules" — the verb comes
      // FIRST in this phrasing, so the formulas-first patterns above missed
      // it and the later component-usage rule stole it onto the generic
      // usage tool (P14-ROUTER-formula-vs-usage).
      /\b(reference|use|depend)\w*\b.*\bin\b.*\b(formulas?|validation\s+rules?)\b/,
    ],
  },

  // === Onboarding / docs / overview (vault) =================================
  {
    intent: 'org-overview',
    plane: 'vault',
    tools: ['sfi.org_overview'],
    liveRequired: false,
    needsResolve: false,
    reason: 'A structured org-tour snapshot — the headline "what is this org" answer.',
    patterns: [
      /\b(org\s+overview|tour|give\s+me\s+(an?\s+)?overview|headline)\b/,
      /\bwhat('?s| is)\s+in\s+(this\s+|my\s+)?org\b/,
    ],
  },
  // P13-CARD-tool: the cached refresh-time orientation card — cheaper and
  // more complete than the recomputed overview for "orient me first" asks.
  // High-precision literal patterns only (the broad overview phrasings stay
  // with org-overview above — first match wins).
  {
    intent: 'org-card',
    plane: 'vault',
    tools: ['sfi.org_card'],
    liveRequired: false,
    needsResolve: false,
    reason: 'The refresh-time org card — the ≤16KB orientation snapshot to load before the first question.',
    patterns: [
      /\borg\s+card\b/,
      /\borientation\s+(card|snapshot|doc(ument)?)\b/,
    ],
  },
  {
    intent: 'architecture-overview',
    plane: 'vault',
    tools: ['sfi.generate_architecture_overview'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Architecture / data-model / ERD overview generated from the vault.',
    patterns: [
      /\b(architecture|data\s+model|erd|entity\s+relationship)\b/,
      /\b(draw|diagram|map)\b.*\b(org|data\s+model|objects?)\b/,
      /\b(deepest|relationship\s+hierarchy)\b/,
      /\bconsolidat\w*\b.*\b(custom\s+)?objects?\b/,
      /\bexternal\s+objects?\b.*\b(salesforce\s+connect|connect)\b/,
      /\bdata\s+skew\b/,
      /\bownership\s+skew\b/,
      /\bskinny\s+tables?\b/,
    ],
  },
  {
    intent: 'data-dictionary',
    plane: 'vault',
    tools: ['sfi.generate_data_dictionary'],
    liveRequired: false,
    needsResolve: false,
    reason: 'A full data dictionary generated from vault schema.',
    patterns: [/\bdata\s+dictionary\b/, /\b(document|catalog)\b.*\b(all\s+)?fields?\b/],
  },
  {
    intent: 'admin-handbook',
    plane: 'vault',
    tools: ['sfi.generate_admin_handbook'],
    liveRequired: false,
    needsResolve: false,
    reason: 'An admin handbook / runbook generated from the vault.',
    patterns: [/\b(admin\s+handbook|runbook|admin\s+guide)\b/],
  },
  {
    intent: 'onboarding-doc',
    plane: 'vault',
    tools: ['sfi.generate_onboarding_doc', 'sfi.domain_clusters'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Onboarding doc / "I inherited this org, explain it" generated from the vault.',
    patterns: [
      /\b(onboard(ing)?|inherited|new\s+to\s+(this\s+)?org|get\s+up\s+to\s+speed)\b/,
      /\b(walk\s+me\s+through|explain)\b.*\borg\b/,
    ],
  },
  {
    intent: 'domain-clusters',
    plane: 'vault',
    tools: ['sfi.domain_clusters'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Suggested domain groupings of objects/classes/flows from graph structure.',
    patterns: [
      /\b(domains?|clusters?|functional\s+areas?|modules?)\b/,
      /\bhow\s+is\b.*\borg\b.*\b(structured|organized|grouped)\b/,
    ],
  },

  // === Change / history / cross-org (vault, snapshots) ======================
  // R7-W6: live_field_history and live_setup_audit_trail now cover TWO of the
  // three runtime-audit-trail gaps (field history, Setup Audit Trail — debug
  // logs / Event Monitoring stay genuinely out of scope). Both are placed
  // BEFORE runtime-audit-trail and anchored on STRONGER signals than its bare
  // "who changed/field history/setup audit trail" patterns, so the existing
  // honest-disclosure default is preserved for the ambiguous/generic phrasings
  // it is regression-tested on ("who changed this record", "show me the field
  // history for Account", bare "setup audit trail") — those name no specific
  // FIELD, no temporal/config qualifier, so they fall through unchanged.
  {
    // A NAMED field ("who changed Account.Status", "field history for
    // Discount__c") or an explicit old/new-value framing is unambiguous:
    // {Object}History runtime data, not the generic disclosure.
    intent: 'live-field-history',
    plane: 'live',
    tools: ['sfi.live_field_history'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'WHO changed a NAMED field on a record, and to what value, is runtime {Object}History data — live_field_history reads it (subject to the vault field-history-tracking precondition check); the vault only reasons about which automation COULD write the field.',
    suggestArgs: (q, question) => {
      const source = question ?? q;
      const fieldMatch = source.match(new RegExp(NAMED_FIELD_ID, 'i'));
      const args: Record<string, unknown> = {};
      const objectApiName = deriveObjectApiFromQuestion(q, question);
      if (objectApiName !== undefined) args['objectApiName'] = objectApiName;
      if (fieldMatch?.[0] !== undefined) {
        const raw = fieldMatch[0];
        const dotted = raw.split('.');
        args['fieldApiName'] = dotted.length === 2 ? dotted[1] : raw;
      }
      return Object.keys(args).length > 0 ? args : undefined;
    },
    patterns: [
      new RegExp(`\\bwho\\s+(?:changed|edited|updated|set)\\b[^.?!]{0,40}\\b${NAMED_FIELD_ID}\\b`),
      new RegExp(`\\bfield\\s+history\\b[^.?!]{0,40}\\bfor\\b[^.?!]{0,40}\\b${NAMED_FIELD_ID}\\b`),
      /\bold\s+value\b[^.?!]{0,60}\bnew\s+value\b/,
      /\bwhat\s+was\s+the\s+(?:old|previous)\s+value\b[^.?!]{0,40}\bfield\b/,
      /\bchange\s+history\s+for\s+the\s+\w+\s+field\b/,
      /\b(?:changed|edited)\s+the\s+\w+\s+on\s+(?:this|that)\s+record\b/,
      /\baudit\s+trail\s+of\s+value\s+changes?\b/,
      /\bwho\s+set\s+(?:this|that)\s+field\b/,
      /\blive_field_history\b/,
    ],
  },
  {
    // A NAMED setup-config target (profile / permission set / OWD / sharing /
    // security setting) or "setup audit trail"/"setup changes" WITH a temporal
    // qualifier is unambiguous SetupAuditTrail data; the bare, unqualified
    // "setup audit trail" phrasing (no temporal cue, no named target) stays on
    // runtime-audit-trail's honest disclosure below.
    intent: 'live-setup-audit-trail',
    plane: 'live',
    tools: ['sfi.live_setup_audit_trail'],
    liveRequired: true,
    needsResolve: false,
    reason:
      'WHO changed a profile / permission set / org-wide default / sharing setting — or a temporally-scoped Setup Audit Trail read — is the runtime SetupAuditTrail roster; live_setup_audit_trail reads it directly.',
    patterns: [
      /\bsetup\s+audit\s+trail\b[^.?!]{0,40}\b(?:recent(?:ly)?|last\s+(?:\d+\s+days?|week|month|quarter)|this\s+(?:week|month)|today|past\s+\w+)\b/,
      /\b(?:recent|last\s+(?:\d+\s+days?|week|month)|this\s+week|today)\b[^.?!]{0,40}\bsetup\s+(?:changes?|audit\s+trail)\b/,
      /\bchanged\b[^.?!]{0,30}\bin\s+setup\b/,
      /\bwho\s+(?:changed|modified|edited|touched|flipped)\b[^.?!]{0,60}\b(?:profile|permission\s+set|org[-\s]?wide\s+default|owd|security\s+settings?|sharing\s+settings?|field-?level\s+security|fls|session\s+settings?|password\s+polic\w*|mfa)\b/,
      /\b(?:deactivated|activated|turned\s+off|turned\s+on|disabled|enabled)\b[^.?!]{0,40}\b(?:trigger|validation\s+rule|flow|automation)\b/,
      /\b(?:trigger|validation\s+rule|flow|automation)\b[^.?!]{0,40}\b(?:deactivated|turned\s+off|disabled)\b/,
      /\badmin\s+change\s+history\b/,
      /\bconfiguration\s+changes?\b[^.?!]{0,40}\bmade\s+by\b[^.?!]{0,20}\badministrators?\b/,
      /\bwho\s+granted\b[^.?!]{0,40}\bmodify[-\s]?all\b/,
      /\bflip(?:ped)?\b[^.?!]{0,40}\bfield[-\s]level\s+security\b/,
      /\blive_setup_audit_trail\b/,
      // M41 — a display-verb-anchored "show me the setup audit trail". SetupAuditTrail
      // is inherently runtime; the leading display verb keeps this off the
      // component-change-attribution gold ("...according to the persisted setup audit trail").
      /\b(?:show|display|pull\s+up|bring\s+up|open|give\s+me)\b[^.?!]{0,15}\bsetup\s+audit\s+trail\b/,
    ],
  },
  {
    // #39 — offline SetupAuditTrail attribution from persisted JSONL.
    // MUST sit before runtime-audit-trail: that rule's bare
    // `\b(setup\s+)?audit\s+trail\b` would otherwise swallow "persisted /
    // offline / vault setup audit trail" asks.
    intent: 'component-change-attribution',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.component_change_attribution'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Offline who-changed-this from persisted SetupAuditTrail (component_change_attribution); vault never ran --with-audit-trail answers available:false with the enable hint. Distinct from live_setup_audit_trail (live 180-day) and component_history (vault git).',
    patterns: [
      /\b(?:persisted|offline|vault)\s+setup\s+audit\s+trail\b/,
      /\bsetup\s+audit\s+trail\b[^.?!]{0,40}\b(?:persisted|offline|vault|attribut)/,
      /\b(?:attribute|attribut(?:e|ion)|correlate)\b[^.?!]{0,40}\b(?:setup\s+)?audit\s+trail\b/,
      /\bcomponent_change_attribution\b/,
      /\boffline\s+(?:setup\s+)?change\s+attribution\b/,
      /\bwho\s+changed\b[^.?!]{0,60}\baccording\s+to\s+(?:the\s+)?(?:persisted|vault)\s+(?:setup\s+)?audit\b/,
      // M42 — "(show me) who changed the <Component>" where the component is a
      // metadata token ending in flow/trigger/class/layout/component/process. The
      // query is lowercased so CamelCase is unusable; require "the <token+suffix>"
      // so "who changed this record" / a field / sharing settings are not stolen.
      /\bwho\s+(?:changed|modified|edited|last\s+(?:changed|modified|edited))\s+the\s+[a-z][a-z0-9_]*(?:flow|trigger|class|layout|component|process)\b/,
    ],
  },
  // Runtime audit trail — placed BEFORE `history-change` so its broad
  // `\bhistory\b` pattern does not swallow "field history" (which is a runtime
  // audit-trail ask, not a metadata diff). These questions are about WHO did
  // WHAT to a record / field history / Setup Audit Trail / debug logs — runtime
  // data the offline vault cannot hold. Route to the metadata-side fallbacks
  // (last_modified / changed_since) with an honest disclosure rather than
  // fabricating an answer or going dead-`unknown`.
  {
    intent: 'runtime-audit-trail',
    plane: 'vault',
    tools: ['sfi.last_modified', 'sfi.changed_since'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Field history, the Setup Audit Trail, who-changed-which-record, and debug / event-monitoring logs are RUNTIME audit data that live only in the org — the offline vault cannot answer them. It CAN show metadata last-modified (last_modified / changed_since) and metadata causality (why_field_changed = which automation writes a field, not who edited a record).',
    gap: {
      category: 'runtime-audit-trail',
      note: 'Out of scope: runtime audit trail (Field History Tracking, Setup Audit Trail, who-changed-what, debug logs, Event Monitoring) is org-runtime data, not vault metadata. Use last_modified / changed_since for the metadata-side last-modified info, and why_field_changed for which AUTOMATION writes a field (not who edited a record). For an actual audit trail, check Field History Tracking, the Setup Audit Trail, or Event Monitoring in Salesforce.',
    },
    patterns: [
      /\b(field|record|data)\s+history\b/,
      /\bhistory\s+tracking\b/,
      /\b(setup\s+)?audit\s+trail\b/,
      /\bdebug\s+logs?\b/,
      /\bevent\s+monitoring\b/,
      /\bwho\s+(changed|modified|edited|updated|deleted)\b/,
      /\bwho\s+last\s+(changed|edited|modified|updated)\b/,
      /\bwho\s+(made|did)\b.*\b(change|edit|update|deletion|modification)\b/,
      /\bwhat\s+happened\s+to\s+(this|the|my|that)\b/,
    ],
  },
  {
    // Component change TIMELINE over the vault's own git history — "when did
    // X change", "change history of the Payment flow"
    // (P14-ROUTER-goldset-expand; sfi.component_history leaves the
    // grandfather list). Placed BEFORE history-change: its bare
    // history/timeline pattern would steal the component-anchored form.
    // Distinct from last-modified (org-declared stamp) and history-change
    // (org-wide between-refresh diffs).
    intent: 'component-history',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.component_history'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'A component change timeline — one entry per source-changing refresh from the vault git history (component_history); a non-git vault answers available:false with the enable hint, never an error.',
    patterns: [
      /\bwhen\s+did\b.*\bchange\b/,
      /\b(change|revision)\s+(history|timeline)\b.*\b(of|for)\b/,
      /\bhow\s+has\b.*\bchanged\s+over\s+time\b/,
    ],
  },
  {
    // Curated OWNERSHIP / stewardship — "who owns the Status field" reads
    // the annotations overlay (P14-ROUTER-goldset-expand; sfi.annotations
    // leaves the grandfather list). The metadata-noun anchor keeps live
    // record ownership ("who owns most accounts") on owner-breakdown
    // (earlier rule, live plane).
    intent: 'annotations-owner',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.annotations'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Ownership/stewardship is curated annotation data — resolve the component, then annotations returns its curated notes (owner, glossary, caveats); an empty answer means "no annotation recorded", never inferred ownership.',
    patterns: [
      /\bwho\s+owns?\b.*\b(field|object|flow|class|trigger|component|process|integration)\b/,
      /\b(owner|steward)\s+of\s+(the\s+)?\w+\b.*\b(field|object|flow|class)\b/,
    ],
  },
  {
    // M10 — a TIME-WINDOW delta ("what changed since last week") is changed_since;
    // history-change below leads with org_history and its /changed since/ pattern
    // catches this. org_history's own gold ("since the last refresh") has no
    // week/month timeframe, so it is excluded.
    intent: 'changed-since-timeframe',
    plane: 'vault',
    tools: ['sfi.changed_since', 'sfi.org_history'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Components changed within a time window (changed_since), not the whole org_history digest.',
    patterns: [
      /\bsince\s+last\s+(week|month|day|quarter|year|sprint|release)\b/,
      /\bchang\w*\s+since\b[^.?!]{0,30}\b(yesterday|last\s+(week|month|day|quarter|year|sprint|release)|\d+\s+(day|week|month)s?\s+ago)\b/,
    ],
  },
  {
    intent: 'history-change',
    plane: 'vault',
    tools: ['sfi.org_history', 'sfi.changed_since'],
    liveRequired: false,
    needsResolve: false,
    reason: 'What changed between refreshes comes from the continuous-learning store.',
    patterns: [
      /\bwhat\s+(changed|is\s+new|happened)\b.*\b(since|last|recently|lately)\b/,
      /\bwhat\s+changed\s+around\b.*\brecently\b/,
      /\b(what\s+changed|change\s+history|org\s+history|audit\s+(trail|history))\b/,
      // Do not steal object names that contain "history" when the ask names an object.
      /\b(history|timeline|recent\s+changes)\b(?!.*\bobject\b)/,
      /\bchanged\s+since\b/,
    ],
  },
  {
    intent: 'last-modified',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.last_modified'],
    liveRequired: false,
    needsResolve: true,
    reason: 'When a component was last modified (needs a tooling-API-enriched refresh).',
    patterns: [
      /\bwhen\s+was\b.*\b(last\s+(modified|changed|updated|edited))\b/,
      /\blast\s+modified\b/,
    ],
  },
  {
    // M6 — OBJECT-scoped cross-vault compare. The cross-org-diff rule below always
    // grades top-1 = compare_vaults; the noun "object" scopes this to
    // compare_object_across_vaults.
    intent: 'cross-org-diff-object',
    plane: 'vault',
    tools: ['sfi.compare_object_across_vaults', 'sfi.compare_vaults'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Compare a specific OBJECT across two vaults (compare_object_across_vaults).',
    // Same second-registered-vault prerequisite as the org-wide cross-org-diff
    // rule below: compare_object_across_vaults diffs two offline snapshots and
    // returns vault-not-found on a single-vault install. DISCLOSURE, not a block.
    gap: {
      category: 'cross-vault-registry',
      note: 'Cross-vault comparison needs a SECOND registered vault (a multi-vault registry). If only this vault is registered, the compare_* call will return vault-not-found — register the other org first (sfi vault register) or name the two vault aliases to compare.',
    },
    patterns: [
      /\bcompare\b[^.?!]{0,30}\bobject\b[^.?!]{0,40}\bacross\b/,
      /\bcompare\b[^.?!]{0,40}\bobject\b[^.?!]{0,50}\b(sandbox(es)?|uat|staging|prod\w*|vaults?|orgs?|environments?)\b/,
    ],
  },
  {
    // M7 — PROFILE-scoped cross-vault compare. Same combined-rule top-1 issue as M6.
    intent: 'cross-org-diff-profile',
    plane: 'vault',
    tools: ['sfi.compare_profile_across_vaults', 'sfi.compare_vaults'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Compare a specific PROFILE across two vaults (compare_profile_across_vaults).',
    // Same second-registered-vault prerequisite as cross-org-diff:
    // compare_profile_across_vaults returns vault-not-found on a single-vault
    // install. DISCLOSURE, not a block.
    gap: {
      category: 'cross-vault-registry',
      note: 'Cross-vault comparison needs a SECOND registered vault (a multi-vault registry). If only this vault is registered, the compare_* call will return vault-not-found — register the other org first (sfi vault register) or name the two vault aliases to compare.',
    },
    patterns: [
      /\bcompare\b[^.?!]{0,30}\bprofiles?\b[^.?!]{0,40}\bacross\b/,
      /\bcompare\b[^.?!]{0,40}\bprofiles?\b[^.?!]{0,50}\b(sandbox(es)?|uat|staging|prod\w*|vaults?|orgs?|environments?)\b/,
    ],
  },
  {
    intent: 'cross-org-diff',
    plane: 'vault',
    tools: ['sfi.compare_vaults', 'sfi.compare_object_across_vaults', 'sfi.compare_profile_across_vaults'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Differences between two registered orgs (UAT vs prod) from the vault registry. Requires BOTH orgs to be registered vaults — the compare_* tools diff two offline snapshots, never the live org.',
    // DISCLOSURE, not a block (eval family D): on a single-vault install the
    // compare tools fail with vault-not-found — say the second-registered-vault
    // prerequisite up front instead of routing confident-clean into it.
    gap: {
      category: 'cross-vault-registry',
      note: 'Cross-vault comparison needs a SECOND registered vault (a multi-vault registry). If only this vault is registered, the compare_* call will return vault-not-found — register the other org first (sfi vault register) or name the two vault aliases to compare.',
    },
    patterns: [
      /\b(uat|sandbox|staging)\b.*\b(vs|versus|compared?\s+to|and)\b.*\b(prod|production)\b/,
      /\bwhat('?s| is)\s+different\b.*\b(between|across)\b.*\borgs?\b/,
      /\bcompare\b.*\borgs?\b/,
      // "compare the Account object across our sandboxes" — the cross-vault
      // ask phrased with "across" + an environment noun (eval family D).
      /\bcompare\b[^.?!]{0,60}\bacross\b[^.?!]{0,30}\b(orgs?|sandbox(es)?|environments?|vaults?|instances?)\b/,
      /\b(differs?|difference|different)\b[^.?!]{0,50}\b(between|across)\b[^.?!]{0,40}\b(sandbox(es)?|environments?|instances?|vaults?)\b/,
    ],
  },
  {
    // "Churn/what changed SINCE THE LAST REFRESH" has a no-arg specialist —
    // the broad snapshot-diff rule below routed it to diff_snapshots, whose
    // REQUIRED from/to labels the router can never derive from this phrasing
    // (P14-ROUTER-stress-20; what_changed_since_refresh leaves the
    // grandfather list). Placed before snapshot-diff so the refresh anchor
    // wins; generic churn/trend phrasings keep the snapshot tools.
    intent: 'what-changed-since-refresh',
    plane: 'vault',
    // STEP-2: churn retired to a hidden alias of diff_snapshots (summary: true);
    // the survivor takes its secondary slot behind the refresh anchor.
    tools: ['sfi.what_changed_since_refresh', 'sfi.diff_snapshots'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Local source-tree drift since the last vault refresh — what_changed_since_refresh compares the current source hash against the manifest, no arguments needed.',
    patterns: [
      // NB: "what changed since …" phrasings belong to the EARLIER
      // history-change rule (org_history — also no-arg); this rule claims
      // the churn/drift-flavored refresh anchor that snapshot-diff was
      // swallowing onto a tool with non-derivable required args.
      /\b(churn|chang\w+|drift\w*|differen\w+)\b[^.?!]{0,30}\bsince\b[^.?!]{0,25}\b(last\s+)?(vault\s+)?refresh/,
      /\bsince\s+(the\s+)?last\s+(vault\s+)?refresh\b/,
    ],
  },
  {
    intent: 'security-posture-trend',
    plane: 'vault',
    tools: ['sfi.trend'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Security posture over time — sfi.trend with metric:securityScore reads capture-time grades persisted on SnapshotMeta.metrics at snapshot create / refresh.',
    suggestArgs: () => ({ metric: 'securityScore' }),
    // BEFORE snapshot-diff: that rule's /\btrend\b/ would otherwise steal
    // "security score trend" asks.
    patterns: [
      /\bsecurity\s+posture\b.*\b(trend|over\s+time|better|worse|improv|degrad)/,
      /\b(trend|over\s+time|better|worse|improv|degrad).*\bsecurity\s+posture\b/,
      /\bis\s+our\s+security\b.*\b(better|worse|improv|degrad)/,
      /\bsecurity\b.*\b(getting\s+)?(better|worse)\b/,
      /\b(security\s+score|securityScore)\b.*\b(trend|over\s+time|history)\b/,
      /\b(trend|over\s+time|history)\b.*\b(security\s+score|securityScore)\b/,
    ],
  },
  {
    // M31 — a TREND across snapshots is sfi.trend. snapshot-diff below has
    // tools [diff_snapshots, trend] with pattern /(churn|trend|snapshot)/, so a
    // "trend" ask yields diff_snapshots. Placed after security-posture-trend.
    intent: 'snapshot-trend',
    plane: 'vault',
    tools: ['sfi.trend'],
    liveRequired: false,
    needsResolve: false,
    reason: 'A metric trend across captured snapshots (trend), not a two-snapshot diff.',
    patterns: [
      /\btrends?\b[^?!]{0,40}\b(snapshots?|over\s+time|across|vault)\b/,
      /\b(snapshots?|over\s+time)\b[^?!]{0,20}\btrends?\b/,
    ],
  },
  {
    // M11 — metadata CHURN digest is sfi.churn. snapshot-diff below routes churn
    // phrasings to diff_snapshots; the "churn since last vault refresh" ask is a
    // different tool (matched earlier) so exclude "churn since".
    intent: 'metadata-churn',
    plane: 'vault',
    tools: ['sfi.churn', 'sfi.diff_snapshots'],
    liveRequired: false,
    needsResolve: false,
    reason: 'A metadata churn digest for the vault (churn).',
    patterns: [
      /\bmetadata\s+churn\b/,
      /\bchurn\b(?!\s+since\b)/,
    ],
  },
  {
    // M12 — a point-in-time "show <component> AS OF the last snapshot" is
    // component_as_of, which is not in snapshot-diff's tools; key on the distinct
    // "as of ... snapshot" vocabulary.
    intent: 'snapshot-component-as-of',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.component_as_of'],
    liveRequired: false,
    needsResolve: true,
    reason: 'A component as of a past snapshot (component_as_of), a point-in-time read.',
    patterns: [
      /\bas\s+of\b[^.?!]{0,40}\bsnapshot\b/,
    ],
  },
  {
    intent: 'snapshot-diff',
    plane: 'vault',
    // STEP-2: churn retired to a hidden alias of diff_snapshots (summary: true) —
    // dropped here (diff_snapshots already leads). trend is KEPT (distinct store).
    tools: ['sfi.diff_snapshots', 'sfi.trend'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Structural diff / churn digest / trend between captured snapshots.',
    patterns: [
      /\b(churn|trend|snapshot)\b/,
      /\bhow\s+much\b.*\b(changed|growth)\b.*\bover\s+time\b/,
    ],
  },

  // === CPQ / OmniStudio (vault) =============================================
  {
    // M13 — break down a CPQ quote-template's structure. The cpq rule below leads
    // with cpq_dependency_map on any "quote template" mention; key on the per-template
    // breakdown verb (break down / structure).
    intent: 'cpq-quote-template-breakdown',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.cpq_quote_template_breakdown'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Break down a specific CPQ quote template (cpq_quote_template_breakdown).',
    patterns: [
      /\b(break\s*down|breakdown)\b[^.?!]{0,30}\bquote\s+templates?\b/,
      /\bquote\s+templates?\b[^.?!]{0,15}\bstructure\b/,
    ],
  },
  {
    intent: 'cpq',
    plane: 'vault',
    tools: ['sfi.cpq_dependency_map', 'sfi.cpq_rule_chain', 'sfi.cpq_quote_template_breakdown'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'CPQ dependency map (org-wide, no id needed), then price/product rule chains and quote-template breakdown for a specific named rule or template.',
    patterns: [
      /\bcpq\b/,
      /\b(price|product|discount)\s+rules?\b/,
      /\bquote\s+templates?\b/,
    ],
  },

  // === Field mapping / meaning (vault) ======================================
  {
    // M15 — OmniStudio DataTransform field mappings (datatransform_field_map). The
    // NL field-mapping rule below misses plural "field mappings" and would route to
    // field_mapping_between_objects anyway; key on the distinct DataTransform vocab.
    intent: 'datatransform-field-map',
    plane: 'vault',
    tools: ['sfi.datatransform_field_map', 'sfi.field_mapping_between_objects'],
    liveRequired: false,
    needsResolve: false,
    reason: 'DataTransform / DataRaptor field mappings (datatransform_field_map).',
    patterns: [/\bdata\s?transform\b/],
  },
  {
    intent: 'field-mapping',
    plane: 'vault',
    tools: ['sfi.field_mapping_between_objects', 'sfi.datatransform_field_map'],
    liveRequired: false,
    needsResolve: false,
    reason: 'How fields map between two objects (lead conversion, data transforms).',
    suggestArgs: deriveFieldMappingArgs,
    patterns: [
      /\bfield\s+mapping\b/,
      /\bhow\s+(do|does)\b.*\bfields?\b.*\bmap\b/,
      /\bmap(ping|ped)?\b.*\b(between|from)\b.*\b(object|to)\b/,
      // M18 — object-to-object mapping without the literal word "fields" or
      // "between": "how does the Contact object map to Account?".
      /\bhow\s+do(es)?\b[^.?!]{0,30}\bobjects?\b[^.?!]{0,20}\bmaps?\s+to\b/,
    ],
  },
  {
    // M39 — the real sfi.field_meaning tool (semantic/business meaning) has no
    // rule; "meaning of <field>" matches nothing and goes unrouted. Carve the
    // "meaning of" / "mean ... business context" vocabulary to field_meaning.
    intent: 'field-meaning-semantic',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_meaning'],
    liveRequired: false,
    needsResolve: true,
    reason: 'The semantic / business meaning of a field (field_meaning), not explain_field.',
    patterns: [
      // "meaning of <Field>" — SCOPED to a field reference. A bare
      // "what is the meaning of life" must stay UNROUTED (life is not a field),
      // so the object of "meaning of" has to be a named field (custom `__x`
      // suffix or an `Object.Field` path) or carry the literal word "field".
      /\bmeaning\s+of\b[^.?!]{0,40}\bfield\b/,
      /\bmeaning\s+of\s+(?:the\s+|a\s+|an\s+|this\s+|that\s+|our\s+|your\s+)*[A-Za-z][A-Za-z0-9]*(?:__[a-z0-9]+\b|\.[A-Za-z])/,
      /\bmean\b[^.?!]{0,40}\bbusiness\s+context\b/,
    ],
  },
  {
    // M19 — "what does <field> mean in our BUSINESS CONTEXT" is the business
    // semantics of a field (field_meaning), a close sibling of explain_field
    // (technical values/help-text/type).
    intent: 'field-business-meaning',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_meaning', 'sfi.field_360'],
    liveRequired: false,
    needsResolve: true,
    reason: 'The business meaning/purpose of a field (field_meaning).',
    patterns: [
      /\bbusiness\s+(context|meaning|purpose|sense)\b/,
    ],
  },
  {
    intent: 'field-meaning',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_field', 'sfi.field_360'],
    liveRequired: false,
    needsResolve: true,
    reason: 'What a specific field means / its full 360 (type, usage, references, lineage).',
    patterns: [
      /\bwhat\s+(does|is)\b.*\bfield\b.*\b(mean|for|do)\b/,
      /\bexplain\b.*\bfield\b/,
      /\btell\s+me\s+about\b.*\bfield\b/,
      // M35 — "(show me) an explanation of the <Field> field". \bexplain\b
      // word-boundary-misses "explanation", so this fell to the generic schema rule.
      /\bexplanation\s+of\b[^.?!]{0,40}\bfield\b/,
      // "what does Status__c mean on Evaluation" — the field is NAMED (e.g. an
      // __c api name) rather than the literal word "field". Battery gap.
      /\bwhat\s+(does|is)\b.*\w+__c\b.*\b(mean|for)\b/,
      // "what is the help text for the Discount_Percent__c field" — the
      // inline help bubble IS explain_field's surface; a top baseline-300
      // unrouted cluster (P14-ROUTER-goldset-expand).
      /\b(help\s+text|inline\s+help)\b/,
      /\bwhat\s+is\s+the\s+data\s+type\b/,
    ],
  },

  // === Schema / naming (general — near the end) =============================
  {
    // KNOWLEDGE plane (B1) — greenfield/best-practice asks with NO org-specific
    // answer. Patterns are deliberately narrow (only asks no vault rule already
    // catches: flow-vs-apex, trigger framework, async options, SFDX, unlocked
    // packages) so org-specific questions still route to vault/live. Other
    // greenfield topics (governor limits, callouts, coverage, naming) are caught
    // by their vault rules earlier and stay org-specific; their curated topics
    // remain reachable via an explicit sfi.guidance { topic } call.
    intent: 'guidance',
    plane: 'knowledge',
    tools: ['sfi.guidance'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'General Salesforce best-practice question with no org-specific answer — sfi.guidance returns a curated summary + official doc links (not org data).',
    suggestArgs: (q) => {
      const topic = deriveKnowledgeTopic(q);
      return topic !== undefined ? { topic } : undefined;
    },
    patterns: [
      /\b(flow\s+(vs\.?|versus|or)\s+apex|apex\s+(vs\.?|versus|or)\s+flow)\b/,
      /\bwhen\s+(should\s+i|to)\s+use\b.*\bflow\b/,
      /\b(apex\s+)?trigger\s+framework\b/,
      /\basync(hronous)?\s+apex\b/,
      /\b(future|queueable|batch|schedulable)\b.*\b(vs\.?|versus|when\s+to|which\s+to|each\s+appropriate|options?)\b/,
      /\b(sfdx|source[-\s]driven\s+development|scratch\s+orgs?)\b/,
      /\bunlocked\s+packages?\b/,
      /\bsingle[-\s]org\b.*\bmulti[-\s]org\b/,
      /\bdata\s+(retention|archiv)/,
      /\b(large\s+data\s+volumes?|\bldv\b)/,
      /\bhow\s+should\s+i\s+structure\b.*\btest\b/,
      /\bstandard\s+(stages?|profiles?)\b/,
      /\b(person\s+accounts?)\b.*\b(enabling|enable)\b/,
      /\b(ci\/cd|source\s+control|deployment\s+(and\s+)?release)\b/,
      /\bsandboxes?\b.*\b(refresh|managed)\b/,
      /\benvironment\s+and\s+release\s+strategy\b/,
      /\b(is\s+there\s+a\s+)?ci\/cd\b/,
      // Concept ask about an access primitive — "What is a Profile" / "what is
      // a permission set". The indefinite article marks a GENERIC type word,
      // never a named component, so this must not fall through to unrouted (or
      // worse, a Profile-record disambiguation menu). Comparisons ("difference
      // between a profile and a permission set") stay on compare-profiles.
      /\bwhat\s+is\s+an?\s+(?:profile|permission\s+set)\s*\??\s*$/,
    ],
  },
  // === FIELD-FORENSICS REACH block (USAGE / IMPACT / FIELD-FORENSICS cluster) =
  // These sit BEFORE the generic component-usage dispatcher so a question that
  // NAMES a specific field (NAMED_FIELD_ID — a dotted `Object.field` or a bare
  // `__c` api name) and asks a field-forensics question lands on the dedicated
  // field tool instead of the generic usage tool. Every pattern REQUIRES the
  // named field, so a bare-English question (no dot, no `__c`) never fires here
  // and keeps its existing route. The order within the block encodes the eval's
  // distinction: "reads OR writes" → find_field_anywhere; "what writes … is it a
  // flow" (writers only) → field_provenance; a lineage/trace frame →
  // field_lineage; "field 360" → field_360; a semantic "do we have a field for
  // X" → find_semantic_field. USAGE ("which flows write X", "is X triggered by
  // Y", "connected to Marketo") stays on the component-usage dispatcher below.
  {
    // "do we already have a field for <concept>" / "where do we store <concept>
    // data across the org" — semantic field discovery. High-precision on the
    // store/have-a-field frame + a cross-org scope; must sit before the field-id
    // rules because it is about a CONCEPT, not a specific named field (the named
    // field it cites, e.g. "X is one, what ELSE", is an example, not the target).
    intent: 'find-semantic-field',
    plane: 'vault',
    tools: ['sfi.find_semantic_field'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Semantic field discovery — "do we already have a field for X" ranks CustomFields by token overlap with a natural-language concept (heuristic recommendation).',
    patterns: [
      /\bwhere\s+do\s+we\s+store\b[^.?!]{0,60}\b(across|anywhere|in\s+(?:the\s+)?org)\b/,
      /\bdo\s+we\s+(?:already\s+)?have\s+a\s+field\s+for\b/,
      /\b(is|are)\s+there\s+(?:already\s+)?an?\s+(?:existing\s+)?field\s+for\b/,
      // "X is one, what else" — the caller names one example field and asks for
      // the rest of the concept family (the semantic-discovery signature).
      /\bis\s+one,?\s+what\s+else\b/,
    ],
  },
  {
    // "trace where <field> goes after conversion / where does <field> data come
    // from / where does <field> flow" — data lineage for a NAMED field. Sits
    // before find_field_anywhere/provenance so an explicit trace/lineage frame
    // wins over a bare reads/writes ask. The named-field id + a movement verb
    // (trace/goes/lands/flows/come from) keep it precise; the pii-flow rule
    // earlier already owns the "field data flow/lineage" phrasings without a
    // named id, so this only adds the NAMED-field trace shape it missed.
    intent: 'field-lineage',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_lineage'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Trace where a NAMED field\'s value comes from and what it feeds — the provenance + downstream-effects walker, requested by an explicit trace/lineage frame on a named field.',
    patterns: [
      new RegExp(
        `\\btrace\\b[^.?!]{0,40}\\b${NAMED_FIELD_ID}\\b[^.?!]{0,60}\\b(goes?|lands?|flows?|end\\s+up|get\\s+dropped|come\\s+from|after\\s+conversion)\\b`,
      ),
      new RegExp(
        `\\bwhere\\s+does\\b[^.?!]{0,30}\\b${NAMED_FIELD_ID}\\b[^.?!]{0,50}\\b(go|goes?|flow|flows?|come\\s+from|land)\\b`,
      ),
    ],
  },
  {
    // "give me the field 360 on <Field>" / "the full picture of <Field>" — the
    // unified field-forensics synthesis tool, requested by its own vocabulary.
    // The literal "field 360" / "360 on <field>" phrase is unambiguous.
    intent: 'field-360',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_360', 'sfi.explain_field'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Full 360 profile of a single field — everything that validates / writes / reads / uses it across automation, code, UI, integrations, composed into one report.',
    patterns: [
      /\bfield\s*360\b/,
      /\b360\b[^.?!]{0,20}\b(on|of|for)\b[^.?!]{0,20}(?:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|[a-z][a-z0-9_]*__c)\b/,
      new RegExp(
        `\\b(full\\s+(?:picture|profile)|everything\\s+that\\s+(?:touches|uses))\\b[^.?!]{0,30}\\b${NAMED_FIELD_ID}\\b`,
      ),
    ],
  },
  {
    // "What READS OR WRITES <Field> on <Object>" — the universal find-anywhere
    // for a named field (both directions). The "reads or/and writes" (or the
    // "used anywhere") frame distinguishes it from provenance (writers-only)
    // below. Requires the named field id so bare English never fires.
    intent: 'find-field-anywhere-usage',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_field_anywhere'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Where a NAMED field is used anywhere — every incoming edge (apex reads/writes, flow ops, layout placements, VR refs), grouped by referrer type. Both read and write directions.',
    patterns: [
      new RegExp(
        `\\b(reads?\\s+(?:or|and)\\s+writes?|writes?\\s+(?:or|and)\\s+reads?)\\b[^.?!]{0,60}\\b${NAMED_FIELD_ID}\\b`,
      ),
      new RegExp(
        `\\b${NAMED_FIELD_ID}\\b[^.?!]{0,40}\\bused\\s+anywhere\\b`,
      ),
    ],
  },
  {
    // "What WRITES <Field> on <Object> — is it a flow?" — the source-of-a-field
    // ask (writers only): who/what SETS this field's value, and is it manual /
    // automated / integration-synced. Distinguished from find-field-anywhere
    // above by being writers-only (no "reads"), and from the "which flows write
    // X" USAGE ask below by NOT scoping to a component type up front (the field
    // is the subject: "what writes X"). Requires the named field id.
    intent: 'field-provenance',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.field_provenance', 'sfi.interpret'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Who/what SETS a field's value — the writers fabric (apex/flow/trigger writers, formula/auto-number declaration, integration-synced classifier) for a named field.",
    patterns: [
      new RegExp(
        `^(?!.*\\breads?\\b)(?!.*\\bwhich\\s+flows?\\b).*\\bwhat\\s+writes\\b[^.?!]{0,80}\\b${NAMED_FIELD_ID}\\b`,
      ),
      new RegExp(
        `\\bwhat\\s+(?:sets|populates?|fills?)\\b[^.?!]{0,60}\\b${NAMED_FIELD_ID}\\b[^.?!]{0,40}\\bis\\s+it\\s+(?:a\\s+)?(?:flow|manual|automated|integration)`,
      ),
    ],
  },
  {
    // M20 — "where is <ApexClass> used in OTHER APEX CODE" is Apex-to-Apex usage
    // scoping (find_apex_usages), narrower than the universal usage dispatcher
    // below which would otherwise claim it on find_component_usages.
    intent: 'apex-usages',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_apex_usages'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Where a class/method is used in other Apex code (find_apex_usages), an Apex-to-Apex usage scope.',
    patterns: [
      /\bused\b[^?!]{0,25}\bapex\s+code\b/,
      /\b(in|other)\s+apex\s+code\b/,
    ],
  },
  {
    // P12-USAGE-router (§C3): the universal "where is X used / what references X /
    // what depends on X" intent for a NAMED component of ANY type → the
    // find_component_usages dispatcher. Ordered BEFORE locate-field so a non-field
    // usage ("where is MyClass used") wins the dispatcher instead of the field
    // tool; the "where is … used" pattern EXCLUDES a field signal (`field`/`__c`)
    // so a field's usage stays on the richer find_field_anywhere specialist, and a
    // bare "where is X" (no usage verb) still falls through to locate-field.
    // Describe phrasing ("what CMDTs do we HAVE") has no usage verb → unaffected.
    intent: 'component-usage',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_component_usages', 'sfi.integration_map'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Universal usage lookup — where a named component is referenced/used/depended-on, composing graph incoming edges (minus access) + an Apex-source grep supplement, with empty≠absent honesty.',
    suggestArgs: (q, question) => {
      const src = question ?? q;
      const nc = src.match(/\bnamed\s+credential\s+([A-Za-z0-9_]+)/i)?.[1];
      if (nc !== undefined) return { componentId: `NamedCredential:${nc}` };
      return undefined;
    },
    patterns: [
      // "where is <non-field> used/referenced" — a `field`/`__c` signal defers to
      // locate-field (the field specialist) so only class/flow/object/CMDT/layout
      // usage lands here.
      /\bwhere\s+is\b(?![^?]*\bfield\b)(?![^?]*__c)[^?]*\b(used|referenced|consumed)\b/,
      /\b(what|who|which\s+components?)\b.*\b(uses?|references?|depends?\s+on|consumes?)\b/,
      /\bwhat\s+still\s+references\b/,
      // USAGE REACH (find_component_usages). "Which flows WRITE (to) <field>" —
      // the writers of a field scoped to a component TYPE (flows). Distinct from
      // field_provenance ("what writes X") by naming the referrer type first;
      // find_component_usages is the right dispatcher for "which <type> touch X".
      /\bwhich\s+(?:flows?|classes?|triggers?|automations?|processes?)\b[^.?!]{0,20}\b(writes?|write\s+to|updates?|reads?|references?|touch\w*|sets?)\b/,
      // "which flow SHOULD (do X / update Y) and why isn't it running" — a
      // which-component-does-this usage lookup phrased as a troubleshooting ask.
      /\bwhich\s+(?:flow|class|automation|process)\b[^.?!]{0,30}\bshould\b/,
      // "is <NamedFlow> triggered by <OtherFlow> or standalone" — whether one
      // component invokes another (an incoming-edge usage question).
      /\bis\s+(?:the\s+)?[a-z][a-z0-9_]*_[a-z0-9_]+\b[^.?!]{0,30}\btriggered\s+by\b/,
      // "does updating <field> trigger any <X> automation" — whether writing a
      // field fires downstream automation (the field's incoming/outgoing usage).
      // `[^?!]` (not `[^.?!]`) so the gap can span the dotted `Object.field__c`
      // name, whose `.` the standard class would otherwise stop at.
      /\bdoes\s+updating\b[^?!]{0,50}\btrigger\b[^?!]{0,30}\bautomation\b/,
      // "is <object> connected to <ExternalSystem>" — integration-usage of a
      // component; find_component_usages composes graph edges + the integration
      // map (the rule already carries integration_map as a secondary tool).
      /\b(is|are)\b[^.?!]{0,40}\b(connected\s+to|integrated\s+with|synced?\s+(?:to|with)|feeding)\b[^.?!]{0,30}\b(marketo|pardot|hubspot|external|api)\b/,
      // "is <NamedComponent> even/still needed anymore BASED ON USAGE" — a
      // still-in-use check on a named component, answered by walking its usage
      // edges. The "based on usage" / "still used anywhere" frame is the tell;
      // it keeps this off the cleanup-catalog tools (which take no named id).
      /\b(?:even|still)\s+(?:needed|used|referenced)\b[^?!]{0,20}\b(?:anymore\s+)?based\s+on\s+usage\b/,
      /\bstill\s+(?:used|referenced)\s+anywhere\b/,
    ],
  },
  {
    // Finding #44: martech (marketing-technology) connections — "what
    // marketing tools/martech does this org have", "does this org use
    // Pardot/Marketo/HubSpot/Marketing Cloud Connect". Distinct from the
    // "is <NamedObject> connected to Marketo" USAGE ask above (that stays a
    // component-usage lookup on a named component); this rule is the
    // ORG-WIDE catalog question with no named component to resolve, so it
    // is placed AFTER component-usage — a phrasing specific enough to hit
    // the "is X connected to Marketo" pattern keeps answering from there.
    // integration_map now composes `martechConnectors` (Finding #44) from
    // InstalledPackage namespace + NamedCredential/ExternalDataSource
    // endpoint signals — see known-integration-packages.ts.
    intent: 'martech-connections',
    plane: 'vault',
    tools: ['sfi.integration_map'],
    liveRequired: false,
    needsResolve: false,
    reason:
      "Martech (marketing-technology) connectors — Marketing Cloud Connect / Pardot / Account Engagement / Marketo / HubSpot — are surfaced in integration_map's martechConnectors section (namespace + endpoint heuristic, disclosed confidence).",
    patterns: [
      /\bmartech\b/,
      /\bmarketing\s+(?:tech(?:nology)?\s+)?stack\b/,
      /\b(?:what|which)\b[^.?!]{0,30}\bmarketing\s+(?:tools?|platforms?|automation(?:\s+platforms?)?|clouds?|connectors?)\b/,
      /\bmarketing\s+(?:tools?|platforms?|automation)\b[^.?!]{0,40}\b(?:does|do)\b[^.?!]{0,20}\borg\b/,
      /\b(?:marketing\s+cloud\s+connect|account\s+engagement)\b/,
      /\bdoes\s+(?:this|our|the)\s+org\s+(?:have|use)\b[^.?!]{0,40}\b(?:pardot|marketo|hubspot|marketing\s+cloud)\b/,
      /\b(?:do|does)\s+we\s+(?:have|use)\b[^.?!]{0,30}\b(?:pardot|marketo|hubspot|marketing\s+cloud\s+connect)\b/,
      /\b(?:pardot|marketo|hubspot)\b[^.?!]{0,30}\b(?:installed|connector|connection|integration)\b/,
      /\bwhat\s+martech\b/,
      /\bmarketing\s+connectors?\b/,
    ],
  },
  {
    intent: 'schema',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Object discovery/location — resolve the named object, then list/get from the vault catalog.',
    patterns: [/\bwhere\s+is\b.*\bobject\b/],
  },
  {
    intent: 'locate-field',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.find_field_anywhere'],
    liveRequired: false,
    needsResolve: true,
    reason:
      '"Where is X on Contact?" field-location asks (including typo variants) — resolve the field, then find_field_anywhere for placements. A bare "where is X" (no usage verb) is field location; "where is the X field used" is field usage; both stay here — component-usage above only takes the NON-field "where is … used".',
    patterns: [/\bwhere\s+is\b(?!.*\bobject\b)/],
  },
  {
    intent: 'resolve-lookup',
    plane: 'vault',
    tools: ['sfi.resolve'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Name lookup, typo correction, and ambiguous artifact selection are handled by the vault resolver.',
    patterns: [
      /\bfind\s+or\s+resolve\b/,
      /\bi\s+typed\b.*\b(salesforce\s+)?artifact\b.*\bmean\b/,
      /\bwhich\b.*\b(should\s+i\s+use|did\s+i\s+mean)\b/,
      /\bfind\s+[\w_]+\b/,
      /\bflows?\s+[A-Za-z][A-Za-z0-9_]*\s*$/,
      // Short informal object-name only — battery-right: "payment object"
      // (must not steal "… on the Opportunity object?" schema/list asks)
      /^(the\s+)?\w+\s+object\.?$/i,
    ],
  },
  {
    intent: 'naming-convention',
    plane: 'vault',
    tools: ['sfi.get_naming_convention_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Naming conventions are heuristic observations over vault components.',
    patterns: [
      /\bnaming\s+convention\b/,
      /\b(should\s+i\s+name|what\s+(do\s+we|should\s+i)\s+(call|name))\b/,
      /\b(suffix|prefix)\b.*\b(convention|standard)\b/,
      /\bwhat\s+naming\s+conventions?\b.*\b(should|follow)\b/,
    ],
  },
  {
    // Lightning record pages / FlexiPages — assignment + component breakdown.
    // "Which Lightning record page is assigned to X", "what components are on
    // the Y record page" fell through to schema/unrouted (B21.2).
    intent: 'flexipage',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.lightning_pages', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: true,
    reason:
      "Lightning record pages (FlexiPage) — which pages an object has, and a page's object / kind / label — are modeled in the vault (lightning_pages). Activation (which profile/app/record-type is served a page) is a separate Lightning App Builder assignment not in the metadata; lightning_pages discloses that.",
    patterns: [
      /\b(lightning\s+(record\s+)?page|flexipage)s?\b/,
      /\b(component|assign|which|what)\b.*\brecord\s+pages?\b/,
      /\brecord\s+pages?\b.*\b(assign|component|layout|for\s+the)\b/,
      /\bpages?\b.*\b(most\s+components|slowest|load\s+times?)\b/,
    ],
  },
  {
    // Picklist-value differences across record types — get_component on each
    // RecordType shows its picklist value sets. Fell through (B21.4).
    intent: 'record-type-picklist',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Record-type picklist-value assignments are in the vault — list the record types, then get_component each to compare picklist values.',
    patterns: [
      /\brecord\s+types?\b.*\b(picklist|differ|difference|values?)\b/,
      /\bpicklist\s+values?\b.*\b(record\s+types?|differ|between|across)\b/,
      /\bwhich\s+picklist\s+values?\b.*\brecord\s+type/,
    ],
  },
  {
    // Declared picklist values of a NAMED field — "what values are in the
    // Status picklist". Unrouted before Phase 14 (gallery-probe miss + gap
    // log). Placed AFTER record-type-picklist so cross-record-type value
    // diffs keep their specialist route (first match wins), and after
    // what-if-field so removal simulations win. Live USAGE phrasings
    // ("which values are actually used") deliberately do not match — that
    // is a live-plane question, not a declared-schema one.
    intent: 'picklist-values',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_field', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Declared picklist values live on the field in the vault — resolve the named field, then explain_field returns its inline value set (a GlobalValueSet-driven field discloses that its values live on the value-set component; get_component shows the full frontmatter).',
    patterns: [
      // "what values are in the Status picklist" / "what are the values in …"
      /\bwhat\s+(are\s+the\s+)?values?\s+(are\s+)?(in|of|for|on)\b.*\bpicklist/,
      // "what picklist values are available for Industry on Account" (baseline ADM-015)
      /\bwhat\s+picklist\s+values?\b.*\b(available|for|on|of)\b/,
      // "which values does the Stage picklist have"
      /\bwhich\s+values?\b.*\bpicklist/,
      // "list/show the picklist values for Case Status"
      /\b(list|show)\b.*\bpicklist\s+values?\b/,
      // "picklist values for the Status field" / "what picklist values does X have"
      /\bpicklist\s+values?\s+(for|of|on|does|available)\b/,
      /\b(available|possible)\s+picklist\s+values?\b/,
      // "what are the possible/available/allowed values for the Status field"
      /\b(possible|available|allowed|valid)\s+values?\b.*\b(field|picklist)/,
      // Named field without the word "picklist" — "what values are in Academic Eligibility"
      // (exclude snake_case CMDT api names — cmdt-record-values owns those).
      /\bwhat\s+(are\s+the\s+)?values?\s+(are\s+)?in\b(?!.*\b(__mdt\b|custom\s+metadata|custom\s+settings?\s+record)\b)(?!.*\w+_\w+)/,
    ],
  },
  {
    // Approval processes — list + steps. Fell through to schema/unrouted (B21.6).
    // ACTION-CHAIN: stacked LAST. This intent answers with a flat COMPONENT
    // CATALOG (list_components / get_component); `action_chain` answers the
    // same question as a SEQUENCE — submit, entry criteria, per-step approvers
    // and actions, final approval / rejection, lock, recall. The catalog stays
    // primary (it is the grounded inventory); the chain rides along.
    intent: 'approval-process',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component', 'sfi.action_chain'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Approval processes and their steps are modeled in the vault (ApprovalProcess) — list_components/get_component for the inventory, action_chain for the documented submit → approve/reject → lock/recall SEQUENCE instantiated against those components.',
    patterns: [
      /\bapproval\s+process(es)?\b/,
      /\bapproval\s+steps?\b/,
      /\bapproval\b.*\b(steps?|process|who\s+approves?|approvers?|stages?)\b/,
    ],
  },
  {
    // List views inventory (B21.8). P14-USAGE-listview-general: the old
    // "retrieved but not graph-modeled" note was STALE — ListView nodes carry
    // outgoing field-reference edges (a field used only in a list-view filter
    // shows the ListView among its referrers), and list_view_sharing covers
    // who can see one. Nothing references a ListView, so its usage shape is
    // consumer-style (outgoing only).
    intent: 'list-views',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'List views are catalogued and GRAPH-MODELED in the vault: list_components/get_component for the inventory, a list view’s outgoing field references via get_edges, and list_view_sharing for who can see it.',
    patterns: [/\blist\s+views?\b/],
  },
  {
    // Record VALUES of a Custom Metadata Type / Custom Setting — "what is the
    // Default record of Marketo_Api_Setting__mdt set to", "what values does
    // the US record hold". The vault DOES carry configured CMDT/CustomSetting
    // records (sfi.lookup_record), but the phrasings were unrouted and the
    // tool sat on the grandfather list (P14-ROUTER-cmdt-record-values).
    // Placed BEFORE custom-settings-cmdt: a record-VALUE ask outranks the
    // type-level "what custom settings exist" browse; record-type picklist
    // diffs already matched earlier (rule order).
    intent: 'cmdt-record-values',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.lookup_record', 'sfi.explain_field'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Configured Custom Metadata Type / Custom Setting RECORDS live in the vault — resolve the record (or its type), then lookup_record returns the per-field value list (masked managed-package values stay masked; explain_field with includeRecordValues compares one field across records).',
    patterns: [
      // "what is the Default record of Marketo_Api_Setting__mdt set to" /
      // "what does the US record hold/store/contain"
      /\bwhat\s+(is|does|do)\b.*\brecords?\b.*\b(hold|store|stores|contain|contains|set\s+to|configured)/,
      // "what value(s) does/is … record/__mdt/custom metadata/custom setting …"
      // NB: no leading \b before __mdt — a suffixed api name (Region_Config__mdt)
      // has no word boundary at the underscores, so \b__mdt never fires there.
      /\bvalues?\b.*\b(of|in|for|does|on)\b.*(__mdt\b|\bcustom\s+metadata\b|\bcustom\s+settings?\s+record\b)/,
      // ("show/list the values in the X records" deliberately has NO bare
      // pattern here — without a CMDT/custom-setting anchor that phrasing is
      // a live sample-records ask; the anchored form already matches above.)
      // "look up the Default record of …" / "lookup record …"
      /\blook\s*up\b.*\brecords?\b/,
      // "what is Api_Timeout set to in the Integration_Config custom setting"
      /\bset\s+to\b.*(\bcustom\s+settings?\b|\bcustom\s+metadata\b|__mdt\b)/,
      // "what values are in Status_Processor_Rule DefaultRecord" — a user
      // names the CMDT type WITHOUT the __mdt suffix (gallery-proven
      // phrasing). Pure-lexical cue: a snake_case api-name token that is NOT a
      // __c field; picklist-anchored asks matched the earlier picklist-values
      // rule already, and __c tokens are excluded so field value-set questions
      // never land here.
      /\bwhat\s+values?\s+(are\s+)?in\b(?!.*__c\b).*[a-z0-9]+_[a-z0-9]+/,
    ],
  },
  {
    // Custom Settings vs Custom Metadata Types — both retrieved as CustomObject.
    // Disambiguation gap (B21.9).
    intent: 'custom-settings-cmdt',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Custom Settings and Custom Metadata Types are modeled as CustomObject in the vault — list + get_component to see what they store.',
    patterns: [
      /\bcustom\s+settings?\b/,
      /\bcustom\s+metadata\s+types?\b/,
      /\b(cmdt|__mdt)\b/,
      /\bhierarch(y|ical|ic)\b.*\bsettings?\b/,
    ],
  },
  {
    // Difference between two profiles / permission sets (B21.10).
    intent: 'compare-profiles',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.compare_components'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Comparing two profiles or permission sets is a vault diff — resolve both, then compare_components.',
    patterns: [
      /\b(difference|differ|compare|versus|vs\.?)\b.*\bprofiles?\b/,
      /\bprofiles?\b.*\b(difference|differ|compare|versus|vs\b)\b/,
      /\bcompare\b.*\b(permission\s+sets?|profiles?)\b/,
    ],
  },
  {
    // DISCOVERY/META REACH: "compare A and B" / "explain the difference between
    // A and B" where A and B are TWO NAMED components (permission-set groups,
    // flows, classes) — a two-component diff, which compare_components answers.
    // Sits AFTER compare-profiles (that owns the "profiles"/"permission sets"
    // wording) and AFTER explain-flow (whose narration patterns carry a
    // compare-frame negative-lookahead, so a two-flow "difference between A and
    // B" deliberately falls through to HERE rather than being narrated as one
    // flow). Precision: every pattern requires TWO distinct named tokens joined
    // by "and"/"vs"/"versus" (or the explicit plural "PSGs"/"perm groups"), so
    // a single-component "explain X" never lands here.
    intent: 'compare-components',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.compare_components'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Comparing two named components is a vault diff — resolve both, then compare_components.',
    patterns: [
      // "compare the <NamedA> and <NamedB> PSGs" / "… perm groups" — an
      // explicit two-thing compare of permission-set GROUPS (compare-profiles
      // keys on "profiles"/"permission sets", not the "PSG"/"perm group" plural).
      new RegExp(
        `\\bcompare\\b[^.?!]{0,80}\\b(?:psgs?|perm(?:ission)?\\s+set\\s+groups?|perm\\s+groups?)\\b`,
      ),
      new RegExp(
        `\\b(?:psgs?|perm(?:ission)?\\s+set\\s+groups?|perm\\s+groups?)\\b[^.?!]{0,80}\\b(?:compare|difference|differ|versus|vs\\.?)\\b`,
      ),
      // "compare/difference between <NamedA> and <NamedB>" — two API-name tokens
      // (>=2 underscores each: unambiguously component ids, never prose) joined
      // by "and"/"&". The two-id requirement is what distinguishes a real
      // comparison from a single-component narration. The leading
      // `(?!.*record\s+types?)` yields a "difference between A and B and C record
      // TYPES" enumeration to record-type-enumeration below (list all types),
      // which is the honest surface for several record types side by side.
      new RegExp(
        `^(?!.*\\brecord\\s+types?\\b).*\\b(?:compare|difference|differ|versus|vs\\.?)\\b[^.?!]{0,40}\\b${NAMED_COMPONENT_ID}\\b[^.?!]{0,20}\\b(?:and|&|versus|vs\\.?)\\b[^.?!]{0,20}\\b${NAMED_COMPONENT_ID}\\b`,
      ),
    ],
  },
  {
    // DISCOVERY/META REACH: "does <NamedFlow> relate to the <concept> concept" /
    // "is <A> the same as <B>" — an org-vocabulary disambiguation, which
    // disambiguate_concepts answers (are these two tokens the same or distinct
    // concepts here). Anchored on the literal "concept(s)" noun OR the "same
    // as … thing/idea" frame so it never grabs a compare (two components) or a
    // field-lineage ("where does X go") question.
    intent: 'disambiguate-concepts-nl',
    plane: 'vault',
    tools: ['sfi.disambiguate_concepts'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Whether two org-specific concepts/terms mean the same thing is a vocabulary disambiguation (disambiguate_concepts).',
    patterns: [
      /\b(?:relate\s+to|related\s+to|same\s+as|different\s+from|distinct\s+from|the\s+same\s+thing)\b[^.?!]{0,50}\bconcepts?\b/,
      /\bconcepts?\b[^.?!]{0,50}\b(?:relate\s+to|related\s+to|same\s+as|different\s+from|distinct\s+from)\b/,
      /\bis\b[^.?!]{0,30}\bthe\s+same\s+(?:as|thing\s+as|concept\s+as)\b/,
    ],
  },
  {
    // DISCOVERY/META REACH: "which queues does <Named>_Queue route to and who
    // are the MEMBERS" — a NEUTRAL single-queue inspection (no failure frame),
    // which get_component renders (the Queue node carries members + routing).
    // resolve binds the named queue first. Distinct from empty-queues above,
    // which only fires on a can't/stuck SYMPTOM. Anchored on a `_queue`
    // API-name suffix (or the literal "queue" + "members") so it never grabs a
    // schema-inventory ("list all queues") ask.
    intent: 'queue-membership',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'A single queue\'s members and routing targets are on its Queue node — resolve the queue, then get_component.',
    patterns: [
      /\bwho\s+are\s+the\s+members?\b[^.?!]{0,60}\bqueues?\b/,
      /\bqueues?\b[^.?!]{0,60}\bwho\s+are\s+the\s+members?\b/,
      /\bwhich\s+queues?\b[^.?!]{0,40}\broute\b/,
    ],
  },
  {
    // DISCOVERY/META REACH: "what's the API version on the TDTM handlers / these
    // HEDA classes" — the per-class apiVersion is a get_component field. The
    // existing schema-rule api-version patterns cover the SINGULAR
    // "api version of X class" (Family-D contract) but missed the PLURAL
    // "handlers"/"classes" scan. Requires the api-version phrase with a PLURAL
    // handlers/classes/triggers noun (mandatory `s`) so the singular
    // "what is the api version of the AccountService class" stays on schema and
    // a plain "what version are we on" (org release) never matches.
    intent: 'component-api-version',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'The api version across a set of Apex classes / triggers / handlers is a per-component property scan — list_components then get_component per member.',
    patterns: [
      /\bapi\s+version\b[^.?!]{0,60}\b(?:classes|handlers|triggers)\b/,
      /\b(?:classes|handlers|triggers)\b[^.?!]{0,60}\bapi\s+version\b/,
    ],
  },
  {
    // DISCOVERY/META REACH: "explain the difference between <RT_A> and <RT_B>
    // and <RT_C> record types" — an enumeration of MULTIPLE record types on an
    // object; list_components(type: 'RecordType') is the honest surface (the
    // user wants each type side by side, not a pairwise diff). Requires the
    // literal "record types" plural AND at least the "difference"/"vs" framing
    // over 3+ named types joined by "and" — so a two-thing "compare A and B"
    // (handled by compare-components) and a single "what is the X record type"
    // do not land here.
    intent: 'record-type-enumeration',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'Distinguishing several record types on an object is a vault enumeration — list_components(RecordType) plus get_component per type.',
    suggestArgs: () => ({ type: 'RecordType' }),
    patterns: [
      // "difference between A and B and C record types" — 3+ names joined by
      // "and", trailing "record types". The two "and"-joins are the tell that
      // this is a multi-type enumeration, not a pairwise compare.
      /\b(?:difference|differ|distinguish|compare)\b[^.?!]{0,120}\band\b[^.?!]{0,60}\band\b[^.?!]{0,60}\brecord\s+types?\b/,
    ],
  },
  {
    // M38 — "what does this formula (field) do/calculate" is explain_formula, which
    // no rule emits top-1 (it is only a tail tool elsewhere). Currently unrouted.
    // Patterns avoid formula-references ("which formulas reference X").
    intent: 'explain-formula',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.explain_formula'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Plain-English narration of what a formula field computes (explain_formula).',
    patterns: [
      /\bwhat\b[^.?!]{0,30}\bformula\b[^.?!]{0,20}\b(?:do(?:es)?|calculat\w*|comput\w*|return)\b/,
      /\bexplain\b[^.?!]{0,20}\bformula\b/,
    ],
  },
  {
    intent: 'capabilities',
    plane: 'vault',
    tools: ['sfi.capabilities'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Catalog of answerable question families and tools — no guessing required.',
    patterns: [
      /\bwhat\s+can\s+you\s+do\b/,
      /\bwhat\s+are\s+you\s+capable\b/,
      /\bwhat\s+tools?\s+(do\s+you\s+have|are\s+available)\b/,
      /\bhelp\b.*\b(capabilit|tools?|commands?)\b/,
      // DISCOVERY/META REACH: "what are you actually able to answer about this
      // org", "what can I ask" — a self-capability ask. `able to answer` /
      // `can .. ask` co-anchored so it never grabs an org-content question
      // ("what can this profile do"): the subject is the tool ("you"/"I"/"this"),
      // not an org component.
      /\bwhat\b[^.?!]{0,30}\b(?:you|i)\b[^.?!]{0,20}\b(?:able\s+to\s+answer|answer\s+about|ask\s+about|ask\s+you)\b/,
      /\bwhat\s+can\s+i\s+ask\b/,
      // "can you (even) tell me anything about … record data … or is this just
      // metadata" — a boundary/capability probe. `just metadata` / `only
      // metadata` is the capability-boundary tell (capabilities reports the
      // metadata-vs-live-record boundary); it never appears in a real
      // org-content question.
      /\b(?:just|only)\s+metadata\b/,
      /\bcan\s+you\s+(?:even\s+)?tell\s+me\s+anything\s+about\b[^.?!]{0,40}\b(?:record\s+data|data\s+in\s+here)\b/,
    ],
  },
  {
    intent: 'schema',
    plane: 'vault',
    tools: ['sfi.list_components', 'sfi.get_component', 'sfi.search_components'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Object/field/record-type/picklist structure is the core of the offline vault.',
    suggestArgs: (q, question) => {
      const type = deriveListType(q);
      const parentId = deriveMetadataParentId(q, question);
      if (type !== undefined && parentId !== undefined) return { type, parentId };
      if (type !== undefined) return { type };
      const fieldParent = deriveFieldListParent(q);
      if (fieldParent !== undefined) return { type: 'CustomField', parentId: fieldParent };
      if (/\bformula\b/.test(q) && /\bfields?\b/.test(q)) {
        const objectApi = deriveObjectApiFromQuestion(q, question);
        if (objectApi !== undefined) return { type: 'CustomField', parentId: `CustomObject:${objectApi}` };
      }
      if (/\bpicklists?\b/.test(q) && /\bfields?\b/.test(q)) {
        const objectApi = deriveObjectApiFromQuestion(q, question);
        if (objectApi !== undefined) return { type: 'CustomField', parentId: `CustomObject:${objectApi}` };
      }
      if (/\brequired\b/.test(q) && /\bfields?\b/.test(q)) {
        const objectApi = deriveObjectApiFromQuestion(q, question);
        if (objectApi !== undefined) return { type: 'CustomField', parentId: `CustomObject:${objectApi}` };
      }
      return undefined;
    },
    patterns: [
      /\bwhat\s+(objects?|fields?|custom\s+objects?|record\s+types?|picklists?|validation\s+rules?)\b/,
      /\b(which|what)\s+fields?\b.*\b(on|for)\b.*\b(formula|picklist|required|encrypted)\b/,
      /\bwhat\s+standard\s+fields?\b/,
      /\bwhat\s+metadata\s+exists\b/,
      /\b(fields?|structure|schema)\s+(of|on|does|for)\b/,
      /\bwhat\s+(type|kind)\s+is\b/,
      /\blist\s+(all\s+)?(objects?|fields?|components?|flows?|classes?|profiles?|permission\s+sets?|layouts?)\b/,
      // "show me the objects in this org" / "show Evaluation fields" / "list the
      // flows" — "show"/"list" with the metadata noun anywhere after (the bare
      // "list X" / "what X" patterns missed these). Battery gaps.
      /\b(show|list)\b.*\b(objects?|fields?|flows?|classes?|triggers?|record\s+types?|profiles?|permission\s+sets?|layouts?|validation\s+rules?|queues?|groups?|labels?)\b/,
      /\b(web\s+links?|custom\s+buttons?)\b.*\b(exist|on|for|defined)\b/,
      /\bwhat\b.*\b(web\s+links?|custom\s+buttons?)\b/,
      /\bwhere\s+is\b.*\bfield\b/,
      /\bsearch\s+broadly\s+for\b/,
      /\bvalidation\s+rules?\s+on\b/,
      /\bduplicate\s+rules?\b/,
      // Object RELATIONSHIP questions — "what is the relationship between
      // Account and Contact", "child objects of Case", "master-detail with
      // Opportunity": lookupTo edges + object structure are core vault
      // schema (a top baseline-300 unrouted cluster;
      // P14-ROUTER-goldset-expand).
      /\b(relationships?\s+between|master[-\s]detail|junction\s+objects?|child\s+objects?\s+of)\b/,
      /\bwhat\s+(apex\s+)?classes?\b.*\b(exist|in\s+this\s+org|are\s+there)\b/,
      /\bwhat\s+apex\s+classes?\s+exist\b/,
      /\bwhat\s+standard\s+objects?\b/,
      /\bstandard\s+objects?\b.*\b(available|in\s+this\s+org|exist)\b/,
      /\bstandard\s+report\s+types?\b.*\b(available|out\s+of\s+the\s+box|exist)\b/,
      /\bwhat\s+report\s+types?\b.*\b(available|standard|out\s+of\s+the\s+box)\b/,
      /\bwhere\s+is\b.*\bobject\b/,
      /\bwhat\s+is\s+the\s+api\s+version\b/,
      /\bapi\s+version\b.*\b(apex|class)\b/,
      // UI component inventory (baseline-300 cluster).
      /\bwhat\s+(lightning\s+web\s+components?|lwcs?|aura\s+components?|visualforce\s+pages?)\b/,
      /\bwhat\s+visualforce\b/,
      /\bwhat\s+custom\s+labels?\b.*\b(defined|exist|in\s+this\s+org)\b/,
      /\bwhat\s+permission\s+set\s+groups?\b/,
      /\b(which|what)\s+permission\s+set\s+groups?\b.*\b(exist|include)\b/,
      /\bstandard\s+stages?\b.*\b(opportunity|sales\s+process)\b/,
      /\b(active\s+)?workflow\s+rules?\b.*\b(running|still|exist)\b/,
      /\bworkflow\s+rules?\b.*\b(still\s+running|active)\b/,
      /\bobjects?\b.*\b(person\s+accounts?|enabling\s+person)\b/,
      /\breports?\b.*\btime\s+out\b/,
    ],
  },
];

const alternativeFromIntent = (intent: string): RouteAlternative | null => {
  const rule = RULES.find((candidate) => candidate.intent === intent);
  return rule === undefined
    ? null
    : {
        intent: rule.intent,
        plane: rule.plane,
        tools: rule.tools,
        reason: rule.reason,
      };
};

/**
 * Some questions are semantically ambiguous even when only one regex family
 * matches. Keep the existing best route, but stop execution and expose the
 * materially different analysis the user may have intended.
 */
const semanticAlternatives = (q: string, primaryIntent: string): readonly RouteAlternative[] => {
  const intents: string[] = [];
  const namesField = /\bfield\b|[a-z0-9_]+\.[a-z0-9_]+/i.test(q);

  if (
    primaryIntent === 'impact-analysis' &&
    namesField &&
    /\b(delete|delet(?:ing|ion)|remove|removing)\b/.test(q) &&
    !/\b(safe[\s-]+to[\s-]+delete|safe-to-delete\s+verdict|block\s+deletion)\b/.test(q)
  ) {
    intents.push('safe-to-delete');
  }
  if (
    primaryIntent === 'impact-analysis' &&
    namesField &&
    /\b(change|changing|modify|modifying)\b/.test(q) &&
    !/\b(method\s+signature|field\s+type|data\s+type|required|picklist\s+value)\b/.test(q)
  ) {
    intents.push('what-if-field');
  }
  if (
    primaryIntent === 'who-can-access-object' &&
    /\bwho\s+can\s+access\b/.test(q) &&
    !/\b(records?|all|every|create|read|edit|delete|view|sharing|owd)\b/.test(q)
  ) {
    intents.push('object-access');
  }
  if (
    primaryIntent === 'runtime-audit-trail' &&
    /\bwho\s+(?:last\s+)?(?:changed|modified|edited|updated|deleted)\b/.test(q) &&
    !/\b(records?|data|field\s+history|history\s+tracking|setup\s+audit|audit\s+trail|debug\s+logs?|event\s+monitoring)\b/.test(q)
  ) {
    intents.push('last-modified');
  }

  return intents
    .filter((intent) => intent !== primaryIntent)
    .map(alternativeFromIntent)
    .filter((alternative): alternative is RouteAlternative => alternative !== null);
};

const intentLabel = (intent: string): string => {
  const labels: Readonly<Record<string, string>> = {
    'impact-analysis': 'the full dependency blast radius',
    'safe-to-delete': 'a safe-to-delete verdict',
    'what-if-field': 'a simulated field schema change',
    'who-can-access-object': 'record-level visibility',
    'object-access': 'object-level CRUD permissions',
    'runtime-audit-trail': 'the runtime record/audit trail',
    'last-modified': 'the metadata component last-modified information',
  };
  return labels[intent] ?? `the ${intent.replaceAll('-', ' ')} analysis`;
};

/**
 * Alternative pairs that are COMPLEMENTARY, not competing (router-v2 P4):
 * both readings are read-only vault analyses answering the same question
 * through different lenses ("who can access X" = the grantor enumeration AND
 * the CRUD matrix; "what breaks if I change/delete X" = the dependency blast
 * radius AND the simulation verdict). Blocking on a which-do-you-want-first
 * clarification added a round-trip carrying zero information — either tool
 * (usually both) answers, so these pairs STACK: the alternative's tools append
 * to the primary route, the alternative stays listed for transparency, and
 * execution is NOT blocked. Pairs absent here still genuinely diverge and keep
 * the blocking clarification.
 */
const COMPLEMENTARY_ALTERNATIVE_PAIRS: ReadonlySet<string> = new Set([
  'impact-analysis|safe-to-delete',
  'impact-analysis|what-if-field',
  'who-can-access-object|object-access',
]);

/**
 * The runtime-audit-trail | last-modified split resolves from a QUALIFIER the
 * question already carries (router-v2 P4): "who last modified <a named
 * component>" is the metadata stamp (`last_modified`), not record forensics —
 * an API-ish token (underscored / __suffix / dotted) or an explicit metadata
 * type noun next to the ask names a COMPONENT, and the clarification the
 * router used to raise is pre-answered. Record/data phrasings never reach
 * this (the semanticAlternatives excluder drops the pair entirely).
 */
const NAMES_COMPONENT_FOR_LAST_MODIFIED =
  /[a-z0-9]_[a-z0-9]|__(?:c|mdt|e|x|b|kav)\b|\w+\.\w+|\b(?:flow|flows|class|classes|trigger|triggers|validation\s+rule|permission\s+set|profile|layout|object|field|component|page|dashboard|report)\b/;

/**
 * Classify a question. Pure: no I/O, deterministic. Returns the best route, or
 * `plane: 'unknown'` with a gap when nothing matches.
 */
export const classifyQuestion = (question: string): RouteResult => {
  const q = routeText(question);
  if (q.length === 0) {
    return {
      question,
      plane: 'unknown',
      intent: 'empty',
      tools: [],
      liveRequired: false,
      needsResolve: false,
      reason: 'Empty question.',
      gap: { category: 'empty', note: 'No question text supplied.' },
      confidence: 'low',
      risk: 'informational',
      alternatives: [],
      clarification: null,
      plan: [],
    };
  }
  const matches = RULES.filter((rule) => rule.patterns.some((p) => p.test(q)));
  const first = matches[0];
  if (first !== undefined) {
    let primary = routeFromRule(question, q, first);
    // Ordered regex rules intentionally overlap: a later match often adds
    // recall, not a genuinely competing user goal. Only explicit semantic
    // ambiguity policies may stop execution; raw overlap remains diagnostic
    // implementation detail and must not interrupt a correctly routed user.
    let alternatives = [...semanticAlternatives(q, primary.intent)]
      .filter((alternative, i, all) =>
        alternative.intent !== primary.intent &&
        all.findIndex((candidate) => candidate.intent === alternative.intent) === i
      )
      .slice(0, 3);
    // Router-v2 P4 QUALIFIED AUTO-RESOLVE: "who last modified <a named
    // component>" — the component mention pre-answers the runtime-vs-metadata
    // clarification, so route the metadata stamp directly. Without a
    // component-ish qualifier the pair stays a genuine blocking ambiguity.
    if (
      primary.intent === 'runtime-audit-trail' &&
      alternatives.some((alternative) => alternative.intent === 'last-modified') &&
      NAMES_COMPONENT_FOR_LAST_MODIFIED.test(q)
    ) {
      const lastModifiedRule = RULES.find((rule) => rule.intent === 'last-modified');
      if (lastModifiedRule !== undefined) {
        primary = routeFromRule(question, q, lastModifiedRule);
        alternatives = [];
      }
    }
    // Router-v2 P4 COMPLEMENTARY STACKING: pairs where either reading answers
    // (both read-only, same plane family) never block — the alternative's
    // tools stack after the primary's and stay listed for transparency.
    const complementary = alternatives.filter((alternative) =>
      COMPLEMENTARY_ALTERNATIVE_PAIRS.has(`${primary.intent}|${alternative.intent}`),
    );
    const blocking = alternatives.filter(
      (alternative) => !complementary.includes(alternative),
    );
    const stackedTools =
      complementary.length > 0
        ? [
            ...primary.tools,
            ...complementary
              .flatMap((alternative) => alternative.tools)
              .filter((tool) => !primary.tools.includes(tool)),
          ]
        : primary.tools;
    if (complementary.length > 0) {
      primary = {
        ...primary,
        tools: stackedTools,
        reason:
          `${primary.reason} The question also admits a complementary reading ` +
          `(${complementary.map((a) => intentLabel(a.intent)).join('; ')}) — its ` +
          `tools are stacked after the primary so either or both can run; no ` +
          `clarification needed.`,
      };
    }
    const clarification =
      blocking.length > 0
        ? {
            required: true,
            question: `Which result do you want first: ${intentLabel(primary.intent)}, or ${blocking.map((a) => intentLabel(a.intent)).join(', ')}?`,
            options: [primary.intent, ...blocking.map((a) => a.intent)],
            fallback: {
              intent: primary.intent,
              warning:
                `Clarification was unavailable. Provisional route: ${primary.intent}. ` +
                `Show the user the alternatives before executing it.`,
            },
          }
        : null;
    return {
      ...primary,
      confidence:
        blocking.length > 0 ? 'low' : complementary.length > 0 ? 'medium' : 'high',
      alternatives,
      clarification,
      plan: [{
        stepId: 'step-1',
        dependsOn: [],
        question,
        intent: primary.intent,
        plane: primary.plane,
        tools: primary.tools,
      }],
    };
  }
  return {
    question,
    plane: 'unknown',
    intent: 'unrouted',
    tools: ['sfi.resolve', 'sfi.capabilities'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'No rule matched. Resolve any named component first, or ask sfi.capabilities for what is answerable — do not fabricate.',
    gap: {
      category: 'unrouted',
      note: 'Question did not match any known intent; logged so the router/tool library can grow toward it.',
    },
    confidence: 'low',
    risk: 'informational',
    alternatives: [],
    clarification: null,
    plan: [],
  };
};

/**
 * Every distinct `sfi.*` tool any rule can route to, plus the front-door
 * fallback (`resolve`/`capabilities`). Used as a CI contract: each must be a
 * real registered tool in `V01_TOOLS`, so a renamed/removed tool or a typo in a
 * rule fails the build instead of silently emitting a dead tool name.
 */
export const allRoutableTools = (): readonly string[] => {
  const set = new Set<string>(['sfi.resolve', 'sfi.capabilities']);
  for (const rule of RULES) for (const t of rule.tools) set.add(t);
  return [...set].sort();
};

// ---------------------------------------------------------------------------
// Gap log — the "log gaps so the library grows toward real demand" mechanism.
// ---------------------------------------------------------------------------

/** One appended gap record. */
export interface GapLogEntry {
  readonly at: string;
  readonly question: string;
  readonly category: string;
  readonly intent: string;
  readonly plane: Plane;
  readonly note: string;
  /**
   * The vault the question was asked against (P14-FEEDBACK-gaplog-scope /
   * P-GAPLOG-GLOBAL). The log FILE stays machine-global, but entries are
   * stamped so `sfi feedback export` can scope to the current vault by
   * default — question text routinely names org-specific components, and a
   * multi-org machine must not bundle every org's questions into one
   * shareable file. Absent on pre-0.1.10 entries (exported only via --all).
   */
  readonly vaultRoot?: string;
}

/**
 * Path of the local gap log. `SFI_GAP_LOG_PATH` overrides it (tests); otherwise
 * `~/.sf-intelligence/question-gaps.jsonl`. Vault-independent on purpose, so it
 * also captures gaps in the no-vault path. Local-only — never sent to Git.
 */
export const gapLogPath = (): string => {
  const override = process.env['SFI_GAP_LOG_PATH'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.sf-intelligence', 'question-gaps.jsonl');
};

/**
 * Append a gap to the log if the route carries one. Best-effort and never
 * throws — a failed write must never break answering. Returns the entry it
 * wrote (or null when there was no gap / the write failed).
 */
export const logGapIfAny = async (
  route: RouteResult,
  path: string = gapLogPath(),
  vaultRoot?: string,
): Promise<GapLogEntry | null> => {
  if (route.gap === null) return null;
  const entry: GapLogEntry = {
    at: new Date().toISOString(),
    question: route.question,
    category: route.gap.category,
    intent: route.intent,
    plane: route.plane,
    note: route.gap.note,
    ...(vaultRoot !== undefined && vaultRoot.length > 0 ? { vaultRoot } : {}),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  } catch {
    return null;
  }
};

/** One category bucket in a {@link RouteGapSummary}. */
export interface RouteGapCategoryCount {
  readonly category: string;
  readonly count: number;
}

/**
 * Aggregated view of the local route-gap log. Category counts only — never
 * echoes question text or vault paths (those can name org-specific components).
 * Used by `sfi doctor`, `sfi gaps report`, and the `sfi.capabilities` nudge
 * (R8-GAPLOG-SURFACE).
 */
export interface RouteGapSummary {
  readonly exists: boolean;
  readonly count: number;
  readonly topCategory: string | null;
  readonly topCount: number;
  /** Categories ranked by count descending (optionally truncated via `top`). */
  readonly categories: readonly RouteGapCategoryCount[];
}

/** Options for {@link summarizeRouteGaps}. */
export interface SummarizeRouteGapsOptions {
  /**
   * Only count entries whose `at` is on/after this instant. Accepts a `Date`
   * or an ISO-8601 string. Entries missing/unparseable `at` are excluded when
   * a since filter is set.
   */
  readonly since?: Date | string;
  /** Max categories to return in `categories` (all when omitted). */
  readonly top?: number;
}

/**
 * Summarize the local route-gap log (`question-gaps.jsonl`): how many questions
 * hit a router gap, and the ranked gap categories. Best-effort and never
 * throws — a missing/garbled log just reports zero gaps. Local-only telemetry;
 * the file never leaves the machine. (P12-ROUTER-confusion-report /
 * R8-GAPLOG-SURFACE.)
 */
export const summarizeRouteGaps = async (
  logFile: string,
  opts?: SummarizeRouteGapsOptions,
): Promise<RouteGapSummary> => {
  let raw: string;
  try {
    raw = await readFile(logFile, 'utf8');
  } catch {
    // No log at all ≠ "ran clean": the MCP server has not logged anything on
    // this machine, so the check must not read as a passing routing audit.
    return { exists: false, count: 0, topCategory: null, topCount: 0, categories: [] };
  }
  const sinceMs =
    opts?.since === undefined
      ? null
      : opts.since instanceof Date
        ? opts.since.getTime()
        : Date.parse(opts.since);
  const byCategory = new Map<string, number>();
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { category?: unknown; at?: unknown };
      if (sinceMs !== null) {
        if (Number.isNaN(sinceMs)) {
          // Invalid since → treat as no matches (caller should validate first).
          continue;
        }
        const atMs = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN;
        if (Number.isNaN(atMs) || atMs < sinceMs) continue;
      }
      const cat = typeof entry.category === 'string' ? entry.category : 'unknown';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      count += 1;
    } catch {
      // skip a malformed line; never break the diagnostic
    }
  }
  const ranked = [...byCategory.entries()]
    .map(([category, n]) => ({ category, count: n }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const limit = opts?.top !== undefined && opts.top >= 0 ? opts.top : ranked.length;
  const categories = ranked.slice(0, limit);
  const top = categories[0];
  return {
    exists: true,
    count,
    topCategory: top?.category ?? null,
    topCount: top?.count ?? 0,
    categories,
  };
};

/**
 * Open-gap count at which `sfi.capabilities` surfaces a review nudge
 * (R8-GAPLOG-SURFACE). Below this, the count is still reported but `nudge`
 * stays null so a quiet machine is not noisy.
 */
export const ROUTE_GAP_NUDGE_THRESHOLD = 5;

/** Capabilities / host-facing open-gap nudge payload. */
export interface RouteGapsNudge {
  readonly openCount: number;
  readonly threshold: number;
  /** Non-null only when `openCount >= threshold`. */
  readonly nudge: string | null;
}

/**
 * Build the open-gap nudge for `sfi.capabilities`. Category/count only — never
 * includes question text or vault paths. Best-effort; a missing log → count 0.
 */
export const routeGapsNudge = async (
  logFile: string = gapLogPath(),
  threshold: number = ROUTE_GAP_NUDGE_THRESHOLD,
): Promise<RouteGapsNudge> => {
  const summary = await summarizeRouteGaps(logFile);
  const openCount = summary.count;
  return {
    openCount,
    threshold,
    nudge:
      openCount >= threshold
        ? `${openCount.toLocaleString()} open route gaps — run \`sfi gaps report\` to review`
        : null,
  };
};
