/**
 * The conversational half of `sfi.review_change` (WOW-6): turn whatever change
 * set the host holds into review targets, add the automation-collision signal,
 * and compose one go / no-go decision with its reasons.
 *
 *   - {@link assembleChangeSet} — `components` (ids, typed rows, or bare
 *     names), a `package.xml` body, a `destructiveChanges.xml` body, and
 *     changed source paths, merged into one de-duplicated set. Bare names
 *     resolve on an EXACT api-name match only; anything else is disclosed in
 *     `unresolved`, never guessed (a deploy gate that silently reviews a
 *     similar-named component is worse than one that asks).
 *   - {@link buildCollisionSection} — composes `sfi.automation_collisions` for
 *     the objects the change set touches and keeps the findings that involve a
 *     changed component.
 *   - {@link buildDeployDecision} — `no-go` / `review-first` / `go`, derived
 *     from the review's own tallies, so it can never disagree with the rows.
 */

import type { ComponentId, McpError, Node } from '@sf-intelligence/contracts';
import { err, ok, splitPathSegments, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, resolveComponents, runGraphQuery } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { automationCollisionsHandler } from './automation-collisions.js';
import {
  parseManifestComponents,
  parseSourcePathEntries,
  type UnreviewableEntry,
} from './change-set-input.js';
import { NON_DEPLOYABLE_TYPES } from './export-manifest.js';
import type { ChangeKind, ParsedChangeEntry, ReviewTarget } from './review-change.js';

/** Hard cap on the change-set size (matches `tests_for_change` / `meaningful_test_audit`). */
export const MAX_CHANGE_SET = 500;

/** Sample caps that keep the disclosure block small. */
const SKIPPED_PATH_SAMPLE = 10;
const UNRESOLVED_CANDIDATE_SAMPLE = 5;

/** Rows one graph lookup may return (the query compiler's ceiling). */
const LOOKUP_ROW_CAP = 500;

/**
 * Something the change set names that was NOT reviewed. Every entry here
 * keeps the deploy decision off `go`.
 */
export interface UnresolvedChangeInput {
  readonly input: string;
  /**
   * `ambiguous` / `not-found` — a bare name that is not exactly one component;
   * `container` — a file / manifest member holding many components (name the
   * changed ones; candidates sample what the vault holds in it);
   * `not-modeled` — metadata the vault does not model, so nothing was checked.
   */
  readonly reason: 'ambiguous' | 'not-found' | 'container' | 'not-modeled';
  /** Components the input could mean, or (container) what it holds. */
  readonly candidates: readonly ComponentId[];
  /** Container only: how many vault components the file / member holds. */
  readonly componentsInVault?: number;
}

/** How the change set was assembled — present when anything was inferred. */
export interface InputResolution {
  /** Rows contributed by each input, before de-duplication. */
  readonly sources: {
    readonly components: number;
    readonly packageXml: number;
    readonly destructiveChangesXml: number;
    readonly sourcePaths: number;
  };
  /**
   * `components` entries reviewed as `modified` because no change kind was
   * given — a deletion among them would be under-called. (package.xml members
   * are deployed, never deleted, so they are not counted here.)
   */
  readonly changeKindDefaulted: number;
  /** Named in the change set but NOT reviewed (see {@link UnresolvedChangeInput}). */
  readonly unresolved: readonly UnresolvedChangeInput[];
  /** Manifest types listed with a `*` member — not enumerable offline, NOT reviewed. */
  readonly wildcardTypes: readonly string[];
  /**
   * Changed project files that are not deployable metadata (docs, READMEs,
   * project config, Jest tests) — sample in `skippedPaths`. These do not block
   * `go`; a metadata file the vault does not model is in `unresolved` instead.
   */
  readonly skippedPathCount: number;
  readonly skippedPaths: readonly string[];
  /** Ids whose api-name casing was corrected to the vault's. */
  readonly recased: number;
  /** Bare nested names completed to the one vault id that has them (`Field__c` → `Obj.Field__c`). */
  readonly qualified: number;
  /** Deleted container files expanded into the components the vault holds in them. */
  readonly containersExpanded: number;
  /** Same component named by more than one input / line — merged into one row. */
  readonly duplicatesMerged: number;
}

