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

const extractFieldRefs = (
  xml: string,
  parentObjectApiName: string | null,
  options?: { readonly listViewFilterScoped?: boolean },
): readonly string[] => {
  const scopeObject =
    parentObjectApiName ?? inferReportObjectApiName(xml);
  const refs = new Set<string>();
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
    if (!isWellFormedColumnField(value)) continue;
    if (value.includes('.')) {
      refs.add(`CustomField:${value}`);
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
      if (value !== undefined) refs.add(`CustomField:${value}`);
    }
  }

  return [...refs].sort();
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
 */
const extractListViewFilterRefs = (
  xml: string,
  scopeObject: string | null,
): readonly string[] => {
  const refs = new Set<string>();
  for (const block of xml.matchAll(/<filters>([\s\S]*?)<\/filters>/g)) {
    for (const field of extractXmlValues(block[1] ?? '', 'field')) {
      if (!isWellFormedFilterField(field)) continue;
      if (field.includes('.')) {
        refs.add(`CustomField:${field}`);
      } else if (scopeObject !== null) {
        refs.add(`CustomField:${scopeObject}.${field}`);
      }
    }
  }
  return [...refs].sort();
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

  const fieldRefs = extractFieldRefs(text.value, parentObjectApiName, {
    listViewFilterScoped: config.parseListViewFilters === true,
  });
  // CR-CAP-13: list-view filter-predicate field identity. `filterFieldRefs` is
  // the set of well-formed fields a `<filters>` block predicates on; a field
  // that is ALSO a column appears in BOTH sets and is merged into one
  // `columnAndFilter` edge below (the edge PK cannot hold two `references`).
  const filterFieldRefs = config.parseListViewFilters === true
    ? extractListViewFilterRefs(
        text.value,
        parentObjectApiName ?? inferReportObjectApiName(text.value),
      )
    : [];
  const filterFieldRefSet = new Set(filterFieldRefs);
  const nodeId = `${config.type}:${apiName}`;

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
      ...childRefSummary,
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

  return ok({ nodes: [node], edges: [...fieldRefEdges, ...childRefEdges, ...visibleToEdges] });
};

export const extractReport = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, { type: 'Report', suffix: '.report-meta.xml' });

export const extractDashboard = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, { type: 'Dashboard', suffix: '.dashboard-meta.xml' });

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
  const fieldRefs = extractFieldRefs(text.value, sobjectType);
  // v2.9: visibility-rule custom-permission references.
  const permissionRefs = extractFlexiPagePermissionRefs(text.value);

  const edges: Edge[] = fieldRefs.map((fieldId) => ({
    fromId: nodeId,
    toId: fieldId,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EXTRACTOR_SOURCE,
    properties: { referenceKind: 'fieldRef' },
  }));
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
  });
  return ok({ nodes: [node], edges });
};

export const extractPermissionSetGroup = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'PermissionSetGroup',
    suffix: '.permissionsetgroup-meta.xml',
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

export const extractMutingPermissionSet = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'MutingPermissionSet',
    suffix: '.mutingpermissionset-meta.xml',
  });

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
    // Same set as RestrictionRule — both rule types share the same XML schema
    // and the same consumer questions (what filter / who does it apply to).
    extraProperties: ['enforcementType', 'recordFilter', 'userCriteria', 'active'],
  });
