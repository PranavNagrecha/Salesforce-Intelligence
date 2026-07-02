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
