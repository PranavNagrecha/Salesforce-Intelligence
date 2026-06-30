/**
 * Handler for the `sfi.get_component` MCP tool.
 *
 * Surfaces a single component's rendered Markdown by canonical id.
 * Two on-disk artifacts back the response: the graph node (read via
 * `getNodeById`) tells us which markdown file to open and gives us a
 * confidence signal that the id is real; the markdown file at
 * `componentPath(...)` gives us the renderer-produced bytes. A node without
 * a matching file is reported as `component-not-found` with the relative
 * path the caller would have read — this is the degraded-vault state where
 * the graph has been imported but the renderer has not run.
 *
 * Frontmatter is returned as the raw YAML string between the opening and
 * the first closing `---` delimiter; the v0.1 contract does not ship a YAML
 * parser through this surface, leaving structured parsing to clients that
 * want it. Splitting on the *first* `\n---\n` after the opening means
 * markdown horizontal rules inside the body remain part of the body.
 *
 * v0.2 STRUCTURED GROUNDING: `data.properties` exposes the component's typed
 * properties object (the same record stored in the graph node — for
 * ValidationRules this carries `active`, `errorConditionFormula`, `conditions`,
 * `errorMessage`, etc.) and `data.referenceIds` carries the canonical ids of
 * all components this node has outgoing edges to. Both fields are additive: the
 * existing `frontmatter` / `body` strings are byte-identical and always present.
 * This lets `synthesize_answer` (and any LLM caller) lift structured facts
 * without re-parsing YAML, and cite edge targets as real component ids rather
 * than guessing from markdown prose — eliminating false hallucination flags on
 * referenced ids.
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { appendDemandHit, componentPath } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { mergeInputAliases } from './input-aliases.js';
import { tryReadComponentDoc } from './component-doc-fallback.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { buildReferenceStub } from './phantom-taxonomy.js';

/**
 * Zod schema for the `sfi.get_component` tool input. `id` is a non-empty
 * string — the canonical `{Type}:{ApiName}` form is enforced downstream by
 * the graph lookup (an unknown id yields `component-not-found`, not a
 * Zod-level rejection).
 */
export const DEFAULT_COMPONENT_BODY_MAX_BYTES = 30_000;

const getComponentInputBaseSchema = z.object({
  id: z.string().min(1),
  maxBodyBytes: z
    .number()
    .int()
    .min(0)
    .max(DEFAULT_COMPONENT_BODY_MAX_BYTES)
    .optional(),
});

export const getComponentInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [{ canonical: 'id', aliases: ['componentId'] }]),
  getComponentInputBaseSchema,
);

/** Parsed input shape, inferred from `getComponentInputSchema`. */
export type GetComponentInput = z.infer<typeof getComponentInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `id`: the canonical component id the caller passed in, echoed back.
 *   - `type`: the component's type (from the graph node).
 *   - `path`: vault-relative path of the markdown file that was read.
 *   - `frontmatter`: raw YAML body between the leading and first trailing
 *     `---` delimiters. Parsing left to the client (byte-identical with v0.1).
 *   - `body`: response-safe markdown body slice following the frontmatter,
 *     with the leading blank line(s) after the closing delimiter trimmed.
 *   - `properties`: the component's typed properties object — the same record
 *     stored in the graph node and rendered into the frontmatter. For
 *     ValidationRules this carries `active`, `errorConditionFormula`,
 *     `conditions`, `errorMessage`, `errorDisplayField`, etc. Always present
 *     (may be `{}` for components whose extractor emits no typed properties).
 *     Additive: does NOT replace `frontmatter`; the existing string is
 *     preserved byte-for-byte.
 *   - `referenceIds`: canonical ids (`{Type}:{ApiName}`) of every component
 *     this node has a directed outgoing edge to, deduplicated and sorted.
 *     Covers all outgoing edge types (references, triggersOn, firesWhen, etc.)
 *     so callers receive the full outbound neighbourhood as structured values
 *     rather than needing to parse markdown prose. Empty array when this node
 *     has no outgoing edges.
 *   - truncation fields: explicit byte counts so callers know whether the
 *     body was clipped to keep the MCP response consumable.
 */
