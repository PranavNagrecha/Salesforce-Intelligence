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
 *   `unresolvedTraversalRefs`  on a ConditionalContext — the relationship-shaped
 *                              refs a Flow decision, record-trigger filter, or
 *                              validation-rule formula mentions
 *                              (`Parent__r.Status__c`). `condition-extractor.ts`
 *                              is a per-file function whose only object context
 *                              is the parent object api name, so it cannot know
 *                              that `Parent__r` reaches another object.
 *
 * All three used to be dropped, which is why a field read only through a
 * traversal, or shown only in a dynamic related list, could report zero
 * referrers and be certified deletable.
 *
 * The honesty rule this module keeps: **resolve or drop, never guess.** A
 * traversal whose relationship cannot be mapped to a vaulted object mints no
 * edge at all, exactly as before — a dangling `CustomField:` id that never
 * resolves would be worse than the absence, because it would present as
 * evidence. Nothing here invents a target.
 *
 * **Confidence tier — the same rationale for BOTH branches.** Every edge this
 * module mints is `parsed`, never `declared`, because every one of them is a
 * scrape plus a join:
 *
 *   formula traversals      the tokenizer PARSED `Parent__r.Field__c` out of a
 *                           formula body, then the relationship map INFERRED
 *                           which object `Parent__r` reaches.
 *   related-list aliases    the FlexiPage extractor REGEX-SCRAPED the column
 *                           names out of XML, then the same inferred map
 *                           supplied the object they belong to.
 *
 * Neither input is a declared pointer: no file states "this page column is
 * `Enrolment__c.Outcome__c`". `declared` is reserved for a metadata element
 * that names its target outright, and it is the tier this product asks users to
 * TRUST when a delete is on the line — so an inferred join must not borrow it.
 * The same class of regex-scraped FlexiPage field ref is stamped `heuristic` by
 * `extractFlexiPage` in `@sf-intelligence/extractors`; `parsed` is the honest
 * middle here because the alias branch adds a structural resolution the generic
 * sweep does not have, and drops anything it cannot ground.
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
 *                 casing does not reliably match the vaulted api name. Two
 *                 fields on one object can therefore share a key: differently-
 *                 cased api names collapse together, and so do a standard
 *                 `FooId` and a sibling already spelled `Foo` (both strip to
 *                 `foo`). Rare, but the resolution is not arbitrary: see below.
 *
 *   `childward`   keyed `{relationshipName}` -> the object that HOLDS the
 *                 lookup. This is the related-list direction: a page on the
 *                 parent names `Course_Enrollments__r`, which is the
 *                 `relationshipName` declared on the child's lookup field, and
 *                 the columns beneath it are fields on that child object.
 *
 * BOTH maps drop an ambiguous key rather than resolve it arbitrarily — the same
 * ambiguity guard the case-canonicalisation passes use, and the map-building
 * half of this module's `resolve or drop, never guess` rule:
 *
 *   childward   the same child relationship name declared on two different
 *               objects (`Enrolments` on both Enrolment__c and Withdrawal__c).
 *   parentward  the same `{object}|{traversal}` key resolving to two different
 *               `referenceTo` targets.
 *
 * A colliding key is dropped in BOTH directions, because last-writer-wins is a
 * guess with the node iteration order as its only justification — and a guessed
 * hop silently retargets every traversal that walks through it, minting an edge
 * onto a field that formula never read. An unresolved hop mints nothing, which
 * is the failure this module is willing to have.
 */
interface RelationshipMaps {
  readonly parentward: ReadonlyMap<string, string>;
  readonly childward: ReadonlyMap<string, string>;
}

const AMBIGUOUS = Symbol('ambiguous');

