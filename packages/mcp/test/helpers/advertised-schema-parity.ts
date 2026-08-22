/**
 * ADVERTISED-VS-ENFORCED INPUT PARITY — the generalised guard.
 *
 * A tool has TWO input contracts: the Zod schema `runTool` validates against
 * (ENFORCED) and the JSON Schema the roster hands `tools/list` (ADVERTISED).
 * When they disagree the failure is invisible from inside this repo, because
 * every unit test calls the handler directly and never reads the advertisement.
 *
 * `advertised-schema-parity.test.ts` used to check THREE tools, ONE property
 * each, on the `enum` axis alone. Ten drifts walked past it in a single batch —
 * six unreachable knobs on `sfi.order_of_execution`, a `.strict()` that no
 * advertisement mentioned on `sfi.what_happens_on_save`, an entire RecordType
 * scoping axis on `sfi.lifecycle_process`.
 * `route-question-schema-parity.test.ts` already held the correct assertion
 * (`Object.keys(schema.shape)` vs the advertised keys) — scoped to one tool.
 * This module generalises it to EVERY tool `dispatchTool` can route, on four
 * axes:
 *
 *   - `properties`            — the advertised property set vs the Zod key set,
 *                               with every advertised key that is NOT a shape
 *                               key proved REACHABLE by `safeParse` (alias
 *                               preprocessing is legitimate; a silently
 *                               stripped key is not).
 *   - `required`              — measured by REMOVAL, not by reading
 *                               `.isOptional()`: a key is required of a CALLER
 *                               only when omitting it from the full advertised
 *                               input makes the parse fail. Reading the shape
 *                               calls `objectApiName` required on a tool that
 *                               happily accepts `{objectId}`.
 *   - `additionalProperties`  — a `.strict()` schema must advertise `false`
 *   - `enum`                  — both directions: a Zod option the
 *                               advertisement omits is unreachable; an
 *                               advertised value the MEMBER schema rejects is a
 *                               lie. (Values a preprocess normalises — `sfi.
 *                               get_edges` maps `incoming` onto `in` — are
 *                               neither.)
 *
 * WHY IT PARSES `tool-dispatch.ts`. The name → validator binding exists in
 * exactly one place: the `dispatchTool` switch. A hand-maintained map here
 * would be a second copy of that binding, free to drift from it — the sin this
 * module exists to catch. So the map is DERIVED from the dispatcher's own
 * source, and {@link enforcedInputSchemas} throws rather than skipping when a
 * `case` cannot be resolved: an unparsed tool is an UNCHECKED tool, and this
 * file refuses to hide one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ZodTypeAny } from 'zod';

/**
 * `import.meta.glob` is Vite's, not Node's. `vite/client` is not a resolvable
 * types package in this workspace (vitest is a devDependency of the ROOT), and
 * `tsconfig.json` compiles `test/` as part of the build — so declare the one
 * member used here rather than pull a types package in for a single call.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { eager: true },
    ): Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }
}

// Eagerly materialise every tool module so a dispatcher-named schema export can
// be resolved without a runtime-computed `import()` specifier.
const TOOL_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  import.meta.glob('../../src/tools/*.ts', { eager: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH_SOURCE_PATH = join(HERE, '..', '..', 'src', 'tools', 'tool-dispatch.ts');

/** One tool's enforced validator, plus where it was found. */
export interface EnforcedSchemaBinding {
  readonly tool: string;
  /** The exported identifier the dispatcher passes to `runTool`/`safeParse`. */
  readonly identifier: string;
  /** The module specifier the dispatcher imports it from (e.g. `./resolve.js`). */
  readonly module: string;
  readonly schema: ZodTypeAny;
}

/** `import { a, b } from './mod.js'` → identifier → `./mod.js`. */
const importedIdentifierModules = (
  source: string,
): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g;
  let match: RegExpExecArray | null = importRe.exec(source);
  while (match !== null) {
    const names = match[1] ?? '';
    const specifier = match[2] ?? '';
    for (const raw of names.split(',')) {
      const identifier = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (identifier !== undefined && identifier.length > 0) {
        found.set(identifier, specifier);
      }
    }
    match = importRe.exec(source);
  }
  return found;
};

