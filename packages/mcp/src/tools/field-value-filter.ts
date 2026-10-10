/**
 * "What sets field X to value V?" — the value side of writer search.
 *
 * Two jobs, one module:
 *   1. {@link resolveFieldValue} checks the asked value against the field: a
 *      picklist value must be declared (an unknown one is an `invalid-query`
 *      that lists the declared values; an inactive one carries a note), a
 *      checkbox takes only true/false. The picklist gate is shared with
 *      `what_if_remove_picklist_value` ({@link checkDeclaredPicklistValue}).
 *   2. {@link classifyWriteForValue} sorts one writer's written values
 *      (`@sf-intelligence/core` write-values) into `definitely` (a stated
 *      literal equals V), `may` (the value is computed or not captured — says
 *      why), or `cannot` (it writes only other literals).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId, McpError, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import type { Context } from '../server.js';

import { PICKLIST_DATA_TYPES, readFieldDataType } from './field-properties.js';
import { detectPicklistLiteralMismatch } from './picklist-literal-check.js';
import {
  normalizePicklistValues,
  resolveGlobalValueSetValues,
  type NormalizedPicklistValue,
} from './picklist-values.js';

/** How a field's values compare. */
export type FieldValueKind = 'checkbox' | 'picklist' | 'other';

/** Outcome of checking a value against a picklist's declared value set. */
export type DeclaredPicklistCheck =
  | { readonly state: 'not-checked' }
  | { readonly state: 'declared'; readonly match: NormalizedPicklistValue; readonly declared: readonly string[] }
  | { readonly state: 'unknown'; readonly message: string };

/**
 * Check `value` against the field's DECLARED value set — inline, else its
 * GlobalValueSet. `not-checked` = the vault cannot resolve the set (never read
 * as "no values"). `unknown` carries the refusal sentence (declared values +
 * did-you-mean); the caller appends what it did not run.
 */
export const checkDeclaredPicklistValue = async (
  ctx: Context,
  fieldNode: Node,
  fieldId: ComponentId,
  value: string,
): Promise<DeclaredPicklistCheck> => {
  const resolved =
    normalizePicklistValues(fieldNode.properties['picklistValues']) ??
    (await resolveGlobalValueSetValues(ctx, fieldId))?.values ??
    null;
  if (resolved === null) return { state: 'not-checked' };
  const key = value.trim().toLowerCase();
  const match = resolved.find((v) => v.value.trim().toLowerCase() === key);
  if (match !== undefined) {
    return { state: 'declared', match, declared: resolved.map((v) => v.value) };
  }
  const apiName = fieldNode.apiName.length > 0 ? fieldNode.apiName : fieldId;
  const mismatch = detectPicklistLiteralMismatch(apiName, [value], resolved);
  const declaredList =
    (mismatch?.definedValues ?? resolved).map((v) => v.value).join(', ') || '(none)';
  const didYouMean =
    mismatch !== null && mismatch.suggestions.length > 0
      ? ` Did you mean ${mismatch.suggestions.map((sug) => `'${sug}'`).join(' / ')}?`
      : '';
  return {
    state: 'unknown',
    message: `\`${value}\` is not a declared value on \`${fieldId}\`. Declared values: ${declaredList}.${didYouMean} Pass a declared value, or call \`sfi.explain_field\` on this field to list the value set.`,
  };
};

/** The asked value, resolved against the field. */
export interface ResolvedFieldValue {
  /** The value compared against writers: the declared spelling, or `true`/`false` for a checkbox. */
  readonly value: string;
  readonly fieldKind: FieldValueKind;
  /** Picklists only: `active`, `inactive`, or `not-checked` (value set not in the vault). */
  readonly valueSetState?: 'active' | 'inactive' | 'not-checked';
  readonly note?: string;
}

const CHECKBOX_VALUES: Readonly<Record<string, 'true' | 'false'>> = {
  true: 'true',
  '1': 'true',
  false: 'false',
  '0': 'false',
};

/** A checkbox literal as `true`/`false` (workflow updates write `1`/`0`), else null. */
const checkboxLiteral = (raw: string): 'true' | 'false' | null =>
  CHECKBOX_VALUES[raw.trim().toLowerCase()] ?? null;

/**
 * Resolve the asked `value` against the field. Picklist: must be declared
 * (case-insensitive) — an undeclared value is an `invalid-query` listing the
 * declared ones; an inactive one gets a note; an unresolvable set is
 * `not-checked`. Checkbox: only true/false (or 1/0).
 */
