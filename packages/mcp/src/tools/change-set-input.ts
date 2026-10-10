/**
 * Change-set input parsing for the deploy gate — ONE module shared by the MCP
 * `sfi.review_change` tool and the `sfi review-change` CLI.
 *
 * A user holds a change set in one of three shapes: a `package.xml` (or a
 * `destructiveChanges.xml`), a list of changed source files (`force-app/…`,
 * optionally `git diff --name-status` lines), or a list of component names.
 * The parsers below turn each shape into the same `ChangeComponent` rows:
 *
 *   - the path → TYPE mapping is the refresh walker's own dispatcher
 *     (`dispatchSourceFile`), and the container-file set comes from the same
 *     module, so a family added to the walker is understood here too;
 *   - the manifest `<name>` → vault type mapping is the INVERSE of
 *     `export_manifest`'s drift-tested `METADATA_API_NAME` table, not a copy.
 *
 * The api NAME derived from a path here is a best effort for files the vault
 * does not hold yet (an added component). For a file the vault DOES hold, the
 * MCP assembler (`review-change-assembly.ts`) replaces it with the id of the
 * node built from that same source file, which is exact for every family.
 *
 * Nothing here guesses silently: wildcard manifest members, container files,
 * unmodelled metadata and malformed XML come back as named entries the caller
 * discloses — and a deploy gate must never call those `go`.
 */

import { splitPathSegments } from '@sf-intelligence/core';
import {
  BUNDLE_PARENT_DIRS,
  CONTAINER_FILE_TYPES,
  dispatchSourceFile,
} from '@sf-intelligence/extractors';
import { XMLParser } from 'fast-xml-parser';

import { METADATA_API_NAME, SETTINGS_MEMBER_NAME } from './export-manifest.js';

/** The three change kinds the deploy gate understands. */
export type ChangeSetKind = 'added' | 'modified' | 'deleted';

/** One assembled change-set entry. */
export interface ChangeComponent {
  readonly type: string;
  readonly apiName: string;
  readonly changeKind: ChangeSetKind;
  /**
   * The changed source file this row came from, when the api name was DERIVED
   * from a file name (not a bundle directory). The MCP assembler looks the
   * file up in the vault to get the exact id the extractor gave it.
   */
  readonly sourcePath?: string;
}

/** Something the change set names that cannot be reviewed as one component. */
export interface UnreviewableEntry {
  /** The path, or `ManifestType:member`, exactly as named. */
  readonly input: string;
  /**
   * `container` — one file / manifest member that holds many components
   * (labels, sharing rules, workflow rules…); `not-modeled` — metadata the
   * vault does not model, so nothing about it can be checked.
   */
  readonly reason: 'container' | 'not-modeled';
  /** The vault type a container fans out into. */
  readonly containerType?: string;
  readonly changeKind: ChangeSetKind;
}

/** Coerce a fast-xml-parser value that may be a scalar, array, or absent to an array. */
const toArray = <T>(value: T | readonly T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as T];

// ---------------------------------------------------------------------------
// Manifest <name> → vault type, derived from export_manifest's table
// ---------------------------------------------------------------------------

/** Vault type → the manifest `<name>` of the per-object/org FILE that holds it. */
const containerManifestName = (vaultType: string): string | undefined =>
  // CustomLabel deploys individually as `CustomLabel`, and as a whole file as
  // `CustomLabels` — the one container whose name the export table does not
  // carry (export_manifest emits the individual form).
  vaultType === 'CustomLabel' ? 'CustomLabels' : METADATA_API_NAME[vaultType];

/** Manifest `<name>` of a container file → the vault type it fans out into. */
const MANIFEST_CONTAINER_TYPES: ReadonlyMap<string, string> = new Map(
  [...CONTAINER_FILE_TYPES]
    .map((t) => [containerManifestName(t), t] as const)
    .filter((e): e is readonly [string, typeof e[1]] => e[0] !== undefined && e[0] !== e[1]),
);

/**
 * Manifest `<name>` → vault type: the inverse of `METADATA_API_NAME` for the
 * one-to-one entries. `Settings` (many-to-one) and the container names are
 * handled separately.
 */
