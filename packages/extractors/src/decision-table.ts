import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const DECISION_TABLE_FILE_SUFFIX = '.decisionTable-meta.xml';
const ROOT_ELEMENT = 'DecisionTable';
const PARAMETER_ELEMENT = 'decisionTableParameters';
const REQUIRED_ELEMENTS = [
  'setupName',
  'dataSourceType',
  'executionType',
] as const;

const INPUT_USAGE = 'INPUT';
const OUTPUT_USAGE = 'OUTPUT';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. A single
 * `<decisionTableParameters>` parses as a scalar object, two or more as
 * an array; both must be iterable here.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; non-`true` values become false (per SF defaults). */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (
  rootObj: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
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

/** Locate the `<DecisionTable>` root and verify required children per `DecisionTable.md`. */
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
  return ok(rootObj);
};

/**
 * Count INPUT- vs OUTPUT-tagged `<decisionTableParameters>` rows. Rows
 * without a `<usage>` element are silently skipped — the vendored doc
 * (`DecisionTable.md` §"Input vs output parameters") declares `<usage>`
 * as the discriminant, so a row without it has no place in either
 * bucket. This intentionally avoids guessing.
 *
 * The counts are the *parameter-shape* surface — Q179's anchor. Row
 * data (the actual values the parameters lookup against) lives in CSV
 * uploads or SObject records, NOT in the metadata XML; v3.2 refuses to
 * fabricate it.
 */
const countParameterUsages = (
  rootObj: Record<string, unknown>,
): { inputParamCount: number; outputParamCount: number } => {
  let inputParamCount = 0;
  let outputParamCount = 0;
  for (const raw of toArray(rootObj[PARAMETER_ELEMENT])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const usage = unwrapSingle((raw as Record<string, unknown>)['usage']);
    if (usage === INPUT_USAGE) {
      inputParamCount += 1;
    } else if (usage === OUTPUT_USAGE) {
      outputParamCount += 1;
    }
  }
  return { inputParamCount, outputParamCount };
};

/**
 * Extract a Node from a single Salesforce
 * `*.decisionTable-meta.xml` file.
 *
 * DecisionTable is the **declarative rule-table primitive** of
 * Salesforce Industries' Business Rules Engine (BRE). The metadata XML
 * declares the table's *parameter shape* — which fields are inputs, which
 * are outputs, the matching operators, and the lookup-time condition
 * expression — but does NOT carry the lookup row data itself.
 *
 * v3.2 surfaces:
 *   - `setupName` (the canonical DT name; also the apiName).
 *   - `dataSourceType` (`CsvUpload` | `SObject` | `Manual`).
 *   - `sourceObject` (for `SObject` dataSourceType; verbatim).
 *   - `executionType` (`HBASE` | `OnPrem`).
 *   - `usageType` (typically `Bre`; optional).
 *   - `status` (verbatim — Salesforce extends the enum over time).
 *   - `type` (volume tier: `LowVolume` | `MediumVolume` | `HighVolume`).
 *   - `conditionType` (`All` | `Any`).
 *   - `conditionCriteria` (e.g., `1 AND 2 AND 3`; verbatim).
 *   - `doesConsiderNullValue`, `filterResultBy`.
 *   - `inputParamCount` and `outputParamCount` — the parameter-shape
 *     surface counted from `<decisionTableParameters>` children.
 *
 * **Q179 honesty boundary — refusal to fabricate row data.**
 * Per `DecisionTable.md`:
 *
 *   > "DecisionTable rows live in CSV uploads or SObject records, not
 *   > in the metadata XML. v3.2 cannot enumerate row content. To see
 *   > the actual rows, query the row data source (SObject record query
 *   > or the original CSV)."
 *
 * This extractor reads ONLY the parameter declarations (the table
 * schema), never the row content. Three concrete refusals:
 *
 *   1. `dataSourceType: CsvUpload` — the CSV file is uploaded as a
 *      Salesforce File. v3.2 does NOT enumerate File content.
 *   2. `dataSourceType: SObject` — rows live in `sourceObject`
 *      records. v3.2 does NOT query SObject records.
 *   3. `dataSourceType: Manual` — rows live in the OmniStudio
 *      designer's row-editor UI. v3.2 does NOT reach into that UI.
 *
 * The `inputParamCount` / `outputParamCount` properties expose only the
 * shape — the count of input columns vs output columns declared by the
 * table — never any row value. Downstream MCP tools surface the verbatim
 * Q179 boundary phrase when callers ask for rows.
 *
 * **Leaf-of-the-chain — zero edges.**
 * DecisionTable is the leaf of the OmniStudio call chain. It does NOT
 * emit `dispatchesOmniAction` edges; DTs do not invoke other OmniStudio
 * components. (DTs ARE invoked BY IPs and Apex via
 * `omnistudio.DecisionTableInvocableService` Remote Actions; the IP
 * extractor surfaces those Remote Action targets verbatim, and the
 * Apex→OmniProcess coupling is the v3.3 follow-up. v3.2 captures
 * neither edge family on the DT side — leaf semantics.)
 *
 * Error cases (per vendored `DecisionTable.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<DecisionTable>` or a
 *     required element (`<setupName>`, `<dataSourceType>`, or
 *     `<executionType>`) is missing
 *
 * @example
 *   const result = await extractDecisionTable(
 *     'force-app/main/default/decisionTables/FPLFullTabe.decisionTable-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'DecisionTable:FPLFullTabe'
 */
export const extractDecisionTable = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML
  // (and forward-compatible with whatever DT files Salesforce emits).
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce. Catch it here so a single pathological file
  // becomes a per-file `parse-error` rather than aborting the refresh
  // pipeline.
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

  // The `<setupName>` element IS the canonical api-name; the filename
  // basename matches it by Salesforce DX convention. We prefer the XML
  // element over the path so a rename via copy/paste cannot corrupt the
  // node id.
  const setupName = String(unwrapSingle(rootObj['setupName']));
  const apiName = setupName;
  const fileApiName = deriveComponentApiName(
    path,
    DECISION_TABLE_FILE_SUFFIX,
  );

  const { inputParamCount, outputParamCount } = countParameterUsages(rootObj);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'DecisionTable',
    apiName,
    label: setupName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      setupName,
      // Always reported so consumers can detect rename drift between
      // the XML's `<setupName>` and the file's basename without an
      // extra file-stat round trip.
      fileBasename: fileApiName,
      dataSourceType: String(unwrapSingle(rootObj['dataSourceType'])),
      sourceObject: optionalString(rootObj, 'sourceObject'),
      executionType: String(unwrapSingle(rootObj['executionType'])),
      usageType: optionalString(rootObj, 'usageType'),
      status: optionalString(rootObj, 'status'),
      type: optionalString(rootObj, 'type'),
      conditionType: optionalString(rootObj, 'conditionType'),
      conditionCriteria: optionalString(rootObj, 'conditionCriteria'),
      doesConsiderNullValue: coerceBoolean(
        unwrapSingle(rootObj['doesConsiderNullValue']),
      ),
      filterResultBy: optionalString(rootObj, 'filterResultBy'),
      // Parameter-shape surface only. Row data is the Q179 boundary —
      // see this module's JSDoc and `DecisionTable.md`. The counts
      // come from `<decisionTableParameters>` children whose `<usage>`
      // is `INPUT` or `OUTPUT`; rows without a `<usage>` element are
      // not bucketed (the vendored doc declares `<usage>` as the
      // discriminant, so a missing value has no defensible bucket).
      inputParamCount,
      outputParamCount,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
