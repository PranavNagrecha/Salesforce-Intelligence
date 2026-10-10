/**
 * Handler for the `sfi.what_if_remove_picklist_value` MCP tool.
 *
 * v2.3 R2a — the "I'm dropping a value from this picklist — what
 * breaks?" surface. Given a `CustomField:{Object}.{Field}` id (which
 * must be a Picklist or MultiselectPicklist) and a value to remove,
 * walks every incoming dependency edge and surfaces the structured
 * impact across:
 *
 *   - **formula sources** (ValidationRule, CustomField formula, etc.)
 *     whose tokenized formula text contains the value as a literal —
 *     these will fail to compile when the value is removed.
 *   - **Apex classes / triggers** with the value in their string-literal
 *     index AND an existing `readsFrom` / `writesTo` edge to the field
 *     (per the v0.3 scanner) — the conjunction narrows the recognition
 *     to heuristic-confident matches.
 *   - **Flow / workflow conditions** — every ConditionalContext that tests
 *     the field, matched on its structured `conditionItems` (Flow and
 *     workflow criteria render UNQUOTED, so a quoted needle never matched
 *     them) and attributed to the FIRER with a `where` line per use.
 *     Inactive Flows go to `informational` (they do not run).
 *   - **Flow formula resources** — `ISPICKVAL({!$Record.F}, 'X')` read from the
 *     Flow node's `formulaValueRefs` (no edge reaches the field).
 *   - **Field-write and filter edges** — literal writes (`assignedValue` /
 *     `literalValues`: Flow, workflow and approval field updates) and Flow
 *     Get/Update/Delete Records filters (`filterValue`).
 *   - **Record types, criteria sharing rules, list view filters, Lightning
 *     page visibility rules** — read from graph properties / source. Record
 *     types only LIST the value (it is dropped from them), so they go to
 *     `informational` and never move compatibility or verdict.
 *   - `notChecked` names what is NOT read (reports, path assistants, …).
 *
 * **Compatibility classification.** Always `breaking` when impacts
 * exist, `review` when no static references match (the value may still
 * be touched dynamically). v2.3's posture: a picklist-value removal is
 * structurally significant by definition, but if no static references
 * exist the recommendation is to spot-check dynamic Apex before
 * applying.
 *
 * **Per-edge category assignment.**
 *
 *   | Source type                    | Category           |
 *   |--------------------------------|--------------------|
 *   | ValidationRule                 | metadata-blocker   |
 *   | CustomField (formula source)   | metadata-blocker   |
 *   | WorkflowRule                   | metadata-blocker   |
 *   | Flow                           | metadata-blocker   |
 *   | ConditionalContext             | metadata-blocker   |
 *   | ApexClass / ApexTrigger        | code-needs-update  |
 *   | (other)                        | configuration-only |
 *
 * **Aggregate verdict.** Same rules as the field-type tool:
 *   - `safe`: never returned while `notChecked` names a family (it always
 *     does) — an empty scan is `review`.
 *   - `risky`: only code-needs-update.
 *   - `blocking`: any metadata-blocker.
 *
 * **Boundary disclosure.** Surfaces the key limitation: Apex
 * variable-based picklist comparisons are invisible to the static
 * recognizer — only string-literal patterns in source code are detected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  conditionItemsTestingValue,
  edgeLiteralValues,
  expressionNamesValue,
  literalNamesValue,
  splitCompoundValue,
} from './condition-value-literals.js';
import {
  buildCoverageCaveat,
  VALUE_LITERAL_READER_COVERAGE,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { PICKLIST_DATA_TYPES, readFieldDataType } from './field-properties.js';
import { checkDeclaredPicklistValue } from './field-value-filter.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';


/** Compatibility verdicts the tool emits. */
type Compatibility = 'breaking' | 'review';

/** Impact category assigned based on the type of metadata or code affected. */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only';

/** One impact entry in the response — mirrors the field-type tool. */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
  /**
   * Every place this component uses the value (`entry criteria: Status__c
   * EqualTo X`, `writes X`, `Get Records filter`, …). Absent for a match found
   * only by the formula / literal text scan.
   */
  readonly where?: readonly string[];
  /** Flow status when not Active — an inactive flow does not run. */
  readonly status?: string;
}

