import type {
  ComponentType,
  Node,
  RendererError,
  RendererOutput,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import { escapeMarkdownInline } from './markdown-table.js';

// The relative path of the index file under the vault root. Co-located with
// the per-component directories so links in the body can be relative to the
// index's own directory (`./{Type}/.../{apiName}.md`).
const INDEX_OUTPUT_PATH = 'components/index.md';

// Stamped into the index's frontmatter so downstream tooling and humans can
// tell at a glance which generator produced this file. Kept distinct from
// the per-component frontmatter (which carries the Node's own fields).
const GENERATED_BY = 'sf-intelligence-vault-index';

// URL-encode a single path segment without touching `/` separators. Apply
// per-segment rather than to the joined path so the path structure survives
// encoding even when segments contain spaces or other URL-significant chars
// (e.g., Profile names like `System Administrator`).
const encodePathSegment = (segment: string): string => encodeURIComponent(segment);

// Compute the link target for `node` relative to the index file. Mirrors the
// path scheme of `component-markdown`, `apex-markdown`, and `flow-markdown`
// (`components/{type}/{parent-segment}/{apiName}.md`) and converts each
// path segment via `encodeURIComponent` so spaces and other URL-significant
// chars in apiNames or parent ids render as `%20` etc. The leading `./`
// roots the link in the index file's own directory.
const buildLinkTarget = (node: Node): string => {
  const segments: string[] = [node.type];
  if (node.parentId !== null) {
    // parentId is `{ParentType}:{ParentApiName}` — split on the first colon
    // and keep both halves as separate segments so each is encoded on its
    // own. A literal colon in the joined path would itself need encoding
    // and would break round-tripping for Obsidian.
    const colonIndex = node.parentId.indexOf(':');
    if (colonIndex === -1) {
      segments.push(node.parentId);
    } else {
      segments.push(node.parentId.slice(0, colonIndex));
      segments.push(node.parentId.slice(colonIndex + 1));
    }
  }
  segments.push(`${node.apiName}.md`);
  return `./${segments.map(encodePathSegment).join('/')}`;
};

// Display text for a node in the index — falls back to apiName when label
// is null so the bullet is never blank. Mirrors the heading-fallback rule
// in `component-markdown` (heading uses `label ?? apiName`). The label is
// free-text metadata, so it is inline-escaped (CR-16c): a newline would
// otherwise split the bullet and the trailing fragment could be parsed as a
// new list item / heading / table row.
const renderNodeDisplayLabel = (node: Node): string =>
  escapeMarkdownInline(node.label ?? node.apiName);

// Build the bullet line for one node. The link text is the canonical id in
// backticks (so it survives copy-paste into other Markdown tools without
// being interpreted as bold/italic). The em dash with spaces separates the
// link from the human-readable label.
const renderNodeBullet = (node: Node): string =>
  `- [\`${node.id}\`](${buildLinkTarget(node)}) — ${renderNodeDisplayLabel(node)}`;

const groupNodesByType = (nodes: readonly Node[]): Map<ComponentType, Node[]> => {
  const grouped = new Map<ComponentType, Node[]>();
  for (const node of nodes) {
    const existing = grouped.get(node.type);
    if (existing) {
      existing.push(node);
    } else {
      grouped.set(node.type, [node]);
    }
  }
  return grouped;
};

const renderTypeSection = (type: ComponentType, nodesOfType: readonly Node[]): string => {
  const sortedNodes = [...nodesOfType].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const bullets = sortedNodes.map(renderNodeBullet);
  return [`## ${type} (${nodesOfType.length})`, '', ...bullets].join('\n');
};

const buildSummaryLine = (totalNodes: number, totalTypes: number): string =>
  `This is the index for the Salesforce org's knowledge vault. ${totalNodes} components across ${totalTypes} types are indexed below.`;

const buildBody = (nodes: readonly Node[]): string => {
  const grouped = groupNodesByType(nodes);
  const sortedTypes = [...grouped.keys()].sort();
  // Title and summary always render, even for an empty vault. For the
  // empty-vault case we emit the title + summary only, with no trailing
  // section block — consistent with the spec.
  const header = ['# SfIntelligence vault', '', buildSummaryLine(nodes.length, sortedTypes.length)];
  if (sortedTypes.length === 0) {
    return header.join('\n');
  }
  const sections = sortedTypes.map((type) => renderTypeSection(type, grouped.get(type) ?? []));
  return [header.join('\n'), ...sections].join('\n\n');
};

const buildFrontmatter = (
  nodes: readonly Node[],
): Readonly<Record<string, unknown>> => {
  const distinctTypes = new Set<ComponentType>();
  for (const node of nodes) {
    distinctTypes.add(node.type);
  }
  return {
    generatedBy: GENERATED_BY,
    totalComponents: nodes.length,
    typesIndexed: distinctTypes.size,
  };
};

/**
 * Render the vault's top-level index document — a single Markdown file
 * listing every Node in the vault grouped by component type, with relative
 * links to each component's individual file. Acts as both an Obsidian-
 * browsable table of contents and an entry point an LLM can load to
 * discover what lives in the vault.
 *
 * Pure and synchronous: takes the entire array of nodes in memory and
 * returns a `RendererOutput`. Sorting is deterministic (alphabetical by
 * type at the section level, alphabetical by `id` within each section), so
 * the same node set in any order produces byte-identical output.
 *
 * The returned `RendererOutput.path` is `components/index.md`; the
 * frontmatter carries `generatedBy`, `totalComponents`, and `typesIndexed`.
 *
 * @example
 *   const result = renderVaultIndex(allNodes);
 *   if (result.ok) {
 *     const fullOutput =
 *       '---\\n' +
 *       serializeFrontmatter(result.value.frontmatter) +
 *       '\\n---\\n\\n' +
 *       result.value.body +
 *       '\\n';
 *     await writeFile(result.value.path, fullOutput);
 *   }
 */
export const renderVaultIndex = (
  nodes: readonly Node[],
): Result<RendererOutput, RendererError> => {
  try {
    return ok({
      path: INDEX_OUTPUT_PATH,
      frontmatter: buildFrontmatter(nodes),
      body: buildBody(nodes),
    });
  } catch (cause) {
    return err({
      kind: 'render-failure',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
