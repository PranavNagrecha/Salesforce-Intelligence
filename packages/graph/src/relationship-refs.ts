import type { Edge, Node } from '@sf-intelligence/contracts';

/**
 * Import-time relationship resolution — the layer that can see every object at
 * once, and therefore the only layer that can turn a relationship traversal into
 * a real edge.
 *
 * Producers hand it unresolved work as node properties, because none can
 * resolve it from the single file it parsed (the fourth, `unresolvedTraversalRefs`
 * on an OmniDataTransform, carries `{ object, path, access }` — a DataMapper
 * Extract row reading `alias:Parent__r.Field__c` or a Load row writing a dotted
 * path, resolved into `readsFrom` / `writesTo`):
 *
 *   `formulaRelationshipRefs`  on a CustomField — cross-object formula paths
 *                              (`Parent__r.Status__c`). The leading segment is a
 *                              relationship name, so the target object is not
 *                              knowable from the formula's own file.
 *   `relatedListFieldRefs`     on a FlexiPage or Layout — related-list columns,
 *                              which are BARE field names on the RELATED object.
 *   `recordTraversalRefs`      on a FlexiPage — `{!Record.<Rel>.<Field>}` in a
 *                              visibility rule or a dotted `<fieldItem>`.
 *   `componentRefs`            on a FlexiPage — the org's own bundles the page
 *                              places by bare name; LWC or Aura is decided by
 *                              which bundle node exists.
 *   `unresolvedTraversalRefs`  on a ConditionalContext — the relationship-shaped
 *                              refs a Flow decision, record-trigger filter, or
 *                              validation-rule formula mentions
 *                              (`Parent__r.Status__c`). `condition-extractor.ts`
 *                              is a per-file function whose only object context
 *                              is the parent object api name, so it cannot know
 *                              that `Parent__r` reaches another object.
 *   `unresolvedTraversalRefs`  on a FieldSet — a dotted displayed/available
 *                              field (`Account__r.Name`), on the related object.
 *   `columnRefs`               on a ReportType — `{ table, fields }` per
 *                              `<table>` path. The path (`Base.Children__r`) is
 *                              walked CHILDWARD to the object the columns live
 *                              on; a dotted field (`Owner__c.Name`) is a lookup
 *                              traversal spelled with the lookup FIELD api name,
 *                              walked parentward from there. What cannot be
 *                              walked is recorded on `unresolvedColumns`.
 *
 * All of these used to be dropped or minted as ids no node has
 * (`CustomField:<Lookup__c>.<Field>`, `CustomField:<Base>.<Rel__r>`), which is
 * why a field read only through a traversal, shown only in a dynamic related
 * list, or exposed only through a report type built over its object could
 * report zero referrers and be certified deletable.
 *
 * The honesty rule this module keeps: **resolve or drop, never guess.** A
 * traversal whose relationship cannot be mapped to a vaulted object mints no
 * edge at all, exactly as before — a dangling `CustomField:` id that never
 * resolves would be worse than the absence, because it would present as
 * evidence. Nothing here invents a target.
 *
 * **Confidence tier — the same rationale for every traversal branch.** Every
 * traversal edge this module mints is `parsed`, never `declared`, because every
 * one of them is a scrape plus a join. The two `declared` exceptions name their
 * target outright with no hop at all: a report-type column on its own `<table>`
 * (`<table>Account</table><field>Name</field>`) and a Lightning page component
 * placement, where `componentName` is the bundle name:
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

/** Unresolved work parked by FlexiPage / Layout extractors for this pass. */
export interface RelatedListFieldRef {
  readonly relatedListApiName: string;
  readonly fields: readonly string[];
}

/**
 * Map a layout or Lightning-page `relatedList` / `relatedListApiName` token to
 * the child object that holds the lookup. Same childward index FlexiPage
 * related-list aliases use — one resolver, never a relationship name mistaken
 * for an object api name.
 */
export const resolveRelatedListChildObject = (
  relatedListApiName: string,
  maps: RelationshipMaps,
): string | undefined => maps.childward.get(relatedListApiName.toLowerCase());

type Emit = (
  fromId: string,
  toId: string,
  confidence: Edge['confidence'],
  edgeType: Edge['edgeType'],
  properties: Record<string, unknown>,
) => void;

