/**
 * Vault registry for v3.1 cross-org tooling.
 *
 * v3.1 opens the "compare multiple orgs" surface: sandbox-vs-prod
 * comparison, prod-vs-prod (multi-customer) audit, or "what changed
 * since the last vault refresh?" diffs. The registry is the load-
 * bearing primitive — a small top-level `registry.json` that maps
 * vault aliases (`acme-prod`, `acme-sandbox`) to absolute on-disk
 * paths. Every v3.1 cross-vault MCP tool resolves through it.
 *
 * Layout (per PLAN-v3.1 §3):
 *
 *   ~/sf-intelligence-vaults/
 *     registry.json            (the registry file)
 *     acme-prod/               (one v3.0-shape vault)
 *     acme-sandbox/            (another v3.0-shape vault)
 *
 * The registry is intentionally minimal. Per-vault state (refresh
 * timestamps, source-tree hashes, component counts) is read from each
 * vault's own `meta/manifest.json` — duplicating it here would risk
 * stale-registry drift when a vault is refreshed independently. The
 * registry stores ONLY alias → path mapping plus the registration
 * timestamp.
 *
 * This module owns the on-disk shape of the registry (load/save) and
 * the alias-resolution primitive. The MCP tools that compose over it
 * (`sfi.compare_vaults` and siblings) live in
 * `@sf-intelligence/mcp`.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

import { loadManifest } from './manifest.js';

/** Schema version embedded in every `registry.json` file. v3.1 ships 1.0. */
const REGISTRY_VERSION = '1.0' as const;

/** Suffix used for the temporary file in `saveRegistry`'s atomic write. */
const TEMP_SUFFIX = '.tmp';

/** JSON indentation, 2 spaces, mirrors the rest of the vault for diffability. */
const JSON_INDENT = 2;

/** Default registry file name. Lives at the co-resident root directory. */
export const REGISTRY_FILENAME = 'registry.json' as const;

/**
 * Reference to a single registered vault, as returned by `listRegisteredVaults`.
 *
 *   - `alias`: the name the user types ('acme-prod', 'acme-sandbox',
 *     'acme').
 *   - `path`: absolute path to the vault root directory.
 *   - `registeredAt`: ISO 8601 timestamp from the registry entry.
 *   - `lastRefreshedAt`: from the vault's `meta/manifest.json`;
 *     `null` when the manifest is missing (the vault has never been
 *     refreshed via `sfi refresh`).
 *   - `sourceTreeHash`: from the vault's manifest; `null` when missing.
 *   - `componentCount`: total components extracted (sum across
 *     ComponentTypes); `null` when the manifest is missing.
 */
export interface VaultRef {
  readonly alias: string;
  readonly path: string;
  readonly registeredAt: string;
  readonly lastRefreshedAt: string | null;
  readonly sourceTreeHash: string | null;
  readonly componentCount: number | null;
}

/**
 * One entry stored in `registry.json`. Intentionally minimal — see the
 * module docblock for why per-vault state is NOT stored here.
 */
export interface RegistryEntry {
  readonly path: string;
  readonly registeredAt: string;
}

/**
 * The on-disk shape of `registry.json`. Two top-level fields beyond
 * the alias map: the schema version (for future migrations) and the
 * registry's own creation timestamp.
 */
export interface VaultRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly registeredAt: string;
  readonly vaults: Readonly<Record<string, RegistryEntry>>;
}

/**
 * Error variants surfaced by registry I/O.
 *
 *   - `registry-missing`: the registry file does not exist. Distinct
 *     from a corrupt file; callers treat this as "no vaults yet".
 *   - `parse-error`: the file exists but is not valid JSON or the
 *     schema does not match `VaultRegistry`.
 *   - `write-failed`: I/O failure (permission denied, temp-file
 *     rename failure, etc.).
 *   - `duplicate-alias`: `registerVault` was called with an alias
 *     already present and `force` was not set.
 *   - `alias-not-found`: `resolveVault` was called with an alias not
 *     present in the registry.
 *   - `invalid-path`: the supplied vault path is not absolute or does
 *     not name an existing directory.
 *   - `invalid-alias`: the alias is empty or contains characters that
 *     would break path resolution.
 */
