/**
 * Conversation-context resolution for `sfi.route_question` (router-v2 P5).
 *
 * The product is STATELESS: conversation memory belongs to the HOST. The host
 * may pass a `context.previous` block per call describing what the PRIOR turn
 * was about (component id, tool, object, an open clarification); nothing is
 * ever stored server-side. This module is DETECTION + DECISION only — pure
 * functions with no I/O — and all wiring lives in `route-question.ts`, inside
 * `if (input.context !== undefined)` guards, so the no-context path stays
 * byte-identical to a build without this module.
 *
 * Value validation here is FAIL-OPEN (never a hard error for stale/bad context
 * — hosts replay old state): an unregistered `previous.tool` or a malformed
 * `previous.componentId` is dropped with a note for `contextApplied.ignored`.
 * Zod SHAPE errors still error normally in the input schema.
 */

/**
 * PRONOUN anchors (word-boundary, case-insensitive): the follow-up refers back
 * to the prior turn's subject with a pronoun/ellipsis token. Multi-word
 * anchors are listed first so the matched text names the most specific one.
 * The design's bare-verb ellipsis openers ("does it", "is it", "can it",
 * "do they", "are they", "would it") are subsumed by the `it`/`they` tokens —
 * and only matter on an otherwise entity-free question, which the callers
 * enforce (entity extraction must have found nothing, or an anaphor only).
 */
const PRONOUN_ANCHORS: readonly RegExp[] = [
  /\bthat\s+one\b/i,
  /\bthis\s+one\b/i,
  /\bthe\s+same\b/i,
  /\bthe\s+other(?:\s+one)?\b/i,
  /\beach\s+of\s+them\b/i,
  /\bany\s+of\s+them\b/i,
  /\beither(?:\s+one)?\b/i,
  /\bboth\b/i,
  /\bit\b/i,
  /\bits\b/i,
  /\bthey\b/i,
  /\bthem\b/i,
  /\bthose\b/i,
  /\bthese\b/i,
];

/**
 * REPARAM anchors: the follow-up re-asks the PREVIOUS question against a NEW
 * target ("what about on Contact?", "same question for Case"). Ordinals and
 * descriptors ("the second one", "the ADA one") are listed here too — they are
 * clarification-selection shapes first (see detectClarificationSelection), and
 * degrade to re-parameterization anchors when no clarification is open.
 */
const REPARAM_ANCHORS: readonly RegExp[] = [
  /\bwhat\s+about\b/i,
  /\bhow\s+about\b/i,
  /\band\s+(?:on|for|the)\b/i,
  /\bsame\s+(?:for|on|thing|question)\b/i,
  /\bwhat\s+does\s+.*\s+look\s+like\s+on\b/i,
  /\bthe\s+(?:first|second|third|last)\s+one\b/i,
  /\bthe\s+[A-Za-z0-9_]+\s+one\b/i,
];

/** First matched PRONOUN anchor text, or null when the question has none. */
export const detectPronounAnchor = (question: string): string | null => {
  for (const anchor of PRONOUN_ANCHORS) {
    const match = question.match(anchor);
    if (match !== null) return match[0];
  }
  return null;
};

/** First matched REPARAM anchor text, or null when the question has none. */
export const detectReparamAnchor = (question: string): string | null => {
  for (const anchor of REPARAM_ANCHORS) {
    const match = question.match(anchor);
    if (match !== null) return match[0];
  }
  return null;
};

/**
 * Anaphor-only phrases the entity extractor can scrape from a terse follow-up.
 * When the extraction IS one of these, the question named nothing real and
 * context substitution may fill the gap; a real extracted phrase always wins
 * over context (the self-contained negative).
 */
const ANAPHOR_ONLY = new Set([
  'it', 'its', 'they', 'them', 'those', 'these', 'both', 'either',
  'that one', 'this one', 'the same', 'the other', 'the other one',
  'same', 'other', 'either one',
]);

