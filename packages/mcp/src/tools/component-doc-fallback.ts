/**
 * Read rendered component markdown when the graph is missing nodes but the
 * renderer left docs on disk (partial refresh / scoped retrieve gap).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';
import { isPathWithin } from '@sf-intelligence/core';
import { componentPath } from '@sf-intelligence/vault';

/** Parse `ValidationRule:Lead.My_Rule` → parent + apiName. */
export const parseValidationRuleComponentId = (
  id: string,
): { parentApiName: string; apiName: string } | null => {
  if (!id.startsWith('ValidationRule:')) return null;
  const rest = id.slice('ValidationRule:'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot >= rest.length - 1) return null;
  return { parentApiName: rest.slice(0, dot), apiName: rest.slice(dot + 1) };
};

const splitFrontmatter = (raw: string): { frontmatter: string; body: string } | null => {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return {
    frontmatter: raw.slice(4, end),
    body: raw.slice(end + 5),
  };
};

/** Minimal YAML scalar lookup — enough for component doc frontmatter ids. */
const yamlScalar = (frontmatter: string, key: string): string | null => {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = frontmatter.match(re);
  if (m === null) return null;
  return m[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
};

const nodeFromDoc = (
  type: ComponentType,
  parentApiName: string,
  apiName: string,
  frontmatter: string,
): Node => {
  const id =
    (yamlScalar(frontmatter, 'id') as ComponentId | null) ??
    (`${type}:${parentApiName}.${apiName}` as ComponentId);
  const label = yamlScalar(frontmatter, 'label') ?? apiName;
  const parentId =
    (yamlScalar(frontmatter, 'parentId') as ComponentId | null) ??
    (`CustomObject:${parentApiName}` as ComponentId);
  return {
    id,
    type,
    apiName,
    label,
    parentId,
    properties: {},
    sourcePath: yamlScalar(frontmatter, 'sourcePath') ?? '',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
  };
};

/**
 * List ValidationRule docs under `components/ValidationRule/{parentApi}/`.
 * Used when the graph has zero rows for a parent that still has rendered docs.
 */
export const listValidationRuleDocsForParent = async (
  vaultRoot: string,
  parentApiName: string,
  options?: { apiNamePrefix?: string; limit?: number; offset?: number },
): Promise<readonly Node[]> => {
  const dir = join(vaultRoot, 'components', 'ValidationRule', parentApiName);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const prefix = options?.apiNamePrefix;
  if (prefix !== undefined) {
    names = names.filter((n) => n.startsWith(`${prefix}.md`) || n.startsWith(`${prefix}_`));
  }
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 200;
  const slice = names.slice(offset, offset + limit);
  const nodes: Node[] = [];
  for (const file of slice) {
    const apiName = file.slice(0, -3);
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      const split = splitFrontmatter(raw);
      if (split === null) continue;
      nodes.push(nodeFromDoc('ValidationRule', parentApiName, apiName, split.frontmatter));
    } catch {
      // skip unreadable doc
    }
  }
  return nodes;
};

/** Try loading a component markdown file when the graph has no node. */
export const tryReadComponentDoc = async (
  vaultRoot: string,
  componentId: string,
): Promise<{ path: string; frontmatter: string; body: string; type: ComponentType } | null> => {
  const vr = parseValidationRuleComponentId(componentId);
  if (vr === null) return null;
  const fullPath = componentPath(
    vaultRoot,
    'ValidationRule',
    vr.parentApiName,
    vr.apiName,
  );

  // COMPONENT-DOC-FALLBACK-TRAVERSAL.
  //
  // `componentId` arrives from the CALLER — sfi.get_component passes `input.id`
  // straight through — and the parse above splits on the first `.` without
  // rejecting anything, so both segments reach `componentPath`'s `join` as-is.
  // `ValidationRule:../../../../some/dir.secret` therefore addressed a file
  // outside the vault entirely, and the old relative-path computation below
  // (`startsWith(vaultRoot) ? slice : fullPath`) RETURNED THE ABSOLUTE PATH on
  // exactly the inputs that escaped — so a miss disclosed the host's filesystem
  // layout even when the read failed.
  //
  // Containment is checked structurally rather than by rejecting `..` or a
  // separator: a deny-list has to anticipate every spelling (`..`, `%2e%2e`,
  // a nested `a/../..`, a Windows `\`), whereas resolving and asking whether
  // the result is still inside the vault is decided by the filesystem's own
  // normalisation. `isPathWithin` is purely LEXICAL — it does no I/O and does
  // not resolve symlinks — which is what we want here: a symlink inside the
  // vault pointing out of it must not become a read, and `realpath` would
  // quietly authorise exactly that.
  if (!isPathWithin(resolve(vaultRoot), resolve(fullPath))) return null;

  try {
    const raw = await readFile(fullPath, 'utf-8');
    const split = splitFrontmatter(raw);
    if (split === null) return null;
    // Containment holds, so this always trims. No absolute-path fallback: a
    // path we would have had to echo whole is one we already refused above.
    const rel = fullPath.slice(vaultRoot.length + 1);
    return { path: rel, frontmatter: split.frontmatter, body: split.body, type: 'ValidationRule' };
  } catch {
    return null;
  }
};