/** The assembled change set. */
export interface AssembledChangeSet {
  readonly targets: readonly ReviewTarget[];
  /** Undefined when the caller passed only typed rows with explicit change kinds. */
  readonly inputResolution?: InputResolution;
}

/** The raw inputs `review_change` accepts (post-schema). */
export interface ChangeSetInputs {
  readonly components?: readonly (ParsedChangeEntry | Record<string, unknown>)[] | undefined;
  readonly packageXml?: string | undefined;
  readonly destructiveChangesXml?: string | undefined;
  readonly sourcePaths?: readonly string[] | undefined;
}

const idOf = (type: string, apiName: string): ComponentId => `${type}:${apiName}` as ComponentId;

/** Rank of a change kind when two inputs name the same component: an explicit delete wins. */
const KIND_RANK: Readonly<Record<ChangeKind, number>> = { deleted: 0, added: 1, modified: 2 };

/**
 * Accept an entry either already normalised by the schema or raw (a direct
 * handler call in a test or the CLI): `{ type, apiName }`, `{ componentId }`,
 * `{ name }`, plus an optional `changeKind`.
 */
const toParsed = (
  e: ParsedChangeEntry | Record<string, unknown>,
): ParsedChangeEntry & { readonly kindDefaulted: boolean } => {
  const raw = e as {
    type?: string;
    apiName?: string;
    componentId?: string;
    name?: string;
    changeKind?: ChangeKind;
  };
  const changeKind = raw.changeKind ?? 'modified';
  // The schema marks a defaulted kind with `kindDefaulted: true`; a raw row
  // (direct handler call) is defaulted when it carries no `changeKind`.
  const kindDefaulted = e['kindDefaulted'] === true || raw.changeKind === undefined;
  if (raw.type !== undefined && raw.apiName !== undefined) {
    return { type: raw.type, apiName: raw.apiName, changeKind, kindDefaulted };
  }
  const id = raw.componentId;
  if (id !== undefined) {
    const idx = id.indexOf(':');
    if (idx > 0 && idx < id.length - 1) {
      return { type: id.slice(0, idx), apiName: id.slice(idx + 1), changeKind, kindDefaulted };
    }
  }
  return { name: raw.name ?? id ?? '', changeKind, kindDefaulted };
};

/** The api-name part of a canonical id. */
const apiPart = (id: string): string => id.slice(id.indexOf(':') + 1);
const typePart = (id: string): string => id.slice(0, id.indexOf(':'));

/** Graph nodes that are not deployable components (synthetic contexts, stubs). */
const isDeployable = (n: Node): boolean => !NON_DEPLOYABLE_TYPES.has(n.type);

/**
 * Resolve a bare name on an EXACT (case-insensitive) api-name match, optionally
 * within one type. Exact = the whole api name (`ShopService`), or a nested /
 * foldered component's own name (`Field__c` → every object that has one;
 * `Report_Name` → `Folder/Report_Name`), so a name on two parents is
 * AMBIGUOUS rather than a coin toss. The match is a direct id scan — not a
 * ranked top-N window — so an exact match can never fall outside it; when the
 * scan itself overflows, uniqueness is unprovable and the name reads ambiguous.
 * Similarity candidates are only ever returned as suggestions.
 */
const resolveExactName = async (
  ctx: Context,
  name: string,
  type?: string,
): Promise<
  Result<
    { match: ComponentId | null; ambiguous: boolean; candidates: readonly ComponentId[] },
    McpError
  >