/** Payload wrapped in the `McpResponse` envelope on success. */
export interface WhatIfRemovePicklistValueOutput {
  readonly fieldId: ComponentId;
  readonly value: string;
  readonly fieldType: string;
  readonly compatibility: Compatibility;
  readonly impacts: readonly WhatIfImpactItem[];
  /**
   * Components that hold the value but do NOT break and never move
   * `compatibility` / `verdict`: record types that list it (the value is just
   * dropped from them) and Flows that use it but do not run (Draft/Obsolete).
   */
  readonly informational: readonly WhatIfImpactItem[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  /**
   * Whether the value the caller named is actually ON this field.
   *
   * `not-checked` means the vault could not resolve the value set at all — it
   * is NOT a synonym for "the value is fine". A destructive verdict whose
   * subject was never verified has to say so.
   */
  readonly valueState: 'active' | 'inactive' | 'not-checked';
  /** The declared value set; `null` when `valueState` is `not-checked`. */
  readonly declaredValues: readonly string[] | null;
  /** Verbatim `valueState`-driven disclosures. Absent when `active`. */
  readonly boundaries?: readonly string[];
  /** The field is a restricted picklist: a write of the removed value FAILS. */
  readonly restricted: boolean | null;
  /**
   * Places a literal can live that this answer did NOT check — absence there
   * is "not checked", never "none".
   */
  readonly notChecked: readonly string[];
}

/**
 * Verbatim boundary for a value that is already deactivated. The scan STILL
 * runs — deactivating and deleting are different operations with different
 * blast radii, and the caller asked about the delete.
 */
const inactiveValueBoundary = (value: string): string =>
  `\`${value}\` is already INACTIVE on this field: it cannot be selected on new records, but existing records may still hold it. Removing it from the value set is a metadata delete, not a deactivation — the impact below is the impact of the DELETE.`;

/** Verbatim boundary when the vault cannot resolve the value set at all. */
const notCheckedBoundary = (value: string): string =>
  `This field's value set is not inline in the vault — commonly a GlobalValueSet reference this refresh did not resolve. Whether \`${value}\` is a declared value was NOT CHECKED, and the impact scan below assumes it exists. Confirm the value in Setup before acting.`;

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * v2.0a / v0.3 boundary: Apex code recognition is limited to static
 * string literals; dynamic Apex and variable-based comparisons are invisible.
 */
const DISCLOSURE =
  "Checked: formulas, validation rules, workflow/approval criteria, Flow entry criteria, decisions, Get/Update/Delete Records filters, formula resources, literal field writes (Flow `<stringValue>`, incl. record-variable and before-save assignments; workflow and approval field updates), Apex string literals, record types, criteria sharing rules, list view filters and Lightning page visibility rules / related-list filters. Invisible: Flow values set through a variable or formula (`<elementReference>`), Flow formulas reaching the field through a relationship or an unresolved variable, Variable-based picklist comparisons in Apex, dynamic SOQL, and reflective access via `obj.get('FieldName')` — review those manually.";

/** Families that can embed a picklist literal but are not read by this tool. */
const NOT_CHECKED_FAMILIES: readonly string[] = [
  'report and dashboard filters',
  'path assistants',
  'Flow screen-component visibility rules and text templates',
  'dependent-picklist (controlling value) matrices',
  'Apex/LWC comparisons against variables, dynamic SOQL',
];

/**
 * Zod schema for the `sfi.what_if_remove_picklist_value` tool input.
 *
 *   - `fieldId`: required, non-empty CustomField id. Picklist /
 *     MultiselectPicklist type enforcement happens at handler time
 *     (so the error envelope is typed) rather than via Zod refine.
 *   - `value`: required, non-empty string. The picklist value's API
 *     name (case-sensitive literal matching what appears in formulas
 *     and source code).
 */
export const whatIfRemovePicklistValueInputSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string().min(1),
});

export type WhatIfRemovePicklistValueInput = z.infer<
  typeof whatIfRemovePicklistValueInputSchema
>;

/**
 * Build a case-sensitive needle that matches the value as a literal in
 * formula / Apex / Flow expression text. The needle is wrapped in
 * common quote characters so a substring match against the source
 * literal recognises both `'Tech'` and `"Tech"` shapes.
 *
 * Returns the array of candidate needles; the caller checks any of
 * them against the expression text.
 */
const buildValueNeedles = (value: string): readonly string[] => [
  `'${value}'`,
  `"${value}"`,
];

/**
 * Check whether any string in `haystackTexts` contains any of the
 * value needles. Used to scan formula expressions, ConditionalContext
 * `expression` text, and Apex `stringLiterals` arrays for the literal.
 */
