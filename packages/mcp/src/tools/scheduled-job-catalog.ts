/**
 * Handler for the `sfi.scheduled_job_catalog` MCP tool.
 *
 * The v2.8 async-deep-tier surface for "which classes run on a
 * schedule, and when?". Walks the existing graph for two distinct
 * signals:
 *
 *   1. **ApexClass nodes with `properties.isSchedulable === true`**.
 *      These are classes implementing the `Schedulable` interface;
 *      they are schedule-CAPABLE but not necessarily currently
 *      scheduled (the actual schedule lives in the
 *      `CronTrigger`/`AsyncApexJob` Tooling API surface, which v2.8
 *      does not query in the offline path).
 *
 *   2. **`dispatchesAsync` edges with
 *      `properties.dispatchMechanism === 'schedule'`**. These are
 *      the v1.5 R3 producer's "System.schedule(...)" call sites the
 *      Apex scanner detected; each edge names the target class plus
 *      the caller. v2.8 surfaces the per-invocation pairing as the
 *      "scheduledByJobs" signal.
 *
 * Implementation notes:
 *   - When an ApexClass node also carries
 *     `properties.cronExpressions` (a hypothetical future
 *     enrichment from the apex-scanner) we surface those as the
 *     `cronExpressions` field on the catalog entry. v2.8's actual
 *     producer (the v1.5 scanner) does not populate this field; the
 *     tool reads it defensively so a future scanner upgrade lands
 *     without contract changes.
 *   - The catalog is per-class — one entry per Schedulable class.
 *     Classes that are Schedulable but lack any
 *     System.schedule(...) call site surface with empty
 *     `scheduledByCalls` / `cronExpressions` arrays.
 *   - Honesty axis (verbatim in `disclosure`): scanning for
 *     System.schedule(...) invocations is heuristic; the actual
 *     runtime schedule lives in the `CronTrigger`/`AsyncApexJob`
 *     Tooling API surface and is invisible to the offline DX-source
 *     scanner. A class flagged "schedulable" may NOT be currently
 *     scheduled — the schedule is a runtime registration.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Hard cap on the catalog size. Mirrors the
 * `INTEGRATION_MAP_MAX_LIMIT` ceiling so the v2.8 catalog tools share
 * the same blast-radius cap as the other enumeration-style tools.
 */
const SCHEDULED_JOB_CATALOG_MAX_CLASSES = 500;

/**
 * Zod schema for the `sfi.scheduled_job_catalog` tool input. The
 * tool takes no arguments — the catalog is intentionally org-wide so
 * the architect's "show me everything that's scheduled" question
 * resolves in one call.
 */
export const scheduledJobCatalogInputSchema = z.object({});

/** Parsed input shape, inferred from `scheduledJobCatalogInputSchema`. */
export type ScheduledJobCatalogInput = z.infer<
  typeof scheduledJobCatalogInputSchema
>;

/**
 * One "System.schedule" call site surfaced from a `dispatchesAsync`
 * edge with `properties.dispatchMechanism === 'schedule'`. The
 * `callerClassId` is the class that calls System.schedule(...); the
 * `cronExpression` is currently `null` because the v1.5 scanner
 * captures the dispatch shape but does NOT parse the second
 * argument (the cron string). A future scanner upgrade can
 * populate it without contract changes.
 */
export interface ScheduledCall {
  readonly callerClassId: ComponentId;
  readonly cronExpression: string | null;
}

/** One entry in the scheduled-job catalog. */
export interface ScheduledJobEntry {
  readonly classId: ComponentId;
  readonly apiName: string;
  readonly isSchedulable: boolean;
  readonly scheduledByCalls: readonly ScheduledCall[];
  readonly cronExpressions: readonly string[];
}

/**
 * T7: one scheduled-Flow entry. Sourced from the Flow node's design-time
 * `<start><schedule>` block (stamped by the flow extractor as the
 * `scheduleFrequency` / `scheduleStartDate` / `scheduleStartTime` node
 * properties). `startTime` is UTC — see {@link SCHEDULED_FLOW_DISCLOSURE}.
 * This is the FLOW's declared schedule, distinct from the Apex
 * `CronTrigger` runtime registration captured above.
 */
