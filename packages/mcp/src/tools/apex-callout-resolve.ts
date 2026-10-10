/**
 * Eval B01. What a non-literal `setEndpoint(...)` argument is made of.
 *
 * `classifyEndpointArgument` only reads a string literal at the very start of
 * the argument, so `Consts.PREFIX + cfg.Endpoint__c` came back as `dynamic`
 * with no host and no hint where the rest comes from, even when the vault held
 * the constant, the custom metadata records and the custom label it was built
 * from. This module splits the argument on its top-level `+` and resolves each
 * operand statically:
 *
 *   - a string literal, or a constant (`static final String X = '...'`, or a
 *     property whose getter only returns a literal) in the same class or in
 *     `OtherClass.X`, becomes LITERAL text;
 *   - `Label.X` / `System.Label.X` is a custom label, valued from the vault's
 *     CustomLabel node when it was retrieved;
 *   - `Type__mdt.getInstance('Rec').Field__c`, `Type__mdt.getAll().get(..).Field__c`
 *     and `v.Field__c` / `v[0].Field__c` where `v` is declared as `Type__mdt`
 *     (or a list of it) are custom metadata, valued from the vault's records;
 *   - `Setting__c.getInstance()/getOrgDefaults()/getValues(..).Field__c` is a
 *     custom setting, whose values are org DATA and never in the vault;
 *   - anything else (a parameter, a local, a method call) stays `unresolved`.
 *
 * Only the literal text BEFORE the first non-literal operand counts as the
 * known prefix. The prefix names a host or a credential outright when the name
 * is visibly finished (followed by `/`, `:`, `?` or `#`, or by a part whose
 * every vault value starts a new segment). When nothing shows where the name
 * ends, `'callout:My_API'` + x and `'https://api.vendor.com'` + x still name
 * `My_API` / `api.vendor.com`, hedged with `nameMayContinue` (x could extend
 * the name). A name cut off mid-token (`'https://api.'`, `'callout:My_'`), or
 * one the vault values show continuing, names nothing.
 * Everything here is static reading: it does not follow assignments, so a
 * constant reassigned elsewhere or a variable built over several lines stays
 * `unresolved` rather than guessed.
 */
import { readFile } from 'node:fs/promises';

import type { ComponentId } from '@sf-intelligence/contracts';
import { listNodesByIds } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { stripApexComments } from './apex-dml-index.js';
import { type CollectedRecordValues, collectRecordValues } from './explain-field.js';

/** Where a non-literal part of a callout endpoint comes from. */
export type CalloutDynamicSource = 'custom-metadata' | 'custom-label' | 'custom-setting' | 'unresolved';

/** One value the vault holds for a dynamic part, and the component holding it. */
export interface CalloutVaultValue {
  readonly value: string;
  /** `CustomMetadataRecord:Type__mdt.Rec` or `CustomLabel:Name`. */
  readonly from: string;
  /** Further records holding the SAME value (capped), when there are any. */
  readonly alsoFrom?: readonly string[];
}

/** One non-literal operand of the endpoint expression. */
export interface CalloutDynamicPart {
  /** The operand as written (comments removed, whitespace collapsed). */
  readonly expression: string;
  readonly source: CalloutDynamicSource;
  /** `Type__mdt` for `custom-metadata`. */
  readonly customMetadataType?: string;
  /** `Setting__c` for `custom-setting`. */
  readonly customSetting?: string;
  /** The field read, for `custom-metadata` / `custom-setting`. */
  readonly field?: string;
  /** The record named by `getInstance('Rec')` / `getAll().get('Rec')`, when a literal. */
  readonly record?: string;
  /** The label name for `custom-label`. */
  readonly customLabel?: string;
  /**
   * Values the vault holds for this part (custom metadata records / the custom
   * label), capped at {@link VAULT_VALUES_CAP}. Which one the code uses at
   * runtime is decided by data the vault does not see.
   */
  readonly vaultValues?: readonly CalloutVaultValue[];
  /** Total distinct values before the cap. */
  readonly vaultValueCount?: number;
  /** Records (or labels) holding a value, before any cap. */
  readonly vaultRecordCount?: number;
  /** Why `vaultValues` is missing or partial. */
  readonly vaultValuesNote?: string;
}

