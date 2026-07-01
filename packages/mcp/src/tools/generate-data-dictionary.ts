/**
 * Handler for the `sfi.generate_data_dictionary` MCP tool.
 *
 * The v2.5 documentation-generation tier first tool. Given a
 * CustomObject canonical id (`CustomObject:{ApiName}`), emits a
 * structured markdown document covering the object's fields,
 * relationships, validation rules, page layouts, and the triggers /
 * flows that fire on it.
 *
 * The tool is a pure composition over the graph layer — it walks
 * `parentOf` (object → fields, object → validation rules), incoming
 * `usedInLayout` (field → layout), incoming `triggersOn` (object →
 * apex trigger / flow), and outgoing `references` to map child
 * relationships (lookups, master-details). No new ComponentTypes, no
 * new EdgeTypes; just composition.
 *
 * Output shape (the v2.5 `GeneratedDocument` interface; declared in
 * this module and re-exported from sibling generators):
 *   - `frontmatter`: { title, generatedAt, sourceTreeHash, componentIds }.
 *   - `body`: structured markdown — H1 (object label) → H2 Overview
 *     → H2 Fields (table) → H2 Relationships → H2 Validation Rules →
 *     H2 Page Layouts → H2 Related Triggers/Flows → H2 Boundaries.
 *   - `sectionConfidence`: per-section confidence labels keyed by
 *     heading text (`'declared' | 'parsed' | 'heuristic'`).
 *   - `boundaries`: verbatim honesty disclosures appended to the
 *     document footer.
 *
 * Honesty axis (per the v2.5 spec): the document is structure, not
 * narrative. Section confidence is inherited from the source edges.
 * The frontmatter timestamp + source-tree hash let downstream
 * consumers detect staleness; the Boundaries section always carries
 * the Q125 freshness disclosure verbatim.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listChildren, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/**
 * The v2.5 shared output type. Defined here as the first generator
 * lands; sibling generator modules import the type from this module
 * to keep the contract anchored in one location.
 */
export interface GeneratedDocument {
  readonly frontmatter: {
    readonly title: string;
    readonly generatedAt: string;
    readonly sourceTreeHash: string;
    readonly componentIds: readonly ComponentId[];
  };
  readonly body: string;
  readonly sectionConfidence: Readonly<Record<string, ConfidenceLevel>>;
  readonly boundaries: readonly string[];
}

/**
 * Verbatim freshness disclosure required by the v2.5 spec (Q125
 * honesty anchor). Appears in every generated document's `boundaries`
 * footer and in the Boundaries H2 of the rendered body.
 */
export const Q125_FRESHNESS_DISCLOSURE =
  'Generated from offline vault on {TIMESTAMP}; missing real-time data, debug logs, runtime metrics.';

/**
 * Standard structural disclosure: every generator surfaces this so a
 * consumer treating the markdown as a literal source of truth has the
 * reminder up front.
 */
export const STRUCTURAL_DISCLOSURE =
  'Document is structure, not narrative; prose polish happens at the rendering layer.';

/**
 * Standard inherited-confidence disclosure: every generator surfaces
 * this so a consumer reading a heuristic-section knows the section's
 * data is suggestive rather than authoritative.
 */
export const INHERITED_CONFIDENCE_DISCLOSURE =
  'Section confidence is inherited from the source edges; spot-check heuristic entries before treating as authoritative.';

/** Canonical id prefix for the CustomObject node type. */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/**
 * Zod schema for the `sfi.generate_data_dictionary` tool input.
 *
 *   - `objectId`: required, non-empty string. Either the canonical
 *     CustomObject id (`CustomObject:{ApiName}`) or a bare object api
 *     name (`Account`) — the latter is coerced to the canonical id, so
 *     the doc-generator family is consistent with `generate_sharing_summary`
 *     (which takes a bare name). A wrong-type prefix (e.g. `ApexClass:Foo`)
 *     surfaces as `invalid-query`; unknown objects surface as
 *     `component-not-found`.
 */