/** Resolve `./order-of-execution.js` + `orderOfExecutionInputSchema` to a value. */
const resolveExport = (specifier: string, identifier: string): unknown => {
  const base = specifier.replace(/^\.\//, '').replace(/\.js$/, '');
  const moduleRecord = TOOL_MODULES[`../../src/tools/${base}.ts`];
  if (moduleRecord === undefined) {
    throw new Error(
      `advertised-schema-parity: no module for '${specifier}' (identifier '${identifier}')`,
    );
  }
  const value = moduleRecord[identifier];
  if (value === undefined) {
    throw new Error(
      `advertised-schema-parity: '${specifier}' does not export '${identifier}'`,
    );
  }
  return value;
};

let cachedBindings: ReadonlyMap<string, EnforcedSchemaBinding> | undefined;

/**
 * Tool name → the Zod validator `dispatchTool` actually enforces, derived from
 * the dispatcher's own source.
 *
 * THROWS when a `case 'sfi.*'` arm names no schema, or names one that cannot be
 * resolved. That is deliberate: silently dropping an unparsable arm would let a
 * tool leave the parity gate without anyone noticing.
 */
export const enforcedInputSchemas = (): ReadonlyMap<string, EnforcedSchemaBinding> => {
  if (cachedBindings !== undefined) return cachedBindings;
  const source = readFileSync(DISPATCH_SOURCE_PATH, 'utf8');
  const flattened = source.replace(/\s+/g, ' ');
  const identifierModules = importedIdentifierModules(source);

  const caseRe = /case '(sfi\.[A-Za-z0-9_]+)':/g;
  const arms: { readonly tool: string; readonly start: number; readonly labelAt: number }[] = [];
  let match: RegExpExecArray | null = caseRe.exec(flattened);
  while (match !== null) {
    arms.push({
      tool: match[1] ?? '',
      start: caseRe.lastIndex,
      labelAt: match.index,
    });
    match = caseRe.exec(flattened);
  }
  if (arms.length === 0) {
    throw new Error('advertised-schema-parity: no dispatch cases parsed from tool-dispatch.ts');
  }

  const bindings = new Map<string, EnforcedSchemaBinding>();
  for (let i = 0; i < arms.length; i += 1) {
    const arm = arms[i];
    if (arm === undefined) continue;
    const next = arms[i + 1];
    const body = flattened.slice(arm.start, next?.labelAt ?? flattened.length);
    const viaRunTool = /runTool\(\s*ctx,\s*args,\s*([A-Za-z0-9_]+)\s*,/.exec(body);
    const viaSafeParse = /([A-Za-z0-9_]+InputSchema)\.safeParse/.exec(body);
    const identifier = viaRunTool?.[1] ?? viaSafeParse?.[1];
    if (identifier === undefined) {
      throw new Error(
        `advertised-schema-parity: could not find the enforced schema for '${arm.tool}' ` +
          `in its dispatch arm. Parsing tool-dispatch.ts is how this gate learns which ` +
          `validator a tool enforces; teach the parser the new arm shape rather than ` +
          `letting the tool go unchecked. Arm text: ${body.slice(0, 200)}`,
      );
    }
    const specifier = identifierModules.get(identifier);
    if (specifier === undefined) {
      throw new Error(
        `advertised-schema-parity: '${identifier}' (for ${arm.tool}) is not imported ` +
          `from a './*.js' module in tool-dispatch.ts`,
      );
    }
    bindings.set(arm.tool, {
      tool: arm.tool,
      identifier,
      module: specifier,
      schema: resolveExport(specifier, identifier) as ZodTypeAny,
    });
  }
  cachedBindings = bindings;
  return bindings;
};

// ── Zod introspection ────────────────────────────────────────────────────────

interface ZodDefLike {
  readonly typeName?: string;
  readonly unknownKeys?: string;
  readonly innerType?: ZodTypeAny;
  readonly schema?: ZodTypeAny;
  readonly type?: ZodTypeAny;
  readonly out?: ZodTypeAny;
  readonly values?: readonly string[];
}

const defOf = (schema: ZodTypeAny): ZodDefLike =>
  (schema as unknown as { readonly _def: ZodDefLike })._def;

/**
 * Peel `.refine()` / `z.preprocess()` / `.optional()` / `.default()` wrappers
 * down to the `ZodObject` (or `ZodEnum`) underneath. Returns `undefined` when
 * no such core exists.
 */
const unwrap = (schema: ZodTypeAny): ZodTypeAny | undefined => {
  let current: ZodTypeAny | undefined = schema;
  for (let guard = 0; guard < 20 && current !== undefined; guard += 1) {
    const def = defOf(current);
    switch (def.typeName) {
      case 'ZodObject':
      case 'ZodEnum':
      case 'ZodArray':
        return current;
      case 'ZodEffects':
        current = def.schema;
        break;
      case 'ZodOptional':
      case 'ZodDefault':
      case 'ZodNullable':
      case 'ZodCatch':
        current = def.innerType;
        break;
      case 'ZodPipeline':
        current = def.out;
        break;
      default:
        return undefined;
    }
  }
  return undefined;
};

interface ZodObjectLike {
  readonly shape: Readonly<Record<string, ZodTypeAny>>;
}

/** The `ZodObject` a tool's validator ultimately validates against. */
export const enforcedObject = (schema: ZodTypeAny): ZodObjectLike | undefined => {
  const core = unwrap(schema);
  if (core === undefined || defOf(core).typeName !== 'ZodObject') return undefined;
  return core as unknown as ZodObjectLike;
};

const isOptionalKey = (schema: ZodTypeAny): boolean =>
  (schema as unknown as { isOptional: () => boolean }).isOptional();

/** The literal set a Zod key accepts, when it is an enum (or an array of one). */
const zodEnumOptions = (schema: ZodTypeAny): readonly string[] | undefined => {
  const core = unwrap(schema);
  if (core === undefined) return undefined;
  const def = defOf(core);
  if (def.typeName === 'ZodEnum') return def.values;
  if (def.typeName === 'ZodArray' && def.type !== undefined) {
    return zodEnumOptions(def.type);
  }
  return undefined;
};

// ── Advertised JSON Schema introspection ─────────────────────────────────────

interface AdvertisedProperty {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly items?: { readonly type?: string; readonly enum?: readonly unknown[] };
}

interface AdvertisedSchema {
  readonly properties?: Readonly<Record<string, AdvertisedProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: unknown;
}

const advertisedEnumOptions = (
  property: AdvertisedProperty,
): readonly unknown[] | undefined => property.enum ?? property.items?.enum;

/** A value the advertised type would accept, for a `safeParse` reachability probe. */
const sampleFor = (property: AdvertisedProperty | undefined): unknown => {
  if (property === undefined) return 'x';
  const enumValues = property.enum;
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];
  switch (property.type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array': {
      const itemEnum = property.items?.enum;
      if (itemEnum !== undefined && itemEnum.length > 0) return [itemEnum[0]];
      return property.items?.type === 'object' ? [{}] : ['x'];
    }
    case 'object':
      return {};
    default:
      return 'x';
  }
};

