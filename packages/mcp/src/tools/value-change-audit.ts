/**
 * Handler for the `sfi.value_change_audit` MCP tool.
 *
 * The batch / portfolio complement to `sfi.what_if_change_field_value`. This
 * is the Data Steward's flagship question: "if I change the VALUES in these
 * fields on {object}, what breaks?" — asked over a SET of fields, risk-ranked.
 *
 *   - With `fields`: audits exactly those fields (each resolved as
 *     `CustomField:{object}.{field}`); unknown ones are returned in `notFound`.
 *   - Without `fields`: AUTO-DETECTS the value-sensitive fields on the object
 *     (upsert keys via externalId/unique/idLookup, identity-catalog members,
 *     and name-lexicon matches) using the cheap pure classifier, then assesses
 *     only those — so a 200-field object doesn't trigger 200 edge walks.
 *
 * Each row carries an overall severity, the role, the top impact reasons, a
 * confidence, and a disclosure count; `verbosity:'detail'` inlines the full
 * buckets. Output is risk-ranked and capped for the MCP response-size limit.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildCoverageCaveat,
  VALUE_LITERAL_READER_COVERAGE,
} from './coverage-trust.js';
import {
  firstNonEmpty,
  parseFieldParentObjectApiName,
  resolveObjectAlias,
  toCustomObjectId,
} from './input-aliases.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateLegacy,
} from './page-cursor.js';
import {
  classifyField,
  lookupIdentityCatalog,
  severityRank,
  type Confidence,
  type Severity,
} from './value-change-classification.js';
import { assessValueChange, type BucketHit } from './value-change-risk.js';

/** Max rows returned (response-size guard); excess is dropped with a note. */
const MAX_ROWS = 200;
/** Page size for listing an object's fields. */
const PAGE = 500;

export interface AuditRow {
  readonly field: string;
  readonly fieldId: ComponentId;
  readonly role: string;
  readonly overallSeverity: Severity;
  readonly mutable: boolean;
  readonly topReasons: readonly string[];
  readonly confidence: Confidence;
  readonly disclosureCount: number;
  readonly buckets?: readonly BucketHit[];
}

export interface CoverageCaveat {
  readonly status: 'partial' | 'unknown';
  readonly missingCoverage: readonly string[];
  readonly message: string;
}

export interface ValueChangeAuditOutput {
  readonly object: string;
  readonly autoDetected: boolean;
  readonly scannedFieldCount: number;
  readonly rows: readonly AuditRow[];
  readonly truncated: boolean;
  readonly summary: Readonly<Record<Severity, number>>;
  readonly globalDisclosures: readonly string[];
  readonly notFound?: readonly string[];
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  /**
   * CR-22 opaque continuation token, present ONLY when `rows` was truncated
   * (over `limit`/MAX_ROWS or the byte budget). Echo it back as `cursor` to
   * resume; absent on a whole-fits page so an in-budget response is byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

const DISCLOSURE =
  'value_change_audit ranks fields by the impact of changing their stored VALUE (not schema). Auto-detect surfaces upsert keys (externalId/unique/idLookup), identity-catalog fields, and name-lexicon matches — it can miss a value-sensitive field that carries none of those signals, and the per-row blast radius inherits what_if_change_field_value’s boundaries (external upsert systems, the IdP side of SSO, and dynamic/managed-package code are invisible).';

const GLOBAL_DISCLOSURES: readonly string[] = [
  'External systems that upsert on these keys live outside org metadata — confirm them in your middleware / ETL.',
  'SSO identity mapping (which field the IdP asserts) is read from SamlSsoConfig when present; verify your IdP.',
  'Reports, list-view filters, and manual processes may key on these values.',
];

export const valueChangeAuditInputSchema = z.object({
  /**
   * Canonical object api name. Optional at the SCHEMA level because a host /
   * router may instead name the object through the interchangeable selectors
   * below (VALUE-CHANGE-AUDIT-REJECTS-NATURAL-FIELD-ARGS): `objectApiName`, or a
   * `fieldId` (`CustomField:Object.Field`) whose PARENT is the object. The
   * handler returns a named `invalid-query` when none names an object.
   */
  object: z.string().min(1).optional(),
  /** Alias for `object` — the object api name a host naturally reaches for. */
  objectApiName: z.string().min(1).optional(),
  /**
   * A single `CustomField:Object.Field` selector: its parent seeds `object` and
   * the field itself seeds a one-field `fields` list. Disagreeing with an
   * explicit `object`/`objectApiName` → named `invalid-query` (never silently
   * stripped).
   */
  fieldId: z.string().min(1).optional(),
  /** A single bare field api name — seeds a one-field `fields` list. */
  fieldApiName: z.string().min(1).optional(),
  fields: z.array(z.string()).optional(),
  verbosity: z.enum(['summary', 'detail']).optional(),
  // CR-22: page size for the risk-ranked `rows` list. Capped at MAX_ROWS so the
  // response-size guard holds; default = MAX_ROWS so a no-limit call returns
  // today's first 200 rows byte-identically.
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0).
  cursor: z.string().min(1).optional(),
});