const containsAnyNeedle = (
  haystackTexts: readonly string[],
  needles: readonly string[],
): boolean => {
  for (const text of haystackTexts) {
    for (const needle of needles) {
      if (text.includes(needle)) return true;
    }
  }
  return false;
};

/**
 * Extract candidate expression / formula / literal text from a node's
 * `properties` for the value scan. Different extractors populate
 * different property keys; we union them all so a single scanner can
 * walk the node.
 *
 *   - `expression`: ConditionalContext, WorkflowRule, ValidationRule.
 *   - `formula`: ValidationRule errorConditionFormula, CustomField
 *     formula source.
 *   - `errorConditionFormula`: ValidationRule alternate key.
 *   - `stringLiterals`: v0.3 apex-scanner output (array of strings).
 *   - `criteria`: WorkflowRule / AssignmentRule criteria text.
 *
 * Returns every text value coerced to string; arrays are flattened.
 */
const extractHaystackTexts = (node: Node): readonly string[] => {
  const texts: string[] = [];
  const candidates = [
    'expression',
    'formula',
    'errorConditionFormula',
    'criteria',
    'description',
    'body',
  ];
  for (const key of candidates) {
    const v = node.properties[key];
    if (typeof v === 'string') texts.push(v);
  }
  const literals = node.properties['stringLiterals'];
  if (Array.isArray(literals)) {
    for (const l of literals) {
      if (typeof l === 'string') texts.push(l);
    }
  }
  return texts;
};

/**
 * Classify the source node + edge into a finding category.
 */
const classifyCategory = (edge: Edge, fromNode: Node): Category => {
  const t = fromNode.type;
  if (t === 'ValidationRule') return 'metadata-blocker';
  if (t === 'WorkflowRule') return 'metadata-blocker';
  if (t === 'Flow') return 'metadata-blocker';
  if (t === 'ConditionalContext') return 'metadata-blocker';
  if (t === 'CustomField') return 'metadata-blocker';
  if (t === 'ApexClass' || t === 'ApexTrigger') return 'code-needs-update';
  if (
    t === 'LightningComponentBundle' ||
    t === 'AuraDefinitionBundle' ||
    t === 'VisualforcePage' ||
    t === 'VisualforceComponent'
  ) {
    return 'code-needs-update';
  }
  if (t === 'ExternalService' || t === 'ExternalDataSource') {
    return 'integration-touch';
  }
  if (edge.edgeType === 'writesTo' || edge.edgeType === 'readsFrom') {
    return 'code-needs-update';
  }
  return 'configuration-only';
};

/**
 * Synthesise the per-finding `explanation` string for a literal-match
 * finding. Names the source and the value to make the citation
 * audit-friendly.
 */
const buildExplanation = (
  fromNode: Node,
  value: string,
): string => {
  return `${fromNode.type} '${fromNode.apiName}' references the literal '${value}'; removing the picklist value will break this reference.`;
};

/** Human label for where a ConditionalContext sits in its firer. */
const conditionLabel = (cc: Node): string => {
  const kind = cc.properties['kind'];
  if (kind === 'flow-recordtrigger') {
    return cc.properties['entryRequiresRecordChange'] === true
      ? 'entry criteria (fires only when a save changes the record to meet them)'
      : 'entry criteria';
  }
  if (kind === 'flow-decision') {
    const name = cc.properties['sourceName'];
    return typeof name === 'string' ? `decision ${name}` : 'decision';
  }
  return 'criteria';
};

/**
 * The ways one ConditionalContext compares `fieldId` to `value`, rendered for
 * the answer — empty when it does not. Structured `conditionItems` first; the
 * prose expression only on a vault built before those existed.
 */
const conditionUsages = (
  cc: Node,
  fieldId: string,
  fieldApiName: string,
  value: string,
): readonly string[] => {
  const items = conditionItemsTestingValue(cc, fieldId, value);
  const label = conditionLabel(cc);
  if (items !== null) {
    return items.map((i) => `${label}: ${i.field} ${i.operator} '${i.value ?? ''}'`);
  }
  const expr = cc.properties['expression'];
  return typeof expr === 'string' && expressionNamesValue(expr, fieldApiName, value)
    ? [`${label}: ${expr.replace(/\s+/g, ' ').slice(0, 160)}`]
    : [];
};

