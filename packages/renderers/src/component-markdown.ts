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

// `label` is already rendered in the top heading and `description` in its
// own paragraph; including either in the Properties table would duplicate
// content for readers and bloat the diff for editors.
const PROPERTIES_TABLE_EXCLUDED_KEYS = new Set(['description', 'label']);

const renderPropertiesTable = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  const keys = Object.keys(properties)
    .filter((k) => !PROPERTIES_TABLE_EXCLUDED_KEYS.has(k))
    .sort();
  const rows = keys.map((key) => `| ${key} | ${renderValueAsBacktickedString(properties[key])} |`);
  return ['## Properties', '', '| Key | Value |', '| --- | --- |', ...rows].join('\n');
};

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
  // Group by edge type. Use a Map so insertion order is irrelevant; we sort
  // the keys before emitting.
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
  // apiName is escaped inside its code span so a backtick can't close it early.
  blocks.push(
    `**API Name:** \`${escapeMarkdownInline(node.apiName)}\`  \n**Type:** ${node.type}`,
  );
  // Block 3 (optional): description paragraph. The description is shown
  // here instead of in the Properties table. Escape line-leading structural
  // chars so the free-text prose cannot inject headings/tables/fences.
  const description = node.properties['description'];
  if (typeof description === 'string' && description.length > 0) {
    blocks.push(escapeMarkdownBlockText(description));
  }
  // Block 4: Properties table.
  blocks.push(renderPropertiesTable(node.properties));
  // Block 5: Incident edges section.
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
  const parentSegment = node.parentId === null ? '' : node.parentId.replace(':', '/');
  // When the node has no parent the parent segment is empty and we want
  // `components/{type}/{apiName}.md`. With a parent the path expands to
  // `components/{type}/{parent-type}/{parent-name}/{apiName}.md`.
  return parentSegment === ''
    ? `components/${node.type}/${node.apiName}.md`
    : `components/${node.type}/${parentSegment}/${node.apiName}.md`;
};

/**
 * Render a component Node and its incident edges into a Markdown document.
 *
 * The output is a pure function of the input: same Node + same Edges always
 * produce the same `RendererOutput`. The caller is responsible for writing
 * the result to disk; the renderer never touches the filesystem.
 *
 * The returned `frontmatter` should be serialized via `serializeFrontmatter`
 * to obtain a YAML body, then wrapped as
 * `'---\\n' + frontmatter + '\\n---\\n\\n' + body + '\\n'` to produce the
 * complete document.
 *
 * @example
 *   const result = renderComponentMarkdown(node, edges);
 *   if (result.ok) {
 *     await writeFile(result.value.path, assembleDocument(result.value));
 *   }
 */
export const renderComponentMarkdown = (
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
