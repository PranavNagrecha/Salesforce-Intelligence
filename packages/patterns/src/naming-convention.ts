import type { Node, PatternObservation, Result } from '@sf-intelligence/contracts';
import { err, isCustomFieldApiName, ok } from '@sf-intelligence/core';
import {
  type GraphError,
  type GraphStore,
  listNodesByType,
} from '@sf-intelligence/graph';

/**
 * The error variants `recognizeNamingConventions` can return.
 *
 *   - `graph-error`: the underlying graph query failed.
 *   - `invalid-scope`: the supplied scope string is not one of the recognized
 *     shapes (`'all'` or `'CustomField:{ObjectApiName}.*'`).
 */
export interface PatternError {
  readonly kind: 'graph-error' | 'invalid-scope';
  readonly message: string;
}

/**
 * Options for `recognizeNamingConventions`.
 *
 * `scope` narrows analysis to one parent object. Defaults to `'all'`, which
 * analyzes every parent group with at least the minimum number of fields.
 */
export interface RecognizeOptions {
  readonly scope?: string;
}

// Tuning constants. 5 fields is the minimum group size for any pattern to be
// statistically meaningful. 60% is the default adherence bar; the 75% bar
// applies to suffix-only reports (no co-dominant prefix), since suffix is a
// weaker signal than prefix. PAGE_SIZE matches the graph package's max limit.
const MIN_GROUP_SIZE = 5;
const DOMINANT_THRESHOLD = 0.6;
const SUFFIX_ONLY_THRESHOLD = 0.75;
const MAX_EXAMPLES = 5;
const PAGE_SIZE = 500;
const CUSTOM_FIELD_SUFFIX = '__c';
// Semantic suffixes (before `__c`) that encode field type or role.
const SEMANTIC_SUFFIXES: readonly string[] = [
  '_Amount',
  '_Count',
  '_Date',
  '_DateTime',
  '_Email',
  '_ID',
  '_Name',
  '_Number',
  '_Percent',
  '_Phone',
  '_URL',
];
// 2-3 letters followed by underscore — e.g., `Acc_`, `OPP_`.
const PREFIX_PATTERN = /^([A-Za-z]{2,3})_/;

// 'mixed' is a sentinel for "no pattern"; never emitted as a dominant casing.
type Casing = 'PascalCase' | 'snake_case' | 'camelCase' | 'ALL_CAPS' | 'mixed';

interface FieldGroup {
  readonly parentApiName: string;
  readonly fields: readonly Node[];
}

/**
 * What the recognizer LOOKED at, alongside what it found.
 *
 * An empty observation list has to be readable as NOT ENOUGH EVIDENCE rather
 * than "this org has no convention", and that is only possible if the reader
 * can see the denominators.
 */
export interface NamingConventionAnalysis {
  readonly observations: readonly PatternObservation[];
  readonly analyzed: {
    /** Objects in scope that hold at least one CUSTOM field. */
    readonly objectsWithCustomFields: number;
    /** Of those, how many fall under {@link MIN_GROUP_SIZE} and emit nothing. */
    readonly objectsBelowMinimumGroupSize: number;
    readonly minimumGroupSize: number;
    /** Standard fields dropped org-wide before grouping. */
    readonly standardFieldsExcluded: number;
    /** Custom-field count for a SCOPED call; `null` for `scope: 'all'`. */
    readonly scopedObjectCustomFieldCount: number | null;
  };
}

interface DominantValue<T> {
  readonly value: T;
  readonly count: number;
  readonly total: number;
  readonly examples: readonly string[];
}

const stripCustomFieldSuffix = (apiName: string): string =>
  apiName.endsWith(CUSTOM_FIELD_SUFFIX)
    ? apiName.slice(0, -CUSTOM_FIELD_SUFFIX.length)
    : apiName;

const extractPrefix = (name: string): string | null =>
  (PREFIX_PATTERN.exec(name)?.[1] as string | undefined) ?? null;

const extractSuffix = (name: string): string | null =>
  SEMANTIC_SUFFIXES.find(
    (s) => name.endsWith(s) && name.length > s.length,
  ) ?? null;

const classifyCasing = (strippedName: string): Casing => {
  if (strippedName.length === 0) return 'mixed';
  // ALL_CAPS: every letter uppercase; underscores OK. Checked before snake_case
  // so an underscore-bearing all-uppercase name (`STATUS_FIELD`) doesn't fall
  // through to "mixed".
  if (
    strippedName === strippedName.toUpperCase() &&
    /[A-Z]/.test(strippedName)
  ) {
    return 'ALL_CAPS';
  }
  if (strippedName.includes('_')) {
    return /^[a-z][a-z0-9_]*$/.test(strippedName) ? 'snake_case' : 'mixed';
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(strippedName)) return 'PascalCase';
  if (/^[a-z][A-Za-z0-9]*$/.test(strippedName)) return 'camelCase';
  return 'mixed';
};

