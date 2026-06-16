/**
 * Handler for the `sfi.decision_table_browse` MCP tool.
 *
 * The fifth of the v3.2 OmniStudio MCP-tool wave. Given a DecisionTable
 * canonical id (`DecisionTable:{SetupName}`), returns the table's
 * parameter shape — its data-source discriminator, its runtime engine,
 * and the per-parameter input / output declarations — but explicitly
 * REFUSES to enumerate row content. Row data lives in CSV uploads,
 * SObject records, or the OmniStudio designer's row-editor UI; v3.2's
 * extraction surface scopes to the metadata XML only.
 *
 * Q179 honesty anchor (the load-bearing v3.2 row-data refusal). The
 * verbatim disclosure from `DecisionTable.md` surfaces on EVERY
 * response in `boundaries[]`, and the tool returns `rows: null`. The
 * `dataSourceType`-specific refusal hint surfaces additionally in
 * `boundaries[]` so the caller learns which row store would hold the
 * data:
 *
 *   - `CsvUpload` → "rows live in the uploaded CSV File".
 *   - `SObject`   → "rows live in `{sourceObject}` SObject records".
 *   - `Manual`    → "rows live in the OmniStudio designer's row-editor".
 *
 * The extractor (`packages/extractors/src/decision-table.ts`) only
 * stores `inputParamCount` / `outputParamCount` on the node. To produce
 * the per-parameter `name` / `type` / `defaultValue` shape this tool
 * advertises, the handler re-reads the source XML at `node.sourcePath`
 * at invocation time. The extractor's count is the structural source of
 * truth; this tool surfaces the unsummarised parameter list a caller
 * needs to walk. Two intentional asymmetries:
 *
 *   - When the source XML cannot be read (vault-relative path stale,
 *     file removed, parse failure) the response still resolves — the
 *     parameter lists fall back to empty arrays and a `boundaries[]`
 *     entry names the read failure verbatim. The graph node IS the
 *     authority that the table exists; failing the entire call would
 *     punish a freshness gap that is the caller's signal to refresh.
 *   - DecisionTable XML has no `<defaultValue>` element in the
 *     vendored doc. The `defaultValue` field is emitted as `null` for
 *     every input parameter; the field exists so the tool's response
 *     shape is forward-compatible with a future XML extension without
 *     a v3.x contract bump.
 *
 * Composition recipe (PLAN-v3.2 §4 `sfi.decision_table_browse`): load
 * the DecisionTable node by id → read its metadata properties verbatim
 * → re-parse `<decisionTableParameters>` from the source XML → classify
 * each by `<usage>` into input / output lists ordered by `<sequence>` →
 * emit the Q179 row-data boundary verbatim. Row data is NOT read.
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

const DECISION_TABLE_PREFIX = 'DecisionTable:';
const ROOT_ELEMENT = 'DecisionTable';
const PARAMETER_ELEMENT = 'decisionTableParameters';
const INPUT_USAGE = 'INPUT';
const OUTPUT_USAGE = 'OUTPUT';

/**
 * Verbatim Q179 row-data boundary disclosure per `DecisionTable.md`
 * §"Honesty boundaries" and PLAN-v3.2 §4 `sfi.decision_table_browse`.
 * The phrasing is contract-locked by Q179; any drift is a v3.2 contract
 * violation regardless of test-suite green.
 */
const ROW_DATA_BOUNDARY =
  'DecisionTable rows live in CSV uploads or SObject records, not in ' +
  'the metadata XML. v3.2 cannot enumerate row content. To see the ' +
  'actual rows, query the row data source (SObject record query or ' +
  'the original CSV).';

/**
 * Native-vs-Vlocity-Legacy honesty disclosure surfaced for EVERY v3.2
 * tool response per PLAN-v3.2 §4 axis 1. DecisionTable is a Native-only
 * family (the Vlocity-managed-package legacy did not carry a DT
 * equivalent), but the discipline-consistency rule surfaces the phrase
 * on every v3.2 response so callers see the same boundary phrasing
 * across the OmniStudio tool surface.
 */
const NATIVE_VS_VLOCITY_BOUNDARY =
  'v3.2 recognizes Industries Native XML shapes (file extensions ' +
  '`.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, `.ouc-meta.xml`, ' +
  '`.decisionTable-meta.xml`). Legacy Vlocity-managed-package ' +
  'components (namespace `vlocity_cmt__`) are NOT extracted by v3.2. ' +
  'Mid-migration orgs may show partial coverage.';

/**
 * dataSourceType-specific row-store hint. The verbatim disclosure
 * above tells the caller v3.2 does NOT enumerate rows; this hint
 * tells them WHERE the rows live so the caller's next step is
 * obvious. Surfaced in `boundaries[]` immediately after the Q179
 * disclosure.
 */
