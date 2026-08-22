/**
 * Shared input-alias normalization for MCP tools (TSB-12 / ADR-007).
 *
 * Published tools cannot rename required params without breaking callers, but
 * LLM hosts often guess sibling-tool names (`componentId`, `objectId`, `query`).
 * Each tool keeps its canonical key; aliases are merged in a Zod preprocess
 * step before validation when the canonical value is absent or empty.
 *
 * L2 "Alias OS" (ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): a router recommends an
 * admin/support tool, the host passes the natural identifier for the thing
 * (`objectApiName`, `componentId: CustomObject:…`, `fieldId`), and the tool
 * must accept it, ECHO the scope it resolved (`appliedScope`), and NEVER
 * silently strip a mismatched alias. The `resolveObjectAlias` /
 * `resolveFieldAlias` / `resolveApexClassAlias` / `resolveContainerAlias`
 * resolvers below are the ONE shared normalizer every object- / field- /
 * class- / container-scoped tool routes through: one distinct target → `ok`;
 * disagreeing aliases or (when required) none → `invalid-query`.
 *
 * They are called from HANDLERS, never from `z.preprocess`. That is not a
 * style preference: a preprocess step cannot emit a NAMED `invalid-query` —
 * throwing from it yields a bare Zod error — and `z.object` strips unknown
 * keys, so a marker smuggled out of preprocess vanishes silently.
 * `mergeInputAliases` therefore stays first-wins on purpose; refusing is the
 * resolvers' job.
 */

import type { ComponentId, McpError } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, type GraphStore } from '@sf-intelligence/graph';

import { coercePrefix } from './coerce-id.js';

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

/** Bare Apex class api name or `ApexClass:X` → `ApexClass:X`. */
export const toApexClassId = (raw: string): string =>
  raw.startsWith('ApexClass:') ? raw : `ApexClass:${raw}`;

/** Bare app api name or `CustomApplication:X` → `CustomApplication:X`. */
export const toCustomApplicationId = (raw: string): string =>
  raw.startsWith('CustomApplication:') ? raw : `CustomApplication:${raw}`;

/** Coerce `raw` (or `undefined`) to its trimmed string form when it is a string. */
const asString = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : undefined;

/** Read `key` off a raw object as a trimmed non-empty string, else `undefined`. */
const readNonEmpty = (
  src: Record<string, unknown>,
  key: string,
): string | undefined => firstNonEmpty(asString(src[key]));

/** Narrow arbitrary tool input to a plain record (empty when not an object). */
const asRecord = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

/**
 * Collapse a candidate list to distinct entries in first-seen order, then
 * return `ok(value)` when exactly one distinct id survives. Zero →
 * `invalid-query` with `emptyMessage` (unless `required` is false, which yields
 * `ok(null)` for a legitimately-unscoped reverse mode). Two or more DISTINCT
 * ids → `invalid-query` naming them (never a silent pick — the strip this
 * whole module exists to kill).
 */
const oneDistinct = (
  candidates: readonly string[],
  opts: {
    readonly required: boolean;
    readonly emptyMessage: string;
    readonly conflictMessage: (distinct: readonly string[]) => string;
    readonly path: string;
  },
): Result<string | null, McpError> => {
  const distinct = [...new Set(candidates)];
  if (distinct.length === 0) {
    if (!opts.required) return ok(null);
    return err({ kind: 'invalid-query', message: opts.emptyMessage, path: opts.path });
  }
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: opts.conflictMessage(distinct),
      path: opts.path,
    });
  }
  return ok(distinct[0] as string);
};

/** A resolved object scope: the canonical id AND its bare api name, for `appliedScope`. */
export interface ResolvedObjectScope {
  /** Canonical `CustomObject:<ApiName>`. */
  readonly componentId: string;
  /** Bare object api name (`Contact`). */
  readonly object: string;
}