const MANIFEST_TO_VAULT_TYPE: ReadonlyMap<string, string> = (() => {
  const byName = new Map<string, string[]>();
  for (const [vaultType, name] of Object.entries(METADATA_API_NAME)) {
    byName.set(name, [...(byName.get(name) ?? []), vaultType]);
  }
  const out = new Map<string, string>();
  for (const [name, types] of byName) {
    if (types.length === 1 && !MANIFEST_CONTAINER_TYPES.has(name)) out.set(name, types[0] ?? name);
  }
  // Child manifest types of a container whose vault node is one rule: the
  // sharing-rule sub-kinds all land on `SharingRule`, and a workflow outbound
  // message is modelled as `OutboundMessage`.
  for (const child of [
    'SharingCriteriaRule',
    'SharingOwnerRule',
    'SharingGuestRule',
    'SharingTerritoryRule',
  ]) {
    out.set(child, 'SharingRule');
  }
  out.set('WorkflowOutboundMessage', 'OutboundMessage');
  return out;
})();

/** `Settings` member (`Security`) → the vault singleton types it deploys. */
const SETTINGS_MEMBER_TO_TYPES: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [vaultType, member] of Object.entries(SETTINGS_MEMBER_NAME)) {
    out.set(member, [...(out.get(member) ?? []), vaultType]);
  }
  return out;
})();

/** The vault id of an org-level settings singleton is `{Type}:default`. */
const SETTINGS_SINGLETON_NAME = 'default';

/**
 * Map one manifest `<types><name>` + `<members>` to vault components, or to an
 * unreviewable entry (a container member, an unmodelled `Settings` file).
 *
 * @example
 *   manifestMemberToVault('ApexPage', 'Retention', 'deleted')
 *   // => { components: [{ type: 'VisualforcePage', apiName: 'Retention', changeKind: 'deleted' }] }
 *   manifestMemberToVault('Layout', 'Account-Account Layout', 'modified')
 *   // => { components: [{ type: 'Layout', apiName: 'Account.Account Layout', … }] }
 */
export const manifestMemberToVault = (
  manifestType: string,
  member: string,
  changeKind: ChangeSetKind,
): { readonly components: readonly ChangeComponent[]; readonly unreviewable?: UnreviewableEntry } => {
  const input = `${manifestType}:${member}`;
  const container = MANIFEST_CONTAINER_TYPES.get(manifestType);
  if (container !== undefined) {
    return { components: [], unreviewable: { input, reason: 'container', containerType: container, changeKind } };
  }
  if (manifestType === 'Settings') {
    const types = SETTINGS_MEMBER_TO_TYPES.get(member) ?? [];
    if (types.length === 0) {
      return { components: [], unreviewable: { input, reason: 'not-modeled', changeKind } };
    }
    return {
      components: types.map((type) => ({ type, apiName: SETTINGS_SINGLETON_NAME, changeKind })),
    };
  }
  const type = MANIFEST_TO_VAULT_TYPE.get(manifestType) ?? manifestType;
  // A Layout member is `{Object}-{Layout Name}`; the vault id is
  // `{Object}.{Layout Name}`. An object api name never contains `-`, so the
  // FIRST hyphen is the separator.
  const apiName = type === 'Layout' ? member.replace('-', '.') : member;
  return { components: [{ type, apiName, changeKind }] };
};

/** Result of parsing one manifest body. */
export interface ParsedManifest {
  /** Members mapped to vault types / id shapes. */
  readonly components: readonly ChangeComponent[];
  /** Types listed with a `*` member — not enumerable offline, so not reviewed. */
  readonly wildcardTypes: readonly string[];
  /** Container members and unmodelled settings — named, NOT reviewed. */
  readonly unreviewable: readonly UnreviewableEntry[];
  /** True when the body has no `<Package>` root (not a manifest at all). */
  readonly notAManifest: boolean;
}

/**
 * Parse a `package.xml` / `destructiveChanges.xml` body. Every `<members>`
 * under a `<types><name>` is mapped to its vault component
 * ({@link manifestMemberToVault}) with `changeKind`. A manifest names WHICH
 * components a deploy touches but not HOW, so `package.xml` members default to
 * `modified` (the caller discloses that); a `destructiveChanges*.xml` body is
 * parsed with `'deleted'`. Wildcards, containers and unmodelled members are
 * returned for disclosure, never silently dropped.
 *
 * @example
 *   parseManifestComponents('<Package><types><members>Acme</members>' +
 *     '<name>ApexClass</name></types></Package>').components
 *   // => [{ type: 'ApexClass', apiName: 'Acme', changeKind: 'modified' }]
 */