const rowStoreHint = (
  dataSourceType: string,
  sourceObject: string | null,
): string => {
  switch (dataSourceType) {
    case 'CsvUpload':
      return (
        'dataSourceType is CsvUpload — rows live in the CSV File ' +
        'uploaded to this DecisionTable. v3.2 does NOT enumerate ' +
        'Salesforce File content.'
      );
    case 'SObject': {
      const obj = sourceObject ?? '<unknown>';
      return (
        `dataSourceType is SObject — rows live in '${obj}' SObject ` +
        'records. v3.2 does NOT query SObject records.'
      );
    }
    case 'Manual':
      return (
        'dataSourceType is Manual — rows live in the OmniStudio ' +
        "designer's row-editor UI. v3.2 does NOT reach into that UI."
      );
    default:
      return (
        `dataSourceType '${dataSourceType}' is not one of the three ` +
        'known row-store kinds (CsvUpload / SObject / Manual); v3.2 ' +
        'surfaces the value verbatim but cannot determine where the ' +
        'rows live for this kind.'
      );
  }
};

/**
 * Zod schema for the `sfi.decision_table_browse` tool input. The
 * `decisionTableId` prefix constraint is enforced at the handler
 * boundary so callers with a wrong prefix learn `invalid-query`
 * rather than Zod's generic shape rejection.
 */
export const decisionTableBrowseInputSchema = z.object({
  decisionTableId: z.string().min(1),
});

/** Parsed input shape. */
export type DecisionTableBrowseInput = z.infer<
  typeof decisionTableBrowseInputSchema
>;

/**
 * One input parameter declaration. The XML field name (the lookup
 * column) carries `dataType`; the `defaultValue` field is reserved
 * for forward-compatibility — DecisionTable XML has no
 * `<defaultValue>` element in the v3.2 vendored doc, so every entry
 * carries `defaultValue: null`. The shape is contract-locked by the
 * task spec.
 */
export interface DecisionTableInputParam {
  readonly name: string;
  readonly type: string;
  readonly defaultValue: string | null;
}

/**
 * One output parameter declaration. Outputs do not carry operators
 * or default values — they're the result tuple columns the table
 * looks up.
 */
export interface DecisionTableOutputParam {
  readonly name: string;
  readonly type: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DecisionTableBrowseOutput {
  readonly decisionTableId: ComponentId;
  readonly apiName: string;
  readonly dataSourceType: string;
  readonly executionType: string;
  readonly inputParams: readonly DecisionTableInputParam[];
  readonly outputParams: readonly DecisionTableOutputParam[];
  readonly rows: null;
  readonly boundaries: readonly string[];
}

/**
 * Pull a typed scalar out of the DecisionTable node's properties.
 * Mirrors the defensive read pattern from other v3.2 tools — non-string
 * values fall back to null so the response shape stays JSON-stable.
 */
const readStringProperty = (node: Node, key: string): string | null => {
  const raw = node.properties[key];
  return typeof raw === 'string' ? raw : null;
};

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. A single
 * `<decisionTableParameters>` parses as a scalar object, two or more as
 * an array; both must be iterable here. Mirrors the extractor's helper.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

interface ParsedParam {
  readonly fieldName: string;
  readonly dataType: string;
  readonly usage: string;
  readonly sequence: number;
}

/**
 * Coerce the XML `<sequence>` scalar to a finite integer. Parameters
 * without a sequence sort last (Number.MAX_SAFE_INTEGER) so the input
 * /  output arrays remain deterministically ordered even when the
 * source XML is missing the ordering hint. The extractor's vendored
 * doc declares `<sequence>` as the ordering position but does not
 * require it; this preserves resilient ordering without fabricating.
 */
const coerceSequence = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.MAX_SAFE_INTEGER;
};

/**
 * Walk the parsed XML root for `<decisionTableParameters>` children,
 * normalise each to a `ParsedParam`, sort by `sequence`. Skips rows
 * without a `<usage>` element — the vendored doc declares `<usage>` as
 * the input/output discriminant, so a row without it has no defensible
 * bucket (mirrors the extractor's count discipline).
 */
const collectParameters = (
  rootObj: Record<string, unknown>,
): readonly ParsedParam[] => {
  const params: ParsedParam[] = [];
  for (const raw of toArray(rootObj[PARAMETER_ELEMENT])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const usage = unwrapSingle(obj['usage']);
    if (usage !== INPUT_USAGE && usage !== OUTPUT_USAGE) continue;
    const fieldName = unwrapSingle(obj['fieldName']);
    const dataType = unwrapSingle(obj['dataType']);
    params.push({
      fieldName: typeof fieldName === 'string' ? fieldName : '',
      dataType: typeof dataType === 'string' ? dataType : '',
      usage,
      sequence: coerceSequence(unwrapSingle(obj['sequence'])),
    });
  }
  return params.sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.fieldName < b.fieldName ? -1 : a.fieldName > b.fieldName ? 1 : 0;
  });
};

interface ParsedSourceXml {
  readonly inputParams: readonly DecisionTableInputParam[];
  readonly outputParams: readonly DecisionTableOutputParam[];
  readonly readError: string | null;
}

const SOURCE_READ_FAILURE = (path: string, reason: string): string =>
  `parameter list unavailable: source XML at '${path}' could not be ` +
  `read (${reason}). The graph node confirms this DecisionTable exists; ` +
  'run `sfi refresh` to re-extract the source XML if the file has ' +
  'moved.';

