/**
 * Source-file fallback for Flow field writers the graph extractor missed —
 * especially SObject-variable `assignToReference` / `recordUpdates` paths
 * that never emit a `writesTo` edge (pre-bundle or non-$Record DML).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { countNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

export interface SupplementalFlowFieldWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly fieldApiName: string;
  readonly mechanism: 'inputAssignments' | 'assignToReference';
}

/**
 * The outcome of a {@link scanSupplementalFlowFieldWriters} walk.
 *
 * FLOW-WRITER-SCAN-CAPS-AT-500: this scan used to return a BARE
 * `readonly SupplementalFlowFieldWriter[]` produced from ONE
 * `listNodesByType(ctx.graph, 'Flow', { limit: 500, offset: 0 })` page. On an
 * org with more than 500 Flows, a supplemental field writer living past the cap
 * was simply absent from the answer, and — because the return type carried no
 * truncation signal at all — NEITHER caller (`field_360`, `why_field_changed`)
 * could disclose that anything had been missed. A field whose only writer is
 * Flow 501 read as "no supplemental writers", which is the exact silent
 * under-reporting the supplemental scan exists to eliminate.
 *
 * The shape mirrors its sibling `FlowConditionReaderScanResult`
 * (`flow-condition-field-readers-scan.ts`), which already pages everything and
 * reports `truncated` / `scannedCount` / `totalCount`, so the two supplemental
 * reconstructions disclose their boundaries identically.
 */
export interface SupplementalFlowWriterScanResult {
  /** One row per (Flow, mechanism) hit, sorted by `componentId`. */
  readonly writers: readonly SupplementalFlowFieldWriter[];
  /**
   * True when the Flow walk did NOT cover every Flow in the vault — it stopped
   * at the residual ceiling with more Flows behind it, or the graph query
   * failed outright. Either way a writer in the un-scanned tail is MISSED, so
   * the caller must disclose the cap rather than imply a complete scan. An
   * empty `writers` list under `truncated: true` is UNCHECKED, never "none".
   */
  readonly truncated: boolean;
  /** Flow nodes actually scanned (N in the "N of M" disclosure). */
  readonly scannedCount: number;
  /** Total Flow nodes in the vault (M). Computed only when truncated. */
  readonly totalCount: number;
}

/**
 * The residual ceiling on the full `Flow` scan. Defaults to the shared
 * {@link FULL_SCAN_MAX_NODES} (20 000 — far above any real org's Flow
 * population). `SFI_FLOW_WRITER_SCAN_MAX` overrides it so a test can exercise
 * the truncated path without seeding thousands of nodes, and an operator on a
 * pathological vault can raise it. Read at CALL time so a test can set it
 * per-case. Mirrors `SFI_CONDITION_SCAN_MAX` on the sibling scan.
 */
