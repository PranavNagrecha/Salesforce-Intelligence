/**
 * Vault-relative source-path normalization, shared by the node-row serializer
 * ({@link ../import.ts}) and the duplicate-source detector
 * ({@link ./duplicate-source.ts}).
 *
 * Lives in its own module purely to keep those two free of an import cycle —
 * `import.ts` calls the detector, and the detector must normalize paths the
 * exact same way the persisted `nodes.source_path` column does or the two would
 * disagree about whether two copies are "the same path".
 */

/**
 * Normalize a node's `sourcePath` to a vault-relative, separator-portable
 * form so the persisted graph never leaks an absolute local path (which
 * carries the user's username + filesystem layout — a privacy + portability
 * problem, and noise in committed/shared artifacts).
 *
 * Strategy: keep the path from the vault root (`org-kb/`) onward; if that
 * marker is absent, fall back to the Salesforce DX `source/` root; if neither
 * is present (e.g. an already-relative test path) the value is returned
 * unchanged. Backslashes are normalized to `/` so vaults built on Windows and
 * POSIX produce identical ids/paths.
 *
 * @example
 *   relativizeSourcePath('/home/dev/proj/org-kb/source/main/default/classes/X.cls')
 *   // => 'source/main/default/classes/X.cls'
 */
export const relativizeSourcePath = (p: string): string => {
  if (p.length === 0) return p;
  const norm = p.replace(/\\/g, '/');
  const orgKb = norm.lastIndexOf('/org-kb/');
  if (orgKb !== -1) return norm.slice(orgKb + '/org-kb/'.length);
  const src = norm.lastIndexOf('/source/');
  if (src !== -1) return norm.slice(src + 1);
  return norm;
};
