/**
 * P13-STAGED-demand-queue — the vault-local demand-retrieve queue.
 *
 * When an MCP consumer ASKS for a component that turns out to be an
 * automation-critical phantom (referenced by retrieved automation but never
 * itself retrieved), the hit is recorded here so a later
 * `sfi refresh --drain-demand-queue` (or the watch daemon) can pull exactly
 * the components real questions actually needed — demand-driven retrieve,
 * never retrieve-all (the 700+ grant-only trap).
 *
 * Storage model: `meta/demand-queue.jsonl`, an APPEND-ONLY event log
 * (`hit` and `drain` records), folded into per-id state at read time:
 *
 *   - a `hit` queues the id (or re-queues it after a drain — the org may
 *     have re-referenced it);
 *   - a `drain` records the outcome (`retrieved` / `already-present` /
 *     `refused`) for the id's hits so far.
 *
 * Append-only makes concurrent writers safe (the MCP server appends hits
 * while a drain runs), dedup falls out of the fold (N hits on one id are
 * ONE queued entry with `hits: N`), and draining twice is idempotent (a
 * second drain record changes nothing material). Corrupt lines are skipped
 * — the queue is an optimization surface, never load-bearing truth.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where the queue lives inside a vault. */
export const demandQueuePath = (vaultRoot: string): string =>
  join(vaultRoot, 'meta', 'demand-queue.jsonl');

/** One raw event line. `hit` = a consumer needed the phantom; `drain` = a drain attempt's outcome. */
interface DemandQueueEvent {
  readonly kind: 'hit' | 'drain';
  readonly id: string;
  readonly at: string;
  /** hit: phantom classification at hit time (e.g. `automation-critical`). */
  readonly classification?: string;
  /** hit: which consumer recorded it (e.g. `get_component`, `watch`). */
  readonly source?: string;
  /** drain: what happened. */
  readonly outcome?: 'retrieved' | 'already-present' | 'refused';
  /** drain: refusal reason, when refused. */
  readonly reason?: string;
}

/** Folded per-id state served to consumers. */
export interface DemandQueueEntry {
  readonly id: string;
  readonly classification: string;
  /**
   * `queued` — hit(s) with no later drain; `drained` — last drain retrieved
   * it (or it was already present); `refused` — last drain refused it (it
   * will not be re-drained unless a NEW hit re-queues it).
   */
  readonly status: 'queued' | 'drained' | 'refused';
  readonly hits: number;
  readonly firstHitAt: string;
  readonly lastHitAt: string;
  readonly sources: readonly string[];
  readonly drainedAt?: string;
  readonly drainOutcome?: 'retrieved' | 'already-present' | 'refused';
  readonly drainReason?: string;
}

const appendEvent = async (
  vaultRoot: string,
  event: DemandQueueEvent,
): Promise<boolean> => {
  try {
    const path = demandQueuePath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false; // best-effort — same posture as the question-gap log
  }
};

/**
 * Record that a consumer needed `id` and found a phantom. Best-effort:
 * returns false (never throws) on I/O failure — a queue write must never
 * break the answer that triggered it.
 *
 * @example
 *   await appendDemandHit(ctx.vaultRoot, 'CustomObject:Acme__c', 'automation-critical', 'get_component');
 */
export const appendDemandHit = async (
  vaultRoot: string,
  id: string,
  classification: string,
  source: string,
): Promise<boolean> =>
  appendEvent(vaultRoot, {
    kind: 'hit',
    id,
    at: new Date().toISOString(),
    classification,
    source,
  });

/** Record a drain attempt's outcome for `id`. Best-effort, never throws. */
export const appendDrainResult = async (
  vaultRoot: string,
  id: string,
  outcome: 'retrieved' | 'already-present' | 'refused',
  reason?: string,
): Promise<boolean> =>
  appendEvent(vaultRoot, {
    kind: 'drain',
    id,
    at: new Date().toISOString(),
    outcome,
    ...(reason !== undefined ? { reason } : {}),
  });

/**
 * Fold the event log into per-id entries (sorted by first hit). Absent or
 * unreadable file → empty queue. Corrupt lines are skipped.
 */
export const readDemandQueue = async (
  vaultRoot: string,
): Promise<readonly DemandQueueEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(demandQueuePath(vaultRoot), 'utf8');
  } catch {
    return [];
  }
  interface Fold {
    classification: string;
    hits: number;
    firstHitAt: string;
    lastHitAt: string;
    sources: Set<string>;
    queued: boolean;
    drainedAt?: string;
    drainOutcome?: 'retrieved' | 'already-present' | 'refused';
    drainReason?: string;
  }
  const byId = new Map<string, Fold>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let event: DemandQueueEvent;
    try {
      event = JSON.parse(line) as DemandQueueEvent;
    } catch {
      continue; // corrupt line — skip, never fail the read
    }
    if (typeof event?.id !== 'string' || event.id.length === 0) continue;
    if (event.kind === 'hit') {
      const prior = byId.get(event.id);
      if (prior === undefined) {
        byId.set(event.id, {
          classification: event.classification ?? 'unknown',
          hits: 1,
          firstHitAt: event.at,
          lastHitAt: event.at,
          sources: new Set(event.source !== undefined ? [event.source] : []),
          queued: true,
        });
      } else {
        prior.hits += 1;
        prior.lastHitAt = event.at;
        if (event.source !== undefined) prior.sources.add(event.source);
        prior.queued = true; // a hit after a drain RE-queues
      }
    } else if (event.kind === 'drain' && event.outcome !== undefined) {
      const prior = byId.get(event.id);
      if (prior === undefined) continue; // drain for an id never hit — ignore
      prior.queued = false;
      prior.drainedAt = event.at;
      prior.drainOutcome = event.outcome;
      if (event.reason !== undefined) prior.drainReason = event.reason;
      else delete prior.drainReason;
    }
  }
  return [...byId.entries()]
    .map(([id, f]) => ({
      id,
      classification: f.classification,
      status: f.queued
        ? ('queued' as const)
        : f.drainOutcome === 'refused'
          ? ('refused' as const)
          : ('drained' as const),
      hits: f.hits,
      firstHitAt: f.firstHitAt,
      lastHitAt: f.lastHitAt,
      sources: [...f.sources].sort(),
      ...(f.drainedAt !== undefined ? { drainedAt: f.drainedAt } : {}),
      ...(f.drainOutcome !== undefined ? { drainOutcome: f.drainOutcome } : {}),
      ...(f.drainReason !== undefined ? { drainReason: f.drainReason } : {}),
    }))
    .sort((a, b) => (a.firstHitAt < b.firstHitAt ? -1 : a.firstHitAt > b.firstHitAt ? 1 : a.id < b.id ? -1 : 1));
};

/** The ids a drain should process: queued, automation-critical only. */
export const queuedDrainIds = (
  entries: readonly DemandQueueEntry[],
): readonly string[] =>
  entries
    .filter((e) => e.status === 'queued' && e.classification === 'automation-critical')
    .map((e) => e.id);
