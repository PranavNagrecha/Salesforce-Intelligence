/**
 * Wave 1 — the Flow CONNECTOR-GRAPH projection (spec §4.1 types + §4.2
 * connector extraction + §4.3 rules).
 *
 * `flow.ts` extracts a Flow's *component-level* edges (Flow → CustomField /
 * CustomObject / ApexClass …) plus two connector *summary flags*
 * (`hasImmediateConnector`, `scheduledPathTypes`). It has never modeled the
 * element-to-element `<connector><targetReference>` graph — the thing that
 * says "what runs next". THIS module fills that gap: it walks the parsed
 * `<Flow>` root and produces a faithful structural projection — every canvas
 * element with its REAL `<name>`, its `<label>`, and the flow author's own
 * `<description>`, the full connector graph (`from → to → kind`), decision
 * rules, assignment items, record-op filters, screen fields, action input /
 * output parameters, loops, formulas, variables, subflows, and the `<start>`
 * element including scheduled paths.
 *
 * Design contract (spec §4.3 — the honesty spine):
 *   - **Real names always.** Element `name` is the metadata `<name>`, never a
 *     synthetic `condition-N`.
 *   - **Faithful, NOT lossless.** What IS projected is carried verbatim —
 *     expressions, `conditionLogic`, filter triplets, offsets, screen
 *     `fieldText`, action parameter values. What is NOT projected is COUNTED,
 *     never implied absent: an element type whose body this parser does not
 *     model keeps its identity row and lands in `unmodeled[]`, and every
 *     top-level `<Flow>` container that contributes no datum to the payload
 *     lands in `unprojected[]` with its occurrence count. An empty
 *     `unmodeled[]` therefore no longer reads as "nothing was dropped" — the
 *     two lists together are the measured gap for THIS flow.
 *   - **No inference.** No reachability, dead-branch detection, or ordering is
 *     computed here; that is the host LLM's / `flow_trace`'s job.
 *   - **Object-level trust.** `RecordOp.objectResolution` mirrors the shipped
 *     record-DML resolution ({@link resolveInputReferenceObject}).
 *
 * `connectors[]` is the AUTHORITATIVE full graph; the per-element `connectsTo`
 * fields are conveniences derived in the same pass. `elements[]` is the
 * COMPLETE index of connector endpoints — including unmodeled element types,
 * which were previously connector targets with no element row at all.
 */

import type { ExtractorError, Result } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { buildFlowDataflowIndex } from './flow-dataflow.js';
import {
  asRecord,
  FLOW_XML_PARSER_OPTIONS,
  resolveInputReferenceObject,
  toArray,
  toNonEmptyString,
  toNullableString,
  unwrapSingle,
} from './flow.js';

const ROOT_ELEMENT = 'Flow';

/**
 * The synthetic sentinel used as the `from` of every edge that originates at
 * the `<start>` element. Flow's `<start>` carries no `<name>`, and a real
 * element name can never begin with `$`, so this can never collide with one.
 */
const START_SENTINEL = '$start';

// ---------------------------------------------------------------------------
// §4.1 Projection types
// ---------------------------------------------------------------------------

/**
 * One edge of the element-to-element connector graph (spec §4.2 — the
 * load-bearing new piece). `from` is the source element's `<name>` (or
 * {@link START_SENTINEL} for `<start>`-originated edges); `to` is the
 * `<targetReference>` element name.
 */
export interface Connector {
  readonly from: string;
  readonly to: string;
  readonly kind:
    | 'default'
    | 'immediate'
    | 'rule'
    | 'fault'
    | 'nextValue'
    | 'noMoreValues'
    | 'scheduled';
  /** For `kind:'rule'` — the decision outcome (`<rules><name>`) this edge leaves. */
  readonly ruleName?: string;
  /** For `kind:'scheduled'` — the `<scheduledPaths><name>` this edge leaves. */
  readonly scheduledPathName?: string;
  /** `<isGoTo>true</isGoTo>` — a reconnect / loop-back edge, NOT a distinct element. */
  readonly isGoTo?: boolean;
}

/** A lightweight connector target for the `<start>.connector` convenience field. */
export interface ConnectorTarget {
  readonly to: string;
  readonly isGoTo?: boolean;
}

/**
 * One canvas element, identified by its real `<name>` + `<label>` + type.
 *
 * `description` is the flow AUTHOR's own `<description>` — the answer to "what
 * does this element do", written by the person who built the flow. It is
 * present only when the element declares a non-empty one, so an element with
 * no author note is byte-identical to before this field existed. `elements[]`
 * is always kept under every narrowing knob, which makes it the one place a
 * description survives an `include`-narrowed response.
 *
 * `type: 'unmodeled'` is an element whose CONTAINER this parser recognises but
 * whose BODY it does not model (see {@link KNOWN_UNMODELED_ELEMENT_KEYS}).
 * Its identity (`name`/`label`/`description`) and its `container` are real; its
 * body semantics are the honest gap recorded in `unmodeled[]`. Before this
 * existed such an element was a connector TARGET with no element row, so
 * `elements[]` was not a complete index of connector endpoints.
 */
export interface FlowElement {
  readonly name: string;
  readonly label: string | null;
  readonly type:
    | 'decision'
    | 'assignment'
    | 'recordCreate'
    | 'recordUpdate'
    | 'recordLookup'
    | 'recordDelete'
    | 'loop'
    | 'screen'
    | 'action'
    | 'subflow'
    | 'wait'
    | 'start'
    | 'end'
    | 'unmodeled';
  /** The flow author's `<description>` — omitted when the element declares none. */
  readonly description?: string;
  /** For `type:'unmodeled'` — the `<Flow>` child container it came from (e.g. `collectionProcessors`). */
  readonly container?: string;
  readonly locationX?: number;
  readonly locationY?: number;
}

/** A single condition triplet, carried verbatim (spec §4.1). */
export interface Condition {
  readonly leftValueReference: string;
  readonly operator: string;
  readonly rightValue: string | null;
  readonly rightValueKind: 'literal' | 'reference' | 'null';
}

/** A `<decisions>` element: its default outcome label + every `<rules>` branch. */
export interface Decision {
  readonly name: string;
  readonly label: string | null;
  readonly defaultConnectorLabel: string | null;
  readonly rules: readonly {
    readonly name: string;
    readonly label: string | null;
    readonly conditionLogic: string | null;
    readonly conditions: readonly Condition[];
    readonly connectsTo: string | null;
  }[];
}

