/**
 * Handler for `sfi.record_delete_impact` (spec F7) — "if a record of object X
 * is deleted, what happens to its children, and what stops it?"
 *
 *   - children        every relationship field pointing at X (and, through a
 *                     cascade, at the records deleted with it): ORPHANED /
 *                     DELETED_WITH_PARENT / BLOCKS_DELETE / UNKNOWN
 *   - guards          before/after-delete triggers and delete-triggered flows on X
 *   - rollups         roll-up summaries that recalculate because records vanish
 *   - whoCanDelete    profiles / permission sets with Delete or Modify All on X
 *                     (and Modify All Data), OmniStudio delete paths, Apex delete
 *                     sites — plus generic deleters that can delete any record
 *
 * Findings: ORPHANED (per SetNull child field), INCONSISTENT_CONSTRAINT (one
 * child object with several relationships to X that behave differently),
 * NO_SERVER_GUARD (nothing server-side runs when X is deleted, while children
 * are orphaned or deleted with it).
 */

import type { ComponentId, McpError, McpResponse, Node, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import { auditEditBlocks } from '../omni/edit-block-audit.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import { compareFindings, type OmniFinding } from '../omni/types.js';
import { OmniWorld } from '../omni/world.js';
import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { type ApexDmlFact, buildApexDmlIndex, dmlActsOn } from './apex-dml-index.js';
import { isApexEntryClass, resolveGenericDml } from './apex-generic-dml.js';
import { computeDeleteImpact, type DeleteChild, type DeleteImpactCore } from './delete-impact.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { scanAllPermissionSetGroups } from './permission-set-group.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { isActiveSoeFirer } from './soe-active.js';

export const recordDeleteImpactInputSchema = z.object({
  /** Object API name (`Acme_Member__c`) or `CustomObject:` id. */
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  /** Look for OmniStudio delete paths (default true). */
  includeOmniStudio: z.boolean().optional(),
  /** Look for Apex delete sites (default true). */
  includeApex: z.boolean().optional(),
  /** Caps each `whoCanDelete` list (default 100). Totals stay whole. */
  limit: z.number().int().min(1).max(500).optional(),
});

export type RecordDeleteImpactInput = z.infer<typeof recordDeleteImpactInputSchema>;

/** One profile / permission set that lets its holders delete records of X. */
export interface DeleteGrant {
  readonly granterId: string;
  readonly granterType: string;
  /** `object-delete` (Delete, records the user can see), `modify-all-object`, or `system-modify-all-data`. */
  readonly via: 'object-delete' | 'modify-all-object' | 'system-modify-all-data';
  /** Permission set groups that include this permission set. */
  readonly inGroups: readonly { readonly groupId: string; readonly hasMuting: boolean }[];
}

/** One Edit Block whose cards save X and that wires a server delete (`inferred`). */
export interface OmniDeletePath {
  readonly kind: 'edit-block';
  readonly componentId: string;
  readonly sourcePath: string;
  readonly elementPath: string;
  readonly line: number | null;
  readonly confidence: 'parsed' | 'inferred';
  readonly detail: Readonly<Record<string, unknown>>;
}

/** One Apex delete site attributed to X (or a generic one that can delete X). */
export interface ApexDeleteSite {
  readonly componentId: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly method: string | null;
  readonly statement: string;
  readonly evidence: string;
  readonly methodAnnotations: readonly string[];
  readonly sharing: string | null;
  /** `user` / `system` when the statement names an access level; `null` when it does not. */
  readonly accessLevel: 'user' | 'system' | null;
  /**
   * Who calls the class (first 5, sorted): every `callsApex` caller — Apex,
   * Flow, LWC / Aura, OmniStudio — except the class itself and test classes.
   */
  readonly calledBy: readonly string[];
  readonly calledByCount: number;
  readonly confidence: 'inferred';
}

/** Response payload. */
export interface RecordDeleteImpactOutput {
  readonly appliedScope: { readonly componentId: string; readonly object: string };
  readonly refreshedAt: string;
  readonly summary: Readonly<Record<string, number | string>>;
  readonly children: readonly DeleteChild[];
  readonly guards: {
    readonly status: DeleteImpactCore['guardStatus'];
    readonly active: DeleteImpactCore['guards'];
    readonly inactive: DeleteImpactCore['inactiveGuards'];
    /** Active validation rules on the object — they do NOT run on delete. */
    readonly validationRulesNotRunOnDelete: number;
  };
  readonly rollups: DeleteImpactCore['rollups'];
  readonly whoCanDelete: {
    readonly grants: readonly DeleteGrant[];
    readonly grantsTotal: number;
    /** Declared delete steps: Integration Procedure Delete Actions and Flow delete elements naming X. */
    readonly declaredDeletes: readonly DeclaredDeletePath[];
    readonly declaredDeletesTotal: number;
    /** Edit Blocks whose cards save X and wire a server delete (`inferred`). */
    readonly editBlocks: readonly OmniDeletePath[];
    readonly editBlocksTotal: number;
    readonly apex: readonly ApexDeleteSite[];
    readonly apexTotal: number;
    /** Delete sites that act on whatever records they are handed — they can delete X. */
    readonly genericDeletes: readonly ApexDeleteSite[];
    readonly genericDeletesTotal: number;
    /** True when any list above was cut at `limit`. */
    readonly truncated: boolean;
  };
  readonly findings: readonly OmniFinding[];
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'A relationship field\'s delete behavior is its declared `deleteConstraint` (SetNull → ORPHANED, Restrict → BLOCKS_DELETE, Cascade → DELETED_WITH_PARENT). A custom lookup that declares none takes the platform default, SetNull (`constraintSource: platform-default`); a master-detail child is always deleted with its parent; a standard relationship is platform-defined per object and is UNKNOWN.',
  'Records removed by a cascade do not fire their own delete triggers, so only the deleted object\'s own before/after-delete triggers and delete-triggered flows count as guards. Validation rules do not run on delete.',
  'Who can delete: profiles and permission sets granting Delete or Modify All on the object, and Modify All Data holders. Which users hold them is not in the vault; permission-set-group muting is disclosed (`hasMuting`), not applied — `sfi.effective_permissions` answers for one persona. Object Delete still needs the record to be visible to the user (sharing).',
  'Apex delete sites are attributed to the object by the deleted operand\'s declared type (`List<X> rows`, `new X(…)`, `[SELECT … FROM X]`) and, when that type is not visible, by the enclosing method naming or querying the object — both `inferred`, the parse does not type-check. A site whose operand is a generic SObject can delete any record it is given; it is listed under `genericDeletes`, never as "does not delete X".',
  'Declared deletes come from the graph: an Integration Procedure Delete Action names its SObject type (`parsed`), and a Flow delete element names its object. Only active components count. An Edit Block\'s delete is attributed to the object its cards save (`inferred`).',
  'How many child records exist is live data, not in the vault.',
]);

