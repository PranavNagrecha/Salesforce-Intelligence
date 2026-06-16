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

  const document: GeneratedDocument = {
    frontmatter: {
      title: `${objectLabel} — Data Dictionary`,
      generatedAt,
      sourceTreeHash,
      componentIds,
    },
    body,
    sectionConfidence,
    boundaries,
  };

  return ok({
    data: { document },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
