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
  /**
   * `scoped` — the write's target object resolved to the asked-about object.
   * `unresolved` — an `<inputAssignments>` DML whose object could not be
   * resolved from source: a LEAD, not proof the Flow writes this object.
   * (A DML resolved to a DIFFERENT object is never returned.)
   */
  readonly objectScope: 'scoped' | 'unresolved';
}

/**
 * WHY the scan fell short. `truncated` is the UNION safety flag (a caller that
 * only knows "is this proven?" reads that and nothing else); this discriminant
 * says which axis fired, because the two have DIFFERENT causes and DIFFERENT
 * remedies and a caller that hardcodes one of them misdiagnoses the other.
 *
 * - `none`               — every Flow node was walked AND every source read.
 * - `scan-ceiling`       — the graph walk stopped at the residual ceiling
 *                          (`SFI_FLOW_WRITER_SCAN_MAX`). There IS an un-scanned
 *                          tail; raising the ceiling recovers it.
 * - `unreadable-sources` — the graph walk was COMPLETE; one or more Flow SOURCE
 *                          FILES could not be opened. There is NO un-scanned
 *                          tail and raising the ceiling recovers NOTHING — the
 *                          remedy is to re-refresh the vault / restore source.
 * - `both`               — both axes fired.
 * - `graph-error`        — the Flow graph query failed outright; NOTHING was
 *                          scanned. Neither remedy above applies.
 */
export type SupplementalFlowWriterScanTruncationCause =
  | 'none'
  | 'scan-ceiling'
  | 'unreadable-sources'
  | 'both'
  | 'graph-error';

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
 * FLOW-WRITER-SCAN-TWO-AXES: `truncated` alone is NOT enough for a caller to
 * explain itself. Two independent things can leave the writer set unproven —
 * a capped graph walk and an unreadable source tree — and they take OPPOSITE
 * remedies. Collapsing them into one boolean traded a silent false-clean for a
 * loud false-CAUSE: every caller hardcoded "capped at the full-scan ceiling,
 * raise SFI_FLOW_WRITER_SCAN_MAX", which is actively wrong advice when the
 * walk was complete and the source files had rotted. So the shape carries the
 * axes SEPARATELY ({@link capExceeded}, {@link unreadableCount},
 * {@link scanFailed}) plus a {@link truncationCause} discriminant, and
 * {@link describeSupplementalFlowWriterScanBoundary} renders the one honest
 * sentence so the three callers do not each write their own (and drift).
 *
 * The shape mirrors its sibling `FlowConditionReaderScanResult`
 * (`flow-condition-field-readers-scan.ts`), which already pages everything and
 * carries `scanFailed` / `scanError` ALONGSIDE `truncated` for exactly this
 * reason, so the two supplemental reconstructions disclose their boundaries
 * identically.
 */
export interface SupplementalFlowWriterScanResult {
  /** One row per (Flow, mechanism) hit, sorted by `componentId`. */
  readonly writers: readonly SupplementalFlowFieldWriter[];
  /**
   * The UNION safety flag: true when the writer set is NOT proven, for ANY
   * reason — the graph walk stopped short, the graph query failed, or a Flow
   * source file could not be read. An empty `writers` list under
   * `truncated: true` is UNCHECKED, never "none". Kept as the union so no
   * existing caller silently loses the flag; use {@link truncationCause} (or
   * {@link describeSupplementalFlowWriterScanBoundary}) to say WHY.
   */
  readonly truncated: boolean;
  /**
   * True when the graph walk itself stopped at the residual ceiling with more
   * Flow nodes behind it — an un-scanned TAIL exists and raising
   * `SFI_FLOW_WRITER_SCAN_MAX` recovers it. False on the source-read axis.
   */
  readonly capExceeded: boolean;
  /**
   * Flow nodes the walk REACHED but whose source was never opened — no
   * `sourcePath` on record, or nothing readable at that path. These are NOT in
   * an un-scanned tail and NO ceiling change recovers them; the vault's source
   * tree is the problem. 0 when every reached Flow was read.
   */
  readonly unreadableCount: number;
  /** True when the Flow graph query failed outright and NOTHING was scanned. */
  readonly scanFailed: boolean;
  /** The graph error message when {@link scanFailed}; `null` otherwise. */
  readonly scanError: string | null;
  /** Which axis (or axes) fired. `'none'` exactly when `truncated` is false. */
  readonly truncationCause: SupplementalFlowWriterScanTruncationCause;
  /**
   * Flow source files actually READ and scanned (N in the "N of M"
   * disclosure) — never a Flow the walk merely visited.
   */
  readonly scannedCount: number;
  /** Total Flow nodes in the vault (M). Resolved exactly when truncated. */
  readonly totalCount: number;
  /**
   * `<inputAssignments>` field-name matches dropped because every DML that
   * assigned the field resolved to a DIFFERENT object (same field name, other
   * object — `Name`, `Status`, `OwnerId` …).
   */
  readonly otherObjectMatchesDropped: number;
}