/** Options for {@link resolveObjectAlias}. */
export interface ResolveObjectAliasOptions {
  /**
   * Whether a `componentId` with NO `:` (a bare api name) is treated as an
   * object. `true` for object-only tools (`automation_collisions`,
   * `what_happens_on_save`, …). `false` for POLYMORPHIC tools whose bare /
   * other-prefix `componentId` is their own reverse mode (`layout_assignments`
   * treats a bare id as a `Layout:`; `lightning_pages` / `list_view_sharing`
   * carry `FlexiPage:` / `ListView:` reverse modes) — there only a
   * `CustomObject:` `componentId` counts as an object alias. Default `true`.
   */
  readonly bareComponentIdIsObject?: boolean;
  /**
   * Whether "no object named" is an error. `true` (default) → `invalid-query`.
   * `false` → `ok(null)` so a polymorphic tool in reverse mode can proceed.
   */
  readonly required?: boolean;
  /**
   * What to do with a `componentId` carrying a prefix that is NOT
   * `CustomObject:`.
   *
   * - `'ignore'` (default) — today's behaviour: the prefix is left alone so the
   *   tool's OWN reverse branch keeps it (`layout_assignments` reads `Layout:`,
   *   `lightning_pages` reads `FlexiPage:`, `list_view_sharing` reads
   *   `ListView:`). Dropping it here is correct for those tools because they
   *   handle it themselves.
   * - `'refuse'` — the caller has NO reverse branch, so an unhandled prefix
   *   would fall through to `ok(null)` and SILENTLY widen the answer to
   *   org-wide. Refuse with a named `invalid-query` instead.
   *
   * Default `'ignore'`, so no existing caller moves a byte.
   */
  readonly unhandledPrefix?: 'ignore' | 'refuse';
}

/**
 * OBJECT-SCOPE-PREFIX-REFUSAL — verbatim refusal for a `componentId` whose
 * prefix this tool cannot scope by. Product copy; do not reword.
 */
const unhandledPrefixMessage = (cid: string): string => {
  const type = cid.slice(0, cid.indexOf(':'));
  return (
    `componentId '${cid}' is a ${type}: id, and this tool scopes only by OBJECT. It was ` +
    'NOT applied — pass objectApiName / object / objectId, or a CustomObject: id. ' +
    'Refusing rather than returning the org-wide report, which would answer a question you did not ask.'
  );
};

/**
 * Resolve a single object scope from the interchangeable object identifiers a
 * router / host may pass: `object`, `objectApiName`, `objectId`, and a
 * `componentId` that is a `CustomObject:` id (or a bare api name when
 * `bareComponentIdIsObject`). Every value is coerced to canonical
 * `CustomObject:<ApiName>` and de-duplicated. Echo the returned
 * `componentId` / `object` back as `appliedScope`.
 *
 * Reverse-mode `componentId` prefixes (`Layout:` / `FlexiPage:` / `ListView:`)
 * are NOT object aliases — they are ignored here so the tool's own reverse
 * branch keeps them. A tool with NO reverse branch passes
 * `unhandledPrefix: 'refuse'` so an unhandled prefix becomes a named
 * `invalid-query` instead of a silent widening to org-wide.
 */
export const resolveObjectAlias = (
  raw: unknown,
  opts: ResolveObjectAliasOptions = {},
): Result<ResolvedObjectScope | null, McpError> => {
  const bareIsObject = opts.bareComponentIdIsObject ?? true;
  const required = opts.required ?? true;
  const unhandledPrefix = opts.unhandledPrefix ?? 'ignore';
  const src = asRecord(raw);

  const candidates: string[] = [];
  for (const key of ['object', 'objectApiName', 'objectId'] as const) {
    const v = readNonEmpty(src, key);
    if (v !== undefined) candidates.push(toCustomObjectId(v));
  }
  const cid = readNonEmpty(src, 'componentId');
  if (cid !== undefined) {
    if (cid.startsWith('CustomObject:')) candidates.push(cid);
    else if (bareIsObject && !cid.includes(':')) candidates.push(toCustomObjectId(cid));
    else if (unhandledPrefix === 'refuse' && cid.includes(':')) {
      // The caller has no reverse branch for this prefix, so ignoring it would
      // silently widen the answer to org-wide. Name it and refuse.
      return err({
        kind: 'invalid-query',
        message: unhandledPrefixMessage(cid),
        path: 'componentId',
      });
    }
    // else: a reverse-mode prefix (Layout:/FlexiPage:/ListView:) — not an object alias.
  }

  const resolved = oneDistinct(candidates, {
    required,
    emptyMessage:
      'name the object — pass `objectApiName` (e.g. "Account"), `object`, `objectId`, or a `CustomObject:` `componentId`',
    conflictMessage: (distinct) =>
      `object aliases name different targets (${distinct.join(', ')}); pass exactly one of object / objectApiName / objectId / componentId`,
    path: 'objectApiName',
  });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);
  const componentId = resolved.value;
  return ok({ componentId, object: toObjectApiName(componentId) });
};

