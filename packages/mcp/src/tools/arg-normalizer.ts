/**
 * Dispatch-level argument normalizer (CH-1 / DEV-12 / ADM-10).
 *
 * Every tool's Zod schema is a plain `z.object` that STRIPS unknown keys, so a
 * host that guessed a sibling tool's arg name (`object` for `objectApiName`,
 * `componentId` for `nodeId`, `permissionSetId` for `permissionSetIds`) got an
 * UNSCOPED, org-wide answer with no warning. Per-tool alias merges fixed this
 * in a handful of tools; this module fixes it ONCE, at dispatch, for all of
 * them:
 *
 *   1. An argument the schema does not declare AND that does not change the
 *      parsed input (i.e. the tool would silently drop it) is a candidate.
 *   2. When the candidate belongs to an alias FAMILY and exactly one member of
 *      that family is declared by the tool (and not already supplied), it is
 *      renamed to that member — the name an LLM naturally guesses maps to the
 *      tool's real arg when that mapping is unambiguous.
 *   3. Anything still dropped is REPORTED (never silently stripped): runTool
 *      stamps it on the response, or names it in the invalid-query message.
 *
 * The "does it change the parsed input" test is semantic, not a key list, so
 * a tool whose own `z.preprocess` already consumes an alias is left alone.
 */
import type { z } from 'zod';

/** Families of interchangeable selector names. `members` may be renamed TO; `sourceOnly` only FROM. */
interface AliasFamily {
  readonly name: string;
  readonly members: readonly string[];
  readonly sourceOnly: readonly string[];
  /** Canonical-id prefix for this family's values (bridges to/from a generic node id). */
  readonly idPrefix?: string;
}

const FAMILIES: readonly AliasFamily[] = [
  {
    name: 'node',
    members: ['componentId', 'nodeId', 'targetId', 'rootId'],
    sourceOnly: ['id', 'component', 'componentName'],
  },
  {
    name: 'object',
    members: ['objectApiName', 'object', 'objectName', 'objectId'],
    sourceOnly: ['sobject', 'sObject', 'sobjectType', 'sObjectType', 'objectType'],
    idPrefix: 'CustomObject:',
  },
  {
    name: 'field',
    members: ['fieldId', 'field', 'fieldApiName', 'fieldName'],
    sourceOnly: [],
    idPrefix: 'CustomField:',
  },
  {
    name: 'class',
    members: ['classApiName', 'className', 'classId', 'classRef'],
    sourceOnly: ['apexClass', 'class'],
    idPrefix: 'ApexClass:',
  },
  {
    name: 'flow',
    members: ['flowId', 'flowApiName', 'flowName'],
    sourceOnly: ['flow'],
    idPrefix: 'Flow:',
  },
  {
    name: 'trigger',
    members: ['triggerId', 'triggerName', 'triggerApiName'],
    sourceOnly: ['trigger'],
    idPrefix: 'ApexTrigger:',
  },
  {
    name: 'permset',
    members: ['permissionSetIds', 'permissionSetId', 'permissionSets'],
    sourceOnly: ['permissionSet', 'permSet', 'permSetId'],
    idPrefix: 'PermissionSet:',
  },
  {
    name: 'profile',
    members: ['profileId', 'profileApiName', 'profileName'],
    sourceOnly: ['profile'],
    idPrefix: 'Profile:',
  },
  { name: 'method', members: ['methodName'], sourceOnly: ['method'] },
  {
    name: 'query',
    members: ['query', 'q'],
    sourceOnly: ['search', 'searchTerm', 'keyword', 'text'],
  },
];

const familyOf = (key: string): AliasFamily | undefined =>
  FAMILIES.find((f) => f.members.includes(key) || f.sourceOnly.includes(key));

const familyByPrefix = (value: unknown): AliasFamily | undefined => {
  if (typeof value !== 'string') return undefined;
  return FAMILIES.find(
    (f) => f.idPrefix !== undefined && value.startsWith(f.idPrefix),
  );
};

type AnyDef = { readonly typeName?: string } & Record<string, unknown>;
const defOf = (schema: unknown): AnyDef | undefined =>
  (schema as { readonly _def?: AnyDef } | undefined)?._def;

/**
 * The declared field map of a tool's input schema, looking through the
 * wrappers tool schemas actually use (preprocess/refine effects, optional,
 * default, pipeline, intersection, union). `undefined` when the shape cannot
 * be determined — callers must then do nothing (never guess).
 */
