import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName, deriveParentApiName } from './path-utils.js';

const QUICK_ACTION_FILE_SUFFIX = '.quickAction-meta.xml';
const ROOT_ELEMENT = 'QuickAction';
const EXTRACTOR_SOURCE = 'quick-action-extractor';
const QUICK_ACTIONS_DIR_NAME = 'quickActions';
// <label> is NOT unconditionally required: standard quick actions (e.g.
// Task.UpdateStatus with <type>Update</type>) omit it and carry a
// <standardLabel> enum instead. validateRoot below requires <type> plus at
// least one of <label> / <standardLabel>.
const REQUIRED_ELEMENTS = ['type'] as const;
const ALLOWED_ACTION_TYPES = [
  'Create',
  'Flow',
  'LogACall',
  'LightningComponent',
  'LightningWebComponent',
  'SocialPost',
  'SendEmail',
  'Update',
  'VisualforcePage',
] as const;

type ActionType = (typeof ALLOWED_ACTION_TYPES)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. QuickAction elements the extractor reads are
 * all single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for elements that may repeat (quickActionLayoutColumns,
 * quickActionLayoutItems).
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** One editable field placed on an Update/Create action's quickActionLayout. */
interface QuickActionField {
  readonly apiName: string;
  readonly uiBehavior: string | null;
}

/**
 * Collect the ordered, distinct editable fields declared in a QuickAction's
 * `<quickActionLayout>` (Update / Create actions). The nesting is
 * `quickActionLayout > quickActionLayoutColumns > quickActionLayoutItems`,
 * where each item carries an optional `<field>` and `<uiBehavior>`
 * (`Required` / `Edit` / `Readonly`). Empty-space items (no `<field>`) are
 * skipped. Deduplication by field API name preserves first-seen order.
 */
const collectQuickActionFields = (
  rootObj: Record<string, unknown>,
): QuickActionField[] => {
  const layout = unwrapSingle(rootObj['quickActionLayout']);
  if (typeof layout !== 'object' || layout === null) return [];
  const seen = new Set<string>();
  const fields: QuickActionField[] = [];
  for (const column of toArray(
    (layout as Record<string, unknown>)['quickActionLayoutColumns'],
  )) {
    if (typeof column !== 'object' || column === null) continue;
    for (const item of toArray(
      (column as Record<string, unknown>)['quickActionLayoutItems'],
    )) {
      if (typeof item !== 'object' || item === null) continue;
      const itemObj = item as Record<string, unknown>;
      const rawField = unwrapSingle(itemObj['field']);
      if (rawField === undefined || rawField === null) continue;
      const apiName = String(rawField);
      if (apiName.length === 0 || seen.has(apiName)) continue;
      seen.add(apiName);
      const rawBehavior = unwrapSingle(itemObj['uiBehavior']);
      fields.push({
        apiName,
        uiBehavior: rawBehavior === undefined || rawBehavior === null
          ? null
          : String(rawBehavior),
      });
    }
  }
  return fields;
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Parse an integer element to a number or `null`. Salesforce serializes
 * `<height>` as a numeric string; non-numeric or non-finite values
 * collapse to `null` rather than aborting the extraction.
 */
const optionalInteger = (rootObj: Record<string, unknown>, key: string): number | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : null;
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
 * Locate the `<QuickAction>` root and verify required children per
 * `QuickAction.md`. The `<type>` enum check happens after this.
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
  const rootObj = root as Record<string, unknown>;
  for (const required of REQUIRED_ELEMENTS) {
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  // Every QuickAction has a display label, but it lives in EITHER a custom
  // <label> or a standard <standardLabel> (the latter for platform actions
  // like Task.UpdateStatus). Require at least one; the read site prefers
  // <label> and falls back to <standardLabel>.
  if (rootObj['label'] === undefined && rootObj['standardLabel'] === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <label> or <standardLabel>',
    });
  }
  return ok(rootObj);
};

/**
 * Derive `{ObjectApiName, ActionName}` from a `*.quickAction-meta.xml`
 * path. QuickActions appear in two layouts per `QuickAction.md`:
 *
 *   1. **DX-nested:** `.../objects/{ObjectApiName}/quickActions/{ActionName}.quickAction-meta.xml`
 *      — the immediate parent directory is `quickActions` and the
 *      grandparent is the parent object's API name.
 *
 *   2. **Top-level:** `.../quickActions/{ObjectApiName}.{ActionName}.quickAction-meta.xml`
 *      — the immediate parent directory is `quickActions` (with no
 *      enclosing object directory), and the filename is split on the
 *      **first** dot. A filename without a dot is a global action; the
 *      `{ObjectApiName}` defaults to the literal string `'Global'`.
 *
 * Returns `malformed-input` when the immediate parent is not
 * `quickActions` — the doc does not name a recognizable DX layout for
 * any other location.
 */