/** The statically known structure of a non-literal callout endpoint. */
export interface CalloutEndpointResolution {
  /** Literal text (literals + resolved constants) before the first dynamic part. */
  readonly literalPrefix: string;
  /** Constants that contributed literal text, as `Class.NAME`. */
  readonly constants: readonly string[];
  readonly dynamicParts: readonly CalloutDynamicPart[];
  readonly confidence: 'heuristic';
}

const VAULT_VALUES_CAP = 10;
const VALUE_TEXT_CAP = 300;
const ARGUMENT_TEXT_CAP = 2000;

const LITERAL = /^'((?:\\.|[^'\\])*)'$/;
const LABEL = /^(?:System\s*\.\s*)?Label\s*\.\s*([A-Za-z_]\w*)$/i;
const MDT_GET_INSTANCE =
  /^([A-Za-z_]\w*__mdt)\s*\.\s*getInstance\s*\(\s*(?:'([^']*)'\s*|[^)]*)\)\s*\.\s*([A-Za-z_]\w*)$/i;
const MDT_GET_ALL =
  /^([A-Za-z_]\w*__mdt)\s*\.\s*getAll\s*\(\s*\)\s*\.\s*get\s*\(\s*(?:'([^']*)'\s*|[^)]*)\)\s*\.\s*([A-Za-z_]\w*)$/i;
const SETTING =
  /^([A-Za-z_]\w*__c)\s*\.\s*(?:getInstance|getOrgDefaults|getValues)\s*\([^)]*\)\s*\.\s*([A-Za-z_]\w*)$/i;
