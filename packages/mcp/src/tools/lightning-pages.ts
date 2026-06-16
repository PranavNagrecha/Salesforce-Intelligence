/**
 * Handler for the `sfi.lightning_pages` MCP tool (P11-UI-flexipage-activation).
 *
 * Lightning record pages (FlexiPage) used to be a bare node. The extractor now
 * captures `sobjectType` / `pageType` / `masterLabel` and a `references` edge
 * FlexiPage → `CustomObject` (referenceKind `flexiPageObject`). This tool reads
 * both directions:
 *   - `CustomObject:X`  → the Lightning pages FOR that object (forward).
 *   - `FlexiPage:X`     → that page's object + kind + label (reverse).
 *
 * HONESTY: the profile / recordType / app / form-factor ACTIVATION (which user
 * actually sees which page) is NOT in the retrieved FlexiPage metadata — it is
 * a separate Lightning App Builder assignment. Every response carries an
 * `activationDisclosure` saying so; the tool reports which pages EXIST for an
 * object, never which one a given user is served.
 *
 * Input: `{ componentId: 'CustomObject:X' | 'FlexiPage:X', limit?, offset? }`.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

const OBJECT_PREFIX = 'CustomObject:';
const FLEXIPAGE_PREFIX = 'FlexiPage:';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

const ACTIVATION_DISCLOSURE =
  'Which profile / record type / app / form factor ACTIVATES (is served) a Lightning page is NOT in the retrieved FlexiPage metadata — it is a separate Lightning App Builder assignment. This lists the pages that EXIST for the object (and `layout_for_user` covers CLASSIC layouts); it does not resolve which page a specific user sees.';

export const lightningPagesInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export type LightningPagesInput = z.infer<typeof lightningPagesInputSchema>;

/** One Lightning page that targets the object. */
export interface LightningPageRef {
  /** The FlexiPage component id (canonical `componentId` key per ADR-007). */
  readonly componentId: ComponentId;
  readonly masterLabel: string | null;
  readonly pageType: string | null;
}

export interface LightningPagesOutput {
  readonly componentId: string;
  readonly mode: 'object' | 'flexipage';
  /** object mode: the object the pages are for. */
  readonly object?: string;
  /** object mode: the Lightning pages for the object (paginated). */
  readonly pages?: readonly LightningPageRef[];
  /** flexipage mode: this page's object (or null for an App/Home page). */
  readonly forObject?: string | null;
  /** flexipage mode: the page's kind (RecordPage / AppPage / HomePage / …). */
  readonly pageType?: string | null;
  /** flexipage mode: the page's label. */
  readonly masterLabel?: string | null;
  readonly summary: { readonly pages: number };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly activationDisclosure: string;
}

const strProp = (p: Readonly<Record<string, unknown>>, k: string): string | null =>
  typeof p[k] === 'string' ? (p[k] as string) : null;

export const lightningPagesHandler = async (
  ctx: Context,
  input: LightningPagesInput,
): Promise<Result<McpResponse<LightningPagesOutput>, McpError>> => {
  const isObject = input.componentId.startsWith(OBJECT_PREFIX);
  const isFlexiPage = input.componentId.startsWith(FLEXIPAGE_PREFIX);
  if (!isObject && !isFlexiPage) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a CustomObject: or FlexiPage: id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  if (isFlexiPage) {
    const nodeResult = await getNodeById(ctx.graph, componentId);
    if (!nodeResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
    }
    if (nodeResult.value === null) {
      return err({ kind: 'component-not-found', message: `no FlexiPage matches \`${componentId}\``, path: componentId });
    }
    const p = nodeResult.value.properties;
    return ok({
      data: {
        componentId,
        mode: 'flexipage',
        forObject: strProp(p, 'sobjectType'),
        pageType: strProp(p, 'pageType'),
        masterLabel: strProp(p, 'masterLabel'),
        summary: { pages: 1 },
        limit,
        offset,
        hasMore: false,
        truncated: false,
        confidence: 'declared',
        activationDisclosure: ACTIVATION_DISCLOSURE,
      },
      vaultState,
    });
  }

  // Object mode: incoming `references` edges from FlexiPages (flexiPageObject).
  const objResult = await getNodeById(ctx.graph, componentId);
  if (!objResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objResult.error.message}` });
  }
  if (objResult.value === null) {
    return err({ kind: 'component-not-found', message: `no CustomObject matches \`${componentId}\``, path: componentId });
  }
  const edgesResult = await listEdges(ctx.graph, componentId, { direction: 'in', edgeType: 'references' });
  if (!edgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
  }
  const pageEdges = edgesResult.value.filter(
    (e) => e.properties['referenceKind'] === 'flexiPageObject' && e.fromId.startsWith(FLEXIPAGE_PREFIX),
  );
  const pages: LightningPageRef[] = [];
  for (const edge of pageEdges) {
    const pageNode = await getNodeById(ctx.graph, edge.fromId);
    if (!pageNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${pageNode.error.message}` });
    }
    const pp = pageNode.value?.properties ?? {};
    pages.push({
      componentId: edge.fromId as ComponentId,
      masterLabel: strProp(pp, 'masterLabel'),
      pageType: strProp(pp, 'pageType'),
    });
  }
  pages.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));

  const total = pages.length;
  const page = pages.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  return ok({
    data: {
      componentId,
      mode: 'object',
      object: componentId.slice(OBJECT_PREFIX.length),
      pages: page,
      summary: { pages: total },
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      confidence: 'declared',
      activationDisclosure: ACTIVATION_DISCLOSURE,
    },
    vaultState,
  });
};