const derivePathParts = (
  path: string,
): Result<{ objectApiName: string; actionName: string }, ExtractorError> => {
  const immediateParent = basename(dirname(path));
  if (immediateParent !== QUICK_ACTIONS_DIR_NAME) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot resolve object/action from path',
    });
  }
  const fileApiName = deriveComponentApiName(path, QUICK_ACTION_FILE_SUFFIX);
  // DX-nested layout: the grandparent directory is the parent object's
  // API name. `deriveParentApiName(path, 2)` returns the grandparent
  // name when the path has enough segments, '' otherwise. A non-empty
  // grandparent that isn't itself `quickActions` (and isn't the
  // top-level project root) means we're in a `objects/{Obj}/quickActions/`
  // layout.
  const grandparent = deriveParentApiName(path, 2);
  // Top-level `quickActions/` directories sit directly under
  // `force-app/main/default/` (or equivalent). In that case the
  // grandparent is *not* an object name — it's `default`, or `main`, or
  // whatever the DX tree shape is. We distinguish the two layouts by
  // asking: does the grandparent directory's *own* parent name exist
  // and is it `objects`? If the great-grandparent (level 3) is
  // `objects`, we are in the nested layout.
  const greatGrandparent = deriveParentApiName(path, 3);
  if (greatGrandparent === 'objects' && grandparent.length > 0) {
    return ok({ objectApiName: grandparent, actionName: fileApiName });
  }
  // Top-level layout. Split filename on first dot:
  //   "Account.LogCall"      -> object="Account", action="LogCall"
  //   "Global.NewTask"       -> object="Global",  action="NewTask"
  //   "NewCase" (no dot)     -> object="Global",  action="NewCase"
  const dotIndex = fileApiName.indexOf('.');
  if (dotIndex < 0) {
    return ok({ objectApiName: 'Global', actionName: fileApiName });
  }
  const objectPart = fileApiName.slice(0, dotIndex);
  const actionPart = fileApiName.slice(dotIndex + 1);
  if (objectPart.length === 0 || actionPart.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot resolve object/action from path',
    });
  }
  return ok({ objectApiName: objectPart, actionName: actionPart });
};

/**
 * Build the optional `references` edge to a target component (LWC,
 * Aura, Visualforce page, or Flow) when the action's `<type>` and the
 * corresponding XML element line up. Per `QuickAction.md`:
 *
 *   - `LightningComponent` -> `AuraDefinitionBundle:<lightningComponent>`
 *   - `LightningWebComponent` -> `LightningComponentBundle:<lightningWebComponent>`
 *   - `VisualforcePage` -> `ApexPage:<page>`
 *   - `Flow` -> `Flow:<flowDefinition>`
 *
 * Other types (`Create`, `Update`, `LogACall`, `SocialPost`,
 * `SendEmail`) produce no `references` edge. The edge is
 * dangling-by-design — there may be no node for the target component —
 * so this is a best-effort heuristic: it surfaces the target name if
 * the XML element is present, with no validation that the target
 * exists. When the action's `<type>` matches one of the four cases
 * above but the corresponding target element is absent or empty, no
 * edge is emitted.
 */
const buildReferencesEdge = (
  fromId: string,
  actionType: ActionType,
  rootObj: Record<string, unknown>,
): Edge | null => {
  if (actionType === 'LightningComponent') {
    const name = optionalString(rootObj, 'lightningComponent');
    if (name === null || name.length === 0) return null;
    return {
      fromId,
      toId: `AuraDefinitionBundle:${name}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'aura' },
    };
  }
  if (actionType === 'LightningWebComponent') {
    const name = optionalString(rootObj, 'lightningWebComponent');
    if (name === null || name.length === 0) return null;
    return {
      fromId,
      toId: `LightningComponentBundle:${name}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'lwc' },
    };
  }
  if (actionType === 'VisualforcePage') {
    const name = optionalString(rootObj, 'page');
    if (name === null || name.length === 0) return null;
    return {
      fromId,
      toId: `ApexPage:${name}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'page' },
    };
  }
  if (actionType === 'Flow') {
    // A Flow quick action names the launched flow in <flowDefinition>.
    const name = optionalString(rootObj, 'flowDefinition');
    if (name === null || name.length === 0) return null;
    return {
      fromId,
      toId: `Flow:${name}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { targetKind: 'flow' },
    };
  }
  return null;
};