// Returns the most-common key produced by `keyOf` and its supporting evidence:
// match count, total non-null observations, and up to MAX_EXAMPLES field names.
// Encounter order = the graph's id-sorted order, so examples are deterministic.
const findDominant = <T>(
  fields: readonly Node[],
  keyOf: (strippedName: string) => T | null,
): DominantValue<T> | null => {
  const counts = new Map<T, number>();
  const examples = new Map<T, string[]>();
  let total = 0;
  for (const field of fields) {
    const key = keyOf(stripCustomFieldSuffix(field.apiName));
    if (key === null) continue;
    total += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const ex = examples.get(key) ?? [];
    if (ex.length < MAX_EXAMPLES) ex.push(field.apiName);
    examples.set(key, ex);
  }
  let bestKey: T | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (bestKey === null) return null;
  return {
    value: bestKey,
    count: bestCount,
    total,
    examples: examples.get(bestKey) ?? [],
  };
};

const observation = (
  scope: string,
  statement: string,
  dom: DominantValue<string>,
  // The denominator the `statement` and the dominance threshold use: the
  // group's TOTAL field count, not `dom.total` (which counts only fields that
  // produced a non-null key). Using `dom.total` here made the evidence
  // disagree with the statement — e.g. statement "5 of 8 fields" but evidence
  // `{matching:5, total:5}` when 3 fields were uncategorizable (mixed casing /
  // no prefix). `evidence.matching/evidence.total` must reconstruct the ratio.
  groupTotal: number,
): PatternObservation => ({
  kind: 'naming-convention',
  scope,
  statement,
  evidence: { matching: dom.count, total: groupTotal, examples: dom.examples },
  confidence: 'heuristic',
});

const meetsThreshold = (
  dom: DominantValue<string> | null,
  total: number,
  threshold: number,
): dom is DominantValue<string> =>
  dom !== null && dom.count / total >= threshold;

const analyzeGroup = (group: FieldGroup, out: PatternObservation[]): void => {
  const total = group.fields.length;
  if (total < MIN_GROUP_SIZE) return;
  const scope = `CustomField:${group.parentApiName}.*`;
  const parent = group.parentApiName;

  const prefix = findDominant(group.fields, extractPrefix);
  const prefixHit = meetsThreshold(prefix, total, DOMINANT_THRESHOLD);
  if (prefixHit) {
    const s = `Custom fields on ${parent} use the prefix "${prefix.value}_" (${prefix.count} of ${total} fields)`;
    out.push(observation(scope, s, prefix, total));
  }

  // Suffix is a weaker signal than prefix; with no co-dominant prefix we raise
  // the bar from 60% to 75% so suffix-only reports require stronger evidence.
  const suffix = findDominant(group.fields, extractSuffix);
  const suffixBar = prefixHit ? DOMINANT_THRESHOLD : SUFFIX_ONLY_THRESHOLD;
  if (meetsThreshold(suffix, total, suffixBar)) {
    const s = `Custom fields on ${parent} use the suffix "${suffix.value}" (${suffix.count} of ${total} fields)`;
    out.push(observation(scope, s, suffix, total));
  }

  const casing = findDominant(group.fields, (n) => {
    const c = classifyCasing(n);
    return c === 'mixed' ? null : c;
  });
  if (meetsThreshold(casing, total, DOMINANT_THRESHOLD)) {
    const s = `Custom fields on ${parent} use ${casing.value} naming (${casing.count} of ${total} fields)`;
    out.push(observation(scope, s, casing, total));
  }
};

