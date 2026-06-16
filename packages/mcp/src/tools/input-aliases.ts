/**
 * Shared input-alias normalization for MCP tools (TSB-12 / ADR-007).
 *
 * Published tools cannot rename required params without breaking callers, but
 * LLM hosts often guess sibling-tool names (`componentId`, `objectId`, `query`).
 * Each tool keeps its canonical key; aliases are merged in a Zod preprocess
 * step before validation when the canonical value is absent or empty.
 */

/** First non-empty trimmed string among `values`. */
export const firstNonEmpty = (
  ...values: readonly (string | undefined)[]
): string | undefined => {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
};

/**
 * Copy alias keys into canonical keys when the canonical is missing/empty.
 * Returns a shallow clone — does not mutate the input object.
 */
export const mergeInputAliases = (
  raw: unknown,
  merges: ReadonlyArray<{
    readonly canonical: string;
    readonly aliases: readonly string[];
  }>,
): unknown => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const { canonical, aliases } of merges) {
    if (firstNonEmpty(typeof out[canonical] === 'string' ? out[canonical] : undefined)) {
      continue;
    }
    for (const alias of aliases) {
      const picked = firstNonEmpty(typeof out[alias] === 'string' ? out[alias] : undefined);
      if (picked !== undefined) {
        out[canonical] = picked;
        break;
      }
    }
  }
  return out;
};

/** Bare api name or `CustomObject:X` → `CustomObject:X`. */
export const toCustomObjectId = (raw: string): string =>
  raw.startsWith('CustomObject:') ? raw : `CustomObject:${raw}`;

/** `CustomObject:X` or bare api name → bare api name. */
export const toObjectApiName = (raw: string): string =>
  raw.startsWith('CustomObject:') ? raw.slice('CustomObject:'.length) : raw;

/** Bare `Object.Layout` or `Layout:Object.Layout` → canonical layout id. */
export const toLayoutId = (raw: string): string =>
  raw.startsWith('Layout:') ? raw : `Layout:${raw}`;

/** Bare profile api name → `Profile:{ApiName}` (PermissionSet uses explicit alias). */
export const toProfileOrPermSetId = (raw: string): string =>
  raw.startsWith('Profile:') || raw.startsWith('PermissionSet:')
    ? raw
    : `Profile:${raw}`;

/** Parse `CustomField:ObjectApi.FieldApi` → bare object api name. */
export const parseFieldParentObjectApiName = (fieldId: string): string | null => {
  if (!fieldId.startsWith('CustomField:')) return null;
  const rest = fieldId.slice('CustomField:'.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  return rest.slice(0, dot);
};

/**
 * Resolve optional object scope from `objectId` / `objectApiName` aliases.
 * Returns canonical `CustomObject:{ApiName}` or `undefined` when unscoped.
 */
export const resolveObjectScopeParentId = (input: {
  readonly objectId?: string | undefined;
  readonly objectApiName?: string | undefined;
}): string | undefined => {
  const raw = firstNonEmpty(input.objectId, input.objectApiName);
  return raw === undefined ? undefined : toCustomObjectId(raw);
};

/** Whether a CustomField node belongs to the scoped parent object. */
export const fieldMatchesObjectScope = (
  fieldNode: { readonly id: string; readonly parentId: string | null },
  scopeParentId: string,
): boolean => {
  if (fieldNode.parentId === scopeParentId) return true;
  const fromId = parseFieldParentObjectApiName(fieldNode.id);
  if (fromId === null) return false;
  return fromId === toObjectApiName(scopeParentId);
};

/**
 * Turn raw sf CLI stderr/stdout into an actionable message when the failure
 * looks like an outdated CLI/plugin (common live-plane footgun).
 */
export const formatSfCliFailure = (message: string): string => {
  const lower = message.toLowerCase();
  const staleHints =
    lower.includes('update available') ||
    (lower.includes('not found') && lower.includes('@salesforce/cli')) ||
    (lower.includes('plugin') && lower.includes('not installed')) ||
    (/\b2\.\d+\.\d+\b/.test(message) && lower.includes('deprecated'));
  if (!staleHints) return message;
  return (
    `${message.trim()} — The live plane requires a current Salesforce CLI ` +
    `(run \`sf version\` locally; upgrade with \`sf update\` or \`npm i -g @salesforce/cli@latest\`, ` +
    `then retry). Vault tools are unaffected.`
  );
};
