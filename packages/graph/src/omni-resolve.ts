import type { Edge, Node } from '@sf-intelligence/contracts';

/**
 * OmniStudio cross-reference resolution (import-time).
 *
 * Every OmniStudio caller names its target by a CALLABLE key, never by the
 * target's node id:
 *
 *   - an Integration Procedure Action (and an Edit Block's `saveIPKey` /
 *     `deleteIPKey`, and a FlexCard IP data source) names an IP by
 *     `integrationProcedureKey` = the IP's `omniProcessKey` (`Type_SubType`);
 *   - a DataRaptor action names a DataMapper by `bundle` = the mapper's `<name>`;
 *   - a FlexCard OmniScript action / an embedded OmniScript element names an
 *     OmniScript by `Type/SubType/Language`.
 *
 * The extractors key every node by its FILE stem, which carries the language
 * and version (`OmniIntegrationProcedure:Acme_Save_English_3`,
 * `OmniDataTransform:AcmeMap_1`). Templating the callable key onto the type
 * prefix therefore produced an id no node carries: every such edge was stamped
 * `targetMissing`, `get_component` on the short id returned a phantom stub with
 * a "retrieve it" remedy for a component that WAS retrieved, and impact /
 * dependency walks could not cross from a screen into its server code.
 *
 * This pass rewrites each DANGLING OmniStudio target onto the versioned node
 * that runs:
 *
 *   - OmniScript / Integration Procedure: the version whose `isActive` is true —
 *     the runtime switch for these two types. With no active version the
 *     highest version is linked and the edge says so (`no-active-version`), so
 *     the dependency stays walkable without claiming the call succeeds.
 *   - DataMapper: `active` is NOT a runtime switch (real orgs run mappers whose
 *     `active` is false), so a single version is linked as-is; among several,
 *     a single `active` one wins, else the highest version (`highest-version`).
 *
 * Honesty invariants (shared with the case-fold canonicalizers in `import.ts`):
 *   - Only DANGLING targets are touched; an exact node-id match is final.
 *   - A key nothing answers to stays dangling — absence is preserved, never
 *     invented.
 *   - The verbatim key survives as `properties.targetRawName`; the rule that
 *     picked the node is `properties.targetResolution`, and every other version
 *     answering to the key is listed in `properties.otherVersionIds`.
 *   - Deterministic: candidates are ordered by (versionNumber DESC, id ASC).
 *
 * INCREMENTAL caveat (same bound as the other canonicalizers): on the
 * apply-change-set path the pass sees only the change-set's node view, so a
 * target outside a SCOPED pull cannot anchor a remap until a full refresh.
 */

/** How a dangling OmniStudio target was resolved onto a versioned node. */
export type OmniTargetResolution =
  /** The key has exactly one version in the vault. */
  | 'only-version'
  /** Several versions; exactly one is active (OmniScript / IP / DataMapper). */
  | 'active-version'
  /** Several versions are active at once; the highest is linked. */
  | 'ambiguous-active'
  /** OmniScript / IP with no active version; the highest version is linked. */
  | 'no-active-version'
  /** DataMapper with several versions and no single active one. */
  | 'highest-version';

/** Which node property answered the caller's key. */
export type OmniTargetKeyKind = 'omniProcessKey' | 'dataMapperName' | 'omniScriptKey';

const IP_PREFIX = 'OmniIntegrationProcedure:';
const DM_PREFIX = 'OmniDataTransform:';
const OS_PREFIX = 'OmniScript:';

interface Candidate {
  readonly id: string;
  readonly isActive: boolean;
  readonly versionNumber: number;
}

