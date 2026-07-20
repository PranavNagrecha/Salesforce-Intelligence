import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const LAYOUT_FILE_SUFFIX = '.layout-meta.xml';
const ROOT_ELEMENT = 'Layout';
const EXTRACTOR_SOURCE = 'layout-extractor';

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Some Layout elements (e.g., `showInheritedColumns`)
 * are single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for elements that may appear multiple times in the
 * source XML (layoutSections, layoutColumns, layoutItems).
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
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

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/**
 * Parse a layout filename into its `{ObjectApiName}` and `{LayoutName}`
 * components.
 *
 * The DX filename format is `{ObjectApiName}-{LayoutName}.layout-meta.xml`,
 * split on the **first** hyphen only — `{LayoutName}` may itself contain
 * hyphens. URL-encoded characters in `{LayoutName}` are decoded with
 * `decodeURIComponent`; malformed sequences surface as `malformed-input`.
 */
const parseFilename = (
  path: string,
): Result<{ objectApiName: string; layoutName: string }, ExtractorError> => {
  const base = basename(path);
  const stem = base.endsWith(LAYOUT_FILE_SUFFIX)
    ? base.slice(0, base.length - LAYOUT_FILE_SUFFIX.length)
    : base;
  const hyphenIndex = stem.indexOf('-');
  if (hyphenIndex < 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot split filename into object and layout name',
    });
  }
  const objectApiName = stem.slice(0, hyphenIndex);
  const rawLayoutName = stem.slice(hyphenIndex + 1);
  let layoutName: string;
  try {
    layoutName = decodeURIComponent(rawLayoutName);
  } catch {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot split filename into object and layout name',
    });
  }
  return ok({ objectApiName, layoutName });
};

/**
 * Locate the `<Layout>` root in a parsed XML tree.
 *
 * Per the vendored `Layout.md` spec, `<Layout>` is the only
 * unconditionally-required element. `<layoutSections>` is optional with
 * structural impact: Salesforce-internal layouts (`Global-*`, `FeedItem-*`,
 * `Outlook-*`, `User-*`, `CaseClose-*`) and some publisher layouts ship
 * without it. Absence is a documented happy path, not an error.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * Extract the well-formed `<layoutSections>` entries from the parsed root.
 * Returns `[]` when the element is absent or its value is not a section
 * object (e.g., `<layoutSections></layoutSections>` parses as an empty
 * string, which is not a section). Used to compute both `sectionCount`
 * and the field-reference set so the two stay consistent.
 */
const getSections = (
  rootObj: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> =>
  toArray(rootObj['layoutSections']).filter(
    (section): section is Record<string, unknown> =>
      typeof section === 'object' && section !== null,
  );

/**
 * Collect the ordered list of distinct field-reference strings a layout
 * places this object's fields in. A field counts as "on the layout" for
 * FLS / "is field X visible here" questions if it appears in ANY of the
 * three field-bearing layout regions:
 *
 *   1. **Detail body** — `layoutSections > layoutColumns > layoutItems > field`
 *   2. **Highlights Panel** — `summaryLayout > summaryLayoutItems > field`
 *      (the compact panel at the top of a Lightning record page; a field can
 *      live ONLY here and nowhere in the detail body).
 *   3. **Mini layout** — `miniLayout > fields` (the hover / related-list
 *      preview; `<fields>` repeats once per field).
 *
 * Items without a `<field>` child (empty space, Visualforce page, custom
 * link, blank summary item) are skipped. Related-list columns
 * (`relatedLists > fields`) are deliberately NOT collected — those are
 * fields of the RELATED object, not this one, so a `CustomField:{thisObj}.X`
 * edge would be wrong. Deduplication preserves first-seen order; the caller
 * re-sorts for deterministic output.
 */
const collectFieldReferences = (
  rootObj: Record<string, unknown>,
): string[] => {
  const seen = new Set<string>();
  const fields: string[] = [];
  const push = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    const fieldName = String(raw);
    if (fieldName.length === 0 || seen.has(fieldName)) return;
    seen.add(fieldName);
    fields.push(fieldName);
  };
  // 1. Detail body.
  for (const section of getSections(rootObj)) {
    for (const column of toArray(section['layoutColumns'])) {
      if (typeof column !== 'object' || column === null) continue;
      for (const item of toArray((column as Record<string, unknown>)['layoutItems'])) {
        if (typeof item !== 'object' || item === null) continue;
        push(unwrapSingle((item as Record<string, unknown>)['field']));
      }
    }
  }
  // 2. Highlights Panel (summaryLayout > summaryLayoutItems > field).
  const summary = unwrapSingle(rootObj['summaryLayout']);
  if (typeof summary === 'object' && summary !== null) {
    for (const item of toArray(
      (summary as Record<string, unknown>)['summaryLayoutItems'],
    )) {
      if (typeof item !== 'object' || item === null) continue;
      push(unwrapSingle((item as Record<string, unknown>)['field']));
    }
  }
  // 3. Mini layout (miniLayout > fields, repeated).
  const mini = unwrapSingle(rootObj['miniLayout']);
  if (typeof mini === 'object' && mini !== null) {
    for (const field of toArray((mini as Record<string, unknown>)['fields'])) {
      push(field);
    }
  }
  return fields;
};