export interface RegistryError {
  readonly kind:
    | 'registry-missing'
    | 'parse-error'
    | 'write-failed'
    | 'duplicate-alias'
    | 'alias-not-found'
    | 'invalid-path'
    | 'invalid-alias';
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}

/**
 * Compute the absolute path of `registry.json` under a co-resident
 * root directory.
 *
 * @example
 *   registryPath('/home/me/sf-intelligence-vaults');
 *   // => '/home/me/sf-intelligence-vaults/registry.json'
 */
export const registryPath = (rootDir: string): string =>
  join(rootDir, REGISTRY_FILENAME);

/**
 * How many directory levels to climb from a vault root when searching
 * for a co-resident `registry.json`. Matches the depth `fleet_find`
 * has always used so both surfaces reach the same workspace-root file.
 */
const REGISTRY_SEARCH_DEPTH = 5;

/**
 * Resolve the multi-vault registry FILE path for a given vault root — the
 * shared registry-LOCATION primitive used by every cross-vault MCP tool
 * (`fleet_find` and the `compare_*` family). Returns a file path that may not
 * exist; callers `existsSync`-check it or let `loadRegistry` report it missing.
 *
 * Contract for `SF_INTELLIGENCE_REGISTRY_PATH`:
 *
 *   - set AND an existing DIRECTORY → the `registry.json` inside it (the form
 *     the `compare_*` tools and the CLI use).
 *   - set AND anything else (an existing file, or a not-yet-existing path) →
 *     that EXACT path, verbatim. `fleet_find`'s eval harness and scripts point
 *     the env var at a specific FILE — which may be named `registry.json` or
 *     not (e.g. a test's `single-registry.json`) — so the filename is
 *     preserved rather than rewritten to `<dir>/registry.json`. (This is the
 *     bug the earlier dirname-then-append model hit: `single-registry.json`
 *     ends with `registry.json`, so it loaded the sibling `registry.json`
 *     instead of the file the env var named.)
 *   - unset → walk UP from `vaultRoot` up to `REGISTRY_SEARCH_DEPTH` levels,
 *     returning the first `registry.json` found; if none, fall back to the
 *     co-resident default `<parent-of-vaultRoot>/registry.json`.
 *
 * @example
 *   // env: SF_INTELLIGENCE_REGISTRY_PATH=/vaults/registry.json (a file)
 *   findRegistryFile('/vaults/acme-prod'); // => '/vaults/registry.json'
 *   // env: SF_INTELLIGENCE_REGISTRY_PATH=/vaults (a directory)
 *   findRegistryFile('/vaults/acme-prod'); // => '/vaults/registry.json'
 */
export const findRegistryFile = (vaultRoot: string): string => {
  const fromEnv = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    if (existsSync(fromEnv) && statSync(fromEnv).isDirectory()) {
      return registryPath(fromEnv);
    }
    return fromEnv;
  }
  let dir = vaultRoot;
  for (let i = 0; i < REGISTRY_SEARCH_DEPTH; i += 1) {
    const candidate = registryPath(dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No registry.json found on the walk — fall back to the prior co-resident
  // default (the registry.json beside the parent of the vault root).
  return registryPath(dirname(vaultRoot));
};

/**
 * Resolve the registry ROOT DIRECTORY for a given vault root — the directory
 * to hand to `loadRegistry(root)` / `resolveVault(root, alias)` /
 * `getVaultRef(root, alias)`. Derived from `findRegistryFile` so the two never
 * disagree: it is simply that file's containing directory.
 *
 * Note: when the env var names an arbitrary file (e.g. `single-registry.json`),
 * the derived root is that file's directory, so a `loadRegistry(root)` caller
 * reads `<dir>/registry.json`, NOT the arbitrary file. That is fine for the
 * `compare_*` tools, which only ever point the env var at a directory or a
 * `registry.json` file; `fleet_find`, which honors arbitrary file names, uses
 * `findRegistryFile` directly instead.
 *
 * @example
 *   // env unset, /work/registry.json exists:
 *   findRegistryRoot('/work/vaults/acme-prod'); // => '/work'
 */
export const findRegistryRoot = (vaultRoot: string): string =>
  dirname(findRegistryFile(vaultRoot));

/**
 * Validate an alias for use as a registry key. Aliases must be
 * non-empty after trimming; they must not contain path separators
 * (`/`, `\`) or null bytes (which would break filesystem lookups).
 *
 * Returns `ok` on success; `err({kind: 'invalid-alias'})` otherwise.
 */
const validateAlias = (alias: string): Result<string, RegistryError> => {
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    return err({
      kind: 'invalid-alias',
      message: 'alias must be a non-empty string',
    });
  }
  if (/[/\\\0]/.test(trimmed)) {
    return err({
      kind: 'invalid-alias',
      message: `alias '${alias}' contains path separators or null bytes`,
    });
  }
  return ok(trimmed);
};