export interface ScheduledFlowEntry {
  readonly flowId: ComponentId;
  readonly apiName: string;
  readonly frequency: string | null;
  readonly startDate: string | null;
  /** UTC time-of-day (trailing `Z`); local run time needs the org timezone. */
  readonly startTimeUtc: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ScheduledJobCatalogOutput {
  readonly jobs: readonly ScheduledJobEntry[];
  readonly scheduledFlows: readonly ScheduledFlowEntry[];
  readonly summary: {
    readonly totalSchedulableClasses: number;
    readonly classesWithKnownCallers: number;
    readonly totalScheduledFlows: number;
  };
  readonly disclosure: string;
  readonly flowScheduleDisclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response. The
 * v2.8 catalog answers from offline DX-source signals only —
 * runtime CronTrigger / AsyncApexJob state is invisible. A class
 * flagged as `isSchedulable: true` may NOT be currently scheduled,
 * and the cron expression for each scheduled call is captured only
 * when the v1.5 scanner could parse it from the
 * System.schedule(...) call site (a literal cron string).
 */
const SCHEDULED_JOB_CATALOG_DISCLOSURE =
  'Scanning for System.schedule() invocations is heuristic — the v0.3 Apex scanner detects literal call sites only, NOT runtime registration via Tooling API. Runtime schedules require Tooling API access (CronTrigger / AsyncApexJob). A class flagged `isSchedulable: true` may not currently be scheduled; conversely, a class scheduled via a helper-wrapper or dynamic class load is invisible to the scanner.';

/**
 * T7: verbatim honesty disclosure for the `scheduledFlows` section.
 * Scheduled Flows declare their cadence in metadata (`<start><schedule>`),
 * so this schedule is parsed, not inferred — but `startTimeUtc` is in UTC
 * (the metadata `<startTime>` carries a trailing `Z`, e.g.
 * `08:00:00.000Z`); the local wall-clock run time depends on the org's
 * default timezone, which the vault does NOT hold. This is the FLOW's
 * design-time schedule and is DISTINCT from the Apex `CronTrigger` /
 * `AsyncApexJob` runtime registration above, which remains Tooling-API-only.
 */
const SCHEDULED_FLOW_DISCLOSURE =
  'Scheduled-Flow cadence is read from the flow metadata `<start><schedule>` (declared, not inferred). `startTimeUtc` is UTC (the metadata `<startTime>` ends in `Z`, e.g. `08:00:00.000Z`); the local run time depends on the org default timezone, which is not in the vault. This is the Flow design-time schedule, distinct from the Apex CronTrigger runtime registration (Tooling-API-only).';

/**
 * Read the `cronExpressions` property defensively. v2.8's actual
 * producer (the v1.5 scanner) does not populate this field, but a
 * future scanner upgrade may write a string array. We accept that
 * shape and pass through any other shape as an empty array.
 */
const readCronExpressions = (
  properties: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const raw = properties['cronExpressions'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Read the optional `cronExpression` property from a
 * `dispatchesAsync` edge. v2.8's actual producer (v1.5) does not
 * populate this; a future scanner upgrade may. We accept the value
 * verbatim if it's a non-empty string, otherwise null.
 */
const readEdgeCronExpression = (
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const raw = properties['cronExpression'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Read the `isSchedulable` flag from a node. v1.5 R3 writes a
 * boolean; we narrow to a safe `true` only when the value is
 * actually true (a missing or false value yields false).
 */
const readIsSchedulable = (
  properties: Readonly<Record<string, unknown>>,
): boolean => properties['isSchedulable'] === true;

/**
 * Walk every incoming `dispatchesAsync` edge to `classId` and
 * narrow to the schedule-dispatch subset (the v1.5 producer marks
 * these with `properties.dispatchMechanism === 'schedule'`). The
 * caller's id and any per-edge cron expression are returned for
 * surface inclusion in the catalog entry.
 */
const collectScheduledCalls = async (
  ctx: Context,
  classId: ComponentId,
): Promise<Result<readonly ScheduledCall[], string>> => {
  const edgesResult = await listEdges(ctx.graph, classId, {
    direction: 'in',
    edgeType: 'dispatchesAsync',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const calls: ScheduledCall[] = [];
  for (const edge of edgesResult.value) {
    if (edge.properties['dispatchMechanism'] === 'schedule') {
      calls.push({
        callerClassId: edge.fromId,
        cronExpression: readEdgeCronExpression(edge.properties),
      });
    }
  }
  return ok(calls);
};

/**
 * Read an optional non-empty string Flow schedule property, returning
 * null for missing / non-string / empty values.
 */
const readScheduleString = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * A Flow node is "scheduled" when the extractor stamped a
 * `scheduleFrequency` (only scheduled flows carry a `<start><schedule>`
 * block). We gate on frequency presence so non-scheduled flows (which
 * leave all three schedule props null) are excluded.
 */
const isScheduledFlow = (
  properties: Readonly<Record<string, unknown>>,
): boolean => readScheduleString(properties, 'scheduleFrequency') !== null;

/**
 * Deterministic comparator: flowId ASC.
 */
const compareFlows = (a: ScheduledFlowEntry, b: ScheduledFlowEntry): number =>
  a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0;

/**
 * Deterministic comparator: classId ASC. Catalog entries render in
 * lexicographic order so multi-page consumers can iterate stably.
 */
const compareEntries = (
  a: ScheduledJobEntry,
  b: ScheduledJobEntry,
): number => (a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0);

/**
 * Deterministic call comparator: callerClassId ASC. Sub-entries
 * inside one catalog entry render stably as well.
 */
const compareCalls = (a: ScheduledCall, b: ScheduledCall): number =>
  a.callerClassId < b.callerClassId
    ? -1
    : a.callerClassId > b.callerClassId
      ? 1
      : 0;

/**
 * The `sfi.scheduled_job_catalog` MCP tool. Takes no arguments;
 * returns one entry per Schedulable class with the per-class
 * "scheduledByCalls" surfaced from inbound `dispatchesAsync` edges
 * with `dispatchMechanism === 'schedule'`.
 *
 * @example
 *   const r = await scheduledJobCatalogHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.summary.totalSchedulableClasses);
 */
export const scheduledJobCatalogHandler = async (
  ctx: Context,
  _input: ScheduledJobCatalogInput,
): Promise<Result<McpResponse<ScheduledJobCatalogOutput>, McpError>> => {
  // Underscore parameter signals "input intentionally unused"; the
  // signature still mirrors the other handlers for the
  // `dispatchTool` switch's homogeneous Result<McpResponse<T>, ...>
  // return shape.
  void _input;

  const apexClassesResult = await listNodesByType(ctx.graph, 'ApexClass', {
    limit: SCHEDULED_JOB_CATALOG_MAX_CLASSES,
  });
  if (!apexClassesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${apexClassesResult.error.message}`,
    });
  }

  const jobs: ScheduledJobEntry[] = [];
  let classesWithKnownCallers = 0;
  for (const node of apexClassesResult.value as readonly Node[]) {
    if (!readIsSchedulable(node.properties)) continue;
    const callsResult = await collectScheduledCalls(ctx, node.id);
    if (!callsResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${callsResult.error}`,
      });
    }
    const cronExpressions = readCronExpressions(node.properties);
    const calls = [...callsResult.value].sort(compareCalls);
    if (calls.length > 0) classesWithKnownCallers++;
    jobs.push({
      classId: node.id,
      apiName: node.apiName,
      isSchedulable: true,
      scheduledByCalls: calls,
      cronExpressions,
    });
  }

  const sorted = jobs.sort(compareEntries);

  // T7: scheduled Flows from <start><schedule>.
  const flowsResult = await listNodesByType(ctx.graph, 'Flow', {
    limit: SCHEDULED_JOB_CATALOG_MAX_CLASSES,
  });
  if (!flowsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${flowsResult.error.message}`,
    });
  }
  const scheduledFlows: ScheduledFlowEntry[] = [];
  for (const node of flowsResult.value as readonly Node[]) {
    if (!isScheduledFlow(node.properties)) continue;
    scheduledFlows.push({
      flowId: node.id,
      apiName: node.apiName,
      frequency: readScheduleString(node.properties, 'scheduleFrequency'),
      startDate: readScheduleString(node.properties, 'scheduleStartDate'),
      startTimeUtc: readScheduleString(node.properties, 'scheduleStartTime'),
    });
  }
  const sortedFlows = scheduledFlows.sort(compareFlows);

  return ok({
    data: {
      jobs: sorted,
      scheduledFlows: sortedFlows,
      summary: {
        totalSchedulableClasses: sorted.length,
        classesWithKnownCallers,
        totalScheduledFlows: sortedFlows.length,
      },
      disclosure: SCHEDULED_JOB_CATALOG_DISCLOSURE,
      flowScheduleDisclosure: SCHEDULED_FLOW_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