const fieldName = (id: string): string => id.slice('CustomField:'.length);

const childFinding = (core: DeleteImpactCore, c: DeleteChild): OmniFinding => {
  const guarded = core.guardStatus !== 'none';
  const how = c.constraintSource === 'declared' ? 'SetNull is declared' : 'no deleteConstraint is declared, so the platform default SetNull applies';
  const path = c.depth === 1 ? '' : ` (reached through the cascade ${c.via.map(fieldName).join(' → ')})`;
  return {
    code: 'ORPHANED',
    verdict: guarded ? 'unknown' : 'defect',
    componentId: c.field,
    sourcePath: c.sourcePath ?? '',
    elementPath: null,
    line: c.line,
    message:
      `Deleting a ${core.object} record leaves ${c.childObject} records with a blank ${fieldName(c.field)}${path}: ${how}` +
      (guarded ? '' : `, and no delete trigger or delete flow on ${core.object} cleans them up`),
    confidence: c.confidence,
    ...(guarded
      ? {
          unknownReason:
            core.guardStatus === 'present'
              ? `delete automation runs on ${core.object} (${core.guards.map((g) => g.componentId).join(', ')}); whether it removes or re-parents these records is not analysed`
              : `an Apex trigger on ${core.object} has no recorded events, so a delete trigger cannot be ruled out`,
        }
      : {}),
    evidence: {
      childObject: c.childObject,
      parentObject: c.parentObject,
      deleteConstraint: c.deleteConstraint,
      constraintSource: c.constraintSource,
      depth: c.depth,
      via: c.via,
    },
    citations: [{ componentId: c.field, sourcePath: c.sourcePath ?? '', ...(c.line === null ? {} : { line: c.line }) }],
  };
};

