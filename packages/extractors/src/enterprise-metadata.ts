import { readFile } from 'node:fs/promises';

import type {
  ComponentType,
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import {
  deriveComponentApiName,
  deriveNestedObjectAndApiName,
} from './path-utils.js';
import { VARIANT_TABLE } from './sharing-rules.js';
import { isWellFormedFieldRef } from './workflow-rule.js';

const EXTRACTOR_SOURCE = 'enterprise-metadata-extractor';

interface ChildRefSpec {
  /** XML child element whose text values are component api names. */
  readonly element: string;
  /** Component type the referenced api names resolve to. */
  readonly toType: ComponentType;
  /** `properties.referenceKind` tag on the emitted `references` edge. */
  readonly referenceKind: string;
}

/**
 * R7-C7: an XML element whose repeated text values are captured as a plain
 * property array — NO edge is emitted. Mirrors {@link ChildRefSpec} minus the
 * edge-emission side; used when the referenced entity has no ComponentType
 * node in this vault (e.g. a `PresenceUserConfig`'s assigned usernames —
 * there is no `User` node type) so minting an edge would either fabricate a
 * node or silently dangle without disclosure. Values are deduplicated +
 * sorted, mirroring `childRefs`' property mirror.
 */
interface ArrayPropertySpec {
  /** XML child element whose text values are captured verbatim. */
  readonly element: string;
  /** Property name written onto `node.properties`. */
  readonly propertyName: string;
}

interface EnterpriseExtractorConfig {
  readonly type: ComponentType;
  readonly suffix: string;
  readonly nestedParent?: string;
  /**
   * Explicit child-element references to emit as `references` edges — e.g. a
   * PermissionSetGroup's member `<permissionSets>` and `<mutingPermissionSets>`.
   * The values are ALSO mirrored onto `node.properties[element]` for direct
   * reads. Declared confidence (explicit metadata pointers, not heuristics).
   */
  readonly childRefs?: readonly ChildRefSpec[];
  /**
   * R7-C7: elements captured as plain property arrays with NO edge — see
   * {@link ArrayPropertySpec}.
   */
  readonly arrayProperties?: readonly ArrayPropertySpec[];
  /**
   * Capture a list view's `<sharedTo>` visibility scope: mirror the resolved
   * targets onto `properties.sharedTo`, the `<filterScope>` onto
   * `properties.filterScope`, and emit a `visibleTo` edge per target. Set only
   * for `ListView` — other enterprise-metadata types have no `<sharedTo>`.
   */
  readonly captureSharedTo?: boolean;
  /**
   * CR-CAP-13: parse the list view's `<filters><field>` predicate fields as
   * field IDENTITY references (which view filters on a field), distinct from
   * its `<columns>` (which view shows a field). Set ONLY for `ListView`. When
   * set, the generic `<field>` column sweep AND the whole-XML `dottedFieldRe`
   * value scan are SUPPRESSED for this config so a filter field is owned by the
   * guarded filter parser (and the value-derived RecordType-name phantom is
   * never minted); a `<columns>`-only field stays a `fieldRef`, a filter-only
   * field becomes a `filterRef`, and a field that is BOTH is merged into ONE
   * `columnAndFilter` edge (the graph edge PK is `(fromId,toId,edgeType,source)`
   * — two `references` edges to the same field would collide and silently drop).
   *
   * R6-04: when set, `properties.legacyAddressingRefsSkipped` is also added
   * (omitted when zero) — the count of legacy dotted SOAP-style addressing
   * tokens (`CONTACT.EMAIL`, `CORE.USERS.ALIAS`, …) skipped across BOTH the
   * `<columns>` and `<filters>` sweeps because they cannot be resolved to a
   * real `CustomField:` id without guessing. See {@link isLegacyDottedAddress}.
   */
  readonly parseListViewFilters?: boolean;
  /**
   * Derive the parent CustomObject from an XML element's text when the file
   * path carries no object (RestrictionRule / ScopingRule retrieve into a
   * TOP-LEVEL `restrictionRules/`/`scopingRules/` folder, but their
   * `<targetEntity>` names the restricted object). Without this, parentId is
   * null and every parentId-keyed consumer — why_cant_user_see_record's
   * RestrictionRule/ScopingRule stages, who_can_access_object's god-mode
   * caveat — silently never fires on real orgs.
   */
  readonly parentFromXmlElement?: string;
  /**
   * RESTRICTION-RULE-MISSING-OBJECT-GRAPH: emit a `parentOf` edge from the
   * resolved parent `CustomObject` to this node. `makeNode` already stamps the
   * parent on `node.parentId`, but WITHOUT this edge the graph carries no
   * traversable object→rule link, so `get_edges` on a RestrictionRule /
   * ScopingRule returns `[]` and object-level impact/sharing surfaces never see
   * it. Set for RestrictionRule / ScopingRule (top-level files whose parent
   * comes from `<targetEntity>`); no-op when `parentObjectApiName` is null. The
   * nested-parent types (ListView, etc.) already carry an object relationship
   * through their nesting and do NOT opt in, so their edge sets do not move.
   */
  readonly parentEdge?: boolean;
  /**
   * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: parse `<userCriteria>`
   * for `$User.ProfileId='00e...'` comparisons and emit an explicit UNRESOLVED
   * stub edge `{node} -> UnresolvedProfile:{ProfileId}` per gated id (heuristic,
   * `referenceKind: 'restrictionUserProfileUnresolved'` — see
   * {@link extractUserCriteriaProfileIds}). A single-file extractor CANNOT
   * resolve the opaque 15/18-char Id to the name-keyed `Profile:{apiName}`
   * node (the mapping is org-wide, not in this file — and real Profile
   * metadata carries no Id at all), so it deliberately does NOT mint a
   * `Profile:{Id}` node that would masquerade as a real Profile in
   * profile-scoped queries. The cross-file resolution runs downstream over
   * the full node set (`resolveRestrictionRuleProfileEdges` in the refresh
   * pipeline): when an Id->apiName index resolves a gated id, that pass
   * rewrites the stub into a real `Profile:{apiName}` edge; unresolved ids
   * stay explicit `UnresolvedProfile:` stubs. Set for RestrictionRule /
   * ScopingRule (whose active rules gate on a hardcoded Profile Id); the
   * parsed ids are also mirrored onto `properties.userCriteriaProfileIds`
   * (all gated ids) and `properties.unresolvedProfileIds` (the disclosure —
   * at extract time every gated id is unresolved). Omitted when none.
   */
  readonly userCriteriaProfileRefs?: boolean;
  /**
   * XML element name whose first text value should be used as the node's
   * `label`. When set, `extractEnterpriseMetadata` reads the element from the
   * raw XML and passes it to `makeNode` instead of the hardcoded `null`.
   * Used for ReportType which has a top-level `<label>` element (e.g.
   * "Bot Metrics Daily Summer '22") that is otherwise lost.
   */
  readonly labelXmlElement?: string;
  /**
   * Additional XML element names whose first text value should be included
   * directly in `node.properties`. Lets callers surface type-specific scalar
   * fields (e.g. enforcementType / recordFilter / userCriteria / active on
   * RestrictionRule and ScopingRule) without requiring a new dedicated config
   * key per field. Values are extracted with `extractXmlValues` and written as
   * `properties[elementName]`; absent elements are omitted (no null entry).
   */
  readonly extraProperties?: readonly string[];
  /**
   * R6-24: parse a Report's structural depth beyond column identity —
   * `<filter>` criteria (field/operator/value-presence, never the literal
   * value), `<booleanFilter>`, `<groupingsDown>`/`<groupingsAcross>`,
   * `<buckets>`, `<crossFilters>`, `<chart>`, and `<format>`. Set ONLY for
   * `Report` — Dashboard/ReportType/ListView do not carry this shape. See
   * {@link extractReportDetail} for the honesty rationale on value omission.
   */
  readonly reportDetail?: boolean;
  /**
   * REPORT-TYPE-OMITS-BASE-OBJECT-JOIN-AND-COLUMNS: parse a ReportType's
   * `<baseObject>` (the primary SObject the report type is built on),
   * `<join><relationship>` tree (the joined relationships — Contacts,
   * `pkg__Related_Items__r`, …), and a COUNT of `<sections><columns>` entries.
   * Set ONLY for `ReportType`. Without this the node was description-only:
   * "what objects does this report type cover?" and join/affiliation report
   * types read as empty. HONEST MINIMUM by design — surfaces the base object
   * (with an edge), the join relationships, and a column COUNT with a
   * `columnsModeled: false` caveat; the full per-column identity graph
   * (potentially hundreds of `<field>`/`<table>` pairs) is a deferred
   * follow-up, disclosed via the caveat rather than silently implied complete.
   * See {@link extractReportTypeDetail}.
   */
  readonly reportTypeDetail?: boolean;
  /**
   * R6-22: parse a TransactionSecurityPolicy's nested `<action>` block into
   * a boolean-flag summary (`block`/`endSession`/`freezeUser`/
   * `twoFactorAuthentication` + a notification-target count). Set ONLY for
   * `TransactionSecurityPolicy` — `<action>` has nested children, so it
   * cannot be read by the flat-text {@link extractXmlValues} that
   * `extraProperties` uses. See {@link extractTransactionSecurityAction}.
   */
  readonly transactionSecurityAction?: boolean;
  /**
   * R7-C7: parse EACH `<milestones>` block's OWN `minutesToComplete` /
   * `useCriteriaStartTime`, scoped per-block — the repeated-element trap
   * this extractor's own doc comment named and deliberately did NOT ship at
   * R6-18: `extraProperties` reads only the FIRST occurrence of a repeated
   * element, so a flat read of `minutesToComplete` across a file with 2+
   * `<milestones>` blocks would silently misattribute one milestone's
   * target minutes to a different milestone. Set ONLY for
   * `EntitlementProcess`. See {@link extractMilestoneDetails}.
   */
  readonly captureMilestones?: boolean;
}

const readText = async (path: string): Promise<Result<string, ExtractorError>> => {
  try {
    return ok(await readFile(path, 'utf8'));
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
};

const extractXmlValues = (xml: string, elementName: string): readonly string[] => {
  const re = new RegExp(`<${elementName}>([^<]+)</${elementName}>`, 'g');
  const out: string[] = [];
  for (const match of xml.matchAll(re)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0) out.push(value);
  }
  return out;
};

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: match a Salesforce Profile
 * Id (`00e` + 12 or 15 more base-62 chars = a 15- or 18-char id) inside a
 * `$User.ProfileId=...` comparison. The `<userCriteria>` text is read verbatim
 * by {@link extractXmlValues} (no XML entity decoding), so the quote delimiter
 * may be `&apos;`, `&#39;`, a literal `'`/`"`, or absent — all tolerated.
 */
const USER_CRITERIA_PROFILE_ID_RE =
  /ProfileId\s*=\s*(?:&(?:apos|#39);|['"])?\s*(00e[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)/g;

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: the node-id prefix for an
 * UNRESOLVED userCriteria Profile-Id stub. A distinct namespace from the real
 * name-keyed `Profile:{apiName}` node so an unresolved opaque Id can NEVER be
 * mistaken for (or collide with) a real Profile in profile-scoped queries. The
 * downstream `resolveRestrictionRuleProfileEdges` pass rewrites a stub into a
 * real `Profile:{apiName}` edge when an Id->apiName index resolves the id.
 */
export const UNRESOLVED_PROFILE_PREFIX = 'UnresolvedProfile:';

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: parse the Profile Ids a
 * RestrictionRule / ScopingRule gates on in its `<userCriteria>` expression.
 * Returns the deduplicated, sorted 15/18-char Profile Ids.
 *
 * A single-file extractor CANNOT resolve an opaque Id to the name-keyed
 * `Profile:{DeveloperName}` node (the mapping is org-wide, not in this file —
 * and real Profile metadata carries no Id at all), so the caller emits an
 * explicit `UnresolvedProfile:{id}` stub at `heuristic` confidence with
 * disclosure props — an honest unresolved-id edge that never masquerades as a
 * real Profile node. The cross-file resolution to `Profile:{apiName}` happens
 * downstream in {@link resolveRestrictionRuleProfileEdges} once the full node
 * set (and any Id->apiName index) is available. Without ANY edge the profile
 * looked unused and "which profiles does this restriction rule constrain?"
 * could not be answered from the graph.
 */
const extractUserCriteriaProfileIds = (xml: string): readonly string[] => {
  const ids = new Set<string>();
  for (const criteria of extractXmlValues(xml, 'userCriteria')) {
    for (const match of criteria.matchAll(USER_CRITERIA_PROFILE_ID_RE)) {
      const id = match[1];
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids].sort();
};

/**
 * Infer the primary SObject for report/dashboard metadata when the file
 * path does not carry a nested parent (reports live flat under `reports/`).
 * Standard report types use `{Object}List`; custom report types use the
 * report type API name verbatim (may still scope bare column refs when
 * the type equals a custom object API name).
 */
const inferReportObjectApiName = (xml: string): string | null => {
  const reportType = extractXmlValues(xml, 'reportType')[0];
  if (reportType === undefined) return null;
  if (reportType.endsWith('List') && !reportType.includes('__')) {
    return reportType.slice(0, -4);
  }
  return reportType;
};

/** Result of a field-reference sweep: the resolved refs plus an honest skip count. */
interface FieldRefSweepResult {
  readonly refs: readonly string[];
  /** Count of tokens rejected as {@link isLegacyDottedAddress} — see that doc. */
  readonly skippedLegacyDotted: number;
}

/**
 * FLEXIPAGE-FIELDREFS-RECORD-PREFIX-PHANTOM: a FlexiPage `<fieldItem>` names a
 * field on the page's record context with the literal pseudo-object head
 * `Record.` (e.g. `Record.Flag_Resolution__c`). `Record` is not an SObject, so a
 * raw `CustomField:Record.Field` id is a phantom that never resolves and hides
 * the real object-qualified field's reverse usage (`find_component_usages` on
 * the field misses the Lightning page). Rewrite the `Record.` head to the
 * page's `sobjectType` (`scopeObject`) so the edge points at the real field.
 *
 * Only a DIRECT field on the record (a single remaining segment) is rescoped —
 * a relationship traversal (`Record.Rel__r.Field__c`) is left untouched because
 * its object is the RELATED object, not the page's sobjectType. `Record.` is a
 * FlexiPage-only construct, so this is inert for the Report / Dashboard /
 * ReportType / ListView paths that share this sweep.
 */
const RECORD_CONTEXT_PREFIX = 'Record.';
const rescopeRecordContextField = (
  token: string,
  scopeObject: string | null,
): string => {
  if (scopeObject === null) return token;
  if (!token.startsWith(RECORD_CONTEXT_PREFIX)) return token;
  const remainder = token.slice(RECORD_CONTEXT_PREFIX.length);
  if (remainder.length === 0 || remainder.includes('.')) return token;
  return `${scopeObject}.${remainder}`;
};

const extractFieldRefs = (
  xml: string,
  parentObjectApiName: string | null,
  options?: { readonly listViewFilterScoped?: boolean },
): FieldRefSweepResult => {
  const scopeObject =
    parentObjectApiName ?? inferReportObjectApiName(xml);
  const refs = new Set<string>();
  let skippedLegacyDotted = 0;
  // CR-CAP-13: for a ListView, the generic `<field>` sweep is suppressed —
  // ListView XML uses `<field>` ONLY inside `<filters>`, which the dedicated
  // guarded filter parser now owns. `<columns>` is the only column source here.
  // CR-CAP-13b: each column token is gated through `isWellFormedColumnField`
  // (the column-path sibling of the filter guard) so platform pseudo-columns do
  // not mint phantom field edges. The guard is deliberately MORE permissive than
  // the filter guard — it keeps real all-UPPERCASE standard fields and mixed-
  // case relationship columns — see that function's doc for why verbatim reuse
  // of `isWellFormedFilterField` would over-drop.
  const columnElements = options?.listViewFilterScoped
    ? ['columns', 'fieldItem', 'fieldApiName']
    : ['columns', 'field', 'fieldItem', 'fieldApiName'];
  // CR-CAP-13b: gate every column token through `isWellFormedColumnField` so a
  // non-field platform operand (CREATED_DATE, OWNER.ALIAS, OWNER_ID, …) never
  // mints a `targetMissing` phantom `CustomField:` edge. ONE site — covers all
  // five column-routing ComponentTypes (Report / Dashboard / ReportType /
  // ListView / FlexiPage). Conservative by design: the guard OMITS a blanket
  // all-UPPERCASE rule so real UPPERCASE std fields (NAME/TITLE/ABSTRACT) and
  // mixed-case relationship columns (Owner.Name) are KEPT — when unsure we keep
  // the edge (a phantom is less harmful than dropping a real field).
  for (const value of columnElements.flatMap((el) => extractXmlValues(xml, el))) {
    // R6-04: count (rather than silently drop) the legacy-dotted-addressing
    // rejects — see {@link isLegacyDottedAddress}. isWellFormedColumnField
    // also rejects these; checking here first lets the sweep attribute the
    // skip to its specific cause instead of lumping it in with denylist hits.
    if (isLegacyDottedAddress(value)) {
      skippedLegacyDotted += 1;
      continue;
    }
    if (!isWellFormedColumnField(value)) continue;
    if (value.includes('.')) {
      refs.add(`CustomField:${rescopeRecordContextField(value, scopeObject)}`);
    } else if (scopeObject !== null) {
      refs.add(`CustomField:${scopeObject}.${value}`);
    }
  }

  // CR-CAP-13: the whole-XML dotted scan mints `CustomField:` from any
  // `Object.Field`-shaped substring, INCLUDING a list view's
  // `<value>Evaluation__c.Student_Evaluation</value>` (a RecordType developer
  // name, not a field). Suppress it for the ListView column path so the filter
  // parser is the sole, guarded owner of filter-block tokens.
  if (!options?.listViewFilterScoped) {
    const dottedFieldRe = /\b([A-Za-z][A-Za-z0-9_]*__?(?:c|pc|pr|r|e|b|kav)?\.[A-Za-z][A-Za-z0-9_]*__?[a-zA-Z0-9]*)\b/g;
    for (const match of xml.matchAll(dottedFieldRe)) {
      const value = match[1];
      if (value !== undefined) {
        refs.add(`CustomField:${rescopeRecordContextField(value, scopeObject)}`);
      }
    }
  }

  return { refs: [...refs].sort(), skippedLegacyDotted };
};

/**
 * CR-CAP-13 / CR-CAP-13b: non-field pseudo-columns that may appear in a list
 * view's `<filters><field>` OR in a `<columns>` sweep but are NOT real fields —
 * special platform operands the engine resolves itself (record type, owner,
 * audit users/dates, KB article state/language). `isWellFormedFieldRef` returns
 * TRUE for all of these (it only rejects `$`-prefixed and empty-segment-dotted
 * tokens), so this denylist carries the real phantom guard.
 *
 * CR-CAP-13b: the column path mints a phantom from a broader set of operands
 * than the filter path. The four added here (`OWNER_ID`, `SETUP_TYPE`,
 * `ARCHIVED_DATE`, `LAST_PUBLISHED_DATE`) appear in real list-view `<columns>`
 * but were absent from the original CR-CAP-13 filter set. Each is also a valid
 * filter operand, so the set stays shared (it never collides with a real custom
 * `__c` or mixed-case standard field). NOTE: `ARCHIVEDBY_USER`,
 * `CREATEDBY_USER.ALIAS`, and `OWNER.FIRST_NAME` are intentionally NOT listed —
 * they are caught structurally by the `_USER$` / `.ALIAS$` / `OWNER.`-head
 * regexes in {@link isWellFormedColumnField}.
 */
const LIST_VIEW_FILTER_PSEUDO_FIELDS: ReadonlySet<string> = new Set([
  'RECORDTYPE',
  'OWNER',
  'CREATED_DATE',
  'CREATEDBY_USER',
  'UPDATEDBY_USER',
  'LAST_UPDATE',
  'LAST_ACTIVITY',
  'PUBLISH_STATUS',
  'LANGUAGE',
  'ARTICLE_NUMBER',
  'VERSION_NUMBER',
  // CR-CAP-13b column-path additions.
  'OWNER_ID',
  'SETUP_TYPE',
  'ARCHIVED_DATE',
  'LAST_PUBLISHED_DATE',
]);

/**
 * R6-04: true when `field` is Salesforce's legacy dotted SOAP-style
 * list-view column/filter addressing (`CONTACT.EMAIL`, `ACCOUNT.NAME`,
 * `CASES.STATUS`, `CORE.USERS.ALIAS`, `CORE.PROFILE.NAME`, …) rather than a
 * real `Object.Field` or `Relationship.Field` pair.
 *
 * Verified against a production-scale gate vault: 96 distinct
 * fully-uppercase dotted tokens across its 580 `ListView` files, all sharing
 * this exact shape. Every REAL modern relationship-traversal column/filter
 * is mixed-case (`Owner.Name`, `Account.Name`, `Custom_Lookup__r.Field__c`)
 * — this legacy addressing instead names the object/table in its
 * pre-Lightning uppercase SOAP form (sometimes pluralized differently than
 * the object itself, e.g. `CASES` for `Case`, `LEAD` for `Lead`) or routes
 * through the synthetic `CORE.USERS` / `CORE.PROFILE` / `CORE.USER_ROLE`
 * cross-object aliases. None of these heads are resolvable to a real graph
 * node id without an unsafe guess (the field segment's original mixed case
 * — e.g. `Best_Admission_Role__c` — cannot be mechanically reconstructed
 * from its uppercased form), so `CustomField:${field}` would silently mint
 * an edge that can never resolve. Skipped rather than guessed; the caller
 * counts the skip so it is disclosed, not silently dropped.
 *
 * The `isWellFormedFilterField` blanket all-uppercase-no-`__` rule already
 * happens to reject every one of these for the `<filters>` path (dotted
 * tokens included, since its regex's character class allows `.`) — this
 * function exists to (a) share ONE definition with the `<columns>` path,
 * which deliberately does NOT apply that blanket rule (real bare-uppercase
 * standard fields like `NAME`/`TITLE`/`ABSTRACT` must survive there), and
 * (b) let both sweeps count the skip under one attributable cause.
 */
const isLegacyDottedAddress = (field: string): boolean =>
  field.includes('.') && !field.includes('__') && /^[A-Z0-9_.]+$/.test(field);

/**
 * CR-CAP-13b: is this `<columns>` token a real field worth a reference edge?
 *
 * Mirrors {@link isWellFormedFilterField} EXCEPT it deliberately OMITS the
 * all-UPPERCASE-no-`__` rule. Real all-UPPERCASE STANDARD fields appear in
 * `<columns>` (e.g. `NAME`, `TITLE`, `ABSTRACT` on Knowledge articles) but
 * NEVER in the `<filters>` fixture, so the filter guard's blanket uppercase
 * reject would drop them — reusing it verbatim would lose ~62 real edges on the
 * sample vault. Instead the phantom guard here is the shared denylist plus the
 * structural shapes that are pseudo regardless of case:
 *
 *   (a) `$`-prefixed / degenerate-dotted via {@link isWellFormedFieldRef};
 *   (b) the denylisted bare platform operands;
 *   (c) a `:` literal (date-range operands like `LAST_N_DAYS:30`);
 *   (d) an audit-user shape `*_USER` (CREATEDBY_USER / ARCHIVEDBY_USER, and the
 *       `*_USER.ALIAS` dotted variants) — but ONLY when that segment is
 *       all-UPPERCASE (a real custom `Foo_User__c` survives: `__c` -> `__C`
 *       fails the `_USER$` anchor, and a mixed-case `Owner_User` is not the
 *       platform operand);
 *   (e) a relationship-into-user `*.ALIAS` / an `OWNER.*` traversal — but ONLY
 *       when the relationship HEAD is the all-UPPERCASE platform operand shape,
 *       so a legitimate mixed-case relationship column (`Owner.Name`,
 *       `CreatedBy.Name`, `Account.Owner.Alias`) survives (CR-CAP-13b design
 *       review hardening: these are common real Report/FlexiPage columns and
 *       must not be over-dropped).
 *
 * This guard is applied GLOBALLY at the single column-sweep site in
 * {@link extractFieldRefs}, covering all five column-routing ComponentTypes
 * (Report / Dashboard / ReportType / ListView / FlexiPage). It is safe across
 * types because the denylist holds only all-UPPERCASE platform operands that
 * never collide with a real custom (`__c`) or mixed-case standard field.
 */
const isWellFormedColumnField = (field: string): boolean => {
  if (!isWellFormedFieldRef(field)) return false;
  const upper = field.toUpperCase();
  if (LIST_VIEW_FILTER_PSEUDO_FIELDS.has(upper)) return false;
  if (field.includes(':')) return false;
  // Audit-user operand: an all-UPPERCASE `*_USER` segment (the trailing
  // `.ALIAS` of an audit-user dotted operand is handled by the `.ALIAS` rule
  // below; here we catch the bare and `_USER`-tail forms). A real custom field
  // ending `_User__c` survives because `__c` -> `__C` breaks the `_USER` anchor.
  if (/(^|\.)[A-Z0-9_]*_USER$/.test(upper)) return false;
  // Relationship traversal whose HEAD is an all-UPPERCASE platform operand,
  // ending in `.ALIAS` (OWNER.ALIAS, CREATEDBY_USER.ALIAS) — but a mixed-case
  // real relationship column (Owner.Name, SomeRel__r.Alias__c) is kept.
  if (/^[A-Z0-9_]+\.ALIAS$/.test(field)) return false;
  // An `OWNER.<anything>` traversal where the head is the literal all-UPPERCASE
  // OWNER operand (OWNER.FIRST_NAME, OWNER.ALIAS). A mixed-case `Owner.Name`
  // does NOT match `^OWNER\.` (it is `Owner.`), so it survives.
  if (/^OWNER\./.test(field)) return false;
  // R6-04: legacy dotted SOAP-style addressing (CONTACT.EMAIL, ACCOUNT.NAME,
  // CORE.USERS.ALIAS, …) — see {@link isLegacyDottedAddress}. Scoped to the
  // dotted case only, so the bare-uppercase exception above is unaffected.
  if (isLegacyDottedAddress(field)) return false;
  return true;
};

/**
 * CR-CAP-13: is this `<filters><field>` token a real field worth a reference
 * edge? Rejects (a) `$`-prefixed and degenerate-dotted via
 * {@link isWellFormedFieldRef}; (b) the known non-field pseudo-columns; (c)
 * `*_USER` audit-user shapes and any `*.ALIAS` dotted relationship into a
 * user; (d) any token carrying a `:` (date-range literals like
 * `LAST_N_DAYS:30`); (e) all-UPPERCASE tokens with no `__` (the platform's
 * special operands — real custom fields carry `__c`, standard fields are
 * mixed-case). Field IDENTITY only — operation/value are never read.
 */
const isWellFormedFilterField = (field: string): boolean => {
  if (!isWellFormedFieldRef(field)) return false;
  const upper = field.toUpperCase();
  if (LIST_VIEW_FILTER_PSEUDO_FIELDS.has(upper)) return false;
  if (field.includes(':')) return false;
  if (/(^|\.)[A-Z0-9_]*_USER$/.test(upper)) return false;
  if (/\.ALIAS$/.test(upper)) return false;
  // All-uppercase, underscore-or-dot only, with no `__` custom marker: a
  // platform pseudo-column (RECORDTYPE, FULL_NAME, etc.), not a field.
  if (!field.includes('__') && /^[A-Z0-9_.]+$/.test(field)) return false;
  return true;
};

/**
 * CR-CAP-13: parse a list view's `<filters>` blocks for predicate field
 * IDENTITY. Reads ONLY `<field>` from each (repeatable) block — never
 * `<operation>` or `<value>` (values include `3`, `en_US`, `Open`, picklist
 * CSVs, and the dotted RecordType name `Evaluation__c.Student_Evaluation`,
 * none of which are fields). Each token is scoped exactly like a column ref
 * (dotted verbatim, bare → `${scopeObject}.${field}`) and gated through
 * {@link isWellFormedFilterField} so no pseudo-column or literal mints an edge.
 *
 * R6-04: `isWellFormedFilterField`'s existing blanket all-uppercase-no-`__`
 * rule already rejects every legacy-dotted-addressing token (its regex's
 * character class includes `.`) — verified against real gate-vault filter
 * blocks (`CONTACT.CREATED_DATE` never mints an edge). The explicit
 * {@link isLegacyDottedAddress} check here exists only to attribute and
 * count that specific rejection cause, matching the `<columns>` sweep's
 * disclosure.
 */
const extractListViewFilterRefs = (
  xml: string,
  scopeObject: string | null,
): FieldRefSweepResult => {
  const refs = new Set<string>();
  let skippedLegacyDotted = 0;
  for (const block of xml.matchAll(/<filters>([\s\S]*?)<\/filters>/g)) {
    for (const field of extractXmlValues(block[1] ?? '', 'field')) {
      if (isLegacyDottedAddress(field)) {
        skippedLegacyDotted += 1;
        continue;
      }
      if (!isWellFormedFilterField(field)) continue;
      if (field.includes('.')) {
        refs.add(`CustomField:${field}`);
      } else if (scopeObject !== null) {
        refs.add(`CustomField:${scopeObject}.${field}`);
      }
    }
  }
  return { refs: [...refs].sort(), skippedLegacyDotted };
};

/**
 * R6-24: each report-depth list property (`filters` / `groupings` /
 * `buckets` / `crossFilters`) is capped at this length before being written
 * onto `node.properties`. A joined report's blocks (or a report with a huge
 * ad hoc filter tree) can carry hundreds of criteria/groupings on a large
 * org; beyond the cap, items are dropped and the drop count is recorded in
 * `properties.truncatedCounts` (never silently lost — see
 * {@link extractReportDetail}).
 */
const REPORT_DETAIL_LIST_CAP = 100;

/** One `<filter>`/`<crossFilters>` `<criteriaItems>` block's field IDENTITY + operator, never its literal value. */
interface ReportCriteriaItem {
  readonly column: string;
  readonly operator: string | null;
  readonly hasValue: boolean;
}

/**
 * Parse every repeatable `<criteriaItems>` block inside `block` (scoped to
 * the caller's `<filter>` or a single `<crossFilters>` element — this
 * function does not care which, both share the exact same child shape:
 * `<column>`/`<operator>`/`<value>`, optionally `<columnToColumn>`/
 * `<isUnlocked>`). Reads `<column>` (field identity) and `<operator>`
 * verbatim, and reduces `<value>` to a presence boolean — see
 * {@link extractReportDetail} for why the literal is never captured.
 */
const extractReportCriteriaItems = (block: string): readonly ReportCriteriaItem[] => {
  const items: ReportCriteriaItem[] = [];
  for (const match of block.matchAll(/<criteriaItems>([\s\S]*?)<\/criteriaItems>/g)) {
    const inner = match[1] ?? '';
    const column = extractXmlValues(inner, 'column')[0];
    if (column === undefined) continue;
    items.push({
      column,
      operator: extractXmlValues(inner, 'operator')[0] ?? null,
      hasValue: extractXmlValues(inner, 'value')[0] !== undefined,
    });
  }
  return items;
};

/** A `<groupingsDown>`/`<groupingsAcross>` block's field + optional date granularity. */
interface ReportGroupingItem {
  readonly field: string;
  readonly dateGranularity: string | null;
  readonly axis: 'down' | 'across';
}

const parseReportGroupingBlock = (
  block: string,
  axis: 'down' | 'across',
): ReportGroupingItem | null => {
  const field = extractXmlValues(block, 'field')[0];
  if (field === undefined) return null;
  return { field, dateGranularity: extractXmlValues(block, 'dateGranularity')[0] ?? null, axis };
};

/** A `<buckets>` block's field identity (`developerName`), label, and source field. */
interface ReportBucketItem {
  readonly field: string;
  readonly label: string | null;
  readonly sourceField: string;
}

/** A `<crossFilters>` block's related object + condition presence (never the criteria values). */
interface ReportCrossFilterItem {
  readonly relatedObject: string | null;
  readonly operation: string | null;
  readonly hasConditions: boolean;
}

/** The `<chart>` block's type + whether a summary-axis series (`<chartSummaries>`) is configured. */
interface ReportChartSummary {
  readonly type: string | null;
  readonly hasSummaryAxis: boolean;
}

/** Resolve a raw (dotted or bare) field token to a candidate `CustomField:` id, or null when unresolvable (bare token, no scope object). Does NOT apply the phantom-field guard — callers gate separately via {@link isWellFormedColumnField}. */
const resolveReportFieldToken = (token: string, scopeObject: string | null): string | null => {
  if (token.includes('.')) return `CustomField:${token}`;
  return scopeObject !== null ? `CustomField:${scopeObject}.${token}` : null;
};

interface ReportDetailResult {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly edges: readonly Edge[];
}

/**
 * R6-24: parse a Report's structural depth beyond column identity.
 *
 * HONESTY / PRIVACY CHOICE (binding, do not relax without re-reading this
 * comment): report filter criteria (`<filter>`/`<crossFilters>`
 * `<criteriaItems>`) carry a `<value>` element that is a LITERAL filter
 * value an admin typed — e.g. a specific student ID, a dollar amount, a
 * person's name. This product never vaults record-level data, and a report
 * filter literal is exactly that: real data, not metadata. So every
 * criteria item captured here reduces `<value>` to a `hasValue: boolean`
 * presence flag and keeps `<column>` (the field it filters on) and
 * `<operator>` (the comparison, e.g. `equals`) — enough to answer "what does
 * this report filter/group/bucket by and how" without ever persisting what
 * value someone filtered for. Bucket `<values>`/`<sourceValues>` (the bucket
 * bin definitions) are skipped entirely for the same reason — a bucket's
 * bin boundaries are themselves value literals.
 *
 * `format`/`chart`/`booleanFilter`/`groupings`/`buckets`(identity only)/
 * `crossFilters`(identity only) carry no record-level data — Salesforce
 * report/dashboard structural metadata, not org data — so they are captured
 * verbatim.
 *
 * Field tokens (`filters[].field`, `groupings[].field`) are the RAW XML
 * token, NOT normalized into a `CustomField:` id — a report filter/grouping
 * can legitimately target a pseudo-column (`RecordType`, `OWNER`) or another
 * bucket's `developerName`, neither of which is a resolvable field node, so
 * minting a `CustomField:` id here would imply a reference that may not
 * exist. `buckets[].sourceField` is the one exception: it is ALSO used to
 * emit a `references` edge (declared confidence — the bucket XML states its
 * source column explicitly), so a well-formed, resolvable token there gets
 * both the raw string in the property and a canonical edge target.
 */
const extractReportDetail = (
  xml: string,
  scopeObject: string | null,
  nodeId: string,
): ReportDetailResult => {
  const truncatedCounts: Record<string, number> = {};

  // <filter> — singular wrapper, repeatable <criteriaItems> children.
  const filterBlock = /<filter>([\s\S]*?)<\/filter>/.exec(xml)?.[1] ?? null;
  const booleanFilter = filterBlock !== null
    ? (extractXmlValues(filterBlock, 'booleanFilter')[0] ?? null)
    : null;
  const allFilters = filterBlock !== null
    ? extractReportCriteriaItems(filterBlock).map((c) => ({
        field: c.column,
        operator: c.operator,
        hasValue: c.hasValue,
      }))
    : [];
  const filters = allFilters.slice(0, REPORT_DETAIL_LIST_CAP);
  if (allFilters.length > REPORT_DETAIL_LIST_CAP) {
    truncatedCounts['filters'] = allFilters.length - REPORT_DETAIL_LIST_CAP;
  }

  // <groupingsDown> / <groupingsAcross> — each repeatable at the top level.
  const allGroupings: ReportGroupingItem[] = [];
  for (const m of xml.matchAll(/<groupingsDown>([\s\S]*?)<\/groupingsDown>/g)) {
    const parsed = parseReportGroupingBlock(m[1] ?? '', 'down');
    if (parsed !== null) allGroupings.push(parsed);
  }
  for (const m of xml.matchAll(/<groupingsAcross>([\s\S]*?)<\/groupingsAcross>/g)) {
    const parsed = parseReportGroupingBlock(m[1] ?? '', 'across');
    if (parsed !== null) allGroupings.push(parsed);
  }
  const groupings = allGroupings.slice(0, REPORT_DETAIL_LIST_CAP);
  if (allGroupings.length > REPORT_DETAIL_LIST_CAP) {
    truncatedCounts['groupings'] = allGroupings.length - REPORT_DETAIL_LIST_CAP;
  }

  // <buckets> — repeatable; bin boundaries (<values>/<sourceValues>) are
  // literal data and deliberately never read (see doc comment above).
  const allBuckets: ReportBucketItem[] = [];
  for (const m of xml.matchAll(/<buckets>([\s\S]*?)<\/buckets>/g)) {
    const block = m[1] ?? '';
    const field = extractXmlValues(block, 'developerName')[0];
    const sourceField = extractXmlValues(block, 'sourceColumnName')[0];
    if (field === undefined || sourceField === undefined) continue;
    allBuckets.push({ field, label: extractXmlValues(block, 'masterLabel')[0] ?? null, sourceField });
  }
  const buckets = allBuckets.slice(0, REPORT_DETAIL_LIST_CAP);
  if (allBuckets.length > REPORT_DETAIL_LIST_CAP) {
    truncatedCounts['buckets'] = allBuckets.length - REPORT_DETAIL_LIST_CAP;
  }

  // <crossFilters> — repeatable top-level blocks, each its own relatedTable
  // (real-org verified element name; <relatedEntity> checked as a fallback)
  // + <operation> + its own <criteriaItems> set.
  const allCrossFilters: ReportCrossFilterItem[] = [];
  for (const m of xml.matchAll(/<crossFilters>([\s\S]*?)<\/crossFilters>/g)) {
    const block = m[1] ?? '';
    allCrossFilters.push({
      relatedObject: extractXmlValues(block, 'relatedTable')[0]
        ?? extractXmlValues(block, 'relatedEntity')[0]
        ?? null,
      operation: extractXmlValues(block, 'operation')[0] ?? null,
      hasConditions: extractReportCriteriaItems(block).length > 0,
    });
  }
  const crossFilters = allCrossFilters.slice(0, REPORT_DETAIL_LIST_CAP);
  if (allCrossFilters.length > REPORT_DETAIL_LIST_CAP) {
    truncatedCounts['crossFilters'] = allCrossFilters.length - REPORT_DETAIL_LIST_CAP;
  }

  // <chart> — singular; presence of any <chartSummaries> block is read as
  // "a summary axis is configured" (the axis carrying the aggregated value).
  const chartBlock = /<chart>([\s\S]*?)<\/chart>/.exec(xml)?.[1] ?? null;
  const chart: ReportChartSummary | null = chartBlock !== null
    ? {
        type: extractXmlValues(chartBlock, 'chartType')[0] ?? null,
        hasSummaryAxis: /<chartSummaries>/.test(chartBlock),
      }
    : null;

  const format = extractXmlValues(xml, 'format')[0] ?? null;

  // Bucket source-field edges: DECLARED confidence (the bucket XML states
  // its source column explicitly, not inferred) — gated through the same
  // phantom-field guard as <columns> so a pseudo-column source never mints
  // an unresolvable edge.
  const edges: Edge[] = [];
  for (const bucket of buckets) {
    if (isLegacyDottedAddress(bucket.sourceField)) continue;
    if (!isWellFormedColumnField(bucket.sourceField)) continue;
    const toId = resolveReportFieldToken(bucket.sourceField, scopeObject);
    if (toId === null) continue;
    edges.push({
      fromId: nodeId,
      toId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'bucketSource', bucketField: bucket.field },
    });
  }

  const properties: Record<string, unknown> = {
    ...(filters.length > 0 ? { filters } : {}),
    ...(booleanFilter !== null ? { booleanFilter } : {}),
    ...(groupings.length > 0 ? { groupings } : {}),
    ...(buckets.length > 0 ? { buckets } : {}),
    ...(crossFilters.length > 0 ? { crossFilters } : {}),
    ...(chart !== null ? { chart } : {}),
    ...(format !== null ? { format } : {}),
    ...(Object.keys(truncatedCounts).length > 0 ? { truncatedCounts } : {}),
  };

  return { properties, edges };
};

/** Result of parsing a ReportType's structural shape — see {@link extractReportTypeDetail}. */
interface ReportTypeDetailResult {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly edges: readonly Edge[];
}

/**
 * REPORT-TYPE-OMITS-BASE-OBJECT-JOIN-AND-COLUMNS: parse a ReportType's
 * structural coverage beyond its description. Reads:
 *
 *   - `<baseObject>` — the primary SObject the report type is built on.
 *     Emitted BOTH as `properties.baseObject` AND as a DECLARED `references`
 *     edge to `CustomObject:{baseObject}` (`referenceKind:
 *     'reportTypeBaseObject'`), so "what objects does this report type cover?"
 *     and object-blast-radius walks see it. Skipped when the element is empty
 *     or absent (real report-type XML can carry an empty `<baseObject/>`).
 *
 *   - every `<relationship>` under the (possibly nested) `<join>` tree —
 *     surfaced as `properties.joinRelationships` (deduped + sorted). These are
 *     relationship API NAMES (e.g. `Contacts`, `pkg__Related_Items__r`), NOT
 *     resolvable object ids, so NO edge is minted — minting
 *     `CustomObject:Contacts` would be a phantom, mirroring this file's
 *     discipline for pseudo/relationship tokens elsewhere.
 *
 *   - a COUNT of `<sections><columns>` blocks — `properties.columnCount`, with
 *     `properties.columnsModeled: false` disclosing that the per-column
 *     `<field>`/`<table>` identity graph (potentially hundreds of entries) is a
 *     deferred follow-up. This is the HONEST MINIMUM: the count answers "how
 *     big is this report type" without falsely implying the sparse generic
 *     fieldRefs sweep is the complete column model.
 */
const extractReportTypeDetail = (xml: string, nodeId: string): ReportTypeDetailResult => {
  const edges: Edge[] = [];
  const properties: Record<string, unknown> = {};

  const baseObject = extractXmlValues(xml, 'baseObject')[0];
  if (baseObject !== undefined && baseObject.length > 0) {
    properties['baseObject'] = baseObject;
    edges.push({
      fromId: nodeId,
      toId: `CustomObject:${baseObject}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'reportTypeBaseObject' },
    });
  }

  // All `<relationship>` values across the join tree. In ReportType XML
  // `<relationship>` occurs ONLY inside `<join>` blocks, so a global sweep is
  // safe (no other element shares the name).
  const joinRelationships = [...new Set(extractXmlValues(xml, 'relationship'))].sort();
  if (joinRelationships.length > 0) properties['joinRelationships'] = joinRelationships;

  const columnCount = [...xml.matchAll(/<columns>/g)].length;
  properties['columnCount'] = columnCount;
  properties['columnsModeled'] = false;

  return { properties, edges };
};

/**
 * R6-22: a TransactionSecurityPolicy's `<action>` block, boolean-flag
 * summarized. The Metadata API's `TransactionSecurityAction` shape is
 * `{ block, endSession, freezeUser, notifications[], twoFactorAuthentication }`
 * — each `notifications` entry additionally names an `inApp`/`sendEmail`
 * toggle and a recipient `user`. The recipient identity is a specific admin
 * user, not org-structural metadata, so — consistent with this file's
 * value-omission discipline elsewhere (R6-24's report filter literals) — only
 * the COUNT of configured notification targets is captured, never who they
 * are. Returns `null` when the Report/TSP file carries no `<action>` block at
 * all (a policy can be `active` with only logging, no response action).
 */
const extractTransactionSecurityAction = (
  xml: string,
): Readonly<Record<string, unknown>> | null => {
  const block = /<action>([\s\S]*?)<\/action>/.exec(xml)?.[1] ?? null;
  if (block === null) return null;
  const flag = (elementName: string): boolean =>
    extractXmlValues(block, elementName)[0] === 'true';
  const notificationCount = [...block.matchAll(/<notifications>/g)].length;
  return {
    block: flag('block'),
    endSession: flag('endSession'),
    freezeUser: flag('freezeUser'),
    twoFactorAuthentication: flag('twoFactorAuthentication'),
    notificationCount,
  };
};

/** One `<milestones>` block's OWN field values — see {@link extractMilestoneDetails}. */
interface MilestoneDetail {
  readonly milestoneName: string;
  readonly minutesToComplete: number | null;
  readonly useCriteriaStartTime: boolean | null;
}

/**
 * R7-C7: parse EACH `<milestones>` block of an `EntitlementProcess` file for
 * its OWN `<milestoneName>` / `<minutesToComplete>` / `<useCriteriaStartTime>`
 * — scoped PER BLOCK via a block-bounded regex (mirrors
 * {@link extractReportCriteriaItems} / {@link parseReportGroupingBlock}'s
 * per-block scoping), never the generic file-wide `extraProperties` reader.
 *
 * This is the trap `extractEntitlementProcess`'s own R6-18 doc comment named
 * and deliberately did NOT ship: `extraProperties` calls
 * {@link extractXmlValues} once per element NAME across the WHOLE file and
 * keeps only the first match — with 2+ `<milestones>` blocks per file (a
 * real verified fixture has three), a flat `minutesToComplete` read would
 * silently misattribute one milestone's target minutes to a different
 * milestone. Scoping the read to each block's own captured text (rather than
 * the whole file) is what makes the per-milestone attribution correct.
 *
 * A block missing `<milestoneName>` is skipped (cannot be attributed to a
 * milestone at all). A present-but-unparseable `<minutesToComplete>` (not a
 * finite number) or an absent one is `null` — never defaulted to 0, which
 * would misrepresent "not set" as "completes immediately". Same tri-state
 * discipline for `<useCriteriaStartTime>` (`null` when absent, never
 * defaulted to `false`).
 *
 * `<timeTriggers>` (nested per-milestone escalation actions) and
 * `<exitCriteriaFilterItems>` (the process-level exit condition) are OUT of
 * scope — not captured here or elsewhere; disclosed, not silently dropped.
 */
const extractMilestoneDetails = (xml: string): readonly MilestoneDetail[] => {
  const out: MilestoneDetail[] = [];
  for (const match of xml.matchAll(/<milestones>([\s\S]*?)<\/milestones>/g)) {
    const block = match[1] ?? '';
    const milestoneName = extractXmlValues(block, 'milestoneName')[0];
    if (milestoneName === undefined) continue;
    const minutesRaw = extractXmlValues(block, 'minutesToComplete')[0];
    const minutes = minutesRaw !== undefined ? Number(minutesRaw) : null;
    const useCriteriaStartTimeRaw = extractXmlValues(block, 'useCriteriaStartTime')[0];
    out.push({
      milestoneName,
      minutesToComplete: minutes !== null && Number.isFinite(minutes) ? minutes : null,
      useCriteriaStartTime:
        useCriteriaStartTimeRaw === undefined ? null : useCriteriaStartTimeRaw === 'true',
    });
  }
  return out;
};

/**
 * A resolved `<sharedTo>` visibility target for a list view — the variant
 * element it came from, its inner name (null for self-closing synthetic
 * variants like `<allInternalUsers/>`), the canonical `Group:`/`Role:` edge
 * target, and any extra edge props (inheritance / synthetic markers).
 */
interface SharedToTarget {
  readonly type: string;
  readonly name: string | null;
  readonly targetId: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

/**
 * Read a list view's `<sharedTo>` visibility scope. Unlike a sharing rule's
 * `<sharedTo>` (exactly one variant), a list view's can hold MANY children
 * (several roles + groups) and a variant element can repeat, so we collect all
 * of them. The element→id logic is shared with sharing rules via
 * {@link VARIANT_TABLE} so `visibleTo` and `sharedWith` never drift. The XML
 * is read with line-bounded regexes to match the rest of this module (no
 * fast-xml-parser dependency here).
 */
const readListViewSharedTo = (xml: string): readonly SharedToTarget[] => {
  const targets: SharedToTarget[] = [];
  const seen = new Set<string>();
  for (const blockMatch of xml.matchAll(/<sharedTo>([\s\S]*?)<\/sharedTo>/g)) {
    const block = blockMatch[1] ?? '';
    for (const [variantKey, spec] of Object.entries(VARIANT_TABLE)) {
      if (spec.syntheticName !== null) {
        // Self-closing variant (e.g. `<allInternalUsers/>`): presence-only.
        if (new RegExp(`<${variantKey}\\b`).test(block)) {
          const targetId = `${spec.idPrefix}:${spec.syntheticName}`;
          if (!seen.has(targetId)) {
            seen.add(targetId);
            targets.push({ type: variantKey, name: null, targetId, extraProps: spec.extraProps });
          }
        }
        continue;
      }
      for (const name of extractXmlValues(block, variantKey)) {
        const targetId = `${spec.idPrefix}:${name}`;
        const dedupeKey = `${variantKey}:${targetId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        targets.push({ type: variantKey, name, targetId, extraProps: spec.extraProps });
      }
    }
  }
  return targets;
};

const makeNode = (
  type: ComponentType,
  apiName: string,
  path: string,
  parentId: string | null,
  properties: Readonly<Record<string, unknown>>,
  label: string | null = null,
): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label,
  parentId,
  sourcePath: path,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const extractEnterpriseMetadata = async (
  path: string,
  config: EnterpriseExtractorConfig,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const text = await readText(path);
  if (!text.ok) return text;

  let apiName: string;
  let parentObjectApiName: string | null = null;
  if (config.nestedParent !== undefined) {
    const nested = deriveNestedObjectAndApiName(path, config.suffix, config.nestedParent);
    if (nested === null) {
      return err({
        kind: 'malformed-input',
        path,
        message: `cannot resolve parent object from path for ${config.type}`,
      });
    }
    apiName = `${nested.objectApiName}.${nested.apiName}`;
    parentObjectApiName = nested.objectApiName;
  } else {
    apiName = deriveComponentApiName(path, config.suffix);
  }
  if (parentObjectApiName === null && config.parentFromXmlElement !== undefined) {
    const fromXml = extractXmlValues(text.value, config.parentFromXmlElement)[0];
    if (fromXml !== undefined && fromXml.length > 0) parentObjectApiName = fromXml;
  }

  const fieldRefResult = extractFieldRefs(text.value, parentObjectApiName, {
    listViewFilterScoped: config.parseListViewFilters === true,
  });
  const fieldRefs = fieldRefResult.refs;
  // CR-CAP-13: list-view filter-predicate field identity. `filterFieldRefs` is
  // the set of well-formed fields a `<filters>` block predicates on; a field
  // that is ALSO a column appears in BOTH sets and is merged into one
  // `columnAndFilter` edge below (the edge PK cannot hold two `references`).
  const filterFieldRefResult = config.parseListViewFilters === true
    ? extractListViewFilterRefs(
        text.value,
        parentObjectApiName ?? inferReportObjectApiName(text.value),
      )
    : null;
  const filterFieldRefs = filterFieldRefResult?.refs ?? [];
  const filterFieldRefSet = new Set(filterFieldRefs);
  // R6-04: honest disclosure of legacy-dotted-addressing tokens (CONTACT.EMAIL,
  // CORE.USERS.ALIAS, …) skipped rather than guessed at — see
  // `isLegacyDottedAddress`. ListView-scoped only (the ticket's ask), so
  // Report/Dashboard/ReportType/FlexiPage output is unaffected here even
  // though the underlying guard fix benefits all five column-routing types.
  const legacyAddressingRefsSkipped = config.parseListViewFilters === true
    ? fieldRefResult.skippedLegacyDotted + (filterFieldRefResult?.skippedLegacyDotted ?? 0)
    : 0;
  const nodeId = `${config.type}:${apiName}`;

  // R6-24: Report structural depth (filters/groupings/buckets/crossFilters/
  // chart/format) — see {@link extractReportDetail} for the value-omission
  // rationale. Report-only (config.reportDetail); a no-op object otherwise.
  const reportDetail = config.reportDetail === true
    ? extractReportDetail(
        text.value,
        parentObjectApiName ?? inferReportObjectApiName(text.value),
        nodeId,
      )
    : null;

  // REPORT-TYPE-OMITS-BASE-OBJECT-JOIN-AND-COLUMNS: ReportType base object +
  // join relationships + column count — see {@link extractReportTypeDetail}.
  // ReportType-only (config.reportTypeDetail).
  const reportTypeDetail = config.reportTypeDetail === true
    ? extractReportTypeDetail(text.value, nodeId)
    : null;

  // R6-22: TransactionSecurityPolicy `<action>` block summary — see
  // {@link extractTransactionSecurityAction}. TSP-only (config.transactionSecurityAction).
  const transactionSecurityAction = config.transactionSecurityAction === true
    ? extractTransactionSecurityAction(text.value)
    : null;

  // R7-C7: EntitlementProcess per-milestone minutesToComplete /
  // useCriteriaStartTime — see {@link extractMilestoneDetails}.
  // EntitlementProcess-only (config.captureMilestones).
  const milestoneDetails = config.captureMilestones === true
    ? extractMilestoneDetails(text.value)
    : null;

  // Explicit child-element references (PSG membership / muting, etc.) — emitted
  // as DECLARED `references` edges and mirrored onto properties for direct reads.
  const childRefEdges: Edge[] = [];
  const childRefSummary: Record<string, readonly string[]> = {};
  for (const spec of config.childRefs ?? []) {
    const values = [...new Set(extractXmlValues(text.value, spec.element))].sort();
    if (values.length > 0) childRefSummary[spec.element] = values;
    for (const value of values) {
      childRefEdges.push({
        fromId: nodeId,
        toId: `${spec.toType}:${value}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { referenceKind: spec.referenceKind },
      });
    }
  }

  // RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: Profile Ids gated in the
  // rule's `<userCriteria>`. Emitted as HEURISTIC `references` edges to an
  // explicit `UnresolvedProfile:{id}` stub — NOT a `Profile:{id}` node, which
  // would masquerade as a real Profile (a single-file extractor cannot resolve
  // the opaque id to the name-keyed Profile node; that happens downstream in
  // `resolveRestrictionRuleProfileEdges` over the full node set). Mirrored onto
  // `properties.userCriteriaProfileIds` (all gated ids) and
  // `properties.unresolvedProfileIds` (the disclosure — every gated id is
  // unresolved at extract time). Empty for every other type.
  const userCriteriaProfileIds =
    config.userCriteriaProfileRefs === true
      ? extractUserCriteriaProfileIds(text.value)
      : [];
  const userCriteriaProfileEdges: Edge[] = userCriteriaProfileIds.map((profileId) => ({
    fromId: nodeId,
    toId: `${UNRESOLVED_PROFILE_PREFIX}${profileId}`,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EXTRACTOR_SOURCE,
    properties: {
      referenceKind: 'restrictionUserProfileUnresolved',
      unresolvedProfileId: profileId,
      idBasedTarget: true,
    },
  }));

  // R7-C7: plain property-array elements (no edge; e.g. PresenceUserConfig's
  // assigned usernames — no User ComponentType to target). Deduplicated +
  // sorted; every occurrence is captured, never just the first (the R6-18
  // repeated-element trap `extraProperties` alone would fall into).
  const arrayPropertyBlock: Record<string, readonly string[]> = {};
  for (const spec of config.arrayProperties ?? []) {
    const values = [...new Set(extractXmlValues(text.value, spec.element))].sort();
    if (values.length > 0) arrayPropertyBlock[spec.propertyName] = values;
  }

  // List-view visibility scope: `<sharedTo>` targets + `<filterScope>`. Emitted
  // as DECLARED `visibleTo` edges (saved-view visibility, NOT record access)
  // and mirrored onto properties so the consumer reads them without a graph walk.
  const visibleToEdges: Edge[] = [];
  const sharedToSummary: SharedToTarget[] = [];
  let filterScope: string | undefined;
  if (config.captureSharedTo) {
    filterScope = extractXmlValues(text.value, 'filterScope')[0];
    for (const target of readListViewSharedTo(text.value)) {
      sharedToSummary.push(target);
      visibleToEdges.push({
        fromId: nodeId,
        toId: target.targetId,
        edgeType: 'visibleTo',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { sharedToType: target.type, ...target.extraProps },
      });
    }
  }

  // Resolve the optional label from a configured XML element.
  const label: string | null =
    config.labelXmlElement !== undefined
      ? (extractXmlValues(text.value, config.labelXmlElement)[0] ?? null)
      : null;

  // Resolve extra scalar properties declared in config.extraProperties.
  const extraPropertiesBlock: Record<string, string> = {};
  for (const elemName of config.extraProperties ?? []) {
    const value = extractXmlValues(text.value, elemName)[0];
    if (value !== undefined) extraPropertiesBlock[elemName] = value;
  }

  const node = makeNode(
    config.type,
    apiName,
    path,
    parentObjectApiName === null ? null : `CustomObject:${parentObjectApiName}`,
    {
      fieldRefs,
      rawReferenceCount: fieldRefs.length,
      ...(config.parseListViewFilters === true
        ? { filterFieldRefs }
        : {}),
      // R6-04: omitted (not zero) when nothing was skipped — "extracted, none
      // skipped" reads differently from "not checked", matching this file's
      // extraProperties convention elsewhere.
      ...(legacyAddressingRefsSkipped > 0 ? { legacyAddressingRefsSkipped } : {}),
      ...childRefSummary,
      ...(userCriteriaProfileIds.length > 0
        ? { userCriteriaProfileIds, unresolvedProfileIds: userCriteriaProfileIds }
        : {}),
      ...arrayPropertyBlock,
      ...(config.captureSharedTo
        ? {
            sharedTo: sharedToSummary.map(({ type, name, targetId, extraProps }) => ({
              type,
              name,
              targetId,
              ...extraProps,
            })),
            ...(filterScope !== undefined ? { filterScope } : {}),
          }
        : {}),
      ...extraPropertiesBlock,
      ...(reportDetail !== null ? reportDetail.properties : {}),
      ...(reportTypeDetail !== null ? reportTypeDetail.properties : {}),
      ...(transactionSecurityAction !== null ? { action: transactionSecurityAction } : {}),
      ...(milestoneDetails !== null && milestoneDetails.length > 0
        ? { milestones: milestoneDetails }
        : {}),
    },
    label,
  );

  // CR-CAP-13: ONE `references` edge per (ListView, field). The edge PK is
  // `(fromId,toId,edgeType,source)` — emitting separate fieldRef + filterRef
  // edges to the same field would collide and one would be silently dropped at
  // import. Merge the role into a single `referenceKind`: a field that is a
  // column AND a filter is `columnAndFilter`; a filter-only field is
  // `filterRef`; a column-only field stays `fieldRef`. Union the two sets so a
  // filter-only field still emits its edge.
  const allFieldIds = [...new Set([...fieldRefs, ...filterFieldRefs])].sort();
  const fieldRefEdges: Edge[] = allFieldIds.map((fieldId) => {
    const isColumn = fieldRefs.includes(fieldId);
    const isFilter = filterFieldRefSet.has(fieldId);
    const referenceKind = isColumn && isFilter
      ? 'columnAndFilter'
      : isFilter
        ? 'filterRef'
        : 'fieldRef';
    return {
      fromId: node.id,
      toId: fieldId,
      edgeType: 'references',
      confidence: 'heuristic',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind },
    };
  });

  // RESTRICTION-RULE-MISSING-OBJECT-GRAPH: emit the object→rule `parentOf` edge
  // when opted in AND a parent object resolved. Without it the rule node carries
  // `parentId` but no traversable edge, so `get_edges` / object-scoped impact /
  // sharing surfaces never reach it.
  const parentEdges: Edge[] =
    config.parentEdge === true && parentObjectApiName !== null
      ? [
          {
            fromId: `CustomObject:${parentObjectApiName}`,
            toId: node.id,
            edgeType: 'parentOf',
            confidence: 'declared',
            source: EXTRACTOR_SOURCE,
            properties: {},
          },
        ]
      : [];

  return ok({
    nodes: [node],
    edges: [
      ...parentEdges,
      ...fieldRefEdges,
      ...childRefEdges,
      ...userCriteriaProfileEdges,
      ...visibleToEdges,
      ...(reportDetail !== null ? reportDetail.edges : []),
      ...(reportTypeDetail !== null ? reportTypeDetail.edges : []),
    ],
  });
};

export const extractReport = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'Report',
    suffix: '.report-meta.xml',
    // Reports carry a top-level <description> in source. Capture it so
    // "which reports have no description" is answerable and get_component
    // can surface the report's stated purpose. Omitted when absent — the
    // "extracted, none present" signal (vs a not-modeled type).
    extraProperties: ['description'],
    // R6-24: filters/booleanFilter/groupings/buckets/crossFilters/chart/
    // format — see {@link extractReportDetail}.
    reportDetail: true,
  });

export const extractDashboard = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'Dashboard',
    suffix: '.dashboard-meta.xml',
    // Dashboards carry a top-level <description>. Same capture rationale as
    // Report — omitted when absent.
    extraProperties: ['description'],
  });

export const extractListView = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'ListView',
    suffix: '.listView-meta.xml',
    captureSharedTo: true,
    parseListViewFilters: true,
    nestedParent: 'listViews',
  });

export const extractReportType = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'ReportType',
    suffix: '.reportType-meta.xml',
    // The ReportType XML has a top-level <label> element (e.g. "Bot Metrics
    // Daily Summer '22") that distinguishes versioned clones from each other.
    // Without this, makeNode always sets label: null and get_component has no
    // human-readable display name to surface in vault Markdown.
    labelXmlElement: 'label',
    // ReportType XML carries a top-level <description> (nearly universal in
    // source). Capture it so custom report types disclose their purpose and
    // are queryable via missingDescription. Omitted when absent.
    //
    // REPORT-TYPE-OMITS-BASE-OBJECT-JOIN-AND-COLUMNS: also surface the
    // top-level <category> (accounts | opportunities | …) and <deployed>
    // (true | false) scalars so the report type's catalog placement and
    // deploy state are queryable; base object / join tree / column count come
    // from `reportTypeDetail` below.
    extraProperties: ['description', 'category', 'deployed'],
    reportTypeDetail: true,
  });

/**
 * CR-CAP-15: extract a CustomPermission DEFINITION node from a flat
 * `customPermissions/{DeveloperName}.customPermission-meta.xml` file. The node
 * id is `CustomPermission:{DeveloperName}` (no parent scope) — the exact target
 * a PermissionSet/Profile `<customPermissions><name>X</name>` grant resolves to
 * (CR-CAP-10's `grantedBy` edge). Definition-node only: the optional
 * `<requiredPermission>` dependency edges and `<connectedApp>` reference are a
 * deferred follow-up (the generic field scanner emits no useful edges for a
 * CustomPermission's plain-text label/description).
 */
export const extractCustomPermission = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, { type: 'CustomPermission', suffix: '.customPermission-meta.xml' });

/**
 * R6-22: extract a Certificate node from a flat `certs/{DeveloperName}.crt-meta.xml`
 * file. Salesforce retrieves a Certificate as TWO files — this metadata
 * sidecar (`caSigned`/`expirationDate`/`keySize`/`masterLabel`/…) and a
 * separate `{DeveloperName}.crt` content file carrying the actual PEM/DER
 * certificate or exported key material. ONLY the sidecar is ever read: the
 * dispatcher below matches strictly on the `.crt-meta.xml` suffix, so the
 * companion `.crt` content file never reaches an extractor at all (like any
 * other unrecognized file, it is silently skipped by the source-tree walk).
 * This mirrors the R6-24 report-filter value-omission rule extended to key
 * material — metadata about a secret, never the secret.
 *
 * Surfaces `caSigned` (CA-signed vs self-signed), `expirationDate`, and
 * `keySize` as properties (raw XML text, matching this file's
 * `extraProperties` convention elsewhere); `label` = `masterLabel`. Flat, no
 * parent scope, no edges — mirrors CustomPermission/RestrictionRule.
 */
export const extractCertificate = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'Certificate',
    suffix: '.crt-meta.xml',
    labelXmlElement: 'masterLabel',
    extraProperties: ['caSigned', 'expirationDate', 'keySize'],
  });

/**
 * R6-22: extract a TransactionSecurityPolicy node from a flat
 * `transactionSecurityPolicies/{DeveloperName}.transactionSecurityPolicy-meta.xml`
 * file — an event-triggered security policy ("when `eventName` X happens,
 * take `action` Y"). Surfaces `eventName` and `active` verbatim
 * (`extraProperties`), `action` as a boolean-flag summary (see
 * {@link extractTransactionSecurityAction} — never the notification
 * recipients), and emits a DECLARED `references` edge (`referenceKind:
 * 'conditionClass'`) to `ApexClass:{apexClass}` when `<apexClass>` is
 * present — the class implementing `TxnSecurity.PolicyCondition`/
 * `EventCondition` that decides whether the policy fires. The nested
 * `<action><notifications>` recipient/blockMessage/customEmailContent/flowId
 * fields are out of this tier's scope (not requested; `flowId` in particular
 * names an alternate v46+ condition mechanism — CustomConditionBuilderPolicy
 * — this extractor does not yet model).
 */
export const extractTransactionSecurityPolicy = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'TransactionSecurityPolicy',
    suffix: '.transactionSecurityPolicy-meta.xml',
    extraProperties: ['eventName', 'active'],
    transactionSecurityAction: true,
    childRefs: [
      { element: 'apexClass', toType: 'ApexClass', referenceKind: 'conditionClass' },
    ],
  });

/**
 * The `<type>` values that name a FLEXIPAGE'S page kind (vs the overloaded
 * region/component `<type>` values like `Region`/`Facet`/`Component`). Used to
 * pick the page type out of the many `<type>` occurrences in the XML.
 */
const FLEXIPAGE_PAGE_TYPES = new Set([
  'RecordPage',
  'AppPage',
  'HomePage',
  'CommAppPage',
  'CommObjectPage',
  'ServiceCenter',
  'UtilityBar',
  'MailAppCanvasFolder',
]);

/**
 * Scan a FlexiPage XML for `{!$Permission.CustomPermission.X}` patterns
 * inside `<leftValue>` elements (visibilityRule criteria blocks). These
 * custom-permission gate checks are invisible to `extractFieldRefs` because
 * they appear inside `<leftValue>` tags whose content is a formula-expression
 * token, not a plain field API name or dotted field reference.
 *
 * Returns an array of deduplicated canonical `CustomPermission:{Name}` ids,
 * sorted for stable output.
 */
const extractFlexiPagePermissionRefs = (xml: string): readonly string[] => {
  // Pattern: {!$Permission.CustomPermission.AssignClinicalLead}
  // — `$Permission.CustomPermission.` is the fixed prefix;
  // — the permission name is one or more word chars (A-Za-z0-9_).
  const permRe = /\{[!]?\$Permission\.CustomPermission\.([A-Za-z0-9_]+)\}/g;
  const seen = new Set<string>();
  for (const match of xml.matchAll(permRe)) {
    const permName = match[1];
    if (permName !== undefined && permName.length > 0) {
      seen.add(`CustomPermission:${permName}`);
    }
  }
  return [...seen].sort();
};

/**
 * FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED: a Lightning record page embeds a Screen
 * Flow through a `<componentInstance>` whose `<componentName>` is the platform
 * `flowruntime:interview` component, naming the Flow via a `flowName` property:
 *
 *   <componentInstance>
 *     <componentInstanceProperties>
 *       <name>flowName</name><value>My_Screen_Flow</value>
 *     </componentInstanceProperties>
 *     <componentName>flowruntime:interview</componentName>
 *   </componentInstance>
 *
 * The field / permission sweeps never looked at these components, so an active
 * embedded Flow showed 0 usages and `review_change` delete read `safe`. Emit the
 * FlexiPage -> `Flow:{flowName}` edge so the Lightning page counts as a Flow
 * dependent.
 *
 * Precise scoping: only a `flowName` property that sits inside a
 * `flowruntime:interview` component instance is treated as an embedded-Flow
 * pointer (a bespoke LWC could carry an unrelated `flowName` property). The
 * componentInstance regex is non-greedy to the first `</componentInstance>`,
 * which is correct for the leaf interview components (they nest no child
 * component instances). Returns deduplicated Flow api names, sorted for stable
 * output.
 */
const extractFlexiPageEmbeddedFlows = (xml: string): readonly string[] => {
  const instanceRe = /<componentInstance\b[\s\S]*?<\/componentInstance>/g;
  const propRe =
    /<componentInstanceProperties>([\s\S]*?)<\/componentInstanceProperties>/g;
  const seen = new Set<string>();
  for (const inst of xml.matchAll(instanceRe)) {
    const block = inst[0];
    if (!/<componentName>\s*flowruntime:interview\s*<\/componentName>/.test(block)) {
      continue;
    }
    for (const prop of block.matchAll(propRe)) {
      const inner = prop[1] ?? '';
      if (!/<name>\s*flowName\s*<\/name>/.test(inner)) continue;
      const value = /<value>([^<]+)<\/value>/.exec(inner)?.[1]?.trim();
      if (value !== undefined && value.length > 0) seen.add(value);
    }
  }
  return [...seen].sort();
};

/**
 * Extract a FlexiPage (Lightning page). Beyond the bare node, captures
 * `sobjectType` (which object the page is for), `pageType` (RecordPage /
 * AppPage / HomePage — picked from the page-type set, since `<type>` is also
 * used by regions/components), and `masterLabel`, and emits a `references`
 * edge FlexiPage → `CustomObject:{sobjectType}` so "what Lightning pages are
 * for object X" is answerable. fieldRefs are scoped by sobjectType.
 *
 * v2.9: also scans for `{!$Permission.CustomPermission.X}` patterns in
 * `<leftValue>` elements (visibilityRule criteria) and emits a declared
 * `references` edge FlexiPage → `CustomPermission:{Name}` tagged
 * `referenceKind: 'visibilityRulePermission'` for each match. This makes
 * custom-permission gates in Lightning page visibility rules discoverable via
 * `sfi.find_component_usages`, `sfi.get_edges`, and `sfi.blast_radius_live`.
 *
 * FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED: also scans for Screen Flows embedded via
 * `flowruntime:interview` components and emits a declared `references` edge
 * FlexiPage -> `Flow:{flowName}` (plus a `embeddedFlows` node property) for each,
 * so an active embedded Flow no longer reads as 0-usage / safe-to-delete.
 *
 * HONESTY: the profile/recordType/app/form-factor ACTIVATION (which user sees
 * which page) is NOT in the retrieved FlexiPage metadata — it is a separate
 * Lightning App Builder assignment. `activationsModeled: false` flags that so
 * the consuming tool discloses the gap rather than implying an assignment.
 */
export const extractFlexiPage = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const text = await readText(path);
  if (!text.ok) return text;
  const apiName = deriveComponentApiName(path, '.flexipage-meta.xml');
  const nodeId = `FlexiPage:${apiName}`;
  const sobjectType = extractXmlValues(text.value, 'sobjectType')[0] ?? null;
  const masterLabel = extractXmlValues(text.value, 'masterLabel')[0] ?? null;
  const pageType =
    extractXmlValues(text.value, 'type').find((t) => FLEXIPAGE_PAGE_TYPES.has(t)) ?? null;
  const fieldRefs = extractFieldRefs(text.value, sobjectType).refs;
  // v2.9: visibility-rule custom-permission references.
  const permissionRefs = extractFlexiPagePermissionRefs(text.value);
  // FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED: Screen Flows embedded via
  // `flowruntime:interview` components (previously invisible → false safe-to-delete).
  const embeddedFlows = extractFlexiPageEmbeddedFlows(text.value);

  const edges: Edge[] = fieldRefs.map((fieldId) => ({
    fromId: nodeId,
    toId: fieldId,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EXTRACTOR_SOURCE,
    properties: { referenceKind: 'fieldRef' },
  }));
  // FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED: one declared `references` edge per
  // embedded Screen Flow. `flowName` is a declared metadata pointer, so the
  // Flow api name resolves directly to the `Flow:{name}` node.
  for (const flowName of embeddedFlows) {
    edges.push({
      fromId: nodeId,
      toId: `Flow:${flowName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'embeddedFlow' },
    });
  }
  if (sobjectType !== null) {
    edges.push({
      fromId: nodeId,
      toId: `CustomObject:${sobjectType}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'flexiPageObject' },
    });
  }
  // v2.9: emit one declared `references` edge per custom-permission gate.
  for (const permId of permissionRefs) {
    edges.push({
      fromId: nodeId,
      toId: permId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'visibilityRulePermission' },
    });
  }

  const node = makeNode('FlexiPage', apiName, path, null, {
    sobjectType,
    pageType,
    masterLabel,
    activationsModeled: false,
    fieldRefs,
    rawReferenceCount: fieldRefs.length,
    permissionRefs,
    embeddedFlows,
  });
  return ok({ nodes: [node], edges });
};

export const extractPermissionSetGroup = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'PermissionSetGroup',
    suffix: '.permissionsetgroup-meta.xml',
    // PSGs carry a top-level <description>. Capture it so the group's stated
    // purpose is surfaced and queryable via missingDescription. Omitted when
    // absent.
    //
    // PERMISSIONSETGROUP-OMITS-STATUS-AND-ACTIVATION: a PSG also carries a
    // top-level <status> (Updated | Outdated | Updating | Failed — is the
    // group's recalculated grant set current?) and <hasActivationRequired>
    // (whether the group is a session-activated / just-in-time bundle). Both
    // were dropped, so an admin's "is this PSG ready / session-activated?"
    // could not be answered from structured facts. Captured verbatim as raw
    // XML strings (matching this file's extraProperties convention for the
    // sibling `deployed` / `active` flags); omitted when the element is absent
    // ("extracted, none present" reads differently from "not checked").
    extraProperties: ['description', 'status', 'hasActivationRequired'],
    // A PSG's effective permissions are the UNION of its member permission
    // sets' grants, minus the muting permission set's. Capture both so the
    // permission analysis can flow god-mode / object grants through the group.
    childRefs: [
      {
        element: 'permissionSets',
        toType: 'PermissionSet',
        referenceKind: 'permissionSetGroupMember',
      },
      {
        element: 'mutingPermissionSets',
        toType: 'MutingPermissionSet',
        referenceKind: 'mutingPermissionSet',
      },
    ],
  });

// NOTE: `extractMutingPermissionSet` moved to `./muting-permission-set.js` — it
// is no longer a bare enterprise-metadata node. The muting file mirrors
// permission-set XML with INVERTED (`true` = muted) semantics, so it needs the
// permission-set parser to capture the object / field / system / custom / apex
// permissions it DENIES, which `effective_permissions` subtracts within the
// owning PermissionSetGroup. See that module for the muted-perm node properties.

// Salesforce stores RestrictionRule / ScopingRule as TOP-LEVEL files named
// `{restriction,scoping}Rules/{DeveloperName}.rule-meta.xml` — the `.rule-meta.xml`
// suffix (NOT `.{type}Rule-meta.xml`), and not nested under an object. The old
// config matched neither real suffix nor real layout, so these types never
// extracted on real metadata (files were skipped). Found via a grounded real-org
// refresh during Phase-10 hardening.
export const extractRestrictionRule = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'RestrictionRule',
    suffix: '.rule-meta.xml',
    // Top-level layout carries no object in the path; `<targetEntity>` names
    // the restricted object (why_cant / who_can_access_object key on parentId).
    parentFromXmlElement: 'targetEntity',
    // RESTRICTION-RULE-MISSING-OBJECT-GRAPH: also emit the object→rule parentOf
    // edge so the security graph is traversable, not just parentId-tagged.
    parentEdge: true,
    // RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: resolve the
    // `$User.ProfileId='00e...'` gate in <userCriteria> to a Profile edge
    // (id-based stub) so profile-retirement / sharing reviews see the rule and
    // the constrained profile is not read as unused.
    userCriteriaProfileRefs: true,
    // Surface enforcement semantics directly so get_component can explain
    // Restrict vs Scoping, show the SOQL filter, user-criteria profile, and
    // active state without requiring a live query.
    extraProperties: ['enforcementType', 'recordFilter', 'userCriteria', 'active'],
  });

export const extractScopingRule = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'ScopingRule',
    suffix: '.rule-meta.xml',
    parentFromXmlElement: 'targetEntity',
    // Same object→rule parentOf edge as RestrictionRule (both are top-level
    // rules whose parent object comes from `<targetEntity>`).
    parentEdge: true,
    // Same set as RestrictionRule — both rule types share the same XML schema
    // and the same consumer questions (what filter / who does it apply to).
    extraProperties: ['enforcementType', 'recordFilter', 'userCriteria', 'active'],
  });

// R6-18 — Service Cloud entitlement/SLA + Omni-Channel routing tier. Closes
// the eval-refused "what's the SLA on this case" / "how are cases routed to
// agents" gap. Folder/suffix for all four types below were verified against
// REAL scoped retrieves (`sf project retrieve start --metadata
// EntitlementProcess --metadata MilestoneType --metadata ServiceChannel
// --metadata QueueRoutingConfig`) from two live orgs — not assumed from the
// Metadata API Developer Guide alone. Real content shapes are mirrored in the
// synthetic test fixtures (no real org identifiers, per privacy policy).

/**
 * Extract an `EntitlementProcess` — Salesforce's SLA definition for one
 * SObject (`entitlementProcesses/{fullName}.entitlementProcess-meta.xml`).
 *
 * **Versioning honesty**: an entitlement process can have MULTIPLE files —
 * one per version — each independently retrieved. This extractor does NOT
 * merge versions into one logical node; each file becomes its own node keyed
 * by that file's own `fullName` (which is how Salesforce itself distinguishes
 * versions — e.g. a cloned process gets a new `fullName`). `versionNumber` /
 * `versionMaster` / `isVersionDefault` / `versionNotes` are captured verbatim
 * per file when present so a caller can tell related versions apart, but no
 * cross-version linking is performed.
 *
 * Captures `SObjectType`, `active`, `businessHours` (the business-hours
 * NAME only — there is no `BusinessHours` ComponentType in this vault to
 * link to), `entryStartDateField`, `description`, and the top-level `<name>`
 * (the process's display label, distinct from the file's own `fullName`/
 * apiName — a real verified fixture had no `<name>` element at all, so this
 * is `null` when absent, never guessed from the apiName).
 *
 * **Milestone references**: each `<milestones>` block's `<milestoneName>`
 * child is promoted to a `references` edge to `MilestoneType:{Name}`
 * (`referenceKind: 'entitlementMilestone'`, `declared` confidence) via the
 * generic `childRefs` mechanism — `extractXmlValues` scans the WHOLE file for
 * `<milestoneName>` occurrences regardless of nesting, which is exactly the
 * flat list of milestones this process touches.
 *
 * **Per-milestone detail (R7-C7)**: the `milestones` property additionally
 * carries EACH block's own `minutesToComplete` and `useCriteriaStartTime` —
 * `[{ milestoneName, minutesToComplete, useCriteriaStartTime }, …]`, in file
 * order. This was DELIBERATELY NOT shipped at R6-18: the generic
 * `extraProperties` reads only the FIRST occurrence of a repeated element —
 * with 2+ `<milestones>` blocks per file (the real verified fixture has
 * three), a flat `minutesToComplete` read would silently misattribute one
 * milestone's target minutes to a different milestone. {@link
 * extractMilestoneDetails} fixes this with a block-scoped parser so each
 * milestone's own value is captured correctly and distinctly — verified
 * against a real file (`standard case`: 240 / 1440 / 5760 minutes across
 * three milestones). **Still deliberately NOT captured**: `<timeTriggers>`
 * (nested per-milestone escalation actions) and `<exitCriteriaFilterItems>`
 * (the process-level exit condition) — disclosed, not silently dropped.
 *
 * **Honesty boundary** (load-bearing for `sfi.lifecycle_process` /
 * `sfi.what_happens_on_save`): this extractor answers WHICH milestones apply
 * to an object, whether the process is active, and (as of R7-C7) each
 * milestone's TARGET minutes — it does NOT answer whether a specific case is
 * currently on-track or breached (that is live, per-record timer data this
 * offline vault cannot hold).
 */
export const extractEntitlementProcess = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'EntitlementProcess',
    suffix: '.entitlementProcess-meta.xml',
    labelXmlElement: 'name',
    extraProperties: [
      'SObjectType',
      'active',
      'businessHours',
      'versionNumber',
      'versionMaster',
      'isVersionDefault',
      'versionNotes',
      'entryStartDateField',
      'description',
    ],
    childRefs: [
      {
        element: 'milestoneName',
        toType: 'MilestoneType',
        referenceKind: 'entitlementMilestone',
      },
    ],
    // R7-C7: per-milestone minutesToComplete / useCriteriaStartTime — see
    // {@link extractMilestoneDetails}.
    captureMilestones: true,
  });

/**
 * Extract a `MilestoneType` — the org-wide milestone DEFINITION an
 * `EntitlementProcess` references by name
 * (`milestoneTypes/{fullName}.milestoneType-meta.xml`).
 *
 * Real Metadata API files (verified against a live org) carry no `<name>` /
 * `<label>` element at all — the file's own `fullName` (the node's
 * `apiName`) IS the display name. Only `<description>` and
 * `<recurrenceType>` (`none` | `recursIndependently` | `recursChained` in
 * real org data) are present. Node-only — the `EntitlementProcess ->
 * MilestoneType` edge is emitted by {@link extractEntitlementProcess}, not
 * here (a MilestoneType file carries no back-reference to the processes that
 * use it).
 */
export const extractMilestoneType = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'MilestoneType',
    suffix: '.milestoneType-meta.xml',
    extraProperties: ['description', 'recurrenceType'],
  });

/**
 * Extract a `ServiceChannel` — an Omni-Channel routable work-item type
 * (Case, Chat, Voice Call, Messaging Session, …), one file per channel
 * (`serviceChannels/{fullName}.serviceChannel-meta.xml`).
 *
 * The related-object field is `relatedEntityType` (verified against real
 * retrieves from two live orgs, e.g. `Case`, `LiveChatTranscript`,
 * `MessagingSession`, `VoiceCall`) — **not** `salesforceObject`; an earlier
 * assumption about the field name did not match either real org's XML or the
 * Metadata API Developer Guide's own field reference, and has been corrected
 * here rather than shipped as a guess. `capacityModel` (`STATUS_BASED` |
 * `TAB_BASED`) is the "capacity config" ServiceChannel itself carries — the
 * PER-ROUTING-CONFIG capacity weighting (`capacityWeight`/`capacityType`)
 * lives on `QueueRoutingConfig`, not here, and is not duplicated onto this
 * node.
 *
 * SERVICE-CHANNEL-RELATED-ENTITY-UNGRAPHED: `relatedEntityType` ALSO emits a
 * DECLARED `references` edge to `CustomObject:{relatedEntityType}`
 * (`referenceKind: 'serviceChannelEntity'`) so the channel's served object is
 * traversable and appears in that object's usages. The scalar property is
 * preserved unchanged (see the config comment on the extraProperties override).
 */
export const extractServiceChannel = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'ServiceChannel',
    suffix: '.serviceChannel-meta.xml',
    labelXmlElement: 'label',
    // `relatedEntityType` stays in extraProperties so the SCALAR string
    // (`MessagingSession`, `VoiceCall`, `Case`, …) is preserved for direct
    // reads. The extraProperties block is spread AFTER childRefSummary in
    // `makeNode`, so it overrides the array mirror childRefs would otherwise
    // leave on `properties.relatedEntityType` — the property stays a scalar.
    extraProperties: [
      'relatedEntityType',
      'capacityModel',
      'isInterruptible',
      'hasAutoAcceptEnabled',
      'doesMinimizeWidgetOnAccept',
      'hasAfterConvoWorkTimer',
    ],
    // SERVICE-CHANNEL-RELATED-ENTITY-UNGRAPHED: emit the ServiceChannel ->
    // CustomObject:{relatedEntityType} declared edge so Omni channel ownership
    // ("which channel owns MessagingSession / VoiceCall?") is traversable and
    // the object's usages include the channel. Declared — the element names
    // the entity directly; dangling-tolerated for standard objects not vaulted.
    childRefs: [
      { element: 'relatedEntityType', toType: 'CustomObject', referenceKind: 'serviceChannelEntity' },
    ],
  });

/**
 * Extract a `QueueRoutingConfig` — the Omni-Channel routing BEHAVIOR
 * (routing model, capacity, push timeout, overflow) a `Queue` opts into via
 * its `<queueRoutingConfig>` element
 * (`queueRoutingConfigs/{fullName}.queueRoutingConfig-meta.xml`).
 *
 * The existing `queue.ts` extractor already reads `<queueRoutingConfig>`
 * into `properties.queueRoutingConfig` (a bare string) but emits no edge —
 * R6-18 adds the `Queue -> QueueRoutingConfig` `references` edge over there
 * (see that file), not here.
 *
 * This extractor additionally promotes `<queueOverflowAssignee>` to a
 * `references` edge to `Queue:{Name}` (`referenceKind:
 * 'queueOverflowAssignee'`). A real verified file held
 * `<queueOverflowAssignee>Agentforce_Fallback_Queue</queueOverflowAssignee>`
 * — a Queue DEVELOPER NAME, not the opaque record ID the Metadata API
 * Developer Guide's prose describes; Salesforce metadata source format
 * always uses portable developer names, never runtime record ids, so the
 * edge target is safe to construct directly. `userOverflowAssignee` (a User,
 * which has no ComponentType node in this vault) is captured as a raw
 * property only, no edge — consistent with `queue.ts`'s existing
 * dangling-by-design `User:{email}` convention elsewhere, but not fabricated
 * here since a User node type does not exist to dangle toward safely without
 * a confirmed id shape (email vs username vs id).
 */
export const extractQueueRoutingConfig = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'QueueRoutingConfig',
    suffix: '.queueRoutingConfig-meta.xml',
    labelXmlElement: 'label',
    extraProperties: [
      'routingModel',
      'routingPriority',
      'capacityWeight',
      'capacityType',
      'pushTimeout',
      'isAttributeBased',
      'userOverflowAssignee',
    ],
    childRefs: [
      {
        element: 'queueOverflowAssignee',
        toType: 'Queue',
        referenceKind: 'queueOverflowAssignee',
      },
    ],
  });

// R7-C7: Omni-Channel presence configuration — the R6-18 leftover ("the
// <assignments><users> sub-block has no User ComponentType to target").
// Folder/suffix + the <assignments> shape below were verified against REAL
// scoped retrieves (`sf project retrieve start --metadata
// PresenceUserConfig`) from two live orgs (a production-scale university
// sandbox and a small services org) — one `<assignments>` block wrapping
// optional `<profiles><profile>` (repeatable) and optional `<users><user>`
// (repeatable); the org-default config in BOTH verification orgs carried no
// `<assignments>` block at all.

/**
 * Extract a `PresenceUserConfig` — an Omni-Channel presence configuration: a
 * capacity model + decline/sound toggles bound to a set of assigned
 * Profiles and/or individual Users
 * (`presenceUserConfigs/{fullName}.presenceUserConfig-meta.xml`).
 *
 * `<assignments><profiles><profile>` names ARE a real `Profile` node — each
 * emits a DECLARED `references` edge (`referenceKind:
 * 'presenceProfileAssignment'`) via the generic `childRefs` mechanism,
 * mirrored onto `properties.profile`.
 *
 * `<assignments><users><user>` names a username/email with NO corresponding
 * ComponentType in this vault. Captured via the new `arrayProperties`
 * mechanism (NOT the generic `extraProperties`, which would silently keep
 * only the FIRST `<user>` — the same repeated-element trap this tier's
 * EntitlementProcess milestone fix addresses) as the `assignedUsernames`
 * property array with NO edge minted — consistent with
 * `QueueRoutingConfig.userOverflowAssignee`'s existing precedent of never
 * fabricating a `User:` node/edge from an unconfirmed id shape (email vs
 * username vs record id).
 */
export const extractPresenceUserConfig = (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'PresenceUserConfig',
    suffix: '.presenceUserConfig-meta.xml',
    labelXmlElement: 'label',
    extraProperties: [
      'capacity',
      'enableAutoAccept',
      'enableDecline',
      'enableDeclineReason',
      'enableDisconnectSound',
      'enableRequestSound',
    ],
    childRefs: [
      { element: 'profile', toType: 'Profile', referenceKind: 'presenceProfileAssignment' },
    ],
    arrayProperties: [{ element: 'user', propertyName: 'assignedUsernames' }],
  });
