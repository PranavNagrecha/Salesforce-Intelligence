import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  extractConditions,
  type ConditionSource,
  type CriteriaItem,
} from './condition-extractor.js';
import { deriveComponentApiName } from './path-utils.js';

const ESCALATION_RULES_FILE_SUFFIX = '.escalationRules-meta.xml';
const ROOT_ELEMENT = 'EscalationRules';
const RULE_ELEMENT = 'escalationRule';
const EXTRACTOR_SOURCE = 'escalation-rule-extractor';
const ALLOWED_ASSIGNED_TO_TYPES = ['Queue', 'User'] as const;
// Salesforce's EscalationRule `<escalationStartTime>` enum. The real metadata
// values are `CaseCreation` and `CaseLastModified` (NOT the `SinceCaseCreation`
// / `SinceModified` this list originally guessed, which rejected every real
// `CaseCreation` rule as malformed — found via a real-org grounded refresh).
const ALLOWED_START_TIMES = ['CaseCreation', 'CaseLastModified'] as const;

type AssignedToType = (typeof ALLOWED_ASSIGNED_TO_TYPES)[number];
type EscalationStartTime = (typeof ALLOWED_START_TIMES)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Required-once elements (`fullName`, `active`,
 * `minutesToEscalation`) use this; repeating elements (`ruleEntry`,
 * `escalationAction`, `criteriaItems`) use `toArray` instead.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/**
 * Locate and validate the `<EscalationRules>` root in a parsed XML tree.
 *
 * Per `EscalationRule.md`, a file with an `<EscalationRules>` root but
 * zero child rules is a documented happy path (not an error).
 * fast-xml-parser represents `<EscalationRules/>` and
 * `<EscalationRules></EscalationRules>` as an empty string rather than
 * an empty object; both shapes count as a valid empty root and yield
 * zero nodes/edges.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  if (!(ROOT_ELEMENT in parsed)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root === 'object' && root !== null) {
    return ok(root as Record<string, unknown>);
  }
  // `<EscalationRules/>` / `<EscalationRules></EscalationRules>` — empty but valid.
  if (root === '' || root === null || root === undefined) {
    return ok({});
  }
  return err({
    kind: 'malformed-input',
    path,
    message: `expected <${ROOT_ELEMENT}> root`,
  });
};

/**
 * Convert a `<notifyToTemplate>` value of the form
 * `{Folder}/{TemplateName}` to its canonical
 * `EmailTemplate:{Folder}.{TemplateName}` id.
 */
const templateToEmailTemplateId = (template: string): string => {
  const slash = template.indexOf('/');
  if (slash === -1) {
    return `EmailTemplate:${template}`;
  }
  return `EmailTemplate:${template.slice(0, slash)}.${template.slice(slash + 1)}`;
};

/**
 * The per-`<escalationAction>` resolved bundle. `assignedTo` may be
 * null — a notify-only escalation action carries `<minutesToEscalation>`
 * and (typically) a `<notifyToTemplate>` but no `<assignedTo>`. Both
 * the `references` and `sendsEmail` edges are optional and emitted only
 * when their respective inputs are present.
 */
interface ResolvedAction {
  readonly minutesToEscalation: number;
  readonly assignedToType: AssignedToType | null;
  readonly targetId: string | null;
  readonly notifyToTemplate: string | null;
  readonly notifyTo: string | null;
}

/**
 * Validate and resolve a single `<escalationAction>`. Per
 * `EscalationRule.md`, `<minutesToEscalation>` is required; if
 * `<assignedTo>` is present then `<assignedToType>` is required and
 * must be `Queue` or `User`.
 */
