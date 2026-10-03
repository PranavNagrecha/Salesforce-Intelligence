import { type DataPackRead, dataPackToMapper } from './datapack.js';
import {
  parseOmniXml,
  rawText,
  scanBlockNameLines,
  toArray,
  trimmedText,
  xmlBool,
  xmlNumber,
} from './xml.js';

/**
 * Parse a DataMapper (`*.rpt-meta.xml`, formerly DataRaptor) into its header
 * and its mapping ITEMS — the rows that decide which keys survive a Transform,
 * which fields a Load writes and which fields an Extract reads.
 *
 * Paths are kept RAW: `inputFieldName` / `outputFieldName` are matched against
 * screen keys exactly, and a near-miss (`Acme_X__c` vs `AcmeX__c`) is the
 * defect, so no normalisation happens here.
 */

/** The operation a mapper performs. `Turbo Extract` reads like an Extract. */
export type DataMapperKind = 'Extract' | 'Turbo Extract' | 'Transform' | 'Load' | 'Unknown';

/** The file-level identity of a DataMapper. */
export interface DataMapperHeader {
  /** The callable name — what a DataRaptor action's `bundle` names. */
  readonly name: string | null;
  readonly uniqueName: string | null;
  readonly kind: DataMapperKind;
  /** Raw `<type>` / `<interfaceClass>` text. */
  readonly rawType: string | null;
  readonly inputType: string | null;
  readonly outputType: string | null;
  /** NOT a runtime switch — real orgs run mappers whose `active` is false. */
  readonly active: boolean;
  readonly versionNumber: number | null;
  readonly description: string | null;
  readonly rollbackOnError: boolean;
  readonly fieldLevelSecurityEnabled: boolean;
  readonly nullInputsIncludedInOutput: boolean;
}

/** One mapping row. */
export interface DataMapperItem {
  /** Document position — the stable item id suffix. */
  readonly index: number;
  readonly line: number | null;
  readonly inputFieldName: string | null;
  readonly outputFieldName: string | null;
  /** `json` for a JSON output, an SObject API name for a Load. */
  readonly outputObjectName: string | null;
  /** Set on an Extract step row (the SObject queried). */
  readonly inputObjectName: string | null;
  readonly inputObjectQuerySequence: number | null;
  readonly filterOperator: string | null;
  readonly filterValue: string | null;
  readonly filterGroup: number | null;
  readonly formulaExpression: string | null;
  readonly formulaResultPath: string | null;
  readonly formulaSequence: number | null;
  readonly defaultValue: string | null;
  readonly disabled: boolean;
  readonly upsertKey: boolean;
  readonly requiredForUpsert: boolean;
  readonly linkedFieldName: string | null;
  readonly linkedObjectSequence: number | null;
  readonly outputCreationSequence: number | null;
  readonly outputFieldFormat: string | null;
  readonly transformValuesMappings: string | null;
  readonly globalKey: string | null;
}

/** A parsed DataMapper. */
export interface DataMapperDoc {
  readonly header: DataMapperHeader;
  readonly items: readonly DataMapperItem[];
}

/** Parse result. */
export type DataMapperParse =
  | { readonly ok: true; readonly doc: DataMapperDoc }
  | { readonly ok: false; readonly message: string };

const kindOf = (rawType: string | null): DataMapperKind => {
  if (rawType === null) return 'Unknown';
  const t = rawType.trim();
  if (t === 'Extract' || /DataRaptorExtract$/.test(t)) return 'Extract';
  if (t === 'Turbo Extract' || /DataRaptorTurboExtract$/.test(t)) return 'Turbo Extract';
  if (t === 'Transform' || /DataRaptorTransform$/.test(t)) return 'Transform';
  if (t === 'Load' || /DataRaptorLoad$|DataRaptorPost$/.test(t)) return 'Load';
  return 'Unknown';
};

/** A non-placeholder text value: blank and `0.0`-style numbers stay numbers elsewhere. */
const text = (value: unknown): string | null => rawText(value);

/** Parse `xmlText` as a DataMapper. */
export const parseDataMapper = (xmlText: string): DataMapperParse => {
  const parsed = parseOmniXml(xmlText, 'OmniDataTransform');
  if (!parsed.ok) return parsed;
  const blocks = scanBlockNameLines(xmlText, ['omniDataTransformItem']);
  return { ok: true, doc: buildDataMapperDoc(parsed.root, (index) => blocks[index]?.startLine ?? null) };
};

