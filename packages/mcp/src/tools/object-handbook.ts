/**
 * `sfi.object_360 { format: 'handbook' }` — a compact single-object brief a new
 * team member can read top to bottom: what the object is for, its key fields,
 * record types, relationships, what runs on save (in order), who can access it,
 * integrations touching it, risk signals, and where to look next.
 *
 * ── Why a format of object_360 and not a new tool or an onboarding scope ─────
 *
 * `object_360` already gathers every graph read a single-object brief needs
 * (children, both usage tiers, grants, relationships). `generate_onboarding_doc`
 * is an ORG-scoped persona document; giving it an object scope would duplicate
 * that gather in a second module that drifts. A new tool would cost host tokens
 * for a view of data one tool already owns. So this module is a second RENDER
 * of the same gather, plus the save sequence composed from
 * `what_happens_on_save` (never re-derived here).
 *
 * ── Honesty rules this render keeps ──────────────────────────────────────────
 *
 *  - Every list is RANKED, then capped, and every cap states "shown of total".
 *  - A section with nothing to show says what was checked, never just "none".
 *  - `required` is the field's DECLARED flag; platform-required standard
 *    fields and layout-required fields are not visible in field metadata.
 *  - Standard picklists whose values live in a standard value set say so instead
 *    of rendering an empty value list.
 *  - Risk signals are FACTS with their evidence, never a verdict.
 */

import type { ComponentId, Edge, McpResponse, Node } from '@sf-intelligence/contracts';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { extractedList } from './absence-disclosure.js';
import { NOT_USAGE_EDGE_TYPES } from './apex-reachability.js';
import { sObjectApiNameToCdcEventName } from './cdc-subscribers.js';
import { buildEmptyTraversalCoverageCaveat, GRAPH_TRAVERSAL_REQUIRED_COVERAGE } from './coverage-trust.js';
import { INTEGRATION_NODE_TYPES } from './field-360.js';
import { PICKLIST_DATA_TYPES, readFieldDataType, UNKNOWN_FIELD_TYPE } from './field-properties.js';
import { classifyObjectKind, familyAvailability, type Object360Gathered } from './object-360.js';
import { AUTOMATION_PHASES } from './soe-payload-bounds.js';
import { whatHappensOnSaveHandler, type SoeStep } from './what-happens-on-save.js';

/**
 * Serialized-byte ceiling for the handbook response. Well under the
 * dispatcher's 40 000-byte budget: a brief that a host reads in full is worth
 * more than one that fills the transport.
 */
export const HANDBOOK_BYTE_BUDGET = 24_000;

/** Row caps for one render pass; the fit ladder shrinks them together. */
interface HandbookCaps {
  readonly keyFields: number;
  readonly picklists: number;
  readonly picklistValues: number;
  readonly recordTypes: number;
  readonly parents: number;
  readonly children: number;
  readonly integrations: number;
  readonly perPhase: number;
  readonly names: number;
  readonly textChars: number;
}

const CAP_LADDER: readonly HandbookCaps[] = [
  { keyFields: 15, picklists: 6, picklistValues: 10, recordTypes: 12, parents: 12, children: 12, integrations: 12, perPhase: 8, names: 6, textChars: 160 },
  { keyFields: 12, picklists: 5, picklistValues: 8, recordTypes: 10, parents: 10, children: 10, integrations: 10, perPhase: 6, names: 5, textChars: 120 },
  { keyFields: 10, picklists: 4, picklistValues: 6, recordTypes: 8, parents: 8, children: 8, integrations: 8, perPhase: 5, names: 4, textChars: 100 },
  { keyFields: 8, picklists: 3, picklistValues: 5, recordTypes: 6, parents: 6, children: 6, integrations: 6, perPhase: 4, names: 3, textChars: 80 },
  { keyFields: 5, picklists: 2, picklistValues: 4, recordTypes: 4, parents: 4, children: 4, integrations: 4, perPhase: 3, names: 2, textChars: 60 },
];

/** Human labels for the order-of-execution phases, in firing order. */
const PHASE_LABEL: Readonly<Record<(typeof AUTOMATION_PHASES)[number], string>> = {
  'before-save-flows': 'Before-save flows',
  'pre-save-triggers': 'Before triggers',
  'pre-save-validation': 'Validation rules',
  'duplicate-rules': 'Duplicate rules',
  'after-triggers': 'After triggers',
  'post-save-assignment': 'Assignment / auto-response / escalation rules',
  'post-save-workflows': 'Workflow rules',
  'post-save-flows': 'After-save flows',
  'post-save-approval': 'Approval processes',
  'post-save-rollup-recalc': 'Parent roll-up summaries recalculated',
  'post-save-async': 'Async jobs dispatched',
};

/** First phase that runs AFTER the database write (`after-triggers`). */
const AFTER_SAVE_PHASE_INDEX = AUTOMATION_PHASES.indexOf('after-triggers');

const LOOKUP_TYPES: ReadonlySet<string> = new Set(['Lookup', 'MasterDetail', 'Hierarchy', 'MetadataRelationship']);

