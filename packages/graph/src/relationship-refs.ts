import type { Edge, Node } from '@sf-intelligence/contracts';

/**
 * Import-time relationship resolution — the layer that can see every object at
 * once, and therefore the only layer that can turn a relationship traversal into
 * a real edge.
 *
 * Two producers hand it unresolved work as node properties, because neither can
 * resolve it from the single file it parsed:
 *
 *   `formulaRelationshipRefs`  on a CustomField — cross-object formula paths
 *                              (`Parent__r.Status__c`). The leading segment is a
 *                              relationship name, so the target object is not
 *                              knowable from the formula's own file.
 *   `relatedListFieldRefs`     on a FlexiPage — dynamic related-list columns,
 *                              which are BARE field names on the RELATED object.
 *
 * Both used to be dropped, which is why a field read only through a traversal,
 * or shown only in a dynamic related list, could report zero referrers and be
 * certified deletable.
 *
 * The honesty rule this module keeps: **resolve or drop, never guess.** A
 * traversal whose relationship cannot be mapped to a vaulted object mints no
 * edge at all, exactly as before — a dangling `CustomField:` id that never
 * resolves would be worse than the absence, because it would present as
 * evidence. Nothing here invents a target.
 */

/** `CustomObject:Foo` -> `Foo`; anything else -> `null`. */
const objectApiNameOf = (parentId: string | null): string | null => {
  if (parentId === null) return null;
  const prefix = 'CustomObject:';
  return parentId.startsWith(prefix) ? parentId.slice(prefix.length) : null;
};

/**
 * The two directions a relationship can be traversed, both derived from the same
 * lookup / master-detail CustomField nodes.
 *
 *   `parentward`  keyed `{owningObject}|{relationship}` -> the object the lookup
 *                 POINTS AT. A lookup `Enrollment__c.Student__c` is spelled
 *                 `Student__r` in a formula on Enrollment__c and resolves to the
 *                 referenced object. Keys are lower-cased: formula and metadata
 *                 casing does not reliably match the vaulted api name.
 *
 *   `childward`   keyed `{relationshipName}` -> the object that HOLDS the
 *                 lookup. This is the related-list direction: a page on the
 *                 parent names `Course_Enrollments__r`, which is the
 *                 `relationshipName` declared on the child's lookup field, and
 *                 the columns beneath it are fields on that child object.
 *
 * A relationship name that is ambiguous across objects (the same child
 * relationship name declared on two different objects) is DROPPED from the
 * childward map rather than resolved arbitrarily — same ambiguity guard the
 * case-canonicalisation passes use.
 */
interface RelationshipMaps {
  readonly parentward: ReadonlyMap<string, string>;
  readonly childward: ReadonlyMap<string, string>;
}

const AMBIGUOUS = Symbol('ambiguous');

export const buildRelationshipMaps = (
  nodes: readonly Node[],
): RelationshipMaps => {
  const parentward = new Map<string, string>();
  const childward = new Map<string, string | typeof AMBIGUOUS>();

  for (const node of nodes) {
    if (node.type !== 'CustomField') continue;
    const owningObject = objectApiNameOf(node.parentId);
    if (owningObject === null) continue;
    const referenceTo = node.properties['referenceTo'];
    if (typeof referenceTo !== 'string' || referenceTo.length === 0) continue;

    // Parentward: the traversal spelling is the field api name with the custom
    // suffix swapped (`Student__c` -> `Student__r`). A standard lookup
    // (`OwnerId` -> `Owner`) carries no `__c`, so its traversal spelling is the
    // api name minus a trailing `Id`.
    const fieldApiName = node.apiName;
    const traversal = fieldApiName.endsWith('__c')
      ? `${fieldApiName.slice(0, -3)}__r`
      : fieldApiName.replace(/Id$/, '');
    if (traversal.length > 0) {
      parentward.set(
        `${owningObject.toLowerCase()}|${traversal.toLowerCase()}`,
        referenceTo,
      );
    }

    // Childward: the related-list name declared on this lookup, spelled `__r`
    // when traversed. Both spellings are indexed so a caller can pass either.
    const relationshipName = node.properties['relationshipName'];
    if (typeof relationshipName === 'string' && relationshipName.length > 0) {
      for (const key of [relationshipName, `${relationshipName}__r`]) {
        const lower = key.toLowerCase();
        const existing = childward.get(lower);
        if (existing === undefined) {
          childward.set(lower, owningObject);
        } else if (existing !== owningObject) {
          childward.set(lower, AMBIGUOUS);
        }
      }
    }
  }

  const resolvedChildward = new Map<string, string>();
  for (const [key, value] of childward) {
    if (value !== AMBIGUOUS) resolvedChildward.set(key, value);
  }
  return { parentward, childward: resolvedChildward };
};