export const generateDataDictionaryInputSchema = z.object({
  objectId: z.string().min(1),
});

/** Parsed input shape, inferred from `generateDataDictionaryInputSchema`. */
export type GenerateDataDictionaryInput = z.infer<
  typeof generateDataDictionaryInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateDataDictionaryOutput {
  readonly document: GeneratedDocument;
}

/** Pull a string property from a node's properties blob, with a fallback. */
const stringProp = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string => {
  const v = properties[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
};

/** Pull a boolean property with a default of false. */
const boolProp = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): boolean => properties[key] === true;

/** Escape a markdown table-cell value: pipes and newlines confuse readers. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Render a single fields-table row from a CustomField node. */
const renderFieldRow = (field: Node): string => {
  const label = escapeCell(
    stringProp(field.properties, 'label', field.label ?? field.apiName),
  );
  const apiName = escapeCell(field.apiName);
  const dataType = stringProp(field.properties, 'dataType', 'Unknown');
  // Flag formula (computed) fields. Showing only the return type (e.g.
  // `Currency`) is misleading in a data dictionary: a formula field is
  // read-only — you cannot write to it, and integrations / Apex must treat it
  // as computed, not stored.
  const isFormula = stringProp(field.properties, 'formula', '') !== '';
  const type = escapeCell(isFormula ? `${dataType} (formula)` : dataType);
  const description = escapeCell(
    stringProp(field.properties, 'description', ''),
  );
  const required = boolProp(field.properties, 'required') ? 'yes' : 'no';
  return `| ${label} | \`${apiName}\` | ${type} | ${description} | ${required} |`;
};

/** Comparator for stable field ordering: apiName ASC. */
const compareByApiName = (a: Node, b: Node): number =>
  a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0;

/**
 * Render the Fields section as a markdown table. An empty fields list
 * surfaces as "_(no fields extracted)_" so the section heading stays
 * present (deterministic structure).
 */
const renderFieldsSection = (fields: readonly Node[]): string => {
  if (fields.length === 0) {
    return ['## Fields', '', '_(no fields extracted)_'].join('\n');
  }
  const lines = [
    '## Fields',
    '',
    '| Label | API Name | Type | Description | Required |',
    '| --- | --- | --- | --- | --- |',
    ...[...fields].sort(compareByApiName).map(renderFieldRow),
  ];
  return lines.join('\n');
};

/**
 * Render the Relationships section. For lookups + master-details, walk
 * each CustomField's properties to extract `referenceTo`. Emit one
 * table row per relationship; deterministic by field apiName ASC.
 */
const renderRelationshipsSection = (fields: readonly Node[]): string => {
  type Rel = {
    readonly fieldApiName: string;
    readonly relationshipType: string;
    readonly referenceTo: string;
  };
  const rels: Rel[] = [];
  for (const field of fields) {
    const dataType = stringProp(field.properties, 'dataType', '');
    if (dataType !== 'Lookup' && dataType !== 'MasterDetail') continue;
    const referenceTo = stringProp(field.properties, 'referenceTo', 'Unknown');
    rels.push({
      fieldApiName: field.apiName,
      relationshipType: dataType,
      referenceTo,
    });
  }
  if (rels.length === 0) {
    return ['## Relationships', '', '_(no relationships extracted)_'].join('\n');
  }
  const sorted = [...rels].sort((a, b) =>
    a.fieldApiName < b.fieldApiName ? -1 : a.fieldApiName > b.fieldApiName ? 1 : 0,
  );
  const lines = [
    '## Relationships',
    '',
    '| Field | Type | References |',
    '| --- | --- | --- |',
    ...sorted.map(
      (r) =>
        `| \`${escapeCell(r.fieldApiName)}\` | ${r.relationshipType} | \`${escapeCell(r.referenceTo)}\` |`,
    ),
  ];
  return lines.join('\n');
};

