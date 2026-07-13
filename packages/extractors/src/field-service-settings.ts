import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const ROOT_ELEMENT = 'FieldServiceSettings';

/** Fixed org-level id — a single FieldServiceSettings node per org, no parent scope. */
const NODE_ID = 'FieldServiceSettings:default';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Read a `<Foo>true</Foo>` boolean element. Returns `true` only when the
 * element is present and its trimmed value is exactly `"true"`; `false` for
 * an explicit `"false"`; and `null` when the element is absent (so callers
 * can distinguish "not enabled" from "not declared in this org's retrieved
 * metadata"). Mirrors `session-settings.ts`'s `optionalBoolean`.
 */
const optionalBoolean = (rootObj: Record<string, unknown>, key: string): boolean | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined) return null;
  return String(raw) === 'true';
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates on mismatched tags).
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
 * Extract the org-wide Field Service configuration from the single
 * `settings/FieldService.settings-meta.xml` file (root element
 * `<FieldServiceSettings>`; Salesforce delivers it under the generic
 * `Settings` container directory, same as `SessionSettings`).
 *
 * Finding #38 (corrected recipe): `ServiceTerritory`/`WorkOrder`/
 * `ServiceAppointment`/etc. are standard SObjects holding record data, not
 * Metadata-API-retrievable — see `STANDARD_OBJECTS_TO_MODEL` in
 * `packages/cli/src/commands/refresh.ts` for that half of the fix.
 * `FieldServiceSettings` is one of the three genuine FSL Metadata API types
 * (the other two are `Skill` and `TimeSheetTemplate`), documented at
 * `developer.salesforce.com/.../meta_fieldservicesettings.htm`. It is an
 * ORG-LEVEL metadata singleton — there is exactly one per org — so this
 * extractor emits one `Node` with the fixed id `FieldServiceSettings:default`
 * and zero edges (the settings are org-wide; they carry no inter-component
 * references).
 *
 * The three properties surfaced are the org-wide FSL enablement/behavior
 * toggles most relevant to "is Field Service on, and how":
 *   - `fieldServiceEnabled` — from `<fieldServiceOrgPref>` (whether Field
 *     Service is enabled for the org at all).
 *   - `workOrdersEnabled` — from `<enableWorkOrders>` (whether users can use
 *     the Work Order object).
 *   - `schedulingOptimizationEnabled` — from `<o2EngineEnabled>` (whether
 *     Enhanced Scheduling and Optimization is turned on).
 *
 * Each is `null` when its element is absent, so a downstream consumer can
 * distinguish "disabled" (`false`) from "not declared in this org's
 * retrieved metadata" (`null`) — mirroring `session-settings.ts`'s
 * tri-state discipline. The extractor surfaces the source faithfully and
 * does NOT validate the values against any FSL license/feature check.
 *
 * NOT modeled (out of scope, per the corrected #38 recipe): the
 * `objectMappingItem` work-plan field-mapping structure, the numeric
 * `serviceAppointmentsDueDateOffsetOrgValue` / `workOrderSearchFields`
 * settings, and — critically — territory hierarchy, resource-to-territory
 * assignment, and scheduling-policy/work-rule records, which are live org
 * DATA (not metadata) and out of scope for the vault tier entirely; see the
 * spec's "what stays genuinely out of reach" note.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<FieldServiceSettings>`
 *
 * @example
 *   const result = await extractFieldServiceSettings(
 *     'force-app/main/default/settings/FieldService.settings-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'FieldServiceSettings:default'
 */
export const extractFieldServiceSettings = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. The default entity-
  // expansion cap is raised to mirror the other settings-tier extractors.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion cap).
  // Catch it so a single pathological file becomes a per-file `parse-error`
  // rather than aborting the refresh pipeline.
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

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;

  const node: Node = {
    id: NODE_ID,
    type: 'FieldServiceSettings',
    // The org-level singleton has no meaningful API name of its own; both
    // `apiName` and `label` use the stable `FieldServiceSettings` moniker
    // so the node renders and resolves consistently (mirrors SessionSettings).
    apiName: 'FieldServiceSettings',
    label: 'Field Service Settings',
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      fieldServiceEnabled: optionalBoolean(rootObj, 'fieldServiceOrgPref'),
      workOrdersEnabled: optionalBoolean(rootObj, 'enableWorkOrders'),
      schedulingOptimizationEnabled: optionalBoolean(rootObj, 'o2EngineEnabled'),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