/**
 * Resolve an OPTIONAL object scope for an object-scoped analysis tool and
 * VERIFY the named object exists in the vault. The honor half of the
 * silent-object-scope-ignore fix: a tool that CAN attribute its findings to an
 * object routes its `objectApiName` / `object` / `objectId` / `CustomObject:`
 * `componentId` through here, then filters to the returned id and emits
 * `appliedScope`. Returns:
 *   - `ok(null)` — the caller named NO object (bare call); the tool stays
 *     org-wide and its response is byte-identical to the pre-scope shape.
 *   - `ok({componentId, object})` — exactly one object was named AND a
 *     `CustomObject:` node for it exists in the graph.
 *   - `err(invalid-query)` — object aliases disagree, or the named object is
 *     absent from the vault. An unresolvable scope is REFUSED, never silently
 *     widened back to the org-wide result (the whole point of the fix).
 */
export const resolveExistingObjectScope = async (
  graph: GraphStore,
  raw: unknown,
  opts: Pick<ResolveObjectAliasOptions, 'unhandledPrefix'> = {},
): Promise<Result<ResolvedObjectScope | null, McpError>> => {
  const resolved = resolveObjectAlias(raw, {
    required: false,
    bareComponentIdIsObject: true,
    ...(opts.unhandledPrefix !== undefined ? { unhandledPrefix: opts.unhandledPrefix } : {}),
  });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);
  const { componentId, object } = resolved.value;
  const node = await getNodeById(graph, componentId as ComponentId);
  if (!node.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
  }
  if (node.value === null) {
    return err({
      kind: 'invalid-query',
      message:
        `no object named '${object}' exists in this vault (resolved to ${componentId}); ` +
        'verify the object api name, or run /sfi-refresh if the vault may be stale',
      path: 'objectApiName',
    });
  }
  return ok(resolved.value);
};

/** A resolved field scope: the field identifier to hand to the tool's field resolver. */
export interface ResolvedFieldScope {
  /**
   * The `CustomField:<Object>.<Field>` canonical id or `<Object>.<Field>`
   * short form — whatever the caller supplied. The tool's own
   * `normalizeFieldId` / `resolveToFieldOrSuggest` still governs prefix rules
   * and object→field routing; this resolver only picks the single value.
   */
  readonly fieldId: string;
}

/**
 * Resolve a single field scope from `fieldId` and its `componentId` alias (the
 * `CustomField:…` id a host reaches for). One value → `ok`; both present and
 * DISAGREEING → `invalid-query`; neither → `invalid-query`. The winning value
 * is echoed by the tool as its output `fieldId`.
 */
export const resolveFieldAlias = (
  raw: unknown,
): Result<ResolvedFieldScope, McpError> => {
  const src = asRecord(raw);
  const candidates: string[] = [];
  for (const key of ['fieldId', 'componentId'] as const) {
    const v = readNonEmpty(src, key);
    if (v !== undefined) candidates.push(v);
  }
  const resolved = oneDistinct(candidates, {
    required: true,
    emptyMessage:
      'name the field — pass `fieldId` or `componentId` (e.g. "CustomField:Account.My_Field__c")',
    conflictMessage: (distinct) =>
      `fieldId / componentId name different targets (${distinct.join(', ')}); pass exactly one`,
    path: 'fieldId',
  });
  if (!resolved.ok) return resolved;
  return ok({ fieldId: resolved.value as string });
};

/** A resolved Apex-class scope: canonical id AND bare api name, for `appliedScope`. */
export interface ResolvedApexClassScope {
  /** Canonical `ApexClass:<ApiName>`. */
  readonly componentId: string;
  /** Bare class api name (`AccountService`). */
  readonly apexClass: string;
}

/**
 * Resolve a single Apex class from `componentId` (`ApexClass:X`) and the
 * `classApiName` / `apiName` aliases a host reaches for. Bare names are coerced
 * to `ApexClass:<ApiName>`; one distinct target → `ok`; disagreeing → conflict;
 * none → `invalid-query`.
 */
export const resolveApexClassAlias = (
  raw: unknown,
): Result<ResolvedApexClassScope, McpError> => {
  const src = asRecord(raw);
  const candidates: string[] = [];
  const cid = readNonEmpty(src, 'componentId');
  if (cid !== undefined) candidates.push(toApexClassId(cid));
  for (const key of ['classApiName', 'apiName'] as const) {
    const v = readNonEmpty(src, key);
    if (v !== undefined) candidates.push(toApexClassId(v));
  }
  const resolved = oneDistinct(candidates, {
    required: true,
    emptyMessage:
      'name the Apex class — pass `classApiName` (e.g. "AccountService") or an `ApexClass:` `componentId`',
    conflictMessage: (distinct) =>
      `class aliases name different targets (${distinct.join(', ')}); pass exactly one of componentId / classApiName / apiName`,
    path: 'classApiName',
  });
  if (!resolved.ok) return resolved;
  const componentId = resolved.value as string;
  return ok({ componentId, apexClass: componentId.slice('ApexClass:'.length) });
};