/**
 * Render the Validation Rules section as a bulleted list. An empty
 * list surfaces as "_(no validation rules)_".
 */
const renderValidationRulesSection = (
  rules: readonly Node[],
): string => {
  if (rules.length === 0) {
    return ['## Validation Rules', '', '_(no validation rules)_'].join('\n');
  }
  const sorted = [...rules].sort(compareByApiName);
  const items = sorted.map((r) => {
    const description = stringProp(
      r.properties,
      'description',
      stringProp(r.properties, 'errorMessage', ''),
    );
    const desc = description.length > 0 ? ` — ${escapeCell(description)}` : '';
    return `- \`${escapeCell(r.apiName)}\`${desc}`;
  });
  return ['## Validation Rules', '', ...items].join('\n');
};

/**
 * Render the Page Layouts section as a bulleted list. The list is the
 * union of incoming `usedInLayout` edge sources across every field on
 * the object — i.e., every layout that surfaces ANY field of this
 * object.
 */
const renderPageLayoutsSection = (
  layoutIds: readonly ComponentId[],
): string => {
  if (layoutIds.length === 0) {
    return ['## Page Layouts', '', "_(no layouts reference this object's fields)_"].join('\n');
  }
  const sorted = [...layoutIds].sort();
  const items = sorted.map((id) => `- \`${id}\``);
  return ['## Page Layouts', '', ...items].join('\n');
};

/**
 * Render the Related Triggers / Flows section. The triggers + flows
 * are the source endpoints of incoming `triggersOn` edges to the
 * object id. Emit two bulleted sub-lists.
 */
const renderTriggersAndFlowsSection = (
  triggers: readonly ComponentId[],
  flows: readonly ComponentId[],
): string => {
  const trigsBlock =
    triggers.length === 0
      ? '_(no apex triggers)_'
      : [...triggers].sort().map((id) => `- \`${id}\``).join('\n');
  const flowsBlock =
    flows.length === 0
      ? '_(no record-triggered flows)_'
      : [...flows].sort().map((id) => `- \`${id}\``).join('\n');
  return [
    '## Related Triggers and Flows',
    '',
    '### Apex Triggers',
    '',
    trigsBlock,
    '',
    '### Flows',
    '',
    flowsBlock,
  ].join('\n');
};

/**
 * Render the closing Boundaries + How To Regenerate footer. The
 * disclosures are emitted verbatim per the v2.5 honesty contract.
 *
 * INVARIANT (load-bearing for `fitDocumentToBudget`): this block is
 * ALWAYS the final element of a generator's `body` array, and it ALWAYS
 * emits `## Boundaries` ... `## How To Regenerate` together, in that
 * order, with `## Boundaries` being the LAST `## Boundaries` line in the
 * whole body. `splitBodyIntoSections` anchors the never-droppable footer
 * on that last `## Boundaries` line through end-of-string, so a future
 * generator must keep this block last (and must not emit a `## Boundaries`
 * line earlier in its body) or the footer-survival guarantee weakens.
 */
export const renderFooter = (
  refreshedAt: string,
  regenerationHint: string,
): string =>
  [
    '## Boundaries',
    '',
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    '',
    INHERITED_CONFIDENCE_DISCLOSURE,
    '',
    STRUCTURAL_DISCLOSURE,
    '',
    '## How To Regenerate',
    '',
    regenerationHint,
  ].join('\n');

