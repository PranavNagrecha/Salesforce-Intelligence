import type { Edge } from '@sf-intelligence/contracts';

import type { OmniProcessDoc } from './process.js';
import { literalObjectArgs } from './remote.js';

/**
 * Save-for-later `saveURLPatterns` on an OmniScript's top-level
 * `propertySetConfig`: each key is a field api name whose value is written
 * when the runtime stores a resume link. The object is never inferred from the
 * key (no `Object.Field` splitting); it must be declared on the script.
 */

/** Config keys that carry a literal SObject api name for save-for-later. */
const SAVE_OBJECT_CONFIG_KEYS = [
  'saveObject',
  'objectType',
  'sObjectType',
  'lkObjName',
] as const;

const LITERAL_OBJECT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** True when `value` is a plain object api name, not a merge field or formula. */
export const literalSaveObjectApiName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed.charAt(0);
  if (first === '%' || first === '{' || first === '$') return null;
  return LITERAL_OBJECT.test(trimmed) ? trimmed : null;
};

const collectDeclaredSaveObjects = (doc: OmniProcessDoc): readonly string[] => {
  const objects = new Set<string>();
  const scanConfig = (cfg: Readonly<Record<string, unknown>> | null): void => {
    if (cfg === null) return;
    for (const key of SAVE_OBJECT_CONFIG_KEYS) {
      const lit = literalSaveObjectApiName(cfg[key]);
      if (lit !== null) objects.add(lit);
    }
    for (const o of literalObjectArgs(cfg)) objects.add(o);
  };
  scanConfig(doc.header.propertySetConfig);
  for (const el of doc.elements) {
    if (el.canonicalType === 'DataRaptor Post Action') scanConfig(el.config);
  }
  return [...objects].sort();
};

/** A `saveURLPatterns` key that names a single field on the declared save object. */
export const isSaveUrlPatternFieldKey = (key: string): boolean => {
  const k = key.trim();
  if (k.length === 0) return false;
  if (k.includes('.')) return false;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(k);
};

export type UnresolvedSaveUrlPatternReason =
  | 'no-declared-save-object'
  | 'ambiguous-save-object'
  | 'not-a-field-name';

/** A pattern that did not mint a `writesTo` edge, with why. */
export interface UnresolvedSaveUrlPattern {
  readonly field: string;
  readonly reason: UnresolvedSaveUrlPatternReason;
}

/**
 * Mint `writesTo` edges for top-level `saveURLPatterns` keys against the
 * script's declared save object, and collect patterns that could not resolve.
 */
export const buildSaveUrlPatternWrites = (
  fromId: string,
  doc: OmniProcessDoc,
  source: string,
): {
  readonly edges: readonly Edge[];
  readonly unresolvedSavePatterns: readonly UnresolvedSaveUrlPattern[];
} => {
  const raw = doc.header.propertySetConfig?.['saveURLPatterns'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { edges: [], unresolvedSavePatterns: [] };
  }
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' && v.trim().length > 0,
  );
  if (entries.length === 0) return { edges: [], unresolvedSavePatterns: [] };

  const declared = collectDeclaredSaveObjects(doc);
  const saveObject = declared.length === 1 ? declared[0]! : null;

  const edges: Edge[] = [];
  const unresolved: UnresolvedSaveUrlPattern[] = [];

  for (const [rawField] of entries) {
    const field = rawField.trim();
    if (!isSaveUrlPatternFieldKey(field)) {
      unresolved.push({ field: rawField, reason: 'not-a-field-name' });
      continue;
    }
    if (saveObject === null) {
      unresolved.push({
        field,
        reason: declared.length > 1 ? 'ambiguous-save-object' : 'no-declared-save-object',
      });
      continue;
    }
    edges.push({
      fromId,
      toId: `CustomField:${saveObject}.${field}`,
      edgeType: 'writesTo',
      confidence: 'parsed',
      source,
      properties: {
        mechanism: 'saveURLPatterns',
        field,
        saveObject,
      },
    });
  }

  edges.sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  unresolved.sort((a, b) => a.field.localeCompare(b.field));
  return { edges, unresolvedSavePatterns: unresolved };
};
