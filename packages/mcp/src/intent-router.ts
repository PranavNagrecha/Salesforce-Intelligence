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

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** Extract a Salesforce object apiName from a routed question phrase. */
const deriveObjectApiFromQuestion = (q: string, question?: string): string | undefined => {
  const source = question ?? q;
  const toolObject = source.match(
    /\b(?:automation_build_advisor|order_of_execution|apex_build_advisor)\b\s+(?:on\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\b/i,
  );
  if (toolObject?.[1] !== undefined) return toolObject[1];
  const onObject = source.match(
    /\b(?:on|for|to|access\s+to)\s+(?:the\s+|an\s+|a\s+)?([A-Za-z][A-Za-z0-9_]*(?:__c|__mdt|__e)?)\b/i,
  );
  if (onObject?.[1] !== undefined) return onObject[1];
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
    intent: 'release-readiness',
    plane: 'vault',
    tools: ['sfi.release_readiness_report', 'sfi.org_risk_report', 'sfi.tech_debt_score'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit release_readiness_report invocation.',
    patterns: [/\brelease_readiness_report\b/],
  },
  {
    intent: 'tech-debt',
    plane: 'vault',
    tools: ['sfi.tech_debt_score', 'sfi.org_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit tech_debt_score invocation.',
    patterns: [/\btech_debt_score\b/],
  },
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
    intent: 'retrieve-blindspot',
    plane: 'vault',
    tools: ['sfi.retrieve_blindspot_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit retrieve_blindspot_report invocation.',
    patterns: [/\bretrieve_blindspot_report\b/],
  },
  {
    intent: 'automation-on-object',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.automation_build_advisor', 'sfi.get_edges'],
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
    intent: 'automation-risk',
    plane: 'vault',
    tools: ['sfi.automation_risk_report'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit automation_risk_report invocation.',
    patterns: [/\bautomation_risk_report\b/],
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
    intent: 'clone-patterns',
    plane: 'vault',
    tools: ['sfi.find_clone_patterns'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit find_clone_patterns invocation.',
    patterns: [/\bfind_clone_patterns\b/],
  },
  {
    intent: 'impact-analysis',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.field_change_advisor'],
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
    tools: ['sfi.resolve', 'sfi.field_change_advisor', 'sfi.get_impact'],
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
    tools: ['sfi.resolve', 'sfi.field_provenance'],
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
    intent: 'cross-org-diff',
    plane: 'vault',
    tools: ['sfi.compare_vaults', 'sfi.compare_object_across_vaults', 'sfi.compare_profile_across_vaults'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit compare_object_across_vaults invocation.',
    patterns: [/\bcompare_object_across_vaults\b/],
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
    tools: ['sfi.resolve', 'sfi.downstream_effects'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit downstream_effects invocation.',
    patterns: [/\bdownstream_effects\b/],
  },
  {
    intent: 'dependency-cycles',
    plane: 'vault',
    tools: ['sfi.find_dependency_cycles'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit find_dependency_cycles invocation.',
    patterns: [/\bfind_dependency_cycles\b/],
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
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit safe_to_delete_field invocation.',
    patterns: [/\bsafe_to_delete_field\b/],
  },
  {
    intent: 'what-if-field',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_make_field_required', 'sfi.what_if_change_field_type', 'sfi.what_if_remove_picklist_value'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit what-if field schema simulators.',
    patterns: [
      /\bwhat_if_make_field_required\b/,
      /\bwhat_if_change_field_type\b/,
      /\bwhat_if_remove_picklist_value\b/,
    ],
  },
  {
    intent: 'scheduled-jobs',
    plane: 'vault',
    tools: ['sfi.scheduled_job_catalog'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit scheduled_job_catalog invocation.',
    patterns: [/\bscheduled_job_catalog\b/],
  },
  {
    intent: 'async-chain-depth',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.async_chain_depth'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit async_chain_depth invocation.',
    patterns: [/\basync_chain_depth\b/],
  },
  {
    intent: 'endpoints',
    plane: 'vault',
    tools: ['sfi.endpoint_catalog', 'sfi.outbound_message_catalog'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit endpoint_catalog / outbound_message_catalog invocation.',
    patterns: [/\bendpoint_catalog\b/, /\boutbound_message_catalog\b/],
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
    intent: 'architecture-overview',
    plane: 'vault',
    tools: ['sfi.generate_architecture_overview'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit generate_architecture_overview invocation.',
    patterns: [/\bgenerate_architecture_overview\b/],
  },
  {
    intent: 'data-dictionary',
    plane: 'vault',
    tools: ['sfi.generate_data_dictionary'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit generate_data_dictionary invocation.',
    patterns: [/\bgenerate_data_dictionary\b/],
  },
  {
    intent: 'admin-handbook',
    plane: 'vault',
    tools: ['sfi.generate_admin_handbook'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit generate_admin_handbook invocation.',
    patterns: [/\bgenerate_admin_handbook\b/],
  },
  {
    intent: 'layout-access',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.layout_for_user', 'sfi.list_components'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit layout_for_user invocation.',
    patterns: [/\blayout_for_user\b/],
  },
  {
    intent: 'recordtype-availability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.recordtype_availability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit recordtype_availability invocation.',
    patterns: [/\brecordtype_availability\b/],
  },
  {
    intent: 'tab-availability',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.tab_availability'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Explicit tab_availability invocation.',
    patterns: [/\btab_availability\b/],
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
  {
    intent: 'dead-code',
    plane: 'vault',
    tools: ['sfi.find_dead_code'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit find_dead_code invocation.',
    patterns: [/\bfind_dead_code\b/],
  },
  {
    intent: 'hardcoded-values-anywhere',
    plane: 'vault',
    tools: ['sfi.find_hardcoded_values_anywhere'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Explicit find_hardcoded_values_anywhere invocation.',
    patterns: [/\bfind_hardcoded_values_anywhere\b/],
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
      /\b(licen[sc]e|seat)s?\b.*\b(usage|used|unused|utili[sz]ation|utilized|reclaim|reclaimable|available|free|provision|assigned|wasted|cost|optimi[sz])/,
      /\b(usage|utili[sz]ation|utilized|reclaim|reclaimable|unused|provision|assigned|wasted)\b.*\b(licen[sc]e|seat)s?\b/,
      /\bpermission\s+set\s+licen[sc]e/,
      /\bhow\s+many\s+(licen[sc]e|seat)s?\b/,
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
      /\b(who|users?|people)\b.*\b(log(ged)?\s?in|login|active|inactive|dormant)\b/,
      /\b(inactive|dormant|stale|unused)\b.*\busers?\b/,
      /\bhaven'?t\b.*\blog(ged)?\s?in\b/,
      /\blast\s+login\b/,
      // Login-activity counts only — bare "how many users" is a live record
      // count (record-count) or a permission audit (over-permission), not dormancy.
      /\bhow\s+many\b.*\b(inactive|dormant|stale)\b.*\busers?\b/,
      /\bhow\s+many\b.*\busers?\b.*\b(inactive|dormant|stale|haven'?t\s+logged|not\s+logged)\b/,
      /\b(license|seat)s?\b.*\b(reclaim|unused|free|available)\b/,
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
      // (vs the adjective "populated"). Battery gap.
      /\b(field\s+)?population\b/,
      // `fields?`/`values?` — `\b(field|value)\b` missed the PLURALS, so
      // "which Account fields are empty" fell through to metadata-count
      // (vault plane) instead of this hybrid live-data intent.
      /\b(empty|blank|null)\b.*\b(fields?|values?)\b/,
      /\b(fields?|values?)\b.*\b(empty|blank|null|populated|filled)\b/,
      /\bhow\s+many\b.*\b(have|with|without)\b.*\b(field|value|filled|set)\b/,
      /\b(actually|really)\s+(populated|filled)\b/,
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
      /\b(org|governor)\s+limits?\b(?!.*\b(risks?|apex|loop|soql|dml|static|trigger|class|queries?|large\s+data\s+volumes?)\b)/,
      /\b(api|daily)\s+(usage|calls?|limit)\b/,
      /\b(data|file)\s+storage\b/,
      /\bhow\s+much\s+(storage|api|data)\b/,
      /\b(headroom|quota|capacity)\b/,
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
      /^(?!.*(__mdt\b|\bcustom\s+metadata\b|\bcustom\s+settings?\b)).*\b(show|give|sample|example)s?\b.*\b(records?|rows?)\b/,
      /\b(show|give)\s+me\s+\d+\b/,
      /\bsample\s+\d+\b/,
      /\b\d+\s+(sample|example)\s+\w+\b/,
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
      /\bhow\s+many\b.*\b(page\s+layouts?|layouts?|custom\s+objects?|profiles?|permission\s+sets?|validation\s+rules?|flows?|(apex\s+)?classes?|triggers?|record\s+types?|list\s+views?|report\s+types?|record\s+pages?|flexipages?|approval\s+process(es)?|custom\s+settings?|quick\s+actions?|sharing\s+rules?|named\s+credentials?|picklists?)\b/,
      /\bhow\s+many\b.*\blayouts?\b.*\b(per|for\s+each|by)\b.*\bprofiles?\b/,
      /\blayouts?\b.*\b(per|for\s+each|by)\b.*\bprofiles?\b/,
      // fields, but NOT field usage/population (those are unused-fields / field-population)
      /\bhow\s+many\b.*\b(custom\s+)?fields?\b(?!.*\b(used|populated|filled|actually|unused|empty|blank|set|values?)\b)/,
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
      /\bduplicate\b.*\b(records?|values?|emails?|contacts?|accounts?|fields?|rows?)\b/,
      /\b(records?|values?|emails?|contacts?|accounts?)\b.*\bduplicate\b/,
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
      /\bhow\s+many\b.*\b(records?|rows?|accounts?|contacts?|opportunit|leads?|cases?)\b/,
      /\b(count|number)\s+of\b.*\b(records?|rows?)\b/,
      /\bhow\s+many\b.*\bin\s+(the\s+)?(org|production|prod)\b/,
      /\blive\s+count\b/,
      // A TEMPORAL qualifier cues live data regardless of the noun — "how
      // many open applications do we have right now" was unrouted because
      // the noun list above can never name every object (the last Phase-14
      // gallery miss; P14-ROUTER-live-count-temporal). Metadata nouns still
      // win: the metadata-count rule sits earlier. fired/ran/logged forms
      // are excluded so automation/login activity asks don't collapse into
      // a bare record count.
      /\bhow\s+many\b(?!.*\b(fired|ran|executed|triggered|logged)\b).*\b(right\s+now|currently|at\s+the\s+moment|as\s+of\s+(now|today)|today)\b/,
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
      /\b(recent(ly)?|last\s+\d+\s+days?|this\s+week|past\s+week)\b.*\b(created|modified|updated|changed|added)\b/,
      /\b(created|modified|updated|new)\b.*\b(recent(ly)?|last\s+\d+\s+days?|this\s+week)\b/,
      /\bwhat\s+(was|were)\b.*\b(created|modified|updated|changed)\b.*\b(recent|last)\b/,
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
    intent: 'reports-usage',
    plane: 'hybrid',
    tools: ['sfi.live_report_usage', 'sfi.list_components'],
    liveRequired: true,
    needsResolve: false,
    reason: 'Report inventory is in the vault; stale/unused needs live LastRunDate.',
    patterns: [
      /\breports?\b.*\b(useless|unused|stale|dead|old|never\s+run|not\s+used|broken)\b/,
      /\b(reports?|dashboards?)\b.*\b(cover|covers|about|for)\b/,
      /\b(useless|unused|stale|dead)\b.*\breports?\b/,
      /\b(dashboards?)\b.*\b(unused|stale|broken|refresh)\b/,
      /\breport\s+types?\b/,
      /\breports?\b.*\b(not\s+run|haven'?t\s+been\s+run)\b/,
      /\breports?\b.*\b(last\s+year|in\s+the\s+last)\b/,
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
      /\bwho\s+can\s+(access|see|view|open)\b.*\b(reports?|dashboards?|documents?)\b/,
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
      // Permission sets assigned to a named user (baseline-300 gap).
      /\bpermission\s+sets?\b.*\bassigned\b.*\buser\b/,
      /\bwhat\s+permission\s+sets?\b.*\bassigned\b/,
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
    intent: 'lifecycle-process',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.lifecycle_process'],
    liveRequired: false,
    needsResolve: true,
    reason:
      'What happens when {Object}.{field} becomes {value} — the automation coupled to a value/stage transition, from the vault (lifecycle_process).',
    patterns: [
      /\bwhat\s+happens\s+when\b.*\b(becomes?|turns?|changes?\s+to|is\s+set\s+to|reaches?)\b/,
      /\bwhat\s+happens\s+when\b.*\b(closed\s+won|closed\s+lost|converted|approved|activated)\b/,
    ],
  },
  {
    // REVERSE of why-cant-see (single user, forward): WHO (profiles/permsets/
    // roles/groups) can see/edit an object's RECORDS. Anchored to "records" so it
    // wins over field-access (fields, no "records") but never steals a field
    // question (P12-ROUTER-disambiguation: forward vs reverse).
    intent: 'who-can-access-object',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.who_can_access_object'],
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
    ],
  },
  {
    intent: 'why-cant-see',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.why_cant_user_see_record'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Walks the sharing cascade (OWD → permission → role hierarchy → sharing rules) from the vault.',
    patterns: [
      /\bwhy\s+(can'?t|cannot|can\s+not)\b.*\b(see|view|access)\b.*\brecord\b/,
      /\bcan'?t\s+(see|view|access)\b.*\b(record|account|case|opportunity)\b/,
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
    patterns: [
      /\bhow\s+many\b.*\blayouts?\b/,
      /\b(what|which|list)\b.*\b(page\s+)?layouts?\b.*\b(exist|are\s+there|for\s+the|on\s+the|does|available)\b/,
      /\bwhat\b.*\b(fields?|related\s+lists?|quick\s+actions?|sections?|buttons?)\b.*\bon\b.*\blayout\b/,
      /\b(related\s+lists?|quick\s+actions?)\b.*\b(on|appear|for)\b.*\blayout\b/,
      // "Is Account.Name in any page layouts?" — field-on-layout inventory (B21).
      /\b(in\s+any|on\s+any)\b.*\b(page\s+)?layouts?\b/,
      /\bis\b.*\bin\s+any\b.*\blayouts?\b/,
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
      /\bleast\s+privilege\b/,
      /\bsecurity\s+gaps?\b.*\b(profile|permission)/,
      /\bpermission\s+sets?\b.*\binstead\s+of\b.*\bprofiles?\b/,
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
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field'],
    liveRequired: false,
    needsResolve: true,
    reason: 'Whether a specific field is safe to delete — coverage-aware dependency check.',
    patterns: [
      /\bsafe(?:[\s_-]+to[\s_-]+delete|_to_delete_field)\b/,
      /\b(block|prevent)\w*\b[^.?!]{0,30}\bdeletion\b/,
      /\bbefore\s+deleting\b/,
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
      /\b(unassigned|unused|orphan)\b[^.?!]{0,40}\bpermission\s+sets?\b/,
      /\bpermission\s+sets?\b[^.?!]{0,40}\b(no\s+one|nobody|unassigned|unused)\b/,
      /\bunassigned_permission_sets\b/,
    ],
  },
  {
    intent: 'empty-queues-groups',
    plane: 'vault',
    tools: ['sfi.empty_queues_and_groups'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Queues / public groups with no members — vault membership scan.',
    patterns: [
      /\b(empty|unused)\b.*\b(queues?|groups?)\b/,
      /\b(queues?|public\s+groups?)\b.*\b(empty|no\s+members?|unused)\b/,
      /\b(which|what)\s+queues?\b.*\b(set\s+up|for|exist)\b/,
      /\bpublic\s+groups?\b.*\b(exist|who\s+is)\b/,
      /\bwhat\s+public\s+groups?\b/,
    ],
  },
  {
    intent: 'sharing-model',
    plane: 'vault',
    tools: ['sfi.generate_sharing_summary'],
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
    intent: 'profile-migration',
    plane: 'vault',
    tools: ['sfi.permission_risk_report', 'sfi.what_if_merge_profiles'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Profile→permission-set migration / merge-split planning from permission metadata.',
    patterns: [
      /\bprofiles?\b.*\b(to|into|vs)\b.*\bpermission\s+sets?\b/,
      /\b(merge|split|consolidate)\b.*\bprofiles?\b/,
      /\bprofile\s+migration\b/,
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
    patterns: [
      /\b(data\s+flow|lineage)\b/,
      /\bwhere\s+does\b.*\b(field|data|pii|it)\b.*\b(flow|go)\b/,
      /\bfield\b.*\bflows?\b/,
      /\b(upstream|downstream)\b/,
    ],
  },
  {
    intent: 'pii-inventory',
    plane: 'vault',
    tools: ['sfi.pii_inventory'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Classifies every field for PII/sensitive data from the vault.',
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
      /\bwhat\s+(happens|runs|fires)\b.*\b(on\s+save|when\b.*\b(created|saved|updated|inserted|deleted|undeleted|restored))\b/,
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
      // "What runs on Account insert?" — DML event without "on save" / "when" (B21).
      /\bwhat\s+runs\b.*\b(insert|update|delete|undelete)\b/,
      // "what happens when I SAVE an Evaluation" — present-tense "save"/"saves"/
      // "saving" (the verb list above only had past-tense "saved"). Question-
      // battery gap.
      /\bwhat\s+(happens|runs|fires)\b.*\bwhen\b.*\bsav(e|es|ing)\b/,
      // "When X is inserted, do TriggerA and TriggerB both fire?" — differential edge-03.
      /\bwhen\b.*\b(is\s+)?(inserted|updated|deleted|created)\b.*\b(trigger|fire)\b/,
      /\bdo\b[^.?!]{0,120}\b(trigger|triggers)\b[^.?!]{0,80}\bfire\b/,
      /\b(trigger|triggers)\b.*\b(both|and)\b.*\bfire\b/,
      /\b(same\s+transaction|rollup)\b.*\b(after[-\s]?insert|DLRS|dlrs)/i,
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
    tools: ['sfi.resolve', 'sfi.automation_build_advisor', 'sfi.get_edges'],
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
    tools: ['sfi.find_apex_usages', 'sfi.search_flow_metadata', 'sfi.resolve'],
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
      /\b(less\s+than|below|under)\b.*\b\d+\s*%\b.*\bcoverage\b/,
      /\b(coverage|percent)\b.*\b(less\s+than|below|under)\b/,
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
    tools: ['sfi.governor_limit_risks'],
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
      /\b(bulk|bulkif|unbounded)\b/,
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
    intent: 'release-readiness',
    plane: 'vault',
    tools: ['sfi.release_readiness_report', 'sfi.org_risk_report', 'sfi.tech_debt_score'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Release / go-live readiness is a vault synthesis (release_readiness_report + org risk + tech debt).',
    patterns: [
      /\brelease\s+readiness\b/,
      /\b(ready|readiness)\b.*\b(release|deploy|go[-\s]?live|cutover|production)\b/,
      /\bpre[-\s]?release\b.*\b(check|review|audit)\b/,
      /\bgo[-\s]?live\b.*\b(risk|readiness|checklist)\b/,
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
    // "Which classes implement <interface>" (Batchable, Schedulable, Queueable,
    // RestResource, ...) — grep Apex source for the implements clause. The
    // apex-search verbs (uses/references) didn't cover "implement" (B21.16/17,
    // E.4-6 / BL-13 interface filters).
    intent: 'interface-implementers',
    plane: 'vault',
    tools: ['sfi.search_apex_source', 'sfi.find_apex_usages'],
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
    tools: ['sfi.search_apex_source', 'sfi.find_apex_usages'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Text grep over Apex source + usage edges.',
    patterns: [
      /\bfind\b.*\b(class|apex|code)\b.*\b(mentions?|references?|uses?|calls?|reads?|writes?|with)\b/,
      /\b(which|what)\s+(classes?|apex)\b.*\b(mentions?|references?|uses?|touch(es)?|reads?|writes?|calls?|invokes?)\b/,
      /\bsearch\b.*\b(apex|code)\b/,
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
    intent: 'integration-map',
    plane: 'vault',
    tools: ['sfi.integration_map'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Topology of the org\'s integration surfaces (named creds, connected apps, remote sites, external services).',
    patterns: [
      /\b(integrations?|named\s+credentials?|connected\s+apps?|remote\s+sites?|external\s+services?|auth\s+providers?)\b/,
      /\bwhat\b.*\bintegrat/,
      /\bapi\b.*\b(connections?|surfaces?)\b/,
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
    tools: ['sfi.event_subscribers'],
    liveRequired: false,
    needsResolve: false,
    reason:
      'Lists every Platform Event the org publishes with its subscriber count (event_subscribers catalog mode — call with no eventId).',
    patterns: [
      /\bwhat\s+(platform\s+events?|cdc\s+channels?)\b/,
      /\b(platform\s+events?)\b.*\b(publish|emit|defined|exist|list|are\s+there)\b/,
      /\bplatform\s+events?\b(?:\s+in\s+(?:this\s+)?(?:the\s+)?org)?\b/,
    ],
  },
  {
    // Inbound Apex REST (@RestResource) — "what REST endpoints are exposed".
    // MUST precede the outbound `endpoints` rule, which would otherwise grab
    // "endpoints" and misroute to the outbound catalog (B21.15).
    intent: 'rest-endpoints',
    plane: 'vault',
    tools: ['sfi.search_apex_source', 'sfi.find_apex_usages'],
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
    intent: 'unused-fields',
    plane: 'hybrid',
    tools: ['sfi.unused_fields_deep', 'sfi.field_cleanup_candidates', 'sfi.live_field_population'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Dead-vs-alive: vault references say "unreferenced"; live population confirms truly unused.',
    patterns: [
      /\b(unused|dead|orphan|cleanup|clean\s+up)\b.*\bfields?\b/,
      /\bfields?\b.*\b(unused|dead|not\s+used|never\s+used|cleanup)\b/,
      /\bhow\s+many\b.*\bfields?\b.*\b(used|populated|actually)\b/,
      /\bexcessive\b.*\b(custom\s+)?fields?\b/,
      /\b(same\s+information|duplicate\s+information)\b.*\b(fields?|objects?)\b/,
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
    ],
  },
  {
    intent: 'safe-to-delete',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.safe_to_delete_field'],
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
      /\b(chang|updat|edit|modif|bulk[-\s]?updat)\w*\b[^.?!]{0,40}\bvalues?\b/,
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
    intent: 'impact-analysis',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.field_change_advisor'],
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
    ],
  },
  {
    intent: 'what-if-field',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.what_if_make_field_required', 'sfi.what_if_change_field_type', 'sfi.what_if_remove_picklist_value'],
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
      /\bremove\b.*\bpicklist\s+value\b/,
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
    intent: 'cross-org-diff',
    plane: 'vault',
    tools: ['sfi.compare_vaults', 'sfi.compare_object_across_vaults', 'sfi.compare_profile_across_vaults'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Differences between two registered orgs (UAT vs prod) from the vault registry.',
    patterns: [
      /\b(uat|sandbox|staging)\b.*\b(vs|versus|compared?\s+to|and)\b.*\b(prod|production)\b/,
      /\bwhat('?s| is)\s+different\b.*\b(between|across)\b.*\borgs?\b/,
      /\bcompare\b.*\borgs?\b/,
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
    tools: ['sfi.what_changed_since_refresh', 'sfi.churn'],
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
    intent: 'snapshot-diff',
    plane: 'vault',
    tools: ['sfi.diff_snapshots', 'sfi.churn', 'sfi.trend'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Structural diff / churn / trend between captured snapshots.',
    patterns: [
      /\b(churn|trend|snapshot)\b/,
      /\bhow\s+much\b.*\b(changed|growth)\b.*\bover\s+time\b/,
    ],
  },

  // === CPQ / OmniStudio (vault) =============================================
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
    intent: 'field-mapping',
    plane: 'vault',
    tools: ['sfi.field_mapping_between_objects', 'sfi.datatransform_field_map'],
    liveRequired: false,
    needsResolve: false,
    reason: 'How fields map between two objects (lead conversion, data transforms).',
    patterns: [
      /\bfield\s+mapping\b/,
      /\bhow\s+(do|does)\b.*\bfields?\b.*\bmap\b/,
      /\bmap(ping|ped)?\b.*\b(between|from)\b.*\b(object|to)\b/,
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
      // "what does Status__c mean on Evaluation" — the field is NAMED (e.g. an
      // __c api name) rather than the literal word "field". Battery gap.
      /\bwhat\s+(does|is)\b.*\w+__c\b.*\b(mean|for)\b/,
      // "what is the help text for the Discount_Percent__c field" — the
      // inline help bubble IS explain_field's surface; a top baseline-300
      // unrouted cluster (P14-ROUTER-goldset-expand).
      /\b(help\s+text|inline\s+help)\b/,
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
    intent: 'approval-process',
    plane: 'vault',
    tools: ['sfi.resolve', 'sfi.list_components', 'sfi.get_component'],
    liveRequired: false,
    needsResolve: false,
    reason: 'Approval processes and their steps are modeled in the vault (ApprovalProcess).',
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
      return undefined;
    },
    patterns: [
      /\bwhat\s+(objects?|fields?|custom\s+objects?|record\s+types?|picklists?|validation\s+rules?)\b/,
      /\bwhat\s+standard\s+fields?\b/,
      /\bwhat\s+metadata\s+exists\b/,
      /\b(fields?|structure|schema)\s+(of|on|does|for)\b/,
      /\bwhat\s+(type|kind)\s+is\b/,
      /\blist\s+(all\s+)?(objects?|fields?|components?|flows?|classes?|profiles?|permission\s+sets?|layouts?)\b/,
      // "show me the objects in this org" / "show Evaluation fields" / "list the
      // flows" — "show"/"list" with the metadata noun anywhere after (the bare
      // "list X" / "what X" patterns missed these). Battery gaps.
      /\b(show|list)\b.*\b(objects?|fields?|flows?|classes?|triggers?|record\s+types?|profiles?|permission\s+sets?|layouts?|validation\s+rules?|queues?|groups?|labels?)\b/,
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
    const primary = routeFromRule(question, q, first);
    // Ordered regex rules intentionally overlap: a later match often adds
    // recall, not a genuinely competing user goal. Only explicit semantic
    // ambiguity policies may stop execution; raw overlap remains diagnostic
    // implementation detail and must not interrupt a correctly routed user.
    const alternatives = [...semanticAlternatives(q, primary.intent)]
      .filter((alternative, i, all) =>
        alternative.intent !== primary.intent &&
        all.findIndex((candidate) => candidate.intent === alternative.intent) === i
      )
      .slice(0, 3);
    const clarification =
      alternatives.length > 0
        ? {
            required: true,
            question: `Which result do you want first: ${intentLabel(primary.intent)}, or ${alternatives.map((a) => intentLabel(a.intent)).join(', ')}?`,
            options: [primary.intent, ...alternatives.map((a) => a.intent)],
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
      confidence: alternatives.length === 0 ? 'high' : 'low',
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
