import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DATAPACK_FILE_SUFFIX, isDataPackPath } from '@sf-intelligence/core';

/**
 * Managed-package (Vlocity) OmniStudio, read from a Vlocity Build Tool export.
 *
 * The managed packages — namespaces `vlocity_cmt`, `vlocity_ins`, `vlocity_ps`,
 * and the `omnistudio` managed runtime — store OmniScripts, Integration
 * Procedures, DataRaptors and Cards as RECORDS (`OmniScript__c` + `Element__c`,
 * `DRBundle__c` + `DRMapItem__c`, `VlocityCard__c`), which no Metadata API
 * retrieve contains. `vlocity packExport` writes them as DataPacks:
 *
 *   <projectPath>/<DataPackType>/<DataPackKey>/<DataPackKey>_DataPack.json
 *
 * with large JSON fields either inline, JSON-encoded, or written to a sibling
 * file named in the field (`…_PropertySet.json`, `…_Mappings.json`).
 *
 * This module turns one DataPack into the object the native parsers and
 * extractors already read for the Metadata API form (`<OmniScript>`,
 * `<OmniIntegrationProcedure>`, `<OmniDataTransform>`, `<OmniUiCard>`), so every
 * extractor, graph rule and OmniStudio tool works on managed-package
 * components unchanged. The two runtimes share their element types and
 * `propertySetConfig` keys — native OmniStudio was built from the managed one —
 * so only the record envelope differs.
 *
 * Tolerant by design: namespace placeholder or real prefix, inline object,
 * JSON string or sibling file, and the parent-element reference as a lookup
 * object, a source key, or a denormalized name are all accepted. What cannot
 * be read becomes a warning, never a guess.
 */

/** DataPack type folders this module models, and the component type each becomes. */
export const DATAPACK_KINDS = Object.freeze({
  OmniScript: 'OmniScript',
  IntegrationProcedure: 'OmniIntegrationProcedure',
  DataRaptor: 'OmniDataTransform',
  VlocityCard: 'OmniUiCard',
} as const);

export type DataPackKind = keyof typeof DATAPACK_KINDS;
export type DataPackComponentType = (typeof DATAPACK_KINDS)[DataPackKind];

// The layout itself (main-file suffix) lives in core, where the vault's
// snapshot hashing reads it too.
export { DATAPACK_FILE_SUFFIX, isDataPackPath };

/** The DataPack kind a folder name names, or null. */
export const dataPackKindOfDir = (dirName: string | undefined): DataPackKind | null =>
  dirName !== undefined && Object.prototype.hasOwnProperty.call(DATAPACK_KINDS, dirName) ? (dirName as DataPackKind) : null;

/**
 * The component type a source path holds when it is a DataPack — a DataPack
 * folder (`…/<Kind>/<Key>/`, `isDirectory`) or its main file
 * (`…/<Kind>/<Key>/<Key>_DataPack.json`) — or null.
 */
export const dataPackComponentType = (
  segments: readonly string[],
  fileName: string,
  isDirectory: boolean,
): DataPackComponentType | null => {
  if (isDirectory) {
    const kind = dataPackKindOfDir(segments[segments.length - 1]);
    return kind === null ? null : DATAPACK_KINDS[kind];
  }
  if (!fileName.endsWith(DATAPACK_FILE_SUFFIX)) return null;
  const kind = dataPackKindOfDir(segments[segments.length - 2]);
  return kind === null ? null : DATAPACK_KINDS[kind];
};

/** Namespaces whose OmniStudio components are records (the managed packages). */
export const MANAGED_OMNISTUDIO_NAMESPACES: readonly string[] = Object.freeze([
  'vlocity_cmt',
  'vlocity_ins',
  'vlocity_ps',
  'omnistudio',
]);

/** The export's namespace placeholder, written in place of the real prefix. */
export const VLOCITY_NAMESPACE_PLACEHOLDER = '%vlocity_namespace%';

const NS_PREFIX = /^(%vlocity_namespace%|vlocity_cmt|vlocity_ins|vlocity_ps|omnistudio)__/i;

/** A field name without its managed-package prefix (`vlocity_cmt__Type__c` → `Type__c`). */
export const stripNamespace = (key: string): string => key.replace(NS_PREFIX, '');

