/**
 * Handler for the `sfi.cpq_quote_template_breakdown` MCP tool.
 *
 * The second of three v2.6a CPQ-specialist tools. Given a
 * CpqQuoteTemplate canonical id, returns the template's top-level
 * configuration (template content reference, format, landscape flag,
 * page-break behavior, active flag) plus a best-effort section list
 * derived from values whose `field` token begins with
 * `SBQQ__Section__c`.
 *
 * Honesty axis: v2.6a recognizes the template's top-level
 * configuration only. The full section / field mapping sub-records
 * (`SBQQ__TemplateSection__c`, `SBQQ__TemplateContent__c`) are NOT
 * extracted — the section list surfaced here is a best-effort
 * projection from the template's own values mirror. The boundary
 * disclosure surfaces verbatim.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

const CPQ_QUOTE_TEMPLATE_PREFIX = 'CpqQuoteTemplate:';

/**
 * Verbatim boundary disclosure per CpqSemantics.md §4.2.
 */
const TEMPLATE_BREAKDOWN_DISCLOSURE =
  'Full quote template section detail requires extracting ' +
  '`SBQQ__TemplateSection__c` and `SBQQ__TemplateContent__c` ' +
  'records, which v2.6a does NOT cover. The sections surfaced above ' +
  "are derived from the template's top-level values mirror; a " +
  'complete breakdown requires opening the template in the CPQ ' +
  'Quote Template Editor.';

/**
 * Field-name prefix the section walker matches against. Per
 * CpqSemantics.md §4.2 step 4 — fields whose `field` token starts
 * with `SBQQ__Section__c` surface as inferred section entries.
 */
const SECTION_FIELD_PREFIX = 'SBQQ__Section__c';

/**
 * Zod schema for the `sfi.cpq_quote_template_breakdown` tool input.
 * `templateId` is a required non-empty string; the prefix constraint
 * is enforced at the handler boundary.
 */
export const cpqQuoteTemplateBreakdownInputSchema = z.object({
  templateId: z.string().min(1),
});

/** Parsed input shape. */
export type CpqQuoteTemplateBreakdownInput = z.infer<
  typeof cpqQuoteTemplateBreakdownInputSchema
>;

/**
 * One inferred section entry. The `fieldName` is the source field
 * token (the values-mirror key that triggered the recognition); the
 * `reference` is the field's value verbatim, or the empty string when
 * the value is genuinely absent OR was withheld as masked — `isMasked`
 * is the only thing that distinguishes those two cases. Mirrors the
 * `isMasked` convention on `lookup-record.ts` / `explain-field.ts`:
 * the recognition layer detects masking explicitly and must not let
 * the empty-string placeholder erase that fact.
 */
export interface CpqQuoteTemplateSection {
  readonly fieldName: string;
  readonly reference: string;
  readonly isMasked: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CpqQuoteTemplateBreakdownOutput {
  readonly templateId: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  readonly active: boolean;
  readonly defaultTemplate: boolean;
  readonly templateContentReference: string | null;
  readonly documentFormat: string | null;
  readonly landscape: boolean;
  readonly pageBreakBefore: string | null;
  readonly sections: readonly CpqQuoteTemplateSection[];
  readonly disclosure: string;
}

/**
 * Pull a typed scalar out of the CPQ node's properties. Returns the
 * value when it matches the expected runtime type, the typed
 * fallback otherwise. Mirrors the v1.6 lookup_record handler's
 * defensive read pattern.
 */
const readStringProperty = (node: Node, key: string): string | null => {
  const raw = node.properties[key];
  return typeof raw === 'string' ? raw : null;
};

const readBooleanProperty = (node: Node, key: string): boolean =>
  node.properties[key] === true;

/**
 * Walk the template's values mirror for entries whose `field` begins
 * with the section field prefix. Each match becomes one section entry
 * with the source field name and the value's string form. Non-string
 * values are coerced to their string representation so the section
 * reference round-trips through JSON. Masked values are surfaced as
 * the empty string — the recognition layer MUST NOT fabricate a
 * masked value — but `isMasked: true` records the fact so the empty
 * string is never conflated with a genuinely blank/absent value.
 */
const readSections = (node: Node): readonly CpqQuoteTemplateSection[] => {
  const rawValues = node.properties['values'];
  if (!Array.isArray(rawValues)) return [];
  const sections: CpqQuoteTemplateSection[] = [];
  for (const entry of rawValues) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const fieldName = typeof obj['field'] === 'string' ? obj['field'] : '';
    if (!fieldName.startsWith(SECTION_FIELD_PREFIX)) continue;
    const isMasked = obj['isMasked'] === true;
    if (isMasked) {
      sections.push({ fieldName, reference: '', isMasked: true });
      continue;
    }
    const rawValue = obj['value'];
    const reference =
      rawValue === null || rawValue === undefined ? '' : String(rawValue);
    sections.push({ fieldName, reference, isMasked: false });
  }
  // Sort by field name for deterministic emission order.
  return sections.sort((a, b) =>
    a.fieldName < b.fieldName ? -1 : a.fieldName > b.fieldName ? 1 : 0,
  );
};

/**
 * The `sfi.cpq_quote_template_breakdown` MCP tool. Returns the
 * template's top-level configuration plus a best-effort section list.
 *
 * @example
 *   const r = await cpqQuoteTemplateBreakdownHandler(ctx, {
 *     templateId: 'CpqQuoteTemplate:SBQQ__QuoteTemplate__c.Standard',
 *   });
 *   if (r.ok) console.log(r.value.data.sections.length);
 */
export const cpqQuoteTemplateBreakdownHandler = async (
  ctx: Context,
  input: CpqQuoteTemplateBreakdownInput,
): Promise<
  Result<McpResponse<CpqQuoteTemplateBreakdownOutput>, McpError>
> => {
  if (!input.templateId.startsWith(CPQ_QUOTE_TEMPLATE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `templateId must start with '${CPQ_QUOTE_TEMPLATE_PREFIX}'; got '${input.templateId}'`,
      path: 'templateId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.templateId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.templateId, 'CpqQuoteTemplate'),
      path: input.templateId,
    });
  }
  if (node.type !== 'CpqQuoteTemplate') {
    return err({
      kind: 'component-not-found',
      message: `no CpqQuoteTemplate with id ${input.templateId}`,
      path: input.templateId,
    });
  }

  return ok({
    data: {
      templateId: node.id,
      apiName: node.apiName,
      label: node.label,
      active: readBooleanProperty(node, 'active'),
      defaultTemplate: readBooleanProperty(node, 'defaultTemplate'),
      templateContentReference: readStringProperty(
        node,
        'templateContentReference',
      ),
      documentFormat: readStringProperty(node, 'documentFormat'),
      landscape: readBooleanProperty(node, 'landscape'),
      pageBreakBefore: readStringProperty(node, 'pageBreakBefore'),
      sections: readSections(node),
      disclosure: TEMPLATE_BREAKDOWN_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