/** True when the extracted entity phrase is itself an anaphor token. */
export const isAnaphorOnly = (phrase: string): boolean =>
  ANAPHOR_ONLY.has(phrase.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Clarification continuation (§2d) — ordinal / descriptor selection.
// ---------------------------------------------------------------------------

export type ClarificationSelection =
  | { readonly kind: 'selected'; readonly anaphor: string; readonly selection: string }
  /** 0 or ≥2 descriptor matches, or an out-of-range ordinal: re-ask, NEVER guess. */
  | { readonly kind: 're-ask'; readonly anaphor: string };

const ORDINAL_INDEX: Readonly<Record<string, number>> = {
  first: 0,
  second: 1,
  third: 2,
};

/**
 * The WHOLE question must be an ordinal/descriptor reference ("the second
 * one", "the Contact one") — optionally with a short lead-in ("go with the
 * second one"). A full question that merely CONTAINS the phrase is not a
 * selection; it routes normally.
 */
const SELECTION_SHAPE =
  /^\s*(?:(?:show\s+me|pick|use|go\s+with|i\s+meant|let'?s\s+go\s+with|the\s+answer\s+is)\s+)?the\s+([A-Za-z0-9_]+)\s+one\s*[?.!]*\s*$/i;

/** Tokens that read as pronouns, not descriptors, in "the <Token> one". */
const NON_DESCRIPTOR_TOKENS = new Set(['other', 'same', 'right', 'wrong']);

/**
 * Map an ordinal/descriptor question onto an open clarification's options.
 * Ordinal → `options[i]` (out of range → re-ask). Descriptor "the <Token>
 * one" → the UNIQUE option containing Token case-insensitively; 0 or ≥2
 * matches → re-ask, never guess. Returns null when the question is not a
 * selection shape at all.
 */
export const detectClarificationSelection = (
  question: string,
  options: readonly string[],
): ClarificationSelection | null => {
  const match = question.match(SELECTION_SHAPE);
  if (match === null) return null;
  const token = match[1]!.toLowerCase();
  if (NON_DESCRIPTOR_TOKENS.has(token)) return null;
  const anaphor = `the ${match[1]!} one`;
  if (token === 'last') {
    const selection = options.at(-1);
    return selection === undefined
      ? { kind: 're-ask', anaphor }
      : { kind: 'selected', anaphor, selection };
  }
  const ordinal = ORDINAL_INDEX[token];
  if (ordinal !== undefined) {
    const selection = options[ordinal];
    return selection === undefined
      ? { kind: 're-ask', anaphor }
      : { kind: 'selected', anaphor, selection };
  }
  const containing = options.filter((option) =>
    option.toLowerCase().includes(token),
  );
  return containing.length === 1
    ? { kind: 'selected', anaphor, selection: containing[0]! }
    : { kind: 're-ask', anaphor };
};

// ---------------------------------------------------------------------------
// Gap-shaped follow-up detection (round-2 honesty seam 2).
//
// The 2K context-threaded run showed honest-gap follow-up PASS dropping
// 142 → 111: a follow-up that is ITSELF gap-shaped ("should they be able
// to?", "who's actually accessed those fields?", "can I get it as a file?")
// was continuation-routed to the carried tool instead of disclosing the gap.
// Mirroring how refusal gates already precede context logic, gap detection
// runs BEFORE context continuation: a hit below means the follow-up must NOT
// inherit the previous turn's tool — the wiring in route-question.ts turns it
// into a non-executable honest-gap route.
//
// PRECISION (zero false refusals): every shape here is a judgment / delivery /
// telemetry / self-capability ask no tool answers. Follow-ups that HAVE a
// continuation answer never match: "is it safe to delete?", "what about on
// Contact?", "who can run it?", "show me its dependencies", "does it touch
// the Marketo sync?" all continuation-route as before. These shapes are also
// deliberately NOT global refusal gates — as primaries some of them carry
// enough of their own vocabulary to route deterministically, and this
// detector only ever runs where a continuation would otherwise fire.
// ---------------------------------------------------------------------------

/**
 * Runtime-analytics follow-up terms (R4 seam-strengthening, DIAGNOSIS-R4 §S4).
 * A follow-up asking for RUNTIME org data the vault never modeled — login
 * history/IPs, API call logs, approval-instance history ("who actually
 * approved"), record field-history ("every value change on that record"),
 * report-subscription recipients, chatter/feed posts, sandbox-refresh date,
 * deployment logs, flow-interview history — must NOT inherit the previous
 * turn's metadata tool.
 *
 * CAPABILITY-MAP RULE (critical): roster / membership / zombie vocabulary
 * (permset holders, queue/group members, dormant-with-access accounts) is NOW
 * an answerable live capability (sfi.live_permset_holders / live_group_members
 * / live_zombie_accounts / live_user_permsets) and MUST route, not gap — so it
 * is deliberately EXCLUDED here. Only the genuinely-unbuilt runtime families
 * (per-user login history, execution traces, debug logs, field history, PSG
 * 2-hop custom-perm chains, historical membership) are caught.
 */
const RUNTIME_FOLLOW_UP_SHAPES: readonly RegExp[] = [
  // login history + IPs (per-user session telemetry, never modeled).
  /\b(?:login|log[-\s]?in|sign[-\s]?in)\s+history\b|\bwho\s+(?:actually\s+)?logged\s+in\b|\bfrom\s+what\s+ip\b|\bip\s+address(?:es)?\b/i,
  // API call logs / latency / error rate (runtime, not metadata).
  /\bapi\s+call\s+(?:logs?|counts?|volume)\b|\b(?:error|failure)\s+rate\b|\bhow\s+(?:many\s+times|often)\s+(?:was\s+it|has\s+it\s+been)\s+called\b|\bcall\s+volume\b/i,
  // approval-instance history — "who actually approved" (a runtime instance,
  // not the approval-process metadata). "who CAN approve" stays a config read.
  /\bwho\s+(?:actually\s+)?approved\b|\bapproval\s+history\b|\bwas\s+(?:it|that|this)\s+approved\b/i,
  // record field-history — every value change ON A RECORD (runtime audit
  // trail). "why did the FIELD change" (metadata provenance) is NOT this: the
  // anchor is a record/instance ("on that record", "for that account").
  /\b(?:every|all\s+the|each)\s+(?:value\s+)?changes?\s+(?:on|to|for)\s+(?:that|this|the)\s+(?:record|row|account|contact|case|lead|opportunity)\b|\bfield\s+history\s+(?:on|for)\b/i,
  // report/dashboard subscription recipients (runtime subscriptions).
  /\bwho\s+(?:is\s+)?subscribed\b|\bsubscription\s+recipients?\b|\bwho\s+gets?\s+(?:the|that)\s+(?:report|dashboard)\s+(?:emailed|sent)\b/i,
  // chatter / feed posts (runtime social data).
  /\bchatter\s+(?:posts?|activity|feed)\b|\bfeed\s+(?:posts?|items?|comments?)\b/i,
  // sandbox refresh date / deployment logs (runtime org lifecycle telemetry).
  /\bsandbox\s+(?:last\s+)?refresh(?:ed)?\b|\bwhen\s+was\s+(?:the\s+)?sandbox\b|\bdeployment\s+(?:logs?|history)\b|\blast\s+deploy(?:ment|ed)\b/i,
  // flow-interview history / event publish counts (runtime execution traces).
  /\bflow\s+interview(?:s|\s+history)?\b|\b(?:how\s+many\s+)?(?:events?\s+)?(?:were\s+)?published\b|\bpublish\s+counts?\b/i,
];

/** Gap family → follow-up shapes (all matched on the raw follow-up text). */
const GAP_FOLLOW_UP_SHAPES: readonly (readonly [RegExp, string])[] = [
  // Normative/judgment asks — the product reads metadata, it has no opinion
  // (q891/q30 "should they be able to?", q95 "is it normal?", q1075 "was any
  // of it risky?", q1054 "are those considered sensitive?", q1065 "how hard
  // is it to close?", q1060 "does that mean something's broken?", q1012 "is
  // it doing its job?").
  [/\bshould\s+(?:they|he|she|it)\s+(?:be\s+able|have|see)\b/i, 'judgment'],
  [/\bis\s+(?:it|that|this)\s+normal\b|\bseems?\s+like\s+a\s+lot\b/i, 'judgment'],
  [/\bwas\s+(?:any\s+of\s+)?(?:it|that|this)\s+risky\b/i, 'judgment'],
  [/\bare\s+(?:those|these|they)\s+considered\s+\w+/i, 'judgment'],
  [/\bhow\s+hard\s+(?:is|would)\s+it\b/i, 'judgment'],
  [/\bdoes\s+that\s+mean\s+something(?:'s|\s+is)\s+broken\b/i, 'judgment'],
  [/\bis\s+it\s+doing\s+its\s+job\b/i, 'judgment'],
  // R4 additions — more normative/opinion shapes the 2K context run showed
  // inheriting the prior tool: "is that a problem?", "is that too many/too
  // much?", "is that a good idea?", "should I be worried?", "is that
  // secure/safe?" (a verdict, not a metadata read — "is it SAFE TO DELETE"
  // is excluded: it carries its own real route and never reaches this
  // detector, which only runs while STILL unrouted).
  [/\bis\s+(?:that|this|it)\s+(?:a\s+)?problem\b|\bis\s+(?:that|this|it)\s+(?:too\s+(?:many|much|few)|a\s+lot)\b/i, 'judgment'],
  [/\bis\s+(?:that|this|it)\s+(?:a\s+)?good\s+idea\b|\bshould\s+i\s+be\s+(?:worried|concerned)\b/i, 'judgment'],
  [/\bis\s+(?:that|this|it)\s+(?:considered\s+)?(?:secure|safe|risky|dangerous)\b(?!\s+to\s+delete\b)/i, 'judgment'],
  // Delivery/export asks (q914 "as a file rather than on screen", q882 "can
  // it be exported…", q1939 "flag those as an audit finding").
  [/\bas\s+a\s+file\b|\bcan\s+(?:it|this|that)\s+be\s+exported\b/i, 'delivery'],
  [/^\s*flag\s+(?:those|these|them|it)\b/i, 'delivery'],
  // R4 additions — more delivery/notification shapes: "email me that", "send
  // it to …", "put it in a spreadsheet / csv / pdf", "download it".
  [/^\s*(?:email|send|forward)\s+(?:me\s+)?(?:that|this|it|those|these|them)\b/i, 'delivery'],
  [/\b(?:as|in|to)\s+(?:a\s+)?(?:spreadsheet|csv|pdf|excel|report\s+file)\b|\b(?:can\s+(?:you|i)\s+)?download\s+(?:it|that|this|them)\b/i, 'delivery'],
  // Self-capability probes about the TOOL, not the org (q849 "does the tool
  // trace transitive access like that, or is that beyond it?").
  [/\b(?:does|can)\s+(?:the|this)\s+tool\b/i, 'tool-self-capability'],
  // R4 additions — "is that beyond you / can you even do that / do you have
  // that data" self-capability probes.
  [/\bis\s+(?:that|this)\s+beyond\s+(?:you|it|the\s+tool)\b|\bcan\s+you\s+even\b|\bdo\s+you\s+(?:have|hold)\s+(?:that|this)\s+(?:data|info(?:rmation)?)\b/i, 'tool-self-capability'],
  // Deployment-status telemetry (q1402 "was the change deployed or is it
  // still pending?").
  [/\bstill\s+pending\b|\bwas\s+(?:it|that|the\s+change)\s+deployed\b/i, 'deployment-status'],
];

/**
 * Gap family name when the follow-up is itself gap-shaped (must NOT inherit
 * the previous turn's tool), or null when it is a legitimate continuation.
 */
export const detectGapShapedFollowUp = (question: string): string | null => {
  for (const [shape, family] of GAP_FOLLOW_UP_SHAPES) {
    if (shape.test(question)) return family;
  }
  for (const shape of RUNTIME_FOLLOW_UP_SHAPES) {
    if (shape.test(question)) return 'runtime-analytics';
  }
  return null;
};

// ---------------------------------------------------------------------------
// Fail-open value validation (§1).
// ---------------------------------------------------------------------------

/**
 * Shape of the (Zod-validated) `context.previous` block the host passes.
 * `| undefined` unions mirror what `z.infer` produces for `.optional()` under
 * `exactOptionalPropertyTypes`.
 */
export interface PreviousTurnContext {
  readonly componentId?: string | undefined;
  readonly objectApiName?: string | undefined;
  readonly tool?: string | undefined;
  readonly intent?: string | undefined;
  readonly plane?: 'vault' | 'live' | 'hybrid' | undefined;
  readonly question?: string | undefined;
  readonly clarification?:
    | {
        readonly clarificationId: string;
        readonly options: readonly string[];
      }
    | undefined;
}

export interface ValidatedContext {
  readonly previous: PreviousTurnContext;
  /** Fail-open notes for `contextApplied.ignored`: fields skipped as invalid. */
  readonly ignored: readonly string[];
}

/** Canonical component id shape: `Type:Name` (e.g. `Flow:Order_Sync`). */
const COMPONENT_ID_SHAPE = /^[A-Za-z]+:.+$/;

/**
 * FAIL-OPEN value validation: a `previous.tool` not in the live tool registry
 * or a `previous.componentId` that is not a canonical `Type:Name` id is
 * DROPPED with a note — never a hard error, because hosts replay old state.
 * Context strings are NEVER treated as question text; the one text field,
 * `previous.question`, is only ever re-dispatched through the FULL handler.
 */
export const validatePreviousContext = (
  previous: PreviousTurnContext,
  isRegisteredTool: (tool: string) => boolean,
): ValidatedContext => {
  const ignored: string[] = [];
  let cleaned: PreviousTurnContext = previous;
  if (previous.tool !== undefined && !isRegisteredTool(previous.tool)) {
    ignored.push(
      `previous.tool '${previous.tool}' is not a registered tool; ignored`,
    );
    cleaned = { ...cleaned, tool: undefined };
  }
  if (
    previous.componentId !== undefined &&
    !COMPONENT_ID_SHAPE.test(previous.componentId)
  ) {
    ignored.push(
      `previous.componentId '${previous.componentId}' is not a canonical Type:Name id; ignored`,
    );
    cleaned = { ...cleaned, componentId: undefined };
  }
  return { previous: cleaned, ignored };
};

// ---------------------------------------------------------------------------
// Continuation tool ↔ resolved-type compatibility (§2b).
// ---------------------------------------------------------------------------

/**
 * Tool ↔ component-type compatibility for CONTEXT CONTINUATION only. A
 * superset of route-question's `TOOL_COMPATIBLE_TYPES` (which stays untouched
 * — extending it would change no-context routing): an inherited tool that is
 * type-incompatible with the substituted entity either gets swapped by
 * `applyComponentTypeGuard` (Flow substitutions) or the continuation is
 * abandoned and the route falls through to funnel-primary — never an
 * executable flow-tool bound to an Apex id.
 */
const CONTINUATION_TOOL_TYPES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sfi.call_graph', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.method_reachability', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.explain_apex_method', new Set(['ApexClass', 'ApexTrigger'])],
  ['sfi.who_can_access_object', new Set(['CustomObject'])],
  ['sfi.object_access_audit', new Set(['CustomObject'])],
  // The object BRIEF is the shape most likely to be asked as a follow-up —
  // "what is this object, where is it used, can we delete it" names nothing,
  // because the previous turn named it. Without this row the continuation was
  // abandoned and the brief was unreachable from the conversational form.
  ['sfi.object_360', new Set(['CustomObject'])],
  ['sfi.field_access_audit', new Set(['CustomField'])],
  ['sfi.explain_flow', new Set(['Flow'])],
  ['sfi.who_can_run', new Set(['Flow'])],
  ['sfi.what_if_deactivate_flow', new Set(['Flow'])],
  ['sfi.explain_field', new Set(['CustomField'])],
  ['sfi.field_360', new Set(['CustomField'])],
  ['sfi.field_lineage', new Set(['CustomField'])],
  ['sfi.safe_to_delete_field', new Set(['CustomField'])],
  ['sfi.explain_formula', new Set(['CustomField'])],
  ['sfi.what_happens_on_save', new Set(['CustomObject'])],
  ['sfi.order_of_execution', new Set(['CustomObject'])],
  ['sfi.what_if_disable_trigger', new Set(['ApexTrigger'])],
]);

/**
 * True when `tool` can accept a component of `resolvedType` (or is untyped /
 * the type is unknown — untyped tools are never blocked).
 */
export const continuationToolCompatible = (
  tool: string,
  resolvedType: string | null,
): boolean => {
  if (resolvedType === null) return true;
  const compatible = CONTINUATION_TOOL_TYPES.get(tool);
  return compatible === undefined || compatible.has(resolvedType);
};

// ---------------------------------------------------------------------------
// Re-parameterization target extraction (§2c).
// ---------------------------------------------------------------------------

/**
 * Filler vocabulary of a re-parameterization follow-up ("what about on
 * Contact?"). Deliberately EXCLUDES object-name words (`case`, `lead`,
 * `order`…) — only unambiguous function words are stripped, so a real
 * component name always survives.
 */
const REPARAM_FILLER = new Set([
  'what', 'whats', 'how', 'about', 'and', 'same', 'for', 'on', 'the', 'a',
  'an', 'of', 'in', 'to', 'does', 'do', 'is', 'are', 'look', 'like', 'way',
  'thing', 'question', 'too', 'also', 'instead', 'then', 'now', 'with',
  'combined', 'anything', 'everything', 'else', 'one',
]);

/**
 * Strip the anchor + filler words from a re-parameterization follow-up and
 * return the remaining candidate entity phrase (≤4 tokens), or null when
 * nothing plausible remains. The phrase goes through the NORMAL resolver —
 * clarification rules intact — so an ambiguous new entity still blocks.
 */
export const extractReparamTarget = (question: string): string | null => {
  const tokens = question
    .replace(/[?!.,;:]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !REPARAM_FILLER.has(token.toLowerCase()));
  if (tokens.length === 0 || tokens.length > 4) return null;
  return tokens.join(' ');
};