export type ValueChangeAuditInput = z.infer<typeof valueChangeAuditInputSchema>;

/** Page every CustomField node parented by `objectId`. */
const listObjectFields = async (ctx: Context, objectId: ComponentId): Promise<Result<Node[], McpError>> => {
  const all: Node[] = [];
  let offset = 0;
  for (;;) {
    const res = await listNodesByType(ctx.graph, 'CustomField', { parentId: objectId, limit: PAGE, offset });
    if (!res.ok) return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    all.push(...res.value);
    if (res.value.length < PAGE) break;
    offset += PAGE;
  }
  return ok(all);
};

/** A field is an auto-detect candidate if it carries any value-sensitive signal. */
const isCandidate = (node: Node): boolean => {
  const c = classifyField(node);
  if (c.mutability.mutability === 'derived') return false;
  return (
    c.upsertKey.isUpsertKey ||
    lookupIdentityCatalog(c.object, c.field) !== null ||
    severityRank(c.role.severity) >= severityRank('medium')
  );
};

const buildRow = (
  assessment: Awaited<ReturnType<typeof assessValueChange>> extends Result<infer A, McpError> ? A : never,
  node: Node,
  verbosity: 'summary' | 'detail',
): AuditRow => {
  const classification = classifyField(node);
  const topReasons = [...assessment.buckets]
    .filter((b) => b.severity !== 'info')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 3)
    .map((b) => `${b.bucket} (${b.severity})`);
  return {
    field: assessment.field,
    fieldId: assessment.fieldId as ComponentId,
    role: classification.role.role,
    overallSeverity: assessment.overallSeverity,
    mutable: assessment.mutable,
    topReasons,
    confidence: classification.role.confidence,
    disclosureCount: assessment.disclosures.length,
    ...(verbosity === 'detail' ? { buckets: assessment.buckets } : {}),
  };
};

/**
 * The `sfi.value_change_audit` MCP tool. See the module JSDoc.
 *
 * @example
 *   await valueChangeAuditHandler(ctx, { object: 'User',
 *     fields: ['Username', 'FederationIdentifier', 'Alias'] });
 */