/**
 * Extract a Node and edges from a single Salesforce
 * `*.quickAction-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<QuickAction>` root
 * per the vendored `QuickAction.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'QuickAction'` and
 * these edges:
 *
 *   1. `parentOf` from the parent CustomObject — emitted only when
 *      the action is object-scoped (i.e., the resolved object name is
 *      not the literal `'Global'`).
 *
 *   2. `references` to the target component (LWC, Aura, Visualforce
 *      page, or Flow) — emitted only when the action's `<type>`
 *      matches one of `LightningComponent`, `LightningWebComponent`,
 *      `VisualforcePage`, or `Flow` and the corresponding target
 *      element (`lightningComponent` / `lightningWebComponent` /
 *      `page` / `flowDefinition`) is non-empty. A `Flow` action
 *      points at `Flow:<flowDefinition>`. The target node may not
 *      exist (the AuraDefinitionBundle / LightningComponentBundle /
 *      ApexPage / Flow node can be outside the retrieve scope);
 *      dangling edges are tolerated.
 *
 *   3. `references` (one per distinct `<quickActionLayout>` field) to
 *      `CustomField:{object}.{field}`, carrying `properties.uiBehavior`
 *      (`Required` / `Edit` / `Readonly`) — the fields an Update / Create
 *      action edits. The field object is the parent object for
 *      object-scoped actions, or `<targetObject>` for global actions; a
 *      global action with no `targetObject` emits no field edges. The
 *      same list is mirrored on `properties.fields` as
 *      `{ apiName, uiBehavior }[]`.
 *
 * The canonical ID is `QuickAction:{ObjectApiName}.{ActionName}` where
 * the two parts come from the path — either the grandparent
 * directory + filename (DX-nested layout) or the filename split on the
 * first dot (top-level layout). Global actions use the literal
 * `'Global'` for `{ObjectApiName}`.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<label>` / `<type>`, `<type>` outside the eight allowed
 * values, or unrecognized DX path layout).
 *
 * @example
 *   const result = await extractQuickAction(
 *     'force-app/main/default/quickActions/Global.NewTask.quickAction-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'QuickAction:Global.NewTask'
 *   }
 */
export const extractQuickAction = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = derivePathParts(path);
  if (!pathParts.ok) return pathParts;
  const { objectApiName, actionName } = pathParts.value;

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
  // cap). Catch it here so a single pathological file becomes a
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

  // Per QuickAction.md: `<type>` must be one of the eight allowed
  // values. A malformed value is an explicit error case.
  const actionTypeValue = String(unwrapSingle(rootObj['type']));
  if (!ALLOWED_ACTION_TYPES.includes(actionTypeValue as ActionType)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid type: ${actionTypeValue}`,
    });
  }
  const actionType = actionTypeValue as ActionType;

  const nodeApiName = `${objectApiName}.${actionName}`;
  const nodeId = `${ROOT_ELEMENT}:${nodeApiName}`;
  // Prefer the custom <label>; standard actions fall back to their
  // <standardLabel> enum value (ChangeStatus, Defer, …), then to the action
  // name — so the label is never the literal string "undefined".
  const customLabel = unwrapSingle(rootObj['label']);
  const standardLabel = unwrapSingle(rootObj['standardLabel']);
  const label =
    customLabel !== undefined
      ? String(customLabel)
      : standardLabel !== undefined
        ? String(standardLabel)
        : actionName;
  const parentObjectId =
    objectApiName === 'Global' ? null : `CustomObject:${objectApiName}`;
  const targetObject = optionalString(rootObj, 'targetObject');
  const fields = collectQuickActionFields(rootObj);
  // The layout fields belong to the object the action acts on: the parent
  // object for object-scoped actions, or the <targetObject> for a global
  // action. When neither resolves (a global action with no targetObject) the
  // field object is unknown, so no CustomField edges are emitted.
  const fieldObjectApiName =
    objectApiName !== 'Global'
      ? objectApiName
      : targetObject !== null && targetObject.length > 0
        ? targetObject
        : null;

  const node: Node = {
    id: nodeId,
    type: 'QuickAction',
    apiName: nodeApiName,
    label,
    parentId: parentObjectId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      actionType,
      description: optionalString(rootObj, 'description'),
      targetObject,
      lightningComponent: optionalString(rootObj, 'lightningComponent'),
      lightningWebComponent: optionalString(rootObj, 'lightningWebComponent'),
      page: optionalString(rootObj, 'page'),
      flowDefinition: optionalString(rootObj, 'flowDefinition'),
      icon: optionalString(rootObj, 'icon'),
      height: optionalInteger(rootObj, 'height'),
      width: optionalString(rootObj, 'width'),
      fields,
    },
  };

  const edges: Edge[] = [];
  // Per QuickAction.md "Edges § 1": object-scoped actions get a
  // `parentOf` edge from the parent CustomObject. Global actions have
  // no parent object and emit no edge.
  if (parentObjectId !== null) {
    edges.push({
      fromId: parentObjectId,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
  }
  // Per QuickAction.md "Edges § 2": at most one `references` edge per
  // action — only for LWC / Aura / Visualforce variants with a
  // non-empty target element. The target node is dangling-by-design.
  const referencesEdge = buildReferencesEdge(nodeId, actionType, rootObj);
  if (referencesEdge !== null) {
    edges.push(referencesEdge);
  }
  // Update / Create actions carry a `<quickActionLayout>` field list — the
  // fields the button edits. Emit one declared `references` edge per field to
  // `CustomField:{object}.{field}` (carrying `uiBehavior`) so "what does this
  // button update?" and field impact/review can see the action as a
  // dependent. Sorted by `toId` for deterministic output.
  if (fieldObjectApiName !== null) {
    const fieldEdges = fields
      .map((f) => ({
        fromId: nodeId,
        toId: `CustomField:${fieldObjectApiName}.${f.apiName}`,
        edgeType: 'references' as const,
        confidence: 'declared' as const,
        source: EXTRACTOR_SOURCE,
        properties: { uiBehavior: f.uiBehavior },
      }))
      .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
    edges.push(...fieldEdges);
  }

  return ok({ nodes: [node], edges });
};