/** Rendered usage for a field write / Flow filter edge that carries `value` as a literal. */
const edgeUsage = (edge: Edge, restricted: boolean | null): string | null => {
  const op = edge.properties['operation'];
  if (edge.edgeType === 'readsFrom' && op === 'recordFilter') {
    return `${String(edge.properties['element'] ?? 'record')} filter: ${String(edge.properties['filterOperator'] ?? '')} this value`;
  }
  if (edge.edgeType === 'writesTo') {
    return restricted === true
      ? `writes this value (${String(op ?? 'write')}) — on this RESTRICTED picklist the save fails once the value is removed`
      : `writes this value (${String(op ?? 'write')}) — keeps saving a value no longer in the list`;
  }
  return null;
};

/**
 * Aggregate the per-impact verdicts into the headline severity.
 */
const aggregateVerdict = (
  impacts: readonly WhatIfImpactItem[],
): Verdict => {
  if (impacts.length === 0) return 'safe';
  for (const i of impacts) {
    if (i.category === 'metadata-blocker') return 'blocking';
  }
  return 'risky';
};

/** One metadata component that embeds the value without a value-level edge. */
interface ValueBearingHit {
  readonly node: Node;
  readonly category: Category;
  readonly usage: string;
  /** What actually happens to this component when the value is removed. */
  readonly explanation: string;
  /** Holds the value but does not break: never moves compatibility/verdict. */
  readonly informational?: true;
}

const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const sameName = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * `<criteria>` blocks of a Lightning page visibility rule that compare
 * `{!Record.Field}` to the value. A page bound to ANOTHER object
 * (`<sobjectType>`) is skipped: its `Record.Field` is that object's field.
 */