export const valueChangeAuditHandler = async (
  ctx: Context,
  input: ValueChangeAuditInput,
): Promise<Result<McpResponse<ValueChangeAuditOutput>, McpError>> => {
  // Resolve the object + field(s) from the natural selectors a host / router may
  // pass (VALUE-CHANGE-AUDIT-REJECTS-NATURAL-FIELD-ARGS). Byte-identical when the
  // canonical `{object}` / `{object, fields}` is passed.
  //
  // Reuse the shared `resolveObjectAlias`: a `CustomField:Object.Field` `fieldId`
  // names BOTH the object (its parent) and a field, so we feed the derived
  // parent into the resolver as `objectId` — an explicit `object`/`objectApiName`
  // that DISAGREES then surfaces as the resolver's conflict `invalid-query`
  // (never a silent strip); agreeing selectors de-dupe to one target.
  const rawForObject: Record<string, unknown> = { ...input };
  if (input.fieldId !== undefined && rawForObject['objectId'] === undefined) {
    const parent = parseFieldParentObjectApiName(input.fieldId);
    if (parent !== null) rawForObject['objectId'] = toCustomObjectId(parent);
  }
  const objScope = resolveObjectAlias(rawForObject);
  if (!objScope.ok) return err(objScope.error);
  if (objScope.value === null) {
    return err({
      kind: 'invalid-query',
      message:
        'name the object — pass `object` / `objectApiName`, or a `fieldId` (`CustomField:Object.Field`) whose parent is the object',
      path: 'object',
    });
  }
  const object = objScope.value.object;
  const objectId = `CustomObject:${object}` as ComponentId;
  const verbosity = input.verbosity ?? 'summary';

  // Explicit `fields` wins; else a single-field selector (`fieldId` /
  // `fieldApiName`) seeds a one-field list. `undefined` → auto-detect (unchanged).
  const singleField = firstNonEmpty(input.fieldId, input.fieldApiName);
  const resolvedFields: readonly string[] | undefined =
    input.fields !== undefined
      ? input.fields
      : singleField !== undefined
        ? [singleField]
        : undefined;

  let candidates: Node[] = [];
  let autoDetected: boolean;
  let scannedFieldCount: number;
  const notFound: string[] = [];

  if (resolvedFields !== undefined && resolvedFields.length > 0) {
    autoDetected = false;
    scannedFieldCount = resolvedFields.length;
    for (const f of resolvedFields) {
      const id = (f.startsWith('CustomField:') ? f : `CustomField:${object}.${f}`) as ComponentId;
      const nodeResult = await getNodeById(ctx.graph, id);
      if (!nodeResult.ok) return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
      if (nodeResult.value === null) { notFound.push(f); continue; }
      candidates.push(nodeResult.value);
    }
  } else {
    autoDetected = true;
    const fieldsResult = await listObjectFields(ctx, objectId);
    if (!fieldsResult.ok) return err(fieldsResult.error);
    scannedFieldCount = fieldsResult.value.length;
    candidates = fieldsResult.value.filter(isCandidate);
  }

  const rows: AuditRow[] = [];
  for (const node of candidates) {
    const assessmentResult = await assessValueChange(ctx, node);
    if (!assessmentResult.ok) return err(assessmentResult.error);
    rows.push(buildRow(assessmentResult.value, node, verbosity));
  }

  // Total order: severity DESC, then field ASC, then fieldId ASC (fieldId is the
  // canonical CustomField id — provably unique — so an offset-based cursor
  // resume can neither dup nor skip at a (severity, field) tie boundary).
  rows.sort((a, b) =>
    severityRank(b.overallSeverity) - severityRank(a.overallSeverity) ||
    (a.field < b.field ? -1 : a.field > b.field ? 1 : 0) ||
    (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0),
  );

  // Resolve the resume offset: an echoed CR-22 cursor wins; a stale/forged
  // cursor (different object / field-set / verbosity) is rejected. The
  // fingerprint includes `verbosity` because detail vs summary changes a row's
  // byte size and therefore the truncation boundary.
  const TOOL = 'sfi.value_change_audit';
  const fingerprint = argsFingerprint({
    object,
    ...(resolvedFields !== undefined ? { fields: resolvedFields } : {}),
    verbosity,
  });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const limit = input.limit ?? MAX_ROWS;
  const paged = paginateLegacy(rows, {
    offset,
    limit,
    keyOf: (r) => r.fieldId,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
  });
  const shownRows = paged.items;
  // Keep `truncated` emitted unconditionally (existing golden field): true when
  // more rows remain past this page.
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  // summary is computed over the FULL `rows` (not the page) so per-severity
  // counts stay honest behind a truncated page.
  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of rows) summary[r.overallSeverity] += 1;

  // ONE shared helper, ONE shared family list. This tool and
  // `what_if_remove_picklist_value` answer the same coverage question about the
  // same field and used to disagree — two hand-copied lists and two near-duplicate
  // private formatters. Both now call `buildCoverageCaveat` with
  // `VALUE_LITERAL_READER_COVERAGE`, differing only in the subject noun phrase.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    VALUE_LITERAL_READER_COVERAGE,
    'Value-change audit completeness',
  );
  const confidence: ConfidenceLevel = rows.some((r) => r.topReasons.some((t) => t.startsWith('automation')))
    ? 'heuristic'
    : 'declared';

  return ok({
    data: {
      object,
      autoDetected,
      scannedFieldCount,
      rows: shownRows,
      truncated,
      summary,
      globalDisclosures: GLOBAL_DISCLOSURES,
      ...(notFound.length > 0 ? { notFound } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust: {
        provenance: 'offline_snapshot',
        confidence,
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
          ...(coverageCaveat !== undefined ? { missingCoverage: coverageCaveat.missingCoverage } : {}),
        },
        limitations: [DISCLOSURE, ...(coverageCaveat !== undefined ? [coverageCaveat.message] : [])],
      },
      disclosure: DISCLOSURE,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