/**
 * The byte cost of the jsonResult envelope the global guard wraps around a
 * `GeneratedDocument`: the `{ data: { document[, targetMissing] }, vaultState,
 * estimatedPayloadBytes[, responseBudget][, orgDrift] }` shell. The helper
 * measures `byteLenOf(doc)` (= `JSON.stringify(document)`), while the global
 * guard trips on the FULL serialized envelope, so this reserve is exactly that
 * difference: `envelope_bytes - JSON.stringify(document)_bytes`.
 *
 * MEASURED, not guessed (the CR-08 regression came from over-reserving 8 KB,
 * which truncated docs that fit fine): the real wrapper overhead around a
 * GeneratedDocument is ~197 B for the plain `{ data: { document }, vaultState,
 * estimatedPayloadBytes }` shell, ~273 B with compliance's `targetMissing[]`,
 * and ~352 B once jsonResult attaches the `orgDrift` badge — newline escaping
 * is NOT extra here because both sides serialize through `JSON.stringify`. A
 * 1 KB reserve covers the worst measured case (~352 B) plus the `responseBudget`
 * field's headroom with margin, while staying ~8× tighter than the old 8 KB.
 *
 * The invariant this preserves: `reserve >= max_envelope_overhead`. That makes
 * the helper engage AT or BEFORE the global guard — a doc whose full envelope
 * is under the global cap (the guard would leave it byte-identical) also clears
 * the helper's `cap - reserve` budget untouched (the referential fast path),
 * so admin_handbook / onboarding (37–39 KB envelopes, under the 40 KB cap)
 * pass through unchanged. The `format: 'html'` path is handled by its own
 * `budget / 2` at the call site (that envelope ALSO carries the `html` string),
 * not by this reserve.
 */
const GENERATED_DOC_ENVELOPE_RESERVE_BYTES = 1_024;

/**
 * Floor for the per-document byte budget. RV4: this is NOT the global guard's
 * floor — the global `2_000` (tools/index.ts `responseBudgetBytes`) is the
 * SFI_MAX_RESPONSE_BYTES acceptance minimum (below which the error envelope
 * itself wouldn't fit), a different concept that merely shares the value `2_000`.
 * This floor only guards `generatedDocByteBudget` from targeting a negative or
 * absurdly small budget when an operator sets a tiny SFI_MAX_RESPONSE_BYTES. At
 * such a cap the generator collapses fully but the irreducible envelope still
 * exceeds the cap, so `jsonResult` returns a structured `oversize` error rather
 * than a footer-chopped doc — H7 cannot re-open. At the default 40 KB this floor
 * is never selected (max(2_000, 38_976) = 38_976).
 */
export const GENERATED_DOC_BUDGET_FLOOR_BYTES = 2_000;

/**
 * When a GENUINELY-oversized document must shed `frontmatter.componentIds[]`
 * (provenance metadata, not readable content), keep this many leading ids as a
 * representative sample and replace the rest with a count disclosure. The
 * sample preserves a usable provenance anchor while the count keeps the
 * trimming HONEST; the dropped count is also named in the Truncation Note.
 */
const COMPONENT_IDS_SAMPLE_KEEP = 25;

/**
 * Resolve the active response budget the same way `index.ts`'s
 * `responseBudgetBytes` does. DUPLICATED here (rather than imported) on
 * purpose: `index.ts` imports the generators, so importing back from it
 * would create a module cycle. Keeping the resolver local keeps the
 * per-document budget composable with an operator's `SFI_MAX_RESPONSE_BYTES`
 * override while staying cycle-free. Must track `index.ts`'s clamp.
 */