/**
 * Load the registry from disk. Returns `err({kind: 'registry-missing'})`
 * when the file does not exist — callers can treat this as "no vaults
 * yet" and offer to create one with `registerVault`.
 *
 * @example
 *   const r = await loadRegistry('/home/me/sf-intelligence-vaults');
 *   if (r.ok) console.log(Object.keys(r.value.vaults));
 *   else if (r.error.kind === 'registry-missing') createFirstVault();
 */
export const loadRegistry = async (
  rootDir: string,
): Promise<Result<VaultRegistry, RegistryError>> => {
  const path = registryPath(rootDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (isEnoent(cause)) {
      return err({
        kind: 'registry-missing',
        message: `registry does not exist: ${path}`,
        path,
      });
    }
    return err({
      kind: 'parse-error',
      message: `failed to read registry: ${path}`,
      path,
      cause,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return err({
      kind: 'parse-error',
      message: `registry is not valid JSON: ${path}`,
      path,
      cause,
    });
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return err({
      kind: 'parse-error',
      message: `registry root is not an object: ${path}`,
      path,
    });
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== REGISTRY_VERSION) {
    return err({
      kind: 'parse-error',
      message: `registry version mismatch at ${path}: expected '${REGISTRY_VERSION}', got '${String(obj.version)}'`,
      path,
    });
  }
  if (typeof obj.registeredAt !== 'string') {
    return err({
      kind: 'parse-error',
      message: `registry missing registeredAt at ${path}`,
      path,
    });
  }
  if (
    obj.vaults === null ||
    typeof obj.vaults !== 'object' ||
    Array.isArray(obj.vaults)
  ) {
    return err({
      kind: 'parse-error',
      message: `registry vaults must be an object at ${path}`,
      path,
    });
  }

  const vaults: Record<string, RegistryEntry> = {};
  const vaultObj = obj.vaults as Record<string, unknown>;
  for (const [alias, value] of Object.entries(vaultObj)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return err({
        kind: 'parse-error',
        message: `registry vault entry '${alias}' is not an object`,
        path,
      });
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.registeredAt !== 'string'
    ) {
      return err({
        kind: 'parse-error',
        message: `registry vault entry '${alias}' missing required fields (path, registeredAt)`,
        path,
      });
    }
    vaults[alias] = {
      path: entry.path,
      registeredAt: entry.registeredAt,
    };
  }

  return ok({
    version: REGISTRY_VERSION,
    registeredAt: obj.registeredAt,
    vaults,
  });
};

/**
 * Persist `registry` to `registry.json` atomically (writes to a
 * sibling temp file then renames into place). Keys are sorted at
 * every level so committed registries produce minimal diffs.
 *
 * @example
 *   await saveRegistry('/home/me/sf-intelligence-vaults', registry);
 */
export const saveRegistry = async (
  rootDir: string,
  registry: VaultRegistry,
): Promise<Result<void, RegistryError>> => {
  const path = registryPath(rootDir);
  const tempPath = `${path}${TEMP_SUFFIX}`;
  const json = `${JSON.stringify(sortKeys(registry), null, JSON_INDENT)}\n`;

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause) {
    return err({
      kind: 'write-failed',
      message: `failed to create registry directory: ${dirname(path)}`,
      path,
      cause,
    });
  }

  try {
    await writeFile(tempPath, json, 'utf8');
  } catch (cause) {
    await cleanupTemp(tempPath);
    return err({
      kind: 'write-failed',
      message: `failed to write temp registry: ${tempPath}`,
      path,
      cause,
    });
  }

  try {
    await rename(tempPath, path);
  } catch (cause) {
    await cleanupTemp(tempPath);
    return err({
      kind: 'write-failed',
      message: `failed to rename temp registry into place: ${path}`,
      path,
      cause,
    });
  }

  return ok(undefined);
};

