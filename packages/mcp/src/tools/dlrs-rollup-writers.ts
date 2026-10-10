/**
 * DLRS rollup definitions as field WRITERS (WOW-3 / C10). The extractor turns
 * each `dlrs__LookupRollupSummary2` custom metadata record into a `writesTo`
 * edge (source `dlrs-rollup`) into the rollup's target field. The record node
 * is a generic CustomMetadataRecord, so its run state and rollup shape live on
 * the EDGE; this module reads them so `why_field_changed` can present the
 * rollup as what it is — a recalculation fired by saves on the CHILD object —
 * instead of a runnable-by-default metadata record.
 *
 * Kept separate from the Flow writer scan on purpose: it is its own writer
 * source, not a variant of the Flow one.
 */

import type { Edge } from '@sf-intelligence/contracts';

/** What `why_field_changed` adds to a writer row for a DLRS rollup. */
export interface DlrsRollupWriterDetail {
  readonly runnable: boolean;
  readonly status: 'Active' | 'Inactive';
  readonly rollup: {
    readonly engine: 'dlrs';
    readonly childObject: string | null;
    readonly aggregateOperation: string | null;
    readonly fieldToAggregate: string | null;
    readonly calculationMode: string | null;
    /** Plain-English: when this writer fires. */
    readonly firesWhen: string;
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The DLRS detail for a `writesTo` edge, or `undefined` when it is not a DLRS edge. */
export const dlrsRollupWriterDetail = (edge: Edge): DlrsRollupWriterDetail | undefined => {
  if (edge.source !== 'dlrs-rollup') return undefined;
  const active = edge.properties['active'] === true;
  const childObject = str(edge.properties['childObject']);
  const calculationMode = str(edge.properties['calculationMode']);
  const child = childObject ?? 'the child object';
  const firesWhen =
    calculationMode === null || /^realtime$/i.test(calculationMode)
      ? `recalculated by the DLRS trigger when a ${child} record is inserted, updated, deleted or undeleted`
      : `recalculated by DLRS in ${calculationMode} mode (not on every ${child} save — scheduled or on demand)`;
  return {
    runnable: active,
    status: active ? 'Active' : 'Inactive',
    rollup: {
      engine: 'dlrs',
      childObject,
      aggregateOperation: str(edge.properties['aggregateOperation']),
      fieldToAggregate: str(edge.properties['fieldToAggregate']),
      calculationMode,
      firesWhen,
    },
  };
};
