/**
 * Org-card input assembly (P13-CARD-render) — derives EVERY number on the
 * card from the graph/manifest, so each is independently re-derivable (the
 * unit tests assert exactly that). The renderer itself is pure
 * (`@sf-intelligence/renderers` `renderOrgCard`); this module is the only
 * place card data is computed.
 *
 * Determinism: all lists are explicitly sorted (count desc, then id/label
 * asc); scans use the bounded graph queries (listNodesByType ≤500). The
 * wall-clock stamp is the caller's to supply (refresh passes `refreshedAt`).
 */

import type { ComponentId, VaultManifest } from '@sf-intelligence/contracts';
import {
  countNodesByType,
  listEdges,
  listNodesByType,
  readFacts,
  type GraphStore,
} from '@sf-intelligence/graph';
import { recognizeNamingConventions } from '@sf-intelligence/patterns';
import type {
  OrgCardAutomationRow,
  OrgCardInput,
  OrgCardNamingObservation,
  OrgCardTopObject,
} from '@sf-intelligence/renderers';
import { buildCoverageEntries, summarizeCoverage } from '@sf-intelligence/vault';

/** Mirrors org_overview's ranking scan bound — disclosed on the card. */
const OBJECT_SCAN_CAP = 200;
const TOP_OBJECT_COUNT = 20;
const AUTOMATION_TYPES = ['Flow', 'ApexTrigger', 'WorkflowRule', 'ApprovalProcess'] as const;
const INTEGRATION_TYPES = [
  'AuthProvider',
  'NamedCredential',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'ConnectedApp',
  'NetworkAccess',
] as const;
const GOD_MODE_PERMS = new Set(['ViewAllData', 'ModifyAllData']);

/** Active-automation heuristic, mirroring org_overview's status reading. */
const isActiveAutomation = (type: string, properties: Readonly<Record<string, unknown>>): boolean => {
  if (type === 'Flow') return properties['status'] === 'Active';
  if (type === 'WorkflowRule' || type === 'ApprovalProcess') {
    return properties['active'] === true || properties['active'] === 'true';
  }
  return true; // ApexTrigger carries no activation flag in metadata
};

const holdsGodMode = (properties: Readonly<Record<string, unknown>>): boolean => {
  const perms = properties['userPermissions'];
  return (
    Array.isArray(perms) && perms.some((p) => typeof p === 'string' && GOD_MODE_PERMS.has(p))
  );
};

/**
 * Assemble the card input from the fresh graph + manifest. Read-only; never
 * throws on partial data — empty sections render honestly as empty.
 */
