/**
 * Handler for the `sfi.generate_compliance_report` MCP tool.
 *
 * The v2.5 documentation-generation tier compliance-report tool.
 * Composes `sfi.pii_inventory` + `sfi.field_access_audit` (per PII
 * field, capped to keep response bounded) + per-object `sharingModel`
 * lookup into a structured markdown document covering the org's
 * compliance posture.
 *
 * Input: an OPTIONAL verified object scope (`objectApiName` / `object` /
 * `objectId` / `objectFilter` / a `CustomObject:` `componentId`) plus the
 * `limit` / `offset` / `cursor` paging knobs. `.strict()` — an unrecognized
 * key is REFUSED, never stripped.
 *
 * Output: `{ document, appliedScope?, pageInfo? }`.
 *
 * Honesty axis: every PII classification inherits the v2.0d recognizer's
 * heuristic confidence — a field flagged as `pii` here may not store
 * PII at runtime, and a field flagged as `public` may. The Boundaries
 * footer carries the recognizer-heuristic disclosure verbatim.
 *
 * Object + FLS exposure (F4/R2-2): a principal is flagged when it can reach the
 * parent object's records AND holds FLS read/edit on a regulated field. Object
 * reach is the UNION of an explicit object-permission grant edge and org-wide
 * god-mode (`ModifyAllData`/`ViewAllData` on `userPermissions`) — so a System
 * Administrator with no explicit object row is no longer missed. PSG-aggregated
 * / muting-permission god-mode is a disclosed gap (boundaries[]).
 *
 * COMPLIANCE-REPORT-SWALLOWED-ITS-SCOPE-AND-PRINTED-AN-UNREACHABLE-REMEDY.
 * Two compounding defects, both fixed here.
 *
 * (1) The input schema was `z.object({})` and the handler took `_input`, so
 *     zod silently STRIPPED every narrowing key a caller passed. Asking for one
 *     object's posture returned the ORG-WIDE document with no `appliedScope`,
 *     and an object name that exists in NO vault returned that same confident
 *     org-wide answer instead of refusing. The scope now routes through the
 *     shared `resolveExistingObjectScope` (R4) — verified against the graph,
 *     wrong-CASE tolerated, absent object refused as `invalid-query` — and a
 *     scoped call echoes `appliedScope` so it can never be read as org-wide.
 *
 * (2) Rendering EVERY regulated field into one document blew the per-document
 *     byte budget on a real org, and the shared fitter then dropped every
 *     readable section — PII Inventory, Field Access Audit, Sharing Model
 *     Exposure, Risk Flags, Object + FLS Exposure. What survived was a six-line
 *     summary plus a GENERIC truncation note advising a re-run with
 *     `objectFilter` / `objectApiName` / `personaFocus` / pagination /
 *     `format: "html"` — knobs this tool did not have. The tool was
 *     structurally incapable of emitting a single compliance finding while
 *     telling the reader to fix that with controls it did not own. The
 *     regulated set is now PAGED with the shared `paginate` (R2): the document
 *     fits, so the generic note never fires, and the tail is reachable through
 *     `pageInfo.nextCursor` / `offset` — knobs that DO exist.
 *
 * Coverage honesty: the per-field access audit, the Risk Flags pass and the
 * Object + FLS exposure pass all run over EXACTLY the regulated fields ON THIS
 * PAGE — one window, not three different caps. Their counts are therefore
 * page-bounded and the Executive Summary says so in the same sentence as the
 * number, so a zero is never readable as an org-wide checked zero.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { fieldAccessAuditHandler } from './field-access-audit.js';
import {
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  fitDocumentToBudget,
  generatedDocByteBudget,
  renderFooter,
  type GeneratedDocument,
} from './generate-data-dictionary.js';
import {
  parseFieldParentObjectApiName,
  resolveExistingObjectScope,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';
import {
  collectPiiInventoryFields,
  type PiiField,
} from './pii-inventory.js';

/** Tool name minting / validating this tool's continuation cursors. */
const COMPLIANCE_REPORT_TOOL = 'sfi.generate_compliance_report';

