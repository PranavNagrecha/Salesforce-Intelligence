/**
 * Shared helper for graceful object→field routing in field tools.
 *
 * When a caller passes a `CustomObject:Foo` id (or a bare `Foo` that
 * matches a known object) to a field tool, it's almost always a user
 * mistake — they want a specific field but didn't drill down first.
 * Rather than returning a cryptic `invalid-query` error, field tools
 * that use this helper return the object's field list so the caller can
 * immediately retry with the right id.
 *
 * Exported symbol: `resolveToFieldOrSuggest`.
 * Returns `null` when the input IS already a field id (happy path).
 * Returns a `McpResponse`-shaped suggestion payload when the input
 * looks like an object id, so the handler can return early with a
 * score of 1–2 (actionable guidance, not a 0/error).
 *
 * The detection heuristic (evaluated in order):
 *   1. Starts with `CustomObject:` → definitely an object id.
 *   2. Has no dot separator AND has no `:` prefix AND a `CustomObject:{raw}`
 *      node exists in the graph → treated as an object ApiName.
 *
 * In both cases the helper fetches every `CustomField` child of that object
 * (via `listChildren`) and returns a structured suggestion.
 */

import type { ComponentId, McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listChildren } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

const CUSTOM_OBJECT_PREFIX = 'CustomObject:';
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** The structured suggestion payload returned when an object id was passed. */
export interface ObjectFieldSuggestion {
  /** The canonical id of the object that was passed. */
  readonly objectId: ComponentId;
  /** The apiName of the object. */
  readonly objectApiName: string;
  /** Human-readable guidance message. */
  readonly message: string;
  /**
   * The field ids found on this object, sorted by id ASC. Caller can
   * pass any of these directly to the same tool.
   */
  readonly fieldIds: readonly ComponentId[];
  /** Field apiNames in the same order as `fieldIds`. */
  readonly fieldApiNames: readonly string[];
  /** Always 1 — user gets actionable guidance even though they passed the wrong id. */
  readonly score: 1;
}

/** Wraps a `McpResponse` around the suggestion for direct handler return. */
export type FieldSuggestionResponse = McpResponse<ObjectFieldSuggestion>;

/**
 * Determine whether `raw` looks like a CustomObject id (either canonical
 * `CustomObject:Foo` form or a bare `Foo` that resolves to an object).
 *
 * Returns the canonical `CustomObject:` id when the input looks like an
 * object, or `null` when it does not match.
 */
const detectObjectId = async (
  ctx: Context,
  raw: string,
): Promise<ComponentId | null> => {
  // Case 1: explicit CustomObject: prefix.
  if (raw.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return raw as ComponentId;
  }
  // If there's a colon the caller used a different explicit prefix — let the
  // main handler reject it with its own message; we don't intercept.
  if (raw.includes(':')) return null;
  // If there's a dot it's probably a short-form `Object.Field` — let the
  // normalizer in field_360 (or prefix check in other tools) handle it.
  if (raw.includes('.')) return null;
  // Case 2: bare name — probe whether `CustomObject:{raw}` exists.
  const candidateId = `${CUSTOM_OBJECT_PREFIX}${raw}` as ComponentId;
  const probe = await getNodeById(ctx.graph, candidateId);
  if (!probe.ok) return null; // graph error — don't intercept
  if (probe.value === null) return null; // no such object
  return candidateId;
};

/**
 * Try to resolve `raw` as an object id. When it matches:
 *   1. Fetches all children of the object from the graph.
 *   2. Filters to `CustomField` nodes only.
 *   3. Returns a structured `FieldSuggestionResponse`.
 *
 * Returns `null` when `raw` does NOT look like an object id (the caller
 * should continue its normal field-id validation).
 *
 * Returns `err(McpError)` when the graph lookup fails mid-way.
 */
export const resolveToFieldOrSuggest = async (
  ctx: Context,
  raw: string,
): Promise<Result<FieldSuggestionResponse | null, McpError>> => {
  const objectId = await detectObjectId(ctx, raw);
  if (objectId === null) {
    // Not an object id — caller should proceed with normal validation.
    return ok(null);
  }

  // Fetch the object node to get its apiName.
  const objectNodeResult = await getNodeById(ctx.graph, objectId);
  if (!objectNodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${objectNodeResult.error.message}`,
    });
  }
  // The object might not exist (bare name that resolved via probe but then
  // disappeared — extremely unlikely race, defensive only).
  const objectNode = objectNodeResult.value;
  if (objectNode === null) {
    return ok(null);
  }

  // Fetch all children and keep only CustomField nodes.
  const childrenResult = await listChildren(ctx.graph, objectId);
  if (!childrenResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${childrenResult.error.message}`,
    });
  }
  const fields = childrenResult.value.filter((n) => n.type === 'CustomField');

  const fieldIds = fields.map((f) => f.id);
  const fieldApiNames = fields.map((f) => f.apiName);

  const fieldCount = fields.length;
  const objectApiName = objectNode.apiName;

  const listSnippet =
    fieldCount === 0
      ? 'No CustomField nodes were found for this object in the vault (they may not have been retrieved — run `sfi refresh` to populate).'
      : `Pass one of the ${fieldCount} field id(s) listed in \`fieldIds\` to this tool.`;

  const message =
    `You passed an object id ('${raw}') instead of a field id. ` +
    `Here are the ${fieldCount} custom field(s) on ${objectApiName}. ` +
    listSnippet +
    ` Each entry in \`fieldIds\` uses the canonical \`${CUSTOM_FIELD_PREFIX}{Object}.{Field}\` format.`;

  const suggestion: ObjectFieldSuggestion = {
    objectId,
    objectApiName,
    message,
    fieldIds,
    fieldApiNames,
    score: 1,
  };

  return ok({
    data: suggestion,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