const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const str = (props: Readonly<Record<string, unknown>>, key: string): string | null => {
  const v = props[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/** One line of prose from free text: collapse whitespace, drop backticks, cap. */
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[`|]/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
};

/** `a, b, c (+N more)` — the cap is always stated with the true total. */
const nameList = (names: readonly string[], cap: number): string => {
  const shown = names.slice(0, cap).map((n) => `\`${n}\``);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
};

/** Bare api name from a `Type:Name` id. */
const bare = (id: string): string => {
  const colon = id.indexOf(':');
  return colon >= 0 ? id.slice(colon + 1) : id;
};

/** Field api name from `CustomField:Obj.Field`. */
const fieldName = (id: string): string => {
  const b = bare(id);
  const dot = b.indexOf('.');
  return dot >= 0 ? b.slice(dot + 1) : b;
};

const isSystemField = (f: Node): boolean =>
  f.properties['synthetic'] === true || f.properties['system'] === true;

/**
 * A field's data type for display. Source-only standard fields (built offline
 * with no describe) carry `Unknown`; that is a capture gap, not a type.
 */
const typeText = (f: Node): string => {
  const t = readFieldDataType(f);
  return t === UNKNOWN_FIELD_TYPE ? 'type not captured' : t;
};

/**
 * The objects a field points at: `referenceTargets` (polymorphic), else
 * `referenceTo`. `[]` = a lookup-typed field whose target was NOT captured
 * (a source-only standard lookup) — still a relationship, never dropped.
 * `null` = not a reference field.
 */
const referenceTargetsOf = (f: Node): readonly string[] | null => {
  // `null` = never carried; `[]` = carried with no target. Never collapsed.
  const many = extractedList(f.properties, 'referenceTargets');
  if (many !== null && many.length > 0) return many.map(String);
  const one = str(f.properties, 'referenceTo');
  if (one !== null) return [one];
  return many !== null || LOOKUP_TYPES.has(str(f.properties, 'dataType') ?? '') ? [] : null;
};

/** `→ A / B`, or `→ target not captured` for a lookup with no captured target. */
const targetText = (targets: readonly string[]): string =>
  targets.length === 0 ? '→ target not captured' : `→ ${targets.map((t) => `\`${t}\``).join(' / ')}`;

/** One merged order-of-execution step across the insert and update compositions. */
interface MergedStep {
  readonly phase: (typeof AUTOMATION_PHASES)[number];
  readonly componentId: string;
  readonly componentType: string;
  readonly apiName: string;
  readonly events: Set<'insert' | 'update'>;
  readonly errorMessage?: string;
  readonly triggerOrder?: number;
  readonly asyncOnly: boolean;
  readonly firstIndex: number;
}

type AutomationPhase = (typeof AUTOMATION_PHASES)[number];

/** Automation on the events the insert/update sequence does not cover. */
interface OtherEventSummary {
  readonly event: 'delete' | 'undelete';
  /** Active steps per `summary.phaseCounts` — the full composition, never the survivors. */
  readonly total: number;
  /** Distinct components listed; a trigger running before AND after is one name, two steps. */
  readonly names: readonly string[];
  /** The save tool could not list every step, so `names` may be short. */
  readonly namesPartial: boolean;
}

/** What the save-sequence composition produced, or why it could not. */
type SaveSequence =
  | {
      readonly ok: true;
      readonly steps: readonly MergedStep[];
      /**
       * Per phase: max(steps listed, the save tool's declared count for either
       * event). Exact unless the phase is in `incompletePhases`, where it is a
       * LOWER bound.
       */
      readonly phaseTotals: Readonly<Record<AutomationPhase, number>>;
      /** Phases the save tool counted more steps in than it could list, even after a `phase` refetch. */
      readonly incompletePhases: ReadonlySet<AutomationPhase>;
      readonly inactiveTotal: number;
      readonly inactiveByType: Readonly<Record<string, number>>;
      readonly bypassWarnings: number;
      /** `null` when the delete/undelete composition failed — never read as "none". */
      readonly otherEvents: readonly OtherEventSummary[] | null;
    }
  | { readonly ok: false; readonly reason: string };

/** The save-tool entry point; injectable so a test can force a shortfall. */
export type SoeFetch = typeof whatHappensOnSaveHandler;

/**
 * Compose the save sequence from `what_happens_on_save` for insert AND update,
 * tagging each step with the events it fires on. A step that fires only on
 * insert must not read as running on every save.
 *
 * On a heavy object the save tool sheds steps from its most crowded phase to
 * fit its own budget and names the shortfall in `phasesOmitted` (its
 * `summary.phaseCounts` keep the full counts). Counting only the surviving
 * steps under-reported a 100-rule validation phase as 45. So every omitted
 * phase is refetched with the `phase` filter (which keeps every step), totals
 * come from `summary.phaseCounts`, and a phase still short after that is
 * reported as a lower bound.
 */
export const composeSaveSequence = async (
  ctx: Context,
  objectId: ComponentId,
  fetch: SoeFetch = whatHappensOnSaveHandler,
): Promise<SaveSequence> => {
  const merged = new Map<string, MergedStep>();
  const declaredMax = Object.fromEntries(AUTOMATION_PHASES.map((p) => [p, 0])) as Record<AutomationPhase, number>;
  const incompletePhases = new Set<AutomationPhase>();
  // The save tool sets inactive automation aside BEFORE it filters by event,
  // so both events report the same inactive set; the larger is kept.
  let inactiveTotal = 0;
  let inactiveByType: Readonly<Record<string, number>> = {};
  let bypassWarnings = 0;
  let index = 0;
  const addSteps = (soe: readonly SoeStep[], event: 'insert' | 'update', seen: Set<string>): void => {
    for (const step of soe) {
      if (step.phase === 'save') continue;
      // One component can run in TWO phases (a trigger with before AND after
      // events), so the merge key is phase + component, never the component alone.
      const key = `${step.phase}|${step.componentId}`;
      seen.add(key);
      const existing = merged.get(key);
      if (existing !== undefined) {
        existing.events.add(event);
        continue;
      }
      merged.set(key, {
        phase: step.phase,
        componentId: step.componentId,
        componentType: step.componentType,
        apiName: step.apiName,
        events: new Set([event]),
        ...(step.errorMessage !== undefined ? { errorMessage: step.errorMessage } : {}),
        ...(step.triggerOrder !== undefined ? { triggerOrder: step.triggerOrder } : {}),
        asyncOnly: step.timing === 'async-only',
        firstIndex: index,
      });
      index += 1;
    }
  };
  for (const event of ['insert', 'update'] as const) {
    const r = await fetch(ctx, { componentId: objectId, event, includeConceptReasoning: false });
    if (!r.ok) return { ok: false, reason: `${r.error.kind}: ${r.error.message}` };
    const out = r.value.data;
    const seen = new Set<string>();
    addSteps(out.soe as readonly SoeStep[], event, seen);
    for (const omission of out.phasesOmitted ?? []) {
      const again = await fetch(ctx, {
        componentId: objectId,
        event,
        phase: omission.phase,
        includeConceptReasoning: false,
      });
      if (again.ok) addSteps(again.value.data.soe as readonly SoeStep[], event, seen);
    }
    const listedForEvent = (phase: AutomationPhase): number =>
      [...seen].filter((k) => k.startsWith(`${phase}|`)).length;
    for (const phase of AUTOMATION_PHASES) {
      const declared = out.summary.phaseCounts[phase];
      declaredMax[phase] = Math.max(declaredMax[phase], declared);
      if (listedForEvent(phase) < declared) incompletePhases.add(phase);
    }
    if (out.inactiveSummary.total > inactiveTotal) {
      inactiveTotal = out.inactiveSummary.total;
      inactiveByType = out.inactiveSummary.byType;
    }
    bypassWarnings = Math.max(bypassWarnings, out.triggerBypassWarnings?.length ?? 0);
  }
  const steps = [...merged.values()];
  const phaseTotals = Object.fromEntries(
    AUTOMATION_PHASES.map((p) => [p, Math.max(declaredMax[p], steps.filter((s) => s.phase === p).length)]),
  ) as Record<AutomationPhase, number>;
  return {
    ok: true,
    steps,
    phaseTotals,
    incompletePhases,
    inactiveTotal,
    inactiveByType,
    bypassWarnings,
    otherEvents: await composeOtherEvents(ctx, objectId, fetch),
  };
};

/** Delete / undelete automation, summarised — the brief's sequence covers insert and update only. */
const composeOtherEvents = async (
  ctx: Context,
  objectId: ComponentId,
  fetch: SoeFetch,
): Promise<readonly OtherEventSummary[] | null> => {
  const out: OtherEventSummary[] = [];
  for (const event of ['delete', 'undelete'] as const) {
    const r = await fetch(ctx, { componentId: objectId, event, includeConceptReasoning: false });
    if (!r.ok) return null;
    const d = r.value.data;
    const total = AUTOMATION_PHASES.reduce((sum, p) => sum + d.summary.phaseCounts[p], 0);
    const names = [...new Set((d.soe as readonly SoeStep[]).filter((s) => s.phase !== 'save').map((s) => s.apiName))];
    out.push({ event, total, names, namesPartial: (d.phasesOmitted ?? []).length > 0 });
  }
  return out;
};

/** Integration touchpoints, each with how it was found. */
interface IntegrationTouch {
  readonly id: string;
  readonly how: string;
}

/** Inputs to one render pass — all graph reads are already done. */
interface HandbookInputs {
  readonly ctx: Context;
  readonly objectId: ComponentId;
  readonly apiName: string;
  readonly g: Object360Gathered;
  readonly resolvedFrom: string | null;
  readonly save: SaveSequence;
  readonly cdcReferrers: readonly Edge[];
}

/** A truncation row: the section, how many rows are shown, and the true total. */
interface HandbookTruncation {
  readonly section: string;
  readonly shown: number;
  readonly total: number;
  /** `total` is a LOWER bound: the source counted more than it could list. */
  readonly atLeast?: true;
}

/** A save phase's count as text: exact, or `at least N` when the phase could not be listed in full. */
const phaseCountText = (save: Extract<SaveSequence, { ok: true }>, phase: AutomationPhase): string =>
  `${save.incompletePhases.has(phase) ? 'at least ' : ''}${save.phaseTotals[phase]}`;

/**
 * Build the handbook response. Reads the save sequence and the CDC channel
 * edges, then renders at descending caps until the payload fits
 * {@link HANDBOOK_BYTE_BUDGET}.
 */
export const buildObjectHandbook = async (
  ctx: Context,
  objectId: ComponentId,
  apiName: string,
  g: Object360Gathered,
  resolvedFrom: string | null,
): Promise<McpResponse<Readonly<Record<string, unknown>>>> => {
  const save = await composeSaveSequence(ctx, objectId);
  const cdcResult = await listEdges(
    ctx.graph,
    `CustomObject:${sObjectApiNameToCdcEventName(apiName)}` as ComponentId,
    { direction: 'in' },
  );
  const cdcReferrers = cdcResult.ok ? cdcResult.value : [];
  const inputs: HandbookInputs = { ctx, objectId, apiName, g, resolvedFrom, save, cdcReferrers };
  let rendered = renderHandbook(inputs, CAP_LADDER[0] as HandbookCaps, 0);
  for (let step = 1; step < CAP_LADDER.length; step += 1) {
    if (Buffer.byteLength(JSON.stringify(rendered)) <= HANDBOOK_BYTE_BUDGET) break;
    rendered = renderHandbook(inputs, CAP_LADDER[step] as HandbookCaps, step);
  }
  const bytes = Buffer.byteLength(JSON.stringify(rendered));
  if (bytes <= HANDBOOK_BYTE_BUDGET) return rendered;
  // The tightest caps still overflow (very long names or messages). Say so
  // rather than hand back an oversize brief as if it fit; the dispatcher's
  // own budget still applies after this.
  return {
    ...rendered,
    data: {
      ...rendered.data,
      overBudget: {
        bytes,
        budgetBytes: HANDBOOK_BYTE_BUDGET,
        note: 'The brief is larger than its budget even at the tightest caps; the host transport may cut it. Use the per-section tools under "Where to look next".',
      },
    },
  };
};

/** Pure render of the handbook at one cap level. */
const renderHandbook = (
  inp: HandbookInputs,
  caps: HandbookCaps,
  ladderStep: number,
): McpResponse<Readonly<Record<string, unknown>>> => {
  const { ctx, objectId, apiName, g, save } = inp;
  const truncation: HandbookTruncation[] = [];
  const noteCap = (section: string, shown: number, total: number, atLeast = false): void => {
    if (shown < total) truncation.push({ section, shown, total, ...(atLeast ? { atLeast: true as const } : {}) });
  };
  const typeOf = (id: string): string => g.referrerById.get(id)?.type ?? (id.includes(':') ? id.slice(0, id.indexOf(':')) : 'unknown');
  const props = g.objectNode?.properties ?? {};
  const lines: string[] = [];

  // ── Purpose ──────────────────────────────────────────────────────────────
  const label = g.objectNode?.label ?? str(props, 'label') ?? apiName;
  const plural = str(props, 'pluralLabel');
  const description = str(props, 'description');
  const objectKind = classifyObjectKind(apiName);
  const kind =
    objectKind.kind === 'managed'
      ? `managed-package object (namespace \`${objectKind.namespace ?? '?'}\`)`
      : `${objectKind.kind} object`;
  lines.push(`# ${label} (\`${apiName}\`) — object brief`);
  lines.push('');
  lines.push('## What it is');
  lines.push(
    `- ${kind.charAt(0).toUpperCase()}${kind.slice(1)}${plural !== null && plural !== label ? `, plural label "${plural}"` : ''}.` +
      (g.objectNode === null ? ' Its own definition was NOT retrieved into this vault; facts below come from its fields and the components pointing at it.' : ''),
  );
  lines.push(
    description !== null
      ? `- Description: ${oneLine(description, caps.textChars * 2)}`
      : '- No description is declared in the metadata.',
  );
  const owdInternal = str(props, 'sharingModel');
  const owdExternal = str(props, 'externalSharingModel');
  if (owdInternal !== null || owdExternal !== null) {
    lines.push(`- Org-wide default: internal \`${owdInternal ?? 'not captured'}\`, external \`${owdExternal ?? 'not captured'}\`.`);
  }

  // ── Fields ───────────────────────────────────────────────────────────────
  const fieldNodes = g.children.filter((c) => c.type === 'CustomField');
  const systemFields = fieldNodes.filter(isSystemField);
  const realFields = fieldNodes.filter((f) => !isSystemField(f));
  const customFields = realFields.filter((f) => f.apiName.endsWith('__c'));
  const referrersByField = new Map<string, Set<string>>();
  for (const e of g.fieldInboundAll) {
    const set = referrersByField.get(e.toId) ?? new Set<string>();
    set.add(e.fromId);
    referrersByField.set(e.toId, set);
  }
  const refs = (f: Node): number => referrersByField.get(f.id)?.size ?? 0;
  const isKeyFlag = (f: Node): boolean =>
    f.properties['required'] === true || f.properties['externalId'] === true || f.properties['unique'] === true;
  const ranked = [...realFields].sort(
    (a, b) => Number(isKeyFlag(b)) - Number(isKeyFlag(a)) || refs(b) - refs(a) || byIdAsc(a.id, b.id),
  );
  const keyFields = ranked.slice(0, caps.keyFields);
  noteCap('keyFields', keyFields.length, realFields.length);
  const requiredCount = realFields.filter((f) => f.properties['required'] === true).length;
  const externalIdCount = realFields.filter((f) => f.properties['externalId'] === true).length;
  const uniqueCount = realFields.filter((f) => f.properties['unique'] === true).length;
  lines.push('');
  lines.push(
    `## Key fields (${keyFields.length} of ${realFields.length}: ${customFields.length} custom, ` +
      `${realFields.length - customFields.length} standard${systemFields.length > 0 ? `; plus ${systemFields.length} platform system fields not listed` : ''})`,
  );
  lines.push(
    `Ranked: declared required / external id / unique first (${requiredCount} / ${externalIdCount} / ${uniqueCount}), then by how many components reference the field.`,
  );
  if (realFields.length === 0) {
    lines.push(
      g.objectNode === null
        ? '- No field node for this object is in the vault — NOT retrieved, not "no fields".'
        : '- The vault holds no non-system field for this object.',
    );
  }
  for (const f of keyFields) {
    const p = f.properties;
    const type = typeText(f);
    const targets = referenceTargetsOf(f);
    const flags = [
      p['required'] === true ? 'required' : null,
      p['externalId'] === true ? 'external id' : null,
      p['unique'] === true ? 'unique' : null,
      targets !== null ? targetText(targets) : null,
      p['isFormula'] === true || str(p, 'formula') !== null ? 'formula' : null,
    ].filter((x): x is string => x !== null);
    const text = str(p, 'inlineHelpText') ?? str(p, 'description');
    const fl = f.label ?? str(p, 'label');
    lines.push(
      `- \`${f.apiName}\`${fl !== null && fl !== f.apiName ? ` "${oneLine(fl, 60)}"` : ''} (${type}` +
        `${flags.length > 0 ? `; ${flags.join(', ')}` : ''}) — ${refs(f)} referencing component(s)` +
        `${text !== null ? `. ${oneLine(text, caps.textChars)}` : ''}`,
    );
  }
  const undocumented = customFields.filter(
    (f) => str(f.properties, 'description') === null && str(f.properties, 'inlineHelpText') === null,
  ).length;

  // ── Picklists ────────────────────────────────────────────────────────────
  const picklists = realFields
    .filter((f) => PICKLIST_DATA_TYPES.has(readFieldDataType(f)))
    .sort((a, b) => refs(b) - refs(a) || byIdAsc(a.id, b.id));
  lines.push('');
  lines.push(
    picklists.length === 0
      ? '## Picklists (0)'
      : `## Picklists (${Math.min(picklists.length, caps.picklists)} of ${picklists.length}, most-referenced first)`,
  );
  noteCap('picklists', Math.min(picklists.length, caps.picklists), picklists.length);
  if (picklists.length === 0) lines.push('- No picklist field among the field nodes this vault holds for the object.');
  for (const f of picklists.slice(0, caps.picklists)) {
    // `null` = the refresh never carried the key; `[]` = carried, no inline
    // values (a standard picklist's live in its standard value set).
    const raw = extractedList(f.properties, 'picklistValues');
    const valueSet = str(f.properties, 'valueSetName');
    if (raw !== null && raw.length > 0) {
      const values = raw as readonly Record<string, unknown>[];
      const active = values.filter((v) => v['isActive'] !== false).map((v) => String(v['value'] ?? v['label'] ?? ''));
      const inactive = values.length - active.length;
      const shown = active.slice(0, caps.picklistValues).map((v) => oneLine(v, 40));
      lines.push(
        `- \`${f.apiName}\`: ${active.length} active value(s) — ${shown.join(' · ')}` +
          `${active.length > shown.length ? ` (+${active.length - shown.length} more)` : ''}` +
          `${inactive > 0 ? `; ${inactive} inactive` : ''}`,
      );
    } else if (valueSet !== null) {
      lines.push(`- \`${f.apiName}\`: values come from global value set \`${valueSet}\` (\`sfi.get_component GlobalValueSet:${valueSet}\`).`);
    } else {
      lines.push(`- \`${f.apiName}\`: values are not in the retrieved field metadata (a standard picklist's values live in its standard value set, which this vault does not carry per field).`);
    }
  }

  // ── Record types ─────────────────────────────────────────────────────────
  const recordTypes = g.children
    .filter((c) => c.type === 'RecordType')
    .sort(
      (a, b) =>
        Number(b.properties['active'] === true) - Number(a.properties['active'] === true) || byIdAsc(a.id, b.id),
    );
  const rtActive = recordTypes.filter((r) => r.properties['active'] === true).length;
  lines.push('');
  lines.push(`## Record types (${recordTypes.length} total, ${rtActive} active)`);
  noteCap('recordTypes', Math.min(recordTypes.length, caps.recordTypes), recordTypes.length);
  if (recordTypes.length === 0) {
    lines.push(
      `- None: ${familyAvailability(ctx, 'RecordType', 0, 'this object has no record types', 'Re-run `/sfi-refresh` to retrieve them.').note}`,
    );
  }
  const moreLine = (shown: number, total: number, what: string): void => {
    if (total > shown) lines.push(`- (+${total - shown} more ${what} not shown)`);
  };
  for (const rt of recordTypes.slice(0, caps.recordTypes)) {
    const bp = str(rt.properties, 'businessProcess');
    const rtDesc = str(rt.properties, 'description');
    lines.push(
      `- \`${rt.apiName}\`${rt.label !== null && rt.label !== rt.apiName ? ` "${oneLine(rt.label, 60)}"` : ''}` +
        `${rt.properties['active'] === true ? '' : rt.properties['active'] === false ? ' (inactive)' : ' (activation not declared)'}` +
        `${bp !== null ? `, business process \`${bp}\`` : ''}${rtDesc !== null ? ` — ${oneLine(rtDesc, caps.textChars)}` : ''}`,
    );
  }

  moreLine(Math.min(recordTypes.length, caps.recordTypes), recordTypes.length, 'record type(s)');

  // ── Relationships ────────────────────────────────────────────────────────
  const parentFields = fieldNodes
    .flatMap((f) => {
      const targets = referenceTargetsOf(f);
      return targets === null ? [] : [{ f, targets, system: isSystemField(f), type: str(f.properties, 'dataType') }];
    })
    .sort((a, b) => Number(a.system) - Number(b.system) || refs(b.f) - refs(a.f) || byIdAsc(a.f.id, b.f.id));
  const businessParents = parentFields.filter((p) => !p.system);
  const systemParents = parentFields.filter((p) => p.system);
  const targetless = businessParents.filter((p) => p.targets.length === 0).length;
  const inboundLookups = g.objectInbound.filter((e) => e.edgeType === 'lookupTo');
  const childObjects = new Map<string, { fields: string[]; masterDetail: number }>();
  for (const e of inboundLookups) {
    const owner = bare(e.fromId).split('.')[0] ?? e.fromId;
    const acc = childObjects.get(owner) ?? { fields: [], masterDetail: 0 };
    acc.fields.push(fieldName(e.fromId));
    if (e.properties['relationshipType'] === 'MasterDetail') acc.masterDetail += 1;
    childObjects.set(owner, acc);
  }
  const childRows = [...childObjects.entries()].sort(
    (a, b) => b[1].masterDetail - a[1].masterDetail || b[1].fields.length - a[1].fields.length || byIdAsc(a[0], b[0]),
  );
  lines.push('');
  lines.push(
    `## Relationships (${businessParents.length} lookup field(s) to parents` +
      `${targetless > 0 ? `, ${targetless} with target not captured` : ''}, ` +
      `${childRows.length} child object(s) pointing here, among retrieved fields)`,
  );
  lines.push(`Parents (fields on this object):`);
  noteCap('parents', Math.min(businessParents.length, caps.parents), businessParents.length);
  if (businessParents.length === 0) lines.push('- No business lookup/master-detail field among the retrieved fields.');
  for (const p of businessParents.slice(0, caps.parents)) {
    const kindText = p.type !== null && LOOKUP_TYPES.has(p.type) ? p.type : p.type === null || p.type === 'Unknown' ? 'reference, type not captured' : `${p.type} reference`;
    lines.push(`- \`${p.f.apiName}\` ${targetText(p.targets)} (${kindText})`);
  }
  moreLine(Math.min(businessParents.length, caps.parents), businessParents.length, 'lookup field(s), ranked by references');
  if (systemParents.length > 0) {
    lines.push(`- plus ${systemParents.length} platform system lookup(s): ${nameList(systemParents.map((p) => p.f.apiName), caps.names)}`);
  }
  lines.push(`Children (fields on other objects that point here):`);
  noteCap('children', Math.min(childRows.length, caps.children), childRows.length);
  if (childRows.length === 0) {
    lines.push('- No lookup from another object\'s retrieved fields reaches this object.');
  }
  for (const [obj, acc] of childRows.slice(0, caps.children)) {
    lines.push(
      `- \`${obj}\` via ${nameList(acc.fields.sort(byIdAsc), caps.names)}${acc.masterDetail > 0 ? ` (${acc.masterDetail} master-detail — deletes cascade)` : ''}`,
    );
  }

  moreLine(Math.min(childRows.length, caps.children), childRows.length, 'child object(s), ranked by master-detail then field count');
  lines.push('- A child appears only when its lookup field is in this vault with a captured target; a standard child whose lookup was not captured (e.g. a polymorphic activity lookup) is not listed.');

  // ── Save sequence ────────────────────────────────────────────────────────
  lines.push('');
  const flowPhaseUnordered: string[] = [];
  let activeTriggers = 0;
  let workflowRules = 0;
  let validationRules: string | null = null;
  let saveStepTotal = 0;
  let saveComponentTotal = 0;
  let saveIncomplete = false;
  if (!save.ok) {
    lines.push('## What runs when a record is saved');
    lines.push(`- The save sequence could not be composed (${oneLine(save.reason, 200)}). This is NOT "no automation" — run \`sfi.what_happens_on_save\` directly.`);
  } else {
    saveIncomplete = save.incompletePhases.size > 0;
    saveStepTotal = AUTOMATION_PHASES.reduce((sum, p) => sum + save.phaseTotals[p], 0);
    // A trigger with before AND after events is ONE component in TWO steps.
    // When a phase could not be listed in full, the listed components are a
    // lower bound and the heading says so.
    saveComponentTotal = new Set(save.steps.map((s) => s.componentId)).size;
    const atLeast = saveIncomplete ? 'at least ' : '';
    lines.push(
      `## What runs when a record is saved (${atLeast}${saveComponentTotal} active component(s) in ${atLeast}${saveStepTotal} step(s), in order)`,
    );
    lines.push('Tags show which events each step fires on. Entry conditions are listed by the save tool, not evaluated here.');
    let wroteSaveMarker = false;
    for (const phase of AUTOMATION_PHASES) {
      if (!wroteSaveMarker && saveStepTotal > 0 && AUTOMATION_PHASES.indexOf(phase) >= AFTER_SAVE_PHASE_INDEX) {
        lines.push('- — the record is written to the database —');
        wroteSaveMarker = true;
      }
      const steps = save.steps.filter((s) => s.phase === phase).sort((a, b) => a.firstIndex - b.firstIndex);
      const total = save.phaseTotals[phase];
      const short = save.incompletePhases.has(phase);
      if (total === 0) continue;
      if (phase === 'pre-save-triggers' || phase === 'after-triggers') {
        activeTriggers = Math.max(activeTriggers, total);
      }
      if (phase === 'post-save-workflows') workflowRules = total;
      if (phase === 'pre-save-validation') validationRules = phaseCountText(save, phase);
      if (
        (phase === 'before-save-flows' || phase === 'post-save-flows') &&
        steps.filter((s) => s.componentType === 'Flow' && s.triggerOrder === undefined).length >= 2
      ) {
        flowPhaseUnordered.push(PHASE_LABEL[phase]);
      }
      const shown = steps.slice(0, caps.perPhase);
      noteCap(`save.${phase}`, shown.length, total, short);
      const rendered = shown.map((s) => {
        const ev = s.events.size === 2 ? 'insert+update' : [...s.events][0] ?? '';
        const bits = [ev, s.asyncOnly ? 'scheduled/async path' : null, s.triggerOrder !== undefined ? `order ${s.triggerOrder}` : null]
          .filter((x): x is string => x !== null && x !== '');
        const msg = s.errorMessage !== undefined ? ` — blocks with "${oneLine(s.errorMessage, caps.textChars)}"` : '';
        return `\`${s.apiName}\` [${bits.join(', ')}]${msg}`;
      });
      const more = total - shown.length;
      lines.push(
        `- **${PHASE_LABEL[phase]}** (${phaseCountText(save, phase)}): ${rendered.join('; ')}` +
          `${more > 0 ? ` (+${short ? 'at least ' : ''}${more} more)` : ''}` +
          `${short ? ` — the save tool counted ${total} here but could not list them all; \`sfi.what_happens_on_save\` {"phase":"${phase}"} lists the phase` : ''}`,
      );
    }
    if (saveStepTotal === 0) {
      lines.push('- No active automation fires on insert or update of this object in the modeled families (see the save tool\'s coverage notes for families not modeled).');
    }
    if (save.otherEvents === null) {
      lines.push('- Delete / undelete automation could not be composed — NOT "none"; run `sfi.what_happens_on_save` {"event":"delete"}.');
    } else {
      const parts = save.otherEvents.map((o) =>
        o.total === 0
          ? `${o.event}: none modeled`
          : `${o.event}: ${o.total} step(s) from ${o.namesPartial ? 'at least ' : ''}${o.names.length} component(s) (${nameList(o.names, caps.names)})`,
      );
      lines.push(`- Not in the sequence above — ${parts.join('; ')} (\`sfi.what_happens_on_save\` {"event":"delete"}).`);
    }
    if (save.inactiveTotal > 0) {
      lines.push(
        `- Configured but INACTIVE (does not run): ${save.inactiveTotal} — ${Object.entries(save.inactiveByType).map(([t, n]) => `${n} ${t}`).join(', ')}.`,
      );
    }
  }
  const automationWriters = new Set(
    g.fieldInboundAll
      .filter((e) => e.edgeType === 'writesTo')
      .map((e) => e.fromId)
      .filter((id) => !save.ok || !save.steps.some((s) => s.componentId === id)),
  );
  if (automationWriters.size > 0) {
    const writerTypes = new Map<string, number>();
    for (const id of automationWriters) writerTypes.set(typeOf(id), (writerTypes.get(typeOf(id)) ?? 0) + 1);
    lines.push(
      `- Other components that write this object's fields (not part of the sequence above): ${[...writerTypes.entries()]
        .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0]))
        .map(([t, n]) => `${n} ${t}`)
        .join(', ')} (\`sfi.why_field_changed\` per field).`,
    );
  }

  // ── Access ───────────────────────────────────────────────────────────────
  const grants = g.objectInbound.filter((e) => e.edgeType === 'grantedBy');
  const holders = (granterType: string, key: string): string[] =>
    [...new Set(grants.filter((e) => typeOf(e.fromId) === granterType && e.properties[key] === true).map((e) => bare(e.fromId)))].sort(byIdAsc);
  lines.push('');
  const verbs: readonly [string, string][] = [
    ['allowRead', 'Read'],
    ['allowCreate', 'Create'],
    ['allowEdit', 'Edit'],
    ['allowDelete', 'Delete'],
    ['viewAllRecords', 'View All'],
    ['modifyAllRecords', 'Modify All'],
  ];
  // A granter counts only when it grants at least one verb: an entry that is
  // all `false` is a declaration of NO access, not access.
  const granting = grants.filter((e) => verbs.some(([key]) => e.properties[key] === true));
  const profileGranters = new Set(granting.filter((e) => typeOf(e.fromId) === 'Profile').map((e) => e.fromId)).size;
  const permsetGranters = new Set(granting.filter((e) => typeOf(e.fromId) === 'PermissionSet').map((e) => e.fromId)).size;
  lines.push(`## Who can access it (${profileGranters} profile(s), ${permsetGranters} permission set(s) grant at least one object permission)`);
  if (grants.length === 0) {
    lines.push('- No profile or permission set in this vault declares a permission on this object. Standard objects are often granted by profile defaults that are not in retrieved metadata — check `sfi.object_access_audit`.');
  }
  const modifyAll = [...holders('Profile', 'modifyAllRecords'), ...holders('PermissionSet', 'modifyAllRecords')];
  if (grants.length > 0) {
    for (const [key, verb] of verbs) {
      const pr = holders('Profile', key);
      const ps = holders('PermissionSet', key);
      if (pr.length === 0 && ps.length === 0) {
        lines.push(`- ${verb}: none declared.`);
        continue;
      }
      lines.push(
        `- ${verb}: ${pr.length} profile(s)${pr.length > 0 ? ` (${nameList(pr, caps.names)})` : ''}, ` +
          `${ps.length} permission set(s)${ps.length > 0 ? ` (${nameList(ps, caps.names)})` : ''}`,
      );
    }
  }
  lines.push('- These are permission containers, not users; permission set groups are not expanded here (`sfi.object_access_audit` does that). Record-level visibility also depends on sharing.');

  // ── Integrations ─────────────────────────────────────────────────────────
  const touches: IntegrationTouch[] = [];
  const seenTouch = new Set<string>();
  const addTouch = (id: string, how: string): void => {
    if (seenTouch.has(id)) return;
    seenTouch.add(id);
    touches.push({ id, how });
  };
  for (const c of g.children) {
    if (INTEGRATION_NODE_TYPES.has(c.type as never)) addTouch(c.id, `${c.type} owned by this object`);
  }
  for (const e of [...g.objectInbound, ...g.fieldInboundAll]) {
    if (e.edgeType === 'grantedBy' || e.edgeType === 'parentOf') continue;
    const node = g.referrerById.get(e.fromId);
    const t = typeOf(e.fromId);
    if (INTEGRATION_NODE_TYPES.has(t as never)) addTouch(e.fromId, `${t} references it`);
    else if (t === 'ApexClass' && node?.properties['isRestResource'] === true) {
      addTouch(e.fromId, 'Apex REST resource that reads or writes it');
    }
  }
  for (const e of inp.cdcReferrers) {
    const t = e.fromId.slice(0, e.fromId.indexOf(':'));
    if (t === 'PlatformEventChannelMember') addTouch(e.fromId, 'Change Data Capture is enabled for it');
    else if (e.edgeType === 'triggersOn') addTouch(e.fromId, `${t} subscribes to its change events`);
  }
  lines.push('');
  lines.push(`## Integrations touching it (${touches.length})`);
  noteCap('integrations', Math.min(touches.length, caps.integrations), touches.length);
  if (touches.length === 0) {
    lines.push('- None found among outbound messages, named credentials/external services/connected apps that reference it, Apex REST resources that read or write it, and Change Data Capture channel members.');
  }
  for (const t of touches.slice(0, caps.integrations)) lines.push(`- \`${t.id}\` — ${t.how}`);
  moreLine(Math.min(touches.length, caps.integrations), touches.length, 'integration touchpoint(s)');
  lines.push('- Apex callouts are not attributed to an object in the vault; `sfi.endpoint_catalog` / `sfi.integration_map` list them org-wide.');

  // ── Risks ────────────────────────────────────────────────────────────────
  const risks: string[] = [];
  if (activeTriggers >= 2) {
    risks.push(`${activeTriggers} Apex triggers fire in the same phase; Salesforce does not guarantee the order between triggers on one object.`);
  }
  if (flowPhaseUnordered.length > 0) {
    risks.push(`${flowPhaseUnordered.join(' and ')}: two or more flows with no declared trigger order — their relative order is not set by the org.`);
  }
  if (save.ok && save.bypassWarnings > 0) {
    risks.push(`${save.bypassWarnings} trigger bypass switch(es) are set in custom metadata — some trigger logic may not run (see \`sfi.what_happens_on_save\`).`);
  }
  if (workflowRules > 0) {
    risks.push(`${workflowRules} active workflow rule(s) — a legacy automation type running alongside flows/triggers.`);
  }
  if (modifyAll.length > 0) {
    risks.push(`${modifyAll.length} profile(s)/permission set(s) hold Modify All on this object, which bypasses sharing: ${nameList(modifyAll, caps.names)}.`);
  }
  if (validationRules !== null) {
    risks.push(`${validationRules} active validation rule(s) can block a save — their messages are listed above.`);
  }
  if (customFields.length > 0 && undocumented > 0) {
    risks.push(`${undocumented} of ${customFields.length} custom field(s) have neither a description nor help text.`);
  }
  if (save.ok && save.inactiveTotal > 0) {
    risks.push(`${save.inactiveTotal} inactive automation component(s) are still configured on this object — easy to mistake for live logic.`);
  }
  lines.push('');
  lines.push(`## Risk signals (${risks.length})`);
  if (risks.length === 0) lines.push('- None of the checked signals fired (trigger count, flow ordering, bypass switches, workflow rules, Modify All, validation rules, field documentation, inactive automation).');
  for (const r of risks) lines.push(`- ${r}`);

  // ── Where to look next ───────────────────────────────────────────────────
  const topField = keyFields[0];
  const next: string[] = [
    `\`sfi.what_happens_on_save\` {"objectApiName":"${apiName}","event":"update"} — the full ordered save with conditions and actions`,
    `\`sfi.object_access_audit\` {"componentId":"${objectId}"} — every grant incl. permission set groups`,
    `\`sfi.generate_data_dictionary\` {"objectId":"${objectId}"} — every field`,
    ...(topField !== undefined ? [`\`sfi.field_360\` {"fieldId":"${topField.id}"} — everything about one field`] : []),
    `\`sfi.object_360\` {"objectApiName":"${apiName}"} — full usage accounting (reports, pages, code)`,
  ];
  lines.push('');
  lines.push('## Where to look next (non-core tools run through `sfi.run_analysis`)');
  for (const n of next) lines.push(`- ${n}`);

  // The sections format's `boundaries`, condensed: what a reference count
  // can and cannot prove, and the coverage caveat when NOTHING points here.
  const usageEdgeCount =
    g.objectInbound.filter((e) => !NOT_USAGE_EDGE_TYPES.includes(e.edgeType as never)).length + g.fieldInboundAll.length;
  const coverageCaveat =
    usageEdgeCount === 0 ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE) : undefined;
  lines.push('');
  lines.push(
    '_Reference counts read MODELED edges of mixed confidence: metadata declarations are `declared`, Apex references `parsed` or `heuristic`. ' +
      'Dynamic SOQL, reflective access and runtime integration payloads are invisible, so a small or zero count is never proof of disuse._',
  );
  if (coverageCaveat !== undefined) lines.push(`_${coverageCaveat.message}_`);
  lines.push('');
  lines.push(
    '_Metadata only: counts here are components, never records. Record counts, owners and recency need the live tools (`sfi.live_count`, `sfi.live_recent_activity`). `required` is the field\'s declared flag; platform- and layout-required fields are not visible in field metadata._',
  );

  const markdown = lines.join('\n');
  return {
    data: {
      appliedScope: {
        componentId: objectId,
        object: apiName,
        format: 'handbook',
        ...(inp.resolvedFrom !== null ? { resolvedFrom: inp.resolvedFrom } : {}),
      },
      format: 'handbook',
      markdown,
      facts: {
        fields: { total: realFields.length, custom: customFields.length, systemFields: systemFields.length, required: requiredCount, externalId: externalIdCount, unique: uniqueCount, undocumentedCustom: undocumented },
        picklists: picklists.length,
        recordTypes: { total: recordTypes.length, active: rtActive },
        relationships: { parentLookups: businessParents.length, parentTargetNotCaptured: targetless, childObjects: childRows.length },
        saveSequence: save.ok
          ? {
              activeComponents: saveComponentTotal,
              steps: saveStepTotal,
              // false = some phase was counted by the save tool but not listed in full;
              // `activeComponents` / `steps` are then lower bounds.
              complete: !saveIncomplete,
              ...(saveIncomplete ? { incompletePhases: [...save.incompletePhases] } : {}),
              inactiveConfigured: save.inactiveTotal,
            }
          : null,
        access: { profiles: profileGranters, permissionSets: permsetGranters, modifyAll: modifyAll.length },
        integrations: touches.length,
        riskSignals: risks.length,
      },
      truncated: truncation.length > 0,
      ...(truncation.length > 0
        ? {
            truncation,
            truncationNote:
              `Lists are ranked, then capped${ladderStep > 0 ? ` (tightened ${ladderStep} step(s) to fit the ${HANDBOOK_BYTE_BUDGET}-byte budget)` : ''}; ` +
              'each row gives the TRUE total, computed before any cap' +
              (truncation.some((t) => t.atLeast === true)
                ? ' — except rows marked `atLeast`, where the source counted more than it could list and the total is a lower bound.'
                : '.'),
          }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      confidence: 'mixed',
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  };
};