/**
 * Register a vault under `alias` at `vaultPath`. Creates `registry.json`
 * if it does not exist. Refuses to overwrite an existing alias unless
 * `force` is true.
 *
 * The `vaultPath` must be an absolute path. The function does NOT
 * verify that the path holds a valid v3.0-shape vault — that's a
 * downstream concern (the cross-vault tools surface a per-call
 * disclosure when they read a registered vault that turns out to be
 * empty or unrefreshed). This separation keeps `registerVault` cheap
 * and offline-friendly.
 *
 * @example
 *   await registerVault(
 *     '/home/me/sf-intelligence-vaults',
 *     'acme-prod',
 *     '/home/me/sf-intelligence-vaults/acme-prod',
 *   );
 */
export const registerVault = async (
  rootDir: string,
  alias: string,
  vaultPath: string,
  options: { readonly force?: boolean } = {},
): Promise<Result<VaultRegistry, RegistryError>> => {
  const aliasResult = validateAlias(alias);
  if (!aliasResult.ok) return aliasResult;
  const normalizedAlias = aliasResult.value;

  if (!isAbsolute(vaultPath)) {
    return err({
      kind: 'invalid-path',
      message: `vault path must be absolute: '${vaultPath}'`,
      path: vaultPath,
    });
  }
  const normalizedPath = resolve(vaultPath);

  const existing = await loadRegistry(rootDir);
  let current: VaultRegistry;
  if (existing.ok) {
    current = existing.value;
  } else if (existing.error.kind === 'registry-missing') {
    current = {
      version: REGISTRY_VERSION,
      registeredAt: new Date().toISOString(),
      vaults: {},
    };
  } else {
    return err(existing.error);
  }

  if (
    Object.prototype.hasOwnProperty.call(current.vaults, normalizedAlias) &&
    options.force !== true
  ) {
    return err({
      kind: 'duplicate-alias',
      message: `alias '${normalizedAlias}' is already registered. Pass force: true to overwrite, or pick a different alias.`,
    });
  }

  const updated: VaultRegistry = {
    version: REGISTRY_VERSION,
    registeredAt: current.registeredAt,
    vaults: {
      ...current.vaults,
      [normalizedAlias]: {
        path: normalizedPath,
        registeredAt: new Date().toISOString(),
      },
    },
  };

  const saved = await saveRegistry(rootDir, updated);
  if (!saved.ok) return err(saved.error);
  return ok(updated);
};

/**
 * Resolve an alias to its absolute vault path. The companion lookup
 * primitive for the cross-vault MCP tools. Returns
 * `err({kind: 'alias-not-found'})` when the alias is not registered,
 * carrying the verbatim pointer the skill surfaces (`sfi register-vault
 * <alias> <path>`).
 *
 * @example
 *   const r = await resolveVault('/home/me/sf-intelligence-vaults', 'acme-prod');
 *   if (r.ok) console.log(r.value);
 *   else if (r.error.kind === 'alias-not-found') refuseWithRegisterHint();
 */
