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
   * Derive the parent CustomObject from an XML element's text when the file
   * path carries no object (RestrictionRule / ScopingRule retrieve into a
   * TOP-LEVEL `restrictionRules/`/`scopingRules/` folder, but their
   * `<targetEntity>` names the restricted object). Without this, parentId is
   * null and every parentId-keyed consumer — why_cant_user_see_record's
   * RestrictionRule/ScopingRule stages, who_can_access_object's god-mode
   * caveat — silently never fires on real orgs.
   */
  readonly parentFromXmlElement?: string;
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
): readonly string[] => {
  const scopeObject =
    parentObjectApiName ?? inferReportObjectApiName(xml);
  const refs = new Set<string>();
  for (const value of [
    ...extractXmlValues(xml, 'columns'),
    ...extractXmlValues(xml, 'field'),
    ...extractXmlValues(xml, 'fieldItem'),
    ...extractXmlValues(xml, 'fieldApiName'),
  ]) {
    if (value.includes('.')) {
      refs.add(`CustomField:${value}`);
    } else if (scopeObject !== null) {
      refs.add(`CustomField:${scopeObject}.${value}`);
    }
  }

  const dottedFieldRe = /\b([A-Za-z][A-Za-z0-9_]*__?(?:c|pc|pr|r|e|b|kav)?\.[A-Za-z][A-Za-z0-9_]*__?[a-zA-Z0-9]*)\b/g;
  for (const match of xml.matchAll(dottedFieldRe)) {
    const value = match[1];
    if (value !== undefined) refs.add(`CustomField:${value}`);
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
): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label: null,
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

  const fieldRefs = extractFieldRefs(text.value, parentObjectApiName);
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

  const node = makeNode(
    config.type,
    apiName,
    path,
    parentObjectApiName === null ? null : `CustomObject:${parentObjectApiName}`,
    {
      fieldRefs,
      rawReferenceCount: fieldRefs.length,
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
    },
  );

  const fieldRefEdges: Edge[] = fieldRefs.map((fieldId) => ({
    fromId: node.id,
    toId: fieldId,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EXTRACTOR_SOURCE,
    properties: { referenceKind: 'fieldRef' },
  }));

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
    nestedParent: 'listViews',
  });

export const extractReportType = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, { type: 'ReportType', suffix: '.reportType-meta.xml' });

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
 * Extract a FlexiPage (Lightning page). Beyond the bare node, captures
 * `sobjectType` (which object the page is for), `pageType` (RecordPage /
 * AppPage / HomePage — picked from the page-type set, since `<type>` is also
 * used by regions/components), and `masterLabel`, and emits a `references`
 * edge FlexiPage → `CustomObject:{sobjectType}` so "what Lightning pages are
 * for object X" is answerable. fieldRefs are scoped by sobjectType.
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

  const node = makeNode('FlexiPage', apiName, path, null, {
    sobjectType,
    pageType,
    masterLabel,
    activationsModeled: false,
    fieldRefs,
    rawReferenceCount: fieldRefs.length,
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
  });

export const extractScopingRule = (path: string): Promise<Result<ExtractionResult, ExtractorError>> =>
  extractEnterpriseMetadata(path, {
    type: 'ScopingRule',
    suffix: '.rule-meta.xml',
    parentFromXmlElement: 'targetEntity',
  });