/**
 * Collect the ordered, distinct list of custom button / link API names a
 * layout places in its `<customButtons>` elements. These are WebLink
 * components defined on THIS layout's object (their canonical id is
 * `WebLink:{objectApiName}.{name}`); the element carries the bare API name.
 * Standard buttons live in `<excludeButtons>` and are deliberately NOT
 * collected here. Deduplication preserves first-seen order; the caller
 * re-sorts edges for deterministic output.
 */
const collectCustomButtons = (
  rootObj: Record<string, unknown>,
): string[] => {
  const seen = new Set<string>();
  const buttons: string[] = [];
  for (const raw of toArray(rootObj['customButtons'])) {
    if (raw === undefined || raw === null) continue;
    const name = String(raw);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    buttons.push(name);
  }
  return buttons;
};

/**
 * Collect the ordered, distinct list of QuickAction API names a layout places
 * via `<platformActionList><platformActionListItems>` entries whose
 * `<actionType>` is `QuickAction`. The `<actionName>` for a QuickAction is
 * already in `{Object}.{Action}` form (e.g. `Case.Change_Status`,
 * `FeedItem.TextPost`), so the canonical id is `QuickAction:{actionName}`.
 *
 * A layout may declare several `<platformActionList>` blocks (Record /
 * ListView / RelatedList contexts) and the same action can appear in more than
 * one; deduplication preserves first-seen order. Non-`QuickAction` action
 * types (`StandardButton`, `CustomButton`, `ProductivityAction`) are skipped
 * here — standard buttons have no vault node, and detail-page custom buttons
 * are graphed from `<customButtons>` (see `collectCustomButtons`).
 */
const collectPlatformQuickActions = (
  rootObj: Record<string, unknown>,
): string[] => {
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const list of toArray(rootObj['platformActionList'])) {
    if (typeof list !== 'object' || list === null) continue;
    for (const item of toArray(
      (list as Record<string, unknown>)['platformActionListItems'],
    )) {
      if (typeof item !== 'object' || item === null) continue;
      const itemObj = item as Record<string, unknown>;
      const actionType = unwrapSingle(itemObj['actionType']);
      if (actionType !== 'QuickAction') continue;
      const actionName = unwrapSingle(itemObj['actionName']);
      if (actionName === undefined || actionName === null) continue;
      const name = String(actionName);
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      actions.push(name);
    }
  }
  return actions;
};

/**
 * Build the full edge set for a layout: one `parentOf` edge from the
 * parent CustomObject, one `usedInLayout` edge per distinct field
 * reference, one `references` edge per distinct custom button
 * (`<customButtons>`) to its `WebLink:{object}.{name}`, and one `references`
 * edge per distinct placed QuickAction (`platformActionListItems`) to its
 * `QuickAction:{Object}.{Action}`. Field, button, and action edges are each
 * sorted by `toId` for deterministic output.
 */