export const schemaShape = (
  schema: z.ZodTypeAny,
): Readonly<Record<string, z.ZodTypeAny>> | undefined => {
  const walk = (s: unknown, depth: number): Record<string, z.ZodTypeAny> | undefined => {
    if (depth > 8) return undefined;
    const def = defOf(s);
    if (def === undefined) return undefined;
    switch (def.typeName) {
      case 'ZodObject': {
        const shape = (s as { readonly shape?: unknown }).shape;
        return shape !== null && typeof shape === 'object'
          ? { ...(shape as Record<string, z.ZodTypeAny>) }
          : undefined;
      }
      case 'ZodEffects':
        return walk(def['schema'], depth + 1);
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodReadonly':
      case 'ZodBranded':
        return walk(def['innerType'] ?? def['type'], depth + 1);
      case 'ZodPipeline':
        return walk(def['in'], depth + 1);
      case 'ZodLazy':
        return undefined;
      case 'ZodIntersection': {
        const l = walk(def['left'], depth + 1);
        const r = walk(def['right'], depth + 1);
        return l !== undefined && r !== undefined ? { ...l, ...r } : undefined;
      }
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion': {
        const opts = def['options'];
        const list = Array.isArray(opts)
          ? opts
          : opts instanceof Map
            ? [...(opts as Map<unknown, unknown>).values()]
            : [];
        let acc: Record<string, z.ZodTypeAny> | undefined = {};
        for (const o of list) {
          const sh = walk(o, depth + 1);
          if (sh === undefined) return undefined;
          acc = { ...sh, ...acc };
        }
        return acc;
      }
      default:
        return undefined;
    }
  };
  return walk(schema, 0);
};

const innerTypeName = (field: z.ZodTypeAny | undefined): string | undefined => {
  let s: unknown = field;
  for (let i = 0; i < 8 && s !== undefined; i += 1) {
    const def = defOf(s);
    if (def === undefined) return undefined;
    if (
      def.typeName === 'ZodOptional' ||
      def.typeName === 'ZodNullable' ||
      def.typeName === 'ZodDefault'
    ) {
      s = def['innerType'];
      continue;
    }
    if (def.typeName === 'ZodEffects') {
      s = def['schema'];
      continue;
    }
    return def.typeName;
  }
  return undefined;
};

/** Whether a declared field is optional (accepts `undefined`). */
export const isOptionalField = (field: z.ZodTypeAny): boolean => {
  try {
    return field.safeParse(undefined).success;
  } catch {
    return true;
  }
};

const isAbsent = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** Transform a value for the target key (prefix add/strip, scalar → array). */
const adaptValue = (
  value: unknown,
  fromFamily: AliasFamily | undefined,
  target: string,
  targetFamily: AliasFamily,
  targetField: z.ZodTypeAny | undefined,
): unknown => {
  let v = value;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (targetFamily.name === 'node' && fromFamily?.idPrefix && !trimmed.includes(':')) {
      v = `${fromFamily.idPrefix}${trimmed}`;
    } else if (
      targetFamily.idPrefix !== undefined &&
      /Ids?$/.test(target) &&
      trimmed.length > 0 &&
      !trimmed.includes(':')
    ) {
      // A bare name renamed onto a typed canonical-id arg (`fieldApiName:
      // 'Contact.Birthdate'` → `fieldId: 'CustomField:Contact.Birthdate'`).
      v = `${targetFamily.idPrefix}${trimmed}`;
    } else if (
      targetFamily.name === 'object' &&
      target !== 'objectId' &&
      trimmed.startsWith('CustomObject:')
    ) {
      v = trimmed.slice('CustomObject:'.length);
    }
  }
  if (innerTypeName(targetField) === 'ZodArray' && !Array.isArray(v) && v !== undefined) {
    return [v];
  }
  return v;
};

/** Pick the ONE declared member a dropped key should be renamed to, or undefined. */
const renameTarget = (
  key: string,
  value: unknown,
  shape: Readonly<Record<string, z.ZodTypeAny>>,
  args: Readonly<Record<string, unknown>>,
): { readonly target: string; readonly value: unknown } | undefined => {
  const from = familyOf(key);
  const declaredFree = (fam: AliasFamily): string[] =>
    fam.members.filter((m) => m in shape && isAbsent(args[m]));
  const declaredAny = (fam: AliasFamily): string[] => fam.members.filter((m) => m in shape);

  // 1. Same family: exactly one declared member.
  if (from !== undefined && declaredAny(from).length > 0) {
    // The family's canonical member when declared, else the single declared one.
    const canonical = from.members[0] as string;
    const any = declaredAny(from);
    const pick = any.includes(canonical) ? canonical : any.length === 1 ? any[0] : undefined;
    if (pick === undefined || !isAbsent(args[pick])) return undefined;
    const target = pick;
    return { target, value: adaptValue(value, from, target, from, shape[target]) };
  }
  // 2. Generic node id carrying a typed prefix → that type's family.
  if (from?.name === 'node' || from === undefined) {
    const typed = familyByPrefix(value);
    if (typed !== undefined && from !== undefined) {
      const any = declaredAny(typed);
      const free = declaredFree(typed);
      if (any.length === 1 && free.length === 1) {
        const target = free[0] as string;
        return { target, value: adaptValue(value, from, target, typed, shape[target]) };
      }
    }
    return undefined;
  }
  // 3. Typed name (object/field/class/...) → the tool's generic node id.
  if (from.idPrefix !== undefined) {
    const node = FAMILIES[0] as AliasFamily;
    const any = declaredAny(node);
    const free = declaredFree(node);
    if (any.length === 1 && free.length === 1) {
      const target = free[0] as string;
      return { target, value: adaptValue(value, from, target, node, shape[target]) };
    }
  }
  return undefined;
};

