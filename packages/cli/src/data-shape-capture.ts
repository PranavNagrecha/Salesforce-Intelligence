/**
 * Data-shape capture (P13-FACTS-capture) — `sfi refresh --with-data-shape`.
 *
 * Captures a SMALL, budgeted set of record-DATA observations from the live
 * org into the graph's `facts` table (P13-FACTS-store):
 *
 *   1. Approximate per-object record counts — ONE REST call
 *      (`/limits/recordCount`), written for objects that exist as graph
 *      nodes (`method: 'rest-recordcount'`; Salesforce documents these
 *      counts as approximate, and they are STORAGE-level: for activity
 *      objects (Task/Event) they include ARCHIVED records, so they can
 *      legitimately exceed a plain SOQL `COUNT()` — verified live: 13.1M
 *      storage rows vs 8.5M queryable on one org's Task).
 *   2. Recent-sample field fill rates for the top-centrality objects — one
 *      SOQL per object over its most recently modified rows
 *      (`method: 'recent-sample'`, or `'exact-sample'` when the object's
 *      whole population fit inside the sample).
 *   3. Permission-holder AGGREGATE counts (P13-PSA-counts) — two GROUP-BY
 *      SOQL queries: active-assignee counts per PermissionSet and active-user
 *      counts per Profile (`method: 'aggregate-soql'`). COUNTS ONLY — the
 *      queries never select AssigneeId/username, and the PII grep test pins
 *      that nothing identifier-shaped lands in the facts.
 *
 * OPT-IN twice over: the flag requests capture AND the org must hold live
 * consent (`sfi.live_consent` / `SFI_LIVE_PLANE_ENABLED`) — without consent
 * the capture reports an honest skip, never an error, and the refresh stays
 * fully offline. Read-only by construction: every call is a GET/query.
 * Budgeted: at most `SFI_DATA_SHAPE_BUDGET` (default 60) API calls; hitting
 * the budget yields a disclosed partial capture. Executors are injectable so
 * unit tests run against a mocked org.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  listEdges,
  listNodesByType,
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  replaceFactsForMetricSource,
  writeFacts,
  type Fact,
  type GraphStore,
} from '@sf-intelligence/graph';
import { hasLiveConsent } from '@sf-intelligence/mcp';
import { getAuthFromSfCli } from '@sf-intelligence/tooling-api';

export const DATA_SHAPE_SOURCE = 'refresh-with-data-shape';
const DEFAULT_BUDGET = 60;
const TOP_OBJECTS_FOR_FILL = 5;
const FIELDS_PER_OBJECT = 20;
const SAMPLE_ROWS = 200;

/** Resolve the call budget from `SFI_DATA_SHAPE_BUDGET` (floor 5). */
export const dataShapeBudget = (): number => {
  const raw = process.env['SFI_DATA_SHAPE_BUDGET'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 5 ? Math.floor(n) : DEFAULT_BUDGET;
};

interface Auth {
  readonly instanceUrl: string;
  readonly accessToken: string;
  readonly apiVersion: string;
}

/** Injectable executors (tests pass fakes; production uses REST fetch). */
export interface DataShapeExecutors {
  readonly getAuth: (targetOrg: string) => Promise<Result<Auth, { readonly message: string }>>;
  readonly restGet: (auth: Auth, path: string) => Promise<Result<unknown, { readonly message: string }>>;
  readonly hasConsent: (targetOrg: string) => Promise<boolean>;
}

const apiBase = (auth: Auth): string => {
  const major = auth.apiVersion.replace(/^v/i, '').split('.')[0] ?? '62';
  return `${auth.instanceUrl}/services/data/v${major}.0`;
};

const productionExecutors = (): DataShapeExecutors => ({
  getAuth: async (targetOrg) => {
    const r = await getAuthFromSfCli(targetOrg);
    return r.ok ? ok(r.value) : err({ message: r.error.message });
  },
  restGet: async (auth, path) => {
    try {
      const response = await fetch(path, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!response.ok) {
        return err({ message: `Salesforce REST ${response.status}` });
      }
      return ok((await response.json()) as unknown);
    } catch (cause) {
      return err({ message: cause instanceof Error ? cause.message : String(cause) });
    }
  },
  hasConsent: async (targetOrg) => {
    if (process.env['SFI_LIVE_PLANE_ENABLED'] === '1' || process.env['SFI_LIVE_PLANE_ENABLED'] === 'true') {
      return true;
    }
    return hasLiveConsent(targetOrg);
  },
});

export interface DataShapeSummary {
  readonly ran: boolean;
  /** Why the capture did not run (consent/auth), when `ran` is false. */
  readonly skippedReason?: string;
  readonly apiCalls: number;
  readonly budget: number;
  readonly budgetExhausted: boolean;
  readonly recordCountFacts: number;
  readonly fillRateFacts: number;
  /** P13-PSA-counts: aggregate active-holder counts (PermissionSet/Profile). */
  readonly holderFacts: number;
}

/**
 * Run the budgeted capture and upsert facts. Best-effort by contract: every
 * failure path returns an honest summary (the refresh never fails on it).
 */
export const captureDataShape = async (
  store: GraphStore,
  targetOrg: string,
  options: {
    readonly now?: string;
    readonly budget?: number;
    readonly executors?: DataShapeExecutors;
  } = {},
): Promise<DataShapeSummary> => {
  const executors = options.executors ?? productionExecutors();
  const budget = options.budget ?? dataShapeBudget();
  const capturedAt = options.now ?? new Date().toISOString();
  let apiCalls = 0;
  const summary = (partial: Partial<DataShapeSummary>): DataShapeSummary => ({
    ran: false,
    apiCalls,
    budget,
    budgetExhausted: false,
    recordCountFacts: 0,
    fillRateFacts: 0,
    holderFacts: 0,
    ...partial,
  });

  if (!(await executors.hasConsent(targetOrg))) {
    return summary({
      skippedReason:
        'live consent not granted for this org — grant with sfi.live_consent { grant: true } (or SFI_LIVE_PLANE_ENABLED=1) and re-run',
    });
  }
  const auth = await executors.getAuth(targetOrg);
  if (!auth.ok) {
    return summary({ skippedReason: `org auth unavailable: ${auth.error.message}` });
  }

  // Graph-known objects, keyed by api name (counts only attach to real nodes).
  const objectsResult = await listNodesByType(store, 'CustomObject', { limit: 500 });
  const objects = objectsResult.ok ? objectsResult.value : [];
  const byApiName = new Map(objects.map((o) => [o.apiName, o]));

  // --- 1. approximate record counts: ONE call for the whole org -----------
  let recordCountFacts = 0;
  const counts = new Map<string, number>();
  if (apiCalls < budget) {
    apiCalls += 1;
    const result = await executors.restGet(auth.value, `${apiBase(auth.value)}/limits/recordCount`);
    if (result.ok) {
      const sObjects =
        (result.value as { readonly sObjects?: readonly { name?: string; count?: number }[] })
          .sObjects ?? [];
      const facts: Fact[] = [];
      for (const row of sObjects) {
        if (typeof row.name !== 'string' || typeof row.count !== 'number') continue;
        const node = byApiName.get(row.name);
        if (node === undefined) continue;
        counts.set(row.name, row.count);
        facts.push({
          subjectId: node.id as ComponentId,
          metric: 'recordCount',
          value: row.count,
          capturedAt,
          method: 'rest-recordcount',
          source: DATA_SHAPE_SOURCE,
        });
      }
      const wrote = await writeFacts(store, facts);
      recordCountFacts = wrote.ok ? wrote.value : 0;
    }
  }

  // --- 2. recent-sample fill rates for the top-centrality objects ---------
  // Top objects by inbound dependency edges (parentOf excluded), bounded.
  const ranked: { readonly apiName: string; readonly id: string; refs: number }[] = [];
  for (const obj of objects.slice(0, 200)) {
    const edges = await listEdges(store, obj.id, { direction: 'in' });
    if (!edges.ok) continue;
    ranked.push({
      apiName: obj.apiName,
      id: obj.id,
      refs: edges.value.filter((e) => e.edgeType !== 'parentOf').length,
    });
  }
  ranked.sort((a, b) => b.refs - a.refs || a.apiName.localeCompare(b.apiName));

  let fillRateFacts = 0;
  let budgetExhausted = false;
  for (const obj of ranked.slice(0, TOP_OBJECTS_FOR_FILL)) {
    if (apiCalls >= budget) {
      budgetExhausted = true;
      break;
    }
    // The object's own custom fields, capped, deterministic order.
    const childEdges = await listEdges(store, obj.id as ComponentId, { direction: 'out' });
    if (!childEdges.ok) continue;
    const fieldNames = childEdges.value
      .filter((e) => e.edgeType === 'parentOf' && e.toId.startsWith('CustomField:'))
      .map((e) => e.toId.slice(`CustomField:${obj.apiName}.`.length))
      .filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(f))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, FIELDS_PER_OBJECT);
    if (fieldNames.length === 0) continue;

    apiCalls += 1;
    const soql = `SELECT ${fieldNames.join(', ')} FROM ${obj.apiName} ORDER BY LastModifiedDate DESC LIMIT ${SAMPLE_ROWS}`;
    const result = await executors.restGet(
      auth.value,
      `${apiBase(auth.value)}/query?q=${encodeURIComponent(soql)}`,
    );
    if (!result.ok) continue;
    const records =
      (result.value as { readonly records?: readonly Record<string, unknown>[] }).records ?? [];
    if (records.length === 0) continue;
    const population = counts.get(obj.apiName);
    const exact = population !== undefined && population <= records.length;
    const facts: Fact[] = fieldNames.map((field) => {
      const filled = records.filter((r) => {
        const v = r[field];
        return v !== null && v !== undefined && v !== '' && v !== false;
      }).length;
      return {
        subjectId: `CustomField:${obj.apiName}.${field}` as ComponentId,
        metric: 'fillRate',
        value: {
          rate: Number((filled / records.length).toFixed(3)),
          sampleSize: records.length,
          exact,
        },
        capturedAt,
        method: exact ? 'exact-sample' : 'recent-sample',
        source: DATA_SHAPE_SOURCE,
      };
    });
    const wrote = await writeFacts(store, facts);
    fillRateFacts += wrote.ok ? wrote.value : 0;
  }

  // --- 3. permission-holder aggregates (P13-PSA-counts): COUNTS ONLY ------
  let holderFacts = 0;
  const holderQueries: ReadonlyArray<{
    readonly soql: string;
    readonly nodeType: 'PermissionSet' | 'Profile';
    readonly nameField: string;
  }> = [
    {
      soql: 'SELECT PermissionSet.Name name, COUNT(Id) holders FROM PermissionSetAssignment WHERE Assignee.IsActive = true GROUP BY PermissionSet.Name',
      nodeType: 'PermissionSet',
      nameField: 'name',
    },
    {
      soql: 'SELECT Profile.Name name, COUNT(Id) holders FROM User WHERE IsActive = true GROUP BY Profile.Name',
      nodeType: 'Profile',
      nameField: 'name',
    },
  ];
  const containers = new Map<string, string>(); // apiName key `${type}:${name}` -> node id
  let holderScopeComplete = true;
  for (const type of ['PermissionSet', 'Profile'] as const) {
    for (let offset = 0; ; offset += 500) {
      const nodesResult = await listNodesByType(store, type, { limit: 500, offset });
      if (!nodesResult.ok) {
        holderScopeComplete = false;
        break;
      }
      for (const n of nodesResult.value) containers.set(`${type}:${n.apiName}`, n.id);
      if (nodesResult.value.length < 500) break;
    }
  }

  const holderCounts = new Map<string, number>();
  for (const q of holderQueries) {
    if (!holderScopeComplete) break;
    if (apiCalls >= budget) {
      budgetExhausted = true;
      holderScopeComplete = false;
      break;
    }
    let nextUrl: string | undefined =
      `${apiBase(auth.value)}/query?q=${encodeURIComponent(q.soql)}`;
    while (nextUrl !== undefined) {
      if (apiCalls >= budget) {
        budgetExhausted = true;
        holderScopeComplete = false;
        break;
      }
      apiCalls += 1;
      const result = await executors.restGet(auth.value, nextUrl);
      if (!result.ok) {
        holderScopeComplete = false;
        break;
      }
      const payload = result.value as {
        readonly records?: readonly Record<string, unknown>[];
        readonly nextRecordsUrl?: unknown;
      };
      if (!Array.isArray(payload.records)) {
        holderScopeComplete = false;
        break;
      }
      for (const row of payload.records) {
        const name = row[q.nameField];
        const holders = row['holders'];
        if (typeof name !== 'string' || typeof holders !== 'number') {
          holderScopeComplete = false;
          break;
        }
        const key = `${q.nodeType}:${name}`;
        if (containers.has(key)) holderCounts.set(key, holders);
      }
      if (!holderScopeComplete) break;
      nextUrl =
        typeof payload.nextRecordsUrl === 'string'
          ? payload.nextRecordsUrl.startsWith('http')
            ? payload.nextRecordsUrl
            : `${auth.value.instanceUrl}${payload.nextRecordsUrl}`
          : undefined;
    }
  }

  // Only a complete graph scan + complete aggregate drain may replace the
  // holder scope. Explicit zero rows make absence factual; the sentinel lets
  // consumers reject legacy/partial captures that lack this proof.
  if (holderScopeComplete) {
    const facts: Fact[] = [...containers.entries()].map(([key, nodeId]) => ({
      subjectId: nodeId as ComponentId,
      metric: 'activeHolders',
      value: holderCounts.get(key) ?? 0,
      capturedAt,
      method: 'aggregate-soql',
      source: DATA_SHAPE_SOURCE,
    }));
    facts.push({
      subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
      metric: 'activeHolders',
      value: { complete: true, containerCount: containers.size },
      capturedAt,
      method: 'aggregate-soql',
      source: DATA_SHAPE_SOURCE,
    });
    const wrote = await replaceFactsForMetricSource(
      store,
      'activeHolders',
      DATA_SHAPE_SOURCE,
      facts,
    );
    holderFacts = wrote.ok ? containers.size : 0;
  }

  return summary({
    ran: true,
    apiCalls,
    budgetExhausted,
    recordCountFacts,
    fillRateFacts,
    holderFacts,
  });
};
