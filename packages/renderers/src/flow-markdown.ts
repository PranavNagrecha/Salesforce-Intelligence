import type {
  ComponentId,
  Edge,
  EdgeType,
  Node,
  RendererError,
  RendererOutput,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import {
  escapeMarkdownBlockText,
  escapeMarkdownHeading,
  escapeMarkdownInline,
  renderValueAsBacktickedString,
} from './markdown-table.js';

// `label` and `description` are shown in the heading/description paragraph;
// the five trigger/status keys below are surfaced prominently in the Flow
// details bullet list. Listing any of them in the Properties table would
// duplicate content for readers and bloat the diff for editors.
const PROPERTIES_TABLE_EXCLUDED_KEYS = new Set([
  'description',
  'label',
  'status',
  'processType',
  'triggerObject',
  'triggerType',
  'recordTriggerType',
]);

// U+2014 em dash; used as the placeholder when a Flow details field is null
// or undefined. Declared as a constant so the source file remains readable
// and the byte choice (em dash, not en dash, not hyphen) is unambiguous.
const EM_DASH = '—';

const renderPropertiesTable = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  const keys = Object.keys(properties)
    .filter((k) => !PROPERTIES_TABLE_EXCLUDED_KEYS.has(k))
    .sort();
  const rows = keys.map((key) => `| ${key} | ${renderValueAsBacktickedString(properties[key])} |`);
  return ['## Properties', '', '| Key | Value |', '| --- | --- |', ...rows].join('\n');
};

// Format a Flow details field: backtick the value when it's a non-empty
// string; emit a bare em dash when null or undefined. We keep the rule
// simple — every value the Flow extractor emits is `string | null`, so we
// don't need to think about booleans or numbers here.
const formatFlowDetailValue = (value: unknown): string => {
  if (value === null || value === undefined) return EM_DASH;
  // escapeMarkdownInline returns the full fenced code span (fence included) —
  // it picks a fence long enough that an embedded backtick in a Flow detail
  // value (status, processType, triggerObject/type, recordTriggerType) can't
  // close it early and leak the tail into prose (CR-16c / CR-16d).
  return escapeMarkdownInline(String(value));
};

const renderFlowDetailsSection = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  // Always emit all five lines so the section layout is identical across
  // every Flow doc, even when the trigger fields are null (Auto-Launched
  // flows with no `<start>` block).
  const lines = [
    '## Flow details',
    '',
    `- **Status:** ${formatFlowDetailValue(properties['status'])}`,
    `- **Process type:** ${formatFlowDetailValue(properties['processType'])}`,
    `- **Trigger object:** ${formatFlowDetailValue(properties['triggerObject'])}`,
    `- **Trigger type:** ${formatFlowDetailValue(properties['triggerType'])}`,
    `- **Record trigger type:** ${formatFlowDetailValue(properties['recordTriggerType'])}`,
  ];
  return lines.join('\n');
};

// v0.1 stub copy. The italicized line tells readers that Flow semantic edges
// (callsApex, readsFrom, writesTo) aren't tracked yet — without it an empty
// "Incident edges" section reads as a bug.
const EMPTY_EDGES_STUB =
  '_No incident edges in this version. Flow semantic edges (callsApex, readsFrom, writesTo) are tracked in v0.2._';

/**
 * Render one direction's worth of edges of a single type into a subsection.
 * The `endpointIds` are the displayed (non-self) component ids in document
 * order, pre-zipped with their owning edges so the caller already decided
 * which endpoint to surface ("Source" for incoming, "Target" for outgoing).
 */
