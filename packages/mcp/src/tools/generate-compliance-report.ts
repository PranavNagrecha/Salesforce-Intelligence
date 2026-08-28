/**
 * Handler for the `sfi.generate_compliance_report` MCP tool.
 *
 * The v2.5 documentation-generation tier compliance-report tool.
 * Composes `sfi.pii_inventory` + `sfi.field_access_audit` (per PII
 * field, capped to keep response bounded) + per-object `sharingModel`
 * lookup into a structured markdown document covering the org's
 * compliance posture.
 *
 * Input: empty object (`z.object({})`).
 *
 * Output: `{ document: GeneratedDocument }`.
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
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
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
import { parseFieldParentObjectApiName } from './input-aliases.js';
import {
  collectPiiInventoryFields,
  type PiiField,
} from './pii-inventory.js';

/** Cap on the per-field audit fan-out — bounded response size. */
const MAX_AUDITED_FIELDS = 25;

/** Zod schema for the `sfi.generate_compliance_report` tool input. */
export const generateComplianceReportInputSchema = z.object({});

/** Parsed input shape. */
export type GenerateComplianceReportInput = z.infer<
  typeof generateComplianceReportInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateComplianceReportOutput {
  readonly document: GeneratedDocument;
}

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
  _input: GenerateComplianceReportInput,
): Promise<Result<McpResponse<GenerateComplianceReportOutput>, McpError>> => {
  const collected = await collectPiiInventoryFields(ctx, { classification: 'all' });
  if (!collected.ok) return err(collected.error);
  const { fields: allFields, summary: piiSummary } = collected.value;

  const regulatedFields = allFields.filter(
    (f) => f.classification === 'pii' || f.classification === 'sensitive',
  );
  const auditTargets = regulatedFields.slice(0, MAX_AUDITED_FIELDS);
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

  const execBlock = [
    '## Executive Summary',
    '',
    `Total classified fields: ${piiSummary.total.toString()}  `,
    `PII fields: ${(piiSummary.byClassification.pii ?? 0).toString()}  `,
    `Sensitive fields: ${(piiSummary.byClassification.sensitive ?? 0).toString()}  `,
    `Fields audited for access: ${auditEntries.length.toString()}  `,
    `Risk flags raised: ${riskFlags.length.toString()}  `,
    `Object+FLS exposure pairs: ${objectFlsExposures.length.toString()}`,
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
    const catFields = regulatedFields.filter((f) => f.category === cat);
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
    inventoryBlock.push('_(no fields classified as PII or sensitive)_');
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
      'Re-run `sfi.generate_compliance_report({})` after the next `sfi refresh`.',
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

  // Finding 33: the per-field access-audit fan-out is capped at
  // MAX_AUDITED_FIELDS to keep the response bounded — a fact previously
  // disclosed only in the tool description. Surface it IN the generated
  // document's boundaries[] whenever the cap actually bit, so a reader who
  // acts on this report knows the exposure pass is incomplete.
  if (regulatedFields.length > MAX_AUDITED_FIELDS) {
    boundaries.push(
      `Per-field access audit is CAPPED to the first ${MAX_AUDITED_FIELDS.toString()} of ${regulatedFields.length.toString()} regulated (PII/sensitive) fields to keep the response bounded — the remaining ${(regulatedFields.length - MAX_AUDITED_FIELDS).toString()} are listed in the inventory but were NOT access-audited here; narrow the scope (e.g. per object) to audit them.`,
    );
  }

  const componentIds: ComponentId[] = regulatedFields.map((f) => f.id);

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
    data: { document },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