const resolveAction = (
  action: Record<string, unknown>,
  path: string,
): Result<ResolvedAction, ExtractorError> => {
  const minutesRaw = unwrapSingle(action['minutesToEscalation']);
  if (minutesRaw === undefined || minutesRaw === null || minutesRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <minutesToEscalation>',
    });
  }
  // fast-xml-parser with parseTagValue: false leaves all values as
  // strings; coerce numerically here so consumers can compare on the
  // edge property without re-parsing.
  const minutesNum = Number(minutesRaw);

  const assignedToRaw = unwrapSingle(action['assignedTo']);
  const hasAssignedTo =
    assignedToRaw !== undefined && assignedToRaw !== null && assignedToRaw !== '';

  let assignedToType: AssignedToType | null = null;
  let targetId: string | null = null;
  if (hasAssignedTo) {
    const assignedToTypeRaw = unwrapSingle(action['assignedToType']);
    if (
      assignedToTypeRaw === undefined ||
      assignedToTypeRaw === null ||
      assignedToTypeRaw === ''
    ) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <assignedToType>',
      });
    }
    const assignedToTypeStr = String(assignedToTypeRaw);
    if (!ALLOWED_ASSIGNED_TO_TYPES.includes(assignedToTypeStr as AssignedToType)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid assignedToType: ${assignedToTypeStr}`,
      });
    }
    assignedToType = assignedToTypeStr as AssignedToType;
    targetId = `${assignedToType}:${String(assignedToRaw)}`;
  }

  const notifyToTemplateRaw = unwrapSingle(action['notifyToTemplate']);
  const notifyToRaw = unwrapSingle(action['notifyTo']);

  return ok({
    minutesToEscalation: minutesNum,
    assignedToType,
    targetId,
    notifyToTemplate:
      notifyToTemplateRaw === undefined ||
      notifyToTemplateRaw === null ||
      notifyToTemplateRaw === ''
        ? null
        : String(notifyToTemplateRaw),
    notifyTo:
      notifyToRaw === undefined || notifyToRaw === null || notifyToRaw === ''
        ? null
        : String(notifyToRaw),
  });
};

/**
 * The per-`<ruleEntry>` resolved bundle: the ordered list of resolved
 * actions and the optional metadata about the rule entry itself.
 *
 * v2.0a additionally captures the per-entry condition source so the
 * shared `extractConditions` helper can synthesise the
 * ConditionalContext nodes. EscalationRule rule-entries carry their
 * condition surface at the same level as AssignmentRule /
 * AutoResponseRule — formula OR criteriaItems, mutually exclusive
 * (per `ConditionalContextSemantics.md`).
 */
interface ResolvedRuleEntry {
  readonly actions: readonly ResolvedAction[];
  /** v2.0a — the per-entry condition source for `extractConditions`. */
  readonly conditionSource: ConditionSource | null;
}

/**
 * Parse a single `<criteriaItems>` element into the helper's
 * `CriteriaItem` shape. `<field>` / `<operation>` required; `<value>`
 * may be empty (modelled as `null`).
 */
const parseCriteriaItem = (raw: unknown): CriteriaItem | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const fieldRaw = unwrapSingle(obj['field']);
  if (fieldRaw === undefined || fieldRaw === null || fieldRaw === '') {
    return null;
  }
  const operationRaw = unwrapSingle(obj['operation']);
  if (operationRaw === undefined || operationRaw === null || operationRaw === '') {
    return null;
  }
  const valueRaw = unwrapSingle(obj['value']);
  return {
    field: String(fieldRaw),
    operation: String(operationRaw),
    value:
      valueRaw === undefined || valueRaw === null || valueRaw === ''
        ? null
        : String(valueRaw),
  };
};

/**
 * Build the per-entry condition source per the v2.0a spec — formula
 * takes precedence over criteria; an entry with neither produces
 * `null`.
 */
const collectEntryConditionSource = (
  entry: Record<string, unknown>,
): ConditionSource | null => {
  const formulaRaw = unwrapSingle(entry['formula']);
  if (
    formulaRaw !== undefined &&
    formulaRaw !== null &&
    formulaRaw !== ''
  ) {
    return { kind: 'formula', expression: String(formulaRaw) };
  }
  const items: CriteriaItem[] = [];
  for (const raw of toArray(entry['criteriaItems'])) {
    const parsed = parseCriteriaItem(raw);
    if (parsed !== null) items.push(parsed);
  }
  if (items.length === 0) return null;
  const booleanFilterRaw = unwrapSingle(entry['booleanFilter']);
  const booleanFilter =
    booleanFilterRaw === undefined ||
    booleanFilterRaw === null ||
    booleanFilterRaw === ''
      ? null
      : String(booleanFilterRaw);
  return { kind: 'criteria', items, booleanFilter };
};

/**
 * Validate and resolve a single `<ruleEntry>`. Per `EscalationRule.md`,
 * `<escalationAction>` is required (a rule entry without any action
 * makes no operational sense). `<escalationStartTime>`, when present,
 * is validated against the allowed enum.
 */
const resolveRuleEntry = (
  entry: Record<string, unknown>,
  path: string,
): Result<ResolvedRuleEntry, ExtractorError> => {
  const startTimeRaw = unwrapSingle(entry['escalationStartTime']);
  if (
    startTimeRaw !== undefined &&
    startTimeRaw !== null &&
    startTimeRaw !== ''
  ) {
    const startTimeStr = String(startTimeRaw);
    if (!ALLOWED_START_TIMES.includes(startTimeStr as EscalationStartTime)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid escalationStartTime: ${startTimeStr}`,
      });
    }
  }

  const actionsRaw = toArray(entry['escalationAction']).filter(
    (a): a is Record<string, unknown> => typeof a === 'object' && a !== null,
  );
  if (actionsRaw.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <escalationAction>',
    });
  }

  const actions: ResolvedAction[] = [];
  for (const action of actionsRaw) {
    const resolved = resolveAction(action, path);
    if (!resolved.ok) return resolved;
    actions.push(resolved.value);
  }
  return ok({ actions, conditionSource: collectEntryConditionSource(entry) });
};

