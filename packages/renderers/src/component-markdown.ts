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
import { serializeFrontmatter } from './yaml-frontmatter.js';

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
  // escapeMarkdownInline returns the full fenced code span (fence included,
  // adaptively sized) so an embedded backtick in apiName can't close it early.
  blocks.push(
    `**API Name:** ${escapeMarkdownInline(node.apiName)}  \n**Type:** ${node.type}`,
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

const isFrontmatterScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isFrontmatterPlainObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * JSON-encode a value into a single frontmatter-safe scalar string. Used only
 * for sub-values too deep for the YAML frontmatter serializer (see
 * {@link toFrontmatterSafeMapValue}); the encoded string preserves the full
 * structure, so no data is dropped. Falls back to `String()` for the rare
 * value `JSON.stringify` cannot encode (e.g. a bare `undefined`).
 */
const toFrontmatterScalar = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  return typeof encoded === 'string' ? encoded : String(value);
};

/**
 * Sanitize a value sitting in a MAP position (a frontmatter key's value, or a
 * nested-map field): scalars pass through untouched, nested maps recurse, and
 * arrays are handed to {@link toFrontmatterSafeArray}. Nested maps may nest to
 * any depth — the serializer handles map recursion — so only the array branch
 * enforces the depth ceiling.
 */
const toFrontmatterSafeMapValue = (value: unknown): unknown => {
  if (isFrontmatterScalar(value)) return value;
  if (Array.isArray(value)) return toFrontmatterSafeArray(value);
  if (isFrontmatterPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = toFrontmatterSafeMapValue(value[key]);
    }
    return out;
  }
  // Functions / symbols / bigint / undefined are not YAML scalars.
  return toFrontmatterScalar(value);
};

/**
 * Sanitize a value sitting in an ARRAY position, mirroring exactly the array
 * shapes {@link serializeFrontmatter} accepts. An all-scalar array is kept
 * verbatim; an all-object array keeps each field that is a scalar or an inner
 * array of scalars, and JSON-encodes any field that is a nested object or an
 * array holding objects/arrays (the depth-4 ceiling — e.g. an ApprovalProcess
 * `steps[].approvers` list of `{ name, type }` objects). A mixed or
 * nested-array shape is JSON-encoded whole. This is a serialize-identical
 * transform for every shape the serializer already accepts, so it only ever
 * changes output that would otherwise have thrown.
 */
const toFrontmatterSafeArray = (items: readonly unknown[]): unknown => {
  if (items.length === 0) return items;
  if (items.every(isFrontmatterScalar)) return items;
  if (items.every(isFrontmatterPlainObject)) {
    return items.map((item) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        const fieldValue = item[key];
        if (isFrontmatterScalar(fieldValue)) {
          out[key] = fieldValue;
        } else if (Array.isArray(fieldValue) && fieldValue.every(isFrontmatterScalar)) {
          out[key] = fieldValue;
        } else {
          out[key] = toFrontmatterScalar(fieldValue);
        }
      }
      return out;
    });
  }
  // Mixed scalars+objects, nested arrays, or class instances: encode whole.
  return toFrontmatterScalar(items);
};

/**
 * Guarantee the frontmatter serializes under the YAML frontmatter depth ceiling
 * (APPROVAL-PROCESS-STEPS-BREAK-VAULT-RENDER). The generic frontmatter mirrors
 * `node.properties` verbatim, but an extractor can legitimately emit a property
 * shape deeper than the serializer's depth-4 array-of-objects ceiling — e.g. an
 * ApprovalProcess `steps[]` whose `approvers` / `approvalActions` are themselves
 * arrays of `{ name, type }` objects. Serializing that shape throws and
 * hard-fails the WHOLE vault render (a refresh abort), leaving every component's
 * markdown stale relative to the graph.
 *
 * Fast path is byte-identical: if the frontmatter already serializes, it is
 * returned untouched, so every currently-rendering component's bytes are
 * unchanged. Only when serialization throws is the frontmatter projected into a
 * frontmatter-safe shape, JSON-encoding any sub-value past the ceiling into a
 * scalar string. No data is dropped — the encoded string carries the full
 * structure, and the graph node (what `get_component` returns) keeps the
 * original typed `properties` object untouched.
 */
const ensureSerializableFrontmatter = (
  frontmatter: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  try {
    serializeFrontmatter(frontmatter);
    return frontmatter;
  } catch {
    return toFrontmatterSafeMapValue(frontmatter) as Readonly<
      Record<string, unknown>
    >;
  }
};

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
      frontmatter: ensureSerializableFrontmatter(buildFrontmatter(node)),
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