const fetchAllCustomFields = async (
  store: GraphStore,
): Promise<Result<readonly Node[], GraphError>> => {
  const all: Node[] = [];
  let offset = 0;
  while (true) {
    const page = await listNodesByType(store, 'CustomField', {
      limit: PAGE_SIZE,
      offset,
    });
    if (!page.ok) return page;
    all.push(...page.value);
    if (page.value.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return ok(all);
};

/**
 * Group a field corpus by parent object, keeping ONLY the custom fields.
 *
 * A naming convention is a statement about names THIS ORG chose. Standard
 * field names (`Name`, `AccountId`, `BillingCity`) are chosen by Salesforce, so
 * including them does not merely add noise — it produces false statements:
 * on the reference vault 21 objects have five or more field nodes and ZERO
 * custom fields, and three objects had the reported convention INVERTED by the
 * standard-field majority.
 *
 * Filtering happens at GROUPING time rather than at fetch time so the "how many
 * did we drop" number stays available per object for the disclosure.
 *
 * Namespaced managed-package fields (`ns__Thing__c`) end in `__c` and stay IN.
 * Their convention is the package vendor's rather than this org's, but
 * excluding them is a separate product decision and is not made here.
 */
const groupFieldsByParent = (
  fields: readonly Node[],
): { groups: readonly FieldGroup[]; standardFieldsExcluded: number } => {
  const byParent = new Map<string, Node[]>();
  let standardFieldsExcluded = 0;
  for (const field of fields) {
    if (field.parentId === null) continue;
    if (!isCustomFieldApiName(field.apiName)) {
      standardFieldsExcluded += 1;
      continue;
    }
    const existing = byParent.get(field.parentId) ?? [];
    existing.push(field);
    byParent.set(field.parentId, existing);
  }
  // Parent id format is `CustomObject:{ApiName}` — strip the prefix for the
  // observation scope. Sort by id ascending so output is deterministic.
  const groups = [...byParent.keys()].sort().map((parentId) => ({
    parentApiName: parentId.slice(parentId.indexOf(':') + 1),
    fields: byParent.get(parentId) ?? [],
  }));
  return { groups, standardFieldsExcluded };
};

// Parse a scope string into a parent api name (`'CustomField:X.*'` -> `'X'`)
// or return null for the wildcard scope. Anything else is an invalid scope.
// The trailing `.*` is optional, so `'CustomField:Account'` is accepted as a
// synonym for `'CustomField:Account.*'` (the form many callers reach for).
const parseScope = (
  scope: string | undefined,
): Result<string | null, PatternError> => {
  if (scope === undefined || scope === 'all') return ok(null);
  const match = /^CustomField:([^.]+)(?:\.\*)?$/.exec(scope);
  if (match === null) {
    return err({
      kind: 'invalid-scope',
      message: `unrecognized scope "${scope}"; expected 'all', 'CustomField:{ObjectApiName}', or 'CustomField:{ObjectApiName}.*'`,
    });
  }
  return ok(match[1] as string);
};

/**
 * Walk the graph and report naming conventions for custom fields. Each
 * observation has confidence: 'heuristic' (recognizers don't assert).
 *
 * For each parent object with at least five custom fields, the recognizer
 * detects dominant prefix, suffix, and casing patterns. A pattern is "dominant"
 * when it holds for at least 60% of the fields in that group (75% for suffix
 * patterns without a co-dominant prefix). Below-threshold groups emit no
 * observations; better silence than a noisy false positive.
 *
 * Observations are sorted by `scope` ascending and then by `statement`
 * ascending, so re-running on the same input yields byte-identical output.
 *
 * @example
 *   const result = await recognizeNamingConventions(store);
 *   if (!result.ok) return;
 *   for (const obs of result.value) {
 *     console.log(obs.statement, obs.evidence.matching, '/', obs.evidence.total);
 *   }
 */
export const analyzeNamingConventions = async (
  store: GraphStore,
  options?: RecognizeOptions,
): Promise<Result<NamingConventionAnalysis, PatternError>> => {
  const scopeResult = parseScope(options?.scope);
  if (!scopeResult.ok) return scopeResult;
  const scopedParentApiName = scopeResult.value;

  const fieldsResult = await fetchAllCustomFields(store);
  if (!fieldsResult.ok) {
    return err({
      kind: 'graph-error',
      message: fieldsResult.error.message,
    });
  }

  const { groups, standardFieldsExcluded } = groupFieldsByParent(
    fieldsResult.value,
  );
  const filtered =
    scopedParentApiName === null
      ? groups
      : groups.filter((g) => g.parentApiName === scopedParentApiName);

  const observations: PatternObservation[] = [];
  for (const group of filtered) {
    analyzeGroup(group, observations);
  }

  observations.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.statement !== b.statement)
      return a.statement < b.statement ? -1 : 1;
    return 0;
  });

  return ok({
    observations,
    analyzed: {
      objectsWithCustomFields: filtered.length,
      objectsBelowMinimumGroupSize: filtered.filter(
        (g) => g.fields.length < MIN_GROUP_SIZE,
      ).length,
      minimumGroupSize: MIN_GROUP_SIZE,
      standardFieldsExcluded,
      scopedObjectCustomFieldCount:
        scopedParentApiName === null
          ? null
          : (filtered[0]?.fields.length ?? 0),
    },
  });
};

/**
 * Back-compat adapter: the observation list alone, for the callers that only
 * ever wanted it (`org_card`, `org_overview`, `refresh`). ONE implementation,
 * one thin projection — not a second recognizer.
 */
export const recognizeNamingConventions = async (
  store: GraphStore,
  options?: RecognizeOptions,
): Promise<Result<readonly PatternObservation[], PatternError>> => {
  const result = await analyzeNamingConventions(store, options);
  return result.ok ? ok(result.value.observations) : result;
};