/**
 * The ONE honest boundary sentence for a supplemental writer scan — `null`
 * when the scan was complete and there is nothing to disclose.
 *
 * FLOW-WRITER-SCAN-TWO-AXES: `field_360`, `why_field_changed` and
 * `safe_to_delete_field` each hand-wrote their own copy of this sentence, and
 * all three hardcoded the ceiling cause ("un-scanned tail", "raise
 * SFI_FLOW_WRITER_SCAN_MAX"). On the source-read axis all of those clauses are
 * FALSE and the remedy they name cannot work. Three copies of a rule is three
 * chances to drift, so the rule lives here, next to the state it describes,
 * and the callers adopt it.
 */
export const describeSupplementalFlowWriterScanBoundary = (
  scan: SupplementalFlowWriterScanResult,
): string | null => {
  const unread = scan.unreadableCount.toString();
  const n = scan.scannedCount.toString();
  const m = scan.totalCount.toString();
  const missedWriter =
    'an SObject-variable / recordUpdates writer';
  const unreadableClause =
    `${unread} Flow source file(s) could not be opened (no \`sourcePath\` on record, ` +
    'or nothing readable at that path — a moved/partial source tree, or a vault whose ' +
    'source no longer matches its graph). The graph walk itself was COMPLETE, so this ' +
    'is NOT the full-scan ceiling and raising `SFI_FLOW_WRITER_SCAN_MAX` recovers ' +
    'NOTHING — re-refresh the vault / restore the source tree';
  switch (scan.truncationCause) {
    case 'none':
      return null;
    case 'graph-error':
      return (
        'Supplemental Flow field-writer reconstruction FAILED outright — the Flow graph ' +
        `query errored (${scan.scanError ?? 'unknown error'}) and NO Flow was scanned. ` +
        'The supplemental writer axis is NOT CHECKED, never a proven "no such writer".'
      );
    case 'scan-ceiling':
      return (
        `Supplemental Flow field-writer reconstruction was CAPPED at ${n} of ${m} Flow ` +
        'nodes (full-scan ceiling, `SFI_FLOW_WRITER_SCAN_MAX`) — ' +
        `${missedWriter} in the un-scanned tail is NOT reflected in \`writers\`; treat ` +
        'the writer set as possibly INCOMPLETE, and narrow the vault or raise the ' +
        'ceiling to fully enumerate.'
      );
    case 'unreadable-sources':
      return (
        `Supplemental Flow field-writer reconstruction READ ${n} of ${m} Flow source ` +
        `file(s): ${unreadableClause}. ${missedWriter} inside an unread Flow is NOT ` +
        'reflected in `writers`; treat the writer set as possibly INCOMPLETE.'
      );
    case 'both':
      return (
        `Supplemental Flow field-writer reconstruction READ only ${n} of ${m} Flow ` +
        'source file(s) for TWO independent reasons: the graph walk was CAPPED at the ' +
        'full-scan ceiling (`SFI_FLOW_WRITER_SCAN_MAX`), leaving an un-scanned tail, ' +
        `AND ${unreadableClause}. ${missedWriter} in either the un-scanned tail or an ` +
        'unread Flow is NOT reflected in `writers`; treat the writer set as possibly ' +
        'INCOMPLETE. Raising the ceiling addresses only the first reason.'
      );
  }
};

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
 * Objects whose CUSTOM fields are ONE physical field: `Activity` is the
 * abstract parent and `Task` / `Event` share its custom field set, so a Flow
 * that writes `Task.Foo__c` really does write `CustomField:Activity.Foo__c`.
 */
const ACTIVITY_POLYMORPHIC_OBJECTS: ReadonlySet<string> = new Set(['activity', 'task', 'event']);

/** Salesforce object api names are case-insensitive; Activity/Task/Event alias. */
export const sameObjectScope = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x === y || (ACTIVITY_POLYMORPHIC_OBJECTS.has(x) && ACTIVITY_POLYMORPHIC_OBJECTS.has(y))
  );
};

/** The object a record-triggered Flow's `$Record` refers to, or null. */
const flowTriggeringObject = (xml: string): string | null => {
  const start = /<start>[\s\S]*?<\/start>/.exec(xml)?.[0];
  if (start === undefined) return null;
  return /<object>([^<]+)<\/object>/.exec(start)?.[1] ?? null;
};

