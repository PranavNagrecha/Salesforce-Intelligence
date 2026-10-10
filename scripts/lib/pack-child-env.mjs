/**
 * Environment for a script's OWN `npm pack` child.
 *
 * `npm publish --dry-run` / `pnpm publish --dry-run` export
 * `npm_config_dry_run=true` to lifecycle hooks (prepublishOnly). Any `npm pack`
 * a hook spawns inherits it and then writes NO tarball, so a check that
 * inspects the tarball fails with "found 0 .tgz" during every dry run — the
 * one moment a maintainer is trying to rehearse a release.
 *
 * npm reads `npm_config_*` case-insensitively and treats `-` and `_` alike,
 * so every spelling of the dry-run key is dropped. Nothing else changes:
 * registry, cache and auth settings still flow through untouched.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function packChildEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_dry[-_]run$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