const flexiPageVisibilityMatches = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
  value: string,
): boolean => {
  const pageObject = /<sobjectType>([^<]*)<\/sobjectType>/.exec(xml)?.[1];
  if (pageObject !== undefined && pageObject.toLowerCase() !== objectApiName.toLowerCase()) return false;
  const blocks = xml.match(/<criteria>[\s\S]*?<\/criteria>/g) ?? [];
  return blocks.some((block) => {
    const left = /<leftValue>([^<]*)<\/leftValue>/.exec(block)?.[1] ?? '';
    const right = /<rightValue>([^<]*)<\/rightValue>/.exec(block)?.[1] ?? '';
    return (
      new RegExp(`Record\\.${fieldApiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'i').test(left) &&
      splitCompoundValue(right, ',').includes(value)
    );
  });
};

const decodeXmlEntities = (v: string): string =>
  v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Lightning page related lists (`adminFilters` = `Field|OP|["v1","v2"]`) that
 * filter on the value. Counted only when the list's `relatedListApiName` is a
 * child relationship of the field's object, so a same-named field on another
 * object never matches.
 */
const flexiPageRelatedListFilterMatches = (
  xml: string,
  childRelationships: ReadonlySet<string>,
  fieldApiName: string,
  value: string,
): boolean => {
  const instances = xml.match(/<componentInstance>[\s\S]*?<\/componentInstance>/g) ?? [];
  return instances.some((block) => {
    const rel = /<name>relatedListApiName<\/name>\s*<value>([^<]*)<\/value>/.exec(block)?.[1];
    if (rel === undefined || !childRelationships.has(rel.toLowerCase())) return false;
    const filters = /<name>adminFilters<\/name>([\s\S]*?)<\/componentInstanceProperties>/.exec(block)?.[1] ?? '';
    const values = [...filters.matchAll(/<value>([^<]*)<\/value>/g)].map((m) => decodeXmlEntities(m[1] ?? ''));
    return values.some((f) => {
      const [field, , raw] = f.split('|');
      if (field === undefined || raw === undefined || field.toLowerCase() !== fieldApiName.toLowerCase()) return false;
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.some((v) => v === value);
      } catch {
        return splitCompoundValue(raw, ',').includes(value);
      }
    });
  });
};

/** `<filters>` of a list view that compare the field to the value. */
const listViewFilterMatches = (xml: string, fieldApiName: string, value: string): boolean => {
  const blocks = xml.match(/<filters>[\s\S]*?<\/filters>/g) ?? [];
  return blocks.some((block) => {
    const field = /<field>([^<]*)<\/field>/.exec(block)?.[1] ?? '';
    const v = /<value>([^<]*)<\/value>/.exec(block)?.[1] ?? '';
    return field.split('.').pop()?.toLowerCase() === fieldApiName.toLowerCase() &&
      splitCompoundValue(v, ',').includes(value);
  });
};

/**
 * Record types (their per-field value lists) and criteria sharing rules are
 * read from the graph; list view filters and Lightning page visibility rules
 * from the source of the list views / pages already linked to the field.
 * `unreadable` names any family whose source could not be opened.
 */
const scanValueBearingMetadata = async (
  ctx: Context,
  objectApiName: string,
  fieldApiName: string,
  value: string,
  incoming: readonly Edge[],
): Promise<Result<{ hits: ValueBearingHit[]; unreadable: string[] }, McpError>> => {
  const hits: ValueBearingHit[] = [];
  const unreadable = new Set<string>();
  const children = await scanAllNodesOfTypes(ctx.graph, ['RecordType', 'SharingRule'], {
    parentId: `CustomObject:${objectApiName}` as ComponentId,
  });
  if (!children.ok) return err({ kind: 'internal', message: children.error.message });
  if (children.value.scanIncomplete) unreadable.add('some record types / sharing rules (scan cap)');
  for (const node of children.value.nodes) {
    if (node.type === 'RecordType') {
      const picklists = node.properties['picklists'];
      if (!Array.isArray(picklists)) continue;
      const listed = picklists.some(
        (p) =>
          typeof p === 'object' && p !== null &&
          sameName((p as Record<string, unknown>)['field'], fieldApiName) &&
          Array.isArray((p as Record<string, unknown>)['values']) &&
          ((p as Record<string, unknown>)['values'] as unknown[]).some(
            (v) => typeof v === 'string' && safeDecode(v) === value,
          ),
      );
      if (listed) {
        hits.push({
          node,
          category: 'configuration-only',
          usage: 'record type lists this value',
          explanation: `RecordType '${node.apiName}' lists this value; removing it only drops the value from this record type — nothing breaks.`,
          informational: true,
        });
      }
    } else {
      const items = node.properties['criteriaItems'];
      if (!Array.isArray(items)) continue;
      const matches = items.some((i) => {
        if (typeof i !== 'object' || i === null) return false;
        const r = i as Record<string, unknown>;
        const field = typeof r['field'] === 'string' ? r['field'].split('.').pop() ?? '' : '';
        return sameName(field, fieldApiName) && typeof r['value'] === 'string' &&
          splitCompoundValue(r['value'], ',').includes(value);
      });
      if (matches) {
        hits.push({
          node,
          category: 'invisible-risk',
          usage: 'sharing-rule criteria match this value — records holding it stop being shared',
          explanation: `SharingRule '${node.apiName}' shares records that hold this value; records that no longer hold it stop being shared by this rule.`,
        });
      }
    }
  }
  const readSource = async (node: Node, family: string): Promise<string | null> => {
    try {
      return await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      unreadable.add(`${family} (source not readable)`);
      return null;
    }
  };
  // List views: the ones already linked to the field.
  const seen = new Set<string>();
  for (const edge of incoming) {
    if (!edge.fromId.startsWith('ListView:') || seen.has(edge.fromId)) continue;
    seen.add(edge.fromId);
    const nodeResult = await getNodeById(ctx.graph, edge.fromId);
    if (!nodeResult.ok) return err({ kind: 'internal', message: nodeResult.error.message });
    const node = nodeResult.value;
    if (node === null) continue;
    const xml = await readSource(node, 'list view filters');
    if (xml !== null && listViewFilterMatches(xml, fieldApiName, value)) {
      hits.push({
        node,
        category: 'configuration-only',
        usage: 'list view filter',
        explanation: `ListView '${node.apiName}' filters on this value; that filter term matches nothing once the value is removed.`,
      });
    }
  }
  // Lightning pages: EVERY page, because neither a visibility rule on
  // `{!Record.Field}` nor a related-list filter mints an edge to the field.
  const fields = await scanAllNodesOfTypes(ctx.graph, ['CustomField'], {
    parentId: `CustomObject:${objectApiName}` as ComponentId,
  });
  if (!fields.ok) return err({ kind: 'internal', message: fields.error.message });
  const childRelationships = new Set<string>();
  for (const f of fields.value.nodes) {
    const rn = f.properties['relationshipName'];
    if (typeof rn === 'string' && rn.length > 0) childRelationships.add(`${rn}__r`.toLowerCase());
  }
  const pages = await scanAllNodesOfTypes(ctx.graph, ['FlexiPage']);
  if (!pages.ok) return err({ kind: 'internal', message: pages.error.message });
  if (pages.value.scanIncomplete) unreadable.add('some Lightning pages (scan cap)');
  for (const node of pages.value.nodes) {
    const xml = await readSource(node, 'Lightning pages');
    if (xml === null || !xml.toLowerCase().includes(fieldApiName.toLowerCase())) continue;
    if (flexiPageVisibilityMatches(xml, objectApiName, fieldApiName, value)) {
      hits.push({
        node,
        category: 'configuration-only',
        usage: 'Lightning page component visibility rule',
        explanation: `FlexiPage '${node.apiName}' shows or hides a component on this value; that rule stops matching once the value is removed.`,
      });
    } else if (flexiPageRelatedListFilterMatches(xml, childRelationships, fieldApiName, value)) {
      hits.push({
        node,
        category: 'configuration-only',
        usage: 'Lightning page related-list filter',
        explanation: `FlexiPage '${node.apiName}' filters a related list on this value; that filter term matches nothing once the value is removed.`,
      });
    }
  }
  return ok({ hits, unreadable: [...unreadable] });
};

/** One Flow formula resource that uses the value, as rendered in `where`. */
interface FlowFormulaHit {
  readonly node: Node;
  readonly usages: readonly string[];
}

/**
 * Flow `<formulas>` resources that test the field against the value. These
 * carry no edge to the field (a formula's reads reach the graph only through a
 * DML element that consumes it), so they are read from the Flow node's
 * `formulaValueRefs` / `formulaComparisons`. `legacyFlows` counts Flow nodes built before that
 * property existed — their formulas were NOT checked.
 */
const scanFlowFormulaResources = async (
  ctx: Context,
  qualifiedField: string,
  value: string,
): Promise<Result<{ hits: FlowFormulaHit[]; legacyFlows: number; capped: boolean }, McpError>> => {
  const flows = await scanAllNodesOfTypes(ctx.graph, ['Flow']);
  if (!flows.ok) return err({ kind: 'internal', message: flows.error.message });
  const target = qualifiedField.toLowerCase();
  const hits: FlowFormulaHit[] = [];
  let legacyFlows = 0;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  for (const node of flows.value.nodes) {
    const refs = node.properties['formulaValueRefs'];
    if (!Array.isArray(refs)) {
      legacyFlows += 1;
      continue;
    }
    const pairs = node.properties['formulaComparisons'];
    const comparedIn = new Set(
      (Array.isArray(pairs) ? pairs : []).flatMap((c) => {
        if (typeof c !== 'object' || c === null) return [];
        const cc = c as Record<string, unknown>;
        return sameName(cc['field'], target) && cc['value'] === value && typeof cc['formula'] === 'string'
          ? [cc['formula']]
          : [];
      }),
    );
    const usages: string[] = [];
    for (const raw of refs) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r['name'] === 'string' ? r['name'] : '?';
      if (comparedIn.has(name)) {
        usages.push(`formula resource ${name}: compares this field to '${value}'`);
      } else if (
        strings(r['fields']).some((f) => f.toLowerCase() === target) &&
        strings(r['literals']).includes(value)
      ) {
        usages.push(`formula resource ${name}: names this field and '${value}' (comparison not proven)`);
      }
    }
    if (usages.length > 0) hits.push({ node, usages });
  }
  return ok({ hits, legacyFlows, capped: flows.value.scanIncomplete });
};

/**
 * The `sfi.what_if_remove_picklist_value` MCP tool.
 *
 * @example
 *   const r = await whatIfRemovePicklistValueHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *     value: 'Tech',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
export const whatIfRemovePicklistValueHandler = async (
  ctx: Context,
  input: WhatIfRemovePicklistValueInput,
): Promise<Result<McpResponse<WhatIfRemovePicklistValueOutput>, McpError>> => {
  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }

  // Enforce the Picklist / MultiselectPicklist requirement. The
  // CustomField extractor stores the data type under
  // `properties.dataType` (see field-properties.ts); a missing/legacy
  // value resolves to 'Unknown', which fails the picklist guard below.
  const fieldType = readFieldDataType(nodeResult.value);
  if (!PICKLIST_DATA_TYPES.has(fieldType)) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} has type '${fieldType}'; expected Picklist or MultiselectPicklist`,
      path: 'fieldId',
    });
  }

  const value = input.value;

  // VALUE EXISTENCE GATE. This is a destructive-verdict tool: a typo'd value
  // used to return a `review` verdict byte-identical to a real value's, and
  // the caller's next action is a metadata delete. Resolve the DECLARED value
  // set first — inline, else the field's GlobalValueSet edge.
  const check = await checkDeclaredPicklistValue(ctx, nodeResult.value, fieldId, value);

  let valueState: 'active' | 'inactive' | 'not-checked';
  let declaredValues: readonly string[] | null;
  const boundaries: string[] = [];
  if (check.state === 'not-checked') {
    // NOT resolvable. Proceed, but never as though the value was checked.
    valueState = 'not-checked';
    declaredValues = null;
    boundaries.push(notCheckedBoundary(value));
  } else if (check.state === 'unknown') {
    // Resolved and NOT present (an empty-but-present value set lands here too,
    // `Declared values: (none)` — different from `not-checked`). Refuse.
    return err({
      kind: 'invalid-query',
      message: `${check.message} No impact scan was run.`,
      path: 'value',
    });
  } else {
    valueState = check.match.isActive ? 'active' : 'inactive';
    declaredValues = check.declared;
    if (!check.match.isActive) boundaries.push(inactiveValueBoundary(value));
  }

  const needles = buildValueNeedles(value);
  const fieldNode = nodeResult.value;
  const fieldApiName = fieldId.slice(fieldId.indexOf('.') + 1);
  const objectApiName = fieldId.slice(CUSTOM_FIELD_PREFIX.length, fieldId.indexOf('.'));
  const restricted =
    typeof fieldNode.properties['restricted'] === 'boolean'
      ? (fieldNode.properties['restricted'] as boolean)
      : null;

  // Walk every incoming edge; for each source node, check whether its
  // searchable text fields contain the value literal.
  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // One finding per component; every usage it makes of the value is listed.
  const impactsById = new Map<ComponentId, WhatIfImpactItem>();
  const nodeCache = new Map<string, Node | null>();
  const loadNode = async (id: string): Promise<Result<Node | null, McpError>> => {
    if (nodeCache.has(id)) return ok(nodeCache.get(id) ?? null);
    const r = await getNodeById(ctx.graph, id as ComponentId);
    if (!r.ok) return err({ kind: 'internal', message: `graph query failed: ${r.error.message}` });
    nodeCache.set(id, r.value);
    return ok(r.value);
  };
  // Components that hold the value but do not break (record types, Flows that
  // do not run) — reported in `informational`, never in the verdict.
  const informationalIds = new Set<ComponentId>();
  const addImpact = (
    node: Node,
    category: Category,
    confidence: ConfidenceLevel,
    usages: readonly string[],
    hit?: Pick<ValueBearingHit, 'explanation' | 'informational'>,
  ): void => {
    const prior = impactsById.get(node.id);
    const status = typeof node.properties['status'] === 'string' ? node.properties['status'] : null;
    const inactiveFlow = node.type === 'Flow' && status !== null && status !== 'Active';
    if (inactiveFlow || hit?.informational === true) informationalIds.add(node.id);
    const where = [...(prior?.where ?? []), ...usages.filter((u) => !(prior?.where ?? []).includes(u))];
    impactsById.set(node.id, {
      category: inactiveFlow ? 'configuration-only' : (prior?.category ?? category),
      componentId: node.id,
      componentType: node.type,
      apiName: node.apiName,
      confidence: prior?.confidence ?? confidence,
      explanation: inactiveFlow
        ? `Flow '${node.apiName}' uses this value but is ${status} and does not run; update it before reactivating.`
        : (prior?.explanation ?? hit?.explanation ?? buildExplanation(node, value)),
      ...(where.length > 0 ? { where } : {}),
      ...(inactiveFlow && status !== null ? { status } : {}),
    });
  };

  for (const edge of edgesResult.value) {
    if (edge.edgeType === 'parentOf') continue;
    const fromLoaded = await loadNode(edge.fromId);
    if (!fromLoaded.ok) return fromLoaded;
    const fromNode = fromLoaded.value;
    if (fromNode === null) continue;

    // A condition that tests the field: attribute the use to its FIRER (the
    // Flow / rule that runs), naming where and how it compares the value.
    if (fromNode.type === 'ConditionalContext') {
      const usages = conditionUsages(fromNode, fieldId, fieldApiName, value);
      if (usages.length === 0) continue;
      const firerId = fromNode.parentId ?? (edge.properties['firerId'] as string | undefined) ?? null;
      const firer = firerId === null ? null : await loadNode(firerId);
      if (firer !== null && !firer.ok) return firer;
      const owner = firer?.value ?? fromNode;
      addImpact(owner, classifyCategory(edge, owner), edge.confidence, usages);
      continue;
    }

    // A field write (Flow / workflow / approval) or Flow record filter carrying the value as a literal.
    if (edgeLiteralValues(edge).some((v) => literalNamesValue(v, value))) {
      const usage = edgeUsage(edge, restricted);
      addImpact(fromNode, classifyCategory(edge, fromNode), edge.confidence, usage === null ? [] : [usage]);
      continue;
    }

    if (impactsById.has(fromNode.id)) continue;
    if (containsAnyNeedle(extractHaystackTexts(fromNode), needles)) {
      addImpact(fromNode, classifyCategory(edge, fromNode), edge.confidence, []);
      continue;
    }

    // Firers whose own edge reached the field: their conditions may still
    // carry the value (older vaults route every Flow condition this way).
    if (
      fromNode.type === 'Flow' ||
      fromNode.type === 'WorkflowRule' ||
      fromNode.type === 'ValidationRule' ||
      fromNode.type === 'ApprovalProcess'
    ) {
      const ccEdges = await listEdges(ctx.graph, fromNode.id, { direction: 'out', edgeType: 'firesWhen' });
      if (!ccEdges.ok) return err({ kind: 'internal', message: ccEdges.error.message });
      const usages: string[] = [];
      for (const ccEdge of ccEdges.value) {
        const cc = await loadNode(ccEdge.toId);
        if (!cc.ok) return cc;
        if (cc.value !== null) usages.push(...conditionUsages(cc.value, fieldId, fieldApiName, value));
      }
      if (usages.length > 0) addImpact(fromNode, classifyCategory(edge, fromNode), edge.confidence, usages);
    }
  }

  // Flow formula resources: no edge reaches the field, read from the node.
  const notChecked = [...NOT_CHECKED_FAMILIES];
  const formulaScan = await scanFlowFormulaResources(ctx, `${objectApiName}.${fieldApiName}`, value);
  if (!formulaScan.ok) return formulaScan;
  for (const hit of formulaScan.value.hits) {
    addImpact(hit.node, 'metadata-blocker', 'heuristic', hit.usages);
  }
  if (formulaScan.value.legacyFlows > 0) {
    notChecked.push(
      `Flow formula resources in ${formulaScan.value.legacyFlows} Flow(s) built before they were extracted (re-run refresh)`,
    );
  }
  if (formulaScan.value.capped) notChecked.push('Flow formula resources past the scan cap');

  // Metadata that embeds the literal but carries no value-level edge: record
  // types (graph property), criteria sharing rules, list view filters and
  // Lightning page visibility rules (source scan).
  const extra = await scanValueBearingMetadata(ctx, objectApiName, fieldApiName, value, edgesResult.value);
  if (!extra.ok) return extra;
  for (const hit of extra.value.hits) {
    addImpact(hit.node, hit.category, 'heuristic', [hit.usage], hit);
  }
  notChecked.push(...extra.value.unreadable);

  // Deterministic ordering; informational entries never reach the verdict.
  const sorted = [...impactsById.values()].sort((a, b) =>
    a.componentId < b.componentId ? -1
      : a.componentId > b.componentId ? 1
      : 0,
  );
  const sortedImpacts = sorted.filter((i) => !informationalIds.has(i.componentId));
  const informational = sorted.filter((i) => informationalIds.has(i.componentId));

  const compatibility: Compatibility =
    sortedImpacts.length === 0 ? 'review' : 'breaking';
  // Shares `VALUE_LITERAL_READER_COVERAGE` and `buildCoverageCaveat` with
  // `value_change_audit` — the two answer the same coverage question about the
  // same field and must not drift apart again.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    VALUE_LITERAL_READER_COVERAGE,
    'Picklist-value removal impact',
  );
  const rawVerdict = aggregateVerdict(sortedImpacts);
  // `safe` would claim more than was read: `notChecked` always names families
  // (report filters, path assistants, …) that can still hold the value.
  const verdict = rawVerdict === 'safe' && (coverageCaveat !== undefined || notChecked.length > 0)
    ? 'review'
    : rawVerdict;

  return ok({
    data: {
      fieldId,
      value,
      fieldType,
      compatibility,
      impacts: sortedImpacts,
      informational,
      verdict,
      valueState,
      declaredValues,
      restricted,
      notChecked,
      ...(boundaries.length > 0 ? { boundaries } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust: {
        provenance: 'offline_snapshot',
        confidence: sortedImpacts.some((impact) => impact.confidence === 'heuristic')
          ? 'heuristic'
          : 'parsed',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
          ...(coverageCaveat !== undefined
            ? { missingCoverage: coverageCaveat.missingCoverage }
            : {}),
        },
        limitations: [
          DISCLOSURE,
          `Not checked (absence there is not "none"): ${notChecked.join('; ')}.`,
          ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
        ],
      },
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