/**
 * Whether the `<recordCreates>`/`<recordUpdates>` that assign `fieldApiName`
 * write `objectApiName`. The field NAME alone is not an identity — `Name`,
 * `Status`, `OwnerId` exist on nearly every object — so each assigning DML's
 * object is resolved: `<object>` → `$Record` via `<start>` → an SObject
 * `<variables>` entry. `scoped` when any resolves to the object, `unresolved`
 * when none does but at least one could not be resolved, `other-object` when
 * every one resolved elsewhere, `none` when nothing assigns the field.
 */
export const classifyInputAssignmentsObjectScope = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): 'scoped' | 'unresolved' | 'other-object' | 'none' => {
  const escaped = fieldApiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTag = new RegExp(`<field>${escaped}</field>`);
  const sobjectVars = parseSObjectVariables(xml);
  const triggering = flowTriggeringObject(xml);
  let sawUnresolved = false;
  let sawAssigning = false;
  for (const tag of ['recordCreates', 'recordUpdates'] as const) {
    const dmlPattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    let dml: RegExpExecArray | null;
    while ((dml = dmlPattern.exec(xml)) !== null) {
      const blk = dml[0];
      const assigns = (blk.match(/<inputAssignments>[\s\S]*?<\/inputAssignments>/g) ?? []).some(
        (ia) => fieldTag.test(ia),
      );
      if (!assigns) continue;
      sawAssigning = true;
      const declared = /<object>([^<]+)<\/object>/.exec(blk)?.[1];
      if (declared !== undefined) {
        if (sameObjectScope(declared, objectApiName)) return 'scoped';
        continue;
      }
      const ref = /<inputReference>([^<]+)<\/inputReference>/.exec(blk)?.[1];
      const head = ref?.split('.')[0] ?? '';
      const resolved =
        ref === undefined ? null : head === '$Record' ? triggering : (sobjectVars.get(head) ?? null);
      if (resolved === null) {
        sawUnresolved = true;
        continue;
      }
      if (sameObjectScope(resolved, objectApiName)) return 'scoped';
    }
  }
  if (sawUnresolved) return 'unresolved';
  return sawAssigning ? 'other-object' : 'none';
};

/** One scan hit, plus whether a same-named field on another object was skipped. */
export interface FlowXmlWriteScan {
  readonly hits: ReadonlyArray<{
    fieldApiName: string;
    mechanism: SupplementalFlowFieldWriter['mechanism'];
    objectScope: SupplementalFlowFieldWriter['objectScope'];
  }>;
  readonly otherObjectMatchDropped: boolean;
}

/**
 * Scan one Flow's XML for writes to `{objectApiName}.{fieldApiName}`.
 *
 * Exported for unit tests. Two invariants: only `<inputAssignments>` inside a
 * `<recordCreates>` / `<recordUpdates>` DML denotes a WRITE (a `<field>` in
 * `<filters>` / `<outputAssignments>` is a READ), and that DML must resolve to
 * THIS object — a same-named field on another object is not a writer.
 * ($Record.<field> assignment writes are minted by the graph extractor, which
 * applies the persistence precondition; this scan does not re-derive them.)
 */
export const scanFlowXmlWrites = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): FlowXmlWriteScan => {
  const hits: Array<FlowXmlWriteScan['hits'][number]> = [];
  const sobjectVars = parseSObjectVariables(xml);
  const scope = classifyInputAssignmentsObjectScope(xml, objectApiName, fieldApiName);
  if (scope === 'scoped' || scope === 'unresolved') {
    hits.push({ fieldApiName, mechanism: 'inputAssignments', objectScope: scope });
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
    if (obj !== undefined && sameObjectScope(obj, objectApiName)) {
      hits.push({ fieldApiName: f, mechanism: 'assignToReference', objectScope: 'scoped' });
    }
  }

  return { hits, otherObjectMatchDropped: scope === 'other-object' };
};

/** {@link scanFlowXmlWrites} hits only (kept for callers that need no drop count). */
export const scanFlowXml = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): FlowXmlWriteScan['hits'] => scanFlowXmlWrites(xml, objectApiName, fieldApiName).hits;

