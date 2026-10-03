import { basename, dirname } from 'node:path';

import { canonicalElementType } from './catalog.js';
import { type DataPackRead, dataPackKindOfDir, dataPackToProcess } from './datapack.js';
import {
  type JsonBlob,
  parseJsonBlob,
  parseOmniXml,
  rawText,
  scanBlockNameLines,
  toArray,
  trimmedText,
  xmlBool,
  xmlNumber,
} from './xml.js';

/**
 * Parse an OmniScript (`*.os-meta.xml`) or Integration Procedure
 * (`*.oip-meta.xml`) into the element TREE the runtime executes.
 *
 * Two facts about the retrieved XML drive the shape:
 *   - Elements nest: every `<omniProcessElements>` block may hold any number of
 *     `<childElements>` blocks, recursively. A flat scan sees only the top
 *     level (a 196-element script exposes 29).
 *   - The XML lists siblings ALPHABETICALLY; the runtime order is each
 *     element's `sequenceNumber` within its parent. `children` is re-sorted by
 *     sequence (document order breaks ties) so every consumer walks the script
 *     the way the runtime does.
 *
 * Names are kept RAW — a leading or trailing space in an element name is a
 * defect the model must be able to report, so nothing is trimmed.
 */

/** Which process file this is. */
export type OmniProcessKind = 'OmniScript' | 'IntegrationProcedure';

/** The file-level identity of a process. */
export interface OmniProcessHeader {
  readonly kind: OmniProcessKind;
  readonly name: string | null;
  readonly uniqueName: string | null;
  readonly type: string | null;
  readonly subType: string | null;
  readonly language: string | null;
  readonly versionNumber: number | null;
  /** The runtime switch for OmniScripts and IPs. */
  readonly isActive: boolean;
  /** `Type_SubType` for an IP (the key callers invoke); null for most OmniScripts. */
  readonly omniProcessKey: string | null;
  readonly description: string | null;
  readonly isWebCompEnabled: boolean;
  readonly propertySetConfig: Readonly<Record<string, unknown>> | null;
}

/** One element of the process tree. */
export interface OmniTreeElement {
  /** Exactly as written (untrimmed). */
  readonly name: string;
  /** The element type exactly as the metadata spells it (`Step`, `Radio`, `Remote Action`, …), trimmed. */
  readonly type: string;
  /**
   * The catalog's canonical type for `type` (`omnistudio/catalog.ts`): an
   * alternative spelling (`Data Mapper Extract Action`) maps to the type the
   * engine reasons about (`DataRaptor Extract Action`); a type the catalog
   * does not list is `type` itself. Logic compares this; output shows `type`.
   */
  readonly canonicalType: string;
  readonly level: number | null;
  /** `sequenceNumber`; 0 when absent. Runtime order within the parent. */
  readonly sequence: number;
  readonly isActive: boolean;
  /** The parsed `propertySetConfig` — the element's real settings. */
  readonly config: Readonly<Record<string, unknown>> | null;
  /** Why `config` is null despite a non-empty blob, else null. */
  readonly configError: string | null;
  /**
   * Names from the root to this element, inclusive. Sibling names are unique
   * in valid metadata; a duplicate gets a `~2` (`~3`, …) suffix in `idPath`
   * so ids stay unique while `path` keeps the raw names.
   */
  readonly path: readonly string[];
  /** `path` joined with `/`, de-duplicated — the element-id suffix. */
  readonly idPath: string;
  /** 1-based line of the element's `<name>` in the source file, when found. */
  readonly line: number | null;
  /** Pre-order position in the source document (stable tie-breaker). */
  readonly documentIndex: number;
  /** Children in RUNTIME order (sequence, then document order). */
  readonly children: readonly OmniTreeElement[];
}

/** A parsed process file. */
export interface OmniProcessDoc {
  readonly header: OmniProcessHeader;
  /** Top-level elements in runtime order. */
  readonly roots: readonly OmniTreeElement[];
  /** Every element, pre-order over the RUNTIME tree. */
  readonly elements: readonly OmniTreeElement[];
  /** Per-element parse problems (malformed `propertySetConfig`, …). */
  readonly warnings: readonly string[];
}

/** Parse result. */
export type OmniProcessParse =
  | { readonly ok: true; readonly doc: OmniProcessDoc }
  | { readonly ok: false; readonly message: string };

const ELEMENT_BLOCK_TAGS = ['omniProcessElements', 'childElements'] as const;

interface RawElement {
  readonly obj: Record<string, unknown>;
  readonly documentIndex: number;
  readonly children: RawElement[];
}

/** Collect the raw element objects in document pre-order. */
const collectRaw = (list: unknown, counter: { n: number }): RawElement[] => {
  const out: RawElement[] = [];
  for (const entry of toArray(list)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const documentIndex = counter.n;
    counter.n += 1;
    const children = collectRaw(obj['childElements'], counter);
    out.push({ obj, documentIndex, children });
  }
  return out;
};

/**
 * Parse `xmlText` as an OmniScript or Integration Procedure. The kind is
 * decided by the root element; `<OmniScript>` with
 * `<isIntegrationProcedure>true` (a legacy unified export) is treated as an IP.
 */