/** A DataPack read from disk: the main record and its sibling files. */
export interface DataPackRead {
  /** Path of the `_DataPack.json` main file. */
  readonly mainPath: string;
  readonly mainText: string;
  readonly main: Readonly<Record<string, unknown>>;
  /** Sibling file name → text. */
  readonly siblings: ReadonlyMap<string, string>;
}

/** Cap on sibling files read per DataPack, and on one file's size. */
const MAX_SIBLINGS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Read a DataPack: `path` is its folder or its main file. The main file is
 * `<FolderName>_DataPack.json`, else the folder's only `*_DataPack.json`.
 */
export const readDataPack = async (
  path: string,
): Promise<{ readonly ok: true; readonly value: DataPackRead } | { readonly ok: false; readonly message: string; readonly missing: boolean }> => {
  let dir = path;
  let mainPath: string | null = null;
  try {
    const s = await stat(path);
    if (s.isFile()) {
      mainPath = path;
      dir = dirname(path);
    }
  } catch {
    return { ok: false, message: 'DataPack not found', missing: true };
  }
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (cause: unknown) {
    return { ok: false, message: `DataPack folder unreadable: ${cause instanceof Error ? cause.message : String(cause)}`, missing: false };
  }
  if (mainPath === null) {
    const own = `${basename(dir)}${DATAPACK_FILE_SUFFIX}`;
    const mains = names.filter((n) => n.endsWith(DATAPACK_FILE_SUFFIX));
    const pick = mains.includes(own) ? own : mains.length === 1 ? mains[0] : undefined;
    if (pick === undefined) {
      return {
        ok: false,
        message: mains.length === 0 ? 'folder has no *_DataPack.json file' : `folder has ${mains.length} *_DataPack.json files and none is ${own}`,
        missing: mains.length === 0,
      };
    }
    mainPath = join(dir, pick);
  }
  let mainText: string;
  try {
    mainText = await readFile(mainPath, 'utf8');
  } catch (cause: unknown) {
    return { ok: false, message: `DataPack unreadable: ${cause instanceof Error ? cause.message : String(cause)}`, missing: false };
  }
  let main: unknown;
  try {
    main = JSON.parse(mainText);
  } catch (cause: unknown) {
    return { ok: false, message: `DataPack is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, missing: false };
  }
  if (typeof main !== 'object' || main === null || Array.isArray(main)) {
    return { ok: false, message: 'DataPack main file is not a JSON object', missing: false };
  }
  const siblings = new Map<string, string>();
  const mainName = basename(mainPath);
  for (const name of names.filter((n) => n !== mainName).slice(0, MAX_SIBLINGS)) {
    try {
      const p = join(dir, name);
      if ((await stat(p)).size > MAX_FILE_BYTES) continue;
      siblings.set(name, await readFile(p, 'utf8'));
    } catch {
      // An unreadable sibling stays unresolved; a field naming it warns.
    }
  }
  return { ok: true, value: { mainPath, mainText, main: main as Record<string, unknown>, siblings } };
};

/** A record's fields keyed without their namespace prefix (first spelling wins). */
const fieldsOf = (record: unknown): ReadonlyMap<string, unknown> => {
  const out = new Map<string, unknown>();
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return out;
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    const key = stripNamespace(k);
    if (!out.has(key)) out.set(key, v);
  }
  return out;
};

/** The managed namespace a record is written in: a real prefix, or null for the placeholder / none. */
export const recordNamespace = (record: unknown): string | null => {
  if (typeof record !== 'object' || record === null) return null;
  for (const k of Object.keys(record as Record<string, unknown>)) {
    const m = NS_PREFIX.exec(k);
    if (m !== null && m[1] !== undefined && m[1].toLowerCase() !== VLOCITY_NAMESPACE_PLACEHOLDER) return m[1].toLowerCase();
  }
  return null;
};

/**
 * A field value that may hold JSON: an inline object / array, a JSON-encoded
 * string, or the name of a sibling file. Plain text stays text.
 */
const resolveJson = (value: unknown, dp: DataPackRead, warnings: string[], what: string): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  const sibling = dp.siblings.get(t);
  const text = sibling ?? (t.startsWith('{') || t.startsWith('[') ? t : null);
  if (text === null) {
    if (/\.json$/i.test(t)) warnings.push(`${what} names ${t}, which is not in the DataPack folder`);
    return value;
  }
  try {
    return JSON.parse(text);
  } catch (cause: unknown) {
    warnings.push(`${what} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return value;
  }
};

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim().length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim().length > 0 ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'string' ? v.trim().toLowerCase() === 'true' : fallback;
/** The text form the native XML carries for a boolean / number. */
const xmlValue = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(v) : typeof v === 'string' ? v : undefined;
const json = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v);

