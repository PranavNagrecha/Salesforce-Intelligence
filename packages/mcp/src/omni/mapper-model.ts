import { omnistudio } from '@sf-intelligence/extractors';

import type { LoadedMapper } from './world.js';

/**
 * The DataMapper model: which input keys each item reads and where it writes.
 *
 *   - Transform (JSON → JSON) is a WHITELIST: a key survives only if an item's
 *     `inputFieldName` matches it EXACTLY (raw), or names a container it sits
 *     in (the whole subtree is copied). Anything else is dropped.
 *   - Load (JSON → SObject) writes `outputObjectName.outputFieldName`.
 *   - Extract (SObject → JSON) reads records; its input keys only feed the
 *     extract steps' filters.
 *   - Formula items compute `formulaResultPath` from the keys their
 *     `formulaExpression` reads; later items may read that result.
 */

/** One item with its paths parsed. */
export interface MapperItem {
  readonly item: omnistudio.DataMapperItem;
  /** `inputFieldName` names (row markers stripped), or null. */
  readonly input: readonly string[] | null;
  /** `outputFieldName` names, or null. */
  readonly output: readonly string[] | null;
  readonly jsonOutput: boolean;
  /** Paths read by `formulaExpression`. */
  readonly formulaReads: readonly (readonly string[])[];
  /** `formulaResultPath` names, or null. */
  readonly formulaResult: readonly string[] | null;
}

/** The built model. */
export interface MapperModel {
  readonly loaded: LoadedMapper;
  readonly componentId: string;
  readonly uniqueName: string;
  readonly sourcePath: string;
  readonly kind: omnistudio.DataMapperKind;
  /** Enabled items only, in document order. */
  readonly items: readonly MapperItem[];
  /** Extract alias → SObject. */
  readonly aliases: ReadonlyMap<string, string>;
}

const names = (raw: string | null): readonly string[] | null =>
  raw === null || raw.trim().length === 0 ? null : omnistudio.segmentNames(omnistudio.parseKeyPath(raw));

/** Build the model of one loaded DataMapper. */
export const buildMapperModel = (loaded: LoadedMapper): MapperModel => {
  const items: MapperItem[] = [];
  for (const item of loaded.doc.items) {
    if (item.disabled) continue;
    const formulaReads =
      item.formulaExpression === null
        ? []
        : omnistudio.scanPercentRefs(item.formulaExpression).refs.map((r) => omnistudio.segmentNames(r.path));
    items.push({
      item,
      input: names(item.inputFieldName),
      output: names(item.outputFieldName),
      jsonOutput: omnistudio.isJsonOutputObject(item.outputObjectName),
      formulaReads,
      formulaResult: names(item.formulaResultPath),
    });
  }
  return {
    loaded,
    componentId: loaded.node.id,
    uniqueName: loaded.doc.header.uniqueName ?? loaded.node.apiName,
    sourcePath: loaded.node.sourcePath,
    kind: loaded.doc.header.kind,
    items,
    aliases: omnistudio.extractAliases(loaded.doc.items),
  };
};

/** One output an input key reaches through a Transform / Load. */
export interface MapperHit {
  readonly item: MapperItem;
  /** How the item consumed the key. */
  readonly via: 'exact' | 'container' | 'formula';
  /** The output path (Transform: JSON path; Load: the field name). */
  readonly out: readonly string[];
}

const eq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Where input key `q` goes in a Transform or Load: exact item matches, items
 * that copy a container `q` sits in (the rest of the path is preserved), and
 * formula items that read `q` (their result path, then any item reading THAT).
 */
export const mapperHits = (model: MapperModel, q: readonly string[]): readonly MapperHit[] => {
  const hits: MapperHit[] = [];
  for (const it of model.items) {
    if (it.input === null || it.output === null) continue;
    if (eq(it.input, q)) hits.push({ item: it, via: 'exact', out: it.output });
    else if (it.input.length < q.length && omnistudio.isPrefixOf(it.input, q)) {
      hits.push({ item: it, via: 'container', out: [...it.output, ...q.slice(it.input.length)] });
    }
  }
  // Formula items: result path is derived from q; follow items that read it.
  for (const it of model.items) {
    if (it.formulaResult === null) continue;
    if (!it.formulaReads.some((r) => eq(r, q) || omnistudio.isPrefixOf(r, q))) continue;
    const result = it.formulaResult;
    for (const reader of model.items) {
      if (reader.input === null || reader.output === null) continue;
      if (eq(reader.input, result)) hits.push({ item: reader, via: 'formula', out: reader.output });
    }
  }
  return hits;
};

/** Every item input path (match form), for near-miss suggestions. */
export const itemInputForms = (model: MapperModel): readonly string[] =>
  [...new Set(model.items.filter((i) => i.input !== null).map((i) => (i.input as readonly string[]).join(':')))].sort();

/**
 * Extract: does input key `q` feed a filter? A `filterValue` that is not a
 * quoted literal or a number names an input key — unless its first segment is
 * an extract alias (it then reads a previous step's record).
 */
export const extractFilterUses = (model: MapperModel, q: readonly string[]): readonly MapperItem[] =>
  model.items.filter((it) => {
    const v = it.item.filterValue;
    if (v === null || it.item.inputObjectName === null) return false;
    const t = v.trim();
    if (/^['"].*['"]$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t.length === 0) return false;
    const path = omnistudio.segmentNames(omnistudio.parseKeyPath(t));
    if (path.length > 1 && model.aliases.has(path[0] as string)) return false;
    return eq(path, q);
  });