interface MintRelatedListColumnsOptions {
  readonly edgeType: Edge['edgeType'];
  readonly referenceKind: string;
}

/**
 * Mint edges for bare related-list column names, or record unresolved list names.
 * Skips dotted aliases (object-qualified columns belong to other extractors).
 */
const mintRelatedListColumnEdges = (
  fromId: string,
  related: unknown,
  maps: RelationshipMaps,
  fieldIds: ReadonlySet<string>,
  emit: Emit,
  options: MintRelatedListColumnsOptions,
  unresolvedRelatedLists: string[],
): void => {
  if (!Array.isArray(related)) return;
  for (const entry of related) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { relatedListApiName, fields } = entry as {
      relatedListApiName?: unknown;
      fields?: unknown;
    };
    if (typeof relatedListApiName !== 'string' || relatedListApiName.length === 0) {
      continue;
    }
    const childObject = resolveRelatedListChildObject(relatedListApiName, maps);
    if (childObject === undefined) {
      unresolvedRelatedLists.push(relatedListApiName);
      continue;
    }
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      if (typeof field !== 'string' || field.length === 0) continue;
      if (field.includes('.')) continue;
      const toId = `CustomField:${childObject}.${field}`;
      if (!fieldIds.has(toId)) continue;
      emit(fromId, toId, 'parsed', options.edgeType, {
        referenceKind: options.referenceKind,
        relatedListApiName,
      });
    }
  }
};

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
    // A Classic page layout names the same list a third way: object-qualified,
    // `{ChildObject}.{LookupField}` (`Invoice__c.Project__c`). That spelling is
    // derived from this very node (its owning object and api name), so it is
    // indexed too — never parsed out of the layout token by splitting on a dot.
    // A packaged lookup (`pkg__Programme__c`) declares its `relationshipName`
    // WITHOUT the namespace (`Enrolments`), while every consumer — report-type
    // `<table>` paths, related lists, SOQL — spells it `pkg__Enrolments__r`.
    // Index the namespaced spelling too, derived from the field's own prefix.
    const relationshipName = node.properties['relationshipName'];
    const classicSpelling = `${owningObject}.${fieldApiName}`;
    const nameParts = fieldApiName.split('__');
    const namespace = nameParts.length === 3 ? nameParts[0] : undefined;
    const childKeys: string[] = [classicSpelling];
    if (typeof relationshipName === 'string' && relationshipName.length > 0) {
      childKeys.push(relationshipName, `${relationshipName}__r`);
      if (namespace !== undefined && !relationshipName.startsWith(`${namespace}__`)) {
        childKeys.push(`${namespace}__${relationshipName}`, `${namespace}__${relationshipName}__r`);
      }
    }
    {
      for (const key of childKeys) {
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
 * A hop spelled as the lookup FIELD (`Owner__c.Name`, the report-type column
 * spelling) is read as its relationship (`Owner__r`); a formula never spells a
 * hop `__c`, so the rewrite is inert for every other caller.
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
      `${current.toLowerCase()}|${hop.toLowerCase().replace(/__c$/, '__r')}`,
    );
    if (next === undefined) return null;
    current = next;
  }
  const field = segments[segments.length - 1];
  if (field === undefined || field.length === 0) return null;
  return `CustomField:${current}.${field}`;
};

/**
 * Walk a report-type `<table>` path (`Base.Children__r.Grandchildren`) to the
 * object its columns live on. The first segment is an object api name; each
 * further segment is a child relationship name, resolved through the same
 * childward index related lists use. `null` when any hop is unknown.
 */
const resolveTablePathObject = (table: string, maps: RelationshipMaps): string | null => {
  const [base, ...hops] = table.split('.');
  if (base === undefined || base.length === 0) return null;
  let current = base;
  for (const hop of hops) {
    const next = resolveRelatedListChildObject(hop, maps);
    if (next === undefined) return null;
    current = next;
  }
  return current;
};