export interface GetComponentOutput {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly path: string;
  readonly frontmatter: string;
  readonly body: string;
  /**
   * Structured property bag from the graph node. For ValidationRules:
   * `{ active, errorConditionFormula, conditions, errorMessage, errorDisplayField }`.
   * Additive — `frontmatter` (the raw YAML string) is still present and
   * byte-identical with v0.1.
   */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Canonical ids of every component this node has an outgoing edge to,
   * deduplicated and sorted. Lets callers cite real component ids without
   * parsing markdown prose.
   */
  readonly referenceIds: readonly ComponentId[];
  readonly bodyTruncated: boolean;
  readonly bodyBytes: number;
  readonly returnedBodyBytes: number;
  readonly omittedBodyBytes: number;
  readonly maxBodyBytes: number;
  /**
   * P13-ANNOT-tools: the component's curated annotations (provenance
   * `annotation` — human-stated/confirmed meaning, never derived from the
   * snapshot). Absent when the component has none, so annotation-free
   * vaults stay byte-identical.
   */
  readonly annotations?: AnnotationsBlock;
}

/**
 * The `sfi.get_component` MCP tool. Returns a vault component's rendered
 * Markdown (split into frontmatter and a bounded body slice) by canonical id.
 * Input is already Zod-validated by `dispatchTool` before this handler runs.
 *
 * @example
 *   const r = await getComponentHandler(ctx, { id: 'CustomObject:Account' });
 *   if (r.ok) console.log(r.value.data.body);
 */
