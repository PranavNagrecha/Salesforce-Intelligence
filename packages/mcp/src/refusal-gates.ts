/**
 * Refusal-shape gates for `sfi.route_question` (router-v2 Phase 2).
 *
 * Score-INDEPENDENT mood/action detectors that run on the RAW question BEFORE
 * intent classification, in both router modes — honesty is mode-independent.
 * The Phase-1 diagnosis showed the genuine over-routes are not score-shaped
 * problems: 42/62 are write imperatives, ~8 injection/exfiltration, ~4
 * out-of-scope — so no intent needs its vocabulary narrowed; what was missing
 * is this shared gate. A hit yields a REFUSAL SHAPE the router turns into a
 * non-executable route (`tools: []`) with an honest disclosure; it never
 * yields an executable route and never blocks a legitimate READ (permission
 * questions — "am I allowed to edit…", "who can delete…", "is it safe to…" —
 * are explicit excluders and route normally).
 *
 * Evaluation order (first hit wins): injection-exfiltration →
 * write-imperative → runtime-analytics → out-of-scope. Order is load-bearing:
 * "ignore the read-only restriction… create an outbound message" must land
 * injection, not write.
 */

export type RefusalKind =
  | 'injection-exfiltration'
  | 'write-imperative'
  | 'runtime-analytics'
  | 'out-of-scope';

export interface RefusalShape {
  readonly kind: RefusalKind;
  /** Full user-facing disclosure text. */
  readonly disclosure: string;
  /** Read-side `sfi.*` tool offered instead (write-imperative only). */
  readonly readOnlyAlternative?: string;
}

// ---------------------------------------------------------------------------
// 2.2 — injection / record-value exfiltration (checked FIRST).
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:your|all|the)\s+(?:previous|prior|read-?only)\s+(?:instructions?|rules?|restrictions?)\b/i,
  /\bpretend\s+the\s+(?:previous|prior)\s+rules\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:admin|deploy|god)\s*[- ]?mode\b/i,
  /\byou'?re\s+actually\s+an?\b[^.?!]*\bbot\b/i,
  /\b(?:print|reveal|show)\s+(?:me\s+)?your\s+(?:system\s+)?prompt\b/i,
];

