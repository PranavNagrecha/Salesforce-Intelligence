import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * Per-vault OmniStudio configuration — `org-kb/config/omnistudio.json`.
 *
 * Some behaviour cannot be read from metadata: what the org's own "generic
 * upsert" Apex does with the rows it is handed, which call marks a section
 * Complete, which method writes log records, which name prefixes the org's
 * developers confuse. The vault owner declares those facts here; the engine
 * uses them instead of guessing, and reports every use of one as `declared`
 * by configuration. The file never ships with the product.
 *
 * Absent file → the defaults below (no adapters, no markers) plus the
 * heuristic generic-upsert recognizer, whose results are always `inferred`.
 */

const callSiteSchema = z.object({
  remoteClass: z.string().min(1),
  remoteMethod: z.string().min(1),
});

const adapterSchema = callSiteSchema.extend({
  recordsParam: z.string().min(1).default('records'),
  objectParam: z.string().min(1).default('objectApiName'),
});

const completionMarkerSchema = z.union([
  callSiteSchema,
  z.object({ integrationProcedureKey: z.string().min(1) }),
]);

export const omniConfigSchema = z
  .object({
    genericUpsertAdapters: z.array(adapterSchema).default([]),
    /**
     * The org's "generic fetch" Apex: returns records keyed by object under
     * `recordsNode` (`<step>:records:<Object>` → rows of field API names).
     */
    genericFetchAdapters: z
      .array(callSiteSchema.extend({ recordsNode: z.string().min(1).default('records') }))
      .default([]),
    completionMarkers: z.array(completionMarkerSchema).default([]),
    loggers: z.array(callSiteSchema).default([]),
    prefixVariants: z.array(z.tuple([z.string().min(1), z.string().min(1)])).default([]),
    appScope: z
      .object({
        namePrefixes: z.array(z.string()).default([]),
        namespaces: z.array(z.string()).default([]),
      })
      .default({ namePrefixes: [], namespaces: [] }),
    customLwcOutputs: z.record(z.array(z.string())).default({}),
    /** Root keys the hosting page / URL passes in when the script launches. */
    launchParameters: z.array(z.string()).default([]),
    /** Form-spec sample overrides, keyed by data-key path. */
    sampleValues: z.record(z.string()).default({}),
    /**
     * Sections the app adds outside the script (a server formula, custom
     * metadata read by Apex): which OmniScript (`Type/SubType`), the step that
     * opens the section, and — as an OmniStudio formula over the script's data
     * — when the section is added. The path simulator checks each for
     * DEAD_END_SECTION.
     */
    sectionEntries: z
      .array(
        z.object({
          omniscript: z.string().min(1),
          step: z.string().min(1),
          enteredWhen: z.string().min(1),
          section: z.string().min(1).optional(),
        }),
      )
      .default([]),
  })
  .passthrough();

/** The parsed configuration. */
export type OmniConfig = z.infer<typeof omniConfigSchema>;

/** Where the config came from — reported on every response that used it. */
export interface OmniConfigSource {
  readonly path: string;
  readonly status: 'loaded' | 'absent' | 'invalid';
  readonly error?: string;
}

/** Vault-relative location of the config file. */
export const OMNI_CONFIG_RELATIVE_PATH = join('config', 'omnistudio.json');

export const DEFAULT_OMNI_CONFIG: OmniConfig = omniConfigSchema.parse({});

/**
 * Load the vault's OmniStudio config. Never throws: an invalid file is
 * reported (`status: 'invalid'`) and the defaults are used, so a typo in the
 * config cannot silently turn a finding into "no finding" — the caller
 * surfaces the source status alongside the answer.
 */
export const loadOmniConfig = async (
  vaultRoot: string,
): Promise<{ readonly config: OmniConfig; readonly source: OmniConfigSource }> => {
  const path = join(vaultRoot, OMNI_CONFIG_RELATIVE_PATH);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { config: DEFAULT_OMNI_CONFIG, source: { path, status: 'absent' } };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause: unknown) {
    return {
      config: DEFAULT_OMNI_CONFIG,
      source: { path, status: 'invalid', error: cause instanceof Error ? cause.message : String(cause) },
    };
  }
  const parsed = omniConfigSchema.safeParse(json);
  if (!parsed.success) {
    return {
      config: DEFAULT_OMNI_CONFIG,
      source: { path, status: 'invalid', error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    };
  }
  return { config: parsed.data, source: { path, status: 'loaded' } };
};

/**
 * True when `remoteClass.remoteMethod` matches a configured call site.
 * Compared TRIMMED: recognising "this is the logger" must not depend on a
 * stray space in the metadata — that space is reported on its own as a
 * whitespace defect, with its runtime effect left `unknown`.
 */
export const matchesCallSite = (
  sites: readonly { readonly remoteClass: string; readonly remoteMethod: string }[],
  remoteClass: string | null,
  remoteMethod: string | null,
): boolean =>
  remoteClass !== null &&
  remoteMethod !== null &&
  sites.some(
    (s) => s.remoteClass.trim() === remoteClass.trim() && s.remoteMethod.trim() === remoteMethod.trim(),
  );