/**
 * Build a per-rule Node + outgoing edges. Each rule emits one `parentOf`
 * edge from `CustomObject:{ObjectApiName}`; for each `<escalationAction>`,
 * one optional `references` edge to the assignment target and one
 * optional `sendsEmail` edge to the notification template. The
 * `entryIndex` + `actionIndex` pair preserves the chain order which
 * Salesforce uses to fire actions in sequence.
 */
const buildRule = (
  rule: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  path: string,
): Result<
  {
    readonly node: Node;
    readonly edges: readonly Edge[];
    readonly conditionNodes: readonly Node[];
  },
  ExtractorError
> => {
  const fullNameRaw = unwrapSingle(rule['fullName']);
  if (fullNameRaw === undefined || fullNameRaw === null || fullNameRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <fullName>',
    });
  }
  const activeRaw = unwrapSingle(rule['active']);
  if (activeRaw === undefined || activeRaw === null || activeRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <active>',
    });
  }
  const fullName = String(fullNameRaw);
  const active = coerceBoolean(activeRaw);

  const ruleEntries = toArray(rule['ruleEntry']).filter(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
  );
  const resolvedEntries: ResolvedRuleEntry[] = [];
  for (const entry of ruleEntries) {
    const resolved = resolveRuleEntry(entry, path);
    if (!resolved.ok) return resolved;
    resolvedEntries.push(resolved.value);
  }

  const ruleId = `EscalationRule:${objectApiName}.${fullName}`;
  const actionCount = resolvedEntries.reduce(
    (acc, e) => acc + e.actions.length,
    0,
  );

  // v2.0a — emit one ConditionalContext per `<ruleEntry>` with a
  // populated condition source. Entries lacking criteria/formula are
  // silently skipped per the spec's fail-conservative posture.
  const conditionSources: ConditionSource[] = [];
  for (const entry of resolvedEntries) {
    if (entry.conditionSource !== null) {
      conditionSources.push(entry.conditionSource);
    }
  }
  const { conditionNodes, firesWhenEdges, conditionsMirror, conditionFieldEdges } =
    extractConditions({
      parentId: ruleId,
      sources: conditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  const node: Node = {
    id: ruleId,
    type: 'EscalationRule',
    apiName: `${objectApiName}.${fullName}`,
    label: fullName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active,
      ruleEntryCount: resolvedEntries.length,
      actionCount,
      conditions: conditionsMirror,
    },
  };

  const edges: Edge[] = [
    {
      fromId: parentId,
      toId: ruleId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
  ];

  for (let entryIndex = 0; entryIndex < resolvedEntries.length; entryIndex += 1) {
    const entry = resolvedEntries[entryIndex]!;
    for (let actionIndex = 0; actionIndex < entry.actions.length; actionIndex += 1) {
      const action = entry.actions[actionIndex]!;
      if (action.targetId !== null && action.assignedToType !== null) {
        edges.push({
          fromId: ruleId,
          toId: action.targetId,
          edgeType: 'references',
          confidence: 'declared',
          source: EXTRACTOR_SOURCE,
          properties: {
            entryIndex,
            actionIndex,
            minutesToEscalation: action.minutesToEscalation,
            assignedToType: action.assignedToType,
          },
        });
      }
      if (action.notifyToTemplate !== null) {
        edges.push({
          fromId: ruleId,
          toId: templateToEmailTemplateId(action.notifyToTemplate),
          edgeType: 'sendsEmail',
          confidence: 'declared',
          source: EXTRACTOR_SOURCE,
          properties: {
            entryIndex,
            actionIndex,
            minutesToEscalation: action.minutesToEscalation,
            notifyTo: action.notifyTo,
          },
        });
      }
    }
  }

  // v2.0a — Append the firesWhen edges at the tail.
  edges.push(...firesWhenEdges, ...conditionFieldEdges);

  return ok({ node, edges, conditionNodes });
};

/**
 * Extract Nodes and Edges from a single Salesforce
 * `*.escalationRules-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<EscalationRules>`
 * root per the vendored `EscalationRule.md` spec, and returns an
 * `ExtractionResult` containing one `'EscalationRule'` Node per
 * `<escalationRule>` child. The root file itself produces no Node;
 * only the individual rules do.
 *
 * Each rule emits a `parentOf` edge from `CustomObject:{ObjectApiName}`
 * to the rule. For every `<escalationAction>` carrying an
 * `<assignedTo>` + `<assignedToType>`, the extractor emits a
 * `references` edge to the resolved target
 * (`{Queue,User}:{assignedTo}`). For every `<escalationAction>`
 * carrying a `<notifyToTemplate>`, the extractor emits a `sendsEmail`
 * edge to the resolved EmailTemplate canonical id. The
 * `entryIndex` + `actionIndex` pair preserves the chain order;
 * Salesforce fires actions in `<minutesToEscalation>` sequence and the
 * chain order is load-bearing.
 *
 * Notify-only actions (no `<assignedTo>`) emit only the `sendsEmail`
 * edge when a template is set, never a `references` edge for ownership
 * — this is the documented happy path for "page a manager but don't
 * re-route ownership".
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<active>` / `<escalationAction>` /
 * `<minutesToEscalation>` / `<assignedToType>` (when `<assignedTo>` is
 * set), or out-of-enum `<assignedToType>` / `<escalationStartTime>`).
 *
 * @example
 *   const result = await extractEscalationRule(
 *     'force-app/main/default/escalationRules/Case.escalationRules-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'EscalationRule:Case.P1_Case_Escalation'
 *   }
 */
export const extractEscalationRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale escalation-rules XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const objectApiName = deriveComponentApiName(
    path,
    ESCALATION_RULES_FILE_SUFFIX,
  );
  const parentId = `CustomObject:${objectApiName}`;

  const rules = toArray(rootObj[RULE_ELEMENT]).filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const rule of rules) {
    const built = buildRule(rule, objectApiName, parentId, path);
    if (!built.ok) return built;
    nodes.push(built.value.node);
    // v2.0a — Append the synthetic ConditionalContext nodes per rule.
    nodes.push(...built.value.conditionNodes);
    edges.push(...built.value.edges);
  }

  return ok({ nodes, edges });
};