const flowWriterScanCeiling = (): number => {
  const v = Number(process.env['SFI_FLOW_WRITER_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
};

/** Parse `<variables>` blocks mapping var name → SObject objectType. */
const parseSObjectVariables = (xml: string): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const varBlock = /<variables>([\s\S]*?)<\/variables>/g;
  let m: RegExpExecArray | null;
  while ((m = varBlock.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const nameMatch = /<name>([^<]+)<\/name>/.exec(block);
    const typeMatch = /<dataType>([^<]+)<\/dataType>/.exec(block);
    const objMatch = /<objectType>([^<]+)<\/objectType>/.exec(block);
    if (
      nameMatch?.[1] !== undefined &&
      typeMatch?.[1] === 'SObject' &&
      objMatch?.[1] !== undefined
    ) {
      out.set(nameMatch[1], objMatch[1]);
    }
  }
  return out;
};

/**
 * Scan one Flow's XML for writes to `{objectApiName}.{fieldApiName}`.
 *
 * Exported for unit tests: the read/write scoping (only `<inputAssignments>`
 * inside a `<recordCreates>` / `<recordUpdates>` DML denotes a WRITE — a
 * `<field>` inside `<filters>` / `<outputAssignments>` is a READ) is the
 * invariant these tests lock, without needing a fixture vault + graph.
 */
export const scanFlowXml = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): ReadonlyArray<{ fieldApiName: string; mechanism: SupplementalFlowFieldWriter['mechanism'] }> => {
  const hits: Array<{ fieldApiName: string; mechanism: SupplementalFlowFieldWriter['mechanism'] }> =
    [];
  const sobjectVars = parseSObjectVariables(xml);

  // recordCreates/recordUpdates `<inputAssignments><field>` — the ONLY place a
  // bare `<field>` denotes a WRITE. The same tag also appears in `<filters>`
  // (a read predicate on the start element / a record lookup / a decision) and
  // in `<outputAssignments>` (reading a queried record's field into a var), so
  // an UNSCOPED `<field>NAME</field>` match reported reads as writes — e.g. a
  // field that only appears in a start-filter predicate became a phantom
  // writer. Scope the match to `<inputAssignments>` blocks nested inside a
  // record-create / record-update DML element. ($Record.<field> assignment
  // writes are emitted by the graph extractor's after-save/before-save
  // handler, which applies the persistence precondition; the supplemental scan
  // deliberately does not re-derive them here.)
  const escapedField = fieldApiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTagPattern = new RegExp(`<field>${escapedField}</field>`);
  const writesViaInputAssignments = (['recordCreates', 'recordUpdates'] as const).some(
    (tag) => {
      const dmlPattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
      let dml: RegExpExecArray | null;
      while ((dml = dmlPattern.exec(xml)) !== null) {
        const iaPattern = /<inputAssignments>[\s\S]*?<\/inputAssignments>/g;
        let ia: RegExpExecArray | null;
        while ((ia = iaPattern.exec(dml[0])) !== null) {
          if (fieldTagPattern.test(ia[0])) return true;
        }
      }
      return false;
    },
  );
  if (writesViaInputAssignments) {
    hits.push({ fieldApiName, mechanism: 'inputAssignments' });
  }

  // `<assignToReference>Var.Field</assignToReference>` on SObject vars for this object.
  const assignPattern = /<assignToReference>([^<]+)<\/assignToReference>/g;
  let am: RegExpExecArray | null;
  while ((am = assignPattern.exec(xml)) !== null) {
    const ref = am[1] ?? '';
    const dot = ref.indexOf('.');
    if (dot <= 0) continue;
    const varName = ref.slice(0, dot);
    const f = ref.slice(dot + 1);
    if (f !== fieldApiName) continue;
    const obj = sobjectVars.get(varName);
    if (obj === objectApiName) {
      hits.push({ fieldApiName: f, mechanism: 'assignToReference' });
    }
  }

  return hits;
};

/**
 * Scan deployed Flow source files for writes to `{objectApiName}.{fieldApiName}`
 * that the graph may not have stamped as `writesTo` edges.
 *
 * Pages EVERY Flow node (not just the first ≤500) via the shared
 * `scanAllNodesOfTypes` full-window walk, and REPORTS whether the walk was
 * complete — see {@link SupplementalFlowWriterScanResult}. A graph query error
 * yields an EMPTY, TRUNCATED result: nothing was scanned, so the empty writer
 * list is "not checked", never a proven "no supplemental writers".
 */
export const scanSupplementalFlowFieldWriters = async (
  ctx: Context,
  objectApiName: string,
  fieldApiName: string,
): Promise<SupplementalFlowWriterScanResult> => {
  const maxNodes = flowWriterScanCeiling();
  const flows = await scanAllNodesOfTypes(ctx.graph, ['Flow'], maxNodes);
  if (!flows.ok) {
    return { writers: [], truncated: true, scannedCount: 0, totalCount: 0 };
  }
  const out: SupplementalFlowFieldWriter[] = [];
  for (const node of flows.value.nodes) {
    if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) continue;
    try {
      const xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
      const hits = scanFlowXml(xml, objectApiName, fieldApiName);
      for (const hit of hits) {
        out.push({
          componentId: node.id,
          apiName: node.apiName,
          fieldApiName: hit.fieldApiName,
          mechanism: hit.mechanism,
        });
      }
    } catch {
      // unreadable source — skip
    }
  }
  out.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  const truncated = flows.value.scanIncomplete;
  const scannedCount = flows.value.nodes.length;
  // Only pay for the true total (M) when we actually need to disclose "N of M".
  let totalCount = scannedCount;
  if (truncated) {
    const total = await countNodesByType(ctx.graph, 'Flow');
    if (total.ok) totalCount = total.value;
  }
  return { writers: out, truncated, scannedCount, totalCount };
};