// ── The four axes ────────────────────────────────────────────────────────────

export type ParityAxis =
  | 'properties'
  | 'required'
  | 'additionalProperties'
  | 'enum';

export interface ParityViolation {
  readonly tool: string;
  readonly axis: ParityAxis;
  /**
   * Canonical, human-readable statement of the exact disagreement. The baseline
   * matches on this string EXACTLY, so widening a known drift changes the
   * fingerprint and re-fails the gate — the baseline is a ratchet, not a mute.
   */
  readonly fingerprint: string;
}

const list = (values: readonly unknown[]): string =>
  values.map((v) => String(v)).join(',');

/**
 * Is an advertised key that is NOT a Zod shape key nonetheless REACHABLE?
 *
 * `z.object()` strips unknown keys, so such a key is honest only when a
 * `z.preprocess` alias-merge folds it into a canonical one. Three probes,
 * because the alias shapes in this repo differ: the key alone (an alias for a
 * required canonical), the key on top of a minimal valid input, and all the
 * extra keys together (`tests_for_change` folds `type` + `apiName` as a PAIR).
 */
const extraKeyIsReachable = (
  schema: ZodTypeAny,
  key: string,
  sample: unknown,
  baseInput: Readonly<Record<string, unknown>>,
  allExtras: Readonly<Record<string, unknown>>,
): boolean => {
  if (schema.safeParse({ [key]: sample }).success) return true;
  if (schema.safeParse({ ...baseInput, [key]: sample }).success) return true;
  return schema.safeParse(allExtras).success;
};