const inconsistentFindings = (core: DeleteImpactCore): OmniFinding[] => {
  const byChild = new Map<string, DeleteChild[]>();
  for (const c of core.children) {
    if (c.depth !== 1 || c.effect === 'UNKNOWN') continue;
    byChild.set(c.childObject, [...(byChild.get(c.childObject) ?? []), c]);
  }
  const out: OmniFinding[] = [];
  for (const [child, fields] of [...byChild].sort((a, b) => a[0].localeCompare(b[0]))) {
    const effects = [...new Set(fields.map((f) => f.effect))].sort();
    if (effects.length < 2) continue;
    const first = fields[0] as DeleteChild;
    out.push({
      code: 'INCONSISTENT_CONSTRAINT',
      verdict: 'defect',
      componentId: `CustomObject:${child}`,
      sourcePath: first.sourcePath ?? '',
      elementPath: null,
      line: null,
      message:
        `${child} has ${fields.length} relationships to ${core.object} that behave differently on delete (` +
        fields.map((f) => `${fieldName(f.field)}: ${f.effect}`).join(', ') +
        `): whether a ${child} record survives the delete depends on which field links it`,
      confidence: fields.every((f) => f.confidence === 'declared') ? 'declared' : 'parsed',
      evidence: { childObject: child, fields: fields.map((f) => ({ field: f.field, deleteConstraint: f.deleteConstraint, effect: f.effect })) },
      citations: fields.map((f) => ({ componentId: f.field, sourcePath: f.sourcePath ?? '', ...(f.line === null ? {} : { line: f.line }) })),
    });
  }
  return out;
};

const noGuardFinding = (core: DeleteImpactCore, objectNode: Node): OmniFinding | null => {
  if (core.guardStatus === 'present') return null;
  const affected = core.children.filter((c) => c.effect === 'ORPHANED' || c.effect === 'DELETED_WITH_PARENT');
  if (affected.length === 0) return null;
  const orphaned = affected.filter((c) => c.effect === 'ORPHANED').length;
  const cascaded = affected.length - orphaned;
  return {
    code: 'NO_SERVER_GUARD',
    verdict: core.guardStatus === 'none' ? 'defect' : 'unknown',
    componentId: core.objectId,
    sourcePath: objectNode.sourcePath ?? '',
    elementPath: null,
    line: null,
    message:
      `Nothing server-side runs when a ${core.object} record is deleted — no before/after-delete trigger, no delete-triggered flow` +
      (core.validationRules > 0 ? ` (its ${core.validationRules} validation rule(s) do not run on delete)` : '') +
      ` — while ${orphaned} relationship field(s) are left blank and ${cascaded} take their records with it`,
    confidence: 'parsed',
    ...(core.guardStatus === 'unknown' ? { unknownReason: `an Apex trigger on ${core.object} has no recorded events, so a delete trigger cannot be ruled out` } : {}),
    evidence: {
      inactiveGuards: core.inactiveGuards.map((g) => g.componentId),
      validationRulesNotRunOnDelete: core.validationRules,
      orphanedFields: affected.filter((c) => c.effect === 'ORPHANED').map((c) => c.field),
      cascadedFields: affected.filter((c) => c.effect === 'DELETED_WITH_PARENT').map((c) => c.field),
    },
    citations: [{ componentId: core.objectId, sourcePath: objectNode.sourcePath ?? '' }],
  };
};