export const resolveFieldValue = async (
  ctx: Context,
  fieldNode: Node,
  fieldId: ComponentId,
  value: string,
): Promise<Result<ResolvedFieldValue, McpError>> => {
  const dataType = readFieldDataType(fieldNode);
  if (dataType === 'Checkbox') {
    const normalized = checkboxLiteral(value);
    if (normalized === null) {
      return err({
        kind: 'invalid-query',
        message: `\`${fieldId}\` is a checkbox — pass value \`true\` or \`false\`, not \`${value}\`.`,
        path: 'value',
      });
    }
    return ok({ value: normalized, fieldKind: 'checkbox' });
  }
  if (!PICKLIST_DATA_TYPES.has(dataType)) return ok({ value, fieldKind: 'other' });
  const check = await checkDeclaredPicklistValue(ctx, fieldNode, fieldId, value);
  if (check.state === 'unknown') {
    return err({ kind: 'invalid-query', message: `${check.message} No writer search was run.`, path: 'value' });
  }
  if (check.state === 'not-checked') {
    return ok({
      value,
      fieldKind: 'picklist',
      valueSetState: 'not-checked',
      note: `This field's value set is not in the vault (commonly an unresolved GlobalValueSet or a standard value set), so whether \`${value}\` is a declared value was NOT CHECKED. Writers are matched case-insensitively.`,
    });
  }
  return ok({
    value: check.match.value,
    fieldKind: 'picklist',
    valueSetState: check.match.isActive ? 'active' : 'inactive',
    ...(check.match.isActive
      ? {}
      : {
          note: `\`${check.match.value}\` is INACTIVE on this field: a user cannot pick it, but automation that writes it literally still can (unless the picklist is restricted) and existing records may hold it.`,
        }),
  });
};

/** What one writer's metadata states about the value it writes. */
export interface WriteValueEvidence {
  readonly literals: readonly string[];
  /** Variables / formulas the value comes from. */
  readonly references: readonly string[];
  /** `assignedValueKind`s seen (`literal`, `reference`, `formula`, `relative`, `null`, `rollup`, `unstated`). */
  readonly kinds: readonly string[];
  readonly writerType: string;
  readonly source: string;
  readonly operation?: string;
}

/** Where one writer stands against the asked value. */
export type WriteValueVerdict =
  | { readonly group: 'definitely' }
  | { readonly group: 'may'; readonly why: string }
  | { readonly group: 'cannot'; readonly sets: readonly string[] };

/** Flow global constants are references by syntax but fixed values by meaning. */
const GLOBAL_CONSTANTS: Readonly<Record<string, string>> = {
  '$globalconstant.true': 'true',
  '$globalconstant.false': 'false',
  '$globalconstant.emptystring': '',
};

const BLANK = '(blank)';

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Does a written literal equal the asked value under the field's comparison
 * rules? Checkbox: true/false (or 1/0). Picklist: case-insensitive, any part of
 * a `;`-joined multi-select literal. Otherwise exact (trimmed) — except two
 * numbers compare numerically, since metadata stores `1.0` and `1` alike.
 */
export const literalEqualsValue = (literal: string, target: ResolvedFieldValue): boolean => {
  if (target.fieldKind === 'checkbox') return checkboxLiteral(literal) === target.value;
  if (target.fieldKind === 'picklist') {
    const key = target.value.trim().toLowerCase();
    // Multi-select literals join values with `;`.
    return literal
      .split(';')
      .some((part) => part.trim().toLowerCase() === key);
  }
  const a = literal.trim();
  const b = target.value.trim();
  if (NUMERIC.test(a) && NUMERIC.test(b)) return Number(a) === Number(b);
  return a === b;
};

const UNCAPTURED_WORKFLOW_OPS = new Set(['Literal', 'LookupValue', 'Formula']);

/** Why a writer with no stated value can still set the asked value. */
const uncapturedReason = (e: WriteValueEvidence): string => {
  if (e.writerType === 'ApexClass' || e.writerType === 'ApexTrigger') {
    return 'Apex write — the vault does not capture the value Apex assigns (read the code)';
  }
  if (e.source.startsWith('flow-field-writers-scan')) {
    return 'found by a Flow source scan that does not read the assigned value';
  }
  if (
    (e.writerType === 'WorkflowRule' || e.writerType === 'ApprovalProcess') &&
    e.operation !== undefined &&
    UNCAPTURED_WORKFLOW_OPS.has(e.operation)
  ) {
    return 'this vault predates field-update value capture — rebuild it (`sfi refresh --no-pull`) to resolve the value';
  }
  return 'the value this write assigns was not captured';
};

/**
 * Sort one writer against the asked value. A stated literal equal to it wins
 * (`definitely`, even when the writer also writes other values); any computed
 * or uncaptured value makes it `may` (with why); otherwise it writes only other
 * literals (`cannot`, listing them).
 */