/**
 * Scan deployed Flow source files for writes to `{objectApiName}.{fieldApiName}`
 * that the graph may not have stamped as `writesTo` edges.
 *
 * Pages EVERY Flow node (not just the first ≤500) via the shared
 * `scanAllNodesOfTypes` full-window walk, and REPORTS whether the walk was
 * complete — see {@link SupplementalFlowWriterScanResult}. `truncated` is the
 * UNION of TWO INDEPENDENT axes. A caller DOES need to tell them apart — they
 * have opposite remedies — so the axis that fired is reported separately in
 * {@link SupplementalFlowWriterScanResult.truncationCause} and rendered by
 * {@link describeSupplementalFlowWriterScanBoundary}. Reading the boolean and
 * assuming axis 1 is a misdiagnosis, not a conservative default:
 *
 * 1. The graph walk itself stopped at the residual ceiling
 *    (`flows.value.scanIncomplete`), or failed outright.
 * 2. A Flow NODE was reached, but its source FILE could not actually be read
 *    — no `sourcePath` on record, or the file at that path is gone
 *    (FLOW-WRITER-SCAN-FILE-READ-IS-NOT-OPTIONAL: a moved/partial source
 *    tree, or a stale graph pointing at a deleted file). That Flow's writes
 *    were never checked, so it must count against completeness exactly like
 *    an un-scanned node past the paging ceiling — `continue`-ing past it with
 *    no accounting let a fully rotted source tree return `{writers: [],
 *    truncated: false}`: a confident, complete-looking "no supplemental
 *    writers" built out of files nobody actually opened. `scannedCount` only
 *    counts Flows whose source was actually read (never a Flow the walk
 *    merely visited), so "N of M" means what it says. There is NO un-scanned
 *    tail on this axis and raising `SFI_FLOW_WRITER_SCAN_MAX` recovers
 *    NOTHING, which is why it must not be reported as a ceiling cap.
 *
 * A graph query error yields an EMPTY, TRUNCATED result with
 * `truncationCause: 'graph-error'`: nothing was scanned, so the empty writer
 * list is "not checked", never a proven "no supplemental writers" — and
 * neither remedy above applies to it either.
 */
export const scanSupplementalFlowFieldWriters = async (
  ctx: Context,
  objectApiName: string,
  fieldApiName: string,
): Promise<SupplementalFlowWriterScanResult> => {
  const maxNodes = flowWriterScanCeiling();
  const flows = await scanAllNodesOfTypes(ctx.graph, ['Flow'], maxNodes);
  if (!flows.ok) {
    // Nothing was scanned: an empty writer list here is "not checked", never a
    // proven "no supplemental writers". `capExceeded` is FALSE — no ceiling was
    // involved, so a caller must not advise raising one.
    return {
      writers: [],
      truncated: true,
      capExceeded: false,
      unreadableCount: 0,
      scanFailed: true,
      scanError: flows.error.message,
      truncationCause: 'graph-error',
      scannedCount: 0,
      totalCount: 0,
      otherObjectMatchesDropped: 0,
    };
  }
  const out: SupplementalFlowFieldWriter[] = [];
  let otherObjectMatchesDropped = 0;
  let readCount = 0;
  let unreadableCount = 0;
  for (const node of flows.value.nodes) {
    if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
      // No source on record at all — this Flow's writes could not be
      // checked. Count it against completeness rather than silently
      // skipping it: see FLOW-WRITER-SCAN-FILE-READ-IS-NOT-OPTIONAL above.
      unreadableCount += 1;
      continue;
    }
    try {
      const xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
      readCount += 1;
      const scan = scanFlowXmlWrites(xml, objectApiName, fieldApiName);
      if (scan.otherObjectMatchDropped) otherObjectMatchesDropped += 1;
      for (const hit of scan.hits) {
        out.push({
          componentId: node.id,
          apiName: node.apiName,
          fieldApiName: hit.fieldApiName,
          mechanism: hit.mechanism,
          objectScope: hit.objectScope,
        });
      }
    } catch {
      // Source path on record, but unreadable (moved/partial tree,
      // permissions, deleted file) — same accounting as a missing
      // sourcePath: this Flow was NOT checked, not "checked and clean".
      unreadableCount += 1;
    }
  }
  out.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  // FLOW-WRITER-SCAN-TWO-AXES: keep the axes SEPARATE, then union them into
  // `truncated`. The union is the safety flag; the discriminant is the reason.
  const capExceeded = flows.value.scanIncomplete;
  const truncated = capExceeded || unreadableCount > 0;
  const truncationCause: SupplementalFlowWriterScanTruncationCause = capExceeded
    ? unreadableCount > 0
      ? 'both'
      : 'scan-ceiling'
    : unreadableCount > 0
      ? 'unreadable-sources'
      : 'none';
  const scannedCount = readCount;
  // Only pay for the true total (M) when we actually need to disclose "N of M".
  let totalCount = flows.value.nodes.length;
  if (truncated) {
    const total = await countNodesByType(ctx.graph, 'Flow');
    if (total.ok) totalCount = total.value;
  }
  return {
    writers: out,
    truncated,
    capExceeded,
    unreadableCount,
    scanFailed: false,
    scanError: null,
    truncationCause,
    scannedCount,
    totalCount,
    otherObjectMatchesDropped,
  };
};
