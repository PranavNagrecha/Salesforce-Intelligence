/**
 * Body merge-token scanner for the v1.3 EmailTemplate extractor's v3.0
 * extension (PLAN-v3.0 §3 + §4 R2).
 *
 * The `<content>` element of a Salesforce EmailTemplate carries either
 * plain text or HTML; both flavours embed merge tokens of the form
 * `{!Object.Field}` (Visualforce-style expressions). For example:
 *
 *   {!Account.Name}
 *   {!Contact.Email}
 *   {!Account.Customer_Segment__c}
 *
 * Conditional merges layer expressions on top of the same syntax:
 *
 *   {!IF(Account.Customer_Segment__c == "Enterprise", "Premium support",
 *        "Standard support")}
 *
 * The grammar v3.0 captures: every dotted `Object.Field` token reachable
 * inside any `{! ... }` envelope. This includes references nested inside
 * function calls (`IF`, `CASE`, etc.). The v3.0 honesty axis: the parser
 * captures the field REFERENCES inside conditional merges; it does NOT
 * capture the firing semantics of the condition itself. When ANY merge
 * uses function-call syntax, `richTemplateSyntaxDetected` flips true so
 * the renderer can surface the "field refs captured; firing logic not"
 * disclosure verbatim.
 *
 * Per PLAN-v3.0 §3 "EdgeType union — No additions" — the extension emits
 * the existing `references` family with `confidence: 'parsed'`. The
 * `{!Object.Field}` syntax is a deterministic parseable grammar; the
 * emission shape mirrors the v0.2 formula tokenizer's `references`
 * emission (both `parsed`).
 *
 * The parser is pure: it takes a body string and returns a structured
 * output. It does not consult the graph; the email-template extractor
 * assembles canonical edges from the parser's output. The deterministic
 * sort order (by `objectApiName`, `fieldApiName`) means the extension
 * is reproducible across runs without depending on Map iteration order.
 */

/**
 * One merge-token reference captured from a template body. The
 * `objectApiName` and `fieldApiName` are the two halves of a dotted
 * `Object.Field` token; the canonical edge target the email-template
 * extractor forms is `CustomField:{objectApiName}.{fieldApiName}`.
 *
 * The `conditional` flag is `true` when the reference appeared inside a
 * function-call merge (e.g., `{!IF(...)}`). It does NOT change the edge
 * confidence — references inside conditional merges are still parsed —
 * but the email-template node's `richTemplateSyntaxDetected` property
 * surfaces the overall posture so the renderer can attach the
 * "firing logic NOT captured" disclosure per PLAN-v3.0 §4 honesty axis.
 *
 * @example
 *   const ref: BodyMergeReference = {
 *     objectApiName: 'Account',
 *     fieldApiName: 'Customer_Segment__c',
 *     mergeContext: '{!Account.Customer_Segment__c}',
 *     conditional: false,
 *   };
 */
export interface BodyMergeReference {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  /** The verbatim `{!...}` token the reference was extracted from. */
  readonly mergeContext: string;
  readonly conditional: boolean;
}

/**
 * The structured payload `parseEmailTemplateBody` returns. The
 * `references` array is deduplicated by `(objectApiName, fieldApiName)`
 * and sorted ASC on the canonical id form; `richTemplateSyntaxDetected`
 * is `true` when at least one `{!FN(...)}` merge appears.
 *
 * `referencedObjects` is the deduplicated set of object names across
 * every reference; the email-template extractor surfaces it as a node
 * property so consumers can render a "this template merges from
 * Account, Contact" summary without re-walking the references array.
 */
export interface BodyParseOutput {
  readonly references: readonly BodyMergeReference[];
  readonly referencedObjects: readonly string[];
  readonly richTemplateSyntaxDetected: boolean;
}

/**
 * Matches a merge envelope `{!...}` where `...` is the inner expression.
 * The non-greedy `[^}]*` body intentionally rejects nested `}` — the v3.0
 * grammar treats the first `}` as the envelope close, which mirrors the
 * Salesforce merge-token recognizer behaviour. The `g` flag drives
 * iteration over the body string.
 */
const MERGE_ENVELOPE_RE = /\{!([^}]*)\}/g;

/**
 * Matches a dotted identifier of the form `Object.Field`. Identifiers
 * start with an ASCII letter and continue with letters/digits/underscores
 * (the Salesforce API-name rule); both halves use the same character
 * class. The `g` flag drives iteration inside each envelope's inner
 * expression.
 *
 * The parser is intentionally namespace-naive in v3.0 — a managed-package
 * reference `{!npsp__Household.Name}` produces a reference with
 * `objectApiName: 'npsp__Household'`. The downstream graph lookup will
 * either find or not find that field; either outcome is the right one.
 */