export const parseOmniProcess = (xmlText: string): OmniProcessParse => {
  const isIpRoot = /<OmniIntegrationProcedure[\s>]/.test(xmlText);
  const parsed = parseOmniXml(xmlText, isIpRoot ? 'OmniIntegrationProcedure' : 'OmniScript');
  if (!parsed.ok) return parsed;
  const lineBlocks = scanBlockNameLines(xmlText, ELEMENT_BLOCK_TAGS);
  return {
    ok: true,
    doc: buildOmniProcessDoc(parsed.root, isIpRoot, (name, documentIndex) => {
      const block = lineBlocks[documentIndex];
      return block !== undefined && block.name === name ? block.line : null;
    }),
  };
};

/**
 * Parse a managed-package (Vlocity) OmniScript / Integration Procedure
 * DataPack into the same document — element lines point into its main file.
 */
export const parseOmniProcessDataPack = (dp: DataPackRead): OmniProcessParse => {
  const conv = dataPackToProcess(dp, dataPackKindOfDir(basename(dirname(dirname(dp.mainPath)))));
  if (!conv.ok) return { ok: false, message: conv.message };
  return {
    ok: true,
    doc: buildOmniProcessDoc(conv.value.root, conv.value.kind === 'IntegrationProcedure', (name) => conv.value.elementLine(name.trim())),
  };
};

/**
 * Build the document from a parsed process root (the `<OmniScript>` /
 * `<OmniIntegrationProcedure>` object). `lineOf` gives an element's source line.
 */
export const buildOmniProcessDoc = (
  root: Readonly<Record<string, unknown>>,
  isIpRoot: boolean,
  lineOf: (name: string, documentIndex: number) => number | null,
): OmniProcessDoc => {
  const kind: OmniProcessKind =
    isIpRoot || xmlBool(root['isIntegrationProcedure']) ? 'IntegrationProcedure' : 'OmniScript';

  const warnings: string[] = [];
  const topConfig = parseJsonBlob(root['propertySetConfig']);
  if (topConfig.error !== null) {
    warnings.push(`top-level propertySetConfig is not valid JSON: ${topConfig.error}`);
  }
  const header: OmniProcessHeader = {
    kind,
    name: trimmedText(root['name']),
    uniqueName: trimmedText(root['uniqueName']),
    type: trimmedText(root['type']),
    subType: trimmedText(root['subType']),
    language: trimmedText(root['language']),
    versionNumber: xmlNumber(root['versionNumber']),
    isActive: xmlBool(root['isActive']),
    omniProcessKey: trimmedText(root['omniProcessKey']),
    description: trimmedText(root['description']),
    isWebCompEnabled: xmlBool(root['isWebCompEnabled']),
    propertySetConfig: topConfig.value,
  };

  const raw = collectRaw(root['omniProcessElements'], { n: 0 });

  const elements: OmniTreeElement[] = [];
  const build = (list: readonly RawElement[], parentPath: readonly string[], parentIdPath: string): OmniTreeElement[] => {
    const sorted = [...list].sort((a, b) => {
      const sa = xmlNumber(a.obj['sequenceNumber']) ?? 0;
      const sb = xmlNumber(b.obj['sequenceNumber']) ?? 0;
      return sa !== sb ? sa - sb : a.documentIndex - b.documentIndex;
    });
    const seen = new Map<string, number>();
    const built: OmniTreeElement[] = [];
    for (const r of sorted) {
      const name = rawText(r.obj['name']) ?? '';
      const type = trimmedText(r.obj['type']) ?? '';
      const config: JsonBlob = parseJsonBlob(r.obj['propertySetConfig']);
      const path = [...parentPath, name];
      const dup = (seen.get(name) ?? 0) + 1;
      seen.set(name, dup);
      const segment = dup === 1 ? name : `${name}~${dup}`;
      const idPath = parentIdPath.length === 0 ? segment : `${parentIdPath}/${segment}`;
      if (config.error !== null) {
        warnings.push(`propertySetConfig of ${idPath} is not valid JSON: ${config.error}`);
      }
      const line = lineOf(name, r.documentIndex);
      // Pre-order over the runtime tree: push self before building children.
      const placeholderIndex = elements.length;
      elements.push(undefined as unknown as OmniTreeElement);
      const children = build(r.children, path, idPath);
      const element: OmniTreeElement = {
        name,
        type,
        canonicalType: canonicalElementType(type),
        level: xmlNumber(r.obj['level']),
        sequence: xmlNumber(r.obj['sequenceNumber']) ?? 0,
        isActive: xmlBool(r.obj['isActive']),
        config: config.value,
        configError: config.error,
        path,
        idPath,
        line,
        documentIndex: r.documentIndex,
        children,
      };
      elements[placeholderIndex] = element;
      built.push(element);
    }
    return built;
  };
  const roots = build(raw, [], '');
  return { header, roots, elements, warnings };
};

/** Every element whose ancestor chain contains `ancestor` (excluding it). */
export const descendantsOf = (element: OmniTreeElement): OmniTreeElement[] => {
  const out: OmniTreeElement[] = [];
  const walk = (e: OmniTreeElement): void => {
    for (const c of e.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(element);
  return out;
};