export const classifyWriteForValue = (
  evidence: WriteValueEvidence,
  target: ResolvedFieldValue,
): WriteValueVerdict => {
  const literals = [...evidence.literals];
  const references: string[] = [];
  for (const ref of evidence.references) {
    const constant = GLOBAL_CONSTANTS[ref.trim().toLowerCase()];
    if (constant === undefined) references.push(ref);
    else literals.push(constant);
  }
  if (literals.some((l) => l.length > 0 && literalEqualsValue(l, target))) return { group: 'definitely' };

  const kinds = new Set(evidence.kinds.length > 0 ? evidence.kinds : ['unstated']);
  const why: string[] = [];
  if (references.length > 0) {
    why.push(
      kinds.has('formula')
        ? `a formula computes the value (\`${references.join('`, `')}\`)`
        : `the value comes from \`${references.join('`, `')}\` (a variable / formula, not resolvable offline)`,
    );
  }
  if (kinds.has('relative')) {
    why.push("moves the picklist to its next / previous value — depends on the record's current value");
  }
  if (kinds.has('rollup')) why.push('a DLRS rollup computes the value from child records');
  const statesNothing = literals.length === 0 && references.length === 0 && !kinds.has('null');
  if (kinds.has('unstated') || (statesNothing && why.length === 0)) why.push(uncapturedReason(evidence));
  if (why.length > 0) return { group: 'may', why: why.join('; ') };

  const sets = [...new Set(literals.map((l) => (l.length === 0 ? BLANK : l)))];
  if (kinds.has('null') && !sets.includes(BLANK)) sets.push(BLANK);
  return { group: 'cannot', sets };
};

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const decodeXml = (s: string): string => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => XML_ENTITIES[e] ?? '');

/** The literal a Flow `<value>` block states, or null when it is a reference. */
const flowValueLiteral = (block: string): string | null => {
  const m = /<(stringValue|booleanValue|numberValue|dateValue|dateTimeValue)>([\s\S]*?)<\/\1>/.exec(block);
  if (m !== null) return decodeXml(m[2] ?? '');
  if (/<stringValue\s*\/>/.test(block)) return '';
  const ref = /<elementReference>([^<]+)<\/elementReference>/.exec(block)?.[1];
  return ref === undefined ? null : (GLOBAL_CONSTANTS[ref.trim().toLowerCase()] ?? null);
};

/**
 * Every literal a Flow's source writes to a field NAMED `fieldApiName`, on any
 * object: `<inputAssignments>` of record creates / updates and `<assignmentItems>`
 * assigning `X.{field}`. Name-only on purpose — it is a re-check for writes the
 * graph did not attribute (an update through `$Record.Lookup__r`, a record
 * variable), never evidence on its own.
 */
export const flowSourceLiteralWrites = (xml: string, fieldApiName: string): string[] => {
  const field = fieldApiName.toLowerCase();
  const out: string[] = [];
  for (const m of xml.matchAll(/<inputAssignments>([\s\S]*?)<\/inputAssignments>/g)) {
    const block = m[1] ?? '';
    const f = /<field>([^<]+)<\/field>/.exec(block)?.[1];
    if (f?.trim().toLowerCase() !== field) continue;
    const v = flowValueLiteral(/<value>([\s\S]*?)<\/value>/.exec(block)?.[1] ?? '');
    if (v !== null) out.push(v);
  }
  for (const m of xml.matchAll(/<assignmentItems>([\s\S]*?)<\/assignmentItems>/g)) {
    const block = m[1] ?? '';
    const ref = /<assignToReference>([^<]+)<\/assignToReference>/.exec(block)?.[1]?.trim().toLowerCase();
    if (ref === undefined || !ref.endsWith(`.${field}`)) continue;
    if (/<operator>([^<]+)<\/operator>/.exec(block)?.[1] !== 'Assign') continue;
    const v = flowValueLiteral(/<value>([\s\S]*?)<\/value>/.exec(block)?.[1] ?? '');
    if (v !== null) out.push(v);
  }
  return out;
};

/**
 * Re-check a Flow judged `cannot` against its own source: when the source
 * writes the asked value to a same-named field in an element the graph did
 * not attribute to this field, the `cannot` claim is unproven — return why it
 * MAY set the value. Null when the source does not, or cannot be read.
 */
export const flowSourceMaySetReason = async (
  ctx: Context,
  flow: Node,
  fieldApiName: string,
  target: ResolvedFieldValue,
): Promise<string | null> => {
  if (flow.type !== 'Flow' || typeof flow.sourcePath !== 'string' || flow.sourcePath.length === 0) return null;
  let xml: string;
  try {
    xml = await readFile(join(ctx.vaultRoot, flow.sourcePath), 'utf-8');
  } catch {
    return null;
  }
  const hit = flowSourceLiteralWrites(xml, fieldApiName).some((v) => v.length > 0 && literalEqualsValue(v, target));
  return hit
    ? `its source writes \`${target.value}\` to a \`${fieldApiName}\` field in an element the vault did not attribute to this field (e.g. an update through a relationship such as \`$Record.Lookup__r\`) — likely this field; check by hand`
    : null;
};