/** Parse a managed-package (Vlocity) DataRaptor DataPack into the same document. */
export const parseDataMapperDataPack = (dp: DataPackRead): DataMapperParse => {
  const conv = dataPackToMapper(dp);
  if (!conv.ok) return { ok: false, message: conv.message };
  return { ok: true, doc: buildDataMapperDoc(conv.value.root, () => null) };
};

/** Build the document from a parsed `<OmniDataTransform>` root; `itemLine` gives an item's source line. */
export const buildDataMapperDoc = (
  root: Readonly<Record<string, unknown>>,
  itemLine: (index: number) => number | null,
): DataMapperDoc => {
  // `<type>` carries the short form; `<interfaceClass>` (rare) the class form.
  const rawType = trimmedText(root['type']) ?? trimmedText(root['interfaceClass']);
  const header: DataMapperHeader = {
    name: trimmedText(root['name']),
    uniqueName: trimmedText(root['uniqueName']),
    kind: kindOf(rawType),
    rawType,
    inputType: trimmedText(root['inputType']),
    outputType: trimmedText(root['outputType']),
    active: xmlBool(root['active']),
    versionNumber: xmlNumber(root['versionNumber']),
    description: trimmedText(root['description']),
    rollbackOnError: xmlBool(root['rollbackOnError']),
    fieldLevelSecurityEnabled: xmlBool(root['fieldLevelSecurityEnabled']),
    nullInputsIncludedInOutput: xmlBool(root['nullInputsIncludedInOutput']),
  };
  const items: DataMapperItem[] = [];
  let index = 0;
  for (const entry of toArray(root['omniDataTransformItem'])) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    items.push({
      index,
      line: itemLine(index),
      inputFieldName: text(o['inputFieldName']),
      outputFieldName: text(o['outputFieldName']),
      outputObjectName: trimmedText(o['outputObjectName']),
      inputObjectName: trimmedText(o['inputObjectName']),
      inputObjectQuerySequence: xmlNumber(o['inputObjectQuerySequence']),
      filterOperator: trimmedText(o['filterOperator']),
      filterValue: text(o['filterValue']),
      filterGroup: xmlNumber(o['filterGroup']),
      formulaExpression: text(o['formulaExpression']),
      formulaResultPath: text(o['formulaResultPath']),
      formulaSequence: xmlNumber(o['formulaSequence']),
      defaultValue: text(o['defaultValue']),
      disabled: xmlBool(o['disabled']),
      upsertKey: xmlBool(o['upsertKey']),
      requiredForUpsert: xmlBool(o['requiredForUpsert']),
      linkedFieldName: trimmedText(o['linkedFieldName']),
      linkedObjectSequence: xmlNumber(o['linkedObjectSequence']),
      outputCreationSequence: xmlNumber(o['outputCreationSequence']),
      outputFieldFormat: trimmedText(o['outputFieldFormat']),
      transformValuesMappings: trimmedText(o['transformValuesMappings']),
      globalKey: trimmedText(o['globalKey']),
    });
    index += 1;
  }
  return { header, items };
};

/** True when `outputObjectName` names JSON (or nothing) rather than an SObject. */
export const isJsonOutputObject = (outputObjectName: string | null): boolean =>
  outputObjectName === null ||
  outputObjectName.length === 0 ||
  outputObjectName.toLowerCase() === 'json' ||
  outputObjectName.toLowerCase() === 'formula';

/**
 * For an Extract: bind each extract alias to the SObject its step queries. An
 * extract step is a row carrying `inputObjectName` (plus its filter) whose
 * `outputFieldName` is the alias the mapping rows address as `alias:Field`.
 * An alias bound to two different objects is dropped (ambiguous).
 */
export const extractAliases = (items: readonly DataMapperItem[]): ReadonlyMap<string, string> => {
  const map = new Map<string, string | null>();
  for (const item of items) {
    const object = item.inputObjectName;
    const alias = item.outputFieldName?.trim() ?? '';
    if (object === null || alias.length === 0 || item.disabled) continue;
    const key = alias.split(':')[0] ?? alias;
    const existing = map.get(key);
    if (existing === undefined) map.set(key, object);
    else if (existing !== object) map.set(key, null);
  }
  const out = new Map<string, string>();
  for (const [k, v] of map) if (v !== null) out.set(k, v);
  return out;
};
