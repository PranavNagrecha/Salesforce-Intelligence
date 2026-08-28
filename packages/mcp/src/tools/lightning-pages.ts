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
 * OBJECT mode also accepts the natural object aliases (L2 Alias OS):
 * `objectApiName` / `object` / `objectId`. The resolved scope is echoed as
 * `appliedScope`; disagreeing object aliases are an `invalid-query`.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import { firstNonEmpty, resolveObjectAliasInVault } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

const OBJECT_PREFIX = 'CustomObject:';
const FLEXIPAGE_PREFIX = 'FlexiPage:';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

const ACTIVATION_DISCLOSURE =
  'Which profile / record type / app / form factor ACTIVATES (is served) a Lightning page is NOT in the retrieved FlexiPage metadata — it is a separate Lightning App Builder assignment. This lists the pages that EXIST for the object (and `layout_for_user` covers CLASSIC layouts); it does not resolve which page a specific user sees.';

/**
 * R1 TYPED ABSENCE sentinel: the property EVERY extracted FlexiPage node
 * carries (even `null`), written by the same extractor pass that mints the
 * `references` FlexiPage -> CustomObject edge object mode reads. A FlexiPage
 * node from a refresh that predates that extractor is a bare node with NO
 * `sobjectType` key at all — `familyWasExtracted` distinguishes that from a
 * genuinely-checked page whose object happens to be unset.
 */
const FLEXIPAGE_SOBJECT_SENTINEL = 'sobjectType';

export const lightningPagesInputSchema = z
  .object({
    // OBJECT mode: a `CustomObject:` id, or any object alias below (L2 Alias
    // OS). FLEXIPAGE mode (reverse): a `FlexiPage:` componentId. At least one
    // identifier is required.
    componentId: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    // Profile ACTIVATION keys a host reaches for on a "which page does {profile}
    // see for {object}?" question. Accepted here ONLY so the handler can REFUSE
    // with the activation-gap pointer instead of silently stripping them (which
    // returned a bare object inventory reading as "{profile} is served these
    // pages") — LIGHTNING-PAGES-SILENTLY-DROPS-PROFILE-ARGS. NEVER a valid scope.
    profileId: z.string().min(1).optional(),
    profileApiName: z.string().min(1).optional(),
    profileName: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
    // CR-22 continuation cursor (object mode only): an OPAQUE token echoed back
    // from a prior truncated page's `nextCursor`. When present it supplies the
    // resume offset; omitting it = today's behavior (offset 0 / explicit
    // `offset`). The flexipage branch is a single-node fast path with no list.
    cursor: z.string().min(1).optional(),
  })
  .refine(
    (i) =>
      i.componentId !== undefined ||
      i.object !== undefined ||
      i.objectApiName !== undefined ||
      i.objectId !== undefined,
    {
      message:
        'name the object or page — pass a `componentId` (`CustomObject:` for an object, `FlexiPage:` for a page) or an object alias (`objectApiName` / `object` / `objectId`)',
      path: ['componentId'],
    },
  );

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
  /**
   * Echoes the id ACTUALLY resolved so a host never assumes an alias it passed
   * (`objectApiName` / `object` / `objectId`) was silently stripped — the
   * `componentId: Required` bug this closes. `componentId` is the resolved
   * `CustomObject:` id (object mode) or `FlexiPage:` id (reverse mode);
   * `object` is the object api name (object mode; the page's object or `null`
   * in reverse mode).
   */
  readonly appliedScope: {
    readonly componentId: string;
    readonly object: string | null;
  };
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
  /**
   * `null` (never a verified `0`) when, in OBJECT mode, NOT ONE FlexiPage node
   * in the vault carries the extracted {@link FLEXIPAGE_SOBJECT_SENTINEL} and
   * this object's own page list came back empty — the `flexiPageObject`
   * family was never extracted, so nothing was checked. flexipage mode always
   * reports the concrete `1`.
   */
  readonly summary: { readonly pages: number | null };
  /**
   * OBJECT mode only: how many FlexiPage nodes in the vault carry no
   * extracted `sobjectType` — i.e. were never examined for a `flexiPageObject`
   * edge at all. `0` on a fully-extracted vault. Any positive value means
   * `pages` / `summary.pages` may be a FLOOR (an unchecked FlexiPage could
   * target this same object and simply never mint the edge), spelled out in
   * `activationDisclosure`.
   */
  readonly pagesExtractionNotChecked?: number;
  /**
   * OBJECT mode only: true when the FlexiPage scan behind
   * {@link LightningPagesOutput.pagesExtractionNotChecked} stopped at the
   * full-scan residual cap, so more unchecked pages may exist behind it.
   */
  readonly pagesScanTruncated?: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token (object mode), present ONLY when the pages
   * page was truncated (more pages remain past `limit`). Echo it back as
   * `cursor` to resume. Absent on a whole-fits page so an in-budget response
   * stays byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly confidence: 'declared';
  readonly activationDisclosure: string;
}

