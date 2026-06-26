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
  field.classification === 'sensitive';

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
 * Profiles/perm sets with BOTH object-level read on the parent object AND
 * FLS read on a regulated field — the combination a compliance reviewer cares
 * about (e.g. "Read Only" profile + EncryptedText SSN read).
 */
const findObjectFlsExposures = async (
  ctx: Context,
  field: PiiField,
  grantorIdsWithFlsRead: ReadonlySet<string>,
): Promise<readonly ObjectFlsExposure[]> => {
  const parentApi = parseFieldParentObjectApiName(field.id);
  if (parentApi === null || grantorIdsWithFlsRead.size === 0) return [];
  const parentObjectId = `CustomObject:${parentApi}` as ComponentId;
  const objectGrants = await listEdges(ctx.graph, parentObjectId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!objectGrants.ok) return [];
  const exposures: ObjectFlsExposure[] = [];
  for (const edge of objectGrants.value) {
    if (!grantorIdsWithFlsRead.has(edge.fromId)) continue;
    const access = objectAccessLabel(edge.properties);
    if (access === null) continue;
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok || grantorResult.value === null) continue;
    const grantor = grantorResult.value;
    exposures.push({
      fieldId: field.id,
      grantorId: grantor.id,
      grantorName: grantor.label ?? grantor.apiName,
      grantorType: grantor.type,
      objectAccess: access,
    });
  }
  return exposures;
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
    objectFlsExposures.push(...exposures);
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
  const categories = ['identifier', 'contact', 'financial', 'health'] as const;
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
    objectFlsBlock.push(
      '_(no profile/perm-set holds both object-level read (or View All) on the parent object AND FLS read on a regulated field in the audited set)_',
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
  ];

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