export const resolveVault = async (
  rootDir: string,
  alias: string,
): Promise<Result<string, RegistryError>> => {
  const registry = await loadRegistry(rootDir);
  if (!registry.ok) {
    if (registry.error.kind === 'registry-missing') {
      return err({
        kind: 'alias-not-found',
        message: `vault alias '${alias}' is not registered. Run \`sfi register-vault ${alias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
      });
    }
    return err(registry.error);
  }
  const entry = registry.value.vaults[alias];
  if (entry === undefined) {
    return err({
      kind: 'alias-not-found',
      message: `vault alias '${alias}' is not registered. Run \`sfi register-vault ${alias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
    });
  }
  return ok(entry.path);
};

/**
 * Enumerate every registered vault and enrich each entry with the
 * freshness metadata read from its `meta/manifest.json`. When the
 * manifest is missing or unreadable, the per-vault freshness fields
 * surface as `null` so callers can render "never refreshed" without
 * fabricating a timestamp.
 *
 * Sorted by alias ASC for stable rendering.
 *
 * @example
 *   const r = await listRegisteredVaults('/home/me/sf-intelligence-vaults');
 *   if (r.ok) for (const v of r.value) console.log(v.alias, v.lastRefreshedAt);
 */
export const listRegisteredVaults = async (
  rootDir: string,
): Promise<Result<readonly VaultRef[], RegistryError>> => {
  const registry = await loadRegistry(rootDir);
  if (!registry.ok) {
    if (registry.error.kind === 'registry-missing') {
      return ok([]);
    }
    return err(registry.error);
  }
  const entries = Object.entries(registry.value.vaults).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: VaultRef[] = [];
  for (const [alias, entry] of entries) {
    const manifestResult = await loadManifest(entry.path);
    let lastRefreshedAt: string | null = null;
    let sourceTreeHash: string | null = null;
    let componentCount: number | null = null;
    if (manifestResult.ok) {
      lastRefreshedAt = manifestResult.value.refreshedAt;
      sourceTreeHash = manifestResult.value.sourceTreeHash;
      let sum = 0;
      for (const value of Object.values(manifestResult.value.components)) {
        if (typeof value === 'number') sum += value;
      }
      componentCount = sum;
    }
    out.push({
      alias,
      path: entry.path,
      registeredAt: entry.registeredAt,
      lastRefreshedAt,
      sourceTreeHash,
      componentCount,
    });
  }
  return ok(out);
};

/**
 * Return the `VaultRef` for a single alias. Composes
 * `resolveVault` + the freshness-enrichment step the `listRegisteredVaults`
 * walker uses. The MCP cross-vault tools use this to populate the
 * `vaultA: VaultRef` / `vaultB: VaultRef` fields in their responses
 * — callers see the freshness skew explicitly.
 */
export const getVaultRef = async (
  rootDir: string,
  alias: string,
): Promise<Result<VaultRef, RegistryError>> => {
  const registry = await loadRegistry(rootDir);
  if (!registry.ok) {
    if (registry.error.kind === 'registry-missing') {
      return err({
        kind: 'alias-not-found',
        message: `vault alias '${alias}' is not registered. Run \`sfi register-vault ${alias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
      });
    }
    return err(registry.error);
  }
  const entry = registry.value.vaults[alias];
  if (entry === undefined) {
    return err({
      kind: 'alias-not-found',
      message: `vault alias '${alias}' is not registered. Run \`sfi register-vault ${alias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
    });
  }
  const manifestResult = await loadManifest(entry.path);
  let lastRefreshedAt: string | null = null;
  let sourceTreeHash: string | null = null;
  let componentCount: number | null = null;
  if (manifestResult.ok) {
    lastRefreshedAt = manifestResult.value.refreshedAt;
    sourceTreeHash = manifestResult.value.sourceTreeHash;
    let sum = 0;
    for (const value of Object.values(manifestResult.value.components)) {
      if (typeof value === 'number') sum += value;
    }
    componentCount = sum;
  }
  return ok({
    alias,
    path: entry.path,
    registeredAt: entry.registeredAt,
    lastRefreshedAt,
    sourceTreeHash,
    componentCount,
  });
};

/**
 * Return a structural deep copy of `value` with object keys sorted
 * alphabetically at every level. Arrays preserve their order.
 *
 * Used by `saveRegistry` to canonicalize key order before JSON encoding,
 * mirroring the discipline `saveManifest` uses.
 */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      sorted[k] = sortKeys(v);
    }
    return sorted;
  }
  return value;
};

/** Treat unknown errors that smell like ENOENT as missing-file signals. */
const isEnoent = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { code?: unknown }).code === 'ENOENT';

/** Best-effort cleanup of a temp file; ignores its absence. */
const cleanupTemp = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch {
    // Temp file may not exist (write failed before it was created); nothing to clean.
  }
};