const recordType = (fields: ReadonlyMap<string, unknown>): string | null => {
  const t = fields.get('VlocityRecordSObjectType');
  return typeof t === 'string' ? stripNamespace(t) : null;
};

/**
 * 1-based line of every `"Name": "<value>"` key sitting at JSON nesting
 * `depth` (1 = the top-level object), by value, first occurrence. An element
 * record inside the main file's `Element__c` array sits at depth 3; the
 * `Name` inside a child's parent-reference object sits deeper, so it never
 * shadows the element's own line.
 */
const nameLinesAtDepth = (text: string, depth: number): Map<string, number> => {
  const out = new Map<string, number>();
  let level = 0;
  let line = 1;
  let i = 0;
  let pendingKey: { readonly name: string; readonly level: number } | null = null;
  let afterColonFor: { readonly name: string; readonly level: number } | null = null;
  const readString = (): string => {
    let j = i + 1;
    let raw = '';
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\') {
        raw += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (text[j] === '\n') line += 1;
      raw += text[j];
      j += 1;
    }
    i = j + 1;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const startLine = line;
      const value = readString();
      if (afterColonFor !== null) {
        if (afterColonFor.name === 'Name' && afterColonFor.level === depth && !out.has(value)) out.set(value, startLine);
        afterColonFor = null;
      } else {
        pendingKey = { name: value, level };
      }
      continue;
    }
    if (c === ':') {
      afterColonFor = pendingKey;
      pendingKey = null;
    } else if (c === '{' || c === '[') {
      level += 1;
      afterColonFor = null;
      pendingKey = null;
    } else if (c === '}' || c === ']') {
      level -= 1;
      afterColonFor = null;
      pendingKey = null;
    } else if (c === ',') {
      afterColonFor = null;
      pendingKey = null;
    } else if (c === '\n') {
      line += 1;
    }
    i += 1;
  }
  return out;
};

/** What a conversion hands to the native code path. */
export interface DataPackConversion {
  readonly kind: DataPackKind;
  /** The object the native parser builds from `<OmniScript>` / `<OmniIntegrationProcedure>` / … */
  readonly root: Readonly<Record<string, unknown>>;
  /** The component's api name, in the native file-stem form. */
  readonly apiName: string;
  /** The managed namespace the export was written in, or null (placeholder / unknown). */
  readonly namespace: string | null;
  /** The DataPack key (its folder name). */
  readonly key: string;
  /** 1-based line of an element's record in the main file, by element name; null when not inline. */
  readonly elementLine: (name: string) => number | null;
  readonly warnings: readonly string[];
}

type Conversion = { readonly ok: true; readonly value: DataPackConversion } | { readonly ok: false; readonly message: string };

/**
 * The separator inside a Vlocity source key (`<Object>/<Type>/<SubType>/…/<Name>`).
 * A key separator — `/` on every platform — not a file-path separator.
 */
const SOURCE_KEY_SEPARATOR = '/';

/** The last segment of a source key: the record's own name. */
const lastKeySegment = (key: string): string | null => key.split(SOURCE_KEY_SEPARATOR).pop() ?? null;

/** The name of an element's parent, from any of the shapes an export uses. */
const parentNameOf = (fields: ReadonlyMap<string, unknown>): string | null => {
  const direct = str(fields.get('ParentElementName__c'));
  if (direct !== null) return direct.trim();
  const ref = fields.get('ParentElementId__c');
  if (typeof ref === 'string') {
    const t = ref.trim();
    if (t.length === 0) return null;
    return t.includes(SOURCE_KEY_SEPARATOR) ? lastKeySegment(t) : t;
  }
  if (typeof ref === 'object' && ref !== null) {
    const rf = fieldsOf(ref);
    const name = str(rf.get('Name'));
    if (name !== null) return name.trim();
    for (const k of ['VlocityLookupRecordSourceKey', 'VlocityMatchingRecordSourceKey']) {
      const key = str(rf.get(k));
      if (key !== null) return lastKeySegment(key);
    }
  }
  return null;
};