/** Stable fingerprint of a parse outcome, ignoring unrecognized-key issues. */
const outcomeOf = (schema: z.ZodTypeAny, args: unknown): string => {
  const r = schema.safeParse(args);
  if (r.success) {
    try {
      return `ok:${JSON.stringify(r.data)}`;
    } catch {
      return 'ok:?';
    }
  }
  const issues = r.error.issues
    .filter((i) => i.code !== 'unrecognized_keys')
    .map((i) => `${i.path.join('.')}|${i.code}|${i.message}`)
    .sort();
  return `err:${issues.join(';')}`;
};

export interface NormalizedToolArgs {
  readonly args: Readonly<Record<string, unknown>>;
  /** Keys renamed to the tool's declared arg (`from` → `to`). */
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  /** Keys the tool does not declare and would have silently dropped. */
  readonly ignored: readonly string[];
}

/**
 * Normalize a tool call's args against its schema. Pure; never throws.
 * Returns the input unchanged when the schema's shape is undeterminable.
 */
export const normalizeToolArgs = (
  schema: z.ZodTypeAny,
  rawArgs: Readonly<Record<string, unknown>>,
): NormalizedToolArgs => {
  const none: NormalizedToolArgs = { args: rawArgs, renamed: [], ignored: [] };
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return none;
  let shape: Readonly<Record<string, z.ZodTypeAny>> | undefined;
  try {
    shape = schemaShape(schema);
  } catch {
    return none;
  }
  if (shape === undefined) return none;
  const unknownKeys = Object.keys(rawArgs).filter((k) => !(k in shape));
  if (unknownKeys.length === 0) return none;

  const base = outcomeOf(schema, rawArgs);
  const dropped = unknownKeys.filter((k) => {
    const rest: Record<string, unknown> = { ...rawArgs };
    delete rest[k];
    return outcomeOf(schema, rest) === base;
  });
  if (dropped.length === 0) return none;

  const next: Record<string, unknown> = { ...rawArgs };
  const renamed: { from: string; to: string }[] = [];
  for (const k of dropped) {
    const t = renameTarget(k, next[k], shape, next);
    if (t === undefined) continue;
    next[t.target] = t.value;
    delete next[k];
    renamed.push({ from: k, to: t.target });
  }
  const renamedFrom = new Set(renamed.map((r) => r.from));
  return {
    args: next,
    renamed,
    ignored: dropped.filter((k) => !renamedFrom.has(k)),
  };
};

/** Placeholder example value for an arg, by its name. */
const exampleValue = (key: string, field: z.ZodTypeAny | undefined): unknown => {
  const k = key.toLowerCase();
  let v: unknown;
  if (k === 'fieldid') v = 'CustomField:Account.Industry';
  else if (k.startsWith('object')) v = k === 'objectid' ? 'CustomObject:Account' : 'Account';
  else if (k.startsWith('field')) v = 'Account.Industry';
  else if (k.startsWith('class')) v = 'ApexClass:AccountService';
  else if (k.startsWith('flow')) v = 'Flow:My_Flow';
  else if (k.startsWith('trigger')) v = 'ApexTrigger:AccountTrigger';
  else if (k.startsWith('permissionset')) v = 'PermissionSet:My_PermSet';
  else if (k.startsWith('profile')) v = 'Profile:Admin';
  else if (k === 'methodname') v = 'doWork';
  else if (k === 'query' || k === 'q') v = 'Account';
  else if (k === 'since') v = '2026-01-01';
  else if (k.endsWith('id') || k.endsWith('ids')) v = 'CustomObject:Account';
  else v = '…';
  return innerTypeName(field) === 'ZodArray' ? [v] : v;
};

/**
 * One compact line naming a tool's required args, a few optional ones, and an
 * example call — appended to invalid-query messages so the next attempt can
 * succeed without a describe round trip. `undefined` when the shape is unknown.
 */
export const expectedArgsHint = (schema: z.ZodTypeAny): string | undefined => {
  let shape: Readonly<Record<string, z.ZodTypeAny>> | undefined;
  try {
    shape = schemaShape(schema);
  } catch {
    return undefined;
  }
  if (shape === undefined) return undefined;
  const keys = Object.keys(shape);
  if (keys.length === 0) return undefined;
  const required = keys.filter((k) => !isOptionalField(shape[k] as z.ZodTypeAny));
  const optional = keys.filter((k) => !required.includes(k));
  const shown = optional.slice(0, 8);
  const more = optional.length > shown.length ? `, +${optional.length - shown.length} more` : '';
  const exampleKeys = required.length > 0 ? required : keys.slice(0, 1);
  const example = Object.fromEntries(
    exampleKeys.map((k) => [k, exampleValue(k, shape[k])]),
  );
  const req = required.length > 0 ? `required: ${required.join(', ')}; ` : '';
  return (
    `Expected args — ${req}optional: ${shown.join(', ') || '(none)'}${more}. ` +
    `Example: ${JSON.stringify(example)}. Use sfi.resolve {"query":"<name>"} to get canonical ids.`
  );
};
