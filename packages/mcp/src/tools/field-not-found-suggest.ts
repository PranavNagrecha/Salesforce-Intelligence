/**
 * FLD-04 — resolve auto-suggestions when a field tool hits `component-not-found`.
 *
 * When a caller passes a mistyped or slightly-wrong CustomField id, field
 * tools attach ranked `resolveSuggestions` (from the same `resolveComponents`
 * engine as `sfi.resolve`) so the user can self-correct without a separate
 * resolve round-trip.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  ResolveSuggestion,
} from '@sf-intelligence/contracts';
import { resolveComponents } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

const CUSTOM_FIELD_PREFIX = 'CustomField:';
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

const SUGGESTION_LIMIT = 5;

/** Verbatim note appended to the error message when suggestions exist. */
const SUGGESTIONS_NOTE =
  ' Typo-tolerant resolve suggestions are attached in `resolveSuggestions` — heuristic matches only; confirm the canonical id before acting.';

/**
 * Build a fuzzy-resolve query from a CustomField-shaped id. Uses the field
 * api name when present; falls back to the full string after the prefix.
 */
export const fieldIdToResolveQuery = (fieldId: string): string => {
  const raw = fieldId.startsWith(CUSTOM_FIELD_PREFIX)
    ? fieldId.slice(CUSTOM_FIELD_PREFIX.length)
    : fieldId;
  const dot = raw.indexOf('.');
  if (dot < 0) return raw;
  const objectApi = raw.slice(0, dot);
  const fieldApi = raw.slice(dot + 1);
  // Prefer the field token; include object context when the field name is generic.
  if (fieldApi.length <= 3 || /^[A-Z][a-z]+$/.test(fieldApi)) {
    return `${objectApi} ${fieldApi}`;
  }
  return fieldApi;
};

/** Infer parent object id for scoping resolve to one object's fields. */
const parentObjectIdFromFieldId = (fieldId: string): ComponentId | undefined => {
  const raw = fieldId.startsWith(CUSTOM_FIELD_PREFIX)
    ? fieldId.slice(CUSTOM_FIELD_PREFIX.length)
    : fieldId;
  const dot = raw.indexOf('.');
  if (dot < 1) return undefined;
  return `${CUSTOM_OBJECT_PREFIX}${raw.slice(0, dot)}` as ComponentId;
};

/**
 * Ranked CustomField candidates for a not-found `fieldId`. Returns an empty
 * array when resolve finds nothing useful.
 */
export const buildFieldResolveSuggestions = async (
  ctx: Context,
  fieldId: string,
): Promise<readonly ResolveSuggestion[]> => {
  const query = fieldIdToResolveQuery(fieldId);
  if (query.length === 0) return [];

  const parentId = parentObjectIdFromFieldId(fieldId);
  const resolved = await resolveComponents(ctx.graph, query, {
    types: ['CustomField' as ComponentType],
    limit: SUGGESTION_LIMIT,
    ...(parentId !== undefined ? { parentId } : {}),
  });
  if (!resolved.ok || resolved.value.candidates.length === 0) return [];

  // Never suggest the exact id the caller already tried.
  return resolved.value.candidates
    .filter((c) => c.id !== fieldId)
    .map((c) => ({
      componentId: c.id,
      type: c.type,
      apiName: c.apiName,
      score: c.score,
      matchKind: c.matchKind,
    }));
};

/**
 * Build a `component-not-found` error with optional resolve suggestions.
 */
export const fieldNotFoundError = async (
  ctx: Context,
  fieldId: ComponentId,
  message: string,
): Promise<McpError> => {
  const resolveSuggestions = await buildFieldResolveSuggestions(ctx, fieldId);
  const withNote =
    resolveSuggestions.length > 0 ? `${message}${SUGGESTIONS_NOTE}` : message;
  return {
    kind: 'component-not-found',
    message: withNote,
    path: fieldId,
    ...(resolveSuggestions.length > 0 ? { resolveSuggestions } : {}),
  };
};
