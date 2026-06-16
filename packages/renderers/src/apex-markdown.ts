import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

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

import { renderValueAsBacktickedString } from './markdown-table.js';

// Apex bodies frequently exceed a thousand lines. Embedding the full source
// would bloat the Markdown diff and overwhelm Obsidian; truncating to the
// first 500 lines preserves the class header and a representative sample
// while keeping a pointer to the on-disk file for the long tail.
const APEX_SOURCE_MAX_LINES = 500;

// `label` is already rendered in the top heading and `description` in its
// own paragraph; including either in the Properties table would duplicate
// content for readers and bloat the diff for editors. Kept in sync with the
// component-markdown renderer's identical exclusion list.
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

const renderSourceSection = (source: string, sourcePath: string): string => {
  // `split('\n')` gives us a stable logical line view for both truncation
  // detection and slicing. A trailing newline in `source` produces a final
  // empty entry; this is acceptable because the closing fence sits on its
  // own line below either way.
  const lines = source.split('\n');
  const visibleLines = lines.slice(0, APEX_SOURCE_MAX_LINES);
  const pointer =
    lines.length > APEX_SOURCE_MAX_LINES
      ? [`... [source truncated; ${lines.length} total lines. See ${sourcePath} for full text.]`]
      : [];
  return ['## Source', '', '```apex', ...visibleLines, ...pointer, '```'].join('\n');
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

const buildBody = (node: Node, edges: readonly Edge[], source: string): string => {
  const blocks: string[] = [];
  // Block 1: top heading.
  blocks.push(`# ${node.label ?? node.apiName}`);
  // Block 2: API name + Type. Two trailing spaces on the API-name line
  // produce a Markdown line break, keeping both labels in one paragraph.
  blocks.push(`**API Name:** \`${node.apiName}\`  \n**Type:** ${node.type}`);
  // Block 3 (optional): description paragraph.
  const description = node.properties['description'];
  if (typeof description === 'string' && description.length > 0) {
    blocks.push(description);
  }
  // Block 4: Properties table.
  blocks.push(renderPropertiesTable(node.properties));
  // Block 5: Source section — the Apex-specific addition.
  blocks.push(renderSourceSection(source, node.sourcePath));
  // Block 6: Incident edges section.
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
  return parentSegment === ''
    ? `components/${node.type}/${node.apiName}.md`
    : `components/${node.type}/${parentSegment}/${node.apiName}.md`;
};

/**
 * Render an ApexClass or ApexTrigger Node into a Markdown document, embedding
 * the on-disk source file as a fenced `apex` code block.
 *
 * Unlike the component renderer, this function performs I/O: it reads the
 * `.cls` or `.trigger` file at `node.sourcePath` from disk. Source bodies
 * longer than 500 lines are truncated, with a pointer line referencing the
 * full source. The returned `RendererOutput.body` is deterministic for a
 * given (Node, edges, on-disk source) triple.
 *
 * @example
 *   const result = await renderApexMarkdown(apexNode, edges);
 *   if (result.ok) {
 *     await writeFile(result.value.path, assembleDocument(result.value));
 *   } else if (result.error.kind === 'render-failure') {
 *     console.error('Could not read', result.error.message);
 *   }
 */
export const renderApexMarkdown = async (
  node: Node,
  edges: readonly Edge[],
  sourceBaseDir?: string,
): Promise<Result<RendererOutput, RendererError>> => {
  // `node.sourcePath` is stored vault-relative (privacy + portability). When a
  // base dir is supplied, resolve the READ against it; the relative path is
  // preserved verbatim in the frontmatter (which is client-facing via
  // sfi.get_component), so nothing leaks an absolute local path.
  const readPath =
    sourceBaseDir !== undefined && !isAbsolute(node.sourcePath)
      ? join(sourceBaseDir, node.sourcePath)
      : node.sourcePath;
  let source: string;
  try {
    source = await readFile(readPath, 'utf-8');
  } catch {
    // We deliberately discard the underlying error; the contract only carries
    // a `message`, and the path is the actionable piece for callers.
    return err({
      kind: 'render-failure',
      message: `cannot read sourcePath: ${node.sourcePath}`,
      nodeId: node.id,
    });
  }
  try {
    return ok({
      path: buildOutputPath(node),
      frontmatter: buildFrontmatter(node),
      body: buildBody(node, edges, source),
    });
  } catch (cause) {
    return err({
      kind: 'render-failure',
      message: cause instanceof Error ? cause.message : String(cause),
      nodeId: node.id,
    });
  }
};