/** An OmniScript or Integration Procedure DataPack → the `<OmniScript>` / `<OmniIntegrationProcedure>` object. */
export const dataPackToProcess = (dp: DataPackRead, folderKind: DataPackKind | null = null): Conversion => {
  const warnings: string[] = [];
  const f = fieldsOf(dp.main);
  const rt = recordType(f);
  if (rt !== null && rt !== 'OmniScript__c') return { ok: false, message: `not an OmniScript / Integration Procedure DataPack (record type ${rt})` };
  const type = str(f.get('Type__c'))?.trim() ?? null;
  const subType = str(f.get('SubType__c'))?.trim() ?? null;
  if (type === null || subType === null) return { ok: false, message: 'DataPack has no Type__c / SubType__c' };
  const isProcedure = bool(f.get('IsProcedure__c'), folderKind === 'IntegrationProcedure');
  const language = str(f.get('Language__c'))?.trim() ?? (isProcedure ? 'Procedure' : 'English');
  const version = num(f.get('Version__c')) ?? 1;
  const propertySet = resolveJson(f.get('PropertySet__c'), dp, warnings, 'PropertySet__c');
  const rawElements = resolveJson(f.get('Element__c'), dp, warnings, 'Element__c');
  const elementsInline = Array.isArray(f.get('Element__c'));
  const elements = Array.isArray(rawElements) ? rawElements : [];
  if (!Array.isArray(rawElements) && rawElements !== undefined && rawElements !== null) {
    warnings.push('Element__c is not a list of element records');
  }

  // Build the element tree by parent name, siblings in Order__c order.
  interface Built { readonly obj: Record<string, unknown>; readonly order: number; readonly index: number; readonly parent: string | null; readonly name: string }
  const built: Built[] = [];
  elements.forEach((record, index) => {
    const ef = fieldsOf(record);
    const name = str(ef.get('Name'));
    if (name === null) {
      warnings.push(`element ${index} has no Name; skipped`);
      return;
    }
    const cfg = resolveJson(ef.get('PropertySet__c'), dp, warnings, `PropertySet__c of ${name}`);
    const obj: Record<string, unknown> = {
      name,
      type: str(ef.get('Type__c')) ?? '',
      isActive: xmlValue(bool(ef.get('Active__c'), true)),
      level: xmlValue(num(ef.get('Level__c')) ?? undefined),
      sequenceNumber: xmlValue(num(ef.get('Order__c')) ?? index),
      ...(json(cfg) === undefined ? {} : { propertySetConfig: json(cfg) }),
      childElements: [] as Record<string, unknown>[],
    };
    built.push({ obj, order: num(ef.get('Order__c')) ?? index, index, parent: parentNameOf(ef), name: name.trim() });
  });
  const byName = new Map<string, Built>();
  for (const b of built) if (!byName.has(b.name)) byName.set(b.name, b);
  const roots: Built[] = [];
  const childrenOf = new Map<string, Built[]>();
  for (const b of built) {
    if (b.parent !== null && b.parent !== b.name && byName.has(b.parent)) {
      childrenOf.set(b.parent, [...(childrenOf.get(b.parent) ?? []), b]);
    } else {
      if (b.parent !== null && !byName.has(b.parent)) warnings.push(`element ${b.name} names parent ${b.parent}, which is not in the DataPack; placed at the top level`);
      roots.push(b);
    }
  }
  const sortSiblings = (xs: Built[]): Built[] => [...xs].sort((a, b) => a.order - b.order || a.index - b.index);
  const attach = (b: Built, seen: Set<string>): Record<string, unknown> => {
    if (seen.has(b.name)) return b.obj;
    seen.add(b.name);
    (b.obj['childElements'] as Record<string, unknown>[]).push(
      ...sortSiblings(childrenOf.get(b.name) ?? []).map((c) => attach(c, seen)),
    );
    return b.obj;
  };
  const seen = new Set<string>();
  const top = sortSiblings(roots).map((b) => attach(b, seen));
  // Elements whose parent chain loops never hang off a root: keep them, at the
  // top level, rather than drop them.
  for (const b of built) {
    if (seen.has(b.name)) continue;
    warnings.push(`element ${b.name} is in a parent-reference cycle; placed at the top level`);
    top.push(attach(b, seen));
  }

  const key = basename(dirname(dp.mainPath));
  const uniqueName = `${type}_${subType}_${language}_${version}`;
  const lines = elementsInline ? nameLinesAtDepth(dp.mainText, 3) : new Map<string, number>();
  const root: Record<string, unknown> = {
    name: str(f.get('Name')) ?? `${type}/${subType}/${language}`,
    type,
    subType,
    language,
    versionNumber: String(version),
    isActive: String(bool(f.get('IsActive__c'), false)),
    isIntegrationProcedure: String(isProcedure),
    omniProcessType: isProcedure ? 'Integration Procedure' : 'OmniScript',
    omniProcessKey: `${type}_${subType}`,
    uniqueName,
    isWebCompEnabled: String(bool(f.get('IsLwcEnabled__c'), false)),
    ...(str(f.get('Description__c')) === null ? {} : { description: str(f.get('Description__c')) }),
    ...(json(propertySet) === undefined ? {} : { propertySetConfig: json(propertySet) }),
    omniProcessElements: top,
  };
  return {
    ok: true,
    value: {
      kind: isProcedure ? 'IntegrationProcedure' : 'OmniScript',
      root,
      apiName: uniqueName,
      namespace: recordNamespace(dp.main),
      key,
      elementLine: (name) => lines.get(name) ?? null,
      warnings,
    },
  };
};