const buildEdges = (
  nodeId: string,
  parentId: string,
  objectApiName: string,
  fieldReferences: readonly string[],
  customButtons: readonly string[],
  platformQuickActions: readonly string[],
): Edge[] => {
  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: {},
  };
  const fieldEdges: Edge[] = fieldReferences
    .map((fieldName) => ({
      fromId: nodeId,
      toId: `CustomField:${objectApiName}.${fieldName}`,
      edgeType: 'usedInLayout' as const,
      confidence: 'declared' as const,
      source: EXTRACTOR_SOURCE,
      properties: {},
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  const buttonEdges: Edge[] = customButtons
    .map((buttonName) => ({
      fromId: nodeId,
      toId: `WebLink:${objectApiName}.${buttonName}`,
      edgeType: 'references' as const,
      confidence: 'declared' as const,
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'customButton' },
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  const quickActionEdges: Edge[] = platformQuickActions
    .map((actionName) => ({
      fromId: nodeId,
      toId: `QuickAction:${actionName}`,
      edgeType: 'references' as const,
      confidence: 'declared' as const,
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'quickAction' },
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  return [parentEdge, ...fieldEdges, ...buttonEdges, ...quickActionEdges];
};

/**
 * Extract a Node and edges from a single Salesforce `*.layout-meta.xml`
 * file.
 *
 * Reads the file, parses it as XML, validates the `<Layout>` root per the
 * vendored `Layout.md` spec, and returns an `ExtractionResult` containing
 * one `Node` of type `'Layout'`, one `parentOf` edge from the parent
 * `CustomObject`, one `usedInLayout` edge per distinct field
 * reference — collected across the detail body, the Highlights Panel
 * (`summaryLayout`), and the mini layout (`miniLayout`), deduplicated and
 * sorted by `toId` for stable output (see `collectFieldReferences`) — and
 * one `references` edge (`properties.targetKind: 'customButton'`) per
 * distinct `<customButtons>` entry to its `WebLink:{object}.{name}`, with
 * the same names mirrored on `properties.customButtons`, and one
 * `references` edge (`properties.targetKind: 'quickAction'`) per distinct
 * `platformActionListItems` QuickAction to its `QuickAction:{Object}.{Action}`.
 *
 * `<layoutSections>` is optional. When absent or empty, the Layout node
 * still emits, the `parentOf` edge still emits, zero `usedInLayout`
 * edges are emitted, and `properties.sectionCount` and
 * `properties.fieldCount` are both `0`. Salesforce-internal layouts
 * (`Global-*`, `FeedItem-*`, `Outlook-*`, `User-*`, `CaseClose-*`) and
 * some publisher layouts use this shape.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root, or
 * a filename without the required hyphen).
 *
 * @example
 *   const result = await extractLayout(
 *     'tests/fixtures/edu-org/source/main/default/layouts/Account-Account Layout.layout-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Layout:Account.Account Layout'
 *   }
 */
export const extractLayout = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const filenameResult = parseFilename(path);
  if (!filenameResult.ok) return filenameResult;
  const { objectApiName, layoutName } = filenameResult.value;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap of 1000). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `Layout:${objectApiName}.${layoutName}`;
  const sections = getSections(rootObj);
  const fieldReferences = collectFieldReferences(rootObj);
  const customButtons = collectCustomButtons(rootObj);
  const platformQuickActions = collectPlatformQuickActions(rootObj);

  const node: Node = {
    id: nodeId,
    type: 'Layout',
    apiName: layoutName,
    label: layoutName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      showInheritedColumns: coerceBoolean(unwrapSingle(rootObj['showInheritedColumns'])),
      showSubmitAndAttach: coerceBoolean(unwrapSingle(rootObj['showSubmitAndAttach'])),
      fieldCount: fieldReferences.length,
      sectionCount: sections.length,
      customButtons,
    },
  };

  return ok({
    nodes: [node],
    edges: buildEdges(
      nodeId,
      parentId,
      objectApiName,
      fieldReferences,
      customButtons,
      platformQuickActions,
    ),
  });
};