const DOTTED_IDENTIFIER_RE = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/g;

/**
 * Detects a function-call shape (`IDENT(...)`) anywhere inside the inner
 * expression. Used to flag conditional merges; the v3.0 axis is "did the
 * author wrap field refs in a function?". Both `IF`/`CASE`/`AND` and
 * less-common functions count — the recognizer is shape-only, not
 * semantically informed.
 */
const FUNCTION_CALL_RE = /[A-Za-z_][A-Za-z0-9_]*\s*\(/;

/**
 * Compute the canonical id form for sort ordering and deduplication.
 * Matches the email-template extractor's emitted edge `toId` shape:
 * `CustomField:{objectApiName}.{fieldApiName}`.
 */
const canonicalFieldId = (ref: BodyMergeReference): string =>
  `CustomField:${ref.objectApiName}.${ref.fieldApiName}`;

/**
 * Scan a single merge envelope's inner expression for dotted
 * `Object.Field` references. Multiple references inside one envelope
 * (e.g., `{!IF(Account.Industry == "X", Contact.Email, "")}`) all share
 * the same `conditional` flag and `mergeContext` (the envelope text).
 */
const scanEnvelope = (
  inner: string,
  envelopeText: string,
  conditional: boolean,
): BodyMergeReference[] => {
  const refs: BodyMergeReference[] = [];
  for (const match of inner.matchAll(DOTTED_IDENTIFIER_RE)) {
    const objectApiName = match[1];
    const fieldApiName = match[2];
    if (objectApiName === undefined || fieldApiName === undefined) continue;
    refs.push({
      objectApiName,
      fieldApiName,
      mergeContext: envelopeText,
      conditional,
    });
  }
  return refs;
};

/**
 * Parse an EmailTemplate `<content>` body for merge-token field
 * references.
 *
 * Returns a deduplicated, ASC-sorted array of `{ objectApiName,
 * fieldApiName, mergeContext, conditional }` entries plus the
 * `referencedObjects` summary and the `richTemplateSyntaxDetected`
 * flag. A body without any `{!...}` envelopes produces an empty
 * `references` array and `richTemplateSyntaxDetected: false`. A body
 * with a function-call merge flips the flag regardless of whether
 * any field reference was captured (the firing-logic disclosure
 * needs to fire even when the function envelope contained only
 * literals).
 *
 * Deduplication keys on `(objectApiName, fieldApiName)`: the same
 * field referenced twice in different merges yields ONE entry. The
 * `mergeContext` and `conditional` flag are taken from the FIRST
 * occurrence — keeping the first encounter makes the extension
 * deterministic across body edits that add a duplicate reference
 * later in the document. When a field is referenced both inside and
 * outside a conditional, the FIRST occurrence wins — callers that
 * need to know whether the field appears in any conditional surface
 * can re-walk via the template-level `richTemplateSyntaxDetected`
 * flag.
 *
 * @example
 *   parseEmailTemplateBody('Hello {!Account.Name}, segment {!Account.Customer_Segment__c}.');
 *   // => {
 *   //   references: [
 *   //     { objectApiName: 'Account', fieldApiName: 'Customer_Segment__c', ... },
 *   //     { objectApiName: 'Account', fieldApiName: 'Name', ... },
 *   //   ],
 *   //   referencedObjects: ['Account'],
 *   //   richTemplateSyntaxDetected: false,
 *   // }
 */
export const parseEmailTemplateBody = (body: string): BodyParseOutput => {
  const seen = new Map<string, BodyMergeReference>();
  let richTemplateSyntaxDetected = false;

  for (const envelope of body.matchAll(MERGE_ENVELOPE_RE)) {
    const inner = envelope[1];
    const envelopeText = envelope[0];
    if (inner === undefined || envelopeText === undefined) continue;
    const conditional = FUNCTION_CALL_RE.test(inner);
    if (conditional) richTemplateSyntaxDetected = true;
    for (const ref of scanEnvelope(inner, envelopeText, conditional)) {
      const key = `${ref.objectApiName}.${ref.fieldApiName}`;
      if (!seen.has(key)) seen.set(key, ref);
    }
  }

  const references = [...seen.values()].sort((a, b) =>
    canonicalFieldId(a) < canonicalFieldId(b)
      ? -1
      : canonicalFieldId(a) > canonicalFieldId(b)
        ? 1
        : 0,
  );

  const objectSet = new Set<string>();
  for (const ref of references) objectSet.add(ref.objectApiName);
  const referencedObjects = [...objectSet].sort();

  return { references, referencedObjects, richTemplateSyntaxDetected };
};