/**
 * Profiles / permission sets that let their holders delete records of the
 * object. `systemPermsUnread` counts containers whose user permissions were
 * never extracted: whether they grant Modify All Data is unknown, not "no".
 */
const deleteGrants = async (
  ctx: Context,
  objectId: string,
): Promise<Result<{ readonly grants: DeleteGrant[]; readonly systemPermsUnread: number }, McpError>> => {
  const edges = await listEdges(ctx.graph, objectId as ComponentId, { direction: 'in', edgeType: 'grantedBy' });
  if (!edges.ok) return err({ kind: 'internal', message: `graph query failed: ${edges.error.message}` });
  const groups = await scanAllPermissionSetGroups(ctx);
  const groupsOf = new Map<string, { groupId: string; hasMuting: boolean }[]>();
  if (groups.ok) {
    for (const g of groups.value.groups) {
      for (const m of g.memberPermissionSetIds) groupsOf.set(m, [...(groupsOf.get(m) ?? []), { groupId: g.psgId, hasMuting: g.hasMuting }]);
    }
  }
  const grants: DeleteGrant[] = [];
  const add = (id: string, type: string, via: DeleteGrant['via']): void => {
    grants.push({ granterId: id, granterType: type, via, inGroups: (groupsOf.get(id) ?? []).sort((a, b) => a.groupId.localeCompare(b.groupId)) });
  };
  for (const e of edges.value) {
    const type = e.fromId.slice(0, e.fromId.indexOf(':'));
    if (type !== 'Profile' && type !== 'PermissionSet') continue;
    if (e.properties['modifyAllRecords'] === true) add(e.fromId, type, 'modify-all-object');
    else if (e.properties['allowDelete'] === true) add(e.fromId, type, 'object-delete');
  }
  const holders = await scanAllNodesOfTypes(ctx.graph, ['Profile', 'PermissionSet']);
  let systemPermsUnread = 0;
  if (holders.ok) {
    for (const n of holders.value.nodes) {
      if (!familyWasExtracted(n.properties, 'userPermissions')) {
        systemPermsUnread += 1;
        continue;
      }
      if (stringsOf(n.properties['userPermissions']).includes('ModifyAllData')) add(n.id, n.type, 'system-modify-all-data');
    }
  }
  const seen = new Set<string>();
  return ok({
    grants: grants
      .filter((g) => {
        const k = `${g.granterId}|${g.via}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.via.localeCompare(b.via) || a.granterId.localeCompare(b.granterId)),
    systemPermsUnread,
  });
};

/** The strings in a stored list (a value that is not a list holds none). */
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** One automation that deletes records of X through a declared delete step. */
export interface DeclaredDeletePath {
  readonly kind: 'ip-delete-action' | 'flow-delete';
  readonly componentId: string;
  readonly sourcePath: string;
  /** The delete step(s) (`elementPath` of an IP step; the Flow's record-delete element names). */
  readonly steps: readonly string[];
  readonly line: number | null;
  readonly confidence: 'parsed' | 'declared';
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Declared record deletes of X, read from the graph: `writesTo` edges with
 * `operation: 'recordDelete'` — an Integration Procedure Delete Action (from
 * the IP extractor) or a Flow delete element. Only ACTIVE components count.
 */
const declaredDeletePaths = async (ctx: Context, objectId: string): Promise<DeclaredDeletePath[]> => {
  const edges = await listEdges(ctx.graph, objectId as ComponentId, { direction: 'in', edgeType: 'writesTo' });
  if (!edges.ok) return [];
  const deletes = edges.value.filter((e) => e.properties['operation'] === 'recordDelete');
  const nodes = await listNodesByIds(ctx.graph, [...new Set(deletes.map((e) => e.fromId))] as ComponentId[]);
  const byId = new Map((nodes.ok ? nodes.value : []).map((n) => [n.id, n]));
  const out: DeclaredDeletePath[] = [];
  for (const e of deletes) {
    const node = byId.get(e.fromId);
    if (node === undefined) continue;
    if (node.type === 'OmniIntegrationProcedure') {
      if (node.properties['isActive'] !== true) continue;
      const callers = await listEdges(ctx.graph, node.id as ComponentId, { direction: 'in', edgeType: 'dispatchesOmniAction' });
      out.push({
        kind: 'ip-delete-action',
        componentId: node.id,
        sourcePath: node.sourcePath ?? '',
        steps: Array.isArray(e.properties['steps']) ? (e.properties['steps'] as string[]) : [],
        line: null,
        confidence: 'parsed',
        detail: {
          recordIds: e.properties['recordIds'] ?? [],
          calledBy: callers.ok ? [...new Set(callers.value.map((c) => c.fromId))].sort() : [],
        },
      });
    } else if (node.type === 'Flow') {
      if (!isActiveSoeFirer(node)) continue;
      out.push({
        kind: 'flow-delete',
        componentId: node.id,
        sourcePath: node.sourcePath ?? '',
        steps: typeof e.properties['elementName'] === 'string' ? [e.properties['elementName'] as string] : [],
        line: null,
        confidence: e.confidence === 'declared' ? 'declared' : 'parsed',
        detail: { processType: node.properties['processType'] ?? null, triggerType: node.properties['triggerType'] ?? null },
      });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.componentId.localeCompare(b.componentId));
};

/** Edit Blocks whose cards save X and that wire a server delete (`inferred`). */
const editBlockDeletePaths = async (ctx: Context, object: string): Promise<OmniDeletePath[]> => {
  const built = await OmniWorld.build(ctx);
  if (!built.ok) return [];
  const world = built.world;
  const paths: OmniDeletePath[] = [];
  const lower = object.toLowerCase();
  const prefixes = world.config.appScope.namePrefixes;
  for (const node of world.scripts.filter((n) => n.properties['isActive'] === true && (prefixes.length === 0 || prefixes.some((p) => n.apiName.startsWith(p))))) {
    const loaded = await world.loadProcess(node);
    if (!loaded.ok) continue;
    const model = await buildScriptModelWithResponses(world, loaded.value);
    if (!model.elements.some((e) => e.el.type === 'Edit Block')) continue;
    const { rows } = await auditEditBlocks(world, model);
    for (const row of rows) {
      if (row.deleteMechanisms.length === 0) continue;
      if (!row.recordIdentity.objectsWritten.some((o) => o.toLowerCase() === lower)) continue;
      paths.push({
        kind: 'edit-block',
        componentId: node.id,
        sourcePath: model.sourcePath,
        elementPath: row.elementPath,
        line: row.line,
        confidence: 'inferred',
        detail: {
          mechanisms: row.deleteMechanisms.map((m) => ({
            mechanism: m.mechanism,
            ipKey: m.ipKey,
            targetId: m.targetId,
            recordId: m.idSource.status === 'parsed' ? (m.idSource.expression ?? null) : null,
            ...(m.idSource.status === 'parsed' ? {} : { recordIdUnknown: m.idSource.reason ?? 'not traced' }),
          })),
          objectFrom: 'the objects the card\'s save path writes',
        },
      });
    }
  }
  return paths.sort((a, b) => a.componentId.localeCompare(b.componentId) || a.elementPath.localeCompare(b.elementPath));
};

const toApexSite = async (ctx: Context, f: ApexDmlFact, evidence: string): Promise<ApexDeleteSite> => {
  // Callers: every `callsApex` edge into the class — Apex, Flow, LWC / Aura and
  // OmniStudio (Remote Actions, Try Catch handlers, FlexCard Apex sources) —
  // except the class itself and test classes.
  const callers = await listEdges(ctx.graph, f.componentId as ComponentId, { direction: 'in', edgeType: 'callsApex' });
  const candidateIds = callers.ok ? [...new Set(callers.value.map((e) => e.fromId))].filter((id) => id !== f.componentId) : [];
  const nodes = await listNodesByIds(ctx.graph, candidateIds as ComponentId[]);
  const tests = new Set(nodes.ok ? nodes.value.filter((n) => n.properties['isTest'] === true).map((n) => n.id) : []);
  const ids = candidateIds.filter((id) => !tests.has(id)).sort();
  return {
    componentId: f.componentId,
    sourcePath: f.sourcePath,
    line: f.line,
    method: f.method,
    statement: f.statement,
    evidence,
    methodAnnotations: f.methodAnnotations,
    sharing: f.sharing,
    accessLevel: f.accessLevel,
    calledBy: ids.slice(0, 5),
    calledByCount: ids.length,
    confidence: 'inferred',
  };
};

/** Vault object api names by lower-case name (for generic-helper call-site typing). */
const objectNameIndex = async (ctx: Context): Promise<ReadonlyMap<string, string>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomObject']);
  return new Map(scan.ok ? scan.value.nodes.map((n) => [n.apiName.toLowerCase(), n.apiName] as const) : []);
};

/** The `sfi.record_delete_impact` handler. */
export const recordDeleteImpactHandler = async (
  ctx: Context,
  input: RecordDeleteImpactInput,
): Promise<Result<McpResponse<RecordDeleteImpactOutput>, McpError>> => {
  const scope = await resolveExistingObjectScope(ctx.graph, input, { unhandledPrefix: 'refuse' });
  if (!scope.ok) return err(scope.error);
  if (scope.value === null) {
    return err({ kind: 'invalid-query', message: 'name the object — pass `objectApiName` (e.g. "Acme_Member__c")', path: 'objectApiName' });
  }
  const objectId = scope.value.componentId;
  const object = scope.value.object;
  const objectNode = await getNodeById(ctx.graph, objectId as ComponentId);
  if (!objectNode.ok || objectNode.value === null) {
    return err({ kind: 'component-not-found', message: `no CustomObject matches \`${objectId}\` in this vault`, path: objectId });
  }
  const limit = input.limit ?? 100;

  const coreR = await computeDeleteImpact(ctx, object);
  if (!coreR.ok) return err({ kind: 'internal', message: coreR.error.message });
  const core = coreR.value;

  const grantsR = await deleteGrants(ctx, objectId);
  if (!grantsR.ok) return grantsR;
  const grants = grantsR.value.grants;

  const declared = await declaredDeletePaths(ctx, objectId);
  const editBlocks = input.includeOmniStudio === false ? [] : await editBlockDeletePaths(ctx, object);

  const limitations: string[] = [];
  if (grantsR.value.systemPermsUnread > 0) {
    limitations.push(
      `${grantsR.value.systemPermsUnread} profile(s) / permission set(s) carry no extracted user permissions, so whether they grant Modify All Data (delete on every object) is unknown — re-run /sfi-refresh.`,
    );
  }
  const apex: ApexDeleteSite[] = [];
  const generic: ApexDeleteSite[] = [];
  if (input.includeApex !== false) {
    const index = await buildApexDmlIndex(ctx, ['delete']);
    if (index.ok) {
      const lower = object.toLowerCase();
      for (const f of index.value.facts) {
        const acts = dmlActsOn(f, object);
        if (acts === 'typed') {
          apex.push(await toApexSite(ctx, f, `the deleted operand is typed as ${object}`));
        } else if (acts === 'named') {
          const queried = f.objectsQueried.some((o) => o.toLowerCase() === lower);
          apex.push(
            await toApexSite(
              ctx,
              f,
              queried
                ? `the operand's type is not visible; the enclosing ${f.method === null ? 'trigger body' : 'method'} queries ${object}`
                : `the operand's type is not visible; the enclosing ${f.method === null ? 'code' : 'method'} names ${object}`,
            ),
          );
        } else if (acts === 'generic') {
          // Resolve the generic helper at its call sites (every non-test caller).
          const res = await resolveGenericDml(ctx, f, null, await objectNameIndex(ctx));
          if (res.status === 'closed') {
            if (res.objects.some((o) => o.toLowerCase() === lower)) {
              apex.push(await toApexSite(ctx, f, `a generic delete helper; its callers pass ${object} (${res.resolvedSites} call site(s) resolved)`));
            }
          } else if (res.status === 'open') {
            generic.push(await toApexSite(ctx, f, `the operand is a generic SObject: it deletes whatever records it is given${res.unresolved.length > 0 ? ` (e.g. ${res.unresolved[0]})` : ''}`));
          } else {
            // Not called by anything — it still runs when the class runs on its own.
            const node = await getNodeById(ctx.graph, f.componentId as ComponentId);
            if (node.ok && node.value !== null && isApexEntryClass(node.value)) {
              generic.push(await toApexSite(ctx, f, 'the operand is a generic SObject in a class the platform runs on its own (batch / schedule / trigger / UI-callable)'));
            }
          }
        }
      }
      if (index.value.unparsed.length > 0) limitations.push(`${index.value.unparsed.length} Apex file(s) did not parse; their delete statements are not seen: ${index.value.unparsed.slice(0, 5).join(', ')}${index.value.unparsed.length > 5 ? ', …' : ''}`);
      if (index.value.scanIncomplete) limitations.push('The Apex node scan stopped at its residual cap; some classes were not read.');
    } else {
      limitations.push(`The Apex delete scan failed: ${index.error.message}`);
    }
  }
  if (core.rollupScanTruncated) limitations.push('The roll-up summary scan hit the node-scan cap; some roll-ups may be missing.');
  if (core.cascadeTruncated) limitations.push('The cascade walk stopped at its depth limit; deeper cascaded records are not listed.');

  const findings: OmniFinding[] = [
    ...core.children.filter((c) => c.effect === 'ORPHANED').map((c) => childFinding(core, c)),
    ...inconsistentFindings(core),
  ];
  const ng = noGuardFinding(core, objectNode.value);
  if (ng !== null) findings.push(ng);
  findings.sort(compareFindings);

  const count = (effect: string): number => core.children.filter((c) => c.effect === effect).length;
  const truncated =
    grants.length > limit || declared.length > limit || editBlocks.length > limit || apex.length > limit || generic.length > limit;
  const inferred = editBlocks.length > 0 || apex.length > 0 || generic.length > 0;
  return ok({
    data: {
      appliedScope: { componentId: objectId, object },
      refreshedAt: ctx.manifest.refreshedAt,
      summary: {
        relationshipFields: core.children.length,
        directChildren: core.children.filter((c) => c.depth === 1).length,
        orphaned: count('ORPHANED'),
        deletedWithParent: count('DELETED_WITH_PARENT'),
        blocksDelete: count('BLOCKS_DELETE'),
        unknown: count('UNKNOWN'),
        guardStatus: core.guardStatus,
        activeGuards: core.guards.length,
        rollups: core.rollups.length,
        grants: grants.length,
        declaredDeletePaths: declared.length,
        editBlockDeletePaths: editBlocks.length,
        apexDeleteSites: apex.length,
        genericDeleteSites: generic.length,
      },
      children: core.children,
      guards: { status: core.guardStatus, active: core.guards, inactive: core.inactiveGuards, validationRulesNotRunOnDelete: core.validationRules },
      rollups: core.rollups,
      whoCanDelete: {
        grants: grants.slice(0, limit),
        grantsTotal: grants.length,
        declaredDeletes: declared.slice(0, limit),
        declaredDeletesTotal: declared.length,
        editBlocks: editBlocks.slice(0, limit),
        editBlocksTotal: editBlocks.length,
        apex: apex.slice(0, limit),
        apexTotal: apex.length,
        genericDeletes: generic.slice(0, limit),
        genericDeletesTotal: generic.length,
        truncated,
      },
      findings,
      boundaries: BOUNDARIES,
      trust: {
        provenance: 'offline_snapshot',
        confidence: inferred ? 'heuristic' : 'declared',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: limitations.length === 0 ? { status: 'complete' } : { status: 'partial', missingCoverage: limitations },
        limitations,
      },
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