/**
 * Default page size over the regulated (PII/sensitive) field set. This is ALSO
 * the per-field access-audit fan-out: the audit, the risk-flag pass and the
 * Object + FLS pass all run over exactly this page, so the report has ONE
 * coverage window instead of three caps that disagreed. It replaces the old
 * `MAX_AUDITED_FIELDS` top-25 truncator, whose dropped tail was unreachable by
 * any argument the tool accepted.
 */
const DEFAULT_REGULATED_PAGE_LIMIT = 25;

/** Hard ceiling a caller may request for one page. */
const MAX_REGULATED_PAGE_LIMIT = 100;

/**
 * Byte budget the pager fits ONE page of regulated fields to. Deliberately far
 * under `generatedDocByteBudget()`: the rendered markdown (inventory table +
 * audit table) plus `frontmatter.componentIds` are all derived from this page,
 * so bounding the page bounds the document. Keeping the document under the
 * per-document budget is what stops the shared fitter from dropping every
 * readable section and printing a remedy this tool cannot honour.
 */
const REGULATED_PAGE_BYTE_BUDGET = 12_000;

/**
 * The object-alias keys the shared resolver reads. `objectFilter` is NOT one of
 * them, so it is folded into a free slot before the resolver runs (see
 * {@link foldObjectFilterAlias}).
 */
const OBJECT_ALIAS_KEYS = ['object', 'objectApiName', 'objectId'] as const;

/**
 * Zod schema for the `sfi.generate_compliance_report` tool input.
 *
 * `.strict()` — mirroring `sfi.apex_structure`. A mistyped or unsupported key
 * (`personaFocus`, `format`, …) is REFUSED with a named `invalid-query` rather
 * than silently dropped, because a silently ignored narrowing is worse than a
 * refusal: the caller has no signal that the scope they asked for never
 * applied, and the narrowing was the entire point of the re-run.
 */