/** An `<assignments>` element: its `<assignmentItems>` + outgoing connector. */
export interface Assignment {
  readonly name: string;
  readonly items: readonly {
    readonly assignToReference: string;
    readonly operator: string;
    readonly value: string | null;
    readonly valueKind: 'literal' | 'reference';
  }[];
  readonly connectsTo: string | null;
}

/** A record DML element (`<recordCreates|Updates|Lookups|Deletes>`). */
export interface RecordOp {
  readonly name: string;
  readonly kind: 'create' | 'update' | 'lookup' | 'delete';
  readonly object: string | null;
  readonly objectResolution:
    | 'object'
    | 'inputReference'
    | 'triggerRecord'
    | 'unresolved';
  readonly filters: readonly Condition[];
  readonly filterLogic: string | null;
  readonly inputAssignments: readonly {
    readonly field: string;
    readonly value: string | null;
    readonly valueKind: 'literal' | 'reference';
  }[];
  readonly connectsTo: string | null;
  readonly faultConnectsTo: string | null;
}

/** A `<loops>` element: its collection + the two branch targets. */
export interface Loop {
  readonly name: string;
  readonly collectionReference: string;
  readonly iterationOrder: string | null;
  readonly nextValueConnectsTo: string | null;
  readonly noMoreValuesConnectsTo: string | null;
}

/**
 * A `<formulas>` resource: name + declared dataType + verbatim expression, plus
 * the author's `<description>` when one is declared (omitted otherwise — a
 * formula with no author note is byte-identical to before this field existed).
 * Formulas have no canvas element row, so the description lives here.
 */
export interface Formula {
  readonly name: string;
  readonly dataType: string | null;
  readonly expression: string;
  readonly description?: string;
}

/**
 * A `<variables>` resource declaration, plus the author's `<description>` when
 * one is declared (omitted otherwise). Variables have no canvas element row, so
 * the description lives here.
 */
export interface Variable {
  readonly name: string;
  readonly dataType: string | null;
  readonly objectType: string | null;
  readonly isCollection: boolean;
  readonly isInput: boolean;
  readonly isOutput: boolean;
  readonly description?: string;
}

/** A `<start><scheduledPaths>` entry. */
export interface ScheduledPath {
  readonly name: string;
  readonly label: string | null;
  readonly offsetNumber: number | null;
  readonly offsetUnit: string | null;
  readonly timeSource: string | null;
  readonly connectsTo: string | null;
}

/**
 * A `<subflows>` element. `targetFlowId` is the canonical `Flow:{flowName}`
 * id; `resolved` is always `false` from the pure parser (it has no graph to
 * check the target against — the tool layer overlays vault resolution).
 */
export interface Subflow {
  readonly name: string;
  readonly targetFlowId: string;
  readonly resolved: boolean;
  readonly connectsTo: string | null;
  readonly faultConnectsTo: string | null;
}

/**
 * One `<inputParameters>` / screen-field parameter: its `<name>` and the
 * `<value>` wrapper unwrapped to a scalar plus a `literal | reference`
 * discriminator (an `<elementReference>` is a variable / formula / `$Record`
 * path, never a literal). `valueKind: 'unset'` is a parameter declared with no
 * value at all — distinct from a literal empty string.
 */
export interface ActionParameter {
  readonly name: string;
  readonly value: string | null;
  readonly valueKind: 'literal' | 'reference' | 'unset';
}

/** One `<outputParameters>`: which action output lands in which flow resource. */
export interface ActionOutput {
  readonly name: string;
  readonly assignToReference: string;
}

/**
 * An `<actionCalls>` element. `actionType` + `actionName` are the action's
 * IDENTITY; `inputParameters` is what makes two calls of the SAME action
 * distinguishable — without it every `emailSimple` call projects identically
 * and a reader cannot tell who gets emailed, with what subject, from which
 * sender. Values are carried verbatim from the metadata, references included
 * (`recipientId` → `Application.Applicant__r.Id` is the answer to "who").
 * No attempt is made to read inside the invoked Apex / packaged action: what an
 * action DOES with its inputs is outside this projection.
 */
export interface ActionCall {
  readonly name: string;
  readonly actionType: string | null;
  readonly actionName: string | null;
  readonly inputParameters: readonly ActionParameter[];
  readonly outputParameters: readonly ActionOutput[];
  readonly connectsTo: string | null;
  readonly faultConnectsTo: string | null;
}

/**
 * One `<screens><fields>` entry — recursive, because a `Region` /
 * `RegionContainer` field nests its own `<fields>`.
 *
 * REFUTED PREMISE, recorded here so nobody re-derives it: Flow screen fields
 * carry NO `<label>` element (the Metadata API's `FlowScreenField` has none;
 * probed across every screen field in the reference vault — 313 fields, 0
 * labels). The human-visible text is `fieldText`: the body copy for a
 * `DisplayText` field, the prompt for an input field. There is no label to
 * parse, so none is fabricated.
 *
 * `extensionName` names the LWC / Aura component behind a `ComponentInstance`
 * field, and `inputParameters` carries what that component is configured with —
 * together they are the "what does this screen actually show" answer.
 */
export interface ScreenField {
  /**
   * The field's `<name>`, or `null` for the field types Salesforce emits
   * WITHOUT one — an `ObjectProvided` field inside a record form is identified
   * by its `objectFieldReference` (`Object.Field`) instead. Requiring a name
   * silently dropped 18 of the 313 screen fields in the reference vault, which
   * is the exact defect this projection exists to stop; a nameless field is
   * kept and its null name is stated.
   */
  readonly name: string | null;
  readonly fieldType: string | null;
  readonly dataType: string | null;
  /** Display copy / input prompt, verbatim (may contain HTML). */
  readonly fieldText: string | null;
  readonly helpText: string | null;
  readonly isRequired: boolean | null;
  /** For `ComponentInstance` fields — the LWC/Aura extension rendered here. */
  readonly extensionName: string | null;
  /** For `ObjectProvided` fields — the `Object.Field` this input is bound to. */
  readonly objectFieldReference: string | null;
  /** `<choiceReferences>` — names of the `<choices>` / `<dynamicChoiceSets>` resources offered. */
  readonly choiceReferences: readonly string[];
  readonly inputParameters: readonly ActionParameter[];
  /** `<visibilityRule><conditionLogic>` — null when the field is always shown. */
  readonly visibilityLogic: string | null;
  /** `<visibilityRule><conditions>` triplets — empty when the field is always shown. */
  readonly visibilityConditions: readonly Condition[];
  /** Nested fields of a `Region` / `RegionContainer`; empty for a leaf field. */
  readonly fields: readonly ScreenField[];
}