/**
 * Walk a dotted traversal path to the object its FINAL segment lives on.
 *
 * `Parent__r.Status__c` on Enrollment__c   -> Account (say), field `Status__c`
 * `A__r.B__r.Code__c`   on Enrollment__c   -> two hops, then `Code__c`
 *
 * Returns `null` when any hop cannot be resolved — a standard relationship whose
 * object was never retrieved (`Owner.Name`, `CreatedBy.Manager.LastName`) fails
 * here, and failing is correct: the vault has no node to point at.
 */
const resolveTraversalTarget = (
  path: string,
  owningObject: string,
  maps: RelationshipMaps,
): string | null => {
  const segments = path.split('.');
  if (segments.length < 2) return null;
  let current = owningObject;
  for (const hop of segments.slice(0, -1)) {
    const next = maps.parentward.get(
      `${current.toLowerCase()}|${hop.toLowerCase()}`,
    );
    if (next === undefined) return null;
    current = next;
  }
  const field = segments[segments.length - 1];
  if (field === undefined || field.length === 0) return null;
  return `CustomField:${current}.${field}`;
};

/** Extractor `source` marker on every edge this module mints. */
export const RELATIONSHIP_RESOLVER_SOURCE = 'relationship-resolver';

/**
 * Mint the edges the extractors could not. Appends to `edges` in place, mirroring
 * the other import-time minting passes.
 *
 * Only targets that correspond to a REAL vaulted CustomField node are emitted.
 * That is stricter than the extractors' usual contract (which tolerates dangling
 * ids classified by the phantom taxonomy) and deliberately so: these ids are
 * derived through a multi-hop inference rather than read from a declaration, so
 * a miss should read as "not found", never as a phantom referrer.
 */
export const mintRelationshipTraversalEdges = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  const maps = buildRelationshipMaps(nodes);
  const fieldIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'CustomField') fieldIds.add(node.id);
  }

  const emit = (
    fromId: string,
    toId: string,
    confidence: Edge['confidence'],
    properties: Record<string, unknown>,
  ): void => {
    if (!fieldIds.has(toId)) return;
    edges.push({
      fromId,
      toId,
      edgeType: 'references',
      confidence,
      source: RELATIONSHIP_RESOLVER_SOURCE,
      properties,
    } as Edge);
  };

  for (const node of nodes) {
    // ── Cross-object formula traversals ─────────────────────────────────────
    if (node.type === 'CustomField') {
      const refs = node.properties['formulaRelationshipRefs'];
      const owningObject = objectApiNameOf(node.parentId);
      if (Array.isArray(refs) && owningObject !== null) {
        for (const ref of refs) {
          if (typeof ref !== 'string') continue;
          const toId = resolveTraversalTarget(ref, owningObject, maps);
          if (toId === null) continue;
          // `parsed`, not `declared`: the tokenizer parsed the path and the
          // relationship map resolved it. Nothing here is a declared pointer.
          emit(node.id, toId, 'parsed', {
            referenceKind: 'formulaRelationshipTraversal',
            traversalPath: ref,
          });
        }
      }
    }

    // ── Dynamic related-list columns on a Lightning page ────────────────────
    if (node.type === 'FlexiPage') {
      const related = node.properties['relatedListFieldRefs'];
      if (!Array.isArray(related)) continue;
      for (const entry of related) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { relatedListApiName, fields } = entry as {
          relatedListApiName?: unknown;
          fields?: unknown;
        };
        if (typeof relatedListApiName !== 'string') continue;
        const childObject = maps.childward.get(relatedListApiName.toLowerCase());
        if (childObject === undefined || !Array.isArray(fields)) continue;
        for (const field of fields) {
          if (typeof field !== 'string' || field.length === 0) continue;
          // A dotted alias already names its own object; the generic sweep owns
          // those. Only bare names need the related object supplied.
          if (field.includes('.')) continue;
          emit(node.id, `CustomField:${childObject}.${field}`, 'declared', {
            referenceKind: 'relatedListFieldAlias',
            relatedListApiName,
          });
        }
      }
    }
  }
};