const GENERATED_DOC_MAX_RESPONSE_BYTES = 45_000;
const GENERATED_DOC_RESPONSE_BUDGET_DEFAULT_BYTES = 40_000;
const resolveResponseBudgetBytes = (): number => {
  const raw = process.env['SFI_MAX_RESPONSE_BYTES'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 2_000
    ? Math.min(Math.floor(parsed), GENERATED_DOC_MAX_RESPONSE_BYTES)
    : GENERATED_DOC_RESPONSE_BUDGET_DEFAULT_BYTES;
};

/**
 * The byte budget a `GeneratedDocument` is fitted to BEFORE the global
 * jsonResult guard ever sees it. Reading the LIVE response budget (minus
 * the envelope reserve, floored) means the fitted body lands under the
 * guard's `reductionCap`, so the global `slimDataStrings` 1024-char cut
 * never engages on `document.body` (the H7 dishonesty bug).
 */
export const generatedDocByteBudget = (): number =>
  Math.max(
    GENERATED_DOC_BUDGET_FLOOR_BYTES,
    resolveResponseBudgetBytes() - GENERATED_DOC_ENVELOPE_RESERVE_BYTES,
  );

/** UTF-8 byte length of a value's JSON serialization. Mirrors index.ts's `utf8Bytes`. */
const byteLenOf = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The three regions a generator's markdown `body` partitions into when
 * split on `## ` (exactly-two-hash) H2 boundaries:
 *   - `head`: everything before the FIRST `## ` line (the H1 + any preamble).
 *   - `sections`: the ordered list of `## ` blocks between head and footer.
 *   - `footer`: the trailing run from the LAST `## Boundaries` line to EOF
 *     (the renderFooter block — `## Boundaries` + `## How To Regenerate`,
 *     one indivisible unit). `null` when no `## Boundaries` line is present.
 */
interface SplitBody {
  readonly head: string;
  readonly sections: readonly string[];
  readonly footer: string | null;
}

/**
 * Partition a generator's markdown `body` into [head][sections...][footer].
 *
 * Splits strictly on lines matching `^## ` (exactly two hashes) so `### `
 * subheadings (e.g. data-dictionary's "### Apex Triggers / Flows") and
 * ```mermaid fences stay bound to their parent `## ` section. Tracks fenced
 * code-block state while scanning so a `## ` line INSIDE a ``` fence (no
 * current generator emits one, but it is latent fragility) is not mistaken
 * for a section boundary.
 *
 * The footer anchors on the LAST `## Boundaries` line through EOF, which
 * captures both `## Boundaries` and the `## How To Regenerate` that
 * renderFooter always emits after it. When no `## Boundaries` line exists
 * the footer is `null` and the caller must NOT drop anything (never risk
 * the honesty footer).
 */
export const splitBodyIntoSections = (body: string): SplitBody => {
  const lines = body.split('\n');
  const isFence = (line: string): boolean => line.trimStart().startsWith('```');
  // Index of every `## ` H2 heading line that is NOT inside a code fence.
  const headingIdx: number[] = [];
  let lastBoundariesIdx = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^## /.test(line)) {
      headingIdx.push(i);
      if (line.startsWith('## Boundaries')) lastBoundariesIdx = i;
    }
  }

  if (headingIdx.length === 0) {
    return { head: body, sections: [], footer: null };
  }
  // No honesty footer to anchor on → caller must not drop. Signal via footer=null.
  if (lastBoundariesIdx === -1) {
    return { head: body, sections: [], footer: null };
  }

  const firstHeading = headingIdx[0] ?? 0;
  const head = lines.slice(0, firstHeading).join('\n');
  const footer = lines.slice(lastBoundariesIdx).join('\n');

  // Section heading lines strictly between the first heading and the footer.
  const middleHeadings = headingIdx.filter(
    (idx) => idx >= firstHeading && idx < lastBoundariesIdx,
  );
  const sections: string[] = [];
  for (let h = 0; h < middleHeadings.length; h += 1) {
    const start = middleHeadings[h] ?? 0;
    const end = middleHeadings[h + 1] ?? lastBoundariesIdx;
    sections.push(lines.slice(start, end).join('\n'));
  }
  return { head, sections, footer };
};