/** Native `<omniDataTransformItem>` field ← DataPack `DRMapItem__c` field. */
const MAP_ITEM_FIELDS: readonly (readonly [string, string, 'text' | 'num' | 'bool'])[] = [
  ['inputObjectName', 'InterfaceObjectName__c', 'text'],
  ['inputFieldName', 'InterfaceFieldAPIName__c', 'text'],
  ['outputObjectName', 'DomainObjectAPIName__c', 'text'],
  ['outputFieldName', 'DomainObjectFieldAPIName__c', 'text'],
  ['inputObjectQuerySequence', 'InterfaceObjectLookupOrder__c', 'num'],
  ['outputCreationSequence', 'DomainObjectCreationOrder__c', 'num'],
  ['filterOperator', 'FilterOperator__c', 'text'],
  ['filterValue', 'FilterValue__c', 'text'],
  ['filterGroup', 'FilterGroup__c', 'num'],
  ['formulaResultPath', 'FormulaResultPath__c', 'text'],
  ['formulaSequence', 'FormulaOrder__c', 'num'],
  ['defaultValue', 'DefaultValue__c', 'text'],
  ['disabled', 'IsDisabled__c', 'bool'],
  ['upsertKey', 'IsUpsertKey__c', 'bool'],
  ['requiredForUpsert', 'IsRequiredForUpsert__c', 'bool'],
  ['linkedFieldName', 'LinkedFieldName__c', 'text'],
  ['linkedObjectSequence', 'LinkedObjectSequence__c', 'num'],
  ['outputFieldFormat', 'DomainObjectFieldType__c', 'text'],
  ['transformValuesMappings', 'TransformValuesMappings__c', 'text'],
  ['globalKey', 'GlobalKey__c', 'text'],
];