/**
 * A `<screens>` element with its FIELDS. A screen's inputs are exactly what the
 * decisions and assignments downstream of it reference, so projecting a screen
 * as name + label alone left those references dangling in the payload.
 */
export interface Screen {
  readonly name: string;
  readonly label: string | null;
  readonly allowBack: boolean | null;
  readonly allowFinish: boolean | null;
  readonly allowPause: boolean | null;
  readonly nextOrFinishButtonLabel: string | null;
  readonly fields: readonly ScreenField[];
  readonly connectsTo: string | null;
}

/**
 * One top-level `<Flow>` container this projection carries NO datum for, with
 * the number of occurrences the flow actually declares. Computed per flow from
 * the parsed XML — a MEASUREMENT of this response's gap, not a boilerplate
 * caveat, so a flow that declares none of them emits an empty list truthfully.
 *
 *   - `resource` — a referencable resource (`constants`, `textTemplates`,
 *     `choices`, `dynamicChoiceSets`). Elements reference these BY NAME, so an
 *     unprojected resource is a dangling reference in the payload.
 *   - `element` — a canvas-element container this parser does not recognise at
 *     all (distinct from {@link KNOWN_UNMODELED_ELEMENT_KEYS}, whose elements
 *     DO get an identity row and land in `unmodeled[]`).
 *   - `metadata` — flow-level metadata outside the structural projection
 *     (`processMetadataValues`, `environments`, `interviewLabel`,
 *     `triggerOrder`, …).
 */
export interface UnprojectedContainer {
  readonly container: string;
  readonly count: number;
  readonly kind: 'resource' | 'element' | 'metadata';
}

/** The `<start>` element projection, including entry criteria + scheduled paths. */
export interface FlowStart {
  readonly triggerType: string | null;
  readonly recordTriggerType: string | null;
  readonly object: string | null;
  readonly doesRequireRecordChangedToMeetCriteria: boolean | null;
  readonly filterLogic: string | null;
  readonly filters: readonly Condition[];
  /**
   * A record-triggered start's `<filterFormula>` entry gate — the modern
   * alternative to structured `<filters>` triplets. Verbatim formula text (or
   * `null` when the start uses structured filters or no criteria). A projection,
   * not an evaluation: consumers that walk entry (e.g. `flow_trace`) must treat a
   * non-null formula as a real gate, never as "no criteria = always enters"
   * (FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA).
   */
  readonly filterFormula: string | null;
  readonly scheduledPaths: readonly ScheduledPath[];
  readonly connector: ConnectorTarget | null;
}

/**
 * The faithful structural projection of a single Flow's metadata (spec §4.1,
 * minus the `flowRef` + `meta` fields the MCP tool layer composes from the
 * graph node). `connectors[]` is the authoritative element graph.
 */
export interface FlowGraphProjection {
  /** The flow-level `<description>` — the author's own "what is this flow for". */
  readonly description: string | null;
  readonly start: FlowStart;
  readonly elements: readonly FlowElement[];
  readonly connectors: readonly Connector[];
  readonly decisions: readonly Decision[];
  readonly assignments: readonly Assignment[];
  readonly recordOps: readonly RecordOp[];
  readonly loops: readonly Loop[];
  readonly screens: readonly Screen[];
  readonly formulas: readonly Formula[];
  readonly variables: readonly Variable[];
  readonly subflows: readonly Subflow[];
  readonly actions: readonly ActionCall[];
  /**
   * Canvas elements whose BODY semantics the parser does not model, by
   * `<name>`. Their identity + connectors ARE projected (each has a
   * `type:'unmodeled'` row in `elements[]`); only the body is the gap.
   */
  readonly unmodeled: readonly string[];
  /**
   * Top-level `<Flow>` containers this projection carries no datum for, with
   * per-flow occurrence counts. Together with `unmodeled[]` this is the measured
   * answer to "what did you drop" — see {@link UnprojectedContainer}.
   */
  readonly unprojected: readonly UnprojectedContainer[];
}

// ---------------------------------------------------------------------------
// XML-shape helpers (built on flow.ts's exported normalizers)
// ---------------------------------------------------------------------------

/**
 * Normalize a fast-xml-parser child into an array of records. Skips non-object
 * entries defensively. Local (rather than importing `toArray` + mapping) so
 * every call site iterates a clean `Record[]`.
 */
const toRecordArray = (value: unknown): Record<string, unknown>[] => {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: Record<string, unknown>[] = [];
  for (const raw of arr) {
    const rec = asRecord(raw);
    if (rec !== null) out.push(rec);
  }
  return out;
};