export const buildRelationshipMaps = (
  nodes: readonly Node[],
): RelationshipMaps => {
  const parentward = new Map<string, string | typeof AMBIGUOUS>();
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
      // Same sentinel the childward map uses: a key that resolves to two
      // DIFFERENT objects is dropped, never overwritten. Two lookups agreeing on
      // the same `referenceTo` are not a conflict — the hop lands in the same
      // place either way — so only a disagreeing target poisons the key.
      const key = `${owningObject.toLowerCase()}|${traversal.toLowerCase()}`;
      const existing = parentward.get(key);
      if (existing === undefined) {
        parentward.set(key, referenceTo);
      } else if (existing !== referenceTo) {
        parentward.set(key, AMBIGUOUS);
      }
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

  const resolve = (
    raw: ReadonlyMap<string, string | typeof AMBIGUOUS>,
  ): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of raw) {
      if (value !== AMBIGUOUS) out.set(key, value);
    }
    return out;
  };
  return { parentward: resolve(parentward), childward: resolve(childward) };
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

  // Dedup against what the per-file extractors ALREADY emitted, keyed on the
  // same (from, to, type) triple the graph is keyed on. A field can legitimately
  // reach the same page twice — once as a direct `fieldItem` and once as a
  // related-list alias column — and the generic FlexiPage sweep owns the first.
  // Emitting a second identical edge inflates that field's referrer count, which
  // is precisely the clone-propagation double-count a field audit must not make:
  // two edges would read as two independent consumers when there is one page.
  const seen = new Set<string>();
  for (const edge of edges) {
    seen.add(`${edge.fromId}\u0000${edge.toId}\u0000${edge.edgeType}`);
  }

  const emit = (
    fromId: string,
    toId: string,
    confidence: Edge['confidence'],
    edgeType: Edge['edgeType'],
    properties: Record<string, unknown>,
  ): void => {
    if (!fieldIds.has(toId)) return;
    // The dedup key carries the edge TYPE — the same triple the graph is keyed
    // on — so a `readsFrom` minted here is never suppressed by an unrelated
    // `references` already present on the same pair, or vice versa.
    const key = `${fromId}\u0000${toId}\u0000${edgeType}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      fromId,
      toId,
      edgeType,
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
          emit(node.id, toId, 'parsed', 'references', {
            referenceKind: 'formulaRelationshipTraversal',
            traversalPath: ref,
          });
        }
      }
    }

    // ── Condition relationship traversals (Flow decision / VR / filter) ─────
    // The third producer. `condition-extractor.ts` parks a relationship-shaped
    // ref here instead of minting `CustomField:<Rel>__r.<Field>__c`, an id that
    // names no node and that NO refresh on any org could ever create. The edge
    // is `readsFrom`, not `references`: a condition READS the field, and
    // `safe_to_delete_field` is a pure incoming-edge composition that must see
    // it or it will certify a read field as deletable.
    if (node.type === 'ConditionalContext') {
      const refs = node.properties['unresolvedTraversalRefs'];
      const owningObject = node.properties['objectApiName'];
      if (Array.isArray(refs) && typeof owningObject === 'string' && owningObject.length > 0) {
        for (const ref of refs) {
          if (typeof ref !== 'string') continue;
          const toId = resolveTraversalTarget(ref, owningObject, maps);
          if (toId === null) continue; // resolve or drop, never guess
          // `parsed`, not `declared`, for the same reason as the other two
          // branches: a scrape plus an inferred join is never a declared pointer.
          emit(node.id, toId, 'parsed', 'readsFrom', {
            referenceKind: 'conditionRelationshipTraversal',
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
          // `parsed`, not `declared` — symmetric with the formula branch above
          // and for the same reason: the column name was regex-scraped from
          // FlexiPage XML and the OBJECT it belongs to came from the inferred
          // childward map. Nothing declared this pointer. Stamping `declared`
          // overclaimed on the axis a caller weighs before deleting a field.
          emit(node.id, `CustomField:${childObject}.${field}`, 'parsed', 'references', {
            referenceKind: 'relatedListFieldAlias',
            relatedListApiName,
          });
        }
      }
    }
  }
};