export const getComponentHandler = async (
  ctx: Context,
  input: GetComponentInput,
): Promise<Result<McpResponse<GetComponentOutput>, McpError>> => {
  const nodeResult = await getNodeById(ctx.graph, input.id);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    const doc = await tryReadComponentDoc(ctx.vaultRoot, input.id);
    if (doc !== null) {
      const split = { frontmatter: doc.frontmatter, body: doc.body.trimStart() };
      const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_COMPONENT_BODY_MAX_BYTES;
      const boundedBody = truncateUtf8(split.body, maxBodyBytes);
      return ok({
        data: {
          id: input.id as ComponentId,
          type: doc.type,
          path: doc.path,
          frontmatter: split.frontmatter,
          body: boundedBody.text,
          properties: {},
          referenceIds: [],
          bodyTruncated: boundedBody.truncated,
          bodyBytes: boundedBody.originalBytes,
          returnedBodyBytes: boundedBody.returnedBytes,
          omittedBodyBytes: boundedBody.originalBytes - boundedBody.returnedBytes,
          maxBodyBytes,
        },
        vaultState: {
          sourceTreeHash: ctx.manifest.sourceTreeHash,
          refreshedAt: ctx.manifest.refreshedAt,
        },
      });
    }
    // A bare "no node with id X" reads as "this doesn't exist". But an id that
    // is REFERENCED by retrieved components (e.g. a permission-set grant to a
    // managed-package or standard CustomObject that was never pulled) is a
    // PHANTOM — it exists in the org, just not in this vault. Disclose that
    // instead of a silent-looking not-found (B29).
    const id = input.id as ComponentId;
    const kindLabel = input.id.includes(':')
      ? input.id.slice(0, input.id.indexOf(':'))
      : 'component';
    // P7-reference-stub-nodes: when the id is a PHANTOM (referenced but never
    // retrieved), attach the classified stub + remedy so the caller gets a
    // structured insufficient-knowledge signal, not a bare not-found. Null when
    // the id has no inbound edges (a genuinely-unknown id).
    const stub = await buildReferenceStub(ctx, id);
    // P13-STAGED-demand-queue: an automation-critical phantom HIT is demand
    // signal — a real question needed this component. Queue it so
    // `sfi refresh --drain-demand-queue` (or the watch daemon) pulls exactly
    // what was asked for. Best-effort: a queue write never breaks the answer.
    if (stub !== null && stub.classification === 'automation-critical') {
      await appendDemandHit(ctx.vaultRoot, id, stub.classification, 'get_component');
    }
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, id, kindLabel),
      path: input.id,
      ...(stub !== null ? { stub } : {}),
    });
  }
  const node = nodeResult.value;

  const parentApiName = parseParentApiName(node.parentId);
  const fullPath = componentPath(
    ctx.vaultRoot,
    node.type,
    parentApiName,
    node.apiName,
  );
  const relPath = toRelativePath(ctx.vaultRoot, fullPath);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch {
    // ENOENT and any other read failure surface the same way to the
    // caller: the rendered artifact is not present. We tag the path so
    // operators can inspect the vault directly.
    return err({
      kind: 'component-not-found',
      message: 'vault file missing',
      path: relPath,
    });
  }

  const split = splitFrontmatter(raw);
  if (split === null) {
    return err({
      kind: 'internal',
      message: `malformed frontmatter at ${relPath}`,
      path: relPath,
    });
  }
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_COMPONENT_BODY_MAX_BYTES;
  const boundedBody = truncateUtf8(split.body, maxBodyBytes);
  const annotations = await annotationsBlockFor(ctx, node.id);

  // Fetch outgoing edges for structured grounding: `referenceIds` gives callers
  // canonical component ids without needing to parse markdown prose, eliminating
  // false hallucination flags in synthesize_answer on referenced ids.
  const edgesResult = await listEdges(ctx.graph, node.id, { direction: 'out' });
  const referenceIds: ComponentId[] = edgesResult.ok
    ? [...new Set(edgesResult.value.map((e) => e.toId))].sort()
    : [];

  return ok({
    data: {
      id: node.id,
      type: node.type,
      path: relPath,
      frontmatter: split.frontmatter,
      body: boundedBody.text,
      // Structured properties from the graph node (already parsed JSON, never
      // re-derived from the YAML string). For ValidationRules carries `active`,
      // `errorConditionFormula`, `conditions`, `errorMessage`, etc.
      properties: node.properties,
      // Canonical ids of every outgoing neighbour, deduplicated + sorted.
      referenceIds,
      bodyTruncated: boundedBody.truncated,
      bodyBytes: boundedBody.originalBytes,
      returnedBodyBytes: boundedBody.returnedBytes,
      omittedBodyBytes: boundedBody.originalBytes - boundedBody.returnedBytes,
      maxBodyBytes,
      ...(annotations !== undefined ? { annotations } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Recover the parent's apiName from a canonical parent id like
 * `CustomObject:Account`. Returns `null` when the node has no parent, which
 * is the shape `componentPath` expects for top-level components.
 */
const parseParentApiName = (parentId: ComponentId | null): string | null => {
  if (parentId === null) return null;
  const colonIdx = parentId.indexOf(':');
  // No colon means the id is malformed upstream; treat it as "no parent
  // segment" rather than crashing — the file lookup will then miss and
  // surface as `component-not-found`, which is the right diagnostic for
  // a vault out of sync with the graph.
  return colonIdx >= 0 ? parentId.substring(colonIdx + 1) : null;
};

/**
 * Trim the vault-root prefix from an absolute component path. The MCP
 * contract reports paths relative to the vault so clients can recombine
 * them with whatever root they have on their own filesystem.
 */
const toRelativePath = (vaultRoot: string, fullPath: string): string => {
  const prefix = vaultRoot.endsWith('/') ? vaultRoot : `${vaultRoot}/`;
  return fullPath.startsWith(prefix) ? fullPath.substring(prefix.length) : fullPath;
};

/**
 * Pull the YAML frontmatter and Markdown body out of a renderer-produced
 * file. Returns `null` when the leading `---\n` or its first matching
 * `\n---\n` is absent; the caller maps that to an `internal` error since
 * the renderer is supposed to write this shape unconditionally.
 *
 * Splitting on the *first* `\n---\n` after position 4 means a markdown
 * horizontal rule inside the body never confuses the parser.
 */
const splitFrontmatter = (
  raw: string,
): { frontmatter: string; body: string } | null => {
  if (!raw.startsWith('---\n')) return null;
  const endIdx = raw.indexOf('\n---\n', 4);
  if (endIdx < 0) return null;
  const frontmatter = raw.substring(4, endIdx);
  const body = raw.substring(endIdx + 5).replace(/^\n+/, '');
  return { frontmatter, body };
};

const truncateUtf8 = (
  text: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly returnedBytes: number;
} => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }
  const sliced = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return {
    text: sliced,
    truncated: true,
    originalBytes,
    returnedBytes: Buffer.byteLength(sliced, 'utf8'),
  };
};