/** Append sorted, deduplicated values to a string-array node property. */
const recordUnresolved = (node: Node, property: string, values: readonly string[]): void => {
  if (values.length === 0) return;
  const props = node.properties as Record<string, unknown>;
  const existing = Array.isArray(props[property]) ? (props[property] as string[]) : [];
  props[property] = [...new Set([...existing, ...values])].sort();
};

/**
 * FLEXI-REFS: `{!Record.<Rel>.<Field>}` in a visibility rule or a dotted
 * `<fieldItem>` on a Lightning page, parked by the FlexiPage extractor as
 * `recordTraversalRefs: {path, use}` because the relationship map lives here.
 * A visibility rule READS the field (`readsFrom`), a field item references it;
 * both `parsed` like every other traversal. An unresolved visibility token is
 * recorded on the page as `unresolvedVisibilityRefs` (joining any the extractor
 * recorded itself) and an unresolved field item as `unresolvedFieldRefs`.
 */
const mintFlexiPageRecordTraversals = (
  node: Node,
  maps: RelationshipMaps,
  emit: Emit,
): void => {
  const refs = node.properties['recordTraversalRefs'];
  const owningObject = node.properties['sobjectType'];
  if (!Array.isArray(refs) || typeof owningObject !== 'string' || owningObject.length === 0) return;
  const unresolved: Record<'visibilityRule' | 'fieldRef', string[]> = { visibilityRule: [], fieldRef: [] };
  for (const ref of refs) {
    if (typeof ref !== 'object' || ref === null) continue;
    const { path, use } = ref as { path?: unknown; use?: unknown };
    if (typeof path !== 'string' || (use !== 'visibilityRule' && use !== 'fieldRef')) continue;
    const toId = resolveTraversalTarget(path, owningObject, maps);
    const traversalPath = `Record.${path}`;
    if (toId === null) {
      unresolved[use].push(traversalPath);
      continue;
    }
    emit(node.id, toId, 'parsed', use === 'visibilityRule' ? 'readsFrom' : 'references', {
      referenceKind: use,
      traversalPath,
    });
  }
  recordUnresolved(node, 'unresolvedVisibilityRefs', unresolved.visibilityRule);
  recordUnresolved(node, 'unresolvedFieldRefs', unresolved.fieldRef);
};

/**
 * FLEXI-REFS: a Lightning page places the org's own LWC and Aura bundles by bare
 * `componentName`; the extractor cannot tell which bundle type holds the name,
 * so it parks `componentRefs` and the edge is minted here onto the bundle node
 * that exists. `declared`: `componentName` names its target outright, and the
 * only join is which of two node sets holds it. A name neither holds (a bundle
 * outside the retrieve) is recorded as `unresolvedComponentRefs`.
 */