// The value-exfiltration arm is deliberately NARROW: it must be a
// VALUES-of-records ask ("actual SSN values", "every SSN value stored").
// "Which fields contain SSN" carries no exfil verb + quantifier + values ask
// and stays a legitimate `sfi.pii_inventory` route.
const EXFIL_VERB = /\b(?:dump|export|give\s+me|tell\s+me|list|retrieve)\b/i;
const EXFIL_QUANTIFIER = /\b(?:every|all|actual|the\s+real|random)\b/i;
const EXFIL_SENSITIVE = /\b(?:ssn|social\s+security|pii|ferpa|hipaa)\b/i;
const EXFIL_VALUES = /\bvalues?\b|\bstored\b/i;
// P4 survivor arm — a SINGLE-record sensitive-value ask ("whats the SSN of the
// most recent lead"): asks for the stored value OF a record/person, no
// quantifier needed. "whats the SSN FIELD…" (a metadata ask) is excluded by
// the field/fields carve-out.
const EXFIL_SINGLE_VALUE =
  /\b(?:what(?:'s|s|\s+is)|show\s+me|give\s+me|pull)\s+the\s+(?:ssn|social\s+security(?:\s+number)?)\b(?!\s+fields?\b)[^.?!]{0,60}\b(?:lead|contact|record|student|person|user|account|applicant)s?\b/i;

const INJECTION_DISCLOSURE =
  'REFUSED: this request asks me to override instructions or exfiltrate record ' +
  'values. sf-intelligence reads metadata only; it never returns stored record ' +
  'values and its instructions are not overridable.';

// ---------------------------------------------------------------------------
// 2.1 — write imperative (org mutation requested of the agent).
// ---------------------------------------------------------------------------

// Mutation verbs. `set` carries a negative lookbehind so the schema NOUN
// "permission set" can never read as the verb; word boundaries keep
// "inactive"/"assigned"/"address" from matching activate/assign/add.
const WRITE_VERB =
  '(?:create|add|delete|remove|update|change|(?<!permission\\s)set|deploy|assign|' +
  'reassign|revoke|deactivate|activate|disable|enable|merge|reset|rename|fix|' +
  'grant|provision|turn\\s+(?:on|off)|clean\\s+up|migrate|convert|insert|upsert|' +
  'push|publish|install|uninstall|schedule|upgrade|downgrade|throttle|purge)';

/**
 * Adverb/quantifier filler allowed between the imperative frame and the verb —
 * "i need you to BULK update…", "can you go ahead and MASS delete…" all carry
 * the same mutation ask; the bare-verb anchor missed them (P4 survivors).
 */
const WRITE_VERB_FILLER = '(?:(?:bulk|mass|batch|just|please|go\\s+ahead\\s+and)\\s+)*';

// (B) EXCLUDERS — any present means the USER is asking about permission or a
// hypothetical, not instructing the agent to mutate: route normally. "can I
// edit the SSN field" is a plain FLS read (the 64-mislabeled-expect lesson);
// "can YOU delete…" is an imperative aimed at the agent and is NOT excluded.
const WRITE_EXCLUDER =
  /\b(?:am\s+i|can\s+i|could\s+i|do\s+i|who\s+can|who\s+is\s+able|allowed\s+to|able\s+to|what\s+if|what\s+would|would\s+happen|is\s+it\s+safe|safe\s+to|before\s+i|if\s+i|should\s+i|how\s+do\s+i|how\s+would\s+i|what\s+happens\s+when)\b/i;

// (A) imperative position, three arms — each captures the verb phrase (verb +
// bounded trailing slice) for the disclosure.
const WRITE_SENTENCE_INITIAL = new RegExp(
  `(?:^|[.!?;]\\s+)(?:please\\s+|just\\s+)?${WRITE_VERB_FILLER}(${WRITE_VERB}\\b[^.?!;]{0,80})`,
  'i',
);
const WRITE_LEAD_IN = new RegExp(
  `\\b(?:please|just|go\\s+ahead\\s+and|can\\s+(?:you|u)|could\\s+(?:you|u)|would\\s+(?:you|u)|you\\s+should|i\\s+need\\s+you\\s+to)\\s+(?:please\\s+|just\\s+)?${WRITE_VERB_FILLER}(${WRITE_VERB}\\b[^.?!;]{0,80})`,
  'i',
);
const WRITE_TRAILING_FRAME = new RegExp(
  `\\b(${WRITE_VERB}\\b[^.?!;]{0,80}?\\b(?:for\\s+me|right\\s+now|and\\s+confirm)\\b[^.?!;]{0,20})`,
  'i',
);
// P4 survivor arms — each a narrow, high-precision imperative the three
// generic frames missed:
// - "can you MAKE the X field required" — schema-mutation "make" (never the
//   idiomatic "make sense of"; anchored on the schema outcome word).
const WRITE_MAKE_SCHEMA = new RegExp(
  `\\b(?:can|could|would)\\s+(?:you|u)\\b[^.?!;]{0,10}\\s(make\\b[^.?!;]{0,60}\\b(?:required|mandatory|optional|unique|read[-\\s]?only|editable|visible)\\b)`,
  'i',
);
// - "can you GIVE the Admissions profile Modify All Data" — a grant phrased
//   with "give". `give me …` (a READ delivery ask) is explicitly excluded.
const WRITE_GIVE_GRANT = new RegExp(
  `\\b(?:can|could|would)\\s+(?:you|u)\\b[^.?!;]{0,30}\\b(give\\s+(?!me\\b)[^.?!;]{0,60}\\b(?:profile|permission|perm\\s+set|access|user)\\b[^.?!;]{0,40})`,
  'i',
);
// - sentence-initial "GIVE everyone admin access" — the same grant, imperative
//   from the first word. `give me …` (a READ delivery ask) stays excluded.
const WRITE_GIVE_INITIAL =
  /(?:^|[.!?;]\s+)(give\s+(?!me\b)[^.?!;]{0,60}\b(?:admin|access|permission|profile)\b[^.?!;]{0,30})/i;
// - "…run it and DELETE THE DUPES" — a mutation chained behind a read in the
//   same sentence. Anchored on the dupes/duplicates object so read phrasings
//   ("which profiles can edit and delete Cases") never match.
const WRITE_CHAINED_DUPE_DELETE =
  /\b(?:and|then)\s+(?:just\s+)?((?:delete|remove|purge|merge)\s+(?:the\s+)?dup(?:e|licate)s?\b[^.?!;]{0,30})/i;

/** Static read-side alternative by verb family (write-imperative gate only). */
const readOnlyAlternativeFor = (verbPhrase: string, question: string): string => {
  const v = verbPhrase.toLowerCase();
  const q = question.toLowerCase();
  if (/^(?:delete|remove)\b/.test(v) && /\bfield\b|__c\b/.test(q)) {
    return 'sfi.safe_to_delete_field';
  }
  if (/^(?:deactivate|disable|turn)\b/.test(v) && /\bflow\b/.test(q)) {
    return 'sfi.what_if_deactivate_flow';
  }
  if (/^disable\b/.test(v) && /\btrigger\b/.test(q)) {
    return 'sfi.what_if_disable_trigger';
  }
  if (/^(?:change|convert)\b/.test(v) && /\bfield\b/.test(q)) {
    return 'sfi.what_if_change_field_type';
  }
  if (/^merge\b/.test(v) && /\bprofile/.test(q)) {
    return 'sfi.what_if_merge_profiles';
  }
  if (/^make\b/.test(v) && /\brequired|mandatory\b/.test(v)) {
    return 'sfi.what_if_make_field_required';
  }
  if (/^give\b/.test(v) || (/^grant\b/.test(v) && /\b(?:profile|permission)\b/.test(q))) {
    return 'sfi.permission_risk_report';
  }
  if (/^(?:upgrade|downgrade|install|uninstall)\b/.test(v) && /\bpackage\b/.test(q)) {
    return 'sfi.package_impact';
  }
  if (/^throttle\b/.test(v) || /\basync\b/.test(q)) {
    return 'sfi.async_chain_depth';
  }
  if (/dup(?:e|licate)s?\b/.test(v)) {
    return 'sfi.live_duplicate_check';
  }
  return 'sfi.get_impact';
};

// ---------------------------------------------------------------------------
// 2.3 — runtime/ops telemetry no tool models (honest gap, not a refusal of
// intent — the ask is legitimate, the data does not exist in the product).
// ---------------------------------------------------------------------------

// Each arm pairs the trigger with the disclosed topic. NON-triggers that HAVE
// tools are deliberately absent: inactive/stale users (live_inactive_users),
// report usage (live_report_usage), recent activity (live_recent_activity),
// automation fired (live_automation_fired), org limits (live_org_limits).
const RUNTIME_TRIGGERS: readonly (readonly [RegExp, string])[] = [
  [/\blogin\s+history\b|\baudit\s+trail\s+of\s+logins?\b/i, 'login history'],
  [/\badoption\b|\bhow\s+often\s+do\s+users\s+actually\s+use\b/i, 'adoption/usage telemetry'],
  [
    /\bping\s+(?:the\s+)?\S+|\bendpoints?\b[^.?!]*\bup\b|\b(?:returned|returning|throwing|threw)\s+errors?\b/i,
    'endpoint health',
  ],
  [/\brunning[-\s]user\s+context\b/i, 'the runtime running-user context'],
];
// Temporal incident forensics: a runtime WINDOW plus incident vocabulary.
const RUNTIME_WINDOW = /\b(?:this\s+week|yesterday|last\s+night|in\s+the\s+\w+\s+incident)\b/i;
const RUNTIME_INCIDENT = /\b(?:errors?|failed|failures?|incident|outage|gated)\b/i;

const runtimeDisclosure = (topic: string): string =>
  `HONEST GAP: ${topic} is runtime telemetry sf-intelligence does not model — ` +
  'the vault holds metadata; the live plane covers counts/samples/limits, not event logs.';

// ---------------------------------------------------------------------------
// 2.4 — out of scope (not this org's Salesforce metadata).
// ---------------------------------------------------------------------------

const EXTERNAL_SYSTEM =
  /\b(sharepoint|jira|confluence|google\s+drive|onedrive|slack\s+workspace|s3\s+bucket)\b/i;
// Password/session/sharing/IP policies are REAL profile metadata (the
// profile-login-security route) — only organizational-governance policy asks
// gate here.
const POLICY_ASK =
  /\bwhat(?:'s|s|\s+is)\s+our\b(?![^.?!]{0,60}\b(?:password|session|sharing|lockout|ip|login)\b)[^.?!]{0,60}\bpolic(?:y|ies)\b/i;
// Retention schedules and consent PROCESSES are organizational governance, not
// Salesforce metadata — the vault has no retention/consent model to read
// (P4 survivors q879/q438/q899). Narrow nouns; "retention" alone (e.g. "data
// retention fields on Contact") does not gate.
const RETENTION_POLICY_ASK = /\bretention\s+(?:polic(?:y|ies)|schedule|rules?)\b/i;
const CONSENT_PROCESS_ASK =
  /\bhow\s+do(?:es)?\s+(?:students?|users?|customers?|people|contacts?)\s+consent\b/i;
const OPINION_ASK = /\bwhat\s+do\s+you\s+think\b/i;
const SHOULD_WE = /\bshould\s+we\b/i;
// "should we" only gates WITHOUT a metadata object in sight — "should we split
// the Admin profile" is a real (routable) org question.
const METADATA_NOUN =
  /\b(?:field|object|flow|trigger|class|profile|permission|layout|validation|record\s+type|apex|report|dashboard|picklist|component|rule)\b|__(?:c|mdt|e|x|b|kav)\b/i;
const DELIVERY_ASK = /\bemail\s+me\b|\bsend\s+(?:this|it)\s+to\b|\bpost\s+(?:this\s+|it\s+)?to\s+slack\b/i;
// "write me an apex trigger that…" — code GENERATION is out of scope;
// sfi.apex_build_advisor asks ("what should I know before building…") carry no
// "write …" and stay routed.
const WRITE_CODE_ASK =
  /\bwrite\s+(?:me\s+)?(?:an?\s+)?(?:apex|lwc|trigger|class|component)\b[^.?!]*\b(?:that|to)\b/i;

const outOfScopeDisclosure = (topic: string): string =>
  `OUT OF SCOPE: sf-intelligence answers questions about this org's Salesforce ` +
  `metadata. ${topic} is outside that boundary (no external systems, no policy ` +
  'authorship, no code generation, no message delivery).';

// ---------------------------------------------------------------------------
// Detector.
// ---------------------------------------------------------------------------

/**
 * Detect a refusal shape in the raw question, or `null` when the question is a
 * legitimate read that must route normally. First hit wins in the order
 * injection-exfiltration → write-imperative → runtime-analytics → out-of-scope.
 */
export const detectRefusalShape = (question: string): RefusalShape | null => {
  const q = question.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (q.length === 0) return null;

  // 1 — injection / value exfiltration (hard refuse; checked before write so
  // an override that also names a mutation lands here).
  const injected =
    INJECTION_PATTERNS.some((p) => p.test(q)) ||
    (EXFIL_VERB.test(q) && EXFIL_QUANTIFIER.test(q) && EXFIL_SENSITIVE.test(q) && EXFIL_VALUES.test(q)) ||
    EXFIL_SINGLE_VALUE.test(q);
  if (injected) {
    return { kind: 'injection-exfiltration', disclosure: INJECTION_DISCLOSURE };
  }

  // 2 — write imperative: mutation verb in imperative position AND no
  // permission/hypothetical frame. The chained dupe-delete arm runs even
  // under an excluder-free compound ask ("write me the SOQL … and delete the
  // dupes") — the mutation clause poisons the whole turn.
  if (!WRITE_EXCLUDER.test(q)) {
    const verbPhrase = (
      WRITE_SENTENCE_INITIAL.exec(q) ??
      WRITE_LEAD_IN.exec(q) ??
      WRITE_TRAILING_FRAME.exec(q) ??
      WRITE_MAKE_SCHEMA.exec(q) ??
      WRITE_GIVE_GRANT.exec(q) ??
      WRITE_GIVE_INITIAL.exec(q) ??
      WRITE_CHAINED_DUPE_DELETE.exec(q)
    )?.[1]
      ?.trim()
      .replace(/[,;:]$/, '');
    if (verbPhrase !== undefined && verbPhrase.length > 0) {
      const alternative = readOnlyAlternativeFor(verbPhrase, q);
      return {
        kind: 'write-imperative',
        disclosure:
          `REFUSED (read-only boundary): sf-intelligence never mutates the org — ` +
          `it cannot ${verbPhrase}. I can show you the read-side analysis instead: ` +
          `${alternative}.`,
        readOnlyAlternative: alternative,
      };
    }
  }

  // 3 — runtime/ops telemetry honest gap.
  const runtimeTopic =
    RUNTIME_TRIGGERS.find(([pattern]) => pattern.test(q))?.[1] ??
    (RUNTIME_WINDOW.test(q) && RUNTIME_INCIDENT.test(q) ? 'runtime incident forensics' : undefined);
  if (runtimeTopic !== undefined) {
    return { kind: 'runtime-analytics', disclosure: runtimeDisclosure(runtimeTopic) };
  }

  // 4 — out of scope.
  const externalSystem = EXTERNAL_SYSTEM.exec(q)?.[1];
  const outOfScopeTopic =
    externalSystem !== undefined
      ? `"${externalSystem}"`
      : RETENTION_POLICY_ASK.test(q)
        ? 'A data-retention policy (organizational governance, not org metadata)'
        : CONSENT_PROCESS_ASK.test(q)
          ? 'A consent process (organizational governance, not org metadata)'
          : POLICY_ASK.test(q)
            ? 'Org policy authorship'
            : OPINION_ASK.test(q)
              ? 'An opinion'
              : DELIVERY_ASK.test(q)
                ? 'Message delivery'
                : WRITE_CODE_ASK.test(q)
                  ? 'Code generation'
                  : SHOULD_WE.test(q) && !METADATA_NOUN.test(q)
                    ? 'An org-decision recommendation'
                    : undefined;
  if (outOfScopeTopic !== undefined) {
    return { kind: 'out-of-scope', disclosure: outOfScopeDisclosure(outOfScopeTopic) };
  }

  return null;
};