export const parseManifestComponents = (
  xml: string,
  changeKind: ChangeSetKind = 'modified',
): ParsedManifest => {
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const empty = { components: [], wildcardTypes: [], unreviewable: [], notAManifest: true };
  let parsed: { Package?: { types?: unknown } } | undefined;
  try {
    parsed = parser.parse(xml) as { Package?: { types?: unknown } };
  } catch {
    return empty;
  }
  if (parsed?.Package === undefined) return empty;
  const typesBlocks = toArray(parsed.Package.types) as ReadonlyArray<{
    name?: unknown;
    members?: unknown;
  }>;
  const components: ChangeComponent[] = [];
  const wildcardTypes: string[] = [];
  const unreviewable: UnreviewableEntry[] = [];
  for (const block of typesBlocks) {
    const name = typeof block.name === 'string' ? block.name.trim() : '';
    if (name === '') continue;
    for (const rawMember of toArray(block.members as string | string[] | undefined)) {
      const member = String(rawMember).trim();
      if (member === '') continue;
      if (member === '*') {
        if (!wildcardTypes.includes(name)) wildcardTypes.push(name);
        continue;
      }
      const mapped = manifestMemberToVault(name, member, changeKind);
      components.push(...mapped.components);
      if (mapped.unreviewable !== undefined) unreviewable.push(mapped.unreviewable);
    }
  }
  return { components, wildcardTypes, unreviewable, notAManifest: false };
};

// ---------------------------------------------------------------------------
// Source paths
// ---------------------------------------------------------------------------

/** The companion-metadata suffix (`Foo.cls-meta.xml`, `Foo.layout-meta.xml`). */
const SIDECAR_SUFFIX = '-meta.xml';

/**
 * The component name inside a file name: drop the `-meta.xml` sidecar suffix,
 * then the type extension (`.cls`, `.quickAction`, `.md`). Only the LAST dot
 * goes — `Case.SendEmail.quickAction-meta.xml` names `Case.SendEmail`.
 */