const strProp = (p: Readonly<Record<string, unknown>>, k: string): string | null =>
  typeof p[k] === 'string' ? (p[k] as string) : null;

export const lightningPagesHandler = async (
  ctx: Context,
  input: LightningPagesInput,
): Promise<Result<McpResponse<LightningPagesOutput>, McpError>> => {
  // LIGHTNING-PAGES-SILENTLY-DROPS-PROFILE-ARGS: profile ACTIVATION (which user
  // is SERVED which page) is NOT in the retrieved FlexiPage metadata — it is a
  // separate Lightning App Builder assignment. A profile* key can therefore never
  // scope this tool. Rather than silently strip it (returning the bare object
  // inventory that reads as "{profile} is served these pages"), REFUSE with a
  // pointer at the activation gap and the tools that DO model per-profile routing.
  const profileKey = firstNonEmpty(
    input.profileApiName,
    input.profileId,
    input.profileName,
    input.profile,
  );
  if (profileKey !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        `lightning_pages lists the Lightning pages that EXIST for an object; it cannot scope by profile (\`${profileKey}\`). ` +
        'Which profile / record type / app / form factor ACTIVATES (is served) a page is NOT in the retrieved FlexiPage metadata — it is a separate Lightning App Builder assignment. ' +
        'Drop the profile argument and pass just the object, then use `layout_for_user` (Classic layout routing) or Lightning App Builder for the per-profile page a user actually sees.',
      path: 'profileApiName',
    });
  }

  // L2 Alias OS: resolve an OBJECT scope from object / objectApiName / objectId
  // or a CustomObject: componentId (a reverse-mode FlexiPage: componentId is
  // NOT an object alias). Disagreeing object aliases -> invalid-query.
  //
  // R6 (census brief 069, line 171): the VAULT-AWARE resolver, not the sync
  // one — `object_access_audit` / `flow_bulkification_audit` /
  // `flow_fault_audit` route the same way. The sync resolver alone turns
  // `objectApiName: 'contact'` into `CustomObject:contact`, an id no vault
  // holds even though `CustomObject:Contact` is right there; the vault-aware
  // resolver probes case variants and corrects it before the
  // `component-not-found` check below ever runs.
  const objScope = await resolveObjectAliasInVault(ctx.graph, input, {
    bareComponentIdIsObject: false,
    required: false,
  });
  if (!objScope.ok) return err(objScope.error);
  const rawComponentId = input.componentId;
  let resolvedId: string;
  if (objScope.value !== null) {
    // OBJECT mode. A FlexiPage: componentId alongside an object is ambiguous.
    if (rawComponentId !== undefined && rawComponentId.startsWith(FLEXIPAGE_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message:
          'pass either a FlexiPage: componentId (reverse mode) or an object (object mode), not both',
        path: 'componentId',
      });
    }
    resolvedId = objScope.value.componentId;
  } else if (rawComponentId !== undefined) {
    resolvedId = rawComponentId;
  } else {
    return err({
      kind: 'invalid-query',
      message:
        'name the object or page — pass a `componentId` (CustomObject: or FlexiPage:) or an object alias (objectApiName / object / objectId)',
      path: 'componentId',
    });
  }
  const isObject = resolvedId.startsWith(OBJECT_PREFIX);
  const isFlexiPage = resolvedId.startsWith(FLEXIPAGE_PREFIX);
  if (!isObject && !isFlexiPage) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a CustomObject: or FlexiPage: id; got '${resolvedId}'`,
      path: 'componentId',
    });
  }
  const componentId = resolvedId as ComponentId;
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
    const forObject = strProp(p, 'sobjectType');
    return ok({
      data: {
        componentId,
        appliedScope: { componentId, object: forObject },
        mode: 'flexipage',
        forObject,
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
  // TOTAL-ORDER sort by the FlexiPage `componentId` (= edge.fromId). This single
  // key is ALREADY unique: each row's componentId is a distinct FlexiPage id,
  // and the extractor emits EXACTLY ONE flexiPageObject edge per FlexiPage to a
  // fixed CustomObject — so no two surviving rows share a componentId. A CR-22
  // resume over this list cannot dup or skip; no extra tiebreak is needed.
  pages.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));

  // ------------------------------------------------------------------
  // R1 TYPED ABSENCE — did this refresh extract FlexiPage `sobjectType` (and
  // therefore the `flexiPageObject` edge) AT ALL?
  //
  // `pages: []` above reads IDENTICALLY for "checked, this object genuinely
  // has no Lightning pages" and "this vault's refresh predates the extractor
  // pass that writes `sobjectType`, so no FlexiPage ever mints a
  // `flexiPageObject` edge to ANY object". The FlexiPage node this object's
  // OWN empty edge set came back from cannot answer that (it never emitted
  // anything to look at) — the sentinel lives on the whole FlexiPage corpus,
  // scanned with the shared multi-window walk so a corpus past the 500-row
  // `listNodesByType` ceiling is not alphabetically capped.
  // ------------------------------------------------------------------
  const flexiPageScan = await scanAllNodesOfTypes(ctx.graph, ['FlexiPage']);
  if (!flexiPageScan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${flexiPageScan.error.message}` });
  }
  const flexiPagesNotChecked: string[] = [];
  let flexiPagesChecked = 0;
  for (const fp of flexiPageScan.value.nodes) {
    if (familyWasExtracted(fp.properties, FLEXIPAGE_SOBJECT_SENTINEL)) flexiPagesChecked += 1;
    else flexiPagesNotChecked.push(fp.id);
  }
  flexiPagesNotChecked.sort();
  const pagesScanTruncated = flexiPageScan.value.scanIncomplete;

  // CR-22 (object mode only): resolve the resume offset — an echoed cursor wins
  // over an explicit `offset`; a stale/forged cursor (changed componentId,
  // different tool, or refreshed vault) is rejected with `invalid-query`. The
  // input.componentId being an OBJECT id is part of the fingerprint, so a cursor
  // minted on CustomObject:A is auto-rejected if replayed against CustomObject:B.
  const fingerprint = argsFingerprint({ componentId });
  let objOffset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.lightning_pages',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    objOffset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — set an effectively
  // unbounded byteBudget so `paginate()` truncates ONLY on `limit`
  // (byte-identical to the prior open-coded slice). The global jsonResult guard
  // remains the byte backstop.
  const paged = paginateLegacy(pages, {
    offset: objOffset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.lightning_pages',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (p) => p.componentId,
  });
  const page = paged.items;
  const total = paged.totalCount;
  const hasMore = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const objectApiName = componentId.slice(OBJECT_PREFIX.length);

  // The case-1 sentence comes from the ONE shared builder (R6-adjacent module
  // reuse) — the same template `who_can_run` renders for its own extraction
  // vintage gap, so the two cannot drift into two wordings of one blind spot.
  const notExtractedNote =
    flexiPagesNotChecked.length > 0
      ? notExtractedFamilyDisclosure({
          subject: 'Lightning page object references',
          verb: 'checked',
          pluralSubject: true,
          sentinelProperty: FLEXIPAGE_SOBJECT_SENTINEL,
          containers: flexiPagesNotChecked,
          surface: '`pages` / `summary.pages`',
          zeroReading: '"no Lightning pages exist for this object"',
        })
      : null;
  // Leading, because it is an UNDERSTATEMENT of what exists: a reader who
  // stops after one sentence must still learn the enumeration may be short.
  const baseDisclosure =
    notExtractedNote === null ? ACTIVATION_DISCLOSURE : `${notExtractedNote} ${ACTIVATION_DISCLOSURE}`;
  const activationDisclosure = pagesScanTruncated
    ? `${baseDisclosure} ${fullScanTruncationNote(flexiPageScan.value.incompleteTypes)}`
    : baseDisclosure;

  // NOTHING was checked and nothing was found → `null`, never a verified `0`.
  // A page that WAS found makes the count a real floor, so it stays a number
  // even on a mixed-vintage vault (the shortfall is disclosed, not nulled).
  const pagesSummary =
    total === 0 && flexiPagesChecked === 0 && flexiPagesNotChecked.length > 0 ? null : total;

  return ok({
    data: {
      componentId,
      appliedScope: { componentId, object: objectApiName },
      mode: 'object',
      object: objectApiName,
      pages: page,
      summary: { pages: pagesSummary },
      pagesExtractionNotChecked: flexiPagesNotChecked.length,
      pagesScanTruncated,
      limit,
      offset: objOffset,
      hasMore,
      truncated: hasMore || objOffset > 0,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      confidence: 'declared',
      activationDisclosure,
    },
    vaultState,
  });
};