const renderEdgeSubsection = (
  edgeType: EdgeType,
  direction: 'incoming' | 'outgoing',
  rowsInput: readonly { readonly endpointId: ComponentId; readonly edge: Edge }[],
): string => {
  const sorted = [...rowsInput].sort((a, b) =>
    a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0,
  );
  const columnHeader = direction === 'incoming' ? 'Source' : 'Target';
  const rows = sorted.map(
    ({ endpointId, edge }) => `| \`${endpointId}\` | ${edge.confidence} | ${edge.source} |`,
  );
  return [
    `### ${edgeType} (${direction}, ${rowsInput.length})`,
    '',
    `| ${columnHeader} | Confidence | Producer |`,
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
};

const renderEdgesSection = (thisNodeId: ComponentId, edges: readonly Edge[]): string => {
  if (edges.length === 0) {
    return ['## Incident edges', '', EMPTY_EDGES_STUB].join('\n');
  }
  // Defensive path: in v0.1 Flow nodes carry zero edges, but the parameter
  // is part of the renderer contract for uniformity. If a caller does pass
  // edges, render them per the component-markdown pattern so the output
  // doesn't silently drop data.
  const grouped = new Map<EdgeType, Edge[]>();
  for (const edge of edges) {
    const existing = grouped.get(edge.edgeType);
    if (existing) {
      existing.push(edge);
    } else {
      grouped.set(edge.edgeType, [edge]);
    }
  }
  const sortedTypes = [...grouped.keys()].sort();
  const subsections: string[] = [];
  for (const edgeType of sortedTypes) {
    const group = grouped.get(edgeType) ?? [];
    // An edge is "incoming" iff it points AT this node from another node;
    // "outgoing" iff it points FROM this node to another node. A self-loop
    // (fromId === toId === thisNodeId) is classified as outgoing so each edge
    // appears exactly once.
    const incoming = group
      .filter((e) => e.toId === thisNodeId && e.fromId !== thisNodeId)
      .map((edge) => ({ endpointId: edge.fromId, edge }));
    const outgoing = group
      .filter((e) => e.fromId === thisNodeId)
      .map((edge) => ({ endpointId: edge.toId, edge }));
    // Render incoming before outgoing for readability — the architect persona
    // typically asks "who references me?" before "what do I reference?".
    if (incoming.length > 0) {
      subsections.push(renderEdgeSubsection(edgeType, 'incoming', incoming));
    }
    if (outgoing.length > 0) {
      subsections.push(renderEdgeSubsection(edgeType, 'outgoing', outgoing));
    }
  }
  return ['## Incident edges', ...subsections].join('\n\n');
};

const buildBody = (node: Node, edges: readonly Edge[]): string => {
  const blocks: string[] = [];
  // Block 1: top heading. label/apiName are free-text metadata — escape so a
  // newline or markdown special cannot inject structure (CR-16c). node.type is
  // a closed enum and is left raw.
  blocks.push(`# ${escapeMarkdownHeading(node.label ?? node.apiName)}`);
  // Block 2: API name + Type. Two trailing spaces on the API-name line
  // produce a Markdown line break, keeping both labels in one paragraph.
  // escapeMarkdownInline returns the full fenced code span (fence included,
  // adaptively sized) so an embedded backtick in apiName can't close it early.
  blocks.push(
    `**API Name:** ${escapeMarkdownInline(node.apiName)}  \n**Type:** ${node.type}`,
  );
  // Block 3 (optional): description paragraph. Escape line-leading structural
  // chars so the free-text prose cannot inject headings/tables/fences.
  const description = node.properties['description'];
  if (typeof description === 'string' && description.length > 0) {
    blocks.push(escapeMarkdownBlockText(description));
  }
  // Block 4: Flow details — the Flow-specific addition. Surfaces the four
  // identity-bearing fields (status, process type, trigger object/type,
  // record trigger type) at a glance, before the catch-all Properties
  // table.
  blocks.push(renderFlowDetailsSection(node.properties));
  // Block 5: Properties table (excluding the keys already shown above).
  blocks.push(renderPropertiesTable(node.properties));
  // Block 6: Incident edges section (stub in v0.1; real groups thereafter).
  blocks.push(renderEdgesSection(node.id, edges));
  return blocks.join('\n\n');
};

const buildFrontmatter = (node: Node): Readonly<Record<string, unknown>> => ({
  apiName: node.apiName,
  apiVersion: node.apiVersion,
  id: node.id,
  label: node.label,
  lastModifiedBy: node.lastModifiedBy,
  lastModifiedDate: node.lastModifiedDate,
  parentId: node.parentId,
  properties: node.properties,
  sourcePath: node.sourcePath,
  type: node.type,
});

const buildOutputPath = (node: Node): string => {
  // Flow nodes always have parentId: null in v0.1. The conditional matches
  // the component-markdown precedent so future Flow variants with a parent
  // (e.g., subflows) don't surprise this function.
  const parentSegment = node.parentId === null ? '' : node.parentId.replace(':', '/');
  return parentSegment === ''
    ? `components/${node.type}/${node.apiName}.md`
    : `components/${node.type}/${parentSegment}/${node.apiName}.md`;
};

/**
 * Render a Flow Node into a Markdown document with the four identity-bearing
 * Flow fields (status, process type, trigger object/type, record trigger
 * type) surfaced in a "Flow details" bullet list above the generic
 * Properties table.
 *
 * Synchronous and disk-free: Flow Markdown is fully derivable from
 * `node.properties` (the Flow extractor parses the `.flow-meta.xml` once;
 * the renderer doesn't re-read it). The `edges` parameter is part of the
 * renderer contract for uniformity — in v0.1 Flow nodes carry zero edges
 * and the section emits a stub note, but if a caller passes a non-empty
 * array the defensive branch renders them per the component pattern.
 *
 * @example
 *   const result = renderFlowMarkdown(flowNode, []);
 *   if (result.ok) {
 *     await writeFile(result.value.path, assembleDocument(result.value));
 *   }
 */
export const renderFlowMarkdown = (
  node: Node,
  edges: readonly Edge[],
): Result<RendererOutput, RendererError> => {
  try {
    return ok({
      path: buildOutputPath(node),
      frontmatter: buildFrontmatter(node),
      body: buildBody(node, edges),
    });
  } catch (cause) {
    return err({
      kind: 'render-failure',
      message: cause instanceof Error ? cause.message : String(cause),
      nodeId: node.id,
    });
  }
};