const fileStem = (fileName: string): string => {
  const base = fileName.endsWith(SIDECAR_SUFFIX)
    ? fileName.slice(0, -SIDECAR_SUFFIX.length)
    : fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

/** What a changed path names, before any vault lookup. */
interface DerivedPath {
  readonly type: string;
  readonly apiName: string;
  /** The file holds many components; `apiName` names the FILE. */
  readonly container: boolean;
  /**
   * The file the refresh walker dispatches for this component (a sidecar-only
   * change points at its primary file) — set when `apiName` came from a file
   * name, i.e. not a bundle / resource directory.
   */
  readonly filePath?: string;
}

/**
 * Derive the `{ type, apiName }` a source-tree path resolves to, using the
 * refresh walker's dispatcher for the TYPE and the extractors' id shapes for
 * the name. Returns null for a path that is not a recognised metadata source
 * file.
 *
 * `container` is true when the file holds MANY components (labels, sharing
 * rules, workflow rules…): its `apiName` then names the FILE, not a component.
 * Bundles: a diff reports FILES inside `lwc/{bundle}/`; the graph models the
 * bundle as ONE component, so every such file collapses to the bundle.
 */
const classifySourcePath = (relPath: string): DerivedPath | null => {
  const segments = splitPathSegments(relPath);
  if (segments.length === 0) return null;

  for (const bundleDir of BUNDLE_PARENT_DIRS) {
    const idx = segments.indexOf(bundleDir);
    if (idx !== -1 && idx + 1 < segments.length) {
      const bundleName = segments[idx + 1];
      if (bundleName === undefined || bundleName === '') continue;
      const type = dispatchSourceFile(segments.slice(0, idx + 1), bundleName, true);
      if (type !== null) return { type, apiName: bundleName, container: false };
    }
  }
  // A static resource is its sidecar plus a payload: a single file
  // (`staticresources/Logo.png`) or a whole folder (`staticresources/Site/…`).
  // Any of them changes the one `StaticResource:{name}`.
  const srIdx = segments.indexOf('staticresources');
  if (srIdx !== -1 && srIdx + 1 < segments.length) {
    const head = segments[srIdx + 1] ?? '';
    const name = head.split('.')[0] ?? '';
    if (name !== '') return { type: 'StaticResource', apiName: name, container: false };
  }

  const fileName = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  let dispatched = fileName;
  let type = dispatchSourceFile(dirs, fileName, false);
  if (type === null && fileName.endsWith(SIDECAR_SUFFIX)) {
    // A code file's sidecar (`Foo.cls-meta.xml`) is not dispatched on its own —
    // the walker reads it through the primary file. A diff that touches ONLY
    // the sidecar (an API version bump) still changes that component.
    const primary = fileName.slice(0, -SIDECAR_SUFFIX.length);
    const primaryType = dispatchSourceFile(dirs, primary, false);
    if (primaryType !== null) {
      dispatched = primary;
      type = primaryType;
    }
  } else if (type === null) {
    // The reverse: a payload file whose SIDECAR is what the walker dispatches
    // (an email template body `Folder/T.email` beside `T.email-meta.xml`).
    dispatched = `${fileName}${SIDECAR_SUFFIX}`;
    type = dispatchSourceFile(dirs, dispatched, false);
  }
  if (type === null) return null;

  const stem = fileStem(dispatched);
  const container = CONTAINER_FILE_TYPES.has(type);
  const filePath = [...dirs, dispatched].join('/');
  const named = (apiName: string): DerivedPath => ({ type, apiName, container, filePath });
  const objIdx = segments.indexOf('objects');
  if (objIdx !== -1 && objIdx + 1 < segments.length) {
    const objectName = segments[objIdx + 1] ?? '';
    if (type === 'CustomObject') return named(objectName);
    return named(`${objectName}.${stem}`);
  }
  // Foldered types carry their LEAF folder: `Folder/Name` for reports and
  // dashboards, `Folder.Name` for email templates (the extractors' id shapes).
  const parent = dirs[dirs.length - 1] ?? '';
  if ((type === 'Report' || type === 'Dashboard') && parent !== 'reports' && parent !== 'dashboards') {
    return named(`${parent}/${stem}`);
  }
  if (type === 'EmailTemplate' && parent !== 'email') return named(`${parent}.${stem}`);
  // A Layout file is `{Object}-{Layout Name}`; the vault id is `{Object}.{Layout Name}`.
  if (type === 'Layout') return named(stem.replace('-', '.'));
  // Org-level settings singletons are `{Type}:default`.
  if (dirs.includes('settings') && type.endsWith('Settings')) return named(SETTINGS_SINGLETON_NAME);
  return named(stem);
};

/**
 * The `{ type, apiName }` a changed source path names, or null when it is not
 * a recognised metadata source file. A container file (labels, sharing rules…)
 * yields its type with the FILE's name — use {@link parseSourcePathEntries},
 * which reports containers separately, to build a change set.
 *
 * @example
 *   deriveComponentFromPath('force-app/main/default/quickActions/Case.Send.quickAction-meta.xml')
 *   // => { type: 'QuickAction', apiName: 'Case.Send' }
 */
export const deriveComponentFromPath = (
  relPath: string,
): { type: string; apiName: string } | null => {
  const d = classifySourcePath(relPath);
  return d === null ? null : { type: d.type, apiName: d.apiName };
};

/** Map a `git diff --name-status` status letter to a change kind. */
const statusToChangeKind = (status: string): ChangeSetKind => {
  const head = status.charAt(0).toUpperCase();
  if (head === 'A' || head === 'C') return 'added';
  if (head === 'D') return 'deleted';
  // M, T, U, anything else → modified. (R is split into D + A by the caller.)
  return 'modified';
};

/** A `git diff --name-status` status token: one letter, optional similarity score. */
const STATUS_TOKEN = /^[AMDRCTU]\d{0,3}$/;

/**
 * Project files that are never deployed as metadata: docs, READMEs, project
 * config, tooling dot-files, Jest tests. A changed path matching none of these
 * that is ALSO not a modelled metadata file is metadata the vault cannot
 * check — the gate reports it as not reviewed instead of ignoring it.
 */
const NON_METADATA_DIRS: ReadonlySet<string> = new Set([
  '__tests__',
  'docs',
  'doc',
  'scripts',
  'config',
  '.github',
  '.vscode',
  '.husky',
  '.sfdx',
  '.sf',
]);
const NON_METADATA_FILE =
  /^(readme.*|license.*|changelog.*|.*\.md|\..*|sfdx-project\.json|package(-lock)?\.json|tsconfig.*\.json|jest\.config\..*|eslint\.config\..*)$/i;

/** True for a changed project file that is not deployable metadata. */
export const isNonMetadataPath = (relPath: string): boolean => {
  const segments = splitPathSegments(relPath);
  const file = segments[segments.length - 1] ?? '';
  return NON_METADATA_FILE.test(file) || segments.slice(0, -1).some((s) => NON_METADATA_DIRS.has(s));
};

/** Result of parsing a list of changed source paths. */
export interface ParsedSourcePaths {
  readonly components: readonly ChangeComponent[];
  /** Container files and unmodelled metadata files — named, NOT reviewed. */
  readonly unreviewable: readonly UnreviewableEntry[];
  /** Project files that are not deployable metadata (docs, config, tests). */
  readonly skippedPaths: readonly string[];
}

/** Split one `--name-status` line / bare path into `[status, path]` pairs (a rename is two). */
const splitEntry = (line: string): readonly (readonly [string, string])[] => {
  const fields = line.split('\t').filter((f) => f !== '');
  let status = 'M';
  let paths: string[] = [line];
  if (fields.length >= 2 && STATUS_TOKEN.test(fields[0] ?? '')) {
    status = fields[0] ?? 'M';
    paths = fields.slice(1);
  } else {
    const m = /^([AMDRCTU]\d{0,3})\s+(\S.*)$/.exec(line);
    if (m !== null) {
      status = m[1] ?? 'M';
      // Space-separated `R100 old new`: only split when that yields exactly
      // two paths; a single path may itself contain spaces.
      const rest = (m[2] ?? '').trim();
      const parts = rest.split(/\s+/);
      paths = /^[RC]/.test(status) && parts.length === 2 ? parts : [rest];
    }
  }
  const head = status.charAt(0).toUpperCase();
  if ((head === 'R' || head === 'C') && paths.length >= 2) {
    const oldPath = paths[0] ?? '';
    const newPath = paths[paths.length - 1] ?? '';
    // A rename removes the old component and adds the new one; a copy only adds.
    return head === 'R' ? [['D', oldPath], ['A', newPath]] : [['A', newPath]];
  }
  return [[status, paths[paths.length - 1] ?? '']];
};

/** Several files of one component: all added → added, all deleted → deleted, else modified. */
const mergeKinds = (kinds: ReadonlySet<ChangeSetKind>): ChangeSetKind =>
  kinds.size === 1 ? ([...kinds][0] ?? 'modified') : 'modified';

/**
 * Parse changed source paths into a de-duplicated change set. Each entry is a
 * bare path (→ `modified`) or a `git diff --name-status` line (`D\tforce-app/…`,
 * `M force-app/…`, `R100\told\tnew`). A rename reviews the OLD component as
 * deleted and the NEW one as added. Several files of one component (a
 * bundle's files, a class and its sidecar) collapse to one row whose kind is
 * `added` / `deleted` only when EVERY file agrees, `modified` otherwise — a
 * file deleted inside a bundle modifies the bundle.
 */
export const parseSourcePathEntries = (entries: readonly string[]): ParsedSourcePaths => {
  const rows = new Map<string, { c: Omit<ChangeComponent, 'changeKind'>; kinds: Set<ChangeSetKind> }>();
  const containers = new Map<string, { type: string; kinds: Set<ChangeSetKind> }>();
  const notModeled = new Map<string, Set<ChangeSetKind>>();
  const skippedPaths: string[] = [];
  for (const raw of entries) {
    const line = raw.trim();
    if (line === '') continue;
    for (const [status, rawPath] of splitEntry(line)) {
      const path = rawPath.trim();
      if (path === '') continue;
      const kind = statusToChangeKind(status);
      if (isNonMetadataPath(path)) {
        if (!skippedPaths.includes(path)) skippedPaths.push(path);
        continue;
      }
      const derived = classifySourcePath(path);
      if (derived === null) {
        notModeled.set(path, (notModeled.get(path) ?? new Set()).add(kind));
        continue;
      }
      if (derived.container) {
        const file = derived.filePath ?? path;
        const prev = containers.get(file);
        containers.set(file, { type: derived.type, kinds: (prev?.kinds ?? new Set()).add(kind) });
        continue;
      }
      const id = `${derived.type}:${derived.apiName}`;
      const prev = rows.get(id);
      if (prev !== undefined) {
        prev.kinds.add(kind);
        continue;
      }
      rows.set(id, {
        c: {
          type: derived.type,
          apiName: derived.apiName,
          ...(derived.filePath !== undefined ? { sourcePath: derived.filePath } : {}),
        },
        kinds: new Set([kind]),
      });
    }
  }
  const unreviewable: UnreviewableEntry[] = [
    ...[...containers].map(([input, v]) => ({
      input,
      reason: 'container' as const,
      containerType: v.type,
      changeKind: mergeKinds(v.kinds),
    })),
    ...[...notModeled].map(([input, kinds]) => ({
      input,
      reason: 'not-modeled' as const,
      changeKind: mergeKinds(kinds),
    })),
  ];
  return {
    components: [...rows.values()].map((r) => ({ ...r.c, changeKind: mergeKinds(r.kinds) })),
    unreviewable,
    skippedPaths,
  };
};

/**
 * Parse raw `git diff --name-status <base>` output (the CLI's `--diff`) into
 * its reviewable components. Same semantics as {@link parseSourcePathEntries};
 * use that directly to also get the container / unmodelled entries to disclose.
 */
export const parseDiffComponents = (diffOutput: string): readonly ChangeComponent[] =>
  parseSourcePathEntries(diffOutput.split('\n')).components.map((c) => ({
    type: c.type,
    apiName: c.apiName,
    changeKind: c.changeKind,
  }));