const VAR_FIELD = /^([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\.\s*([A-Za-z_]\w*__c)$/i;
const CONSTANT_REF = /^(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unescapeApex = (s: string): string => s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/**
 * The text inside `setEndpoint( … )` starting on the 1-based `line` of
 * comment-free `code`, or null when the call cannot be found or does not
 * close within {@link ARGUMENT_TEXT_CAP} characters.
 */
export const endpointArgumentText = (code: string, line: number): string | null => {
  let start = 0;
  for (let l = 1; l < line; l += 1) {
    const nl = code.indexOf('\n', start);
    if (nl === -1) return null;
    start = nl + 1;
  }
  const lineEnd = code.indexOf('\n', start);
  const m = /\bsetEndpoint\s*\(/i.exec(code.slice(start, lineEnd === -1 ? code.length : lineEnd));
  if (m === null) return null;
  const open = start + m.index + m[0].length;
  let depth = 1;
  for (let i = open; i < code.length && i - open < ARGUMENT_TEXT_CAP; i += 1) {
    const c = code[i];
    if (c === "'") {
      i += 1;
      while (i < code.length && code[i] !== "'" && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
    } else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i);
    }
  }
  return null;
};

/** Split an expression on its top-level `+` (outside literals and brackets). */
export const splitConcatenation = (expr: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "'") {
      i += 1;
      while (i < expr.length && expr[i] !== "'") i += expr[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === '+' && depth === 0) {
      parts.push(expr.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(expr.slice(from));
  return parts.map((p) => p.replace(/\s+/g, ' ').trim());
};

/** Drop parentheses that wrap the WHOLE operand. */
const unwrap = (op: string): string => {
  let s = op.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '(') depth += 1;
      else if (s[i] === ')') depth -= 1;
      if (depth === 0 && i < s.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    s = s.slice(1, -1).trim();
  }
  return s;
};

/**
 * The literal value of constant `name` declared in comment-free `code`: a
 * `static final String NAME = '…';` field (both modifiers, any order; a local
 * `final` in some other method is NOT a constant of the call site) or a
 * `String NAME { get { return '…'; } }` property whose getter only returns
 * that literal (static or not: it can return nothing else). Null when absent,
 * when two declarations disagree (inner classes), or when ANY other `String
 * NAME` is declared in the same code (a local, parameter, non-final field or
 * computed property): scope is not tracked, so a name that may be shadowed at
 * the call site is not resolved.
 */
export const constantValueIn = (code: string, name: string): string | null => {
  const n = escapeRe(name);
  const found = new Set<string>();
  const field = new RegExp(
    `(?<=^|[;{}])\\s*((?:@?[A-Za-z]+\\s+)+)String\\s+${n}\\s*=\\s*'((?:\\\\.|[^'\\\\])*)'\\s*;`,
    'gi',
  );
  const getter = new RegExp(
    `\\bString\\s+${n}\\s*\\{\\s*get\\s*\\{\\s*return\\s+'((?:\\\\.|[^'\\\\])*)'\\s*;\\s*\\}\\s*(?:(?:private\\s+|protected\\s+)?set\\s*;\\s*)?\\}`,
    'gi',
  );
  let accepted = 0;
  for (const m of code.matchAll(field)) {
    const modifiers = (m[1] ?? '').toLowerCase().split(/\s+/);
    if (modifiers.includes('static') && modifiers.includes('final')) {
      found.add(unescapeApex(m[2] ?? ''));
      accepted += 1;
    }
  }
  for (const m of code.matchAll(getter)) {
    found.add(unescapeApex(m[1] ?? ''));
    accepted += 1;
  }
  const declarations = [...code.matchAll(new RegExp(`\\bString\\s+${n}\\s*[=;,){]`, 'gi'))].length;
  if (declarations > accepted) return null;
  return found.size === 1 ? ([...found][0] as string) : null;
};

/** The `__mdt` type a variable is declared as in `code` (`T v`, `List<T> v`, `T[] v`). */
const declaredMdtType = (code: string, variable: string): string | null => {
  const re = new RegExp(
    `(?:\\bList\\s*<\\s*([A-Za-z_]\\w*__mdt)\\s*>|\\b([A-Za-z_]\\w*__mdt)(?:\\s*\\[\\s*\\])?)\\s+${escapeRe(variable)}\\b`,
    'gi',
  );
  const types = new Set<string>();
  for (const m of code.matchAll(re)) types.add((m[1] ?? m[2] ?? '') as string);
  types.delete('');
  return types.size === 1 ? ([...types][0] as string) : null;
};

type Operand =
  | { readonly kind: 'literal'; readonly text: string; readonly constant?: string }
  | { readonly kind: 'dynamic'; readonly part: CalloutDynamicPart };

type VaultValuesOf = Pick<CalloutDynamicPart, 'vaultValues' | 'vaultValueCount' | 'vaultRecordCount' | 'vaultValuesNote'>;

/** Reads and caches other Apex classes' comment-free source by class name. */
export type ClassCodeReader = (className: string) => Promise<string | null>;

/** Lookups against the vault; injectable so the parser is testable alone. */
export interface CalloutVaultLookups {
  readonly classCode: ClassCodeReader;
  readonly mdtValues: (
    type: string,
    field: string,
    record: string | undefined,
  ) => Promise<VaultValuesOf>;
  readonly labelValue: (
    name: string,
  ) => Promise<VaultValuesOf>;
}

const classifyOperand = async (
  raw: string,
  ownClass: string,
  ownCode: string,
  lookups: CalloutVaultLookups,
): Promise<Operand> => {
  const op = unwrap(raw);
  const lit = LITERAL.exec(op);
  if (lit !== null) return { kind: 'literal', text: unescapeApex(lit[1] ?? '') };

  const label = LABEL.exec(op);
  if (label?.[1] !== undefined) {
    return {
      kind: 'dynamic',
      part: { expression: op, source: 'custom-label', customLabel: label[1], ...(await lookups.labelValue(label[1])) },
    };
  }
  const mdt = MDT_GET_INSTANCE.exec(op) ?? MDT_GET_ALL.exec(op);
  if (mdt?.[1] !== undefined && mdt[3] !== undefined) {
    const record = mdt[2];
    return {
      kind: 'dynamic',
      part: {
        expression: op,
        source: 'custom-metadata',
        customMetadataType: mdt[1],
        field: mdt[3],
        ...(record !== undefined ? { record } : {}),
        ...(await lookups.mdtValues(mdt[1], mdt[3], record)),
      },
    };
  }
  const setting = SETTING.exec(op);
  if (setting?.[1] !== undefined && setting[2] !== undefined) {
    return {
      kind: 'dynamic',
      part: {
        expression: op,
        source: 'custom-setting',
        customSetting: setting[1],
        field: setting[2],
        vaultValuesNote: 'Custom setting values are org data; the vault holds the setting definition, not its rows.',
      },
    };
  }
  const varField = VAR_FIELD.exec(op);
  if (varField?.[1] !== undefined && varField[2] !== undefined) {
    const type = declaredMdtType(ownCode, varField[1]);
    if (type !== null) {
      return {
        kind: 'dynamic',
        part: {
          expression: op,
          source: 'custom-metadata',
          customMetadataType: type,
          field: varField[2],
          ...(await lookups.mdtValues(type, varField[2], undefined)),
        },
      };
    }
  }
  const ref = CONSTANT_REF.exec(op);
  if (ref?.[2] !== undefined) {
    const cls = ref[1];
    const code = cls === undefined || cls.toLowerCase() === ownClass.toLowerCase() ? ownCode : await lookups.classCode(cls);
    const value = code === null ? null : constantValueIn(code, ref[2]);
    if (value !== null) return { kind: 'literal', text: value, constant: `${cls ?? ownClass}.${ref[2]}` };
  }
  return { kind: 'dynamic', part: { expression: op, source: 'unresolved' } };
};

/**
 * Resolve one `setEndpoint` argument. Returns null when nothing in it is
 * statically known (no literal text and no recognized source), so a bare
 * parameter does not grow an empty `resolution` block.
 */
export const resolveEndpointArgument = async (
  argText: string,
  ownClass: string,
  ownCode: string,
  lookups: CalloutVaultLookups,
): Promise<CalloutEndpointResolution | null> => {
  const operands: Operand[] = [];
  for (const raw of splitConcatenation(argText)) {
    if (raw.length === 0) return null; // unary/odd syntax: do not guess
    operands.push(await classifyOperand(raw, ownClass, ownCode, lookups));
  }
  let literalPrefix = '';
  let prefixOpen = true;
  const constants: string[] = [];
  const dynamicParts: CalloutDynamicPart[] = [];
  for (const o of operands) {
    if (o.kind === 'literal') {
      if (prefixOpen) {
        literalPrefix += o.text;
        if (o.constant !== undefined) constants.push(o.constant);
      }
    } else {
      prefixOpen = false;
      dynamicParts.push(o.part);
    }
  }
  if (literalPrefix.length === 0 && dynamicParts.every((p) => p.source === 'unresolved')) return null;
  return { literalPrefix, constants, dynamicParts, confidence: 'heuristic' };
};

/**
 * Where the name the literal prefix ends with stops, judged from the dynamic
 * part right after it: `ends` when there is no dynamic part or every value the
 * vault holds for it starts a new segment (`/`, `?`, `#`, or `:` for a port),
 * so `'callout:Nc' + Label.Path` (label `/v1/x`) names `Nc` outright;
 * `continues` when every value is known and starts with a name character, so
 * the name runs on; `unknown` otherwise (no vault values, a partial list, or
 * a mix).
 */
export type PrefixNameEnd = 'ends' | 'continues' | 'unknown';

export const prefixNameEnd = (resolution: CalloutEndpointResolution): PrefixNameEnd => {
  const next = resolution.dynamicParts[0];
  if (next === undefined) return 'ends';
  const values = next.vaultValues ?? [];
  if (values.length === 0 || values.length !== (next.vaultValueCount ?? -1)) return 'unknown';
  if (values.every((v) => /^[/?#:]/.test(v.value))) return 'ends';
  if (values.every((v) => /^[A-Za-z0-9_.-]/.test(v.value))) return 'continues';
  return 'unknown';
};

/** What a literal prefix names; `nameMayContinue` hedges a name with no visible end. */
export interface PrefixNames {
  readonly namedCredential: string | null;
  readonly host: string | null;
  /**
   * True when the name runs to the end of the prefix and nothing shows where
   * it stops: the runtime part could extend it (`callout:My_API` + `_V2/x`).
   */
  readonly nameMayContinue: boolean;
}

/**
 * What a resolved literal prefix NAMES: a credential (`callout:Name`) or a
 * host (`https://host`). A name followed by a separator in the prefix (`/`,
 * `?`, `#`, or `:` after a host), or running to the end of a prefix whose
 * `end` is `ends`, is named outright. One running to the end of the prefix
 * when `end` is `unknown` is named with `nameMayContinue`, unless it is cut
 * off mid-token (a host ending in `.` / `-` or holding no `.`; a credential
 * ending in `_`). With `end` `continues` it names nothing.
 */
export const prefixNames = (prefix: string, end: PrefixNameEnd): PrefixNames => {
  const none: PrefixNames = { namedCredential: null, host: null, nameMayContinue: false };
  const nc = /^callout:([A-Za-z_][A-Za-z_0-9]*)([/?#]|$)/i.exec(prefix);
  const host = nc === null ? /^https?:\/\/([^/:?#\s]+)([/:?#]|$)/i.exec(prefix) : null;
  const name = nc?.[1] ?? host?.[1];
  if (name === undefined) return none;
  const make = (nameMayContinue: boolean): PrefixNames =>
    nc !== null
      ? { namedCredential: name, host: null, nameMayContinue }
      : { namedCredential: null, host: name.toLowerCase(), nameMayContinue };
  if ((nc?.[2] ?? host?.[2] ?? '') !== '' || end === 'ends') return make(false);
  if (end === 'continues') return none;
  const cutOff = nc !== null ? /_$/.test(name) : /[.-]$/.test(name) || !name.includes('.');
  return cutOff ? none : make(true);
};

const capValues = (values: readonly CalloutVaultValue[]): Pick<CalloutDynamicPart, 'vaultValues' | 'vaultValueCount' | 'vaultRecordCount'> => {
  const holders = new Map<string, string[]>();
  for (const v of values) holders.set(v.value, [...(holders.get(v.value) ?? []), v.from]);
  const distinct = [...holders];
  return {
    vaultValues: distinct.slice(0, VAULT_VALUES_CAP).map(([value, from]) => ({
      value: value.slice(0, VALUE_TEXT_CAP),
      from: from[0] as string,
      ...(from.length > 1 ? { alsoFrom: from.slice(1, 1 + VAULT_VALUES_CAP) } : {}),
    })),
    vaultValueCount: distinct.length,
    vaultRecordCount: values.length,
  };
};

/** Vault-backed lookups over the graph and the vault's Apex source. */
export const vaultCalloutLookups = (ctx: Context): CalloutVaultLookups => {
  const classCache = new Map<string, Promise<string | null>>();
  const classCode: ClassCodeReader = (className) => {
    const key = className.toLowerCase();
    const hit = classCache.get(key);
    if (hit !== undefined) return hit;
    const p = (async (): Promise<string | null> => {
      const nodes = await listNodesByIds(ctx.graph, [`ApexClass:${className}` as ComponentId]);
      const path = nodes.ok ? nodes.value[0]?.sourcePath : null;
      if (path === null || path === undefined || path.length === 0) return null;
      try {
        return stripApexComments(await readFile(resolveVaultSourcePath(ctx.vaultRoot, path), 'utf-8'));
      } catch {
        return null;
      }
    })();
    classCache.set(key, p);
    return p;
  };
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const p = run();
    cache.set(key, p);
    return p;
  };
  const mdtCache = new Map<string, Promise<VaultValuesOf>>();
  const labelCache = new Map<string, Promise<VaultValuesOf>>();
  return {
    classCode,
    mdtValues: (type, field, record) =>
      memo(mdtCache, `${type}|${field}|${record ?? ''}`.toLowerCase(), () => mdtValuesUncached(ctx, type, field, record)),
    labelValue: (name) => memo(labelCache, name.toLowerCase(), () => labelValueUncached(ctx, name)),
  };
};

const mdtValuesUncached = async (
  ctx: Context,
  type: string,
  field: string,
  record: string | undefined,
): Promise<VaultValuesOf> => {
  // Source-format record files are named `<Type without __mdt>.<Record>`, and
  // the record extractor parents them on that bare name; a record built from a
  // `__mdt`-suffixed name parents on the type itself. Read both.
  const bare = type.replace(/__mdt$/i, '');
  const rowsOut: CollectedRecordValues['rows'][number][] = [];
  let blind = 0;
  for (const parent of new Set([`CustomObject:${type}`, `CustomObject:${bare}`])) {
    const collected = await collectRecordValues(ctx, parent as ComponentId, field);
    if (!collected.ok) return { vaultValuesNote: `Records of ${type} could not be read from the vault.` };
    rowsOut.push(...collected.value.rows);
    blind += collected.value.notExtracted.length + collected.value.unreadable.length;
  }
  const wantRecord = record?.toLowerCase();
  const rows = rowsOut.filter(
    (r) =>
      wantRecord === undefined ||
      (r.recordId as string).slice((r.recordId as string).lastIndexOf('.') + 1).toLowerCase() === wantRecord,
  );
  const values = rows
    .filter((r) => !r.isMasked && typeof r.value === 'string' && r.value.length > 0)
    .map((r) => ({ value: r.value as string, from: r.recordId as string }));
  const notes: string[] = [];
  if (values.length === 0) {
    notes.push(
      wantRecord === undefined
        ? `No ${type} record in the vault sets ${field}.`
        : `Record ${bare}.${record ?? ''} is not in the vault or does not set ${field}.`,
    );
  }
  if (rows.some((r) => r.isMasked)) notes.push('Some record values are masked by the managed package.');
  if (blind > 0) notes.push(`${blind} ${type} record(s) carry no readable values (refresh the vault).`);
  if (values.length > 0 && record === undefined) {
    notes.push(
      'Which record the code reads at runtime is not traced; each distinct value is listed once, with every record holding it (from + alsoFrom).',
    );
  }
  return {
    ...(values.length > 0 ? capValues(values) : {}),
    ...(notes.length > 0 ? { vaultValuesNote: notes.join(' ') } : {}),
  };
};

const labelValueUncached = async (ctx: Context, name: string): Promise<VaultValuesOf> => {
  const nodes = await listNodesByIds(ctx.graph, [`CustomLabel:${name}` as ComponentId]);
  const node = nodes.ok ? nodes.value[0] : undefined;
  const value = node?.properties['value'];
  if (typeof value !== 'string' || value.length === 0) {
    return { vaultValuesNote: `CustomLabel:${name} is not in the vault; its value is unknown here.` };
  }
  return {
    ...capValues([{ value, from: node?.id ?? `CustomLabel:${name}` }]),
    vaultValuesNote: 'The default-language value; a translation or a later edit can change it at runtime.',
  };
};