export const generateComplianceReportInputSchema = z
  .object({
    /** Narrow the whole report to ONE object, verified against the vault. */
    objectApiName: z.string().min(1).optional(),
    /** Interchangeable object alias. */
    object: z.string().min(1).optional(),
    /** Interchangeable object alias. */
    objectId: z.string().min(1).optional(),
    /** Interchangeable object alias (the name the truncation remedy prints). */
    objectFilter: z.string().min(1).optional(),
    /** A `CustomObject:` id (or a bare api name); any other prefix is refused. */
    componentId: z.string().min(1).optional(),
    /** Regulated fields per page (default 25). */
    limit: z.number().int().min(1).max(MAX_REGULATED_PAGE_LIMIT).optional(),
    /** Resume offset into the regulated set. */
    offset: z.number().int().min(0).optional(),
    /** Opaque continuation token from a previous `pageInfo.nextCursor`. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

/** Parsed input shape. */
export type GenerateComplianceReportInput = z.infer<
  typeof generateComplianceReportInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateComplianceReportOutput {
  readonly document: GeneratedDocument;
  /**
   * Present ONLY on an object-scoped call — the canonical `CustomObject:` id
   * the report was narrowed to, in the vault's own casing. Absent on a bare
   * call, so a host can never read a scoped document as org-wide.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  /**
   * The page window over the regulated (PII/sensitive) field set this document
   * covers: `totalCount` regulated fields in scope, `returnedCount` on this
   * page, `hasMore`, and an opaque `nextCursor` to echo back as `cursor`. This
   * is the RESUME POINTER — without it the report's own advice to "re-run for
   * the dropped detail" named no reachable control.
   */
  readonly pageInfo?: PageInfo;
}

/** Strip a `CustomObject:` prefix and case-fold, for alias-agreement checks. */
const objectAliasKey = (raw: unknown): string =>
  String(raw).replace(/^CustomObject:/i, '').toLowerCase();

/**
 * Fold the `objectFilter` alias into one of the shared resolver's slots.
 *
 * `objectFilter` is the name the shared truncation note prints, and several
 * sibling generators accept it, but `resolveObjectAlias` reads only
 * `object` / `objectApiName` / `objectId` / `componentId`. Rather than add a
 * fourth divergent copy of the object-resolution predicate, the value is moved
 * into the first FREE alias slot so the shared resolver does all the work
 * (canonicalization, disagreement detection, vault verification).
 *
 * When every slot is already taken, the value is dropped ONLY if it agrees with
 * one of them; a disagreement is refused rather than silently discarded.
 */
const foldObjectFilterAlias = (
  input: GenerateComplianceReportInput,
): Result<Readonly<Record<string, unknown>>, McpError> => {
  const rest: Record<string, unknown> = { ...input };
  const filter = input.objectFilter;
  if (filter === undefined) return ok(rest);
  delete rest['objectFilter'];
  const free = OBJECT_ALIAS_KEYS.find((k) => rest[k] === undefined);
  if (free !== undefined) {
    rest[free] = filter;
    return ok(rest);
  }
  const agrees = OBJECT_ALIAS_KEYS.some(
    (k) => objectAliasKey(rest[k]) === objectAliasKey(filter),
  );
  if (agrees) return ok(rest);
  return err({
    kind: 'invalid-query',
    message:
      `\`objectFilter\` names a different object than the other object aliases ` +
      `(${filter}); pass exactly one of object / objectApiName / objectId / objectFilter / componentId`,
    path: 'objectFilter',
  });
};

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const isRegulatedPiiField = (field: PiiField): boolean =>
  field.type === 'EncryptedText' ||
  field.category === 'identifier' ||
  field.category === 'protected-class' ||
  field.classification === 'sensitive' ||
  field.classification === 'protected';

const objectAccessLabel = (
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  if (properties['viewAllRecords'] === true) return 'viewAllRecords';
  if (properties['modifyAllRecords'] === true) return 'modifyAllRecords';
  if (properties['allowRead'] === true) return 'allowRead';
  if (properties['allowEdit'] === true) return 'allowEdit';
  return null;
};

interface ObjectFlsExposure {
  readonly fieldId: ComponentId;
  readonly grantorId: ComponentId;
  readonly grantorName: string;
  readonly grantorType: string;
  readonly objectAccess: string;
}

/**
 * Map an org-wide system permission held by a grantor to its broader
 * object-access label. ModifyAllData is checked FIRST (it implies
 * read/edit/delete on every record of every object); ViewAllData maps to a
 * READ-level label only. Mirrors the EXACT sibling guard in
 * `who-can-access-object.ts` (lines 337-340) and `field-access-audit.ts`
 * (lines 580-584): `Array.isArray(perms) && perms.includes('ModifyAllData')`,
 * never a new divergent helper. Returns null when the grantor holds neither.
 */
const systemPermAccessLabel = (
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const perms = properties['userPermissions'];
  if (!Array.isArray(perms)) return null;
  if (perms.includes('ModifyAllData')) return 'ModifyAllData (system)';
  if (perms.includes('ViewAllData')) return 'ViewAllData (system)';
  return null;
};

/**
 * Profiles/perm sets with BOTH object-level access on the parent object AND
 * FLS read on a regulated field — the combination a compliance reviewer cares
 * about (e.g. "Read Only" profile + EncryptedText SSN read).
 *
 * F4/R2-2: object access is the UNION of two paths — (1) an explicit
 * `grantedBy` object-permission edge (allowRead/allowEdit/viewAll/modifyAll)
 * and (2) org-wide god-mode (ModifyAllData / ViewAllData) stored on the
 * grantor node's `properties.userPermissions`. A System Administrator with
 * ModifyAllData but NO explicit `<objectPermissions>` row for a custom object
 * STILL reaches its records, so the system-perm path is folded in here. Both
 * paths iterate ONLY `grantorIdsWithFlsRead` (grantors that already hold FLS
 * read/edit on the regulated field), so a god-mode principal with no FLS on
 * the field is never emitted (no over-report). The broader system label is
 * preferred when a grantor matches both paths.
 *
 * FAILS CLOSED (R1). Returns `Result` so a FAILED graph read propagates as
 * `err({ kind: 'internal' })` exactly like every sibling read in this handler
 * (the per-field access audit, the sharing-model `getNodeById`). An earlier
 * revision returned a bare array and swallowed a failed read into `[]`, which
 * rendered the section's all-clear sentence plus `Object+FLS exposure pairs: 0`
 * — a clean bill of health for a state that was never checked. An ABSENT node
 * ROW (`value === null`) is a different thing and is still tolerated with a
 * `continue`: that is the documented sparse-graph case, not a failed read.
 */
const findObjectFlsExposures = async (
  ctx: Context,
  field: PiiField,
  grantorIdsWithFlsRead: ReadonlySet<string>,
): Promise<Result<readonly ObjectFlsExposure[], McpError>> => {
  const parentApi = parseFieldParentObjectApiName(field.id);
  if (parentApi === null || grantorIdsWithFlsRead.size === 0) return ok([]);
  const parentObjectId = `CustomObject:${parentApi}` as ComponentId;
  const objectGrants = await listEdges(ctx.graph, parentObjectId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!objectGrants.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${objectGrants.error.message}`,
    });
  }
  // Track which FLS-read grantors we have already emitted via the edge path so
  // the system-perm pass below only adds grantors NOT matched by an edge.
  const emittedViaEdge = new Set<string>();
  const exposures: ObjectFlsExposure[] = [];
  for (const edge of objectGrants.value) {
    if (!grantorIdsWithFlsRead.has(edge.fromId)) continue;
    const access = objectAccessLabel(edge.properties);
    if (access === null) continue;
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${grantorResult.error.message}`,
      });
    }
    if (grantorResult.value === null) continue;
    const grantor = grantorResult.value;
    // Prefer the broader god-mode label when this grantor ALSO holds it.
    const sysLabel = systemPermAccessLabel(grantor.properties);
    emittedViaEdge.add(edge.fromId);
    exposures.push({
      fieldId: field.id,
      grantorId: grantor.id,
      grantorName: grantor.label ?? grantor.apiName,
      grantorType: grantor.type,
      objectAccess: sysLabel ?? access,
    });
  }
  // System-permission path: any FLS-read grantor holding org-wide god-mode that
  // was NOT already emitted via an object edge. getNodeById each, mirror the
  // sibling Array.isArray(perms).includes('ModifyAllData') guard.
  for (const grantorId of grantorIdsWithFlsRead) {
    if (emittedViaEdge.has(grantorId)) continue;
    const grantorResult = await getNodeById(ctx.graph, grantorId);
    if (!grantorResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${grantorResult.error.message}`,
      });
    }
    if (grantorResult.value === null) continue;
    const grantor = grantorResult.value;
    const sysLabel = systemPermAccessLabel(grantor.properties);
    if (sysLabel === null) continue;
    exposures.push({
      fieldId: field.id,
      grantorId: grantor.id,
      grantorName: grantor.label ?? grantor.apiName,
      grantorType: grantor.type,
      objectAccess: sysLabel,
    });
  }
  return ok(exposures);
};

/**
 * The `sfi.generate_compliance_report` MCP tool. Composes the PII
 * inventory + per-field access audit + per-object sharing model into
 * a single structured markdown document.
 */
export const generateComplianceReportHandler = async (
  ctx: Context,
  input: GenerateComplianceReportInput,
): Promise<Result<McpResponse<GenerateComplianceReportOutput>, McpError>> => {
  // ── Scope (R4) ─────────────────────────────────────────────────────────
  // Resolve the OPTIONAL object scope and VERIFY it exists, via the same
  // shared resolver `pii_inventory` / `flow_fault_audit` /
  // `flow_bulkification_audit` use. No `CustomObject:${name}` string coercion:
  // a typo, a name in the wrong CASE, and an object the refresh never
  // retrieved were all indistinguishable from a real one, and each produced a
  // confident answer. `unhandledPrefix: 'refuse'` because this tool has NO
  // reverse mode — a `componentId` carrying any other prefix must be named and
  // refused, never ignored into a silent org-wide answer.
  const scopeArgs = foldObjectFilterAlias(input);
  if (!scopeArgs.ok) return err(scopeArgs.error);
  const scopeResult = await resolveExistingObjectScope(ctx.graph, scopeArgs.value, {
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

  const collected = await collectPiiInventoryFields(ctx, {
    classification: 'all',
    ...(scope !== null ? { objectId: scope.componentId } : {}),
  });
  if (!collected.ok) return err(collected.error);
  const { fields: allFields, summary: piiSummary } = collected.value;

  const regulatedFields = allFields.filter(
    (f) => f.classification === 'pii' || f.classification === 'sensitive',
  );

  // ── Page (R2) ──────────────────────────────────────────────────────────
  // The regulated set is sorted to a TOTAL order by `collectPiiInventoryFields`
  // (classification, category, id — id unique), so a resume neither dups nor
  // skips. `limit`/`offset`/`cursor` are excluded from the fingerprint by
  // `argsFingerprint`: asking for a different PAGE of the same query is exactly
  // what a cursor is for, and a cursor minted org-wide can never be replayed
  // against a scoped call.
  const fingerprint = argsFingerprint(
    scope !== null ? { objectId: scope.componentId } : {},
  );
  let pageOffset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: COMPLIANCE_REPORT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    pageOffset = decoded.value.o;
  }
  const paged = paginate(regulatedFields, {
    offset: pageOffset,
    limit: input.limit ?? DEFAULT_REGULATED_PAGE_LIMIT,
    byteBudget: REGULATED_PAGE_BYTE_BUDGET,
    keyOf: (f) => f.id,
    binding: {
      tool: COMPLIANCE_REPORT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  // ONE window for every downstream pass — the inventory table, the access
  // audit, the risk flags and the Object + FLS exposure all cover exactly these
  // fields, so no section can claim a coverage another section does not have.
  const auditTargets = paged.items;
  type AuditEntry = {
    readonly fieldId: ComponentId;
    readonly fieldLabel: string;
    readonly classification: string;
    readonly category: string;
    readonly type: string;
    readonly profilesWithRead: number;
    readonly profilesWithEdit: number;
    readonly permSetsWithRead: number;
    readonly permSetsWithEdit: number;
    readonly flsReadGrantorIds: ReadonlySet<string>;
  };
  const auditEntries: AuditEntry[] = [];
  for (const field of auditTargets) {
    const auditResult = await fieldAccessAuditHandler(ctx, {
      fieldId: field.id,
    });
    if (!auditResult.ok) {
      if (auditResult.error.kind === 'component-not-found') continue;
      return err(auditResult.error);
    }
    const a = auditResult.value.data;
    const flsReadGrantorIds = new Set(
      a.grants
        .filter((g) => g.permission === 'read' || g.permission === 'edit')
        .map((g) => g.grantorId),
    );
    auditEntries.push({
      fieldId: field.id,
      fieldLabel: field.label,
      classification: field.classification,
      category: field.category,
      type: field.type,
      profilesWithRead: a.summary.profilesWithRead,
      profilesWithEdit: a.summary.profilesWithEdit,
      permSetsWithRead: a.summary.permSetsWithRead,
      permSetsWithEdit: a.summary.permSetsWithEdit,
      flsReadGrantorIds,
    });
  }

  const objectFlsExposures: ObjectFlsExposure[] = [];
  for (const entry of auditEntries) {
    const field = auditTargets.find((f) => f.id === entry.fieldId);
    if (field === undefined || !isRegulatedPiiField(field)) continue;
    const exposures = await findObjectFlsExposures(
      ctx,
      field,
      entry.flsReadGrantorIds,
    );
    if (!exposures.ok) return err(exposures.error);
    objectFlsExposures.push(...exposures.value);
  }

  const sharingMap = new Map<string, string>();
  for (const field of auditTargets) {
    const objectApiName = parseFieldParentObjectApiName(field.id);
    if (objectApiName === null || sharingMap.has(objectApiName)) continue;
    const objNodeResult = await getNodeById(
      ctx.graph,
      `CustomObject:${objectApiName}`,
    );
    if (!objNodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${objNodeResult.error.message}`,
      });
    }
    const objNode: Node | null = objNodeResult.value;
    if (objNode === null) continue;
    const owd = objNode.properties['sharingModel'];
    sharingMap.set(
      objectApiName,
      typeof owd === 'string' && owd.length > 0 ? owd : 'Unknown',
    );
  }

  const RISK_GRANT_THRESHOLD = 3;
  const riskFlags = auditEntries.filter(
    (e) =>
      e.classification === 'pii' &&
      e.profilesWithRead + e.permSetsWithRead >= RISK_GRANT_THRESHOLD,
  );

  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();
  const title = 'Compliance Posture Report';

  // The page window, stated once and reused by every coverage sentence below.
  const regulatedTotal = regulatedFields.length;
  const pageFrom = regulatedTotal === 0 ? 0 : pageOffset + 1;
  const pageTo = pageOffset + auditTargets.length;
  // Read on EVERY page-bounded count: it is what turns "0" from a claim about
  // the org into a claim about the fields this document actually examined.
  const pageQualifier =
    `over the ${auditEntries.length.toString()} field(s) access-audited on this page ` +
    `of ${regulatedTotal.toString()} regulated`;
  const scopeLine =
    scope !== null
      ? `Scope: \`${escapeCell(scope.componentId)}\` — every count below is for THIS OBJECT ONLY, not the org.  `
      : 'Scope: org-wide (every object in this vault).  ';
  const nextPageLine = paged.pageInfo.hasMore
    ? `More regulated fields remain (${regulatedTotal.toString()} in scope). Re-run with ` +
      '`cursor` set to `pageInfo.nextCursor` for the next page, or narrow with ' +
      '`objectApiName` / `objectFilter` to report on one object.  '
    : 'This page covers every regulated field in scope. Narrow with `objectApiName` / ' +
      '`objectFilter` to report on one object.  ';

  const execBlock = [
    '## Executive Summary',
    '',
    scopeLine,
    `Total classified fields: ${piiSummary.total.toString()}  `,
    `PII fields: ${(piiSummary.byClassification.pii ?? 0).toString()}  `,
    `Sensitive fields: ${(piiSummary.byClassification.sensitive ?? 0).toString()}  `,
    `Regulated (PII/sensitive) fields in scope: ${regulatedTotal.toString()}  `,
    // An empty page (an `offset` past the end) must say so rather than render
    // an inverted "N\u2013N-1 of M" range that reads like a real window.
    auditTargets.length === 0 && regulatedTotal > 0
      ? `This document covers NO regulated fields — offset ${pageOffset.toString()} is past the end of the ${regulatedTotal.toString()} in scope; re-run without \`offset\`/\`cursor\`.  `
      : `This document covers regulated fields ${pageFrom.toString()}\u2013${pageTo.toString()} of ${regulatedTotal.toString()}.  `,
    `Fields audited for access: ${auditEntries.length.toString()}  `,
    // NOT bare numbers: each is page-bounded, and the qualifier travels in the
    // same sentence so a zero can never be lifted out as an org-wide finding.
    `Risk flags raised: ${riskFlags.length.toString()} (${pageQualifier})  `,
    `Object+FLS exposure pairs: ${objectFlsExposures.length.toString()} (${pageQualifier})  `,
    nextPageLine,
  ].join('\n');

  const inventoryBlock: string[] = ['## PII Inventory by Category', ''];
  const categories = [
    'protected-class',
    'identifier',
    'contact',
    'financial',
    'health',
  ] as const;
  for (const cat of categories) {
    // The PAGE, not the whole regulated set: rendering every regulated field
    // into one document is what blew the byte budget and got every readable
    // section dropped.
    const catFields = auditTargets.filter((f) => f.category === cat);
    if (catFields.length === 0) continue;
    inventoryBlock.push(`### ${cat}`);
    inventoryBlock.push('');
    inventoryBlock.push('| Field | Classification | Reason |');
    inventoryBlock.push('| --- | --- | --- |');
    for (const f of catFields) {
      inventoryBlock.push(
        `| \`${escapeCell(f.id)}\` | ${f.classification} | ${escapeCell(f.reason)} |`,
      );
    }
    inventoryBlock.push('');
  }
  if (inventoryBlock.length === 2) {
    inventoryBlock.push(
      regulatedTotal === 0
        ? '_(no fields classified as PII or sensitive in scope)_'
        : `_(no PII/sensitive fields on this page fall in a listed category; ${regulatedTotal.toString()} regulated fields are in scope)_`,
    );
  }

  const auditBlock: string[] = ['## Field Access Audit', ''];
  if (auditEntries.length === 0) {
    auditBlock.push('_(no PII/sensitive fields surfaced; audit fan-out skipped)_');
  } else {
    auditBlock.push(
      '| Field | Classification | Profiles (read/edit) | PermSets (read/edit) |',
    );
    auditBlock.push('| --- | --- | --- | --- |');
    for (const e of auditEntries) {
      auditBlock.push(
        `| \`${escapeCell(e.fieldId)}\` | ${e.classification} | ${e.profilesWithRead.toString()}/${e.profilesWithEdit.toString()} | ${e.permSetsWithRead.toString()}/${e.permSetsWithEdit.toString()} |`,
      );
    }
  }

  const sharingBlock: string[] = ['## Sharing Model Exposure', ''];
  if (sharingMap.size === 0) {
    sharingBlock.push('_(no parent objects to summarise)_');
  } else {
    sharingBlock.push('| Object | OWD |');
    sharingBlock.push('| --- | --- |');
    const sortedSharing = [...sharingMap.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [obj, owd] of sortedSharing) {
      sharingBlock.push(`| \`${escapeCell(obj)}\` | ${escapeCell(owd)} |`);
    }
  }

  const riskBlock: string[] = ['## Risk Flags', ''];
  if (riskFlags.length === 0) {
    riskBlock.push(
      '_(no risk flags raised — PII fields had fewer than the threshold grants)_',
    );
  } else {
    riskBlock.push('| Field | Total read grants | Note |');
    riskBlock.push('| --- | --- | --- |');
    for (const r of riskFlags) {
      const total = r.profilesWithRead + r.permSetsWithRead;
      riskBlock.push(
        `| \`${escapeCell(r.fieldId)}\` | ${total.toString()} | PII field with ${total.toString()} read grants |`,
      );
    }
  }

  const objectFlsBlock: string[] = ['## Object + FLS Exposure', ''];
  if (objectFlsExposures.length === 0) {
    // Emitted only AFTER the system-perm (ModifyAllData/ViewAllData) path has
    // been checked alongside the object-edge path — god-mode is folded in.
    objectFlsBlock.push(
      '_(no profile/perm-set holds object-level access — via an object grant or org-wide ModifyAllData/ViewAllData — AND FLS read on a regulated field in the audited set)_',
    );
  } else {
    objectFlsBlock.push(
      '| Field | Principal | Object access | Note |',
    );
    objectFlsBlock.push('| --- | --- | --- | --- |');
    for (const row of objectFlsExposures) {
      objectFlsBlock.push(
        `| \`${escapeCell(row.fieldId)}\` | ${escapeCell(row.grantorType)}:${escapeCell(row.grantorName)} | ${row.objectAccess} | Can reach parent records AND has FLS read on this field — verify encrypted/identifier exposure |`,
      );
    }
  }

  const body = [
    `# ${title}`,
    '',
    execBlock,
    '',
    inventoryBlock.join('\n'),
    '',
    auditBlock.join('\n'),
    '',
    sharingBlock.join('\n'),
    '',
    riskBlock.join('\n'),
    '',
    objectFlsBlock.join('\n'),
    '',
    renderFooter(
      refreshedAt,
      // Names ONLY arguments this tool actually accepts. The previous hint said
      // to re-run with `{}` — empty args — while the shared truncation note two
      // paragraphs above told the reader to pass a scope, so the document
      // contradicted itself and neither instruction was constructible.
      'Re-run `sfi.generate_compliance_report({})` for the org-wide page, ' +
        '`{ objectApiName: "<Object__c>" }` to scope it to one object, or ' +
        '`{ cursor: "<pageInfo.nextCursor>" }` for the next page of regulated ' +
        'fields. Re-run after the next `sfi refresh` for fresh data.',
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'Executive Summary': 'declared',
    'PII Inventory by Category': 'heuristic',
    'Field Access Audit': 'declared',
    'Sharing Model Exposure': 'declared',
    'Risk Flags': 'heuristic',
    'Object + FLS Exposure': 'heuristic',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'PII classifications inherit the v2.0d recognizer heuristic — fields flagged here may not contain PII at runtime, and unflagged fields may.',
    'Dynamic Apex and runtime SOQL strings are invisible to the access-audit — the recognizer cannot trace reflective field access.',
    'Object+FLS exposure pairs flag principals with BOTH parent-object access and field-level read on regulated fields — cross-check with `sfi.who_can_access_object` and `sfi.field_access_audit`.',
    'Object+FLS exposure now folds in org-wide god-mode: a Profile/PermissionSet holding `ModifyAllData` or `ViewAllData` (on `userPermissions`) reaches every record even with NO explicit object-permission row, so it is reported whenever it ALSO holds FLS read/edit on a regulated field. ViewAllData maps to read-level only.',
    'DISCLOSED GAP: god-mode granted via a Permission Set GROUP or a muting permission set is NOT resolved here — the vault models `userPermissions` on Profile/PermissionSet nodes only; PSG aggregation / muting is not folded into this exposure pass.',
  ];

  // The scope, stated as a typed disclosure a machine consumer cannot skip.
  boundaries.push(
    scope !== null
      ? `OBJECT-SCOPED: every count and table in this document covers ONLY ${scope.componentId}. It is NOT an org-wide compliance posture; re-run with no object argument for that.`
      : 'ORG-WIDE SCOPE: counts cover every object in this vault. Pass `objectApiName` / `objectFilter` to scope the report to one object.',
  );
  // What this page did NOT examine, named with the control that reaches it.
  // The previous disclosure said the audit was "CAPPED to the first 25" and
  // told the reader to "narrow the scope (e.g. per object)" — advice the tool
  // could not accept, on a tail no argument could reach.
  boundaries.push(
    paged.pageInfo.hasMore
      ? `PAGE-BOUNDED: the access audit, the Risk Flags pass and the Object + FLS exposure pass ran over ONLY the ${auditEntries.length.toString()} regulated field(s) on this page (${pageFrom.toString()}\u2013${pageTo.toString()} of ${regulatedTotal.toString()} in scope). A zero in those sections is a zero FOR THIS PAGE, not for the org. The remaining ${(regulatedTotal - pageTo).toString()} are reachable: re-run with \`cursor\` set to this response's \`pageInfo.nextCursor\`, or with \`offset\` / \`limit\`.`
      : `PAGE COMPLETE: this page covers all ${regulatedTotal.toString()} regulated field(s) in scope, so the access audit, Risk Flags and Object + FLS sections cover the whole scoped set. \`pageInfo.nextCursor\` is null.`,
  );

  // Provenance for what this DOCUMENT covers — the page, not the whole
  // regulated population. Listing ids the body never rendered read as coverage
  // the report did not have.
  const componentIds: ComponentId[] = auditTargets.map((f) => f.id);

  const document: GeneratedDocument = fitDocumentToBudget(
    {
      frontmatter: {
        title,
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
    data: {
      // appliedScope FIRST and only when scoped, mirroring the sibling shape:
      // a bare call omits the whole block, i.e. the org-wide reading.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      document,
      pageInfo: paged.pageInfo,
    },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