/** The first `## ` heading text of a section block, for the truncation note's drop list. */
const sectionHeading = (section: string): string => {
  const firstLine = section.split('\n', 1)[0] ?? '';
  return firstLine.replace(/^##\s+/, '').trim();
};

/**
 * How `frontmatter.componentIds[]` was trimmed (the FIRST reduction step). When
 * present in the truncation note it discloses how many provenance ids were
 * dropped and how many were kept as a sample, so a reader knows the id list is
 * a representative sample, not the complete provenance set.
 */
interface ComponentIdsTrimSummary {
  readonly kept: number;
  readonly dropped: number;
}

/**
 * Build the in-body truncation note naming the dropped section headings, any
 * componentIds trimming, and the remedy. Always placed immediately BEFORE the
 * footer so the honesty Boundaries block stays the document's tail.
 *
 * `idsTrim` is the FIRST reduction step (provenance metadata), disclosed ahead
 * of the dropped readable sections so the note reads in reduction order.
 */
const renderTruncationNote = (
  droppedHeadings: readonly string[],
  idsTrim?: ComponentIdsTrimSummary,
): string => {
  const lines: string[] = [
    '## Truncation Note',
    '',
    'This document exceeded the response-size budget and was reduced to keep the readable body and the full Boundaries disclosures intact.',
  ];
  if (idsTrim !== undefined && idsTrim.dropped > 0) {
    lines.push(
      '',
      `Provenance was trimmed FIRST: \`frontmatter.componentIds\` kept the first ${idsTrim.kept.toString()} of ${(idsTrim.kept + idsTrim.dropped).toString()} component ids as a sample (…and ${idsTrim.dropped.toString()} more components). The trimmed ids are provenance metadata, not readable content.`,
    );
  }
  if (droppedHeadings.length > 0) {
    const named = droppedHeadings.map((h) => `\`${h}\``).join(', ');
    lines.push(
      '',
      `The following readable section(s) were then dropped tail-first to fit: ${named}.`,
    );
  }
  lines.push(
    '',
    'To get the dropped detail, re-run with a narrower scope (e.g. an `objectFilter` / `objectApiName` for a single object, a `personaFocus`, or pagination), or request `format: "html"` where available for the full document.',
  );
  return lines.join('\n');
};

/**
 * Fit a `GeneratedDocument` to a byte budget, ALWAYS preserving the readable
 * body's value and the honesty footer. This runs in each generator BEFORE the
 * global jsonResult guard, so the guard's `slimDataStrings` never hard-cuts
 * `document.body` to 1024 chars (the H7 dishonesty bug that would silently
 * destroy the disclosures).
 *
 * Reduction PRIORITY (least-valuable shed first):
 *   1. Trim `frontmatter.componentIds[]` — provenance metadata, not readable
 *      content, and the real bloat for the union-everything generators
 *      (admin_handbook / onboarding carry 800+ ids = ~34 KB while the body is
 *      ~2–3 KB). Keep the first `COMPONENT_IDS_SAMPLE_KEEP` ids as a sample;
 *      the dropped count is disclosed in the Truncation Note. If this alone
 *      brings the doc under budget, EVERY readable section is preserved.
 *   2. ONLY if still over budget, drop whole body sections tail-first
 *      (least-important last), on top of the trimmed componentIds.
 *
 * Footer-survival is UNCONDITIONAL: the honesty footer (`## Boundaries` +
 * `## How To Regenerate`), `sectionConfidence`, and per-section confidence are
 * always preserved. Middle sections are dropped — down to ZERO if necessary —
 * but the Boundaries block always reaches the client intact.
 *
 * Pure and referential: a doc whose full response envelope is under the global
 * cap is returned UNCHANGED (same object) — the budget is `cap - measured
 * envelope overhead`, so it engages at or before the global guard and realistic
 * under-cap docs (admin_handbook / onboarding) stay byte-identical with no note
 * and no id trimming.
 *
 * @example
 *   const fitted = fitDocumentToBudget(
 *     { frontmatter, body, sectionConfidence, boundaries },
 *     generatedDocByteBudget(),
 *   );
 */
export const fitDocumentToBudget = (
  doc: GeneratedDocument,
  budgetBytes: number,
): GeneratedDocument => {
  // Fast path: already fits → return the SAME object (referential identity).
  // The budget is `cap - measured envelope overhead`, so an under-cap doc the
  // global guard would leave byte-identical also passes here untouched.
  if (byteLenOf(doc) <= budgetBytes) return doc;

  const { head, sections, footer } = splitBodyIntoSections(doc.body);
  // No honesty footer to anchor on (should never happen for a real generator)
  // → never risk dropping it; return the doc unchanged.
  if (footer === null) return doc;

  // STEP 1 — trim frontmatter.componentIds[] FIRST. It is provenance metadata
  // (not readable content) and is the real bloat for the union-everything
  // generators, so shedding it before any body section preserves the value.
  const fullIds = doc.frontmatter.componentIds;
  const idsAreTrimmable = fullIds.length > COMPONENT_IDS_SAMPLE_KEEP;
  const trimmedIds: readonly ComponentId[] = idsAreTrimmable
    ? fullIds.slice(0, COMPONENT_IDS_SAMPLE_KEEP)
    : fullIds;
  const idsTrim: ComponentIdsTrimSummary | undefined = idsAreTrimmable
    ? { kept: trimmedIds.length, dropped: fullIds.length - trimmedIds.length }
    : undefined;

  // Reassemble a candidate body from the kept sections + (optional) note. The
  // note discloses the componentIds trim (if any) and the dropped sections.
  const assemble = (
    kept: readonly string[],
    dropped: readonly string[],
    notedIdsTrim: ComponentIdsTrimSummary | undefined,
  ): string => {
    const parts: string[] = [head, ...kept];
    const hasNote =
      dropped.length > 0 || (notedIdsTrim !== undefined && notedIdsTrim.dropped > 0);
    if (hasNote) parts.push(renderTruncationNote(dropped, notedIdsTrim));
    parts.push(footer);
    // Drop empty leading/trailing fragments to avoid stray blank runs, but keep
    // interior joins (sections already carry their own blank-line separators).
    return parts.filter((p) => p.length > 0).join('\n');
  };

  const candidate = (
    ids: readonly ComponentId[],
    kept: readonly string[],
    dropped: readonly string[],
    notedIdsTrim: ComponentIdsTrimSummary | undefined,
  ): GeneratedDocument => ({
    ...doc,
    frontmatter: { ...doc.frontmatter, componentIds: ids },
    body: assemble(kept, dropped, notedIdsTrim),
  });

  // If trimming componentIds alone fits, keep every readable body section.
  const idsOnly = candidate(trimmedIds, sections, [], idsTrim);
  if (byteLenOf(idsOnly) <= budgetBytes) return idsOnly;

  // STEP 2 — still over budget: drop whole body sections tail-first, on top of
  // the trimmed componentIds. Re-measure the FULL serialized doc each time
  // until it fits or every middle section is gone (footer + note never dropped).
  const kept = [...sections];
  const dropped: string[] = [];
  while (
    byteLenOf(candidate(trimmedIds, kept, dropped, idsTrim)) > budgetBytes &&
    kept.length > 0
  ) {
    const removed = kept.pop();
    if (removed !== undefined) dropped.unshift(sectionHeading(removed));
  }

  // If nothing was actually dropped (the body grew under serialization but the
  // sections were all empty / the split could not help), still return a fitted
  // shape; assemble with no dropped list yields head + sections + footer.
  return candidate(trimmedIds, kept, dropped, idsTrim);
};

/**
 * The `sfi.generate_data_dictionary` MCP tool. Returns a structured
 * markdown document describing a single CustomObject. See the module
 * JSDoc for the recipe and the honesty axis.
 *
 * @example
 *   const r = await generateDataDictionaryHandler(ctx, {
 *     objectId: 'CustomObject:Account',
 *   });
 *   if (r.ok) console.log(r.value.data.document.body);
 */
export const generateDataDictionaryHandler = async (
  ctx: Context,
  input: GenerateDataDictionaryInput,
): Promise<Result<McpResponse<GenerateDataDictionaryOutput>, McpError>> => {
  // Accept either the canonical id (`CustomObject:Account`) or a bare object api
  // name (`Account`) — the sibling `generate_sharing_summary` takes a bare name,
  // so coercing here keeps the doc-generator family consistent. A wrong-type
  // prefix (e.g. `ApexClass:Foo`) is left intact and rejected below.
  const objectId = coercePrefix(input.objectId, [CUSTOM_OBJECT_PREFIX]) as ComponentId;
  if (!objectId.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `objectId must be a CustomObject id (e.g. '${CUSTOM_OBJECT_PREFIX}Account') or a bare object api name (e.g. 'Account'); got '${input.objectId}'`,
      path: 'objectId',
    });
  }
  const objectResult = await getNodeById(ctx.graph, objectId);
  if (!objectResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${objectResult.error.message}`,
    });
  }
  const object = objectResult.value;
  if (object === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, objectId, 'CustomObject'),
      path: objectId,
    });
  }

  // Fetch children (fields, validation rules) via parentOf.
  const childrenResult = await listChildren(ctx.graph, objectId);
  if (!childrenResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${childrenResult.error.message}`,
    });
  }
  const fields: Node[] = [];
  const validationRules: Node[] = [];
  for (const child of childrenResult.value) {
    if (child.type === 'CustomField') fields.push(child);
    else if (child.type === 'ValidationRule') validationRules.push(child);
  }

  // For Page Layouts: walk each field's incoming `usedInLayout` edges
  // and collect the unique layout source ids.
  const layoutIds = new Set<ComponentId>();
  for (const field of fields) {
    const edgesResult = await listEdges(ctx.graph, field.id, {
      direction: 'in',
      edgeType: 'usedInLayout',
    });
    if (!edgesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgesResult.error.message}`,
      });
    }
    for (const edge of edgesResult.value) {
      layoutIds.add(edge.fromId);
    }
  }

  // For Triggers / Flows: walk the object's incoming `triggersOn`
  // edges and partition by the source node's id-prefix.
  const incomingTriggersResult = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!incomingTriggersResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${incomingTriggersResult.error.message}`,
    });
  }
  const triggerIds: ComponentId[] = [];
  const flowIds: ComponentId[] = [];
  for (const edge of incomingTriggersResult.value) {
    if (edge.fromId.startsWith('ApexTrigger:')) triggerIds.push(edge.fromId);
    else if (edge.fromId.startsWith('Flow:')) flowIds.push(edge.fromId);
  }

  // Compose the body.
  const objectLabel = object.label ?? object.apiName;
  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();

  const overviewBlock = [
    '## Object Overview',
    '',
    `**API Name:** \`${object.apiName}\`  `,
    `**Label:** ${escapeCell(objectLabel)}  `,
    `**Field count:** ${fields.length.toString()}  `,
    `**Validation rules:** ${validationRules.length.toString()}`,
  ].join('\n');

  const componentIds: ComponentId[] = [
    objectId,
    ...fields.map((f) => f.id),
    ...validationRules.map((v) => v.id),
  ];

  const body = [
    `# ${objectLabel} — Data Dictionary`,
    '',
    overviewBlock,
    '',
    renderFieldsSection(fields),
    '',
    renderRelationshipsSection(fields),
    '',
    renderValidationRulesSection(validationRules),
    '',
    renderPageLayoutsSection([...layoutIds]),
    '',
    renderTriggersAndFlowsSection(triggerIds, flowIds),
    '',
    renderFooter(
      refreshedAt,
      `Re-run \`sfi.generate_data_dictionary({ objectId: '${objectId}' })\` after the next \`sfi refresh\`.`,
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'Object Overview': 'declared',
    Fields: 'declared',
    Relationships: 'declared',
    'Validation Rules': 'declared',
    'Page Layouts': 'declared',
    'Related Triggers and Flows': 'parsed',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
  ];

  const document: GeneratedDocument = fitDocumentToBudget(
    {
      frontmatter: {
        title: `${objectLabel} — Data Dictionary`,
        generatedAt,
        sourceTreeHash,
        componentIds,
      },
      body,
      sectionConfidence,
      boundaries,
    },
    generatedDocByteBudget(),
  );

  return ok({
    data: { document },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