/** Every advertised-vs-enforced disagreement across the whole dispatch table. */
export const computeParityViolations = (
  tools: readonly {
    readonly name: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[],
): readonly ParityViolation[] => {
  const bindings = enforcedInputSchemas();
  const violations: ParityViolation[] = [];

  for (const tool of tools) {
    const binding = bindings.get(tool.name);
    if (binding === undefined) {
      throw new Error(
        `advertised-schema-parity: ${tool.name} is advertised in V01_TOOLS but has no ` +
          `dispatch arm — it can never be called.`,
      );
    }
    const object = enforcedObject(binding.schema);
    if (object === undefined) {
      throw new Error(
        `advertised-schema-parity: ${tool.name}'s validator (${binding.identifier}) does ` +
          `not resolve to a ZodObject, so its key set cannot be compared.`,
      );
    }
    const advertised = tool.inputSchema as AdvertisedSchema;
    const properties = advertised.properties ?? {};
    const advertisedKeys = Object.keys(properties).sort();
    const zodKeys = Object.keys(object.shape).sort();

    // --- axis: properties -------------------------------------------------
    const unadvertised = zodKeys.filter((k) => !advertisedKeys.includes(k));
    const extras = advertisedKeys.filter((k) => !zodKeys.includes(k));
    const baseInput: Record<string, unknown> = {};
    for (const key of zodKeys) {
      const member = object.shape[key];
      if (member !== undefined && !isOptionalKey(member)) {
        baseInput[key] = sampleFor(properties[key]);
      }
    }
    const allExtras: Record<string, unknown> = {};
    for (const key of extras) allExtras[key] = sampleFor(properties[key]);
    const unreachable = extras.filter(
      (key) =>
        !extraKeyIsReachable(
          binding.schema,
          key,
          sampleFor(properties[key]),
          baseInput,
          allExtras,
        ),
    );
    if (unadvertised.length > 0 || unreachable.length > 0) {
      violations.push({
        tool: tool.name,
        axis: 'properties',
        fingerprint: `enforced-not-advertised=[${list(unadvertised)}] advertised-not-reachable=[${list(unreachable)}]`,
      });
    }

    // --- axis: required ---------------------------------------------------
    // Measured by REMOVAL, not by reading `.isOptional()` off the shape. A key
    // can be non-optional in Zod and still not be required of a CALLER, because
    // an advertised alias satisfies it through a preprocess merge
    // (`sfi.lifecycle_process` accepts `{objectId}` alone, `sfi.tests_for_change`
    // accepts `{componentId}` alone). Reading the shape would call those
    // `required` and push a false entry into the baseline; removal asks the
    // question a host actually asks — "can I omit this?".
    const fullInput: Record<string, unknown> = {};
    for (const key of advertisedKeys) fullInput[key] = sampleFor(properties[key]);
    const fullParses = binding.schema.safeParse(fullInput).success;
    const trulyRequired = fullParses
      ? advertisedKeys.filter((key) => {
          const without = { ...fullInput };
          delete without[key];
          return !binding.schema.safeParse(without).success;
        })
      : // Fallback: a schema that refuses its own full advertised key set (two
        // mutually-exclusive selectors, say) cannot be probed by removal, so
        // fall back to the shape and SAY SO in the fingerprint.
        zodKeys.filter((k) => {
          const member = object.shape[k];
          return member !== undefined && !isOptionalKey(member);
        });
    const advertisedRequired = [...(advertised.required ?? [])].sort();
    if (list(trulyRequired) !== list(advertisedRequired)) {
      violations.push({
        tool: tool.name,
        axis: 'required',
        fingerprint: `${fullParses ? 'enforced' : 'enforced(shape)'}=[${list(trulyRequired)}] advertised=[${list(advertisedRequired)}]`,
      });
    }

    // --- axis: additionalProperties --------------------------------------
    const strict = defOf(object as unknown as ZodTypeAny).unknownKeys === 'strict';
    if (strict && advertised.additionalProperties !== false) {
      violations.push({
        tool: tool.name,
        axis: 'additionalProperties',
        fingerprint: `zod=.strict() advertised=${
          advertised.additionalProperties === undefined
            ? '(absent)'
            : JSON.stringify(advertised.additionalProperties)
        }`,
      });
    }

    // --- axis: enum -------------------------------------------------------
    // Bidirectional, and REJECTION-based in the advertised direction: an
    // advertised value the Zod enum does not list is fine when a preprocess
    // normalises it (`sfi.get_edges` maps `incoming`/`outgoing` onto `in`/`out`),
    // and a lie when `safeParse` refuses it. In the enforced direction there is
    // no such escape: a Zod option the advertisement omits is a value a
    // schema-driven host will never send.
    const enumDrift: string[] = [];
    for (const key of advertisedKeys) {
      const property = properties[key];
      const advertisedValues = property === undefined ? undefined : advertisedEnumOptions(property);
      if (advertisedValues === undefined) continue;
      const member = object.shape[key];
      if (member === undefined) continue;
      const zodValues = zodEnumOptions(member);
      if (zodValues === undefined) continue;
      // Probed against the MEMBER schema, not the whole object: a tool-level
      // `.refine()` ("name the object somehow") would reject every probe and
      // report the entire enum as unaccepted. Alias normalisation for enum
      // values lives on the member (`z.preprocess` inside the shape), so the
      // member probe still sees it.
      const wrapValue = (value: unknown): unknown =>
        property?.type === 'array' ? [value] : value;
      const rejected = advertisedValues.filter(
        (value) => !member.safeParse(wrapValue(value)).success,
      );
      const unadvertisedValues = zodValues.filter((value) => !advertisedValues.includes(value));
      if (rejected.length > 0 || unadvertisedValues.length > 0) {
        enumDrift.push(
          `${key}: enforced-not-advertised=[${list(unadvertisedValues)}] advertised-not-accepted=[${list(rejected)}]`,
        );
      }
    }
    if (enumDrift.length > 0) {
      violations.push({
        tool: tool.name,
        axis: 'enum',
        fingerprint: enumDrift.join(' | '),
      });
    }
  }

  return violations;
};
