/**
 * First-turn entity → tool-arg binding for route_question (ROUTE-01 / FR-04 /
 * DEV-02 / ADM-9 / WOW-7).
 *
 * route_question resolved the named component (`entityEvidence.disposition:
 * 'exact'`) and then handed the host every recommended call with EMPTY args,
 * so most first calls failed `invalid-query`. This module binds a resolved
 * winner into a target tool's args using the keys that tool ACTUALLY declares
 * — read from its registered input schema (roster `inputSchema.properties`),
 * never from a per-intent hand list:
 *
 *   - a typed key (`fieldId`, `flowId`, `triggerId`, `classApiName`,
 *     `objectApiName`) is used when the winner is that type;
 *   - a generic node key (`componentId`, `targetId`, `nodeId`, `rootId`) is used
 *     ONLY when the tool declares no typed key of a different family (a
 *     `componentId` on a tool that also declares `fieldId` is a FIELD alias);
 *   - a field winner on an object-only tool binds the PARENT object;
 *   - when no key fits, nothing is bound (unsure ⇒ unbound, and the caller
 *     says so) — never a guessed key, never a guessed value.
 */
import { V01_TOOLS } from './roster.js';

/** The resolved component to bind (a resolver winner). */
export interface BindableEntity {
  readonly id: string;
  readonly type: string;
  readonly apiName: string;
  readonly parentApiName: string | null;
}

interface ToolArgShape {
  readonly properties: ReadonlySet<string>;
  readonly required: readonly string[];
  readonly arrayKeys: ReadonlySet<string>;
  /** String-enum args and their allowed values (from the registered schema). */
  readonly enums: ReadonlyMap<string, readonly string[]>;
}

let shapeCache: ReadonlyMap<string, ToolArgShape> | null = null;

/** Declared arg keys per tool, derived once from the registered roster schemas. */
export const toolArgShape = (tool: string): ToolArgShape | undefined => {
  if (shapeCache === null) {
    const m = new Map<string, ToolArgShape>();
    for (const t of V01_TOOLS) {
      const schema = t.inputSchema as {
        readonly properties?: Readonly<Record<string, { readonly type?: unknown; readonly enum?: unknown }>>;
        readonly required?: readonly string[];
      };
      const props = schema.properties ?? {};
      m.set(t.name, {
        properties: new Set(Object.keys(props)),
        required: schema.required ?? [],
        arrayKeys: new Set(
          Object.entries(props)
            .filter(([, v]) => v?.type === 'array')
            .map(([k]) => k),
        ),
        enums: new Map(
          Object.entries(props)
            .filter(([, v]) => Array.isArray(v?.enum) && (v.enum as unknown[]).every((e) => typeof e === 'string'))
            .map(([k, v]) => [k, v.enum as string[]]),
        ),
      });
    }
    shapeCache = m;
  }
  return shapeCache.get(tool);
};

const GENERIC_NODE_KEYS = ['componentId', 'targetId', 'nodeId', 'rootId'] as const;

/** Typed keys by winner family; value form: canonical id or bare api name. */
const TYPED_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly types: ReadonlySet<string>;
  readonly value: 'id' | 'apiName' | 'parent';
}> = [
  { key: 'fieldId', types: new Set(['CustomField']), value: 'id' },
  { key: 'flowId', types: new Set(['Flow']), value: 'id' },
  { key: 'triggerId', types: new Set(['ApexTrigger']), value: 'id' },
  { key: 'classApiName', types: new Set(['ApexClass']), value: 'apiName' },
  { key: 'classRef', types: new Set(['ApexClass', 'ApexTrigger']), value: 'apiName' },
  { key: 'objectApiName', types: new Set(['CustomObject']), value: 'apiName' },
  { key: 'object', types: new Set(['CustomObject']), value: 'apiName' },
  { key: 'integrationProcedureId', types: new Set(['OmniIntegrationProcedure']), value: 'id' },
];

/** Tools whose args describe TWO components or a filter, never one entity. */
const NEVER_BIND = /^sfi\.(compare_|field_mapping_between_objects$|list_components$|search_components$|resolve$|capabilities$)/;

/**
 * A tool whose NAME names a component family (`app_access`, `omni_save_trace`,
 * `explain_flow`) takes THAT family in its generic `componentId`. Derived from
 * the tool name's own words, so a Flow is never bound into an app tool's or an
 * object into an OmniStudio tool's generic id slot.
 */
const NAME_FAMILY: ReadonlyArray<readonly [RegExp, (type: string) => boolean]> = [
  [/^apps?$/, (t) => t === 'CustomApplication'],
  [/^flows?$/, (t) => t === 'Flow'],
  [/^fields?$/, (t) => t === 'CustomField'],
  [/^objects?$/, (t) => t === 'CustomObject'],
  [/^triggers?$/, (t) => t === 'ApexTrigger'],
  [/^(?:apex|class|classes|method)$/, (t) => t === 'ApexClass' || t === 'ApexTrigger'],
  [/^omni\w*$|^omniscript$|^datatransform$/, (t) => t.startsWith('Omni')],
  [/^profiles?$/, (t) => t === 'Profile'],
  [/^(?:permset|permission)$/, (t) => t === 'PermissionSet' || t === 'Profile'],
  [/^layouts?$/, (t) => t === 'Layout'],
  [/^reports?$/, (t) => t === 'Report'],
  [/^dashboards?$/, (t) => t === 'Dashboard'],
  [/^labels?$/, (t) => t === 'CustomLabel'],
];

const nameAdmitsType = (tool: string, type: string): boolean => {
  const words = tool.replace(/^sfi\./, '').split('_');
  const families = NAME_FAMILY.filter(([re]) => words.some((w) => re.test(w)));
  return families.length === 0 || families.some(([, ok]) => ok(type));
};

