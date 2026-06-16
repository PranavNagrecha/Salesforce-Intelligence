import type { VaultManifest } from '@sf-intelligence/contracts';

/**
 * The three states a vault can be in relative to the current source tree.
 *
 *   - `fresh`: the manifest's recorded source-tree hash matches the
 *     current source-tree hash; downstream answers are trustworthy.
 *   - `stale`: a manifest exists but its hash disagrees with the current
 *     source tree; a refresh is required.
 *   - `no-vault`: no manifest exists at all; the vault has not been
 *     populated yet.
 */
export type FreshnessState =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'stale'; readonly currentHash: string; readonly manifestHash: string }
  | { readonly kind: 'no-vault' };

/**
 * Compare the current source-tree hash against the manifest's recorded
 * hash and decide whether the vault is fresh, stale, or absent.
 *
 * Pure: takes the manifest and current hash as inputs, returns the
 * decision. Callers pass `null` for `manifest` when `loadManifest`
 * reported `manifest-missing`.
 *
 * @example
 *   const decision = checkFreshness(manifest, currentHash);
 *   if (decision.kind === 'stale') console.log('refresh required');
 */
export const checkFreshness = (
  manifest: VaultManifest | null,
  currentSourceHash: string,
): FreshnessState => {
  if (manifest === null) {
    return { kind: 'no-vault' };
  }
  if (manifest.sourceTreeHash === currentSourceHash) {
    return { kind: 'fresh' };
  }
  return {
    kind: 'stale',
    currentHash: currentSourceHash,
    manifestHash: manifest.sourceTreeHash,
  };
};