/** A resolved permission CONTAINER scope: a Profile or a PermissionSet. */
export interface ResolvedContainerScope {
  /** Canonical `Profile:<ApiName>` or `PermissionSet:<ApiName>`. */
  readonly componentId: string;
  /**
   * Which container family the id names.
   *
   * Only meaningful once the caller has confirmed `componentId` carries a
   * `Profile:` / `PermissionSet:` prefix. A `componentId` bearing some OTHER
   * `Type:` prefix is deliberately passed through unchanged (see below) so the
   * caller's own wrong-type check produces its precise message; for that value
   * this field reads `'Profile'` and means nothing.
   */
  readonly containerType: 'Profile' | 'PermissionSet';
  /** Bare container api name, with the container prefix stripped. */
  readonly apiName: string;
}

/**
 * Resolve a single permission CONTAINER from the interchangeable selectors a
 * router / host may pass: `componentId`, `profileId` / `profileApiName` /
 * `profileName`, and `permissionSetId` / `permissionSetApiName` /
 * `permissionSetName`.
 *
 * ## Coercion is per key, by the KEY'S OWN name
 *
 * This is the whole point. The per-tool `z.preprocess` hack this replaces took
 * the VALUE from one key and the PREFIX from the mere PRESENCE of another, so
 * `{ profileApiName: 'X', permissionSetApiName: 'Y' }` answered about
 * `PermissionSet:X` — a THIRD component neither selector named, whose answer
 * differs materially. Here a `profile*` key can only ever produce a `Profile:`
 * id from a bare name, a `permissionSet*` key only a `PermissionSet:` one, and
 * two selectors naming different components are REFUSED.
 *
 * A `componentId` (or any selector value) that already carries a DIFFERENT
 * `Type:` prefix is returned UNCHANGED — `coercePrefix`'s wrong-type branch —
 * so the caller's own `Profile:`/`PermissionSet:` check rejects it with its
 * precise message instead of it being mangled into `Profile:CustomObject:…`
 * and 404-ing as a phantom.
 *
 * The refusal grammar is deliberately identical to `profile_security`'s
 * private `resolveProfileRef`, so the two never read as different products.
 */
export const resolveContainerAlias = (
  raw: unknown,
  opts: { readonly required?: boolean } = {},
): Result<ResolvedContainerScope | null, McpError> => {
  const required = opts.required ?? true;
  const src = asRecord(raw);

  const candidates: string[] = [];
  // Profile-family keys: a bare name is a PROFILE api name.
  for (const key of ['profileId', 'profileApiName', 'profileName'] as const) {
    const v = readNonEmpty(src, key);
    if (v !== undefined) candidates.push(coercePrefix(v, ['Profile:', 'PermissionSet:']));
  }
  // PermissionSet-family keys: a bare name is a PERMISSION SET api name.
  for (const key of [
    'permissionSetId',
    'permissionSetApiName',
    'permissionSetName',
  ] as const) {
    const v = readNonEmpty(src, key);
    if (v !== undefined) candidates.push(coercePrefix(v, ['PermissionSet:', 'Profile:']));
  }
  // Canonical `componentId`: a bare name keeps the historical Profile default.
  const cid = readNonEmpty(src, 'componentId');
  if (cid !== undefined) candidates.push(coercePrefix(cid, ['Profile:', 'PermissionSet:']));

  const resolved = oneDistinct(candidates, {
    required,
    emptyMessage:
      'name the profile or permission set — pass `componentId` (`Profile:X` / `PermissionSet:X`) or the natural `profileApiName` / `permissionSetApiName` selector',
    conflictMessage: (distinct) =>
      `container selectors name different targets (${distinct.join(', ')}); pass exactly one of componentId / profileId / profileApiName / permissionSetId / permissionSetApiName`,
    path: 'componentId',
  });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);
  const componentId = resolved.value;
  const isPermSet = componentId.startsWith('PermissionSet:');
  const apiName = isPermSet
    ? componentId.slice('PermissionSet:'.length)
    : componentId.startsWith('Profile:')
      ? componentId.slice('Profile:'.length)
      : componentId;
  return ok({
    componentId,
    containerType: isPermSet ? 'PermissionSet' : 'Profile',
    apiName,
  });
};

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