const objectApiNameOf = (e: BindableEntity): string | null =>
  e.type === 'CustomObject'
    ? e.apiName
    : e.type === 'CustomField' && e.parentApiName !== null
      ? e.parentApiName
      : null;

/**
 * Args to bind `entity` into `tool`, or `null` when no declared key fits.
 * Pure. `methodName` (from a `Class.method` reference) is bound to a declared
 * `methodName`/`method` key only alongside a class binding.
 */
export const bindEntityArgs = (
  tool: string,
  entity: BindableEntity,
  methodName?: string,
): Readonly<Record<string, unknown>> | null => {
  if (NEVER_BIND.test(tool)) return null;
  const shape = toolArgShape(tool);
  if (shape === undefined) return null;
  const has = (k: string): boolean => shape.properties.has(k);
  const wrap = (k: string, v: string): unknown => (shape.arrayKeys.has(k) ? [v] : v);
  const out: Record<string, unknown> = {};

  const typed = TYPED_KEYS.find((t) => has(t.key) && t.types.has(entity.type));
  if (typed !== undefined) {
    out[typed.key] = wrap(typed.key, typed.value === 'id' ? entity.id : entity.apiName);
  } else {
    // A declared typed key of ANOTHER family means this tool's generic
    // `componentId` is that family's alias — binding a different type there is
    // a guaranteed hard error, so leave it unbound.
    const foreignTyped = TYPED_KEYS.some((t) => has(t.key) && !t.types.has(entity.type));
    const generic = GENERIC_NODE_KEYS.find((k) => has(k));
    const objectName = objectApiNameOf(entity);
    if (generic !== undefined && !foreignTyped && nameAdmitsType(tool, entity.type)) {
      out[generic] = wrap(generic, entity.id);
    } else if (has('changedComponents') && !foreignTyped && nameAdmitsType(tool, entity.type)) {
      out['changedComponents'] = [entity.id];
    } else if (entity.type === 'CustomField' && objectName !== null && has('objectApiName') && !has('fieldId')) {
      // A field named on an object-scoped tool (save order, layouts): the
      // question is about the field's OBJECT.
      out['objectApiName'] = objectName;
    } else {
      return null;
    }
  }
  if (methodName !== undefined && methodName.length > 0) {
    if (has('methodName')) out['methodName'] = methodName;
    else if (has('method')) out['method'] = methodName;
  }
  return out;
};

/**
 * Registered tools that declare any of `keys` as an input arg, in roster order
 * (e.g. every tool that takes a method name). Derived from the schemas, so a new
 * method tool joins without a hand list.
 */
export const toolsDeclaringArg = (keys: readonly string[]): readonly string[] =>
  V01_TOOLS.map((t) => t.name).filter((name) => {
    const shape = toolArgShape(name);
    return shape !== undefined && keys.some((k) => shape.properties.has(k));
  });

/** Required args of `tool` still missing from `args` (empty = executable as far as keys go). */
export const missingRequiredArgs = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const shape = toolArgShape(tool);
  if (shape === undefined) return [];
  return shape.required.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
};

/**
 * A quoted literal in prose: the opening quote starts a word, the closing quote
 * ends one, so an apostrophe ("what's", "Contact's") never opens a literal.
 * A literal followed by a type noun ("the 'Status' field") names a COMPONENT,
 * not a value, and is skipped.
 */
const QUOTED_LITERAL =
  /(?:^|[\s(:])['"\u2018\u201C]([^'"\u2019\u201D]{1,80}?)['"\u2019\u201D](?=$|[\s.,;:?!)])(?!\s+(?:field|object|profile|permission\s+set|flow|record\s+type|picklist|checkbox|class|trigger|label)\b)/gi;

/** "LongTextArea" -> /long\s*text\s*area/ — how a person types an enum value. */
const enumValuePattern = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_-]*');

/**
 * ROUTE-06: bind the literals a question states for a tool's REQUIRED value
 * args, derived from the tool's registered schema (no per-tool list):
 *   - a REQUIRED `value` arg (never on an annotation write tool) takes the ONE
 *     quoted literal in the question
 *     ("remove 'Former Member' from the Status picklist");
 *   - a required string-enum arg takes the ONE enum value stated after "to"
 *     ("from currency to number" -> newType: 'Number').
 * Zero or several candidates leave the arg unbound (unsure ⇒ unbound). Args the
 * caller already set are never overwritten.
 */
export const bindQuestionLiterals = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  question: string,
): Readonly<Record<string, unknown>> => {
  if (NEVER_BIND.test(tool)) return args;
  const shape = toolArgShape(tool);
  if (shape === undefined) return args;
  const out: Record<string, unknown> = { ...args };
  // Only a REQUIRED `value` (an optional one is a filter a stray quote must not
  // set) and never on a write-side annotation tool (it would pre-fill a record).
  if (
    shape.required.includes('value') &&
    !/annotation/.test(tool) &&
    out['value'] === undefined &&
    !shape.enums.has('value')
  ) {
    const literals = [...new Set([...question.matchAll(QUOTED_LITERAL)].map((m) => (m[1] ?? '').trim()))]
      .filter((v) => v.length > 0);
    if (literals.length === 1) out['value'] = literals[0];
  }
  for (const [key, values] of shape.enums) {
    if (out[key] !== undefined || !shape.required.includes(key)) continue;
    const hits = values.filter((v) =>
      new RegExp(`\\bto\\s+(?:an?\\s+)?${enumValuePattern(v)}\\b`, 'i').test(question),
    );
    if (hits.length === 1) out[key] = hits[0];
  }
  return out;
};