> => {
  const scan = await runGraphQuery(ctx.graph, {
    select: 'nodes',
    where: [
      { column: 'id', op: 'ILIKE', value: `%${name}` },
      ...(type !== undefined ? [{ column: 'type', op: '=' as const, value: type }] : []),
    ],
    limit: LOOKUP_ROW_CAP,
  });
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  const wanted = name.toLowerCase();
  const exact = [
    ...new Set(
      (scan.value.rows as readonly Node[])
        .filter(isDeployable)
        .map((n) => n.id)
        .filter((id) => {
          const api = apiPart(id).toLowerCase();
          return api === wanted || api.endsWith(`.${wanted}`) || api.endsWith(`/${wanted}`);
        }),
    ),
  ].sort();
  const overflow = scan.value.totalCount > scan.value.rows.length;
  if (exact.length === 1 && !overflow) return ok({ match: exact[0] ?? null, ambiguous: false, candidates: exact });
  if (exact.length > 1 || (exact.length === 1 && overflow)) {
    return ok({ match: null, ambiguous: true, candidates: exact });
  }
  const similar = await resolveComponents(ctx.graph, name, {
    limit: UNRESOLVED_CANDIDATE_SAMPLE,
    ...(type !== undefined ? { types: [type as never] } : {}),
  });
  if (!similar.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${similar.error.message}` });
  }
  return ok({ match: null, ambiguous: false, candidates: similar.value.candidates.map((c) => c.id) });
};

/**
 * The vault nodes built from one changed source file. The vault stores each
 * node's file relative to its own source root (`source/classes/Foo.cls`) while
 * the host passes a project path (`force-app/main/default/classes/Foo.cls`),
 * so the match is the LONGEST shared tail of path segments (at least the
 * directory + file name). This is what makes path → id exact for every family
 * — dotted CMDT records, `Obj-Name` layouts, foldered reports, path
 * assistants named from inside the file — without re-deriving any name.
 */
const nodesFromSourceFile = async (
  ctx: Context,
  path: string,
): Promise<Result<{ nodes: readonly Node[]; total: number }, McpError>> => {
  const segs = splitPathSegments(path);
  const file = segs[segs.length - 1] ?? '';
  if (file === '') return ok({ nodes: [], total: 0 });
  const res = await runGraphQuery(ctx.graph, {
    select: 'nodes',
    where: [{ column: 'sourcePath', op: 'LIKE', value: `%${file}` }],
    limit: LOOKUP_ROW_CAP,
  });
  if (!res.ok) return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
  const sharedTail = (other: string): number => {
    const o = splitPathSegments(other);
    let k = 0;
    while (k < segs.length && k < o.length && segs[segs.length - 1 - k] === o[o.length - 1 - k]) k += 1;
    return k;
  };
  let best = 1;
  let nodes: Node[] = [];
  for (const n of (res.value.rows as readonly Node[]).filter(isDeployable)) {
    const k = sharedTail(n.sourcePath);
    if (k > best) {
      best = k;
      nodes = [n];
    } else if (k === best && k > 1) nodes.push(n);
  }
  return ok({ nodes, total: res.value.totalCount });
};

/** A row headed for review, before de-duplication. */
interface PendingRow {
  readonly type: string;
  readonly apiName: string;
  readonly changeKind: ChangeKind;
  readonly kindDefaulted: boolean;
}

/**
 * Merge every input into one de-duplicated review set. Errors are reserved for
 * graph failures; an EMPTY or OVERSIZED result is reported by the caller.
 */
export const assembleChangeSet = async (
  ctx: Context,
  input: ChangeSetInputs,
): Promise<Result<AssembledChangeSet, McpError>> => {
  const rows: PendingRow[] = [];
  const unresolved: UnresolvedChangeInput[] = [];
  let changeKindDefaulted = 0;
  let inferred = false;
  let containersExpanded = 0;
  const sources = { components: 0, packageXml: 0, destructiveChangesXml: 0, sourcePaths: 0 };

  for (const raw of input.components ?? []) {
    const e = toParsed(raw);
    if (e.kindDefaulted) inferred = true;
    if ('name' in e) {
      inferred = true;
      const r = await resolveExactName(ctx, e.name);
      if (!r.ok) return r;
      if (r.value.match === null) {
        unresolved.push({
          input: e.name,
          reason: r.value.ambiguous ? 'ambiguous' : 'not-found',
          candidates: r.value.candidates.slice(0, UNRESOLVED_CANDIDATE_SAMPLE),
        });
        continue;
      }
      const m = r.value.match;
      rows.push({
        type: typePart(m),
        apiName: apiPart(m),
        changeKind: e.changeKind,
        kindDefaulted: e.kindDefaulted,
      });
    } else {
      rows.push({ ...e });
    }
    sources.components += 1;
  }

  /**
   * A container file / member names MANY components. A DELETED one removes
   * every component the vault holds in it, so those are reviewed as deleted;
   * otherwise WHICH ones changed is unknown, so it is disclosed, not reviewed.
   */
  const handleUnreviewable = async (
    u: UnreviewableEntry,
    holds: readonly Node[],
    key: 'packageXml' | 'destructiveChangesXml' | 'sourcePaths',
  ): Promise<void> => {
    const held = [...new Set(holds.map((n) => n.id))].sort();
    if (u.reason === 'container' && u.changeKind === 'deleted' && held.length > 0) {
      containersExpanded += 1;
      for (const id of held) {
        rows.push({ type: typePart(id), apiName: apiPart(id), changeKind: 'deleted', kindDefaulted: false });
        sources[key] += 1;
      }
      return;
    }
    unresolved.push({
      input: u.input,
      reason: u.reason,
      candidates: held.slice(0, UNRESOLVED_CANDIDATE_SAMPLE),
      ...(u.reason === 'container' ? { componentsInVault: held.length } : {}),
    });
  };

  /** Vault components a container MANIFEST member (`SharingRules:Account`) holds. */
  const containerMemberNodes = async (u: UnreviewableEntry): Promise<Result<readonly Node[], McpError>> => {
    if (u.reason !== 'container' || u.containerType === undefined) return ok([]);
    const member = u.input.slice(u.input.indexOf(':') + 1);
    // `CustomLabels:CustomLabels` holds every label; a per-object container
    // (`SharingRules:Account`) holds the type's `{Object}.*` ids.
    const prefix = u.containerType === 'CustomLabel' ? '' : `${member}.`;
    const res = await runGraphQuery(ctx.graph, {
      select: 'nodes',
      where: [
        { column: 'type', op: '=', value: u.containerType },
        { column: 'id', op: 'LIKE', value: `${u.containerType}:${prefix}%` },
      ],
      limit: LOOKUP_ROW_CAP,
    });
    if (!res.ok) return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    return ok((res.value.rows as readonly Node[]).filter((n) => apiPart(n.id).startsWith(prefix)));
  };

  const wildcardTypes: string[] = [];
  const addManifest = async (
    xml: string,
    kind: ChangeKind,
    key: 'packageXml' | 'destructiveChangesXml',
  ): Promise<Result<void, McpError>> => {
    inferred = true;
    const parsed = parseManifestComponents(xml, kind);
    if (parsed.notAManifest) {
      unresolved.push({
        input: `${key} (no <Package> root — not a manifest body)`,
        reason: 'not-found',
        candidates: [],
      });
      return ok(undefined);
    }
    for (const w of parsed.wildcardTypes) if (!wildcardTypes.includes(w)) wildcardTypes.push(w);
    for (const c of parsed.components) {
      rows.push({
        type: c.type,
        apiName: c.apiName,
        changeKind: c.changeKind,
        // A package.xml member is deployed (never deleted), so `modified` is
        // not hiding a deletion; a member absent from the vault reads
        // not-in-vault (it may be new), never `safe`.
        kindDefaulted: false,
      });
      sources[key] += 1;
    }
    for (const u of parsed.unreviewable) {
      const held = await containerMemberNodes(u);
      if (!held.ok) return held;
      await handleUnreviewable(u, held.value, key);
    }
    return ok(undefined);
  };
  if (input.packageXml !== undefined) {
    const r = await addManifest(input.packageXml, 'modified', 'packageXml');
    if (!r.ok) return r;
  }
  if (input.destructiveChangesXml !== undefined) {
    const r = await addManifest(input.destructiveChangesXml, 'deleted', 'destructiveChangesXml');
    if (!r.ok) return r;
  }

  let skipped: readonly string[] = [];
  if (input.sourcePaths !== undefined) {
    inferred = true;
    const parsed = parseSourcePathEntries(input.sourcePaths);
    skipped = parsed.skippedPaths;
    for (const c of parsed.components) {
      let { type, apiName } = c;
      if (c.sourcePath !== undefined) {
        // The file name is only a best-effort name; the vault node built from
        // the same file carries the exact id.
        const found = await nodesFromSourceFile(ctx, c.sourcePath);
        if (!found.ok) return found;
        const ofType = found.value.nodes.filter((n) => n.type === type);
        const exact = ofType.find((n) => n.id === idOf(type, apiName)) ?? (ofType.length === 1 ? ofType[0] : undefined);
        if (exact !== undefined) {
          type = exact.type;
          apiName = apiPart(exact.id);
        }
      }
      rows.push({ type, apiName, changeKind: c.changeKind, kindDefaulted: false });
      sources.sourcePaths += 1;
    }
    for (const u of parsed.unreviewable) {
      let held: readonly Node[] = [];
      if (u.reason === 'container') {
        const found = await nodesFromSourceFile(ctx, u.input);
        if (!found.ok) return found;
        held = found.value.nodes;
      }
      await handleUnreviewable(u, held, 'sourcePaths');
    }
  }

  // Case-correct ids the vault holds under a different casing (Salesforce api
  // names are case-insensitive; the graph's ids are not), and complete a bare
  // nested name to the ONE vault id that has it. Only an EXACT match within
  // the same type is adopted, and each kind of rewrite is counted separately.
  let recased = 0;
  let qualified = 0;
  const merged = new Map<string, PendingRow>();
  let duplicatesMerged = 0;
  for (const row of rows) {
    let { type, apiName } = row;
    const node = await getNodeById(ctx.graph, idOf(type, apiName));
    if (!node.ok) return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    if (node.value === null && row.changeKind !== 'added') {
      const r = await resolveExactName(ctx, apiName, type);
      if (!r.ok) return r;
      if (r.value.match !== null && r.value.match !== idOf(type, apiName)) {
        const matchedApi = apiPart(r.value.match);
        if (matchedApi.toLowerCase() === apiName.toLowerCase()) recased += 1;
        else qualified += 1;
        type = typePart(r.value.match);
        apiName = matchedApi;
        inferred = true;
      }
    }
    const key = idOf(type, apiName).toLowerCase();
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, { ...row, type, apiName });
      continue;
    }
    duplicatesMerged += 1;
    // Explicit beats defaulted; among explicit kinds, a delete wins.
    const better =
      prev.kindDefaulted && !row.kindDefaulted
        ? row
        : !prev.kindDefaulted && row.kindDefaulted
          ? prev
          : KIND_RANK[row.changeKind] < KIND_RANK[prev.changeKind]
            ? row
            : prev;
    merged.set(key, { ...better, type: prev.type, apiName: prev.apiName });
  }

  const finalRows = [...merged.values()];
  for (const r of finalRows) if (r.kindDefaulted) changeKindDefaulted += 1;
  const targets: ReviewTarget[] = finalRows.map((r) => ({
    type: r.type,
    apiName: r.apiName,
    changeKind: r.changeKind,
  }));

  const needsDisclosure =
    inferred || unresolved.length > 0 || duplicatesMerged > 0 || wildcardTypes.length > 0;
  return ok({
    targets,
    ...(needsDisclosure
      ? {
          inputResolution: {
            sources,
            changeKindDefaulted,
            unresolved,
            wildcardTypes,
            skippedPathCount: skipped.length,
            skippedPaths: skipped.slice(0, SKIPPED_PATH_SAMPLE),
            recased,
            qualified,
            containersExpanded,
            duplicatesMerged,
          },
        }
      : {}),
  });
};

/** Explain why an assembled set cannot be reviewed (empty / oversized), or null. */
export const assembledSetProblem = (set: AssembledChangeSet): string | null => {
  if (set.targets.length > MAX_CHANGE_SET) {
    return `The change set resolves to ${set.targets.length} components; review_change analyses at most ${MAX_CHANGE_SET} per call. Split it (e.g. by metadata type) and review each part.`;
  }
  if (set.targets.length > 0) return null;
  const r = set.inputResolution;
  const parts: string[] = [];
  if (r !== undefined) {
    if (r.unresolved.length > 0) {
      parts.push(
        `${r.unresolved.length} input(s) could not be reviewed (${r.unresolved
          .slice(0, 5)
          .map((u) => `${u.input}: ${u.reason}${u.candidates.length > 0 ? ` — e.g. ${u.candidates.slice(0, 3).join(', ')}` : ''}`)
          .join('; ')})`,
      );
    }
    if (r.wildcardTypes.length > 0) {
      parts.push(`wildcard members cannot be enumerated offline (${r.wildcardTypes.join(', ')})`);
    }
    if (r.skippedPathCount > 0) {
      parts.push(`${r.skippedPathCount} path(s) are not deployable metadata (e.g. ${r.skippedPaths.slice(0, 3).join(', ')})`);
    }
  }
  return `Nothing reviewable in the change set: ${parts.length > 0 ? parts.join('; ') : 'no components were named'}. Pass canonical ids (\`Type:ApiName\`, from sfi.resolve), a package.xml body with named members, or force-app/... source paths.`;
};

// ---------------------------------------------------------------------------
// Automation collisions
// ---------------------------------------------------------------------------

/** Objects whose collisions are composed per call (most-touched first). */
const MAX_COLLISION_OBJECTS = 5;
/** Findings kept per object. */
const MAX_FINDINGS_PER_OBJECT = 5;

/**
 * A collision finding only ever involves a FIELD (the raced field) or an
 * AUTOMATION (a writer / hop), so only those touch an object here: a changed
 * layout or list view can never appear in a finding and would only spend the
 * per-call object cap. A field's object is its id prefix; an automation's is
 * its outbound `triggersOn` edge.
 */
const FIELD_TYPE = 'CustomField';

/** Automation types whose object binding is an outbound `triggersOn` edge. */
const TRIGGERS_ON_TYPES: ReadonlySet<string> = new Set(['Flow', 'ApexTrigger', 'WorkflowRule']);

/** One collision or recursion cycle that involves a changed component. */
export interface CollisionFinding {
  readonly kind: 'field-write-collision' | 'save-recursion-cycle';
  readonly severity: 'info' | 'medium' | 'high';
  /** The field raced on (collision) or the first hop's field (cycle). */
  readonly fieldId: ComponentId;
  /** The automations involved — writers (collision) or hop automations (cycle). */
  readonly automations: readonly ComponentId[];
  /** Which of those / the field are in the change set. */
  readonly changedInvolved: readonly ComponentId[];
}

/** Collisions on one object the change set touches. */
export interface ObjectCollisionReport {
  readonly objectId: ComponentId;
  /** Changed components on / firing on this object. */
  readonly changedOnObject: readonly ComponentId[];
  readonly fieldsWithMultipleWriters: number;
  readonly cyclesFound: number;
  /** `partial` = some writes could not be enumerated; an empty list is a floor. */
  readonly fieldWriteCoverage: 'complete' | 'partial';
  readonly involvingChange: readonly CollisionFinding[];
  readonly involvingChangeTotal: number;
}

/** The composed collision section. */
export interface CollisionSection {
  readonly objects: readonly ObjectCollisionReport[];
  /** Objects touched but not checked (over the per-call cap, or not in the vault). */
  readonly notChecked: readonly { readonly objectId: ComponentId; readonly reason: string }[];
  /** Total findings that involve a changed component, across checked objects. */
  readonly involvingChangeTotal: number;
  readonly boundary: string;
}

const COLLISION_BOUNDARY =
  'Composed from sfi.automation_collisions for the objects this change set touches (at most ' +
  `${MAX_COLLISION_OBJECTS}, most-touched first). It reads the CURRENT vault's automations — the ` +
  'deployed versions, not the new ones in this change set — so a collision a modified Flow ' +
  'introduces is not visible until after a refresh. Entry conditions are not evaluated (mutually ' +
  'exclusive criteria still list as a collision), and `fieldWriteCoverage: partial` means some ' +
  'writes could not be enumerated, so the list is a floor.';

/**
 * Compose `sfi.automation_collisions` for every object the change set touches
 * and keep the findings that involve a changed component (as a writer, a hop,
 * or the raced field). Returns undefined when the change set touches no object.
 */
export const buildCollisionSection = async (
  ctx: Context,
  targets: readonly ReviewTarget[],
): Promise<Result<CollisionSection | undefined, McpError>> => {
  const changed = new Set<ComponentId>(targets.map((t) => idOf(t.type, t.apiName)));
  const byObject = new Map<ComponentId, Set<ComponentId>>();
  const touch = (objectId: ComponentId, id: ComponentId): void => {
    const set = byObject.get(objectId) ?? new Set<ComponentId>();
    set.add(id);
    byObject.set(objectId, set);
  };
  for (const t of targets) {
    const id = idOf(t.type, t.apiName);
    if (t.type === 'CustomObject') touch(id, id);
    else if (t.type === FIELD_TYPE && t.apiName.includes('.')) {
      touch(idOf('CustomObject', t.apiName.slice(0, t.apiName.indexOf('.'))), id);
    } else if (TRIGGERS_ON_TYPES.has(t.type)) {
      const out = await listEdges(ctx.graph, id, { direction: 'out', edgeType: 'triggersOn' });
      if (!out.ok) return err({ kind: 'internal', message: `graph query failed: ${out.error.message}` });
      for (const e of out.value) if (e.toId.startsWith('CustomObject:')) touch(e.toId, id);
    }
  }
  if (byObject.size === 0) return ok(undefined);

  const ranked = [...byObject.entries()].sort(
    (a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const objects: ObjectCollisionReport[] = [];
  const notChecked: { objectId: ComponentId; reason: string }[] = [];
  for (const [objectId, ids] of ranked.slice(MAX_COLLISION_OBJECTS)) {
    void ids;
    notChecked.push({
      objectId,
      reason: `over the ${MAX_COLLISION_OBJECTS}-object cap — run sfi.automation_collisions on it`,
    });
  }
  let involvingChangeTotal = 0;
  for (const [objectId, ids] of ranked.slice(0, MAX_COLLISION_OBJECTS)) {
    const res = await automationCollisionsHandler(ctx, { objectId });
    if (!res.ok) {
      notChecked.push({ objectId, reason: res.error.message.slice(0, 200) });
      continue;
    }
    const d = res.value.data;
    const findings: CollisionFinding[] = [];
    for (const c of d.collisions) {
      const writers = c.writers.map((w) => w.componentId);
      const involved = [c.fieldId, ...writers].filter((x) => changed.has(x));
      if (involved.length === 0) continue;
      findings.push({
        kind: 'field-write-collision',
        severity: c.severity,
        fieldId: c.fieldId,
        automations: writers,
        changedInvolved: [...new Set(involved)],
      });
    }
    for (const cy of d.cycles) {
      const autos = cy.path.map((h) => h.automationId);
      const fields = cy.path.map((h) => h.fieldId);
      const involved = [...autos, ...fields].filter((x) => changed.has(x));
      const firstField = fields[0];
      if (involved.length === 0 || firstField === undefined) continue;
      findings.push({
        kind: 'save-recursion-cycle',
        severity: cy.severity,
        fieldId: firstField,
        automations: [...new Set(autos)],
        changedInvolved: [...new Set(involved)],
      });
    }
    const sevRank = { high: 0, medium: 1, info: 2 } as const;
    findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    involvingChangeTotal += findings.length;
    objects.push({
      objectId,
      changedOnObject: [...ids].sort(),
      fieldsWithMultipleWriters: d.summary.fieldsWithMultipleWriters,
      cyclesFound: d.summary.cyclesFound,
      fieldWriteCoverage: d.summary.fieldWriteCoverage,
      involvingChange: findings.slice(0, MAX_FINDINGS_PER_OBJECT),
      involvingChangeTotal: findings.length,
    });
  }
  return ok({ objects, notChecked, involvingChangeTotal, boundary: COLLISION_BOUNDARY });
};

// ---------------------------------------------------------------------------
// Go / no-go
// ---------------------------------------------------------------------------

/** The one-line deploy call, with the reasons that drove it. */
export interface DeployDecision {
  /**
   * `no-go` — at least one blocking change. `review-first` — nothing blocks,
   * but something is risky, unverified, or not checked. `go` — every change is
   * safe within the vault's coverage AND nothing was left unchecked.
   */
  readonly decision: 'no-go' | 'review-first' | 'go';
  readonly reasons: readonly string[];
}

/** The facts the decision is derived from (all already in the response). */
export interface DecisionFacts {
  readonly summary: {
    readonly total: number;
    readonly blocking: number;
    readonly risky: number;
    readonly review: number;
    readonly testsToRun: number;
    readonly uncoveredApex: number;
    readonly unknownTestCoverage: number;
    readonly notInVault: number;
  };
  readonly blockingSample: readonly {
    readonly id: ComponentId;
    readonly dependentCount: number;
    readonly reason: string;
  }[];
  readonly riskySample: readonly ComponentId[];
  readonly coverageGap: boolean;
  /**
   * ADDED Apex classes / triggers no test in the vault reaches. They are not
   * in `summary.uncoveredApex` (that tallies the vault's own Apex), yet a
   * production deploy of a trigger with 0% coverage is rejected.
   */
  readonly addedApexUncovered: readonly ComponentId[];
  /** True when the caller opted out of the automation-collision check. */
  readonly collisionsSkipped: boolean;
  readonly inputResolution?: InputResolution;
  readonly collisions?: CollisionSection;
}

/**
 * Derive the go / no-go call. Never `go` while anything named in the change
 * set was left unreviewed or unchecked: an unresolved name, a container or
 * unmodelled metadata file, a wildcard, an uncovered family, an undecided test
 * dimension, new Apex no test reaches, or a skipped collision check.
 */
export const buildDeployDecision = (f: DecisionFacts): DeployDecision => {
  const s = f.summary;
  const reasons: string[] = [];
  if (s.blocking > 0) {
    reasons.push(
      `${s.blocking} blocking change(s): ${f.blockingSample
        .slice(0, 3)
        .map((b) =>
          b.dependentCount > 0
            ? `${b.id} (${b.dependentCount} dependent(s))`
            : // Blocking with no inbound dependent = a floor (e.g. a live
              // save-time automation); name it from the row's own reason.
              `${b.id} (${(b.reason.split(' — ')[0] ?? b.reason).slice(0, 140)})`,
        )
        .join(', ')}`,
    );
  }
  if (s.risky > 0) {
    reasons.push(`${s.risky} risky change(s) with firm dependents: ${f.riskySample.slice(0, 3).join(', ')}`);
  }
  if (s.review > 0) reasons.push(`${s.review} change(s) need manual review`);
  if (s.notInVault > 0) {
    reasons.push(`${s.notInVault} modified/deleted component(s) are not in the vault — not assessed`);
  }
  if (s.uncoveredApex > 0) reasons.push(`${s.uncoveredApex} changed Apex component(s) reached by no test`);
  if (f.addedApexUncovered.length > 0) {
    reasons.push(
      `${f.addedApexUncovered.length} added Apex class(es)/trigger(s) reached by no test the vault knows (${f.addedApexUncovered
        .slice(0, 3)
        .join(', ')}) — new tests in this change set are not analysed; a production deploy needs every trigger covered and 75% overall`,
    );
  }
  if (s.unknownTestCoverage > 0) {
    reasons.push(`test coverage undetermined for ${s.unknownTestCoverage} Apex change(s) — the test list is a floor`);
  }
  if (f.coverageGap) reasons.push('the vault does not fully cover a family this change set touches (see coverageCaveat)');
  const r = f.inputResolution;
  if (r !== undefined) {
    if (r.unresolved.length > 0) {
      const byReason = new Map<string, number>();
      for (const u of r.unresolved) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
      reasons.push(
        `${r.unresolved.length} named input(s) were NOT reviewed (${[...byReason]
          .map(([k, n]) => `${n} ${k}`)
          .join(', ')} — see inputResolution.unresolved)`,
      );
    }
    if (r.wildcardTypes.length > 0) {
      reasons.push(`wildcard manifest types were NOT reviewed: ${r.wildcardTypes.join(', ')}`);
    }
    if (r.changeKindDefaulted > 0) {
      reasons.push(
        `${r.changeKindDefaulted} component(s) were reviewed as 'modified' because no change kind was given — a deletion among them is under-called; pass destructiveChangesXml or changeKind: 'deleted'`,
      );
    }
  }
  const c = f.collisions;
  if (c !== undefined && c.involvingChangeTotal > 0) {
    reasons.push(`${c.involvingChangeTotal} automation collision / recursion finding(s) involve a changed component (see automationCollisions)`);
  }
  if (c !== undefined && c.notChecked.length > 0) {
    reasons.push(`automation collisions not checked on ${c.notChecked.length} touched object(s)`);
  }
  if (f.collisionsSkipped) reasons.push('automation collisions were not checked (includeCollisions: false)');

  if (s.blocking > 0) return { decision: 'no-go', reasons };
  if (reasons.length > 0) return { decision: 'review-first', reasons };
  return {
    decision: 'go',
    reasons: [
      `all ${s.total} change(s) are safe within the vault's coverage; run the ${s.testsToRun} selected test(s) — selection is not validation, and the vault reflects its last refresh`,
    ],
  };
};