const stringProp = (node: Node, key: string): string | null => {
  const v = node.properties[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const versionOf = (node: Node): number => {
  const v = node.properties['versionNumber'];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** Normalise a language for key comparison: `Multi-Language` ≡ `multiLanguage`. */
export const normOmniLanguage = (language: string): string =>
  language.replace(/[\s_-]/g, '').toLowerCase();
const normLanguage = normOmniLanguage;

/**
 * The separator of an OmniScript key written `Type/SubType/Language` (a
 * FlexCard's `omniType.Name`, an embedded OmniScript, a tool selector). A key
 * separator — `/` on every platform — not a file-path separator.
 */
const OMNI_KEY_SEPARATOR = '/';

/** `Type/SubType/Language` → its trimmed parts, or null for any other shape. */
export const parseOmniScriptKey = (
  raw: string,
): { readonly type: string; readonly subType: string; readonly language: string } | null => {
  const parts = raw.split(OMNI_KEY_SEPARATOR);
  if (parts.length !== 3) return null;
  const [type, subType, language] = parts as [string, string, string];
  return { type: type.trim(), subType: subType.trim(), language: language.trim() };
};

const pushKey = (
  index: Map<string, Candidate[]>,
  key: string | null,
  candidate: Candidate,
): void => {
  if (key === null) return;
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [candidate]);
  else if (!bucket.some((c) => c.id === candidate.id)) bucket.push(candidate);
};

/** Candidate order: highest version first, then id ascending. */
const byVersionDesc = (a: Candidate, b: Candidate): number =>
  b.versionNumber !== a.versionNumber
    ? b.versionNumber - a.versionNumber
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;

interface Pick {
  readonly id: string;
  readonly resolution: OmniTargetResolution;
  readonly others: readonly string[];
  readonly ambiguousActive: readonly string[];
}

/**
 * Pick the runtime target among the versions answering to one key.
 * `activeIsRuntimeSwitch` is true for OmniScript / IP and false for
 * DataMapper (see the module header).
 */
export const pickOmniVersion = (
  candidates: readonly Candidate[],
  activeIsRuntimeSwitch: boolean,
): Pick | null => {
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort(byVersionDesc);
  const others = (chosen: string): string[] =>
    ordered.map((c) => c.id).filter((id) => id !== chosen).sort();
  const first = ordered[0] as Candidate;
  if (ordered.length === 1) {
    if (activeIsRuntimeSwitch && !first.isActive) {
      return { id: first.id, resolution: 'no-active-version', others: [], ambiguousActive: [] };
    }
    return { id: first.id, resolution: 'only-version', others: [], ambiguousActive: [] };
  }
  const active = ordered.filter((c) => c.isActive);
  if (active.length === 1) {
    const only = active[0] as Candidate;
    return { id: only.id, resolution: 'active-version', others: others(only.id), ambiguousActive: [] };
  }
  if (active.length > 1) {
    const top = active[0] as Candidate;
    return {
      id: top.id,
      resolution: 'ambiguous-active',
      others: others(top.id),
      ambiguousActive: active.map((c) => c.id).sort(),
    };
  }
  return {
    id: first.id,
    resolution: activeIsRuntimeSwitch ? 'no-active-version' : 'highest-version',
    others: others(first.id),
    ambiguousActive: [],
  };
};

interface OmniIndexes {
  readonly ipByKey: Map<string, Candidate[]>;
  readonly dmByName: Map<string, Candidate[]>;
  readonly osByKey: Map<string, Candidate[]>;
}

/**
 * Index every OmniStudio node under each callable key it answers to. Exported
 * so read-side tools resolve a key with the SAME rule the import used.
 */
export const buildOmniIndexes = (nodes: readonly Node[]): OmniIndexes => {
  const ipByKey = new Map<string, Candidate[]>();
  const dmByName = new Map<string, Candidate[]>();
  const osByKey = new Map<string, Candidate[]>();
  for (const node of nodes) {
    if (
      node.type !== 'OmniIntegrationProcedure' &&
      node.type !== 'OmniDataTransform' &&
      node.type !== 'OmniScript'
    ) {
      continue;
    }
    const isActive =
      node.type === 'OmniDataTransform'
        ? node.properties['active'] === true
        : node.properties['isActive'] === true;
    const candidate: Candidate = { id: node.id, isActive, versionNumber: versionOf(node) };
    if (node.type === 'OmniDataTransform') {
      pushKey(dmByName, stringProp(node, 'name'), candidate);
      continue;
    }
    const type = stringProp(node, 'type');
    const subType = stringProp(node, 'subType');
    const language = stringProp(node, 'language');
    const typeSub = type !== null && subType !== null ? `${type}_${subType}` : null;
    if (node.type === 'OmniIntegrationProcedure') {
      const processKey = stringProp(node, 'omniProcessKey');
      pushKey(ipByKey, processKey ?? typeSub, candidate);
      // A caller spelling the key from Type + SubType must reach the same
      // node even when the file's omniProcessKey is blank (stub exports).
      if (processKey !== null && typeSub !== null && processKey !== typeSub) {
        pushKey(ipByKey, typeSub, candidate);
      }
      continue;
    }
    // OmniScript: callers use `Type/SubType/Language` (FlexCard omniType.Name,
    // embedded OmniScript elements) or the underscore form.
    if (type !== null && subType !== null && language !== null) {
      pushKey(osByKey, `${type}/${subType}/${normLanguage(language)}`, candidate);
      pushKey(osByKey, `${type}_${subType}_${normLanguage(language)}`, candidate);
    }
  }
  return { ipByKey, dmByName, osByKey };
};

/** Normalise an OmniScript caller key into the indexed form. */
const osLookupKeys = (raw: string): string[] => {
  const key = parseOmniScriptKey(raw);
  if (key !== null) return [`${key.type}/${key.subType}/${normLanguage(key.language)}`];
  const parts = raw.split('_');
  if (parts.length >= 3) {
    const language = parts[parts.length - 1] as string;
    return [`${parts.slice(0, -1).join('_')}_${normLanguage(language)}`];
  }
  return [];
};

interface Resolved {
  readonly pick: Pick;
  readonly keyKind: OmniTargetKeyKind;
}

const resolveDangling = (toId: string, idx: OmniIndexes): Resolved | null => {
  if (toId.startsWith(IP_PREFIX)) {
    const pick = pickOmniVersion(idx.ipByKey.get(toId.slice(IP_PREFIX.length)) ?? [], true);
    return pick === null ? null : { pick, keyKind: 'omniProcessKey' };
  }
  if (toId.startsWith(DM_PREFIX)) {
    const pick = pickOmniVersion(idx.dmByName.get(toId.slice(DM_PREFIX.length)) ?? [], false);
    return pick === null ? null : { pick, keyKind: 'dataMapperName' };
  }
  if (toId.startsWith(OS_PREFIX)) {
    for (const key of osLookupKeys(toId.slice(OS_PREFIX.length))) {
      const pick = pickOmniVersion(idx.osByKey.get(key) ?? [], true);
      if (pick !== null) return { pick, keyKind: 'omniScriptKey' };
    }
  }
  return null;
};

/**
 * Rewrite every dangling OmniStudio edge target onto the versioned node that
 * answers to its callable key. Mutates `edges` in place (same contract as the
 * canonicalizers in `import.ts`). See the module header for the rules.
 */
export const canonicalizeOmniStudioEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  const nodeIds = new Set<string>();
  for (const node of nodes) nodeIds.add(node.id);
  let idx: OmniIndexes | null = null;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (edge === undefined) continue;
    const { toId } = edge;
    if (
      !toId.startsWith(IP_PREFIX) &&
      !toId.startsWith(DM_PREFIX) &&
      !toId.startsWith(OS_PREFIX)
    ) {
      continue;
    }
    if (nodeIds.has(toId)) continue;
    idx ??= buildOmniIndexes(nodes);
    const resolved = resolveDangling(toId, idx);
    if (resolved === null) continue;
    const { pick, keyKind } = resolved;
    const rawName = toId.slice(toId.indexOf(':') + 1);
    edges[i] = {
      ...edge,
      toId: pick.id as Edge['toId'],
      properties: {
        ...edge.properties,
        targetRawName:
          typeof edge.properties['targetRawName'] === 'string'
            ? edge.properties['targetRawName']
            : rawName,
        resolvedTargetBy: keyKind,
        targetResolution: pick.resolution,
        ...(pick.others.length > 0 ? { otherVersionIds: pick.others } : {}),
        ...(pick.ambiguousActive.length > 0
          ? { ambiguousActiveIds: pick.ambiguousActive }
          : {}),
      },
    };
  }
};
