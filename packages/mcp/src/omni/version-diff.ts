import { omnistudio } from '@sf-intelligence/extractors';

import type { OmniCitation } from './types.js';
import type { LoadedProcess } from './world.js';

/**
 * Semantic diff between two versions of one OmniScript / Integration
 * Procedure (spec F3): elements added, removed and RENAMED — same type, same
 * parent, same label key, different name — and, for every rename, each
 * reference in the newer version that still uses the OLD name (a show rule
 * or merge field the rename left pointing at nothing). Plus property changes
 * on elements present in both, over the settings that change behaviour.
 */

/** One element in a diff row. */
export interface DiffElement {
  readonly elementPath: string;
  readonly name: string;
  readonly type: string;
  readonly line: number | null;
}

/** A rename and the references it left behind. */
export interface DiffRename {
  readonly type: string;
  readonly parentPath: string;
  readonly labelKey: string | null;
  readonly from: DiffElement;
  readonly to: DiffElement;
  readonly staleReferences: readonly {
    readonly elementPath: string;
    readonly via: string;
    readonly reference: string;
    readonly line: number | null;
  }[];
}

/** A behaviour-relevant property change. */
export interface DiffChange {
  readonly elementPath: string;
  readonly type: string;
  readonly property: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** The diff result. */
export interface VersionDiff {
  readonly from: { readonly componentId: string; readonly versionNumber: number | null; readonly isActive: boolean };
  readonly to: { readonly componentId: string; readonly versionNumber: number | null; readonly isActive: boolean };
  readonly added: readonly DiffElement[];
  readonly removed: readonly DiffElement[];
  readonly renamed: readonly DiffRename[];
  readonly changed: readonly DiffChange[];
  readonly citations: readonly OmniCitation[];
}

/** Settings whose change alters behaviour (compared verbatim). */
const BEHAVIOUR_PROPS = [
  'show',
  'required',
  'readOnly',
  'mask',
  'pattern',
  'maxLength',
  'minLength',
  'options',
  'expression',
  'extraPayload',
  'integrationProcedureKey',
  'sendOnlyExtraPayload',
  'sendJSONPath',
  'sendJSONNode',
  'responseJSONPath',
  'responseJSONNode',
  'elementValueMap',
  'additionalInput',
  'executionConditionalFormula',
  'failOnStepError',
  'bundle',
  'remoteClass',
  'remoteMethod',
  'allowDelete',
  'allowEdit',
  'allowNew',
  'deleteIPKey',
  'deleteIPExtraPayload',
  'saveIPKey',
  'saveIPExtraPayload',
] as const;

const parentOf = (e: omnistudio.OmniTreeElement): string => e.path.slice(0, -1).join('/');

const asDiff = (e: omnistudio.OmniTreeElement): DiffElement => ({
  elementPath: e.idPath,
  name: e.name,
  type: e.type,
  line: e.line,
});

const labelOf = (e: omnistudio.OmniTreeElement): string | null => {
  const l = e.config?.['label'];
  return typeof l === 'string' && l.trim().length > 0 ? l : null;
};

const canon = (v: unknown): string => JSON.stringify(v ?? null);

/** Diff `older` → `newer`. */
export const diffVersions = (older: LoadedProcess, newer: LoadedProcess): VersionDiff => {
  const a = older.doc.elements;
  const b = newer.doc.elements;
  const byPathA = new Map(a.map((e) => [e.idPath, e]));
  const byPathB = new Map(b.map((e) => [e.idPath, e]));
  const removedRaw = a.filter((e) => !byPathB.has(e.idPath));
  const addedRaw = b.filter((e) => !byPathA.has(e.idPath));

  // Rename pairing: same type + parent + label key, distinct names, 1:1.
  const renamed: DiffRename[] = [];
  const usedAdded = new Set<string>();
  const usedRemoved = new Set<string>();
  for (const r of removedRaw) {
    const label = labelOf(r);
    const candidates = addedRaw.filter(
      (x) =>
        !usedAdded.has(x.idPath) &&
        x.type === r.type &&
        parentOf(x) === parentOf(r) &&
        labelOf(x) === label &&
        x.name !== r.name,
    );
    if (candidates.length !== 1) continue;
    const to = candidates[0] as omnistudio.OmniTreeElement;
    usedAdded.add(to.idPath);
    usedRemoved.add(r.idPath);
    renamed.push({ type: r.type, parentPath: parentOf(r), labelKey: label, from: asDiff(r), to: asDiff(to), staleReferences: [] });
  }

  // Stale references in the NEWER version that still use an old name.
  const withRefs = renamed.map((rn) => {
    const stale: { elementPath: string; via: string; reference: string; line: number | null }[] = [];
    for (const e of b) {
      const cfg = e.config;
      if (cfg === null) continue;
      for (const c of omnistudio.ruleConditions(omnistudio.parseShowRule(cfg['show']))) {
        if (omnistudio.segmentNames(omnistudio.parseKeyPath(c.field)).includes(rn.from.name)) {
          stale.push({ elementPath: e.idPath, via: `show.${c.at}.field`, reference: c.field, line: e.line });
        }
      }
      for (const site of omnistudio.stringSites(cfg)) {
        if (site.prop.startsWith('show.')) continue;
        for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
          if (omnistudio.segmentNames(ref.path).includes(rn.from.name)) {
            stale.push({ elementPath: e.idPath, via: site.prop, reference: ref.raw, line: e.line });
          }
        }
      }
    }
    return { ...rn, staleReferences: stale.sort((x, y) => (x.elementPath < y.elementPath ? -1 : x.elementPath > y.elementPath ? 1 : 0)) };
  });

  const changed: DiffChange[] = [];
  for (const e of b) {
    const old = byPathA.get(e.idPath);
    if (old === undefined) continue;
    if (old.type !== e.type) {
      changed.push({ elementPath: e.idPath, type: e.type, property: 'type', from: old.type, to: e.type });
    }
    for (const p of BEHAVIOUR_PROPS) {
      const x = old.config?.[p];
      const y = e.config?.[p];
      if (canon(x) !== canon(y)) changed.push({ elementPath: e.idPath, type: e.type, property: p, from: x ?? null, to: y ?? null });
    }
  }

  const head = (l: LoadedProcess): VersionDiff['from'] => ({
    componentId: l.node.id,
    versionNumber: l.doc.header.versionNumber,
    isActive: l.doc.header.isActive,
  });
  return {
    from: head(older),
    to: head(newer),
    added: addedRaw.filter((e) => !usedAdded.has(e.idPath)).map(asDiff),
    removed: removedRaw.filter((e) => !usedRemoved.has(e.idPath)).map(asDiff),
    renamed: withRefs,
    changed,
    citations: [
      { componentId: older.node.id, sourcePath: older.node.sourcePath },
      { componentId: newer.node.id, sourcePath: newer.node.sourcePath },
    ],
  };
};