/**
 * Re-read the source XML to enumerate the per-parameter shape. The
 * extractor stored only counts; this tool needs the per-parameter
 * detail. Read failures resolve to empty parameter arrays plus a
 * `readError` boundary entry rather than aborting the call — the graph
 * already proved the DecisionTable exists, and a freshness gap should
 * surface as a documented partial answer, not a refusal.
 */
const readParametersFromSource = async (
  sourcePath: string,
): Promise<ParsedSourceXml> => {
  let xmlText: string;
  try {
    xmlText = await readFile(sourcePath, 'utf-8');
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      inputParams: [],
      outputParams: [],
      readError: SOURCE_READ_FAILURE(sourcePath, reason),
    };
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return {
      inputParams: [],
      outputParams: [],
      readError: SOURCE_READ_FAILURE(sourcePath, validation.err.msg),
    };
  }

  // Local trusted disk content; XXE not a concern. Mirrors the
  // extractor's parser settings so this tool's reading semantics
  // stay in lockstep with what the extractor accepted.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      inputParams: [],
      outputParams: [],
      readError: SOURCE_READ_FAILURE(sourcePath, reason),
    };
  }

  const rootCandidate = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof rootCandidate !== 'object' || rootCandidate === null) {
    return {
      inputParams: [],
      outputParams: [],
      readError: SOURCE_READ_FAILURE(
        sourcePath,
        `expected <${ROOT_ELEMENT}> root`,
      ),
    };
  }

  const params = collectParameters(rootCandidate as Record<string, unknown>);
  const inputParams: DecisionTableInputParam[] = [];
  const outputParams: DecisionTableOutputParam[] = [];
  for (const p of params) {
    if (p.usage === INPUT_USAGE) {
      inputParams.push({
        name: p.fieldName,
        type: p.dataType,
        // DecisionTable XML has no <defaultValue> element in the
        // vendored doc; the field exists for forward-compatibility
        // and surfaces as null in v3.2.
        defaultValue: null,
      });
    } else {
      outputParams.push({ name: p.fieldName, type: p.dataType });
    }
  }
  return { inputParams, outputParams, readError: null };
};

/**
 * The `sfi.decision_table_browse` MCP tool. Returns the table's
 * parameter shape plus the verbatim Q179 row-data refusal in
 * `boundaries[]`. `rows` is unconditionally `null` — v3.2 will not
 * fabricate row content.
 *
 * @example
 *   const r = await decisionTableBrowseHandler(ctx, {
 *     decisionTableId: 'DecisionTable:FPLFullTabe',
 *   });
 *   if (r.ok) console.log(r.value.data.inputParams.length);
 */
export const decisionTableBrowseHandler = async (
  ctx: Context,
  input: DecisionTableBrowseInput,
): Promise<Result<McpResponse<DecisionTableBrowseOutput>, McpError>> => {
  if (!input.decisionTableId.startsWith(DECISION_TABLE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `decisionTableId must start with '${DECISION_TABLE_PREFIX}'; got '${input.decisionTableId}'`,
      path: 'decisionTableId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.decisionTableId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.decisionTableId, 'DecisionTable'),
      path: input.decisionTableId,
    });
  }
  if (node.type !== 'DecisionTable') {
    return err({
      kind: 'component-not-found',
      message: `no DecisionTable with id ${input.decisionTableId}`,
      path: input.decisionTableId,
    });
  }

  const dataSourceTypeRaw =
    readStringProperty(node, 'dataSourceType') ?? '<unknown>';
  const executionTypeRaw =
    readStringProperty(node, 'executionType') ?? '<unknown>';
  const sourceObject = readStringProperty(node, 'sourceObject');

  const { inputParams, outputParams, readError } =
    await readParametersFromSource(
      resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
    );

  // Q179 first, then the dataSourceType-specific hint, then the
  // Native-vs-Vlocity disclosure (axis 1). Order matters: the
  // refusal anchor is the load-bearing one; the hint immediately
  // tells the caller what to do next; the Native disclosure
  // surfaces for discipline consistency across the v3.2 tool
  // surface. If we couldn't read the source XML, append the
  // documented read-failure boundary so the caller sees the partial-
  // answer signal verbatim.
  const boundaries: string[] = [
    ROW_DATA_BOUNDARY,
    rowStoreHint(dataSourceTypeRaw, sourceObject),
    NATIVE_VS_VLOCITY_BOUNDARY,
  ];
  if (readError !== null) {
    boundaries.push(readError);
  }

  return ok({
    data: {
      decisionTableId: node.id,
      apiName: node.apiName,
      dataSourceType: dataSourceTypeRaw,
      executionType: executionTypeRaw,
      inputParams,
      outputParams,
      // Q179 honesty anchor: the row payload is unconditionally
      // null. The boundaries[] array carries the verbatim refusal
      // phrase the caller will surface. v3.2 will not fabricate row
      // content even when the metadata XML hints at the row store.
      rows: null,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