export const buildOrgCardInput = async (
  manifest: VaultManifest,
  store: GraphStore,
  generatedAt: string,
): Promise<OrgCardInput> => {
  // Scale — straight off the manifest (already authoritative counts).
  const componentCounts = Object.entries(manifest.components)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const totalComponents = componentCounts.reduce((s, [, n]) => s + n, 0);
  const totalEdges = Object.values(manifest.edges).reduce(
    (s: number, n) => s + (typeof n === 'number' ? n : 0),
    0,
  );

  // Coverage & blind spots — the canonical vault helpers.
  const coverageSummary = summarizeCoverage(manifest);
  const entries = buildCoverageEntries(manifest);
  const erroredTypes = entries
    .filter((e) => e.errored)
    .map((e) => e.type)
    .sort((a, b) => a.localeCompare(b));

  // Top objects by inbound dependency edges (parentOf excluded — containment
  // is not usage), over a bounded, id-ordered object scan.
  const objectsResult = await listNodesByType(store, 'CustomObject', { limit: OBJECT_SCAN_CAP });
  const objects = objectsResult.ok ? [...objectsResult.value].sort((a, b) => a.id.localeCompare(b.id)) : [];
  const ranked: OrgCardTopObject[] = [];
  for (const obj of objects) {
    const edgesResult = await listEdges(store, obj.id, { direction: 'in' });
    if (!edgesResult.ok) continue;
    const inboundRefs = edgesResult.value.filter((e) => e.edgeType !== 'parentOf').length;
    ranked.push({ id: obj.id, inboundRefs });
  }
  ranked.sort((a, b) => b.inboundRefs - a.inboundRefs || a.id.localeCompare(b.id));
  const topObjects = ranked.slice(0, TOP_OBJECT_COUNT);

  // Automation density. Totals are exact (countNodesByType); active flags are
  // read over the bounded scan (≤500 — exact on every org seen so far).
  const automation: OrgCardAutomationRow[] = [];
  for (const type of AUTOMATION_TYPES) {
    const totalResult = await countNodesByType(store, type);
    const nodesResult = await listNodesByType(store, type, { limit: 500 });
    const nodes = nodesResult.ok ? nodesResult.value : [];
    automation.push({
      type,
      total: totalResult.ok ? totalResult.value : nodes.length,
      active: nodes.filter((n) => isActiveAutomation(type, n.properties)).length,
    });
  }

  // Permissions posture.
  const profileCountResult = await countNodesByType(store, 'Profile');
  const permSetCountResult = await countNodesByType(store, 'PermissionSet');
  let godModeContainers = 0;
  let godModeScanCount = 0;
  for (const type of ['Profile', 'PermissionSet'] as const) {
    const nodesResult = await listNodesByType(store, type, { limit: 500 });
    if (!nodesResult.ok) continue;
    godModeScanCount += nodesResult.value.length;
    godModeContainers += nodesResult.value.filter((n) => holdsGodMode(n.properties)).length;
  }

  // Integration surface — exact counts, zero rows dropped from the card.
  const integrations: Array<readonly [string, number]> = [];
  for (const type of INTEGRATION_TYPES) {
    const result = await countNodesByType(store, type);
    if (result.ok && result.value > 0) integrations.push([type, result.value] as const);
  }
  integrations.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Data-shape facts (P13-FACTS-consumers): captured approximate counts for
  // the top objects, when the vault holds them. Graph state — deterministic.
  const factCounts: Array<readonly [string, number]> = [];
  let factStamp: string | null = null;
  for (const top of topObjects) {
    const rows = await readFacts(store, { subjectId: top.id, metric: 'recordCount', limit: 1 });
    if (!rows.ok || rows.value.length === 0) continue;
    const fact = rows.value[0];
    if (fact === undefined || typeof fact.value !== 'number') continue;
    factCounts.push([fact.subjectId.split(':')[1] ?? fact.subjectId, fact.value] as const);
    if (factStamp === null || fact.capturedAt > factStamp) factStamp = fact.capturedAt;
  }

  // Naming conventions — observed heuristics, top 5 by support.
  const namingResult = await recognizeNamingConventions(store);
  const naming: OrgCardNamingObservation[] = (namingResult.ok ? namingResult.value : [])
    .map((o) => ({ pattern: o.statement, matching: o.evidence.matching, total: o.evidence.total }))
    .sort((a, b) => b.matching - a.matching || a.pattern.localeCompare(b.pattern))
    .slice(0, 5);

  return {
    generatedAt,
    sourceTreeHash: manifest.sourceTreeHash,
    refreshedAt: manifest.refreshedAt,
    targetOrg: manifest.sourceOrg,
    componentCounts,
    totalComponents,
    totalEdges,
    coverage: {
      status: coverageSummary.status,
      coveredTypeCount: coverageSummary.coveredTypes.length,
      partialTypes: coverageSummary.partialTypes,
      notModeledTypes: coverageSummary.notModeledTypes,
      erroredTypes,
    },
    topObjects,
    objectScanCount: objects.length,
    automation,
    permissions: {
      profileCount: profileCountResult.ok ? profileCountResult.value : 0,
      permissionSetCount: permSetCountResult.ok ? permSetCountResult.value : 0,
      godModeContainers,
      godModeScanCount,
    },
    integrations,
    naming,
    ...(factCounts.length > 0 && factStamp !== null
      ? { dataShape: { capturedAt: factStamp, counts: factCounts } }
      : {}),
  };
};

/** Re-exported for the refresh hook's id-type needs (kept minimal). */
export type { ComponentId };
