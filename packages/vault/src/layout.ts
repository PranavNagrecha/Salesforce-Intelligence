import { join } from 'node:path';

import type { ComponentType } from '@sf-intelligence/contracts';

/**
 * The canonical filesystem layout of an `org-kb/` vault.
 *
 * Every other runtime package asks `vaultPaths` for the locations it
 * needs rather than hard-coding strings. This keeps the layout in one
 * place and easy to refactor.
 *
 * `snapshots` is the v2.0c root for persisted snapshot directories
 * (`{vaultRoot}/snapshots/{label}/`); each snapshot is a sibling
 * directory under it. The location parallels `graph/` and `components/`
 * — a sibling of the source / meta / graph branches rather than nested
 * inside any of them so backups and gitignore rules can address it as
 * a single tree.
 */
export interface VaultLayout {
  readonly root: string;
  readonly source: string;
  readonly components: string;
  readonly graph: string;
  readonly graphDb: string;
  readonly meta: string;
  readonly manifest: string;
  readonly config: string;
  readonly version: string;
  readonly snapshots: string;
  readonly baseline: string;
}

/**
 * Compute the canonical paths inside a vault rooted at `vaultRoot`.
 *
 * Returns a frozen record of every directory and file the rest of the
 * system needs to address. Pure: does not touch the filesystem.
 *
 * @example
 *   const paths = vaultPaths('/home/me/org-kb');
 *   // paths.manifest === '/home/me/org-kb/meta/manifest.json'
 *   // paths.components === '/home/me/org-kb/components'
 */
export const vaultPaths = (vaultRoot: string): VaultLayout => {
  const meta = join(vaultRoot, 'meta');
  const graph = join(vaultRoot, 'graph');
  return {
    root: vaultRoot,
    source: join(vaultRoot, 'source'),
    components: join(vaultRoot, 'components'),
    graph,
    graphDb: join(graph, 'graph.duckdb'),
    meta,
    manifest: join(meta, 'manifest.json'),
    config: join(meta, 'config.json'),
    version: join(meta, 'version.txt'),
    snapshots: join(vaultRoot, 'snapshots'),
    baseline: join(meta, 'baseline.json'),
  };
};

/**
 * Compute the canonical filesystem path of a single named snapshot under
 * the vault.
 *
 * Layout: `{vaultRoot}/snapshots/{label}/`. Each snapshot directory
 * holds three flat JSON files (`nodes.json`, `edges.json`, `meta.json`)
 * plus a copy of `manifest.json` captured at the time of snapshot.
 * Markdown vault contents are NOT copied — the structured graph plus
 * the manifest is sufficient for the v2.0c diff use cases.
 *
 * Pure: does not touch the filesystem.
 *
 * @example
 *   snapshotPath('/org-kb', 'weekly-2026-05-27');
 *   // => '/org-kb/snapshots/weekly-2026-05-27'
 */
export const snapshotPath = (vaultRoot: string, label: string): string =>
  join(vaultRoot, 'snapshots', label);

/**
 * Compute the absolute path of a single component's Markdown file inside
 * the vault.
 *
 * Layout: `{vaultRoot}/components/{type}/{parentApiName?}/{apiName}.md`.
 * The parent segment is included only when `parentApiName` is non-null,
 * which lets callers decide per component type (CustomField and the like
 * have parents; CustomObject does not).
 *
 * Pure: does not touch the filesystem.
 *
 * @example
 *   componentPath('/org-kb', 'CustomField', 'Account', 'Industry__c');
 *   // => '/org-kb/components/CustomField/Account/Industry__c.md'
 *
 *   componentPath('/org-kb', 'CustomObject', null, 'Account');
 *   // => '/org-kb/components/CustomObject/Account.md'
 */
export const componentPath = (
  vaultRoot: string,
  type: ComponentType,
  parentApiName: string | null,
  apiName: string,
): string => {
  const fileName = `${apiName}.md`;
  const base = join(vaultRoot, 'components', type);
  if (parentApiName === null) {
    return join(base, fileName);
  }
  return join(base, parentApiName, fileName);
};
