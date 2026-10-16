import type { Edge } from '@sf-intelligence/contracts';
import type {
  FrontendFieldAccess,
  FrontendUnresolvedFieldBinding,
} from '@sf-intelligence/parsers';

const MARKUP_DECLARED_ORIGINS = new Set([
  'lwc-markup',
  'aura-markup',
  'markup-qualified',
]);

/**
 * Project markup scanner field bindings onto graph edges. Resolved object
 * bindings become `readsFrom` / `writesTo`; qualified-only bindings become
 * `references` to `CustomField:{Object}.{Field}`; bare names are returned
 * for `unresolvedFieldBindings` on the bundle node.
 */
export const buildMarkupFieldBindingEdges = (
  ownerId: string,
  source: string,
  fieldAccesses: readonly FrontendFieldAccess[],
  unresolved: readonly FrontendUnresolvedFieldBinding[],
): {
  readonly edges: readonly Edge[];
  readonly unresolvedFieldBindings: readonly string[];
} => {
  const raw: Edge[] = [];
  const fieldEdges = new Map<string, Edge>();

  for (const access of fieldAccesses) {
    if (!MARKUP_DECLARED_ORIGINS.has(access.origin)) continue;
    const toId = `CustomField:${access.object}.${access.field}`;
    if (access.origin === 'markup-qualified') {
      raw.push({
        fromId: ownerId,
        toId,
        edgeType: 'references',
        confidence: 'declared',
        source,
        properties: {
          mechanism: 'markup-binding',
          bindingKind: access.type,
        },
      });
      continue;
    }
    const edgeType = access.type === 'write' ? 'writesTo' : 'readsFrom';
    const key = `${edgeType}|${toId}`;
    if (fieldEdges.has(key)) continue;
    fieldEdges.set(key, {
      fromId: ownerId,
      toId,
      edgeType,
      confidence: 'declared',
      source,
      properties: {
        mechanism: 'markup-binding',
        offset: access.offset,
        length: access.length,
      },
    });
  }
  raw.push(...fieldEdges.values());

  const unresolvedFieldBindings = [
    ...new Set(unresolved.map((u) => u.fieldName)),
  ].sort();

  return { edges: raw, unresolvedFieldBindings };
};
