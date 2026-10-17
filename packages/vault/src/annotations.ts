/**
 * the vault-local annotations overlay.
 *
 * Annotations are MEANING the org's metadata cannot carry: ownership
 * ("RevOps owns this field"), lifecycle status ("deprecated"), glossary
 * synonyms ("the SSN field"), domain grouping, free-form notes. They are
 * curated knowledge — human-stated (or AI-proposed and human-confirmed) —
 * never derived from the org, so they live OUTSIDE the graph in
 * `meta/annotations.jsonl` and survive every refresh (keyed by component
 * id, not by graph row).
 *
 * Storage model: append-only event log (`op: set | unset`), materialized
 * by LAST-WRITE-WINS per `(componentId, key)` at read time. Append-only
 * makes concurrent writers safe (an MCP server proposing while a human
 * annotates via CLI), history is preserved for free, and corrupt lines are
 * skipped — the overlay is curated context, never load-bearing truth.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The curated annotation keys. `note` is free-form; the rest are vocabularies. */
export const ANNOTATION_KEYS = ['owner', 'status', 'glossary', 'domain', 'note'] as const;
export type AnnotationKey = (typeof ANNOTATION_KEYS)[number];

/** One raw event line in `meta/annotations.jsonl`. */
export interface AnnotationEvent {
  readonly componentId: string;
  readonly key: AnnotationKey;
  /** Required for `set`; ignored for `unset`. */
  readonly value?: string;
  readonly author: string;
  /** `human` = stated by a person; `ai` = proposed by a model (unconfirmed until a human confirms). */
  readonly source: 'human' | 'ai';
  /** Confirmation is a HUMAN act — an `ai` event is born unconfirmed. */
  readonly confirmed: boolean;
  readonly at: string;
  readonly op: 'set' | 'unset';
}

/** One materialized annotation (the last-write-wins state of a (componentId, key) pair). */
export interface Annotation {
  readonly componentId: string;
  readonly key: AnnotationKey;
  readonly value: string;
  readonly author: string;
  readonly source: 'human' | 'ai';
  readonly confirmed: boolean;
  /** Stamp of the WINNING event. */
  readonly at: string;
}

/** Where the overlay lives inside a vault. */
export const annotationsPath = (vaultRoot: string): string =>
  join(vaultRoot, 'meta', 'annotations.jsonl');

/**
 * Append one annotation event. Best-effort: returns false (never throws) on
 * I/O failure — same posture as the demand queue and the gap log.
 *
 * @example
 *   await appendAnnotationEvent(vaultRoot, {
 *     componentId: 'CustomField:Contact.SSN__c', key: 'glossary',
 *     value: 'social security number', author: 'pranav', source: 'human',
 *     confirmed: true, at: new Date().toISOString(), op: 'set',
 *   });
 */
export const appendAnnotationEvent = async (
  vaultRoot: string,
  event: AnnotationEvent,
): Promise<boolean> => {
  try {
    const path = annotationsPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
};

const isValidEvent = (e: Partial<AnnotationEvent>): e is AnnotationEvent =>
  typeof e?.componentId === 'string' &&
  e.componentId.length > 0 &&
  typeof e?.key === 'string' &&
  (ANNOTATION_KEYS as readonly string[]).includes(e.key) &&
  typeof e?.at === 'string' &&
  (e.op === 'set' || e.op === 'unset') &&
  (e.op === 'unset' || typeof e.value === 'string');

/**
 * Materialize the event log: replay in file order, last write wins per
 * `(componentId, key)`, `unset` removes the pair. Absent/unreadable file →
 * empty overlay; corrupt or invalid lines are skipped. Sorted by
 * componentId then key for deterministic output.
 */
export const readAnnotations = async (
  vaultRoot: string,
): Promise<readonly Annotation[]> => {
  let raw: string;
  try {
    raw = await readFile(annotationsPath(vaultRoot), 'utf8');
  } catch {
    return [];
  }
  const state = new Map<string, Annotation>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let event: Partial<AnnotationEvent>;
    try {
      event = JSON.parse(line) as Partial<AnnotationEvent>;
    } catch {
      continue; // corrupt line — skip, never fail the read
    }
    if (!isValidEvent(event)) continue;
    const mapKey = `${event.componentId}\u0000${event.key}`;
    if (event.op === 'unset') {
      state.delete(mapKey);
    } else {
      state.set(mapKey, {
        componentId: event.componentId,
        key: event.key,
        value: event.value as string,
        author: typeof event.author === 'string' ? event.author : 'unknown',
        source: event.source === 'ai' ? 'ai' : 'human',
        confirmed: event.confirmed === true,
        at: event.at,
      });
    }
  }
  return [...state.values()].sort((a, b) =>
    a.componentId < b.componentId
      ? -1
      : a.componentId > b.componentId
        ? 1
        : a.key < b.key
          ? -1
          : 1,
  );
};

/** The materialized annotations for one component. */
export const annotationsFor = (
  annotations: readonly Annotation[],
  componentId: string,
): readonly Annotation[] =>
  annotations.filter((a) => a.componentId === componentId);