/** Parse an XML scalar as a finite number, or `null` when absent/unparseable. */
const toNumber = (value: unknown): number | null => {
  const s = toNonEmptyString(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parse an XML boolean (`true`/`false`) as `boolean | null` (null when absent). */
const toNullableBoolean = (value: unknown): boolean | null => {
  const s = toNonEmptyString(value);
  if (s === null) return null;
  return s.toLowerCase() === 'true';
};

/** Parse an XML boolean as a strict `boolean` (absent/anything-else → false). */
const toBoolean = (value: unknown): boolean =>
  String(unwrapSingle(value)).toLowerCase() === 'true';

/** A parsed `<connector>` (or `<*Connector>`) child: its target + goto flag. */
interface ParsedConnector {
  readonly target: string;
  readonly isGoTo: boolean;
}

/**
 * Read a single connector-bearing child (`<connector>`, `<defaultConnector>`,
 * `<faultConnector>`, `<nextValueConnector>`, …) into its `<targetReference>`
 * + `<isGoTo>` flag. Returns `null` when the child is absent or carries no
 * (non-empty) target.
 */
const readConnector = (raw: unknown): ParsedConnector | null => {
  const obj = asRecord(unwrapSingle(raw));
  if (obj === null) return null;
  const target = toNonEmptyString(obj['targetReference']);
  if (target === null) return null;
  return { target, isGoTo: toBoolean(obj['isGoTo']) };
};

/**
 * Parse one Flow condition triplet into a lossless {@link Condition}. Decision
 * `<conditions>` use `<leftValueReference>` / `<operator>` / `<rightValue>`;
 * `<start>` and record-op `<filters>` use `<field>` / `<operator>` / `<value>`
 * — both schemas are accepted (left = `leftValueReference ?? field`, right =
 * `rightValue ?? value`) so entry-criteria and record-op filters are never
 * silently dropped. The right operand is wrapped in a typed scalar
 * (`stringValue`, `numberValue`, …) OR an `<elementReference>`; `rightValueKind`
 * records which so a consumer never mistakes a reference for a literal. Returns
 * `null` when the triplet lacks a left ref/field or operator.
 */
const parseCondition = (raw: Record<string, unknown>): Condition | null => {
  const left =
    toNonEmptyString(raw['leftValueReference']) ?? toNonEmptyString(raw['field']);
  const operator = toNonEmptyString(raw['operator']);
  if (left === null || operator === null) return null;
  const rawRight = unwrapSingle(
    raw['rightValue'] !== undefined ? raw['rightValue'] : raw['value'],
  );
  let rightValue: string | null = null;
  let rightValueKind: Condition['rightValueKind'] = 'null';
  const wrapper = asRecord(rawRight);
  if (wrapper !== null) {
    for (const key of [
      'stringValue',
      'numberValue',
      'booleanValue',
      'dateValue',
      'dateTimeValue',
    ]) {
      const v = unwrapSingle(wrapper[key]);
      if (v !== undefined && v !== null && v !== '') {
        rightValue = String(v);
        rightValueKind = 'literal';
        break;
      }
    }
    if (rightValue === null) {
      const ref = unwrapSingle(wrapper['elementReference']);
      if (ref !== undefined && ref !== null && ref !== '') {
        rightValue = String(ref);
        rightValueKind = 'reference';
      }
    }
  } else if (rawRight !== undefined && rawRight !== null && rawRight !== '') {
    rightValue = String(rawRight);
    rightValueKind = 'literal';
  }
  return { leftValueReference: left, operator, rightValue, rightValueKind };
};

/** Parse every `<conditions>` (or `<filters>`) triplet child into {@link Condition}s. */
const parseConditions = (raw: unknown): Condition[] => {
  const out: Condition[] = [];
  for (const rec of toRecordArray(raw)) {
    const cond = parseCondition(rec);
    if (cond !== null) out.push(cond);
  }
  return out;
};

/**
 * Parse an assignment / input-assignment `<value>` into its unwrapped scalar +
 * a `literal | reference` discriminator. Returns `null` when no value is
 * present. An `<elementReference>` is a variable/formula/`$Record` path (a
 * reference); every scalar wrapper is a literal.
 */
const parseValue = (
  raw: unknown,
): { value: string; kind: 'literal' | 'reference' } | null => {
  const obj = asRecord(unwrapSingle(raw));
  if (obj === null) {
    const bare = unwrapSingle(raw);
    if (bare !== undefined && bare !== null && bare !== '') {
      return { value: String(bare), kind: 'literal' };
    }
    return null;
  }
  for (const key of [
    'stringValue',
    'numberValue',
    'booleanValue',
    'dateValue',
    'dateTimeValue',
  ]) {
    const v = unwrapSingle(obj[key]);
    if (v !== undefined && v !== null && v !== '') {
      return { value: String(v), kind: 'literal' };
    }
  }
  const ref = unwrapSingle(obj['elementReference']);
  if (ref !== undefined && ref !== null && ref !== '') {
    return { value: String(ref), kind: 'reference' };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Element-container keys
// ---------------------------------------------------------------------------

/**
 * Canvas-element containers whose BODY SEMANTICS this parser does NOT model (a
 * wait's timed-event logic, a collection processor's filter/sort/map, an
 * orchestrated stage's step choreography, a custom error's messages, …). Every
 * entry's `<name>` is surfaced in `unmodeled[]` so a consumer knows the body is
 * an honest gap, NEVER silently dropped.
 *
 * Their OUTGOING CONNECTORS, however, ARE captured (spec §4.2: "every element
 * type can carry outgoing connectors"), so the graph is not silently
 * disconnected at these nodes. Only losslessly-mappable edges are emitted: a
 * top-level `<connector>` → `'default'`, a `<faultConnector>` → `'fault'`, and —
 * for `<waits>` — each `<waitEvents><connector>` → `'default'` (connectivity
 * beats leaving a dangling node). Genuinely multi-branch bodies with no lossless
 * §4.2 kind (orchestratedStages stage/step branching, legacy `<steps><connectors>`)
 * contribute only their top-level default/fault edge; their inner branch edges
 * are intentionally left out. No typed detail array is fabricated for any of
 * these — connectivity is captured, the body stays unmodeled.
 */
const KNOWN_UNMODELED_ELEMENT_KEYS = [
  'waits',
  'steps',
  'apexPluginCalls',
  'collectionProcessors',
  'orchestratedStages',
  'customErrors',
  'recordRollbacks',
  'transforms',
] as const;

/**
 * Top-level `<Flow>` containers this projection DOES carry a datum for — the
 * typed detail arrays plus the identity-only element containers above plus the
 * scalars the tool layer's `meta` block and the projection root carry
 * (`description`, `label`, `status`, `processType`, `apiVersion`, `runInMode`,
 * and the legacy `startElementReference` the start reader consumes).
 *
 * Anything present in a flow's XML and NOT in this set becomes an
 * {@link UnprojectedContainer} row with its real occurrence count. Keeping the
 * accounted-for set explicit (rather than deriving it from "keys we happened to
 * read") is what makes `unprojected[]` a measurement instead of a guess: adding
 * a parser for a container without adding it here fails loudly in the tests.
 */
const ACCOUNTED_CONTAINER_KEYS: ReadonlySet<string> = new Set<string>([
  'start',
  'decisions',
  'assignments',
  'recordCreates',
  'recordUpdates',
  'recordLookups',
  'recordDeletes',
  'loops',
  'screens',
  'actionCalls',
  'subflows',
  'formulas',
  'variables',
  ...KNOWN_UNMODELED_ELEMENT_KEYS,
  'description',
  'label',
  'status',
  'processType',
  'apiVersion',
  'runInMode',
  'startElementReference',
]);

/**
 * Containers that are REFERENCABLE RESOURCES: an element names one of these by
 * name (a screen field's `choiceReferences`, an assignment's `elementReference`),
 * so leaving one unprojected leaves a dangling reference in the payload. Ranked
 * `resource` in {@link UnprojectedContainer} so a reader can tell a real
 * comprehension gap from flow-level trivia.
 */
const RESOURCE_CONTAINER_KEYS: ReadonlySet<string> = new Set<string>([
  'constants',
  'textTemplates',
  'choices',
  'dynamicChoiceSets',
  'stages',
]);

/**
 * Containers that are flow-level METADATA rather than canvas structure. Anything
 * present in a flow's XML that is neither accounted-for, nor a known resource,
 * nor listed here is reported as an unrecognised `element` container — the
 * loudest bucket, because it means a real canvas element type is invisible.
 */
const METADATA_CONTAINER_KEYS: ReadonlySet<string> = new Set<string>([
  'processMetadataValues',
  'environments',
  'interviewLabel',
  'triggerOrder',
  'sourceTemplate',
  'isAdditionalPermissionRequiredToRun',
  'isTemplate',
  'fullName',
  'migratedFromWorkflowRuleName',
  'timeZoneSidKey',
]);

/**
 * Count the occurrences of a top-level `<Flow>` child. fast-xml-parser emits an
 * object for a single occurrence and an array for many, so `Array.isArray` is
 * the only reliable multiplicity signal.
 */
const occurrenceCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : 1;

/**
 * Measure what this flow's XML declares that the projection does not carry.
 * Pure over the parsed root — no allowlist of "things we know we drop", just
 * `present keys − accounted keys`, so a container nobody thought about still
 * shows up.
 */
const buildUnprojected = (
  rootObj: Record<string, unknown>,
): UnprojectedContainer[] => {
  const out: UnprojectedContainer[] = [];
  for (const key of Object.keys(rootObj)) {
    if (ACCOUNTED_CONTAINER_KEYS.has(key)) continue;
    const value = rootObj[key];
    if (value === undefined || value === null || value === '') continue;
    const kind: UnprojectedContainer['kind'] = RESOURCE_CONTAINER_KEYS.has(key)
      ? 'resource'
      : METADATA_CONTAINER_KEYS.has(key)
        ? 'metadata'
        : 'element';
    out.push({ container: key, count: occurrenceCount(value), kind });
  }
  // Stable, reader-useful order: the buckets that cost comprehension first.
  const rank: Record<UnprojectedContainer['kind'], number> = {
    element: 0,
    resource: 1,
    metadata: 2,
  };
  return out.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.container.localeCompare(b.container),
  );
};

/**
 * Parse one `<inputParameters>` (or screen-field parameter) into an
 * {@link ActionParameter}. A parameter declared with no `<value>` at all is
 * `valueKind:'unset'` — distinct from a literal empty string. Returns `null`
 * when the parameter carries no `<name>`.
 */
const parseActionParameter = (
  raw: Record<string, unknown>,
): ActionParameter | null => {
  const name = toNonEmptyString(raw['name']);
  if (name === null) return null;
  const parsed = parseValue(raw['value']);
  if (parsed === null) return { name, value: null, valueKind: 'unset' };
  return { name, value: parsed.value, valueKind: parsed.kind };
};

/** Parse every `<inputParameters>` child into {@link ActionParameter}s. */
const parseActionParameters = (raw: unknown): ActionParameter[] => {
  const out: ActionParameter[] = [];
  for (const rec of toRecordArray(raw)) {
    const param = parseActionParameter(rec);
    if (param !== null) out.push(param);
  }
  return out;
};

/** Parse every `<outputParameters>` child into {@link ActionOutput}s. */
const parseActionOutputs = (raw: unknown): ActionOutput[] => {
  const out: ActionOutput[] = [];
  for (const rec of toRecordArray(raw)) {
    const name = toNonEmptyString(rec['name']);
    const assignToReference = toNonEmptyString(rec['assignToReference']);
    if (name === null || assignToReference === null) continue;
    out.push({ name, assignToReference });
  }
  return out;
};

/** Recursion guard for {@link parseScreenField} (deepest real nesting seen: 3). */
const MAX_SCREEN_FIELD_DEPTH = 8;

/**
 * Parse one `<screens><fields>` entry, recursing into a `Region` /
 * `RegionContainer`'s nested `<fields>`. `depth` guards against a pathological
 * (or hand-edited) nesting chain; real screens nest at most a container → region
 * → field, and the reference vault's deepest is 3.
 */
const parseScreenField = (
  raw: Record<string, unknown>,
  depth: number,
): ScreenField | null => {
  const name = toNonEmptyString(raw['name']);
  const fieldType = toNonEmptyString(raw['fieldType']);
  const objectFieldReference = toNonEmptyString(raw['objectFieldReference']);
  // Keep any field that declares SOMETHING identifying. Only a genuinely empty
  // `<fields/>` node is skipped — a nameless `ObjectProvided` field is real and
  // is identified by `objectFieldReference`.
  if (name === null && fieldType === null && objectFieldReference === null) {
    return null;
  }
  const visibility = asRecord(unwrapSingle(raw['visibilityRule']));
  const choiceReferences: string[] = [];
  for (const ref of toArray(raw['choiceReferences'])) {
    const s = toNonEmptyString(ref);
    if (s !== null) choiceReferences.push(s);
  }
  const nested: ScreenField[] = [];
  if (depth < MAX_SCREEN_FIELD_DEPTH) {
    for (const child of toRecordArray(raw['fields'])) {
      const parsed = parseScreenField(child, depth + 1);
      if (parsed !== null) nested.push(parsed);
    }
  }
  return {
    name,
    fieldType,
    dataType: toNonEmptyString(raw['dataType']),
    fieldText: toNullableString(raw['fieldText']),
    helpText: toNullableString(raw['helpText']),
    isRequired: toNullableBoolean(raw['isRequired']),
    extensionName: toNonEmptyString(raw['extensionName']),
    objectFieldReference,
    choiceReferences,
    inputParameters: parseActionParameters(raw['inputParameters']),
    visibilityLogic:
      visibility === null ? null : toNullableString(visibility['conditionLogic']),
    visibilityConditions:
      visibility === null ? [] : parseConditions(visibility['conditions']),
    fields: nested,
  };
};


// ---------------------------------------------------------------------------
// The projection builder
// ---------------------------------------------------------------------------

/**
 * Build the faithful {@link FlowGraphProjection} from a parsed `<Flow>` root.
 * PURE and defensive: a malformed element contributes what it can and never
 * throws (mirrors `flow.ts`'s per-element tolerance).
 *
 * `connectors[]` is assembled in one pass alongside the typed detail arrays,
 * so the per-element `connectsTo` conveniences and the authoritative graph
 * never disagree.
 */
export const parseFlowGraph = (
  rootObj: Record<string, unknown>,
): FlowGraphProjection => {
  const connectors: Connector[] = [];
  const elements: FlowElement[] = [];
  const decisions: Decision[] = [];
  const assignments: Assignment[] = [];
  const recordOps: RecordOp[] = [];
  const loops: Loop[] = [];
  const formulas: Formula[] = [];
  const variables: Variable[] = [];
  const subflows: Subflow[] = [];
  const actions: ActionCall[] = [];
  const screens: Screen[] = [];
  const unmodeled: string[] = [];

  const pushConnector = (
    from: string,
    parsed: ParsedConnector,
    kind: Connector['kind'],
    extra?: { ruleName?: string; scheduledPathName?: string },
  ): string => {
    connectors.push({
      from,
      to: parsed.target,
      kind,
      ...(extra?.ruleName !== undefined ? { ruleName: extra.ruleName } : {}),
      ...(extra?.scheduledPathName !== undefined
        ? { scheduledPathName: extra.scheduledPathName }
        : {}),
      ...(parsed.isGoTo ? { isGoTo: true } : {}),
    });
    return parsed.target;
  };

  /**
   * Push one element index row. `description` and `container` are spread in
   * ONLY when present, so an element with no author `<description>` serializes
   * byte-identically to before those fields existed.
   */
  const pushElement = (
    name: string,
    obj: Record<string, unknown>,
    type: FlowElement['type'],
    container?: string,
  ): void => {
    const el: FlowElement = {
      name,
      label: toNullableString(obj['label']),
      type,
    };
    const description = toNonEmptyString(obj['description']);
    const x = toNumber(obj['locationX']);
    const y = toNumber(obj['locationY']);
    elements.push({
      ...el,
      ...(description !== null ? { description } : {}),
      ...(container !== undefined ? { container } : {}),
      ...(x !== null ? { locationX: x } : {}),
      ...(y !== null ? { locationY: y } : {}),
    });
  };

  // --- <start> ---------------------------------------------------------------
  const startObj = asRecord(unwrapSingle(rootObj['start']));
  const triggerType = startObj ? toNonEmptyString(startObj['triggerType']) : null;
  const triggerObject = startObj ? toNonEmptyString(startObj['object']) : null;
  let startConnector: ConnectorTarget | null = null;
  const scheduledPaths: ScheduledPath[] = [];
  const startFilters: Condition[] = startObj
    ? parseConditions(startObj['filters'])
    : [];
  if (startObj !== null) {
    pushElement(START_SENTINEL, startObj, 'start');
    const direct = readConnector(startObj['connector']);
    if (direct !== null) {
      pushConnector(START_SENTINEL, direct, 'immediate');
      startConnector = {
        to: direct.target,
        ...(direct.isGoTo ? { isGoTo: true } : {}),
      };
    }
    for (const sp of toRecordArray(startObj['scheduledPaths'])) {
      const name = toNonEmptyString(sp['name']);
      const conn = readConnector(sp['connector']);
      scheduledPaths.push({
        name: name ?? '',
        label: toNullableString(sp['label']),
        offsetNumber: toNumber(sp['offsetNumber']),
        offsetUnit: toNonEmptyString(sp['offsetUnit']),
        timeSource: toNonEmptyString(sp['timeSource']),
        connectsTo: conn?.target ?? null,
      });
      if (conn !== null) {
        pushConnector(START_SENTINEL, conn, 'scheduled', {
          scheduledPathName: name ?? '',
        });
      }
    }
  }
  // Legacy shape: a top-level <startElementReference> names the first element
  // when <start> carries no direct <connector>. Emit it as the immediate edge.
  if (startConnector === null) {
    const legacyStart = toNonEmptyString(rootObj['startElementReference']);
    if (legacyStart !== null) {
      pushConnector(START_SENTINEL, { target: legacyStart, isGoTo: false }, 'immediate');
      startConnector = { to: legacyStart };
    }
  }
  const start: FlowStart = {
    triggerType,
    recordTriggerType: startObj
      ? toNonEmptyString(startObj['recordTriggerType'])
      : null,
    object: triggerObject,
    doesRequireRecordChangedToMeetCriteria: startObj
      ? toNullableBoolean(startObj['doesRequireRecordChangedToMeetCriteria'])
      : null,
    filterLogic: startObj ? toNullableString(startObj['filterLogic']) : null,
    filters: startFilters,
    // The formula-shaped entry gate (mirrors flow.ts's ConditionalContext read).
    // Kept even when `filters` is empty so entry consumers never mistake a
    // formula gate for "no criteria".
    filterFormula: startObj ? toNullableString(startObj['filterFormula']) : null,
    scheduledPaths,
    connector: startConnector,
  };

  // --- <decisions> -----------------------------------------------------------
  for (const dec of toRecordArray(rootObj['decisions'])) {
    const name = toNonEmptyString(dec['name']);
    if (name === null) continue;
    pushElement(name, dec, 'decision');
    const defaultConn = readConnector(dec['defaultConnector']);
    if (defaultConn !== null) pushConnector(name, defaultConn, 'default');
    const rules: Decision['rules'] = toRecordArray(dec['rules']).map((rule) => {
      const ruleName = toNonEmptyString(rule['name']) ?? '';
      const ruleConn = readConnector(rule['connector']);
      let connectsTo: string | null = null;
      if (ruleConn !== null) {
        connectsTo = pushConnector(name, ruleConn, 'rule', { ruleName });
      }
      return {
        name: ruleName,
        label: toNullableString(rule['label']),
        conditionLogic: toNullableString(rule['conditionLogic']),
        conditions: parseConditions(rule['conditions']),
        connectsTo,
      };
    });
    decisions.push({
      name,
      label: toNullableString(dec['label']),
      defaultConnectorLabel: toNullableString(dec['defaultConnectorLabel']),
      rules,
    });
  }

  // --- <assignments> ---------------------------------------------------------
  for (const asn of toRecordArray(rootObj['assignments'])) {
    const name = toNonEmptyString(asn['name']);
    if (name === null) continue;
    pushElement(name, asn, 'assignment');
    const conn = readConnector(asn['connector']);
    const items: Assignment['items'] = toRecordArray(asn['assignmentItems'])
      .map((item) => {
        const assignToReference = toNonEmptyString(item['assignToReference']);
        if (assignToReference === null) return null;
        const parsed = parseValue(item['value']);
        return {
          assignToReference,
          operator: toNonEmptyString(item['operator']) ?? 'Assign',
          value: parsed?.value ?? null,
          valueKind: (parsed?.kind ?? 'literal') as 'literal' | 'reference',
        };
      })
      .filter((x): x is Assignment['items'][number] => x !== null);
    assignments.push({
      name,
      items,
      connectsTo: conn?.target ?? null,
    });
    if (conn !== null) pushConnector(name, conn, 'default');
  }

  // --- record DML (<recordCreates|Updates|Lookups|Deletes>) ------------------
  // The dataflow index resolves whole-record <inputReference> DML to its
  // SObject, so `objectResolution` mirrors the shipped `flow.ts` resolution.
  const dataflowIndex = buildFlowDataflowIndex(rootObj, triggerObject);
  const recordDml: {
    readonly key: string;
    readonly kind: RecordOp['kind'];
  }[] = [
    { key: 'recordCreates', kind: 'create' },
    { key: 'recordUpdates', kind: 'update' },
    { key: 'recordLookups', kind: 'lookup' },
    { key: 'recordDeletes', kind: 'delete' },
  ];
  const elementTypeForDml: Record<RecordOp['kind'], FlowElement['type']> = {
    create: 'recordCreate',
    update: 'recordUpdate',
    lookup: 'recordLookup',
    delete: 'recordDelete',
  };
  for (const { key, kind } of recordDml) {
    for (const op of toRecordArray(rootObj[key])) {
      const name = toNonEmptyString(op['name']);
      if (name === null) continue;
      pushElement(name, op, elementTypeForDml[kind]);

      let object = toNonEmptyString(op['object']);
      let objectResolution: RecordOp['objectResolution'];
      if (object !== null) {
        objectResolution = 'object';
      } else {
        const resolved = resolveInputReferenceObject(op, rootObj, dataflowIndex);
        if (resolved === null) {
          objectResolution = 'unresolved';
        } else if (resolved.kind === 'triggerRecord') {
          object = resolved.object;
          objectResolution = 'triggerRecord';
        } else {
          object = resolved.object;
          objectResolution = 'inputReference';
        }
      }

      const inputAssignments: RecordOp['inputAssignments'] = toRecordArray(
        op['inputAssignments'],
      )
        .map((ia) => {
          const field = toNonEmptyString(ia['field']);
          if (field === null) return null;
          const parsed = parseValue(ia['value']);
          return {
            field,
            value: parsed?.value ?? null,
            valueKind: (parsed?.kind ?? 'literal') as 'literal' | 'reference',
          };
        })
        .filter((x): x is RecordOp['inputAssignments'][number] => x !== null);

      const conn = readConnector(op['connector']);
      const faultConn = readConnector(op['faultConnector']);
      recordOps.push({
        name,
        kind,
        object,
        objectResolution,
        filters: parseConditions(op['filters']),
        filterLogic: toNullableString(op['filterLogic']),
        inputAssignments,
        connectsTo: conn?.target ?? null,
        faultConnectsTo: faultConn?.target ?? null,
      });
      if (conn !== null) pushConnector(name, conn, 'default');
      if (faultConn !== null) pushConnector(name, faultConn, 'fault');
    }
  }

  // --- <loops> ---------------------------------------------------------------
  for (const loop of toRecordArray(rootObj['loops'])) {
    const name = toNonEmptyString(loop['name']);
    if (name === null) continue;
    pushElement(name, loop, 'loop');
    const nextConn = readConnector(loop['nextValueConnector']);
    const noMoreConn = readConnector(loop['noMoreValuesConnector']);
    loops.push({
      name,
      collectionReference: toNonEmptyString(loop['collectionReference']) ?? '',
      iterationOrder: toNonEmptyString(loop['iterationOrder']),
      nextValueConnectsTo: nextConn?.target ?? null,
      noMoreValuesConnectsTo: noMoreConn?.target ?? null,
    });
    if (nextConn !== null) pushConnector(name, nextConn, 'nextValue');
    if (noMoreConn !== null) pushConnector(name, noMoreConn, 'noMoreValues');
  }

  // --- <screens> (element + connector + the FIELDS the screen shows) --------
  // A screen's fields are what downstream decisions and assignments reference,
  // so projecting a screen as name + label alone left those references dangling.
  for (const screen of toRecordArray(rootObj['screens'])) {
    const name = toNonEmptyString(screen['name']);
    if (name === null) continue;
    pushElement(name, screen, 'screen');
    const conn = readConnector(screen['connector']);
    const fields: ScreenField[] = [];
    for (const raw of toRecordArray(screen['fields'])) {
      const field = parseScreenField(raw, 0);
      if (field !== null) fields.push(field);
    }
    screens.push({
      name,
      label: toNullableString(screen['label']),
      allowBack: toNullableBoolean(screen['allowBack']),
      allowFinish: toNullableBoolean(screen['allowFinish']),
      allowPause: toNullableBoolean(screen['allowPause']),
      nextOrFinishButtonLabel: toNullableString(screen['nextOrFinishButtonLabel']),
      fields,
      connectsTo: conn?.target ?? null,
    });
    if (conn !== null) pushConnector(name, conn, 'default');
  }

  // --- <actionCalls> ---------------------------------------------------------
  for (const call of toRecordArray(rootObj['actionCalls'])) {
    const name = toNonEmptyString(call['name']);
    if (name === null) continue;
    pushElement(name, call, 'action');
    const conn = readConnector(call['connector']);
    const faultConn = readConnector(call['faultConnector']);
    actions.push({
      name,
      actionType: toNonEmptyString(call['actionType']),
      actionName: toNonEmptyString(call['actionName']),
      inputParameters: parseActionParameters(call['inputParameters']),
      outputParameters: parseActionOutputs(call['outputParameters']),
      connectsTo: conn?.target ?? null,
      faultConnectsTo: faultConn?.target ?? null,
    });
    if (conn !== null) pushConnector(name, conn, 'default');
    if (faultConn !== null) pushConnector(name, faultConn, 'fault');
  }

  // --- <subflows> ------------------------------------------------------------
  for (const sub of toRecordArray(rootObj['subflows'])) {
    const name = toNonEmptyString(sub['name']);
    if (name === null) continue;
    pushElement(name, sub, 'subflow');
    const flowName = toNonEmptyString(sub['flowName']);
    const conn = readConnector(sub['connector']);
    const faultConn = readConnector(sub['faultConnector']);
    subflows.push({
      name,
      targetFlowId: flowName === null ? '' : `${ROOT_ELEMENT}:${flowName}`,
      resolved: false,
      connectsTo: conn?.target ?? null,
      faultConnectsTo: faultConn?.target ?? null,
    });
    if (conn !== null) pushConnector(name, conn, 'default');
    if (faultConn !== null) pushConnector(name, faultConn, 'fault');
  }

  // --- <formulas> (resources — no canvas element / connector) ----------------
  for (const f of toRecordArray(rootObj['formulas'])) {
    const name = toNonEmptyString(f['name']);
    if (name === null) continue;
    const description = toNonEmptyString(f['description']);
    formulas.push({
      name,
      dataType: toNonEmptyString(f['dataType']),
      expression: toNullableString(f['expression']) ?? '',
      ...(description !== null ? { description } : {}),
    });
  }

  // --- <variables> (resources) -----------------------------------------------
  for (const v of toRecordArray(rootObj['variables'])) {
    const name = toNonEmptyString(v['name']);
    if (name === null) continue;
    const description = toNonEmptyString(v['description']);
    variables.push({
      name,
      dataType: toNonEmptyString(v['dataType']),
      objectType: toNonEmptyString(v['objectType']),
      isCollection: toBoolean(v['isCollection']),
      isInput: toBoolean(v['isInput']),
      isOutput: toBoolean(v['isOutput']),
      ...(description !== null ? { description } : {}),
    });
  }

  // --- unmodeled canvas-element types: body unmodeled, edges captured --------
  // The BODY semantics of these element types remain an honest gap (their
  // `<name>` stays in `unmodeled[]`), but their OUTGOING CONNECTORS are now
  // extracted so the graph is not silently disconnected at these nodes (spec
  // §4.2). Only losslessly-mappable edges are emitted: a top-level `<connector>`
  // or `<defaultConnector>` → 'default', a `<faultConnector>` → 'fault', and —
  // for `<waits>` — each
  // `<waitEvents><connector>` → 'default'. `<isGoTo>` is preserved by
  // `readConnector`. Inner multi-branch edges (orchestratedStages stage/step
  // branching, legacy `<steps><connectors>`) have no lossless §4.2 kind and are
  // intentionally left out. No typed detail array is fabricated for these.
  for (const key of KNOWN_UNMODELED_ELEMENT_KEYS) {
    for (const el of toRecordArray(rootObj[key])) {
      const name = toNonEmptyString(el['name']);
      if (name === null) continue;
      unmodeled.push(name);
      // Identity row: before this, an unmodeled element was a connector TARGET
      // with no row in `elements[]` — so the element index was not a complete
      // index of connector endpoints and a walk over it dangled. Its `<name>`,
      // `<label>` and the author's `<description>` are real facts; only the
      // BODY stays the gap `unmodeled[]` records.
      pushElement(name, el, 'unmodeled', key);
      const conn = readConnector(el['connector']);
      if (conn !== null) pushConnector(name, conn, 'default');
      // Waits (and orchestration stages) carry their default-resume path on
      // `<defaultConnector>` (not `<connector>`) — same lossless 'default' kind.
      const defaultConn = readConnector(el['defaultConnector']);
      if (defaultConn !== null) pushConnector(name, defaultConn, 'default');
      const faultConn = readConnector(el['faultConnector']);
      if (faultConn !== null) pushConnector(name, faultConn, 'fault');
      if (key === 'waits') {
        for (const we of toRecordArray(el['waitEvents'])) {
          const weConn = readConnector(we['connector']);
          if (weConn !== null) pushConnector(name, weConn, 'default');
        }
      }
    }
  }

  return {
    description: toNonEmptyString(rootObj['description']),
    start,
    elements,
    connectors,
    decisions,
    assignments,
    recordOps,
    loops,
    screens,
    formulas,
    variables,
    subflows,
    actions,
    unmodeled,
    unprojected: buildUnprojected(rootObj),
  };
};

/**
 * Validate + parse + project a Flow-XML STRING into a {@link FlowGraphProjection}
 * (the on-demand entry point the `sfi.flow_graph` tool calls with source read
 * from the vault). Mirrors `flow.ts`'s `readAndValidateXml` discipline: XML is
 * strictly validated first (fast-xml-parser's `parse()` silently truncates on
 * mismatched tags), then parsed with the shared {@link FLOW_XML_PARSER_OPTIONS},
 * then the `<Flow>` root is confirmed present before projection. Returns a
 * `parse-error` on malformed XML and `malformed-input` when the root is not a
 * `<Flow>` element. `path` is a synthetic label since the input is a string.
 */
export const parseFlowGraphSource = (
  xml: string,
): Result<FlowGraphProjection, ExtractorError> => {
  const path = '<inline-flow-xml>';
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  const parser = new XMLParser(FLOW_XML_PARSER_OPTIONS);
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
  const root = asRecord(unwrapSingle(parsed[ROOT_ELEMENT]));
  if (root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  return ok(parseFlowGraph(root));
};