/** A DataRaptor DataPack → the `<OmniDataTransform>` object. */
export const dataPackToMapper = (dp: DataPackRead): Conversion => {
  const warnings: string[] = [];
  const f = fieldsOf(dp.main);
  const rt = recordType(f);
  if (rt !== null && rt !== 'DRBundle__c') return { ok: false, message: `not a DataRaptor DataPack (record type ${rt})` };
  const name = str(f.get('Name'))?.trim() ?? null;
  if (name === null) return { ok: false, message: 'DataRaptor DataPack has no Name' };
  const rawItems = resolveJson(f.get('DRMapItem__c'), dp, warnings, 'DRMapItem__c');
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!Array.isArray(rawItems) && rawItems !== undefined && rawItems !== null) warnings.push('DRMapItem__c is not a list of mapping records');
  const omniItems = items.map((record) => {
    const mf = fieldsOf(record);
    const out: Record<string, unknown> = {};
    for (const [nativeKey, field, kind] of MAP_ITEM_FIELDS) {
      const v = mf.get(field);
      if (v === undefined || v === null || v === '') continue;
      out[nativeKey] = kind === 'bool' ? String(bool(v, false)) : kind === 'num' ? xmlValue(num(v) ?? undefined) : xmlValue(v);
    }
    const formula = str(mf.get('FormulaConverted__c')) ?? str(mf.get('Formula__c'));
    if (formula !== null) out['formulaExpression'] = formula;
    return out;
  });
  const root: Record<string, unknown> = {
    name,
    uniqueName: name,
    type: str(f.get('Type__c')) ?? str(f.get('DRMapType__c')) ?? '',
    ...(str(f.get('InputType__c')) === null ? {} : { inputType: str(f.get('InputType__c')) }),
    ...(str(f.get('OutputType__c')) === null ? {} : { outputType: str(f.get('OutputType__c')) }),
    ...(str(f.get('Description__c')) === null ? {} : { description: str(f.get('Description__c')) }),
    // A managed DRBundle has no activation flag; a DataRaptor runs when called.
    active: String(bool(f.get('IsActive__c'), true)),
    rollbackOnError: String(bool(f.get('RollbackOnError__c'), false)),
    fieldLevelSecurityEnabled: String(bool(f.get('CheckFieldLevelSecurity__c'), false)),
    nullInputsIncludedInOutput: String(bool(f.get('IsNullInputsIncludedInOutput__c'), false)),
    omniDataTransformItem: omniItems,
  };
  return {
    ok: true,
    value: {
      kind: 'DataRaptor',
      root,
      apiName: name,
      namespace: recordNamespace(dp.main),
      key: basename(dirname(dp.mainPath)),
      elementLine: () => null,
      warnings,
    },
  };
};

/** A Card DataPack → the `<OmniUiCard>` object (`Definition__c` holds the data source and states). */
export const dataPackToCard = (dp: DataPackRead): Conversion => {
  const warnings: string[] = [];
  const f = fieldsOf(dp.main);
  const rt = recordType(f);
  if (rt !== null && rt !== 'VlocityCard__c') return { ok: false, message: `not a Card DataPack (record type ${rt})` };
  const name = str(f.get('Name'))?.trim() ?? null;
  if (name === null) return { ok: false, message: 'Card DataPack has no Name' };
  const definition = resolveJson(f.get('Definition__c'), dp, warnings, 'Definition__c');
  const def = typeof definition === 'object' && definition !== null && !Array.isArray(definition) ? (definition as Record<string, unknown>) : null;
  if (def === null && f.get('Definition__c') !== undefined) warnings.push('Definition__c is not a JSON object');
  const author = str(f.get('Author__c'))?.trim() ?? null;
  const version = num(f.get('Version__c')) ?? 1;
  const root: Record<string, unknown> = {
    name,
    ...(author === null ? {} : { authorName: author }),
    versionNumber: String(version),
    isActive: String(bool(f.get('Active__c'), false)),
    omniUiCardType: bool(f.get('IsChildCard__c'), false) ? 'Child' : 'Parent',
    ...(def === null ? {} : { dataSourceConfig: JSON.stringify({ dataSource: def['dataSource'] ?? null }), propertySetConfig: JSON.stringify(def) }),
  };
  return {
    ok: true,
    value: {
      kind: 'VlocityCard',
      root,
      apiName: author === null ? `${name}_${version}` : `${name}_${author}_${version}`,
      namespace: recordNamespace(dp.main),
      key: basename(dirname(dp.mainPath)),
      elementLine: () => null,
      warnings,
    },
  };
};

/** Properties every node built from a DataPack carries. */
export const dataPackNodeProperties = (c: DataPackConversion): Readonly<Record<string, unknown>> => ({
  sourceFormat: 'vlocity-datapack',
  dataPackKey: c.key,
  managedPackageNamespace: c.namespace,
  ...(c.warnings.length > 0 ? { dataPackWarnings: c.warnings } : {}),
});
