/**
 * App scope — which components are the app's own, for every tool that counts
 * across the org.
 *
 * An org-wide count mixes the app with installed packages and with whichever
 * standard objects the retrieve happened to include, so it moves with the
 * retrieve rather than with the app: unrestricted picklists can read in the
 * hundreds org-wide and a few dozen on the app's own objects. A counting tool
 * therefore reports the SCOPED number as the answer and the org-wide number
 * beside it, labelled as the contrast.
 *
 * Declared per vault (never shipped with the product) in
 * `org-kb/config/app-scope.json`:
 *
 * ```json
 * { "namePrefixes": ["Acme_"], "namespaces": ["acme"] }
 * ```
 *
 * falling back to the OmniStudio config's `appScope`
 * (`org-kb/config/omnistudio.json`), or passed per call as `scope`. A `scope`
 * with both lists empty asks for org-wide explicitly.
 *
 * Membership: a component is in scope when its API name, its parent object, or
 * (for a field) its object, starts with a declared prefix — or carries a
 * declared namespace (`ns__Name__c`). Prefixes and namespaces compare
 * case-insensitively.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { loadOmniConfig } from '../omni/config.js';
import type { Context } from '../server.js';

/** Vault-relative location of the app-scope config. */
export const APP_SCOPE_CONFIG_RELATIVE_PATH = join('config', 'app-scope.json');

const nameList = z.array(z.string().trim().min(1)).max(50);

/** The per-call `scope` input every counting tool accepts. */
export const appScopeSchema = z
  .object({
    namePrefixes: nameList.optional(),
    namespaces: nameList.optional(),
  })
  .strict();

export type AppScopeInput = z.infer<typeof appScopeSchema>;

/** JSON-schema twin of {@link appScopeSchema}, for tool input schemas. */
export const APP_SCOPE_INPUT_JSON_SCHEMA = {
  type: 'object',
  description:
    "The app's own components, for a scoped count: `namePrefixes` (e.g. [\"Acme_\"]) and/or `namespaces` (e.g. [\"acme\"]). A component is in scope when its API name or its object starts with a prefix, or carries the namespace. Omitted → the vault's declared app scope (org-kb/config/app-scope.json, else the OmniStudio config's appScope); both lists empty → org-wide. The scoped number is the answer; the org-wide number is returned beside it as a labelled contrast.",
  properties: {
    namePrefixes: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 },
    namespaces: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 },
  },
  additionalProperties: false,
} as const;

/** The scope a response applied, echoed on it. */
export interface AppScope {
  readonly namePrefixes: readonly string[];
  readonly namespaces: readonly string[];
  /**
   * `input` (passed per call), `config` (app-scope.json), `omnistudio-config`
   * (omnistudio.json `appScope`), or `none` (no scope declared — org-wide).
   */
  readonly source: 'input' | 'config' | 'omnistudio-config' | 'none';
  /** True when no prefix or namespace applies: the answer is org-wide. */
  readonly orgWide: boolean;
  /** Set when a config file exists but could not be read; the answer fell back to org-wide. */
  readonly configError?: string;
}

const appScopeConfigSchema = z
  .object({ namePrefixes: nameList.default([]), namespaces: nameList.default([]) })
  .passthrough();

const make = (
  namePrefixes: readonly string[],
  namespaces: readonly string[],
  source: AppScope['source'],
  configError?: string,
): AppScope => ({
  namePrefixes: [...new Set(namePrefixes)].sort(),
  namespaces: [...new Set(namespaces.map((n) => n.toLowerCase()))].sort(),
  source,
  orgWide: namePrefixes.length === 0 && namespaces.length === 0,
  ...(configError !== undefined ? { configError } : {}),
});

/**
 * Resolve the scope a counting tool applies: the per-call input, else the
 * vault's app-scope.json, else the OmniStudio config's appScope, else none.
 * Never throws; an unreadable config is echoed as `configError`.
 */
export const resolveAppScope = async (ctx: Context, input: AppScopeInput | undefined): Promise<AppScope> => {
  if (input !== undefined) return make(input.namePrefixes ?? [], input.namespaces ?? [], 'input');
  let configError: string | undefined;
  try {
    const text = await readFile(join(ctx.vaultRoot, APP_SCOPE_CONFIG_RELATIVE_PATH), 'utf8');
    const parsed = appScopeConfigSchema.safeParse(JSON.parse(text));
    if (parsed.success) return make(parsed.data.namePrefixes, parsed.data.namespaces, 'config');
    configError = `org-kb/config/app-scope.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      configError = `org-kb/config/app-scope.json is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  if (configError !== undefined) return make([], [], 'none', configError);
  const omni = await loadOmniConfig(ctx.vaultRoot);
  const { namePrefixes, namespaces } = omni.config.appScope;
  if (namePrefixes.length > 0 || namespaces.length > 0) return make(namePrefixes, namespaces, 'omnistudio-config');
  return make([], [], 'none');
};

/** The namespace of a managed name (`ns__Name__c` → `ns`), else null. */
export const namespaceOf = (name: string): string | null => {
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] !== undefined && /^[A-Za-z][A-Za-z0-9]*$/.test(parts[0]) ? parts[0].toLowerCase() : null;
};

/** What scope membership is judged on: a component's names. */
export interface ScopeSubject {
  readonly apiName: string;
  readonly parentId?: string | null | undefined;
}

/** The names a component answers to: its own, its object's, and (for `Obj.Field`) both halves. */
const namesOf = (subject: ScopeSubject): string[] => {
  const names = [subject.apiName, ...subject.apiName.split('.')];
  const parent = subject.parentId ?? null;
  if (parent !== null) names.push(parent.slice(parent.indexOf(':') + 1));
  return names.filter((n) => n.length > 0);
};

/** True when `subject` is the app's own under `scope` (always true org-wide). */
export const inAppScope = (scope: AppScope, subject: ScopeSubject): boolean => {
  if (scope.orgWide) return true;
  const prefixes = scope.namePrefixes.map((p) => p.toLowerCase());
  return namesOf(subject).some((name) => {
    const lower = name.toLowerCase();
    if (prefixes.some((p) => lower.startsWith(p))) return true;
    const ns = namespaceOf(name);
    return ns !== null && scope.namespaces.includes(ns);
  });
};

/** The labelled sentence that sets a scoped number against its org-wide contrast. */
export const scopeContrastNote = (scope: AppScope, noun: string, scoped: number, orgWide: number): string =>
  scope.orgWide
    ? `Org-wide: ${orgWide} ${noun}${scope.configError !== undefined ? ` (${scope.configError} — no app scope applied)` : ' — no app scope declared (org-kb/config/app-scope.json) or passed (`scope`)'}.`
    : `In app scope (${[...scope.namePrefixes.map((p) => `prefix ${p}`), ...scope.namespaces.map((n) => `namespace ${n}`)].join(', ')}; from ${scope.source}): ${scoped} ${noun} — this is the answer. Org-wide contrast: ${orgWide}, which also counts installed packages and whichever standard objects the retrieve included.`;