const mintFlexiPageComponentPlacements = (
  node: Node,
  nodeIds: ReadonlySet<string>,
  emit: Emit,
): void => {
  const refs = node.properties['componentRefs'];
  if (!Array.isArray(refs)) return;
  const unresolved: string[] = [];
  for (const name of refs) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const toId = [`LightningComponentBundle:${name}`, `AuraDefinitionBundle:${name}`].find((id) =>
      nodeIds.has(id),
    );
    if (toId === undefined) {
      unresolved.push(name);
      continue;
    }
    emit(node.id, toId, 'declared', 'references', { referenceKind: 'componentPlacement' });
  }
  recordUnresolved(node, 'unresolvedComponentRefs', unresolved);
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
  // Every resolved target must be a vaulted node: a CustomField for the
  // traversal branches, a Lightning bundle for page placements.
  const nodeIds = new Set<string>(nodes.map((node) => node.id));

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
    if (!nodeIds.has(toId)) return;
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

    // ── Field-set relationship columns ──────────────────────────────────────
    // `field-set.ts` parks a dotted `<field>` (`Programme__r.Status__c`) here
    // instead of minting `CustomField:{Object}.{Rel__r}.{Field}`.
    if (node.type === 'FieldSet') {
      const refs = node.properties['unresolvedTraversalRefs'];
      const owningObject = objectApiNameOf(node.parentId);
      if (Array.isArray(refs) && owningObject !== null) {
        for (const ref of refs) {
          if (typeof ref !== 'string') continue;
          const toId = resolveTraversalTarget(ref, owningObject, maps);
          if (toId === null) continue; // resolve or drop, never guess
          emit(node.id, toId, 'parsed', 'usedInLayout', {
            referenceKind: 'fieldSetRelationshipTraversal',
            traversalPath: ref,
          });
        }
      }
      continue;
    }

    // ── Report-type columns ─────────────────────────────────────────────────
    // `extractReportTypeDetail` parks `{ table, fields }` per `<table>` path.
    // The path is walked childward to the column object; a dotted field is a
    // lookup traversal from there. A hop that cannot be walked is recorded on
    // `unresolvedColumns` as `{table}.{field}` and mints nothing.
    if (node.type === 'ReportType') {
      const refs = node.properties['columnRefs'];
      const unresolvedColumns = new Set<string>();
      if (Array.isArray(refs)) {
        for (const entry of refs) {
          if (typeof entry !== 'object' || entry === null) continue;
          const { table, fields } = entry as { table?: unknown; fields?: unknown };
          if (typeof table !== 'string' || table.length === 0 || !Array.isArray(fields)) continue;
          const object = resolveTablePathObject(table, maps);
          for (const field of fields) {
            if (typeof field !== 'string' || field.length === 0) continue;
            const toId =
              object === null
                ? null
                : field.includes('.')
                  ? resolveTraversalTarget(field, object, maps)
                  : `CustomField:${object}.${field}`;
            if (toId === null) {
              unresolvedColumns.add(`${table}.${field}`);
              continue;
            }
            const hopped = table.includes('.') || field.includes('.');
            emit(node.id, toId, hopped ? 'parsed' : 'declared', 'references', {
              referenceKind: 'reportTypeColumn',
              table,
            });
          }
        }
      }
      if (unresolvedColumns.size > 0) {
        (node.properties as Record<string, unknown>)['unresolvedColumns'] = [...unresolvedColumns].sort();
      }
      continue;
    }

    // ── DataMapper / FlexCard relationship paths ────────────────────────────
    // The OmniDataTransform extractor parks `alias:Parent__r.Field__c` (an
    // Extract mapping row) or a dotted Load output here, and the FlexCard
    // extractor a dotted field of a SOQL data source, each with the SObject the
    // path starts from. Resolved like any other traversal; a path whose
    // relationship is not in the vault mints nothing.
    if (node.type === 'OmniDataTransform' || node.type === 'OmniUiCard') {
      const refs = node.properties['unresolvedTraversalRefs'];
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          if (typeof ref !== 'object' || ref === null) continue;
          const { object, path, access } = ref as { object?: unknown; path?: unknown; access?: unknown };
          if (typeof object !== 'string' || typeof path !== 'string') continue;
          const toId = resolveTraversalTarget(path, object, maps);
          if (toId === null) continue; // resolve or drop, never guess
          emit(node.id, toId, 'parsed', access === 'write' ? 'writesTo' : 'readsFrom', {
            referenceKind: 'dataMapperRelationshipTraversal',
            traversalPath: path,
            fromObject: object,
          });
        }
      }
      continue;
    }

    // ── Dynamic related-list columns on a Lightning page ────────────────────
    if (node.type === 'FlexiPage') {
      mintRelatedListColumnEdges(
        node.id,
        node.properties['relatedListFieldRefs'],
        maps,
        nodeIds,
        emit,
        { edgeType: 'references', referenceKind: 'relatedListFieldAlias' },
        [],
      );
      mintFlexiPageRecordTraversals(node, maps, emit);
      mintFlexiPageComponentPlacements(node, nodeIds, emit);
      continue;
    }

    // ── Classic layout related-list columns ─────────────────────────────────
    if (node.type === 'Layout') {
      const unresolvedRelatedLists: string[] = [];
      mintRelatedListColumnEdges(
        node.id,
        node.properties['relatedListFieldRefs'],
        maps,
        nodeIds,
        emit,
        { edgeType: 'usedInLayout', referenceKind: 'layoutRelatedListColumn' },
        unresolvedRelatedLists,
      );
      if (unresolvedRelatedLists.length > 0) {
        const props = node.properties as Record<string, unknown>;
        props['unresolvedRelatedLists'] = [...new Set(unresolvedRelatedLists)].sort();
      }
    }
  }
};
