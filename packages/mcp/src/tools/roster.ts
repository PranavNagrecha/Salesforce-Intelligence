/**
 * Tool roster — canonical V01_TOOLS definition for the MCP server.
 *
 * Contains: MCP protocol annotation helpers, ToolDefinition types,
 * inline JSON Schema definitions for every tool, and the V01_TOOLS array
 * that is advertised via `tools/list`. Split from tools/index.ts (R7-F2)
 * to remove the merge hotspot on that file.
 *
 * @see tool-dispatch.ts  — handler imports + dispatchTool + jsonResult
 * @see index.ts          — thin re-exports + registerTools
 */

import {
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { EDGE_TYPES } from '@sf-intelligence/contracts';
import {
  QUERY_GRAPH_ALLOWED_OPS,
  QUERY_GRAPH_MAX_CONDITIONS,
  QUERY_GRAPH_MAX_LIMIT,
} from '@sf-intelligence/graph';

import {
  livePlaneForTool,
  type LivePlaneTag,
} from '../live-capability.js';

// LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES: the advertised list_components
// `type` enum is spread from this single source of truth, not hand-duplicated.
import { COMPONENT_TYPES } from './list-components.js';

/**
 * MCP protocol `Tool.annotations` for vault-plane tools (MCP-01).
 *
 * Distinct from the vault curated-annotations overlay in `annotations.ts`
 * (`sfi.annotations` / `sfi.propose_annotation` / review/confirm/reject).
 * These are SDK hints for hosts, not org metadata.
 *
 * Product is Salesforce-read-only: `readOnlyHint: true`, `destructiveHint:
 * false`. Local vault-file writers (`sfi.propose_annotation`,
 * `sfi.confirm_annotation`, `sfi.reject_annotation`,
 * `sfi.baseline_acknowledge`, optional `route_question` gap logging) keep
 * the same hints — `openWorldHint: false` because the local filesystem is
 * not an open-world external entity; `readOnlyHint` stays true because the
 * Salesforce product surface never mutates the org (MCP-01 documented
 * choice vs strict SDK "modifies environment" reading).
 */
export const MCP_VAULT_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> =
  Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });

/**
 * MCP protocol annotations for tools that can reach the live org — still
 * Salesforce read-only, but `openWorldHint: true` because they hit an
 * external org. Applied to every tool whose registry `livePlane` tag is
 * `primary` OR `opt-in` (i.e. `livePlaneForTool(name) !== 'never'`), NOT a
 * lexical `sfi.live_*` guess — so non-prefixed live-reaching tools are
 * labeled open-world too.
 */
export const MCP_LIVE_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> =
  Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });

/**
 * Resolve MCP protocol annotations for a registered tool name (MCP-01).
 *
 * `openWorldHint` is keyed off the SEMANTIC registry `livePlane` tag
 * ({@link livePlaneForTool}) rather than the `sfi.live_*` name prefix.
 */
export const mcpProtocolAnnotationsFor = (
  name: string,
): Readonly<ToolAnnotations> =>
  livePlaneForTool(name) !== 'never'
    ? MCP_LIVE_TOOL_ANNOTATIONS
    : MCP_VAULT_TOOL_ANNOTATIONS;

/**
 * One tool's static metadata as advertised to MCP clients.
 *
 *   - `name`: the JSON-RPC tool name the client invokes.
 *   - `description`: a one-line summary the client surfaces to users.
 *   - `inputSchema`: a JSON Schema object describing the tool's input.
 *     v0.1 ships placeholder schemas (`{type: 'object'}`); Phase F's
 *     `mcp-tool-X` tasks replace the entry with the real Zod-derived
 *     JSON Schema.
 *   - `annotations`: MCP protocol ToolAnnotations (MCP-01) — stamped on
 *     every roster entry via `mcpProtocolAnnotationsFor`. Not the vault
 *     curated-annotations overlay.
 *   - `outputSchema`: MCP-01 (b) shared envelope schema for
 *     `structuredContent` — stamped via {@link MCP_TOOL_OUTPUT_SCHEMA}.
 *   - `livePlane`: INFRA-12-DEEP structural ambient-consent guard —
 *     `'never'` | `'opt-in'` | `'primary'`. Stamped via {@link livePlaneForTool}.
 *     `dispatchTool` mints a LiveCapability from this tag onto Context so
 *     `resolveLiveAccess` / `gateLive` cannot read standing consent unless
 *     the invoked tool is declared opt-in or primary.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<ToolAnnotations>;
  /**
   * MCP-01 (b) — JSON Schema for `CallToolResult.structuredContent`.
   * Shared envelope for every tool (success `data`+`vaultState` or `error`).
   */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /**
   * INFRA-12-DEEP — whether this tool may consult the live org plane.
   * Required on every roster entry (completeness test enforced).
   */
  readonly livePlane: LivePlaneTag;
  /**
   * When `true`, the tool stays fully DISPATCHABLE (its dispatch `case`,
   * `KNOWN_TOOL_NAMES` membership, and any embedding vector are retained) but is
   * EXCLUDED from `advertisedTools()` / the `tools/list` roster. This is the
   * back-compat-alias posture: a retired tool name whose capability has been
   * folded into a survivor keeps working for direct / `run_analysis` callers
   * (and any un-migrated gold row) yet no longer occupies a schema slot on
   * `tools/list`. A hidden alias needs NO funnel-utterance entry and NO
   * `capabilities.ts` roster entry — the parity tests exempt it. Omit (or
   * `false`) for a normally-advertised tool.
   */
  readonly hidden?: boolean;
}

/**
 * MCP-01 (b) — centralized output schema for every roster tool.
 *
 * Mirrors the typed `McpResponse` / `McpError` envelopes (plus budget /
 * badge fields `jsonResult` may attach). Root is intentionally loose
 * (`additionalProperties: true`, no required root keys) so both success
 * and error shapes validate; per-tool `data` payloads stay open.
 */
export const MCP_TOOL_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    description:
      'sf-intelligence tool envelope: success `{ data, vaultState, estimatedPayloadBytes, ... }` or failure `{ error, ... }`.',
    properties: {
      data: {
        description: 'Tool-specific success payload.',
      },
      vaultState: {
        type: 'object',
        properties: {
          sourceTreeHash: { type: 'string' },
          refreshedAt: { type: 'string' },
        },
        required: ['sourceTreeHash', 'refreshedAt'],
        additionalProperties: true,
      },
      error: {
        description:
          'Failure envelope — string kind or `{ kind, message, ... }`.',
      },
      estimatedPayloadBytes: { type: 'number' },
      orgDrift: {
        description: 'Optional freshness/drift badge when vault staleness intersects the answer.',
      },
      responseBudget: {
        description: 'Present when the global response budget truncated or slimmed the payload.',
      },
    },
    additionalProperties: true,
  });

/** Roster entry before MCP-01 protocol annotations + livePlane + outputSchema are stamped. */
type ToolDefinitionBase = Omit<
  ToolDefinition,
  'annotations' | 'livePlane' | 'outputSchema'
>;

/**
 * Concrete JSON Schema for `sfi.search_components`. Hand-authored to mirror
 * `searchComponentsInputSchema` — the project has no zod-to-json-schema
 * dependency, and inlining keeps the advertised schema in lockstep with
 * the Zod validator at code-review time rather than build time.
 */
const SEARCH_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    types: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.capabilities`. The tool takes no arguments;
 * mirrors the empty `z.object({})` validator in its own module.
 */
const CAPABILITIES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.synthesize_answer`. Mirrors
 * `synthesizeAnswerInputSchema`. `input` accepts any JSON (the prior tool
 * output to ground on); `question` and `draft` are optional strings.
 */
const SYNTHESIZE_ANSWER_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      input: {},
      question: { type: 'string' },
      draft: { type: 'string' },
    },
  });

/** Concrete JSON Schema for `sfi.org_pulse`. Mirrors `orgPulseInputSchema`. */
const ORG_PULSE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
});

/** Concrete JSON Schema for `sfi.org_card`. Mirrors `orgCardInputSchema`. */
const ORG_CARD_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/** Concrete JSON Schema for `sfi.list_analyses`. Mirrors `listAnalysesInputSchema`. */
const LIST_ANALYSES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/** Concrete JSON Schema for `sfi.describe_analysis`. Mirrors `describeAnalysisInputSchema`. */
const DESCRIBE_ANALYSIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    detail: {
      type: 'string',
      enum: ['summary', 'schema', 'full'],
      description:
        'Progressive discovery: summary (default under core), schema (+ inputSchema), or full (description + schema).',
    },
  },
  required: ['name'],
});

/** Concrete JSON Schema for `sfi.run_analysis`. Mirrors `runAnalysisInputSchema`. */
const RUN_ANALYSIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    args: {
      description: 'The target analysis args — an object, or a JSON-encoded string of one.',
    },
  },
  required: ['name'],
});

/** Concrete JSON Schema for `sfi.fleet_find`. Mirrors `fleetFindInputSchema`. */
const FLEET_FIND_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['query'],
});

/** Concrete JSON Schema for `sfi.fleet_drift_ranking`. Mirrors `fleetDriftRankingInputSchema`. */
const FLEET_DRIFT_RANKING_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    liveEnabled: { type: 'boolean' },
    vaults: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_fleet_report`. Mirrors
 * `generateFleetReportInputSchema` — no required args; the optional `limit`
 * (1..25) caps how many registered vaults get the graph-opening pulse
 * digest. Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_FLEET_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 25 },
  },
});

/**
 * Concrete JSON Schema for `sfi.resolve`. Mirrors `resolveInputSchema` — a
 * non-empty `query`, optional `types` filter, optional `parentId` scope, and
 * a 1..50 `limit`. Drift between Zod and this schema is a code-review concern.
 */
const RESOLVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    types: { type: 'array', items: { type: 'string' } },
    parentId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.get_component`. Mirrors
 * `getComponentInputSchema`; kept inline alongside the search-components
 * schema for the same reason — no zod-to-json-schema dependency, and
 * Zod-vs-advertised drift is easier to spot when both live in this file.
 */
const GET_COMPONENT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    maxBodyBytes: { type: 'integer', minimum: 0, maximum: 30000 },
  },
  required: ['id'],
});

/**
 * Concrete JSON Schema for `sfi.get_edges`. Mirrors `getEdgesInputSchema`.
 * The `edgeType` and `confidence` enums are duplicated from the contracts
 * `EdgeType` and `ConfidenceLevel` unions; the source of truth lives in
 * `get-edges.ts` (Zod) and drift is a code-review concern.
 */
const GET_EDGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    nodeId: { type: 'string', minLength: 1 },
    // 'incoming'/'outgoing' are accepted aliases (normalized to in/out).
    direction: { type: 'string', enum: ['in', 'out', 'both', 'incoming', 'outgoing'] },
    edgeType: {
      type: 'string',
      // Single-sourced from the contracts EDGE_TYPES tuple so the advertised
      // schema can't drift from the Zod enum (both include dispatchesOmniAction).
      enum: [...EDGE_TYPES],
    },
    confidence: {
      type: 'string',
      enum: ['declared', 'parsed', 'heuristic'],
    },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['nodeId'],
});

/**
 * Concrete JSON Schema for `sfi.query_graph`. Mirrors `queryGraphInputSchema`
 * (Zod). The `op` enum and `limit` max are single-sourced from the graph-layer
 * `QUERY_GRAPH_ALLOWED_OPS` / `QUERY_GRAPH_MAX_LIMIT` so the advertised schema
 * cannot drift from the compiler's allowlist. `column` is a free string here —
 * the graph-layer per-table allowlist rejects an unknown column at compile time
 * with `invalid-query` (the allowlist is too large + context-dependent to
 * usefully enumerate in a JSON-Schema enum, and a fail-closed compile error is
 * the honest boundary).
 */
const QUERY_GRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    select: { type: 'string', enum: ['nodes', 'edges'] },
    where: {
      type: 'array',
      maxItems: QUERY_GRAPH_MAX_CONDITIONS,
      items: {
        type: 'object',
        properties: {
          column: { type: 'string', minLength: 1 },
          op: { type: 'string', enum: [...QUERY_GRAPH_ALLOWED_OPS] },
          value: {
            oneOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                  ],
                },
              },
            ],
          },
        },
        required: ['column', 'op'],
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: QUERY_GRAPH_MAX_LIMIT },
  },
  required: ['select'],
});

/**
 * Concrete JSON Schema for `sfi.list_components`. Mirrors
 * `listComponentsInputSchema`. The `type` enum is SPREAD from the single source
 * of truth `COMPONENT_TYPES` in `list-components.ts` (the same array the Zod
 * validator enumerates) rather than hand-duplicated — so the advertised schema
 * and the handler's accepted set can never drift again
 * (LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES: a stale hand-copy here is exactly
 * how `CustomPermission` — and later `SamlSsoConfig` / `Skill` / … — shipped
 * retrievable but unlistable). The `list-components advertised inputSchema enum
 * ↔ Zod validator parity` test still guards against a hand-edit slipping the two
 * apart.
 */
const LIST_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...COMPONENT_TYPES],
    },
    parentId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
    // P4-interface-impl: ApexClass async/interface/API boolean filters.
    isQueueable: { type: 'boolean' },
    isSchedulable: { type: 'boolean' },
    isBatchable: { type: 'boolean' },
    isRestResource: { type: 'boolean' },
    hasFutureMethod: { type: 'boolean' },
    hasInvocableMethod: { type: 'boolean' },
    hasAuraEnabledMethod: { type: 'boolean' },
    isTest: { type: 'boolean' },
    // Description-presence filters. Answer "which <type> have no description".
    // Only meaningful for a type whose extractor captures `<description>`.
    missingDescription: { type: 'boolean' },
    hasDescription: { type: 'boolean' },
  },
});

/**
 * Concrete JSON Schema for `sfi.get_subgraph`. Mirrors
 * `getSubgraphInputSchema`. The `hops` bounds (`1..3`) are duplicated from
 * the Zod schema in `get-subgraph.ts`; drift between Zod and this schema
 * is a code-review concern.
 */
const GET_SUBGRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    rootId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
  },
  required: ['rootId'],
});

/**
 * Concrete JSON Schema for `sfi.search_apex_source`. Mirrors
 * `searchApexSourceInputSchema`. The `limit` upper bound (`200`) is
 * duplicated from the Zod schema in `search-apex-source.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const SEARCH_APEX_SOURCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    regex: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.search_flow_metadata`. Mirrors
 * `searchFlowMetadataInputSchema`. The shape is identical to
 * `SEARCH_APEX_SOURCE_INPUT_SCHEMA` because the tool inputs are
 * structurally the same; keeping the two constants distinct preserves
 * the one-constant-per-tool symmetry so future Zod-vs-advertised drift
 * is easy to spot at code-review time.
 */
const SEARCH_FLOW_METADATA_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    regex: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.get_naming_convention_report`. Mirrors
 * `namingConventionReportInputSchema` — `scope` is an optional non-empty
 * string; no required fields. The recognizer interprets the value itself
 * (`'all'` or `'CustomField:{ObjectApiName}.*'`); we only enforce
 * non-emptiness at the input boundary so genuinely malformed scopes
 * surface as `invalid-query` further downstream.
 */
const NAMING_CONVENTION_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    scope: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.get_manifest`. The tool takes no arguments;
 * the schema mirrors the empty `z.object({})` validator declared in the
 * tool's own module. Declared as a named constant so the `tools/list`
 * payload stays symmetric with the other tools and Zod-vs-advertised
 * drift remains a code-review concern.
 */
const GET_MANIFEST_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/** Concrete JSON Schema for `sfi.coverage_report`. Mirrors `coverageReportInputSchema`. */
const COVERAGE_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
  },
});

/** Concrete JSON Schema for `sfi.retrieve_blindspot_report`. Mirrors `retrieveBlindspotReportInputSchema`. */
const RETRIEVE_BLINDSPOT_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    targetType: { type: 'string', minLength: 1 },
    includeLowSignal: { type: 'boolean' },
  },
});

const BASELINE_ACKNOWLEDGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['tool', 'rule', 'componentId', 'location'],
    properties: {
      tool: { type: 'string', minLength: 1 },
      rule: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      location: { type: 'string', minLength: 1 },
      note: { type: 'string' },
    },
  });

const BASELINE_STATUS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      tool: { type: 'string', minLength: 1 },
    },
  });

const TREND_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    metric: {
      type: 'string',
      enum: ['componentCount', 'edgeCount', 'securityScore'],
      description:
        'Optional series to emphasize. Omit for the default componentCount/edgeCount timeline. Pass securityScore to trend the capture-time permission-risk posture grade (0–100; null on pre-upgrade snapshots).',
    },
  },
});

const CHURN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    fromLabel: { type: 'string', minLength: 1 },
    toLabel: { type: 'string', minLength: 1 },
  },
});

const LIVE_ENABLED_PROPERTY = {
  liveEnabled: { type: 'boolean' },
  orgAlias: { type: 'string', minLength: 1 },
};

const LIVE_DESCRIBE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_COUNT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  // Either `soql` (a SELECT COUNT() query) or `objectApiName` (count all rows).
  // The one-of requirement is enforced in the handler, not the JSON schema, so
  // the advertised shape stays simple for clients. `additionalProperties:false`
  // matches the runtime `.strict()` schema so a filter passed under an
  // unrecognized key (e.g. `filter`/`where`) is rejected, never silently dropped
  // into an unfiltered full-object count.
  additionalProperties: false,
  properties: {
    soql: { type: 'string', minLength: 1 },
    objectApiName: { type: 'string', minLength: 1 },
    whereClause: {
      type: 'string',
      minLength: 1,
      description:
        'Filter applied only when counting via objectApiName; becomes the WHERE of SELECT COUNT() FROM <object>. Cannot be combined with a full soql.',
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STALE_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_SAMPLE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['soql'],
  properties: {
    soql: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_FIELD_POPULATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['objectApiName', 'fieldApiName'],
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

const LIVE_ORG_LIMITS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { ...LIVE_ENABLED_PROPERTY },
});

/** Concrete JSON Schema for `sfi.live_data_skew`. Mirrors `liveDataSkewInputSchema`
 *  (`orgAlias` comes from LIVE_ENABLED_PROPERTY). */
const LIVE_DATA_SKEW_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    ownerField: { type: 'string', minLength: 1 },
    threshold: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['objectApiName'],
});

/** Concrete JSON Schema for `sfi.live_security_exposure`. Mirrors
 *  `liveSecurityExposureInputSchema` (`orgAlias` from LIVE_ENABLED_PROPERTY). */
const LIVE_SECURITY_EXPOSURE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    ...LIVE_ENABLED_PROPERTY,
  },
});

/** Concrete JSON Schema for `sfi.live_picklist_usage`. Mirrors `livePicklistUsageInputSchema`. */
const LIVE_PICKLIST_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['fieldId'],
});

/** Concrete JSON Schema for `sfi.live_automation_fired`. Mirrors `liveAutomationFiredInputSchema`. */
const LIVE_AUTOMATION_FIRED_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['componentId'],
});

const LIVE_INACTIVE_USERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 3650 },
      includeAllUserTypes: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/** Concrete JSON Schema for `sfi.live_permset_holders`. Mirrors `livePermsetHoldersInputSchema`. */
const LIVE_PERMSET_HOLDERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        description:
          'Exact PermissionSet.Name / PermissionSetGroup DeveloperName / Profile.Name (labels accepted).',
      },
      kind: {
        type: 'string',
        enum: ['permissionSet', 'permissionSetGroup', 'profile', 'auto'],
        description:
          "What `name` names. Default 'auto' probes PermissionSet → PermissionSetGroup → Profile by exact name/label; no-match or ambiguity errors honestly.",
      },
      includeInactiveAssignees: { type: 'boolean' },
      includeViaGroups: {
        type: 'boolean',
        description:
          'For kind permissionSet: also count holders receiving the set through a PermissionSetGroup containing it (default true).',
      },
      groupBy: { type: 'string', enum: ['none', 'profile'] },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      afterId: {
        type: 'string',
        description: 'Keyset paging token — the `nextAfterId` from the previous page.',
      },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/** Concrete JSON Schema for `sfi.live_zombie_accounts`. Mirrors `liveZombieAccountsInputSchema`. */
const LIVE_ZOMBIE_ACCOUNTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      minDaysInactive: {
        type: 'integer',
        minimum: 0,
        maximum: 3650,
        description:
          'Additionally require last login older than N days (default 0 = ignore login age).',
      },
      includeAllUserTypes: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/** Concrete JSON Schema for `sfi.live_group_members`. Mirrors `liveGroupMembersInputSchema`. */
const LIVE_GROUP_MEMBERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        description: 'Exact Group DeveloperName or Name (label) of the queue / public group.',
      },
      groupType: {
        type: 'string',
        enum: ['Queue', 'Regular', 'auto'],
        description:
          "What kind of Group `name` names. Default 'auto' matches both; an ambiguous name across both errors honestly.",
      },
      expandNested: {
        type: 'boolean',
        description:
          'Expand exactly ONE level of nested public groups (default false). Role entries are never expanded.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/** Concrete JSON Schema for `sfi.live_user_permsets`. Mirrors `liveUserPermsetsInputSchema`. */
const LIVE_USER_PERMSETS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['user'],
    properties: {
      user: {
        type: 'string',
        minLength: 1,
        description:
          'Exact Username (preferred — unique) or exact User.Name. An ambiguous name returns candidates, never a guess.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/**
 * Concrete JSON Schema for `sfi.live_setup_audit_trail` (R6-27). Mirrors
 * `liveSetupAuditTrailInputSchema` in `live-plane.ts`. `days` bounds the
 * SetupAuditTrail window (default 30, max 180 — Salesforce's own retention
 * ceiling for this object); `limit` caps the detail page (default 100, max
 * 500, matching `MAX_DETAIL_ROWS`).
 */
const LIVE_SETUP_AUDIT_TRAIL_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 180 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/**
 * Concrete JSON Schema for `sfi.live_license_usage`. Mirrors
 * `liveLicenseUsageInputSchema`. `inactiveDays` sets the reclaimable-seat
 * dormancy window (default 90); `limit` caps reclaimable-seat groups. Drift
 * between Zod and this schema is a code-review concern.
 */
const LIVE_LICENSE_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      inactiveDays: { type: 'integer', minimum: 1, maximum: 3650 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

const LIVE_GROUP_COUNT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'groupByField'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    groupByField: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STALE_RECORDS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    dateField: { type: 'string', minLength: 1 },
    includeNeverSet: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_RECENT_ACTIVITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    days: { type: 'integer', minimum: 1, maximum: 365 },
    activity: { type: 'string', enum: ['created', 'modified', 'both'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_AGGREGATE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'fieldApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    fieldApiName: { type: 'string', minLength: 1 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_DUPLICATE_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'fieldApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    fieldApiName: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_OWNER_BREAKDOWN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STORAGE_BY_OBJECT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    objectApiNames: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: 80,
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

/** Concrete JSON Schema for `sfi.live_record_access`. Mirrors `liveRecordAccessInputSchema`. */
const LIVE_RECORD_ACCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['recordId'],
  properties: {
    recordId: {
      type: 'string',
      minLength: 1,
      description: 'The 15- or 18-character Id of the record whose access is being checked.',
    },
    userId: {
      type: 'string',
      minLength: 1,
      description: 'The user to check, by Id. Provide this OR `username` (userId wins).',
    },
    username: {
      type: 'string',
      minLength: 1,
      description: 'The user to check, by exact Username (resolved to an Id). Provide this OR `userId`.',
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

/** Concrete JSON Schema for `sfi.live_record_shares`. Mirrors `liveRecordSharesInputSchema`. */
const LIVE_RECORD_SHARES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['recordId'],
  properties: {
    recordId: {
      type: 'string',
      minLength: 1,
      description: 'The 15- or 18-character Id of the record whose explicit shares are listed.',
    },
    objectApiName: {
      type: 'string',
      minLength: 1,
      description: "The record's object API name. Optional — derived from the Id key prefix via the org describe when omitted.",
    },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

/** Concrete JSON Schema for `sfi.live_field_history`. Mirrors `liveFieldHistoryInputSchema`. */
const LIVE_FIELD_HISTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    fieldApiName: {
      type: 'string',
      minLength: 1,
      description: 'Restrict to one field (History.Field equals this API name).',
    },
    recordId: {
      type: 'string',
      minLength: 1,
      description: 'Restrict to one record (the {Object}History parent-Id field).',
    },
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 3650,
      description: 'Only changes in the last N days (CreatedDate = LAST_N_DAYS:N).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'Max history rows (default 20, HARD cap 200 — these are record values).',
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

/** Concrete JSON Schema for `sfi.live_scheduled_jobs`. Mirrors `liveScheduledJobsInputSchema`. */
const LIVE_SCHEDULED_JOBS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    includeAsyncApexJobs: {
      type: 'boolean',
      description: 'Include a recent AsyncApexJob status summary (default true).',
    },
    asyncDays: {
      type: 'integer',
      minimum: 1,
      maximum: 90,
      description: 'Window (days) for the AsyncApexJob summary (default 7).',
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_REPORT_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_FOLDER_ACCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    folderType: { type: 'string', enum: ['Report', 'Dashboard', 'Email', 'Document', 'all'] },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_EMAIL_TEMPLATE_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_ORG_HEALTH_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    days: { type: 'integer', minimum: 1, maximum: 90 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_CONSENT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    orgAlias: { type: 'string', minLength: 1 },
    grant: { type: 'boolean' },
    revoke: { type: 'boolean' },
    scopes: {
      type: 'array',
      items: { type: 'string', enum: ['aggregate', 'sample', 'users', 'audit'] },
    },
    expiresInHours: { type: 'integer', minimum: 1, maximum: 2160 },
  },
});

/**
 * Concrete JSON Schema for `sfi.route_question`. Mirrors
 * `routeQuestionInputSchema` (route-question.ts) — the Zod validator is the
 * source of truth, and the advertised property KEYS are parity-tested against
 * it (route-question-schema-parity.test.ts) so a param the handler accepts can
 * never ship unadvertised again (the CustomPermission enum-drift lesson).
 * `context` is the router-v2 P5 host-passed conversation context: STATELESS,
 * per-call, never stored server-side.
 */
const ROUTE_QUESTION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1 },
    logGap: { type: 'boolean' },
    clarificationResponse: {
      type: 'object',
      required: ['clarificationId', 'selection'],
      properties: {
        clarificationId: { type: 'string', minLength: 1 },
        selection: { type: 'string', minLength: 1 },
      },
    },
    mode: { type: 'string', enum: ['ask', 'plan', 'assessment'] },
    context: {
      type: 'object',
      required: ['previous'],
      additionalProperties: false,
      properties: {
        previous: {
          type: 'object',
          additionalProperties: false,
          properties: {
            componentId: { type: 'string', minLength: 1, maxLength: 256 },
            objectApiName: { type: 'string', minLength: 1, maxLength: 256 },
            tool: { type: 'string', pattern: '^sfi\\.[a-z0-9_]+$' },
            intent: { type: 'string', minLength: 1, maxLength: 64 },
            plane: { type: 'string', enum: ['vault', 'live', 'hybrid'] },
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            clarification: {
              type: 'object',
              required: ['clarificationId', 'options'],
              additionalProperties: false,
              properties: {
                clarificationId: { type: 'string', minLength: 1, maxLength: 64 },
                options: {
                  type: 'array',
                  items: { type: 'string', minLength: 1, maxLength: 256 },
                  minItems: 1,
                  maxItems: 10,
                },
              },
            },
          },
        },
      },
    },
  },
});

const SYNTHESIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
});

/**
 * Concrete JSON Schema for `sfi.automation_risk_report`. Mirrors
 * `automationRiskReportInputSchema`: the generic `limit` plus an optional OBJECT
 * SCOPE (AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE) and the optional `mode`
 * (AUTOMATION-SPRAWL-MODE). A scope narrows the legacy-automation half to that
 * object and excludes the org-wide Apex governor-limit half (disclosed), never
 * silently returning the org-wide report. `mode: 'sprawl'` switches to the
 * org-wide per-object automation-density ranking; the default (`'risk'`) is the
 * per-finding risk synthesis.
 */
const AUTOMATION_RISK_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      objectApiName: { type: 'string', minLength: 1 },
      object: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['risk', 'sprawl'] },
    },
  });

/**
 * Concrete JSON Schema for `sfi.org_risk_report`. Mirrors
 * `orgRiskReportInputSchema`: the generic `limit` plus the optional `gate`
 * deploy-gate MODE (STEP-2: absorbed from the retired
 * `release_readiness_report`). `gate: true` adds `ready` + `blockers` to the
 * output — the go/no-go release verdict.
 */
const ORG_RISK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    gate: { type: 'boolean' },
  },
});

/**
 * Concrete JSON Schema for `sfi.permission_risk_report`. Mirrors
 * `permissionRiskReportInputSchema`: the generic `limit` plus an optional
 * `profileFilter` that SCOPES the report to one profile. The filter is honored
 * — an unknown profile stops the report with a false-premise caveat rather than
 * dumping the org-wide report.
 */
const PERMISSION_RISK_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      profileFilter: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.health_check`. The tool takes no arguments;
 * the schema mirrors the empty `z.object({})` validator declared in the
 * tool's own module. Declared as a named constant so the `tools/list`
 * payload stays symmetric with the other tools and Zod-vs-advertised
 * drift remains a code-review concern.
 */
const HEALTH_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.get_impact`. Mirrors
 * `getImpactInputSchema`. The `hops` bounds (`1..3`) and the `edgeTypes`
 * enum are duplicated from `get-impact.ts`; drift between Zod and this
 * schema is a code-review concern. The enum order matches the Zod
 * declaration so a future automated comparison can be a textual diff.
 */
const GET_IMPACT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
    edgeTypes: {
      type: 'array',
      items: {
        type: 'string',
        // Single-sourced from the contracts EDGE_TYPES tuple (see get_edges).
        enum: [...EDGE_TYPES],
      },
    },
  },
  required: ['componentId'],
});

/** Concrete JSON Schema for `sfi.blast_radius_live`. Mirrors `blastRadiusLiveInputSchema`. */
const BLAST_RADIUS_LIVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
    maxLiveCounts: { type: 'integer', minimum: 0, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.find_formula_references`. Mirrors
 * `findFormulaReferencesInputSchema`. The `limit` upper bound (`500`) is
 * duplicated from the Zod schema in `find-formula-references.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const FIND_FORMULA_REFERENCES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // The target field — interchangeable: a `CustomField:` id via `fieldId` or
      // `componentId`, or a dotted `<Object>.<Field>` via `fieldApiName` (all
      // resolve to the same field). Pass exactly one; disagreeing selectors →
      // `invalid-query` (FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID).
      fieldId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.find_apex_usages`. Mirrors
 * `findApexUsagesInputSchema`. The `limit` upper bound (`500`) and the
 * `edgeTypes` enum are duplicated from the Zod schema in
 * `find-apex-usages.ts`; drift between Zod and this schema is a
 * code-review concern. The enum is the Apex-emitted subset of the
 * contracts `EdgeType` union.
 */
const FIND_APEX_USAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
      edgeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['readsFrom', 'writesTo', 'callsApex'],
        },
      },
    },
    required: ['targetId'],
  });

/**
 * Concrete JSON Schema for `sfi.find_code_usages`. Mirrors
 * `findCodeUsagesInputSchema`. The `limit` upper bound (`500`), the
 * `edgeTypes` enum (the four code-emitted edge types), and the
 * `nodeTypes` enum (the six code node types — `ApexClass`,
 * `ApexTrigger`, plus the v1.4 frontend tier `LightningComponentBundle`,
 * `AuraDefinitionBundle`, `VisualforcePage`, `VisualforceComponent`)
 * are duplicated from the Zod schema in `find-code-usages.ts`; drift
 * between Zod and this schema is a code-review concern.
 *
 * `references` is included in the `edgeTypes` enum because LWC/Aura/VF
 * extractors emit `references` to other components — the v0.3-era
 * Apex-only enum (`readsFrom`/`writesTo`/`callsApex`) is a strict
 * subset of this one.
 */
const FIND_CODE_USAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
      edgeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['readsFrom', 'writesTo', 'callsApex', 'references'],
        },
      },
      nodeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'ApexClass',
            'ApexTrigger',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
          ],
        },
      },
    },
    required: ['targetId'],
  });

/** Concrete JSON Schema for `sfi.flow_fault_audit`. Mirrors `flowFaultAuditInputSchema`. */
const FLOW_FAULT_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      // FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE: object identifiers narrow the
      // sweep to record-triggered flows on that object (+ `appliedScope`),
      // never silently stripped.
      objectApiName: { type: 'string', minLength: 1 },
      object: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
    },
  });

/** Concrete JSON Schema for `sfi.record_creation_paths`. Mirrors `recordCreationPathsInputSchema`. */
const RECORD_CREATION_PATHS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.why_cant_user_see_record`. Mirrors
 * `whyCantUserSeeRecordInputSchema`. JSON Schema cannot express the
 * "at least one userContext field" refine, so callers that supply an
 * empty `userContext` will be rejected at the Zod parse step with
 * `error.kind: 'invalid-query'` rather than at advertised-schema
 * validation. Drift between Zod and this schema is a code-review
 * concern.
 */
/**
 * Concrete JSON Schema for `sfi.effective_permissions`. Mirrors
 * `effectivePermissionsInputSchema` — a profile (via `profileId` or the
 * `profileApiName` / `profileName` alias) and/or permission sets (at least one,
 * enforced at the Zod step), an optional OBJECT scope (`object` /
 * `objectApiName` / `objectId`), plus optional `limit`/`offset`.
 */
const EFFECTIVE_PERMISSIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      profileId: { type: 'string', minLength: 1 },
      profileApiName: { type: 'string', minLength: 1 },
      profileName: { type: 'string', minLength: 1 },
      permissionSetIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      // Optional OBJECT scope — "effective permissions for {profile} ON {object}?".
      object: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 200 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.list_view_sharing`. Mirrors
 * `listViewSharingInputSchema` — a required `componentId` (`CustomObject:X`
 * for all of the object's list views, or `ListView:X.Y` for one) plus
 * optional `limit`/`offset` for the paged list-view rows.
 */
const LIST_VIEW_SHARING_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 120 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.who_can_run`. Mirrors `whoCanRunInputSchema` —
 * a required `componentId` (`Flow:X`) plus optional `limit`/`offset`.
 */
const WHO_CAN_RUN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.explain_error` (R6-09). Mirrors
 * `explainErrorInputSchema` — a required `errorText` (the pasted error string)
 * plus an optional `object` SObject narrowing hint. The natural aliases
 * `error` / `message` / `errorMessage` / `text` are accepted for `errorText`
 * (merged before validation, canonical wins) so a host that pasted the banner
 * under a guessed key is not hard-failed (EXPLAIN-ERROR-REJECTS-NATURAL-ALIASES).
 */
const EXPLAIN_ERROR_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    errorText: { type: 'string', minLength: 1 },
    error: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    errorMessage: { type: 'string', minLength: 1 },
    text: { type: 'string', minLength: 1 },
    object: { type: 'string', minLength: 1 },
  },
  required: ['errorText'],
});

/**
 * Concrete JSON Schema for `sfi.explain_debug_log` (Finding #40). Mirrors
 * `explainDebugLogInputSchema` — a required `logText` (the pasted Apex debug
 * log / flow fault / governor-limit exception) plus an optional `object`
 * SObject narrowing hint. The natural aliases `debugLog` / `log` / `text` /
 * `content` are accepted for `logText` (merged before validation, canonical
 * wins) so a host that pasted the log under a guessed key is not hard-failed
 * (EXPLAIN-DEBUG-LOG-REJECTS-TEXT-ALIAS).
 */
const EXPLAIN_DEBUG_LOG_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    logText: { type: 'string', minLength: 1 },
    debugLog: { type: 'string', minLength: 1 },
    log: { type: 'string', minLength: 1 },
    text: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    object: { type: 'string', minLength: 1 },
  },
  required: ['logText'],
});

/**
 * Concrete JSON Schema for `sfi.who_can_access_object`. Mirrors
 * `whoCanAccessObjectInputSchema` — a required `componentId`
 * (`CustomObject:X`) plus optional `limit`/`offset` for the paged
 * granter list.
 */
const WHO_CAN_ACCESS_OBJECT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 250 },
      offset: { type: 'number', minimum: 0 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.guest_exposure_report` (R6-17). Mirrors
 * `guestExposureReportInputSchema`. Two optional, composable scope axes plus
 * paging — no required field (a bare call audits every modeled Experience
 * Cloud / Site surface):
 *   - COMMUNITY scope: `communityId` (`Network:X`/`CustomSite:X`) or the bare
 *     `networkApiName` / `networkName` / `siteApiName` aliases.
 *   - OBJECT scope: `objectApiName` (bare, e.g. `Contact`) or `objectId`
 *     (`CustomObject:Contact`).
 *   - `componentId` is dispatched BY PREFIX: `Network:` / `CustomSite:` →
 *     community scope; `CustomObject:` → object scope (equivalent to
 *     `objectApiName`); any other prefix is `invalid-query`.
 * Plus optional `limit`/`offset`/`cursor` for the paged `findings` list. Any
 * unsupported prefix or disagreeing selectors → `invalid-query`, never a
 * silent org-wide fallback. Drift between Zod and this schema is a code-review
 * concern.
 */
const GUEST_EXPOSURE_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      communityId: { type: 'string', minLength: 1 },
      networkApiName: { type: 'string', minLength: 1 },
      networkName: { type: 'string', minLength: 1 },
      siteApiName: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 200 },
      offset: { type: 'number', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

const WHY_CANT_USER_SEE_RECORD_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    accessLevel: { type: 'string', enum: ['read', 'edit', 'delete', 'create'] },
    userContext: {
      type: 'object',
      properties: {
        profileId: { type: 'string', minLength: 1 },
        permissionSetIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        roleId: { type: 'string', minLength: 1 },
        groupIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  required: ['componentId', 'userContext'],
});

/**
 * Concrete JSON Schema for `sfi.layout_for_user`. Mirrors
 * `layoutForUserInputSchema`. The three input axes (`objectApiName`,
 * optional `recordTypeId`, `profileId`) are all non-empty strings; no
 * enum constraints since the values are arbitrary Salesforce API
 * names. Drift between Zod and this schema is a code-review concern.
 */
const LAYOUT_FOR_USER_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      recordTypeId: { type: 'string', minLength: 1 },
      // The profile — interchangeable: a bare api name or a `Profile:` id via
      // `profileId`, `profileApiName`, `profileName`, or `profile` (resolved +
      // echoed as `appliedScope`). Pass exactly one; disagreeing → `invalid-query`.
      profileId: { type: 'string', minLength: 1 },
      profileApiName: { type: 'string', minLength: 1 },
      profileName: { type: 'string', minLength: 1 },
      profile: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.layout_assignments`. Mirrors
 * `layoutAssignmentsInputSchema` — a single required `componentId`
 * naming EITHER a page Layout (`Layout:{Object}.{LayoutName}`, layout mode)
 * OR a `CustomObject:{Object}` (object mode — every layout of the object).
 */
const LAYOUT_ASSIGNMENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 250 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.user_ability`. Mirrors
 * `userAbilityInputSchema` — the Profile / PermissionSet subject via
 * `componentId` (`Profile:X`/`PermissionSet:X`) or the natural `profileApiName`
 * / `profileId` / `permissionSetApiName` / `permissionSetId` selector (a bare
 * name is coerced to the container prefix; `componentId` wins), an optional
 * FIELD scope (`fieldId`, or `fieldApiName` + `objectApiName`) that adds a
 * `fieldAccess` FLS block, plus optional `limit`/`offset`. No field is
 * schema-required; a call that names no container is refused by the handler with
 * a named `invalid-query` (USER-ABILITY-REJECTS-FIELD-SCOPE).
 */
const USER_ABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    profileApiName: { type: 'string', minLength: 1 },
    profileId: { type: 'string', minLength: 1 },
    permissionSetApiName: { type: 'string', minLength: 1 },
    permissionSetId: { type: 'string', minLength: 1 },
    fieldId: { type: 'string', minLength: 1 },
    fieldApiName: { type: 'string', minLength: 1 },
    objectApiName: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.profile_security`. Mirrors
 * `profileSecurityInputSchema` — the profile is interchangeable across
 * `profileId` / `componentId` (`Profile:X`) / `profileApiName` (a bare apiName,
 * coerced). Pass exactly one; disagreeing selectors → `invalid-query`
 * (PROFILE-SECURITY-REJECTS-COMPONENTID). Profile-only; a permission set is refused.
 */
const PROFILE_SECURITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    profileId: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    profileApiName: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.lightning_pages`. Mirrors
 * `lightningPagesInputSchema` — a required `componentId`
 * (`CustomObject:X` for the forward, `FlexiPage:X` for the reverse) +
 * optional `limit`/`offset`.
 */
const LIGHTNING_PAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 250 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor (object mode): opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.permission_set_consolidation`. Mirrors
 * `permissionSetConsolidationInputSchema` (permission-set-consolidation.ts):
 * `minOverlap` (0.5..1, default 0.9) is the near-duplicate Jaccard threshold;
 * `includeEmpty` (default true) toggles empty-permission-set candidates; `limit`
 * (max 100, default 25) and `offset` page the RANKED candidate list. Drift
 * between this schema and the Zod schema is a code-review concern.
 */
const PERMISSION_SET_CONSOLIDATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      minOverlap: { type: 'number', minimum: 0.5, maximum: 1 },
      includeEmpty: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.limit_headroom_report`. Mirrors
 * `limitHeadroomReportInputSchema` (limit-headroom-report.ts). `edition` is the
 * optional org edition (edition-dependent limits are computed against an ASSUMED
 * `enterprise` edition when omitted, disclosed in `boundaries[]`); `limit`
 * (max 100, default 15) and `offset` page the RANKED per-object list. Drift
 * between this schema and the Zod schema is a code-review concern.
 */
const LIMIT_HEADROOM_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      edition: {
        type: 'string',
        enum: ['enterprise', 'unlimited', 'developer', 'professional'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.doc_coverage_report`. Mirrors
 * `docCoverageReportInputSchema` (doc-coverage-report.ts): `limit` (max 100,
 * default 20) and `offset` page the RANKED per-object list worst-covered first.
 * Drift between this schema and the Zod schema is a code-review concern.
 */
const DOC_COVERAGE_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.app_access`. Mirrors `appAccessInputSchema` —
 * a `componentId` (`CustomApplication:`/`Profile:`/`PermissionSet:` id) OR a
 * natural app-name selector (`apiName`/`app`/`nameContains`), plus optional
 * `limit`/`offset`. No field is schema-required; the handler resolves the app
 * from whichever selector is given and refuses with a named `invalid-query`
 * when none resolves (APP-ACCESS-REJECTS-NATURAL-ARGS).
 */
const APP_ACCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    apiName: { type: 'string', minLength: 1 },
    appApiName: { type: 'string', minLength: 1 },
    app: { type: 'string', minLength: 1 },
    application: { type: 'string', minLength: 1 },
    nameContains: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 250 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.tab_availability`. Mirrors
 * `tabAvailabilityInputSchema` — the Profile / PermissionSet subject via
 * `componentId` (`Profile:X`/`PermissionSet:X`) or the natural `profileApiName`
 * / `profileId` / `permissionSetApiName` / `permissionSetId` selector (a bare
 * name is coerced to the container prefix), an optional OBJECT scope (`object` /
 * `objectApiName` / `objectId`) that narrows to that object's tab, plus optional
 * `limit`/`offset`.
 */
const TAB_AVAILABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    profileApiName: { type: 'string', minLength: 1 },
    profileId: { type: 'string', minLength: 1 },
    permissionSetApiName: { type: 'string', minLength: 1 },
    permissionSetId: { type: 'string', minLength: 1 },
    object: { type: 'string', minLength: 1 },
    objectApiName: { type: 'string', minLength: 1 },
    objectId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.lifecycle_process`. Mirrors
 * `lifecycleProcessInputSchema` — a required `objectApiName` plus the optional
 * `field` / `value` transition, an optional `event` (insert|update, default
 * update), and `limit`/`offset` for the paged process chain.
 */
const LIFECYCLE_PROCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      field: { type: 'string', minLength: 1 },
      value: { type: 'string', minLength: 1 },
      event: { type: 'string', enum: ['insert', 'update'] },
      limit: { type: 'number', minimum: 1, maximum: 200 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.integration_map`. Mirrors
 * `integrationMapInputSchema`. The `filter` enum is duplicated from
 * the Zod schema in `integration-map.ts` and the `limit` upper bound
 * (`500`) is shared with the other enumeration-style tools. Drift
 * between Zod and this schema is a code-review concern.
 */
const INTEGRATION_MAP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['auth', 'sites', 'sources', 'services', 'access', 'all'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });
// NOTE: `integrationMapInputSchema` (Zod) ALSO accepts `objectApiName` / `object`
// / `objectId` / `componentId` ONLY to refuse them with an org-wide-only
// `invalid-query` (INTEGRATION-MAP-IGNORES-OBJECT-SCOPE); they are deliberately
// NOT advertised here because they are never a valid scope for this org-wide map.

/**
 * Concrete JSON Schema for `sfi.event_subscribers`. Mirrors
 * `eventSubscribersInputSchema`. The `eventId` suffix constraint
 * (`__e` Platform Event canonical form) is not expressible in JSON
 * Schema, so callers that supply a non-Platform-Event id will be
 * rejected at the handler's `validateEventId` step with
 * `error.kind: 'invalid-query'` rather than at advertised-schema
 * validation. Drift between Zod and this schema is a code-review
 * concern.
 */
const EVENT_SUBSCRIBERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      eventId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.lookup_record`. Mirrors
 * `lookupRecordInputSchema`. The `recordId` prefix constraint
 * (must start with `CustomMetadataRecord:` or `CustomSettingRecord:`)
 * is not expressible in JSON Schema, so callers that supply a non-
 * record id will be rejected at the handler's `classifyRecordId`
 * step with `error.kind: 'invalid-query'` rather than at advertised-
 * schema validation. Drift between Zod and this schema is a code-
 * review concern.
 */
const LOOKUP_RECORD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      recordId: { type: 'string', minLength: 1 },
    },
    required: ['recordId'],
  });

/**
 * Concrete JSON Schema for `sfi.guidance`. Mirrors `guidanceInputSchema`.
 * `topic` is optional — omit to list available knowledge topics.
 */
const GUIDANCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    topic: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.explain_field`. Mirrors
 * `explainFieldInputSchema`. The `fieldId` prefix constraint (must
 * start with `CustomField:`) is not expressible in JSON Schema, so
 * callers that supply a non-CustomField id will be rejected at the
 * handler boundary with `error.kind: 'invalid-query'` rather than at
 * advertised-schema validation. `includeRecordValues` is optional;
 * the handler defaults to true for `__mdt` parents and false
 * otherwise. Drift between Zod and this schema is a code-review
 * concern.
 */
const EXPLAIN_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      includeRecordValues: { type: 'boolean' },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.safe_to_delete_field`. Mirrors
 * `safeToDeleteFieldInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema,
 * so callers that supply a non-CustomField id will be rejected at the
 * handler boundary with `error.kind: 'invalid-query'` rather than at
 * advertised-schema validation. Drift between Zod and this schema is
 * a code-review concern.
 */
const SAFE_TO_DELETE_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      // Finding #35: 'proposal' emits a LOCAL destructiveChanges.xml for the field.
      format: { type: 'string', enum: ['json', 'checklist', 'proposal'] },
      // CR-CAP-L5: opt-in live population cross-check on a `safe` verdict.
      liveEnabled: { type: 'boolean' },
      orgAlias: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.unused_components`. Mirrors
 * `unusedComponentsInputSchema`. The `limit` upper bound (`500`) and
 * the `types` enum are duplicated from the Zod schema in
 * `unused-components.ts`; drift between Zod and this schema is a
 * code-review concern. The enum mirrors the contracts `ComponentType`
 * union — the same superset `LIST_COMPONENTS_INPUT_SCHEMA` uses — so
 * the tool stays usable across every node type the v1.x vault holds.
 */
const UNUSED_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'CustomObject',
            'CustomField',
            'ValidationRule',
            'Flow',
            'ApexClass',
            'ApexTrigger',
            'Layout',
            'Profile',
            'PermissionSet',
            'PermissionSetAssignment',
            'NamedCredential',
            'ConnectedApp',
            'Group',
            'Queue',
            'Role',
            'SharingRule',
            'RecordType',
            'BusinessProcess',
            'CustomTab',
            'CustomApplication',
            'QuickAction',
            'PathAssistant',
            'GlobalValueSet',
            'CustomLabel',
            'StaticResource',
            'WorkflowRule',
            'ApprovalProcess',
            'AssignmentRule',
            'AutoResponseRule',
            'EscalationRule',
            'DuplicateRule',
            'MatchingRule',
            'EmailTemplate',
            'Letterhead',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
            'AuthProvider',
            'RemoteSiteSetting',
            'CspTrustedSite',
            'ExternalDataSource',
            'ExternalService',
            'NetworkAccess',
            'CustomMetadataRecord',
            'CustomSettingRecord',
            // v4.x — decomposed object-child metadata (button/link placement).
            'WebLink',
            // v2.0a — conditional-context tier.
            'ConditionalContext',
            // v2.8 — async + integration deep tier.
            'OutboundMessage',
          ],
        },
      },
      // Singular type alias — folded into a one-element `types` scope; an
      // unknown value is invalid-query, never a silent default-family fallback.
      type: { type: 'string', minLength: 1 },
      componentType: { type: 'string', minLength: 1 },
      typeFilter: { type: 'string', minLength: 1 },
      // Object scope — narrow the scan to that object's children.
      object: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.diff_snapshots`. Mirrors
 * `diffSnapshotsInputSchema`. The `limit` upper bound (`500`) and
 * the `'current'` sentinel for `toLabel` are duplicated from the Zod
 * schema in `diff-snapshots.ts`; drift between Zod and this schema is
 * a code-review concern. JSON Schema cannot express the
 * "must name a persisted snapshot OR equal 'current'" constraint —
 * callers that pass an unknown label surface as `invalid-query` at
 * the handler boundary rather than at advertised-schema validation.
 */
const DIFF_SNAPSHOTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // STEP-2: both labels OPTIONAL — omit to auto-diff the latest two snapshots.
      fromLabel: { type: 'string', minLength: 1 },
      toLabel: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
      // STEP-2: 'summary' mode adds the compact churn digest (folded-in churn).
      summary: { type: 'boolean' },
    },
  });

/**
 * Concrete JSON Schema for `sfi.compare_components`. Mirrors
 * `compareComponentsInputSchema`. Both ids are required non-empty
 * strings; the cross-type comparison case (`typesMatch: false`) is
 * intentionally allowed at the schema level so admins can ask
 * "Profile X vs PermissionSet Y" without a workaround. Unknown ids
 * surface as `component-not-found` at the handler boundary.
 */
const COMPARE_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      idA: { type: 'string', minLength: 1 },
      idB: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['json', 'ps-diff'] },
    },
    required: ['idA', 'idB'],
  });

/**
 * Concrete JSON Schema for `sfi.pii_inventory`. Mirrors
 * `piiInventoryInputSchema`. The `classification` and `category`
 * enums (including the `'all'` sentinel that means "no filter") are
 * duplicated from the Zod schema in `pii-inventory.ts`; drift between
 * Zod and this schema is a code-review concern. The `limit` upper
 * bound (`500`) is shared with the other enumeration-style tools.
 * `format` (R6-21) is an optional `'json'` (default) / `'csv'` enum.
 */
const PII_INVENTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      classification: {
        type: 'string',
        enum: ['pii', 'sensitive', 'protected', 'all'],
      },
      category: {
        type: 'string',
        enum: [
          'identifier',
          'contact',
          'financial',
          'health',
          'protected-class',
          'all',
        ],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
      // R6-21: 'csv' returns `csv` (rows serialized as CSV) instead of `fields`.
      format: { type: 'string', enum: ['json', 'csv'] },
    },
  });

/**
 * Concrete JSON Schema for `sfi.history_tracking_gaps`. Mirrors
 * `historyTrackingGapsInputSchema` in `history-tracking-gaps.ts`. Same
 * `objectId`/`objectApiName` alias + CR-22 pagination shape as `pii_inventory`.
 */
const HISTORY_TRACKING_GAPS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_access_audit`. Mirrors
 * `fieldAccessAuditInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema,
 * so callers that supply a non-CustomField id are rejected at the
 * handler boundary with `error.kind: 'invalid-query'`. The
 * `permissionType` enum is duplicated from the Zod schema in
 * `field-access-audit.ts`; drift between Zod and this schema is a
 * code-review concern.
 */
const FIELD_ACCESS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      permissionType: {
        type: 'string',
        enum: ['read', 'edit', 'all'],
      },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.object_access_audit`. Mirrors
 * `objectAccessAuditInputSchema`. The `CustomObject:` prefix constraint is
 * enforced at the handler boundary (`invalid-query`), not expressible here.
 */
const OBJECT_ACCESS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.recordtype_availability`. Mirrors
 * `recordtypeAvailabilityInputSchema`. The Profile:/PermissionSet: prefix
 * constraint is enforced at the handler boundary (`invalid-query`).
 */
const RECORDTYPE_AVAILABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // The Profile / PermissionSet visibility SUBJECT — pass any one selector.
      componentId: { type: 'string', minLength: 1 },
      profileApiName: { type: 'string', minLength: 1 },
      profileId: { type: 'string', minLength: 1 },
      profileName: { type: 'string', minLength: 1 },
      permissionSetApiName: { type: 'string', minLength: 1 },
      permissionSetId: { type: 'string', minLength: 1 },
      // Optional OBJECT filter — "record types on <object> for <profile>?".
      objectApiName: { type: 'string', minLength: 1 },
      object: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_360` (v3.0 R4). Mirrors
 * `field360InputSchema`. The `fieldId` accepts either canonical
 * `CustomField:Object.Field` or short `Object.Field` form (the
 * handler normalises); non-matching shapes surface as
 * `invalid-query`. `includeSections` enum mirrors the ten content
 * sections defined in PLAN-v3.0 §4; `maxRowsPerSection` upper bound
 * (`200`) is the Q165 hard cap. Drift between Zod and this schema is
 * a code-review concern.
 */
const FIELD_360_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      includeSections: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'validates',
            'formulas',
            'writers',
            'readers',
            'ui',
            'integrations',
            'automations',
            'emails',
            'dependencies',
            'summary',
          ],
        },
      },
      groupBy: {
        type: 'string',
        enum: ['source', 'edge-type', 'confidence'],
      },
      maxRowsPerSection: { type: 'integer', minimum: 1, maximum: 200 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.field_lineage` (v3.0 R5). Mirrors
 * `fieldLineageInputSchema`. The `direction` enum mirrors the three
 * walk modes; `maxDepth` bounds (`[1, 5]`) duplicate the cap shared
 * with `sfi.call_graph`. `includeFieldsOfTruth` / `includeFiresWhen`
 * default to true at the handler. Drift between Zod and this schema is
 * a code-review concern.
 */
const FIELD_LINEAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      direction: {
        type: 'string',
        enum: ['upstream', 'downstream', 'both'],
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      includeFieldsOfTruth: { type: 'boolean' },
      includeFiresWhen: { type: 'boolean' },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.org_overview`. The tool takes no
 * arguments; the schema mirrors the empty `z.object({})` validator
 * declared in the tool's own module. Declared as a named constant so
 * the `tools/list` payload stays symmetric with the other tools and
 * Zod-vs-advertised drift remains a code-review concern.
 */
const ORG_OVERVIEW_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.domain_clusters`. Mirrors
 * `domainClustersInputSchema`. The `minDensity` bounds (`[0.0, 1.0]`)
 * and the `limit` bounds (`[1, 50]`) are duplicated from the Zod
 * schema in `domain-clusters.ts`; drift between Zod and this schema
 * is a code-review concern. `limit` is constrained to a tighter cap
 * than the enumeration-style tools (50 vs. 500) because the response
 * is a structural summary, not an enumerated list — a caller
 * rendering more than 50 suggested domains is unlikely.
 */
const DOMAIN_CLUSTERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      minDensity: { type: 'number', minimum: 0, maximum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
      // Optional SEED — "which domain owns {X}?". A canonical `Type:` id or a
      // bare api name; returns the cluster CONTAINING it (+ `appliedScope`).
      componentId: { type: 'string', minLength: 1 },
      seedComponentId: { type: 'string', minLength: 1 },
      seed: { type: 'string', minLength: 1 },
      // DOMAIN-CLUSTERS-IGNORES-OBJECTAPINAME: object identifiers honored as a
      // seed alias (resolved to a `CustomObject:` id), never silently stripped.
      objectApiName: { type: 'string', minLength: 1 },
      object: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.changed_since`. Mirrors
 * `changedSinceInputSchema`. The `since` ISO-8601 validation is
 * expressed as a non-empty string at the advertised level; the Zod
 * refine (`Date.parse(...)`) rejects non-date strings at the handler
 * boundary with `error.kind: 'invalid-query'`. The `types` enum
 * mirrors the contracts `ComponentType` union, the `limit` upper
 * bound (`500`) is the v1.7 honesty cap, and the schema is the v1.7
 * R2 freshness headline answer to the buyer-priority gap "when was
 * X modified?".
 */
const CHANGED_SINCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      since: { type: 'string', minLength: 1 },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'CustomObject',
            'CustomField',
            'ValidationRule',
            'Flow',
            'ApexClass',
            'ApexTrigger',
            'Layout',
            'Profile',
            'PermissionSet',
            'PermissionSetAssignment',
            'NamedCredential',
            'ConnectedApp',
            'Group',
            'Queue',
            'Role',
            'SharingRule',
            'RecordType',
            'BusinessProcess',
            'CustomTab',
            'CustomApplication',
            'QuickAction',
            'PathAssistant',
            'GlobalValueSet',
            'CustomLabel',
            'StaticResource',
            'WorkflowRule',
            'ApprovalProcess',
            'AssignmentRule',
            'AutoResponseRule',
            'EscalationRule',
            'DuplicateRule',
            'MatchingRule',
            'EmailTemplate',
            'Letterhead',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
            'AuthProvider',
            'RemoteSiteSetting',
            'CspTrustedSite',
            'ExternalDataSource',
            'ExternalService',
            'NetworkAccess',
            'CustomMetadataRecord',
            'CustomSettingRecord',
            // v2.8 — async + integration deep tier.
            'OutboundMessage',
          ],
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['since'],
  });

/**
 * Concrete JSON Schema for `sfi.last_modified`. Mirrors
 * `lastModifiedInputSchema`. `componentId` is a non-empty string; the
 * canonical `{Type}:{ApiName}` form is enforced downstream by the
 * graph lookup (an unknown id yields `component-not-found`, not a
 * Zod-level rejection). The v1.7 R3 per-component freshness lookup;
 * the response carries the `enriched: boolean` honesty flag and the
 * verbatim disclosure naming the CLI command to populate missing
 * fields. Drift between Zod and this schema is a code-review concern.
 */
const LAST_MODIFIED_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.what_happens_on_save`. Mirrors
 * `whatHappensOnSaveInputSchema`. The `event` enum is duplicated from
 * the Zod schema in `what-happens-on-save.ts` — the source of truth
 * for the enum lives in the Zod validator and drift between Zod and
 * this schema is a code-review concern.
 */
const WHAT_HAPPENS_ON_SAVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      event: {
        type: 'string',
        enum: ['insert', 'update', 'upsert', 'delete', 'undelete'],
      },
      recordTypeId: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName', 'event'],
  });

/**
 * Concrete JSON Schema for `sfi.why_field_changed`. Mirrors
 * `whyFieldChangedInputSchema`. The tool traces ONE field, named via any of the
 * interchangeable identifiers (`fieldId`, a `CustomField:`/`CustomObject:`
 * `componentId`, or `objectApiName` + `fieldApiName`). The one-distinct-field /
 * prefix constraints are not expressible in JSON Schema, so an object-only,
 * mis-prefixed, or disagreeing scope is rejected at the handler boundary with
 * `error.kind: 'invalid-query'`; unknown but well-formed ids surface as
 * `component-not-found`. The "at least one identifier" refine is likewise
 * handler-enforced. Drift between Zod and this schema is a code-review concern.
 */
const WHY_FIELD_CHANGED_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.order_of_execution`. Mirrors
 * `orderOfExecutionInputSchema`. The schema takes a single
 * `objectApiName` (non-empty string); the tool emits a per-event
 * tree over the four supported DML events (insert / update / delete
 * / undelete; upsert is excluded as a client-side composition of
 * insert + update).
 */
const ORDER_OF_EXECUTION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.explain_flow`. Mirrors
 * `explainFlowInputSchema`. The Flow is interchangeable across `flowId` /
 * `componentId` (`Flow:X`) / `apiName` (a bare flow name, coerced); pass exactly
 * one, disagreeing selectors → `invalid-query`
 * (EXPLAIN-FLOW-REJECTS-COMPONENTID). The `Flow:` prefix constraint is not
 * expressible in JSON Schema, so callers that supply a non-Flow id are rejected
 * at the handler boundary with `error.kind: 'invalid-query'`. Drift between Zod
 * and this schema is a code-review concern.
 */
const EXPLAIN_FLOW_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      flowId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.flow_graph`. Mirrors `flowGraphInputSchema`
 * (flow-graph.ts). `flowRef` accepts a canonical `Flow:{ApiName}` id, a bare
 * Flow API name, or a Flow record id — the shared resolver reconciles them and
 * fails closed on a record id without a Tooling-API index. `include` narrows to
 * a subset of body sections; `element` returns the subgraph for one canvas
 * element. Drift between this schema and the Zod schema is a code-review concern.
 */
const FLOW_GRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      flowRef: { type: 'string', minLength: 1 },
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'connectors',
            'decisions',
            'assignments',
            'recordOps',
            'formulas',
            'variables',
            'loops',
            'actions',
          ],
        },
      },
      element: { type: 'string', minLength: 1 },
    },
    required: ['flowRef'],
  });

/**
 * Concrete JSON Schema for `sfi.flow_bulkification_audit`. Mirrors
 * `flowBulkificationAuditInputSchema` (flow-bulkification-audit.ts). `limit`
 * caps the FLOW-level slice (max 500, default 100); `offset` pages the flow list
 * forward. Drift between this schema and the Zod schema is a code-review concern.
 */
const FLOW_BULKIFICATION_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.nonselective_soql`. Mirrors
 * `nonselectiveSoqlInputSchema` (nonselective-soql.ts): an optional `limit`
 * (1..200, default 50 in the handler) and `offset` (>= 0), both paging the
 * flagged-component list. Drift between this schema and the Zod schema is a
 * code-review concern.
 */
const NONSELECTIVE_SOQL_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.picklist_integrity_scan`. Mirrors
 * `picklistIntegrityScanInputSchema` (picklist-integrity-scan.ts): an optional
 * `limit` (1..500, default 50 in the handler) and `offset` (>= 0), both paging
 * the FIELDS-with-findings list. Drift between this schema and the Zod schema is
 * a code-review concern.
 */
const PICKLIST_INTEGRITY_SCAN_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.flow_trace`. Mirrors `flowTraceInputSchema`
 * (flow-trace.ts). `flowRef` accepts a canonical `Flow:{ApiName}` id, a bare
 * Flow API name, or a Flow record id (the shared resolver reconciles them and
 * fails closed on a record id without a Tooling-API index). `recordState` is the
 * starting field-value map; `priorState` is the optional `$Record__Prior` map for
 * `ISCHANGED` / `PRIORVALUE`; `maxSteps` guards loops/cycles (default 500, hard
 * cap 100000 mirroring the Zod `.max(100000)` so the guard can't be de-fanged).
 * Drift between this schema and the Zod schema is a code-review concern.
 */
const FLOW_TRACE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    flowRef: { type: 'string', minLength: 1 },
    recordState: { type: 'object' },
    priorState: { type: 'object' },
    maxSteps: { type: 'integer', minimum: 1, maximum: 100000 },
  },
  required: ['flowRef', 'recordState'],
});

/**
 * Concrete JSON Schema for `sfi.explain_apex_method`. Mirrors
 * `explainApexMethodInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query` at the handler boundary. `methodName` is carried
 * verbatim into the response — v2.0f does NOT subset by method (the
 * method-level narrative is deferred to v2.7).
 */
const EXPLAIN_APEX_METHOD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      methodName: { type: 'string', minLength: 1 },
    },
    required: ['classApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.explain_formula`. Mirrors
 * `explainFormulaInputSchema`. The caller must supply EITHER
 * `formulaExpression` (an inline formula string) OR `fieldId` (a
 * canonical CustomField id such as `CustomField:Account.AnnualRevenue__c`).
 * When `fieldId` is supplied the handler resolves the field from the vault
 * graph, extracts its formula expression, and runs the explain logic on it.
 * `parentObjectApiName` is optional and scopes single-segment field
 * references to `CustomField:{parent}.{ref}`; when `fieldId` is used it
 * defaults to the parent object inferred from the id. Invalid formulas
 * surface as a `parseError` field in the response (not an error envelope).
 */
const EXPLAIN_FORMULA_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      formulaExpression: { type: 'string', minLength: 1 },
      fieldId: { type: 'string', minLength: 1 },
      parentObjectApiName: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['json', 'vr-draft'] },
      proposedExpression: { type: 'string', minLength: 1 },
      errorMessage: { type: 'string' },
    },
  });

/**
 * Concrete JSON Schema for `sfi.export_manifest` (P8-manifest-export). Mirrors
 * `exportManifestInputSchema`: a non-empty array of canonical component ids and
 * an optional metadata API version override.
 */
const EXPORT_MANIFEST_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
      },
      apiVersion: { type: 'string', minLength: 1 },
    },
    required: ['componentIds'],
  });

/**
 * Concrete JSON Schema for `sfi.unused_fields_deep`. Mirrors
 * `unusedFieldsDeepInputSchema`. The `limit` upper bound (`500`) is
 * shared with the other enumeration-style tools; the boolean
 * `excludeManagedPackage` / `excludeStandardFields` toggles default to
 * `true` at the handler. `objectId` (added FLD-01) is the primary
 * object-scope parameter; the legacy `parentObjectFilter` (bare api name)
 * remains for back-compat. `format` (R6-21) is an optional `'json'`
 * (default) / `'csv'` enum. Drift between Zod and this schema is a code-
 * review concern.
 */
const UNUSED_FIELDS_DEEP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      parentObjectFilter: { type: 'string', minLength: 1 },
      excludeManagedPackage: { type: 'boolean' },
      excludeStandardFields: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
      // CR-CAP-L5: opt-in live population cross-check on `high`-confidence fields.
      liveEnabled: { type: 'boolean' },
      orgAlias: { type: 'string', minLength: 1 },
      // R6-21: 'csv' returns `csv` (rows serialized as CSV) instead of `fields`.
      // STEP-2: 'cleanup' adds a ranked findings[] roster + report/dashboard
      // caveat (the folded-in field_cleanup_candidates MODE).
      // Finding #35: 'proposal' attaches a LOCAL destructiveChanges.xml bundle.
      format: { type: 'string', enum: ['json', 'csv', 'cleanup', 'proposal'] },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_cleanup_candidates`. Mirrors
 * `fieldCleanupCandidatesInputSchema`. Extends the generic synthesis schema
 * with optional object-scope parameters: `objectId` (canonical id or bare
 * name) and `objectApiName` (bare name synonym). Drift between Zod and this
 * schema is a code-review concern.
 */
const FIELD_CLEANUP_CANDIDATES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.process_builder_migration_candidates`.
 * Mirrors `processBuilderMigrationCandidatesInputSchema`. The `sortBy`
 * enum and `limit` upper bound are duplicated from the Zod schema;
 * drift is a code-review concern.
 */
const PROCESS_BUILDER_MIGRATION_CANDIDATES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    includeWorkflowRules: { type: 'boolean' },
    includeApprovalProcesses: { type: 'boolean' },
    activeOnly: { type: 'boolean' },
    sortBy: {
      type: 'string',
      enum: ['complexity', 'object', 'name'],
    },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
    // PROCESS-BUILDER-MIGRATION-IGNORES-OBJECT-SCOPE: object identifiers narrow
    // each list to candidates parented to that object (+ `appliedScope`),
    // never silently stripped.
    objectApiName: { type: 'string', minLength: 1 },
    object: { type: 'string', minLength: 1 },
    objectId: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.unassigned_permission_sets`. Mirrors
 * `unassignedPermissionSetsInputSchema`.
 */
const UNASSIGNED_PERMISSION_SETS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    includeManagedPackage: { type: 'boolean' },
    includeMutingPermissionSets: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.installed_package_catalog`. Mirrors
 * `installedPackageCatalogInputSchema`.
 */
const INSTALLED_PACKAGE_CATALOG_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    // INSTALLED-PACKAGE-CATALOG-IGNORES-NAMESPACEPREFIX: exact (case-insensitive)
    // namespace match; echoed as appliedScope. Omit for the full catalog.
    namespacePrefix: { type: 'string', minLength: 1 },
  },
});

/** Concrete JSON Schema for `sfi.annotations`. Mirrors `annotationsInputSchema`. */
const ANNOTATIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Narrow to one canonical component id (e.g. `CustomField:Contact.SSN__c`).',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Narrow to one annotation key.',
    },
  },
});

/** Concrete JSON Schema for `sfi.propose_annotation`. Mirrors `proposeAnnotationInputSchema`. */
const PROPOSE_ANNOTATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Canonical id of the component the proposal is about.',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Annotation key being proposed.',
    },
    value: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Proposed value (e.g. `deprecated`, `RevOps`, a glossary synonym).',
    },
    rationale: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Short reason shown to the confirming human.',
    },
  },
  required: ['componentId', 'key', 'value'],
});

/** Concrete JSON Schema for `sfi.review_annotations`. Mirrors `reviewAnnotationsInputSchema`. */
const REVIEW_ANNOTATIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Narrow to one canonical component id.',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Narrow to one annotation key.',
    },
    author: {
      type: 'string',
      minLength: 1,
      description: 'Substring match against the proposal author (e.g. `ai`).',
    },
  },
});

/** Concrete JSON Schema for `sfi.confirm_annotation`. Mirrors `confirmAnnotationInputSchema`. */
const CONFIRM_ANNOTATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Canonical id of the component whose proposal to confirm.',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Annotation key to confirm.',
    },
    author: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Confirming human recorded on the event (default `human`).',
    },
  },
  required: ['componentId', 'key'],
});

/** Concrete JSON Schema for `sfi.reject_annotation`. Mirrors `rejectAnnotationInputSchema`. */
const REJECT_ANNOTATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Canonical id of the component whose proposal to reject.',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Annotation key to reject.',
    },
    author: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Author recorded on the unset event (default `human`).',
    },
  },
  required: ['componentId', 'key'],
});

/** Concrete JSON Schema for `sfi.component_history`. Mirrors `componentHistoryInputSchema`. */
const COMPONENT_HISTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1, description: 'Canonical component id.' },
    limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max history entries (default 20).' },
    includeLatestDiff: { type: 'boolean', description: 'Include a capped unified diff of the most recent change.' },
  },
  required: ['componentId'],
});

/** Concrete JSON Schema for `sfi.component_change_attribution`. Mirrors `componentChangeAttributionInputSchema`. */
const COMPONENT_CHANGE_ATTRIBUTION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: {
        type: 'string',
        minLength: 1,
        description: 'Canonical component id (e.g. ValidationRule:Account.Status_Required).',
      },
      objectApiName: {
        type: 'string',
        minLength: 1,
        description: 'Object API name to correlate against (e.g. Account) when not using componentId.',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        description: 'Max matched SetupAuditTrail rows to return (default 50).',
      },
    },
  });

/** Concrete JSON Schema for `sfi.component_as_of`. Mirrors `componentAsOfInputSchema`. */
const COMPONENT_AS_OF_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1, description: 'Canonical component id.' },
    ref: { type: 'string', minLength: 1, description: 'Git ref in the vault repo (commit hash, HEAD~2, tag).' },
  },
  required: ['componentId', 'ref'],
});

/**
 * Concrete JSON Schema for `sfi.find_component_usages`. Mirrors
 * `findComponentUsagesInputSchema`.
 */
const FIND_COMPONENT_USAGES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    includeGrep: { type: 'boolean' },
    grepLimit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.empty_queues_and_groups`. Mirrors
 * `emptyQueuesAndGroupsInputSchema`.
 */
const EMPTY_QUEUES_AND_GROUPS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['Queue', 'Group', 'both'] },
    // EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS: case-insensitive substring
    // over apiName/label; echoed as appliedScope. Omit for the full inventory.
    nameContains: { type: 'string', minLength: 1 },
    includeManagedPackage: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.tech_debt_score`. Mirrors
 * `techDebtScoreInputSchema`. The score categories enum and weight
 * bounds are duplicated from the Zod schema; drift is a code-review
 * concern.
 */
const TECH_DEBT_SCORE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      excludeCategories: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'deadWeight',
            'legacyAutomation',
            'codeQuality',
            'freshness',
            'apiVersions',
            'unassignedGrants',
          ],
        },
      },
      weights: {
        type: 'object',
        properties: {
          deadWeight: { type: 'number', minimum: 0, maximum: 1 },
          legacyAutomation: { type: 'number', minimum: 0, maximum: 1 },
          codeQuality: { type: 'number', minimum: 0, maximum: 1 },
          freshness: { type: 'number', minimum: 0, maximum: 1 },
          apiVersions: { type: 'number', minimum: 0, maximum: 1 },
          unassignedGrants: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  });
// NOTE: `techDebtScoreInputSchema` (Zod) ALSO accepts `objectApiName` / `object`
// / `objectId` / `componentId` ONLY to refuse them with an org-wide-only
// `invalid-query` (TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE); they are deliberately
// NOT advertised here because they are never a valid scope for this org-wide score.

/**
 * Concrete JSON Schema for `sfi.code_quality_audit`. Mirrors
 * `codeQualityAuditInputSchema`. The `severityFilter` enum mirrors the
 * v2.1 five-tier scale plus the `'all'` sentinel; the `ruleFilter`
 * array of rule ids is open-ended (the v2.1 catalog ships 15 rules but
 * future recognizer additions append without contract changes). The
 * `limit` upper bound (`500`) is shared with the enumeration-style
 * tools. Drift between Zod and this schema is a code-review concern.
 */
const CODE_QUALITY_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // Optional CLASS SCOPE: audit ONLY that ApexClass / ApexTrigger + echo
      // appliedScope. `componentId` is an `ApexClass:`/`ApexTrigger:` id;
      // `classApiName` / `apiName` are bare class-name aliases. Omit for org-wide.
      componentId: { type: 'string', minLength: 1 },
      classApiName: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
      severityFilter: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low', 'info', 'all'],
      },
      ruleFilter: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.governor_limit_risks`. Mirrors
 * `governorLimitRisksInputSchema`. The `limit` upper bound (`500`) is
 * the shared enumeration-style cap; the slice is over classes, not
 * findings. Drift between Zod and this schema is a code-review
 * concern.
 */
const GOVERNOR_LIMIT_RISKS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.find_hardcoded_values`. Mirrors
 * `findHardcodedValuesInputSchema`. The `category` enum mirrors the
 * four hardcoded-literal rule categories (`id` / `email` / `username`
 * / `sandbox-data`); omitted means all four. Drift between Zod and
 * this schema is a code-review concern.
 */
const FIND_HARDCODED_VALUES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['id', 'email', 'username', 'url', 'sandbox-data'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.crud_fls_audit`. Mirrors
 * `crudFlsAuditInputSchema`. The `limit` upper bound (`500`) is the
 * shared enumeration-style cap; the slice is over classes, not
 * findings. Drift between Zod and this schema is a code-review
 * concern.
 */
const CRUD_FLS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // Optional CLASS SCOPE (interchangeable): audit ONLY that class + echo
      // appliedScope. Omit all three for the org-wide audit.
      componentId: { type: 'string', minLength: 1 },
      classApiName: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.test_coverage_gaps`. Mirrors
 * `testCoverageGapsInputSchema`. The optional `classFilter` array is
 * capped at 500 items; absent means "scan every non-test ApexClass".
 * Drift between Zod and this schema is a code-review concern.
 */
const TEST_COVERAGE_GAPS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classFilter: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 500,
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.what_if_change_field_value`. Mirrors
 * `whatIfChangeFieldValueInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) surfaces as `invalid-query` at the
 * handler boundary; `newValue` is an optional targeted-check hint.
 */
const WHAT_IF_CHANGE_FIELD_VALUE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      newValue: { type: 'string' },
    },
    required: ['fieldId'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.value_change_audit`. Mirrors
 * `valueChangeAuditInputSchema`. `fields` omitted → auto-detect the
 * value-sensitive fields on `object`.
 */
const VALUE_CHANGE_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      object: { type: 'string', minLength: 1 },
      // Interchangeable object selector; a `fieldId` (`CustomField:Object.Field`)
      // also names the object via its parent. `object` is therefore not
      // `required` — the handler returns `invalid-query` when none names one.
      objectApiName: { type: 'string', minLength: 1 },
      fieldId: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
      fields: { type: 'array', items: { type: 'string' } },
      verbosity: { type: 'string', enum: ['summary', 'detail'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.what_if_change_field_type`. Mirrors
 * `whatIfChangeFieldTypeInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. The `newType` enum mirrors the v2.3 field-type matrix in
 * `WhatIfSemantics.md` § "Field-type compatibility matrix"; drift
 * between Zod and this schema is a code-review concern.
 */
const WHAT_IF_CHANGE_FIELD_TYPE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      newType: {
        type: 'string',
        enum: [
          'Text',
          'LongTextArea',
          'Number',
          'Currency',
          'Percent',
          'Date',
          'DateTime',
          'Time',
          'Email',
          'Url',
          'Phone',
          'Picklist',
          'MultiselectPicklist',
          'Checkbox',
          'Lookup',
          'MasterDetail',
          'TextArea',
          'EncryptedText',
        ],
      },
    },
    required: ['fieldId', 'newType'],
  });

/**
 * Concrete JSON Schema for `sfi.what_if_remove_picklist_value`. Mirrors
 * `whatIfRemovePicklistValueInputSchema`. The `fieldId` prefix
 * constraint AND the Picklist / MultiselectPicklist type constraint are
 * not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_REMOVE_PICKLIST_VALUE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    value: { type: 'string', minLength: 1 },
  },
  required: ['fieldId', 'value'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_make_field_required`. Mirrors
 * `whatIfMakeFieldRequiredInputSchema`. The `fieldId` prefix constraint
 * is not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_MAKE_FIELD_REQUIRED_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['fieldId'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_deactivate_flow`. Mirrors
 * `whatIfDeactivateFlowInputSchema`. The `flowId` prefix constraint
 * (must start with `Flow:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. Drift between Zod and this schema is a code-review concern.
 */
const WHAT_IF_DEACTIVATE_FLOW_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    // The Flow to analyse — interchangeable selectors (a host naturally passes
    // componentId: Flow:… as on get_impact); at least one is required.
    flowId: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    flowApiName: { type: 'string', minLength: 1 },
    apiName: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.what_if_disable_trigger`. Mirrors
 * `whatIfDisableTriggerInputSchema`. The `triggerId` prefix constraint
 * (must start with `ApexTrigger:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. Drift between Zod and this schema is a code-review concern.
 */
const WHAT_IF_DISABLE_TRIGGER_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    triggerId: { type: 'string', minLength: 1 },
  },
  required: ['triggerId'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_change_method_signature`.
 * Mirrors `whatIfChangeMethodSignatureInputSchema`. The `classApiName`
 * prefix constraint (must start with `ApexClass:`) is not expressible
 * in JSON Schema; non-matching prefixes surface as `invalid-query` at
 * the handler boundary. The `newSignature` parameter is optional — when
 * present the tool echoes it verbatim into the response so the renderer
 * can produce before/after output. Drift between Zod and this schema
 * is a code-review concern.
 */
const WHAT_IF_CHANGE_METHOD_SIGNATURE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    // The target Apex class — interchangeable: a bare name or an `ApexClass:` id
    // via `classApiName`, `componentId`, or `apiName` (resolved + echoed as
    // `appliedScope`). Pass exactly one; disagreeing selectors → `invalid-query`.
    classApiName: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    apiName: { type: 'string', minLength: 1 },
    methodName: { type: 'string', minLength: 1 },
    newSignature: { type: 'string' },
  },
  required: ['methodName'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_merge_profiles`. Mirrors
 * `whatIfMergeProfilesInputSchema`. The `Profile:` prefix constraint
 * is not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_MERGE_PROFILES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileIdA: { type: 'string', minLength: 1 },
    profileIdB: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
    // Finding #35: 'proposal' attaches a LOCAL package.xml pulling both profiles.
    format: { type: 'string', enum: ['json', 'proposal'] },
  },
  required: ['profileIdA', 'profileIdB'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_split_profile`. Mirrors
 * `whatIfSplitProfileInputSchema`. The `Profile:` / `PermissionSet:`
 * prefix constraints and the "targets must be PermissionSet" check are
 * not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. The `targetPermSets` array
 * is required to carry at least one entry — the Zod validator enforces
 * this, and the advertised schema mirrors the constraint via
 * `minItems: 1`.
 */
const WHAT_IF_SPLIT_PROFILE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileId: { type: 'string', minLength: 1 },
    targetPermSets: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['profileId', 'targetPermSets'],
});

/**
 * Concrete JSON Schema shared by `sfi.what_if_assign_permset` and
 * `sfi.what_if_revoke_permset`. Mirrors `whatIfPermsetInputSchema`. The
 * `PermissionSet:` / `PermissionSetGroup:` (target) and `Profile:` (baseline)
 * prefix constraints are not expressible in JSON Schema; non-matching ids
 * surface as `invalid-query` at the handler boundary.
 */
const WHAT_IF_PERMSET_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    permissionSetId: { type: 'string', minLength: 1 },
    baseline: {
      type: 'object',
      properties: {
        profileId: { type: 'string', minLength: 1 },
        permissionSetIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['permissionSetId'],
});

/**
 * Concrete JSON Schema for `sfi.generate_data_dictionary`. Mirrors
 * `generateDataDictionaryInputSchema`. The `objectId` prefix constraint
 * (must start with `CustomObject:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. `format` (R6-21) is an optional `'markdown'` (default) /
 * `'csv'` enum, mirroring `generate_architecture_overview`'s `format`
 * plumbing. Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_DATA_DICTIONARY_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectId: { type: 'string', minLength: 1 },
    format: { type: 'string', enum: ['markdown', 'csv'] },
  },
  required: ['objectId'],
});

/**
 * Concrete JSON Schema for `sfi.generate_admin_handbook`. Mirrors
 * `generateAdminHandbookInputSchema`. The `personaFocus` enum mirrors
 * the four persona values; omitted defaults to `'admin'` at the
 * handler. Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_ADMIN_HANDBOOK_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    personaFocus: {
      type: 'string',
      enum: ['admin', 'architect', 'business-user', 'developer'],
    },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_architecture_overview`. Mirrors
 * `generateArchitectureOverviewInputSchema`: an optional `format`
 * (`'markdown'` default, or `'html'` for a self-contained HTML export).
 * Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_ARCHITECTURE_OVERVIEW_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['markdown', 'html'] },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_sharing_summary`. Mirrors
 * `generateSharingSummaryInputSchema`. `objectFilter` is an optional
 * non-empty string (the api name of a single CustomObject); omitting
 * it scans every extracted object. Drift between Zod and this schema
 * is a code-review concern.
 */
const GENERATE_SHARING_SUMMARY_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectFilter: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_compliance_report`. The tool
 * takes no arguments; the schema mirrors the empty `z.object({})`
 * validator declared in the tool's own module.
 */
const GENERATE_COMPLIANCE_REPORT_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.generate_onboarding_doc`. Mirrors
 * `generateOnboardingDocInputSchema`. The `personaFocus` enum mirrors
 * the two persona values the v2.5 onboarding-doc generator supports
 * (`'admin' | 'developer'`); omitted defaults to `'admin'` at the
 * handler.
 */
const GENERATE_ONBOARDING_DOC_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    personaFocus: {
      type: 'string',
      enum: ['admin', 'developer'],
    },
  },
});

/**
 * Concrete JSON Schema for `sfi.call_graph`. Mirrors
 * `callGraphInputSchema`. The `rootId` prefix constraint (must start
 * with `ApexClass:` or `ApexTrigger:`) is not expressible in JSON
 * Schema; non-matching prefixes surface as `invalid-query` at the
 * handler boundary. The `direction` enum mirrors the three walk
 * modes and is optional (defaults to `'both'` at the handler); `maxDepth`
 * bounds (`[1, 5]`) are duplicated from the Zod schema in `call-graph.ts`.
 * Drift between Zod and this schema is a code-review concern.
 */
const CALL_GRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      rootId: { type: 'string', minLength: 1 },
      direction: {
        type: 'string',
        enum: ['downstream', 'upstream', 'both'],
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      method: { type: 'string', minLength: 1 },
    },
    required: ['rootId'],
  });

/**
 * Concrete JSON Schema for `sfi.downstream_effects`. Mirrors
 * `downstreamEffectsInputSchema`. The `classApiName` prefix constraint
 * (must start with `ApexClass:`, `ApexTrigger:`, or `CustomObject:`) is
 * not expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query` at the handler boundary. `maxDepth` bounds (`[1, 5]`)
 * match the `call_graph` cap. Drift between Zod and this schema is a
 * code-review concern.
 */
const DOWNSTREAM_EFFECTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      method: { type: 'string', minLength: 1 },
    },
    required: ['classApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.interpret` (RM-wire). Mirrors
 * `interpretInputSchema`. `componentId` is any canonical id; `concepts` /
 * `ruleIds` are optional ADDITIVE filters over the curated `CONCEPT_RULES`
 * (an empty array matches no rule). Drift between Zod and this schema is a
 * code-review concern.
 */
const INTERPRET_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    concepts: { type: 'array', items: { type: 'string' } },
    ruleIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.test_coverage_for_method`. Mirrors
 * `testCoverageForMethodInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query`. `methodName` is optional and echoed verbatim into
 * the response — v2.7 does NOT subset coverage by method (deferred to
 * v2.7.1). Drift between Zod and this schema is a code-review concern.
 */
const TEST_COVERAGE_FOR_METHOD_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    // The target class / trigger — interchangeable selectors (a host naturally
    // passes componentId as on sibling Apex tools); at least one is required.
    classApiName: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    apiName: { type: 'string', minLength: 1 },
    methodName: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.meaningful_test_audit`. Mirrors
 * `meaningfulTestAuditInputSchema`. The optional `classFilter` array
 * is capped at 500 items; `targetClass` (+ its `componentId` / `classApiName`
 * host aliases) scopes to a production class's covering tests; `nameContains`
 * scopes by a case-insensitive test-class name substring. Absent means "audit
 * every test ApexClass". Drift between Zod and this schema is a code-review
 * concern.
 */
const MEANINGFUL_TEST_AUDIT_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    classFilter: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: 500,
    },
    targetClass: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    classApiName: { type: 'string', minLength: 1 },
    nameContains: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.method_reachability`. Mirrors
 * `methodReachabilityInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query`. Drift between Zod and this schema is a code-review
 * concern.
 */
const METHOD_REACHABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // The target ApexClass / ApexTrigger — interchangeable: a bare name or an
      // `ApexClass:` / `ApexTrigger:` id via `classApiName`, `componentId`, or
      // `apiName` (resolved + echoed as `appliedScope`). Pass exactly one;
      // disagreeing selectors → `invalid-query`.
      classApiName: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.tests_for_change`. Mirrors
 * `testsForChangeInputSchema`. Each `changedComponents` item is an
 * `ApexClass:` / `ApexTrigger:` id or a bare class name, OR a
 * `review_change`-shaped selector object (`{ componentId }` / `{ type, apiName }`,
 * plus an ignored `changeKind`); non-Apex `Type:` prefixes bucket into
 * `unsupportedChanges` rather than failing the call. A single component may
 * instead be passed as a TOP-LEVEL `componentId` / `{ type, apiName }` (folded
 * into a one-item set), so `changedComponents` is not strictly required. The
 * 1..500 array bound matches `meaningful_test_audit`'s `classFilter`. Drift
 * between Zod and this schema is a code-review concern.
 */
const TESTS_FOR_CHANGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      changedComponents: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string', minLength: 1 },
            {
              type: 'object',
              properties: {
                componentId: { type: 'string', minLength: 1 },
                type: { type: 'string', minLength: 1 },
                apiName: { type: 'string', minLength: 1 },
                changeKind: { type: 'string', minLength: 1 },
              },
            },
          ],
        },
        minItems: 1,
        maxItems: 500,
      },
      componentId: { type: 'string', minLength: 1 },
      type: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.review_change`. Mirrors
 * `reviewChangeInputSchema`. `components` is a 1..500 change set; each item
 * carries `changeKind` ∈ added|modified|deleted plus its selector — EITHER the
 * `{ type, apiName }` pair OR a single `componentId` (`Type:ApiName`, the
 * canonical id from `sfi.resolve`) — normalised to the analysed id
 * `${type}:${apiName}`. `limit` caps the DETAILED
 * `reviewed[]` rows (summary tallies stay full; the deploy-gate verdict is never
 * hidden by the cap). `againstVault` (a registered vault alias OR a path to an
 * org-kb) reviews the changeset against THAT vault's graph instead of the
 * current one. `checkAccessParity` (default false) adds the ADDITIVE
 * `accessParity` grant-completeness ("ships for nobody") section. Drift between
 * Zod and this schema is a code-review concern.
 */
const REVIEW_CHANGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      components: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', minLength: 1 },
            apiName: { type: 'string', minLength: 1 },
            componentId: { type: 'string', minLength: 1 },
            changeKind: { type: 'string', enum: ['added', 'modified', 'deleted'] },
          },
          required: ['changeKind'],
          anyOf: [
            { required: ['type', 'apiName'] },
            { required: ['componentId'] },
          ],
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      againstVault: { type: 'string', minLength: 1 },
      checkAccessParity: { type: 'boolean' },
    },
    required: ['components'],
  });

/**
 * Concrete JSON Schema for `sfi.package_impact`. Mirrors
 * `packageImpactInputSchema`. No selector → INVENTORY mode; a `namespace` (or a
 * `namespacePrefix` / `packageId` / `componentId` selector resolving to one) →
 * IMPACT mode for that managed-package namespace. `limit` caps detail/sample
 * rows. Drift between Zod and this schema is a code-review concern.
 */
const PACKAGE_IMPACT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      namespace: { type: 'string', minLength: 1 },
      namespacePrefix: { type: 'string', minLength: 1 },
      packageId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.cdc_subscribers`. Mirrors
 * `cdcSubscribersInputSchema`. The optional `sObjectFilter` is a non-
 * empty string; absent means "scan every CDC-recognizable event in
 * the graph". The CDC name-pattern recognition runs inside the
 * handler. Drift between Zod and this schema is a code-review concern.
 */
const CDC_SUBSCRIBERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      sObjectFilter: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.async_chain_depth`. Mirrors
 * `asyncChainDepthInputSchema`. The `rootApexClassId` prefix
 * constraint (must start with `ApexClass:`) is not expressible in
 * JSON Schema; non-matching prefixes surface as `invalid-query` at
 * the handler boundary. The depth cap (10 hops) is enforced inside
 * the handler. Drift between Zod and this schema is a code-review
 * concern.
 */
const ASYNC_CHAIN_DEPTH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      rootApexClassId: { type: 'string', minLength: 1 },
      rootId: { type: 'string', minLength: 1 },
    },
    minProperties: 1,
  });

/**
 * Concrete JSON Schema for `sfi.scheduled_job_catalog`. Mirrors
 * `scheduledJobCatalogInputSchema`. The optional `nameContains` narrows
 * both the Schedulable-class catalog and the scheduled-Flow section; omit
 * for the org-wide catalog. Declared as a named constant so the
 * `tools/list` payload stays symmetric with the other tools.
 */
const SCHEDULED_JOB_CATALOG_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // SCHEDULED-JOB-CATALOG-IGNORES-NAMECONTAINS: case-insensitive substring
      // over apiName; echoed as appliedScope. Omit for the org-wide catalog.
      nameContains: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.outbound_message_catalog`. Mirrors
 * `outboundMessageCatalogInputSchema`. The optional `objectFilter`
 * is a non-empty string; absent means "scan every OutboundMessage in
 * the graph". Drift between Zod and this schema is a code-review
 * concern.
 */
const OUTBOUND_MESSAGE_CATALOG_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectFilter: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.endpoint_catalog`. ORG-WIDE, no narrowing
 * scope; the object / component keys are advertised ONLY so the handler can
 * REFUSE them (ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE) instead of silently
 * answering whole-org. Mirrors `endpointCatalogInputSchema`.
 */
const ENDPOINT_CATALOG_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      object: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_meaning` (v2.9 R4). Mirrors
 * `fieldMeaningInputSchema` — `fieldId` is the required CustomField
 * canonical id. Drift between Zod and this schema is a code-review
 * concern.
 */
const FIELD_MEANING_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.disambiguate_concepts` (v2.9 R4).
 * Mirrors `disambiguateConceptsInputSchema` — `conceptA` and
 * `conceptB` are required concept tokens; `limit` is optional and
 * caps each bucket's matchingFields slice. The `200` upper bound is
 * duplicated from `disambiguate-concepts.ts` and is a code-review
 * drift concern.
 */
const DISAMBIGUATE_CONCEPTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      conceptA: { type: 'string', minLength: 1 },
      conceptB: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['conceptA', 'conceptB'],
  });

/**
 * Concrete JSON Schema for `sfi.field_provenance` (v2.9 R4). Mirrors
 * `fieldProvenanceInputSchema` — `fieldId` is the required CustomField
 * canonical id.
 */
const FIELD_PROVENANCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.find_field_anywhere` (v2.2 R2). Mirrors
 * `findFieldAnywhereInputSchema`. The CustomField id is supplied as
 * `targetId` OR its alias `fieldId` (field-tool-family parity); exactly one
 * is required and must start with `CustomField:` — a missing/empty id or a
 * non-matching prefix surfaces as `invalid-query` at the handler boundary.
 * `limit` defaults to 200 and is capped at 500. `componentTypes` filters the
 * returned references to a subset of ComponentType labels.
 */
const FIND_FIELD_ANYWHERE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      fieldId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      componentTypes: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    anyOf: [{ required: ['targetId'] }, { required: ['fieldId'] }],
  });

/**
 * Concrete JSON Schema for `sfi.find_semantic_field` (v2.2 R2). Mirrors
 * `findSemanticFieldInputSchema`. `description` is the natural-
 * language concept. `objectIds` optionally filters the candidate
 * field set. `limit` defaults to 10 and is capped at 50; `minScore`
 * defaults to 0.1. Drift between Zod and this schema is a code-review
 * concern.
 */
const FIND_SEMANTIC_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      description: { type: 'string', minLength: 1 },
      objectIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      minScore: { type: 'number', minimum: 0, maximum: 1 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['description'],
  });

/**
 * Concrete JSON Schema for `sfi.find_hardcoded_values_anywhere` (v2.2
 * R2). Mirrors `findHardcodedValuesAnywhereInputSchema`. At least one
 * of `value` / `category` must be supplied (enforced at the handler
 * boundary — JSON Schema cannot express "or"). The `scope` enum
 * narrows the corpora searched; default is all four. `limit` defaults
 * to 100 and is capped at 500.
 */
const FIND_HARDCODED_VALUES_ANYWHERE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    value: { type: 'string', minLength: 1 },
    query: { type: 'string', minLength: 1 },
    category: {
      type: 'string',
      enum: ['id', 'email', 'date', 'numeric'],
    },
    scope: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['apex', 'formula', 'validation-rule', 'workflow-rule'],
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.find_clone_patterns` (v2.2 R2). Mirrors
 * `findClonePatternsInputSchema`. `componentId` is required;
 * non-Apex / non-Flow prefixes surface as `invalid-query` at the
 * handler boundary. `limit` defaults to 10 and is capped at 50;
 * `minScore` defaults to 0.3.
 */
const FIND_CLONE_PATTERNS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: ['ApexClass', 'ApexTrigger', 'Flow'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      minScore: { type: 'number', minimum: 0, maximum: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.find_dead_code` (v2.2 R2). Mirrors
 * `findDeadCodeInputSchema`. `types` is an optional array of
 * ComponentTypes; default is `['ApexClass', 'ApexTrigger', 'Flow',
 * 'CustomField']`. `includeUncertain` defaults to false. `limit`
 * defaults to 100 and is capped at 500.
 */
const FIND_DEAD_CODE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // Optional COMPONENT scope: one component's verdict instead of the org-wide
      // top-N. `componentId` is an `ApexClass:`/`ApexTrigger:`/`Flow:`/`CustomField:`
      // id; `classApiName` / `apiName` are bare ApexClass-name aliases.
      componentId: { type: 'string', minLength: 1 },
      classApiName: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['ApexClass', 'ApexTrigger', 'Flow', 'CustomField'],
        },
      },
      includeUncertain: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.cpq_rule_chain` (v2.6a R2). Mirrors
 * `cpqRuleChainInputSchema` — `ruleId` is the required CPQ rule
 * canonical id. The prefix constraint (`CpqProductRule:` or
 * `CpqPriceRule:`) is not expressible in JSON Schema, so callers that
 * supply a non-rule id are rejected at the handler boundary with
 * `error.kind: 'invalid-query'`. Drift between Zod and this schema is
 * a code-review concern.
 */
const CPQ_RULE_CHAIN_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      ruleId: { type: 'string', minLength: 1 },
    },
    required: ['ruleId'],
  });

/**
 * Concrete JSON Schema for `sfi.cpq_quote_template_breakdown`
 * (v2.6a R2). Mirrors `cpqQuoteTemplateBreakdownInputSchema` —
 * `templateId` is the required CpqQuoteTemplate canonical id. The
 * prefix constraint (`CpqQuoteTemplate:`) is not expressible in JSON
 * Schema; callers with non-CpqQuoteTemplate ids are rejected at the
 * handler boundary. Drift between Zod and this schema is a code-review
 * concern.
 */
const CPQ_QUOTE_TEMPLATE_BREAKDOWN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    templateId: { type: 'string', minLength: 1 },
  },
  required: ['templateId'],
});

/**
 * Concrete JSON Schema for `sfi.cpq_dependency_map` (v2.6a R2).
 * Mirrors `cpqDependencyMapInputSchema` — both fields are optional.
 * When `cpqComponentId` is set, the prefix constraint (any of the five
 * CPQ-typed prefixes) is enforced at the handler boundary because JSON
 * Schema cannot express the union of prefix-string constraints. The
 * `limit` bound (max 200) is duplicated from the Zod schema; drift
 * between Zod and this schema is a code-review concern.
 */
const CPQ_DEPENDENCY_MAP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      cpqComponentId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.compare_vaults` (v3.1). Mirrors
 * `compareVaultsInputSchema`. Both alias inputs are required non-empty
 * strings. Optional `objectFilter` / `typeFilter` narrow the diff;
 * `includeVolatileProperties` toggles the v2.0c-inherited noise filter.
 */
const COMPARE_VAULTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      vaultA: { type: 'string', minLength: 1 },
      vaultB: { type: 'string', minLength: 1 },
      objectFilter: { type: 'string', minLength: 1 },
      typeFilter: { type: 'string', minLength: 1 },
      includeVolatileProperties: { type: 'boolean' },
      format: { type: 'string', enum: ['json', 'markdown'] },
    },
    required: ['vaultA', 'vaultB'],
  });

/** Concrete JSON Schema for `sfi.promotion_readiness`. Mirrors `promotionReadinessInputSchema`. */
const PROMOTION_READINESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      sandbox: { type: 'string', minLength: 1 },
      prod: { type: 'string', minLength: 1 },
      typeFilter: { type: 'string', minLength: 1 },
    },
    required: ['sandbox', 'prod'],
  });

/**
 * Concrete JSON Schema for `sfi.compare_object_across_vaults` (v3.1).
 * Mirrors `compareObjectAcrossVaultsInputSchema`.
 */
const COMPARE_OBJECT_ACROSS_VAULTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    vaultA: { type: 'string', minLength: 1 },
    vaultB: { type: 'string', minLength: 1 },
    includeVolatileProperties: { type: 'boolean' },
  },
  required: ['objectApiName', 'vaultA', 'vaultB'],
});

/**
 * Concrete JSON Schema for `sfi.compare_profile_across_vaults` (v3.1).
 * Mirrors `compareProfileAcrossVaultsInputSchema`.
 */
const COMPARE_PROFILE_ACROSS_VAULTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileName: { type: 'string', minLength: 1 },
    vaultA: { type: 'string', minLength: 1 },
    vaultB: { type: 'string', minLength: 1 },
    includeVolatileProperties: { type: 'boolean' },
  },
  required: ['profileName', 'vaultA', 'vaultB'],
});

/**
 * Concrete JSON Schema for `sfi.field_mapping_between_objects` (v3.1).
 * Mirrors `fieldMappingBetweenObjectsInputSchema`. Single-vault tool —
 * `vault` is OPTIONAL and defaults to the SERVED vault, so the normal
 * registry-less deployment works out of the box. The Q174 honesty
 * anchor surfaces the verbatim heuristic-mapping disclosure on every
 * response.
 */
const FIELD_MAPPING_BETWEEN_OBJECTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    vault: { type: 'string', minLength: 1 },
    objectA: { type: 'string', minLength: 1 },
    objectB: { type: 'string', minLength: 1 },
    similarityThreshold: { type: 'number', minimum: 0, maximum: 1 },
    includeTypeIncompatible: { type: 'boolean' },
  },
  required: ['objectA', 'objectB'],
});

/**
 * Concrete JSON Schema for `sfi.integration_procedure_chain` (v3.2 R3b).
 * Mirrors `integrationProcedureChainInputSchema`. The
 * `OmniIntegrationProcedure:` prefix constraint is not expressible
 * in JSON Schema, so callers that supply a non-IP id are rejected at
 * the handler boundary with `error.kind: 'invalid-query'`. Drift
 * between Zod and this schema is a code-review concern.
 */
const INTEGRATION_PROCEDURE_CHAIN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    integrationProcedureId: { type: 'string', minLength: 1 },
    includeChildPropertySetConfig: { type: 'boolean' },
  },
  required: ['integrationProcedureId'],
});

/**
 * Concrete JSON Schema for `sfi.omniscript_flow` (v3.2 R3). Mirrors
 * `omniscriptFlowInputSchema`. The `omniScriptId` prefix constraint
 * (must start with `OmniScript:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. `includeChildPropertySetConfig` defaults to false to keep
 * the response compact for the common-case browse use.
 */
const OMNISCRIPT_FLOW_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      omniScriptId: { type: 'string', minLength: 1 },
      includeChildPropertySetConfig: { type: 'boolean' },
    },
    required: ['omniScriptId'],
  });

/**
 * Concrete JSON Schema for `sfi.omniuicard_widget_breakdown` (v3.2
 * R3). Mirrors `omniuicardWidgetBreakdownInputSchema` — the
 * `omniUiCardId` prefix constraint (must start with `OmniUiCard:`)
 * is not expressible in JSON Schema; callers that supply a
 * non-OmniUiCard id are rejected at the handler boundary with
 * `error.kind: 'invalid-query'`. Drift between Zod and this schema
 * is a code-review concern.
 */
const OMNIUICARD_WIDGET_BREAKDOWN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    omniUiCardId: { type: 'string', minLength: 1 },
  },
  required: ['omniUiCardId'],
});

/**
 * Concrete JSON Schema for `sfi.datatransform_field_map` (v3.2). Mirrors
 * `datatransformFieldMapInputSchema`. The `dataTransformId` prefix
 * constraint (must start with `OmniDataTransform:`) is not expressible
 * in JSON Schema; callers that supply a non-OmniDataTransform id are
 * rejected at the handler boundary with `error.kind: 'invalid-query'`.
 * Drift between Zod and this schema is a code-review concern.
 */
const DATATRANSFORM_FIELD_MAP_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    dataTransformId: { type: 'string', minLength: 1 },
  },
  required: ['dataTransformId'],
});

/**
 * Concrete JSON Schema for `sfi.decision_table_browse` (v3.2). Mirrors
 * `decisionTableBrowseInputSchema`. The `decisionTableId` prefix
 * constraint (must start with `DecisionTable:`) is not expressible in
 * JSON Schema; callers that supply a non-DecisionTable id are rejected
 * at the handler boundary with `error.kind: 'invalid-query'`. Drift
 * between Zod and this schema is a code-review concern.
 */
const DECISION_TABLE_BROWSE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      decisionTableId: { type: 'string', minLength: 1 },
    },
    required: ['decisionTableId'],
  });

/**
 * The 49 tools the MCP server advertises: the original 10 from v0.1,
 * the two architect-facing semantic-edge tools added in v0.2
 * (`sfi.get_impact` and `sfi.find_formula_references`), the
 * developer-facing `sfi.find_apex_usages` added in v0.3 alongside the
 * heuristic Apex scanner, the admin-facing
 * `sfi.why_cant_user_see_record` headline tool added in v1.1 alongside
 * the sharing & visibility extractors, the v1.2 layout-routing
 * headline `sfi.layout_for_user` added alongside the record-types +
 * UI-surfaces tier, the v1.5 architect integration-topology pair
 * (`sfi.integration_map`, `sfi.event_subscribers`) added alongside the
 * integration-surface and platform-event extractors, the v1.4
 * broadened developer tool `sfi.find_code_usages` added alongside the
 * LWC/Aura/VF frontend extractors (the strict superset of
 * `sfi.find_apex_usages` that also surfaces frontend referrers and the
 * `references` edge type they emit), the v1.6 business-user
 * record-value pair (`sfi.lookup_record`, `sfi.explain_field`) added
 * alongside the CustomMetadataRecord + CustomSettingRecord extractors,
 * the v2.0b buyer-priority composition pair
 * (`sfi.safe_to_delete_field`, `sfi.unused_components`) added as pure
 * compositions over existing edges — no new extractors, no new
 * contracts, no new EdgeTypes — the v2.0c snapshot + diff pair
 * (`sfi.diff_snapshots`, `sfi.compare_components`) added alongside
 * the snapshot CLI infrastructure that answers buyer-priority #8
 * ("what changed in this org since last week?") and #10 ("compare
 * profiles / perm sets / flow versions"), the v2.0d compliance/privacy
 * pair (`sfi.pii_inventory`, `sfi.field_access_audit`) added alongside
 * the `pii-detection` pattern recognizer that answers buyer-priority
 * #5 ("which fields contain PII and who can see/export them?"), and
 * the v2.0g org-tour pair (`sfi.org_overview`, `sfi.domain_clusters`)
 * added as pure compositions over the existing graph queries to
 * answer buyer-priority #9 ("I'm new — give me a tour of this org"),
 * the v2.0e lifecycle-narrator trio
 * (`sfi.what_happens_on_save`, `sfi.why_field_changed`,
 * `sfi.order_of_execution`) added as pure compositions over the
 * v2.0a `firesWhen` ConditionalContext primitive to answer buyer-
 * priority #1 ("why did this field get updated?"), #2 ("what happens
 * when I save this record?"), and #3 ("what's the order of execution
 * for THIS object update in THIS org?"), and the v1.7 R3 per-component
 * freshness tool `sfi.last_modified` added alongside `sfi.changed_since`
 * to complete the freshness tool surface — the per-id sibling of the
 * range-scan tool, both reading the Tooling-API-enriched
 * `properties.lastModifiedDate` / `properties.lastModifiedBy` overlay
 * with backward-compat fallback to the legacy top-level fields.
 * Order is the order they appear in `tools/list` responses; clients
 * should not assume meaning from it but stability is helpful for
 * fixture-based tests. v0.2, v0.3, v1.1, v1.2, v1.4, v1.5, v1.6,
 * v2.0b, v2.0c, v2.0d, v2.0g, and v2.0e entries are appended at the
 * tail so existing fixtures keyed off the prefix continue to match.
 *
 * Per `build-mcp-tool/SKILL.md`, each tool's real input schema is
 * declared in its own `src/tools/{name}.ts` module; this list mirrors
 * those Zod validators as hand-authored JSON Schema constants above.
 *
 * The constant name remains `V01_TOOLS` to preserve the re-export from
 * `src/index.ts`; out-of-tree callers import the symbol by name.
 */
/**
 * Concrete JSON Schema for `sfi.find_dependency_cycles`. Mirrors
 * `findDependencyCyclesInputSchema` in `find-dependency-cycles.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const FIND_DEPENDENCY_CYCLES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // Optional scope: componentId narrows to the cluster containing it,
      // nameContains keeps clusters with a member id matching the substring.
      componentId: { type: 'string', minLength: 1 },
      nameContains: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.apex_test_coverage`. Mirrors
 * `apexTestCoverageInputSchema` in `apex-test-coverage.ts`; drift between Zod
 * and this schema is a code-review concern.
 */
const APEX_TEST_COVERAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      apexClass: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.automation_build_advisor`. Mirrors
 * `automationBuildAdvisorInputSchema` in `automation-build-advisor.ts`.
 */
const AUTOMATION_BUILD_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['flow-only-objects'] },
    },
    // Exactly one of objectApiName (per-object) or scope (org-wide gap).
    oneOf: [{ required: ['objectApiName'] }, { required: ['scope'] }],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.automation_collisions`. Mirrors
 * `automationCollisionsInputSchema` in `automation-collisions.ts`.
 */
const AUTOMATION_COLLISIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      object: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['object'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.ai_exposure_report`. Mirrors
 * `aiExposureReportInputSchema` in `ai-exposure-report.ts`.
 */
const AI_EXPOSURE_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.apex_build_advisor`. Mirrors
 * `apexBuildAdvisorInputSchema` in `apex-build-advisor.ts`.
 */
const APEX_BUILD_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      // Optional CLASS SCOPE: narrow the briefing to ONE ApexClass / ApexTrigger.
      // `componentId` is an `ApexClass:`/`ApexTrigger:` id; `classApiName` /
      // `apiName` are bare class-name aliases. Omit for the org-wide advisor.
      componentId: { type: 'string', minLength: 1 },
      classApiName: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.field_change_advisor`. Mirrors
 * `fieldChangeAdvisorInputSchema` in `field-change-advisor.ts`. `fieldId` is not
 * `required` because the field can also be named via the interchangeable
 * `componentId` / `fieldApiName` / `apiName` selectors (precedence `fieldId >
 * componentId > fieldApiName > apiName`); the handler returns `invalid-query`
 * when none is given. A bare `Object.Field` and a `CustomField:Object.Field` id
 * both resolve.
 */
const FIELD_CHANGE_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
      apiName: { type: 'string', minLength: 1 },
      newType: { type: 'string', minLength: 1 },
      ...LIVE_ENABLED_PROPERTY,
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.live_drift_check`. Mirrors
 * `liveDriftCheckInputSchema` in `live-drift-check.ts`.
 */
const LIVE_DRIFT_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      orgAlias: { type: 'string', minLength: 1 },
      liveEnabled: { type: 'boolean' },
    },
    required: ['objectApiName'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.org_history`. Mirrors `orgHistoryInputSchema`
 * in `org-history.ts`.
 */
const ORG_HISTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  });

const WHAT_CHANGED_SINCE_REFRESH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

const V01_TOOLS_BASE: readonly ToolDefinitionBase[] = [
  {
    name: 'sfi.search_components',
    description:
      'Free-text search across vault components. Returns ranked matches with snippet previews. Searches `api_name`, `label`, AND `properties_json` — so it finds text embedded in node properties such as ValidationRule `errorConditionFormula` or CustomField `formula`. KEY USE CASE: to find every ValidationRule whose formula contains a `$Permission.*` guard (e.g. `NOT($Permission.SkipValidation)`), call `search_components({ query: "SkipValidation", types: ["ValidationRule"] })` — the formula text is stored offline and is fully searchable without a vault refresh. Do NOT claim `$Permission.*` guards in errorConditionFormula are undetectable from metadata; the formula text is present in node properties and will surface here.',
    inputSchema: SEARCH_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.resolve',
    description:
      "Typo-tolerant resolver: messy/misspelled text -> ranked candidate components with a disposition (exact|ambiguous|none) + per-candidate evidence. Call FIRST when the user names a component informally; tolerates typos, filler, and the org's own misspellings that search_components cannot. Also the answer to informal lookup asks — 'find / look up / locate the X', 'do we have a field for tracking Y?', 'I think there's a flow called something like Z' — whenever the user only half-remembers a name or describes the thing instead of naming it. Leading/trailing schema nouns are TYPE hints, not name content: 'SSN field' scores exactly like bare 'SSN' (the noun is stripped from fuzzy matching and instead prefers candidates of the hinted type among equally-confident matches — it never floats a weak fuzzy match of that type over an exact-name match of another). A dotted 'Object.Field' query is a definitive parent-scoped hit. CONFIRMED glossary annotations act as curated synonyms (candidates marked `glossary-alias`) — an alias never shadows an exact api-name match, and a synonym shared by two components yields `ambiguous` + clarification. Heuristic; never silently picks.",
    inputSchema: RESOLVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.capabilities',
    description:
      'Product self-description: what this knowledge base can answer. Returns a categorized capability map (with example natural-language questions per area), a `personas` grouping of those categories by role (admin / developer / architect / release-manager / support — each with the relevant `categoryIds` + `questionPaths`, where every path is an operational question plus the ordered `sfi.*` tools that answer it) so you can orient a user by their job and lead with question PATHS rather than a flat tool list, the live registered-tool count, the recommended conversational pattern (call sfi.resolve first; ask a clarifying question on ambiguous; offer /sfi-refresh or stop on none), the three slash commands, the v0.1 read-only/offline boundary, and a `trustGlossary` defining every trust tag a host will see (confidence declared/parsed/heuristic, provenance offline_snapshot/live_org/hybrid, completeness complete/partial/unknown) keyed by the verbatim runtime value. Takes no arguments. Call when the user asks "what can you do / what can I ask?" or to orient a fresh session.',
    inputSchema: CAPABILITIES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_analyses',
    description:
      "Catalog gateway: the paginated index of EVERY analysis this server can run — name, one-line summary, and a coarse category (core / search / what-if / documentation / live / cross-org / industries). Use it to NAVIGATE the roster without loading every schema; then sfi.describe_analysis for one tool's full input schema, and sfi.run_analysis to execute (byte-identical output to a direct call). Optional `category` filter + `limit`/`offset` pagination.",
    inputSchema: LIST_ANALYSES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.describe_analysis',
    description:
      "Catalog gateway: ONE analysis's full description + JSON input schema, fetched on demand (`name`, with or without the `sfi.` prefix). Pair with sfi.list_analyses (find it) and sfi.run_analysis (execute it — byte-identical output to a direct call). Unknown names get an honest invalid-query pointing back at the catalog.",
    inputSchema: DESCRIBE_ANALYSIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.run_analysis',
    description:
      "Catalog gateway: execute any analysis by `name` with `args` (an object, or a JSON-encoded string of one — a known client quirk handled defensively). THIN dispatcher into the same handler table as a direct call: identical payload, byte budget, and trust block — byte-identical output. It cannot dispatch itself, and unknown names return an honest invalid-query with the catalog hint. Use after sfi.list_analyses / sfi.describe_analysis when the full roster is not advertised.",
    inputSchema: RUN_ANALYSIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.synthesize_answer',
    description:
      'Answer-layer grounding pass: turns the JSON returned by prior sfi.* tool call(s) into a structured, citation-grounded answer skeleton — `summary`, `bullets` (headline facts extracted from the input), `citations` (ONLY canonical ids present in the input, parsed to type + apiName), and `caveats` (honesty/limitation strings carried verbatim; an input reduced by the global response byte budget — a `responseBudget` truncation block — becomes an explicit caveat with the dropped/trimmed counts, so a synthesis over truncated data never reads absence as evidence). It also returns a grounded `evidence` skeleton — `finding` → `evidence` (the cited ids) → `likelyCause` → `recommendedFix` → `risk` → `nextAction` — where every field is lifted VERBATIM from the source tool output (a `reason`/`recommendation`/`nextStep`/caveat field) and is `null` when the source carried nothing for it, so the recommended action is never fabricated; `nextAction` falls back to the recommended fix, and `orphanComponentIds` flags any id mentioned inside a cause/fix/next string that is not independently cited (an ungrounded reference). Pass the source tool output as `input` (any JSON), optionally the user `question` (echoed into the summary), and optionally a `draft` narrative — when given, `hallucinatedIds` lists canonical ids in the draft that do NOT appear in the source so they can be removed before answering. A `draft` supplied with an empty or missing `input` FAILS CLOSED to `grounded: false` with a caveat — grounding is never rubber-stamped when there is no evidence to check the draft against. `provenance` rolls the source output(s) trust provenance up into `{ stamp, sources }` (`offline_snapshot` / `live_org` / `hybrid` when the input fuses both / `mixed` / `null`) so the host can stamp where the answer came from and never let a vault claim read as a live one. Pure transform: reads ONLY `input`, never the graph or live org, so it can never add a fact it was not handed. Prose wording stays with the caller; this guarantees grounding, not sentences.',
    inputSchema: SYNTHESIZE_ANSWER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.route_question',
    description: "Front-door router: for a plain-language question, surface a meaning-ranked shortlist of the sfi.* tools that can answer it — your host LLM picks which to run — plus the plane it belongs to (vault | live | hybrid | unknown), so the user never types a tool name. Read-only; it advises, it does not answer. Compound questions carry step ids and `dependsOn` edges: independent steps may run in parallel; a `then`-linked step waits for its prerequisite. On GENUINE ambiguity it fails closed with `executionBlocked`, a clarification id, and offered options; resume deterministically by calling again with the exact same question plus `clarificationResponse: { clarificationId, selection }`. Stale ids and invented selections are rejected. CLARIFICATIONS ARE A LAST RESORT (router P4): a qualifier already in the question pre-answers the menu — an object word next to a same-named field ('…saving a CASE without a Resolution_Code__c'), a type word after the name ('the X OBJECT/FLOW'), an underscored/dotted literal api name, or a component mention on a who-last-modified ask all AUTO-RESOLVE instead of blocking; a CustomTab twin of a CustomObject never counts as a rival; complementary readings (who-can-access grantors vs CRUD matrix, impact readout vs change/delete simulation on the same ask) STACK their tools in one route instead of asking which-first; a vault-vs-live candidate near-tie is decided by the question's own runtime-data language (live leads WITH the consent disclosure, vault otherwise) rather than blocking — only the DESTRUCTIVE-vs-read-only tool tie still stops execution; and offered options are HYGIENIC — fuzzy acronym-graze rivals (SSN vs {A,B,M}SN_*) and far-below-top junk never appear as options. Bare schema nouns in the question (trigger/flow/field/object/profile/permission set/record type) are INTENT vocabulary, never named-entity lookups — 'the Contact trigger' scopes a save-order question to the Contact OBJECT, it does not shop 'trigger' to the resolver; an object-qualified field ('Status__c on Case') is resolved parent-scoped; and an entity the resolver reports `exact` never raises the components-match menu — that menu is reserved for two genuinely competing components. The resolved TYPE also gates the routed tools: when the named entity resolves to a FLOW, tools that hard-error on a Flow id (call_graph / method_reachability / explain_apex_method, and the object/field access audits) are SWAPPED for the Flow-appropriate ones (who_can_run for access asks, explain_flow — which narrates the Apex the Flow invokes — plus get_impact) instead of routing into a guaranteed error. Qualifier words never outrank the HEAD question: 'bulk'/'load' on a save-order or test-coverage ask, 'seats'/'license' on a permission-set-assignment ask, and 'integration'/vendor words on a field-write / profile-security / what-if ask all stay on the head intent (never forced onto governor_limit_risks / live_license_usage / integration_map); field_lineage is reserved for explicit lineage/provenance questions ('where does this data come from'), never a field-adjacent default. FALSE PREMISE: when the question names a component the resolver cannot find — disposition `none`, or a literal API reference (dotted / __c-suffixed) that none of the fuzzy candidates actually match — the route is STILL returned (the routed tool fails closed on the unknown id) but its confidence is downgraded and `entityEvidence.warning` carries a premise disclosure (no component matching '<name>' exists in the vault — verify the name), so a nonexistent component is never answered as if it were real. Honesty routes: asks the surface genuinely cannot answer route to an explicit gap, never a lookalike tool — e.g. 'which USERS hold permission set X' (PermissionSetAssignment is not modeled; effective_permissions describes GRANTS, not holders); profile user-roster asks route live (live_group_count over User by ProfileId) with a partial-answer disclosure; and cross-vault compare routes carry a disclosure that a SECOND registered vault is required, so a single-vault install is never routed confident-clean into vault-not-found. Tells you when to sfi.resolve a named component first, whether the opt-in live plane is required, surfaces `suggestedArgs` (heuristic per-intent hints — e.g. `event: 'update'` for a save-order question so you can call `what_happens_on_save` without guessing the DML event), and — when the question hits a capability we lack — returns an honest 'unknown'/gap instead of fabricating (set `logGap: true` to also append the gap to the local backlog; off by default, privacy-first); under `SFI_TOOL_PROFILE=core` the response also carries `invoke`: the routed tools as EXECUTABLE calls (core tools direct, everything else as the byte-identical `sfi.run_analysis` gateway envelope, suggestedArgs threaded) (a short phrase that merely NAMES a real vault component, with no question, is instead routed to sfi.resolve rather than 'unknown'). In the default hybrid mode the meaning-ranked `toolCandidates` are PRIMARY: every routable question carries the shortlist (offline TF-IDF over the capability map, no neural model, no network) plus a `guidance` line stating the loop YOU own — read the candidates → resolve any named component → pick/sequence the tool(s) → run them → ground via sfi.synthesize_answer. YOU decide which to run; the deterministic `route` rides along only as a non-authoritative HINT (suggested tool order + any resolved entity / suggestedArgs). Set `SFI_ROUTER_MODE=offline` for a deterministic, no-LLM route (Design A) where the route is authoritative and candidates are omitted — for CI / air-gapped hosts. An optional `mode` ('ask' | 'plan' | 'assessment') tailors the guidance and reranks the candidates toward that mode's family — 'plan' favors the what_if_* / impact tools (an ordered change plan), 'assessment' favors the *_risk_report / readiness / coverage tools (a full evaluation), 'ask' is a quick grounded answer. REFUSAL SHAPES (score-independent, evaluated BEFORE any intent, in both router modes): a write/mutation imperative aimed at the agent ('delete the X field for me', 'go ahead and merge…') returns intent `refused-write` with EMPTY tools, a 'REFUSED (read-only boundary)' disclosure, and a read-side alternative to offer instead (safe_to_delete_field / what_if_deactivate_flow / what_if_disable_trigger / what_if_change_field_type / what_if_merge_profiles / get_impact by verb family); prompt-injection or record-value exfiltration ('ignore your previous instructions…', 'dump all SSN values') returns `refused-injection` with toolCandidates AND guidance suppressed entirely; runtime/ops telemetry no tool models (login history, adoption metrics, endpoint errors 'this week', running-user context) returns `honest-gap-runtime` with an 'HONEST GAP' disclosure naming the nearest reads; and non-Salesforce asks (SharePoint/Jira subjects, org-policy authorship, 'email me…' delivery, write-me-code) return `out-of-scope`. Every refusal is NON-EXECUTABLE by shape — `tools: []`, the structured `route.refusal` field carries { kind, disclosure, readOnlyAlternative? }, `executionBlocked` stays false — and legitimate permission/hypothetical READS ('am I allowed to edit…', 'who can delete…', 'is it safe to…', 'what would happen if…') are explicit excluders that route normally. FUNNEL-PRIMARY (advisory): when NO deterministic intent matches and nothing else stopped the route (no clarification, and a clean premise — a question naming a component the resolver cannot find gets the premise disclosure, never an advisory route), a pure-semantic top candidate scoring ≥ 0.26 upgrades the dead 'unrouted' to intent `funnel-advisory`: the top-3 funnel tools, confidence LOW by construction, reason flagged FUNNEL-DERIVED — treat it as the funnel's advisory pick to verify (resolve the named component, then ground), never a command. Candidate rows also carry `cosine`, the raw pre-fusion semantic score (0 for rows inserted purely from the regex route hint), so a host can tell real semantic support from regex assertion. CONVERSATION CONTEXT (stateless, host-passed — router P5): the product stores NO conversation memory; the HOST may pass optional `context.previous` per call ({ componentId, objectApiName, tool, intent, plane, question, clarification }) describing what the PRIOR turn was about, and nothing is stored server-side. With it, terse follow-ups resolve: (1) a pronoun/ellipsis follow-up whose own extraction finds no entity ('does it fire on delete too?') substitutes `previous.componentId` as the entity — an EXACT-id lookup, never fuzzy — and, when still unrouted, inherits `previous.tool` as an advisory `context-continuation` route (confidence capped at `medium`, never high; plane/liveRequired always from the live tool registry, never `previous.plane`; the resolved TYPE still gates the inherited tool — a type-incompatible inheritance is swapped or dropped to funnel-primary, never an executable tool bound to an id that guarantees a hard error); (2) a re-parameterization follow-up ('what about on Contact?') re-runs `previous.tool` against the NEW target from the question itself — an ambiguous new entity still blocks with a clarification; (3) an ordinal/descriptor pick ('the second one', 'the Contact one') against `previous.clarification` + `previous.question` re-dispatches through the full clarification-continuation contract (stale ids rejected exactly as usual; 0 or ≥2 descriptor matches, or an out-of-range ordinal, re-ask instead of guessing). HONESTY UNDER CONTEXT: refusal gates run on the RAW question BEFORE any context logic — context never bypasses them and adds no executable path to a refused turn; a carried componentId that no longer resolves gets a context-specific PREMISE disclosure and never advisory-routes; value validation is FAIL-OPEN (an unregistered `tool` / malformed `componentId` is skipped and noted in `contextApplied.ignored`, never a hard error — shape errors still reject). A SELF-CONTAINED question IGNORES context: no anaphor, or a confident own route, returns a response identical to the no-context call, and omitting `context` keeps behavior byte-identical. When (and only when) context changes the route, the response disclosure `route.contextApplied` carries { kind: 'entity-substitution' | 'continuation' | 'reparameterization' | 'clarification-selection', anaphor, substitutedComponentId?, from?, inheritedTool?, selection?, ignored? } and the rendered text appends a 'Context applied: …' line — mere presence of the param never emits it. Call this first on a vague/broad question to decide which tool(s) to run.",
    inputSchema: ROUTE_QUESTION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_pulse',
    description:
      "Org pulse for the current vault: freshness coverage (how many components carry a known lastModifiedDate, the coverage %, and the oldest/newest components) plus the top contributors by lastModifiedBy. Answers \"how fresh is what I know about this org?\" and \"who shaped this org?\". Honesty axis: both signals need lastModifiedDate/By, which a plain `sf project retrieve` does NOT populate — they require a Tooling-API-enriched refresh. ~0% coverage / empty contributors means 'not captured', not 'no history'. Optional `limit` (1..50) caps the lists.",
    inputSchema: ORG_PULSE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_card',
    description:
      'Serve the refresh-time ORG CARD — the ≤16KB orientation snapshot to load BEFORE your first question: identity & freshness, coverage and blind spots up front, scale by type, top objects by inbound dependencies, automation density, permissions posture (incl. god-mode holders), integration surface, observed naming conventions, and how-to-ask rules. Pure cache read of `meta/org-card.json` (rendered once per refresh — never recomputed here), so it costs one file read. A vault refreshed by an older version has no card: returns honest `available: false` with the refresh remedy. Emits a `coverageCaveat` when the WorkflowRule/ApprovalProcess automation families the card counts were not retrieved; a 0 automation count under it is "not retrieved", not proven none. No inputs.',
    inputSchema: ORG_CARD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.fleet_find',
    description:
      'Cross-vault resolve: which of your REGISTERED orgs contains the thing you mean. Runs the typo-tolerant resolver across every vault in the multi-vault registry, read-only, and reports per-vault dispositions (exact|ambiguous|none|unavailable) + which vaults it was found in. The cross-org sibling of sfi.resolve. Needs a multi-vault registry (SF_INTELLIGENCE_REGISTRY_PATH, or a registry.json above the vault); a single-vault install gets an honest note instead. Required `query`; optional `limit`.',
    inputSchema: FLEET_FIND_INPUT_SCHEMA,
  },
  {
    name: 'sfi.fleet_drift_ranking',
    description:
      "Fleet ops: of every REGISTERED vault, which is most behind its live org — i.e. which to /sfi-refresh first. Runs the same Tooling-API staleness check as sfi.live_stale_check (components modified since the vault's refreshedAt across ApexClass / ApexTrigger / ValidationRule / Layout / Flow / CustomField) across the whole registry and ranks vaults by drift descending, with a `mostDrifted` + `recommendation`. Consent is PER ORG: a vault whose sourceOrg has no live consent is an honest `no-consent` skip (not an error, no silent call) — grant per org or pass `liveEnabled: true`. Every query routes through the per-session live-query budget, so a sweep the budget can't cover degrades to `budget-exhausted` skips instead of overrunning org API limits (raise SFI_LIVE_QUERY_BUDGET or pass a `vaults` subset). Each ranked row is its own live_org read at its own time; the aggregate is a fleet roll-up (one org's freshness never implies another's). Only the 6 checked types drift-count; read-only. Optional `vaults` (alias subset), `liveEnabled`.",
    inputSchema: FLEET_DRIFT_RANKING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_fleet_report',
    description:
      "The \"state of my orgs\" digest: ONE GeneratedDocument composed across EVERY vault in the multi-vault registry, so you get a single artifact instead of running sfi.org_pulse / sfi.fleet_find / sfi.fleet_drift_ranking once per org by hand. A Per-Org Inventory table (every registered vault: status, source org, product version, last-refresh timestamp, total components, top component types) is read cheaply from each vault's own manifest — never dropped, an unreadable manifest is listed with status `unreadable`. A Freshness & Contributors digest (coverage % + top contributor) reuses the SAME logic sfi.org_pulse runs, capped at optional `limit` registered vaults (default 10, max 25) so this one call cannot be forced to open every vault's graph store — the Per-Org Inventory still covers all of them regardless. A fleet-level Executive Summary names the total component count and which vault is 'most behind' by an OFFLINE proxy (oldest refreshedAt; never-refreshed ranks worst) plus a Notable Divergences section (extractor-version splits, component-count spread). LIVE DRIFT IS SKIPPED, NOT SILENTLY SUBSTITUTED: this tool takes no org/consent arguments and makes no Tooling-API calls — the Live Drift section discloses that explicitly and points at sfi.fleet_drift_ranking (per-org consent) for the real live comparison. Fails closed with zero registered vaults (returns a document saying so, never a fabricated 'fleet is healthy'). Read-only; no args required.",
    inputSchema: GENERATE_FLEET_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_component',
    description:
      "Fetch a single component by canonical id. Returns its frontmatter and a response-safe Markdown body slice; large bodies are truncated with explicit bodyBytes/returnedBodyBytes/omittedBodyBytes metadata. Optional maxBodyBytes (0..30000) narrows the body slice. `maxBodyBytes: 0` (or any small value) is the EXISTENCE/METADATA-PROBE pattern — the response becomes a bounded metadata envelope (`metadataOnly: true`) instead of the full document: frontmatter is capped the same way body is, `properties` keeps whichever entries fit a small budget (scalars survive, huge arrays like a Profile's fieldPermissions/objectPermissions are the ones dropped and named in `omittedPropertyKeys`), and `referenceIds` is capped with the true total in `referenceCount` — a `disclosure` string names exactly what was omitted. This guarantees `maxBodyBytes: 0` never trips the global oversize guard, even on a huge node (e.g. a Profile with thousands of grants). A PHANTOM id (referenced by retrieved metadata but never itself retrieved) returns component-not-found with a classified reference stub — and an AUTOMATION-CRITICAL phantom hit is also queued in meta/demand-queue.jsonl so `sfi refresh --drain-demand-queue` (or the watch daemon with --drain-demand-queue) can pull exactly the components real questions needed. An `UnresolvedProfile:{id}` stub (a Profile Id a RestrictionRule/DuplicateRule referenced but the vault could not resolve to an api name) classifies as `unresolved-profile-id`: its remedy is a Profile Id→apiName index / live Tooling, NOT a wider retrieve manifest. Every response also carries `conceptReasoning` (DEFAULT ON; pass `includeConceptReasoning: false` to skip it): the deterministic concept-rule engine (`sfi.interpret`) run over this component, returning CITED claims on the shared EvidenceEnvelope v2 shape plus a `completeness` digest that keeps four states apart — rules that FIRED, rules EVALUATED against this component that matched nothing, rules PROVABLY inapplicable to this component type, and rules that could NOT be evaluated (the vault lacks their metadata, or their bind shape could not be proven inapplicable). Read `completeness.noRuleCoversComponentType` FIRST: when true, NOTHING was checked and an empty `claims` list is silence, never a clean bill of health. Its bytes are RESERVED from the response budget before the rest of the answer is fitted, and its claim list is capped for size — `sfi.interpret` is the uncapped surface. This is the UNIVERSAL reasoning anchor — the only surface that reaches concept rules bound on long-tail component types (Role, SharingRule, Network, DuplicateRule, RestrictionRule, …). The `maxBodyBytes` metadata-PROBE path IGNORES the flag in both directions and never attaches the block: a probe's contract is a minimal payload, so honouring the flag there would violate the caller's own size bound.",
    inputSchema: GET_COMPONENT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.doc_coverage_report',
    description:
      'Offline, vault-only documentation-GAP meter — the documentation axis `sfi.tech_debt_score` lacks. MEASURES where the org\'s metadata is undocumented (it does NOT PRODUCE docs like `sfi.generate_data_dictionary` / `sfi.generate_admin_handbook`). Rolls the two documentation axes the extractors capture — a component\'s `description` and a field\'s `inlineHelpText` presence — into a scored, LOWEST-COVERAGE-FIRST report broken down by object, and WEIGHTS each undocumented component by its inbound graph edge-degree (a real criticality proxy — an undocumented, heavily-referenced field ranks above an undocumented orphan). `objects` is the per-object breakdown (each with a `description` and `helpText` axis rollup — measurable / documented / undocumented / coveragePct — plus `combinedCoveragePct` and `undocumentedDegreeWeight`), ranked worst-covered first and PAGED by `limit` (default 20, max 100) / `offset` / `nextOffset`; the page self-fits the response byte budget (`nextOffset` always equals `offset + objects.length`, `byteTrimmed` flags a byte-limited page, so a cursor walk never skips an object). `topUndocumented` surfaces the highest-impact undocumented components (undocumented AND high-degree) regardless of page; `totals` carries the org-wide axis rollups plus the excluded `notMeasurableCount` / `outOfScopeCount`. HONESTY: "not measurable" ≠ "undocumented" — a type whose description the extractor does NOT capture (or a family the refresh did not retrieve) is NOT MEASURABLE and is EXCLUDED from the undocumented count, never counted as a gap (objects have no inline help text, so they are not measurable on the help-text axis). Scoped to what the ORG owns: custom `__c`/`__mdt`/… fields + custom objects; standard fields (Salesforce-provided help) and managed-package (`ns__…`) components are reported separately as out-of-scope and never penalize the org. `description` absence and `inlineHelpText` absence are distinct axes, never conflated. Coverage is a floor (only retrieved families measured). Presence is `declared` (structural); "documented" means a NON-EMPTY field, not a QUALITY judgment (a one-word description still counts as present).',
    inputSchema: DOC_COVERAGE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.limit_headroom_report',
    description:
      "Offline, vault-only limit-headroom report — the replacement for the retiring Salesforce Optimizer's limit report. Counts the org's METADATA against per-object and per-org CONFIGURATION ceilings and ranks the rows WORST-FIRST by remaining headroom% so an admin acts before a deploy hits a wall. Per CustomObject it reports consumed / limit / headroom% for custom fields, active validation rules, record types, and relationship fields (lookup + master-detail); org-wide it reports custom objects, custom tabs, custom apps, and active flows. `orgLimits` is the always-included org-wide set; `objects` is the per-object set (each with its 4 metric rows and `worstHeadroomPct`), ranked worst-first and PAGED by `limit` (default 15, max 100) / `offset` / `nextOffset` — the page also self-fits the response byte budget, so a large `limit` returns as many objects as fit with an honest cursor (`nextOffset` always equals `offset + objects.length`, and `byteTrimmed` flags a byte-limited page); `topRisks` surfaces the ≤5 tightest rows across the WHOLE report regardless of page; `metricLegend` holds each metric's label + general-Salesforce source note + consumption caveat (deduped out of the lean rows). This is NOT `sfi.tech_debt_score` (a weighted debt index, no per-limit headroom) and NOT `sfi.coverage_report` (retrieval coverage, not config limits). HONESTY: edition cannot be read offline — pass `edition` (enterprise | unlimited | developer | professional) or edition-dependent limits use an ASSUMED enterprise edition, disclosed verbatim, with every such row labeled `limitBasis: 'assumed-edition'` (the cap table is GENERAL Salesforce documented limits, never this org's provisioned ceilings). Field consumption is an APPROXIMATION (geolocation counted as 3 slots; roll-up summary has a separate cap; managed-package namespaced fields excluded because they generally do not count). Only families the refresh retrieved are counted — an un-retrieved family reads as 0 consumed, a FLOOR flagged `consumedIsFloor`. Runtime limits (data/file storage, API request counts, daily async) are out of scope and deferred to the consent-gated live plane (`sfi.live_org_limits`).",
    inputSchema: LIMIT_HEADROOM_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_components',
    description:
      'List components of a given type (optionally narrowed by parentId), sorted by id. Paginated via limit/offset; `hasMore` hints at additional pages (a truncated page returns a `nextCursor` to resume). Grant-heavy rows (Profile / PermissionSet, whose nodes carry tens of KB of declarative grants) are slimmed to scalar properties — each such row is marked `properties.propertiesTruncated: true` and the page carries a top-level `propertiesSlimmed: true` — so the whole inventory fits per page; fetch full detail per component via sfi.get_component. For `type: \'ApexClass\'`, optional boolean filters list interface/async/API implementers at the DB layer (correct pagination, not a post-filtered page): `isBatchable` / `isQueueable` / `isSchedulable` / `isRestResource` / `hasFutureMethod` / `hasInvocableMethod` / `hasAuraEnabledMethod` / `isTest` — e.g. `{ type: \'ApexClass\', isBatchable: true }` returns every Batchable class. `missingDescription: true` (or `hasDescription: true`) filters to components that lack (or carry) a non-empty `properties.description`, with `totalCount` as the authoritative tally — only meaningful for a type whose extractor captures a source `<description>` (a type that carries none in source will match ALL of its nodes, meaning "no description in source", not "left blank"). When manifest coverage for the requested `type` is not `complete`, a structured `coverageCaveat` flags the inventory as potentially incomplete (scoped refresh, errored retrieve, not modeled) — including on non-empty pages. When the FIRST page is empty, a `retrievalHint` (FRESH-02) says WHY — "none in the org" (retrieved, none found) vs "not retrieved" (a scoped refresh skipped the type — run /sfi-refresh) vs "not modeled" — so an empty list is never a silent `[]` read as "the org has none". (The hint is suppressed when a boolean filter is active, since an empty filtered result is not a coverage gap.)',
    inputSchema: LIST_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_edges',
    description:
      "List edges incident to a node, optionally filtered by direction, edge type, and confidence. Paginated: `limit` (default 200, max 1000) and `offset` (default 0) page through the edges, with `totalCount` (the unpaged total), `hasMore`, and `nextOffset` to advance — so a hub node (e.g. a standard object with thousands of `grantedBy` FLS edges) returns a usable page instead of tripping the ~45 KB response limit. A per-response ~38 KB byte budget trims the page further (with a `note`) when wide edges would still overflow; filter by `edgeType`/`direction`/`confidence` to narrow.",
    inputSchema: GET_EDGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_subgraph',
    description:
      'BFS from a root component, up to `hops` (max 3). Returns the connected node and edge slice.',
    inputSchema: GET_SUBGRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.query_graph',
    description:
      "ADVANCED / power-user: a read-only, guard-railed STRUCTURED query over the vault's dependency graph, for ad-hoc questions the purpose-built tools don't cover (e.g. \"every ApexClass whose api name starts with Billing\", \"all grantedBy edges of heuristic confidence\", \"nodes with no lastModifiedBy\"). You do NOT write SQL — you supply a structured query: `select` ('nodes' or 'edges'), an optional `where` list of `{column, op, value}` conditions (AND-ed), and an optional `limit`. Columns are an allowlist: for nodes — id, type, apiName, label, parentId, sourcePath, lastModifiedDate, lastModifiedBy, apiVersion, plus `property:<key>` for a JSON property (e.g. property:dataType, property:triggerType); for edges — fromId, toId, edgeType, confidence, source, plus `property:<key>`. Operators are an allowlist: `=`, `!=`, `LIKE`, `ILIKE`, `IN` (array value, ≤50), `IS NULL`, `IS NOT NULL`. Every value is a BOUND parameter — never SQL — so an injection payload matches nothing rather than executing; an unknown column/operator is rejected with `invalid-query` naming what IS allowed. The compiled statement is always a single read-only SELECT (never an INSERT / UPDATE / DELETE) with a fixed sort and a hard `limit` (default 50, max 500) — the SELECT-only compilation plus the column/operator allowlist and bound parameters are what guarantee it cannot mutate the vault, independent of the underlying graph handle. The response echoes the exact compiled SQL + bound values and carries a `disclosure`: this is a RAW graph view — ids/edges exactly as stored, per-edge `confidence`, NO synthesis/grounding/coverage reconciliation, and an absent row on a partially-refreshed vault is not proof the org lacks it. Prefer get_edges / get_impact / list_components / who_can_access_object / what_happens_on_save for grounded answers; reach for query_graph only for filters those don't expose.",
    inputSchema: QUERY_GRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.search_apex_source',
    description:
      'Search the vaulted Apex source for matches. Optional regex; returns path, line, and snippet.',
    inputSchema: SEARCH_APEX_SOURCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.search_flow_metadata',
    description:
      'Search the vaulted Flow metadata XML for matches. Optional regex; returns path, line, and snippet.',
    inputSchema: SEARCH_FLOW_METADATA_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_naming_convention_report',
    description:
      'Return the naming-convention pattern observations, optionally scoped to a glob.',
    inputSchema: NAMING_CONVENTION_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_manifest',
    description:
      'Return the current vault manifest (org-kb/meta/manifest.json) verbatim.',
    inputSchema: GET_MANIFEST_INPUT_SCHEMA,
  },
  {
    name: 'sfi.coverage_report',
    description:
      "Report the vault's self-assessed metadata coverage: covered, partial, not-modeled, and — during a staged refresh — pending families (queued by the in-progress tiered build, with `stagedBuild` tier progress; pending types count as missing coverage, so absence answers about them must stay qualified). Use before absence-based or destructive answers. The `assignmentData` section covers runtime assignment data (User / PermissionSetAssignment / GroupMember): NOT in the vault by design (a runtime data object, not a retrieve gap) — it names the consent-gated live tools that answer those questions (sfi.live_permset_holders, sfi.live_user_permsets, sfi.live_group_members, sfi.live_zombie_accounts), whether live consent is currently granted, and whether/when a counts-only facts snapshot (`sfi refresh --with-data-shape`) was captured.",
    inputSchema: COVERAGE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.retrieve_blindspot_report',
    description:
      "Retrieve blind spots: components REFERENCED by retrieved automation / code / config but ABSENT from the vault (their edge targets resolve to no node — the last refresh never pulled them). The honest backing for absence answers: an 'X is unused / nothing references X / X is safe to delete' answer about a listed target is unreliable. The `blindspots` list is the high-signal class — automation/code/integration references (triggersOn an unretrieved object, callsApex an unretrieved class, sendsEmail an unretrieved template) — grouped by target type, each tagged with its coverage status (notModeled / absent = a whole-type manifest gap; covered = specific managed/community components outside the retrieve scope) and a concrete `remedy`. Permission-set grants (the managed/standard 'grant-only' class), layout field decoration, and unresolved Apex-scanner phantoms are rolled up as counts (low analysis impact) — pass `includeLowSignal: true` to enumerate them. `cleanVault: true` and an empty `blindspots` means every reference resolves. Optional `targetType` narrows to one type. Provenance offline_snapshot. Lookup / master-detail relationship targets pointing at an unretrieved object are included (dangling `lookupTo` edges).",
    inputSchema: RETRIEVE_BLINDSPOT_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.health_check',
    description:
      'Report self-assessed server health, render consistency, and coverage completeness, plus a freshness block (vault age, a stale flag, the most recent refresh\'s change count, and a yellow-flag nudge when the vault is old or local source drifted). While a staged refresh (`sfi refresh --staged`) is mid-build, status is degraded with explicit tier progress ("building tier i/n") until the final tier clears the marker. Also carries an INFORMATIONAL `assignmentData` block (runtime assignment data is live-first by design — its absence never degrades status; a stale counts snapshot >30 days old earns an advisory only) and a `vaultHistory` block (whether local vault git history is enabled, with a one-line `sfi vault git enable` hint when disabled so change-over-time questions become answerable). When the last refresh computed it, echoes a `phantomSummary` roll-up of dangling-edge targets by phantom taxonomy bucket (counts only — no stub nodes; `null` until the next `sfi refresh` populates it).',
    inputSchema: HEALTH_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.baseline_acknowledge',
    description:
      'Acknowledge a heuristic finding so SAST tools suppress it across refreshes (stored in org-kb/meta/baseline.json).',
    inputSchema: BASELINE_ACKNOWLEDGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.baseline_status',
    description:
      'List suppressed finding fingerprints and per-tool counts from the vault baseline file.',
    inputSchema: BASELINE_STATUS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_describe',
    description:
      'Opt-in live org: describe an sObject via Salesforce CLI. Disabled unless SFI_LIVE_PLANE_ENABLED=1 or liveEnabled=true. Read-only; provenance live_org.',
    inputSchema: LIVE_DESCRIBE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_stale_check',
    description: "Opt-in live org: \"is the org AHEAD of the vault?\". For each Tooling-queryable type (ApexClass, ApexTrigger, ValidationRule, Layout, Flow, CustomField), counts components with `LastModifiedDate` AFTER the vault's `refreshedAt` via the Tooling API. Returns `orgAheadOfVault`, `totalChangedSinceRefresh`, per-type `byType`, `checkedTypes`, `erroredTypes`, and an `interpretation`. A non-zero total means the vault is STALE relative to the org — run /sfi-refresh. Read-only; does not mutate the org or vault. Requires the live plane (SFI_LIVE_PLANE_ENABLED, liveEnabled:true, or sfi.live_consent). orgAheadOfVault:false means \"none of the CHECKED types drifted\", not \"nothing changed\".",
    inputSchema: LIVE_STALE_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_count',
    description:
      'Opt-in live org: count records. Pass `objectApiName` to count every row of an object, or `soql` for a custom SELECT COUNT() query (strict shape validation). Read-only; never falls back to vault data.',
    inputSchema: LIVE_COUNT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_sample',
    description:
      'Opt-in live org: run SOQL with a hard row cap (default + max 200). Read-only sample rows for runtime questions. The caller controls the projection, so a per-response ~36 KB byte budget also trims trailing rows when a wide SELECT (e.g. FIELDS(STANDARD)) at the row cap would exceed the global ~45 KB response limit — `rowCount` reflects the rows actually returned and a `note` appears when rows were dropped for size (narrow the SELECT or lower `limit` to sample more).',
    inputSchema: LIVE_SAMPLE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_field_population',
    description:
      'Opt-in live org: population rate for one field (total vs null counts). Read-only.',
    inputSchema: LIVE_FIELD_POPULATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_group_count',
    description:
      'Opt-in live org: value distribution — COUNT grouped by one field on any object (e.g. Cases by Status, Accounts by Industry). Optional equality filter. Read-only; capped buckets; provenance live_org.',
    inputSchema: LIVE_GROUP_COUNT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_stale_records',
    description:
      'Opt-in live org: records on any object not touched in N days (default LastModifiedDate). Answers "which X are stale/unused?" without arbitrary SOQL. Read-only; reports true total plus capped detail rows.',
    inputSchema: LIVE_STALE_RECORDS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_recent_activity',
    description:
      'Opt-in live org: records created or modified in the last N days on any object. Read-only; capped detail with true total.',
    inputSchema: LIVE_RECENT_ACTIVITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_aggregate',
    description:
      'Opt-in live org: MIN/MAX/AVG/SUM on one numeric field for any object. Optional equality filter. Read-only; provenance live_org.',
    inputSchema: LIVE_AGGREGATE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_duplicate_check',
    description:
      'Opt-in live org: find duplicate values on one field (GROUP BY + HAVING COUNT > 1). Read-only; capped duplicate groups.',
    inputSchema: LIVE_DUPLICATE_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_owner_breakdown',
    description:
      'Opt-in live org: record counts by OwnerId with User/Queue names resolved. Read-only; top owners by volume.',
    inputSchema: LIVE_OWNER_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_record_access',
    description:
      "Opt-in live org: a specific user's EFFECTIVE access to ONE record right now — Read / Edit / Delete / Transfer / Full (All) — from the org's live sharing calculation (UserRecordAccess). This is the RUNTIME resolver for the offline sfi.why_cant_user_see_record: when that vault cascade returns `unknown` (manual shares, account/opportunity teams, Apex managed sharing, and criteria sharing over record field VALUES are record-level state the vault never holds), this tool answers definitively against the live org. Give `recordId` (15/18-char) plus `userId` OR `username` (username resolves via a capped exact-Username lookup; ambiguity or no-match is an honest error). An empty result (`noAccessRow: true`) means the org returned no access row for this user+record — record missing, wrong id, or invisible to the querying user — and is reported as 'could not determine', NEVER a confirmed deny. Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data.",
    inputSchema: LIVE_RECORD_ACCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_record_shares',
    description:
      "Opt-in live org: the explicit sharing rows on ONE record — WHO it is shared with and WHY — from the runtime `{Object}Share` table (each row is a UserOrGroupId + AccessLevel + RowCause: Owner / Manual / a sharing Rule / a Team / Apex managed sharing). This is runtime state the offline vault never holds; it complements sfi.live_record_access (a user's effective access) by enumerating the shares themselves. Give `recordId` (15/18-char); `objectApiName` is optional (derived from the Id key prefix via the org describe when omitted — an ambiguous or unknown prefix is an honest error asking for it). User/Group ids are resolved to names. HONESTY: an object whose OWD is Public Read/Write has NO Share table — a non-queryable result (`shareTableQueryable: false`) means 'no explicit shares apply', NOT 'no one has access'. True count first (`totalShares`); capped detail (default 200, max 500). Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data.",
    inputSchema: LIVE_RECORD_SHARES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_scheduled_jobs',
    description:
      "Opt-in live org: the RUNTIME schedule registry — what is ACTUALLY scheduled right now — from CronTrigger (+ CronJobDetail.Name / JobType, State, CronExpression, NextFireTime, TimesTriggered), plus an optional recent AsyncApexJob status summary. This is the live half of the static sfi.scheduled_job_catalog, which lists Schedulable-CAPABLE Apex classes from metadata (schedule-capable ≠ scheduled). HONESTY: the two measure DIFFERENT things and routinely differ — a Schedulable class may not be scheduled, and a cron job may run managed-package or non-Apex work (Data Export, Dashboard Refresh) no catalog class covers; the class-vs-cron cross-reference is COUNT-ONLY (`staticSchedulableClassCount` vs `liveScheduledApexCount`), never a per-class pairing. True count first (`totalCronJobs`); capped detail (default 200, max 500). Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data.",
    inputSchema: LIVE_SCHEDULED_JOBS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_field_history',
    description:
      "Opt-in live org: WHO changed a field on a record and to what — from the `{Object}History` table (Field, OldValue, NewValue, CreatedBy.Name, CreatedDate). Filter by `fieldApiName`, `recordId`, and/or `days`. This is the ONE live tool family that returns runtime RECORD DATA (OldValue/NewValue are actual field values), so rows are capped HARD (default 20, max 200) with a byte budget. PRECONDITION: field history exists only where tracking is enabled — the vault's per-field `trackHistory` / per-object `enableHistory` is checked FIRST. A vault-KNOWN off state FAILS CLOSED with a precise reason ('history tracking is not enabled for … per last refresh') instead of a cryptic SOQL error; MISSING vault metadata proceeds with a live probe and discloses `trackingState: 'unknown'` (a zero result then must NOT be read as 'no changes'). Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data.",
    inputSchema: LIVE_FIELD_HISTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_storage_by_object',
    description:
      'Opt-in live org: record counts across objects via the Salesforce recordCount REST API — top N by volume, optional objectApiNames filter. Read-only.',
    inputSchema: LIVE_STORAGE_BY_OBJECT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_org_limits',
    description:
      'Opt-in live org: current org governor limits via REST. Read-only.',
    inputSchema: LIVE_ORG_LIMITS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_data_skew',
    description:
      "Opt-in live org: ownership / data-skew concentration — which `ownerField` value (default `OwnerId`) holds MORE than `threshold` records (default 10,000) of `objectApiName`, via a single `GROUP BY … HAVING COUNT(Id) > threshold` SOQL aggregate, worst-concentration first. The large-data-volume risk (ownership skew slows sharing recalculation and record locking) that only the runtime org can answer — record counts are never in the offline vault. `ownerField` may be any groupable field (e.g. a lookup) to check non-owner concentration. True `maxConcentration` + `skewDetected` first; capped detail (default 50, max 500). Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data. Fails CLOSED without the live plane (SFI_LIVE_PLANE_ENABLED=1, liveEnabled:true, or sfi.live_consent).",
    inputSchema: LIVE_DATA_SKEW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_security_exposure',
    description: "Opt-in live org: the RUNTIME security-exposure snapshot — how many permission sets currently grant Modify All Data / View All Data / Author Apex, and how many user assignments carry Modify All Data — via resilient SOQL COUNT() over PermissionSet / PermissionSetAssignment (each signal independent; an unqueryable object yields null, never a false zero, and a budget stop is disclosed as a signal). This is the LIVE complement to the offline sfi.permission_risk_report (which ranks the same exposure from vault metadata): use this for the current count as-of-now, that for the grounded per-container attribution. Read-only; point-in-time as of queriedAt; provenance live_org; never falls back to vault data. Fails CLOSED without the live plane (SFI_LIVE_PLANE_ENABLED=1, liveEnabled:true, or sfi.live_consent).",
    inputSchema: LIVE_SECURITY_EXPOSURE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_inactive_users',
    description:
      "Opt-in live org: active users who haven't logged in within N days (default 30) or never have — the license-reclamation / dormant-account question. Standard (human) users by default; reports the true total (`totalInactive`) plus a capped detail page, oldest-dormant first. `limit` pages the detail rows (default 100, hard cap 500) and a per-response ~36 KB byte budget trims the page further when a wide page would exceed it (the response carries both the structured rows and a rendered table, so it can't trip the global ~45 KB limit); `capped` flips true when more remain and a `note` appears when the page was byte-trimmed. Read-only; LastLoginDate is live-only state. Dormancy ONLY — for active users with login access but ZERO permission-set/PSG assignments (the perm-set-less variant of this sweep), use sfi.live_zombie_accounts.",
    inputSchema: LIVE_INACTIVE_USERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_permset_holders',
    description:
      "Opt-in live org: WHO HOLDS a permission set, permission set group, or profile — the name-by-name assignment roster (PermissionSetAssignment / User rows are runtime state, never in the vault; vault sfi.effective_permissions describes what a grantor GRANTS, not who holds it). `kind` defaults to 'auto' (probes PermissionSet → PermissionSetGroup → Profile by exact name/label; ambiguity or no-match is an honest error, never a guess). For a permission set the default `includeViaGroups: true` ALSO counts users who receive it through a PermissionSetGroup containing it (querying PermissionSetGroupComponent), reported separately as `directHolders` / `viaGroupHolders` with a deduped `totalAssignees` — direct-only rosters silently miss via-group holders (the classic wrong answer). kind 'profile' returns the User roster for the profile. Expired assignments are excluded and disclosed (`expiredExcluded`); active assignees only by default. True count first; `limit` (default 100, cap 500) + ~36 KB byte budget page the detail; keyset paging via `afterId`/`nextAfterId`; `groupBy: 'profile'` (default) adds per-profile buckets. Reverse direction (what does USER X hold) = sfi.live_user_permsets. Read-only; point-in-time as of queriedAt — never cached beyond the live-session TTL; roster is CURRENT org state, unlike vault answers.",
    inputSchema: LIVE_PERMSET_HOLDERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_zombie_accounts',
    description:
      'Opt-in live org: ZOMBIE accounts — active users with login access but ZERO permission-set/PSG assignments, via a single SOQL anti-join (Id NOT IN PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false; the IsOwnedByProfile filter is load-bearing — every user carries a system PSA row for their profile-owned set). When the org rejects the anti-join it falls back to a DISCLOSED client-side diff of two bounded queries (`method: \'client-diff\'`, capped scans flagged as a lower bound). Optional `minDaysInactive` additionally requires dormancy; Standard (human) users by default. True count first (`totalZombies`); `limit` (default 100, cap 500) + ~36 KB byte budget page the detail. HONESTY: a "zombie" still holds every permission its PROFILE grants — this reports "no permission-set/PSG assignments", NOT "no access". This is the perm-set-less variant of sfi.live_inactive_users, which covers dormancy only (and for who DOES hold a set, use sfi.live_permset_holders). Read-only; point-in-time.',
    inputSchema: LIVE_ZOMBIE_ACCOUNTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_group_members',
    description:
      "Opt-in live org: WHO IS IN a queue or public group — the runtime GroupMember roster (metadata XML only carries DECLARED members, so the vault's member counts routinely say 0 while Setup-managed membership is live-only; vault sfi.empty_queues_and_groups reads the declared counts). Resolves the Group by exact DeveloperName/Name (`groupType` defaults to 'auto'; ambiguity or no-match is an honest error, never a guess). GroupMember.UserOrGroupId is polymorphic: users (005) are resolved name-by-name, nested groups (00G) are LISTED but not expanded, and Role / RoleAndSubordinates entries are surfaced by UserRole name and NEVER expanded to users. `expandNested: true` expands exactly ONE level of nested public groups, stamped `expansion: 'partial-one-level'` — deeper nesting and role-hierarchy subordinates are not enumerated; never treat a partial expansion as the full effective membership. Queues also return `supportedObjects` (QueueSobject — which sObjects the queue can own). Output cross-checks the vault: `vaultDeclaredMemberCount` vs `liveDirectMemberCount` with a `drift` boolean. True count first (`totalDirectMembers`); `limit` (default 100, cap 500) + ~36 KB byte budget page the user rows. Read-only; point-in-time as of queriedAt.",
    inputSchema: LIVE_GROUP_MEMBERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_user_permsets',
    description:
      "Opt-in live org: WHAT does USER X hold — the reverse of sfi.live_permset_holders (input = a user, output = the grantors they hold: profile + direct permission sets + permission set groups, with expirations). Resolves the user by exact Username (preferred — unique) then exact Name; an ambiguous name returns an honest candidate list, never a guess. PSA rows are split `directPermsets` vs `viaGroups` (grouped by PermissionSetGroup); the query pins PermissionSet.IsOwnedByProfile = false so the user's profile-owned system PSA row never masquerades as a direct assignment — the profile is reported as `user.profileName` instead. Expired assignments are excluded and disclosed (`expiredExcluded`). DUAL PROVENANCE: this answers WHICH grantors the user holds (live, point-in-time as of queriedAt); vault sfi.effective_permissions answers WHAT those grantors grant — pair them, each half stamped with its own provenance. True count first (`totalAssignments`); `limit` (default 200, cap 500) + ~36 KB byte budget page the detail. Read-only.",
    inputSchema: LIVE_USER_PERMSETS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_setup_audit_trail',
    description: "Opt-in live org: WHO CHANGED WHAT in Setup — the SetupAuditTrail roster (profile/permission-set edits, field changes, org-wide-default flips, and every other tracked configuration change), the runtime \"who touched this\" question the vault's declared metadata cannot answer. `days` bounds the window (default 30, max 180 — Salesforce's own SetupAuditTrail retention ceiling). True count first (`totalChanges`, from a GATED COUNT query); `limit` (default 100, max 500) pages the detail rows (Action, Section, CreatedDate, Display, CreatedBy.Name), newest first. : the detail SELECT is NOT itself budget-gated, so a mid-tool session-budget stop can leave `changes` empty while `totalChanges` stays exact — `budgetStopped` and the rendered text disclose the partial rather than reading it as zero changes. Read-only; point-in-time as of queriedAt.",
    inputSchema: LIVE_SETUP_AUDIT_TRAIL_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_license_usage',
    description:
      "Opt-in live org: license / cost optimization. Returns UserLicense and PermissionSetLicense utilization (total / used / available / utilizationPct; unlimited licenses surface total: -1 → available/pct null) plus `reclaimableSeats` — active Standard users dormant past `inactiveDays` (default 90), grouped by their user license, the paid-seats-nobody-uses question. Honesty axis (verbatim): reclaimable seats is a PROXY (inactivity, not actual feature usage; some dormant seats are held intentionally; per-feature-license usage is not covered). READ-ONLY: never deprovisions or reassigns a license — verify each seat before reclaiming. License counts and LastLoginDate are live-only state.",
    inputSchema: LIVE_LICENSE_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_consent',
    description: "Manage per-org live-plane grants (in the core profile). Default (no args) REPORTS grant status — it never silently enables anything. grant: true binds OrgId+principal via read-only `sf org display`, records scopes (default aggregate; step up with scopes:[\"sample\"] / [\"users\"] / [\"audit\"]) and expiry (default 7 days), and persists locally. revoke: true removes the grant. Per-call liveEnabled is NOT a consent substitute. Granting never mutates Salesforce records.",
    inputSchema: LIVE_CONSENT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_report_usage',
    description:
      'Opt-in live org: stale/unused reports via Report.LastRunDate — total vs not-run-in-N-days. Read-only; resilient when Report is unavailable. Fails CLOSED without the live plane: with no consent (SFI_LIVE_PLANE_ENABLED=1, liveEnabled:true, or sfi.live_consent) it returns a clear invalid-query error and never queries the org.',
    inputSchema: LIVE_REPORT_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_folder_access',
    description:
      'Opt-in live org: folder inventory and access types (Report/Dashboard/Email/Document). Read-only; flags publicly accessible folders.',
    inputSchema: LIVE_FOLDER_ACCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_email_template_usage',
    description:
      'Opt-in live org: email template usage, Classic vs Lightning classification, and migration candidates. Read-only.',
    inputSchema: LIVE_EMAIL_TEMPLATE_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_org_health',
    description:
      'Opt-in live org: operational health snapshot — failed/pending async jobs, paused flow interviews, governor limits at risk. Read-only.',
    inputSchema: LIVE_ORG_HEALTH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_automation_fired',
    description: "Does this record-triggered automation actually run in production? Given an ApexTrigger / record-triggered Flow / WorkflowRule `componentId`, resolves its trigger object (the vault `triggersOn` edge) and, when the live plane is enabled, checks whether that object has records and whether any were modified in the last `staleDays` (default 90). Flags `likelyNeverRuns: true` when the trigger object has ZERO records (cannot have fired) or has records but NONE changed in the window (a create/change-triggered automation hasn't fired recently). `confidence: 'heuristic'` — record presence/activity is necessary but NOT sufficient (entry criteria may filter every record; execution itself is not observed without debug logs). Non-record-triggered automation (autolaunched/scheduled/screen flows, platform-event subscribers) is reported `applicable: false`. WITHOUT consent it returns the resolved trigger object + a caveat (offline_snapshot). Counts only; provenance hybrid when consented.",
    inputSchema: LIVE_AUTOMATION_FIRED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_picklist_usage',
    description: "Which picklist VALUES are actually used in production. Given a Picklist/MultiselectPicklist `CustomField:{Object}.{Field}` id, runs a live `GROUP BY` over the field's value distribution and cross-references it against the vault's DEFINED value set: returns `usage` (each value with its live record count, top-N), `unusedDefinedValues` (values the picklist defines that NO record uses — cleanup / restrict-to-active candidates), `undefinedUsedValues` (values records carry that the picklist no longer defines), and `blankCount`. Honest empty when the object has no records or the field is never populated. WITHOUT consent it returns the DEFINED values with a caveat (offline_snapshot) — the value set still answers, usage just isn't filled in. provenance hybrid when consented. Counts only; for a MultiselectPicklist per-value counts overlap (a record counts toward every value in its combo) — flagged. `limit` caps distinct values (default 50).",
    inputSchema: LIVE_PICKLIST_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_budget',
    description: "Disclose this session's live-query budget and result-cache state. Returns `budget` (limit/used/remaining — the per-session cap, default 50 via SFI_LIVE_QUERY_BUDGET, that stops the hybrid plane from exhausting org API limits), `cache` (cached-result count + TTL), and — when the live plane is enabled — `orgApiHeadroom` cross-checked against the org's real DailyApiRequests via `sf org limits` so the cap is visibly a tiny fraction of what the org can serve. Budget/cache are SESSION-LOCAL runtime state, reported without a live call (no consent needed); only the org-headroom cross-check needs the live plane. A repeated identical live query is served from cache and costs NO budget. Read-only.",
    inputSchema: LIVE_ORG_LIMITS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_risk_report',
    description:
      'Deterministic org risk synthesis: health, tech debt, and coverage gaps ranked with trust metadata. Optional `gate: true` adds a deploy-gate verdict — `ready` (go/no-go) + `blockers` (critical findings plus any requested metadata that ERRORED during retrieve); this is the "is this org ready to deploy?" release gate (formerly release_readiness_report).',
    inputSchema: ORG_RISK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_cleanup_candidates',
    // HIDDEN back-compat alias (STEP-2): the ranked cleanup roster folded into
    // `sfi.unused_fields_deep` (`format: 'cleanup'` MODE). Dispatchable by name /
    // run_analysis, un-advertised on tools/list.
    hidden: true,
    description:
      "Ranked unused-field cleanup candidates composed from sfi.unused_fields_deep. Optional `objectId` narrows the scan to one CustomObject — accepts the canonical id (`CustomObject:Account`) or a bare api name (`Account`); without it the scan is org-wide. `limit` (default 100, max 500) caps the candidates; because each carries the full eight-tier detail, a per-response ~36 KB byte budget trims the list further when it would exceed the global ~45 KB MCP response limit, adding a `note` (use sfi.unused_fields_deep, paginated, for the full detail). (Superseded by `sfi.unused_fields_deep` with `format: 'cleanup'`.)",
    inputSchema: FIELD_CLEANUP_CANDIDATES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.automation_risk_report',
    description:
      "Ranked automation risks: Process Builder migration candidates and governor-limit findings. Optional object scope (`objectApiName` / `object` / `objectId` / `CustomObject:` `componentId`) is HONORED: the legacy-automation half narrows to Process Builders parented to that object and the response echoes `appliedScope`; the Apex governor-limit half is EXCLUDED from the object-scoped view (Apex classes aren't attributable to one object) and that exclusion is disclosed — never silently returning the org-wide report. An object absent from the vault is refused with `invalid-query`. A bare call stays org-wide and byte-identical. `mode: 'sprawl'` switches to an org-wide, per-OBJECT automation-density ranking — which objects have the most automation (record-triggered flows, triggers, workflow rules, Process Builders, field-write collisions) — a prioritized candidate queue for triage (where is flow/automation sprawl worst first), not a graded verdict, with the score weights disclosed in `scoreBasis`.",
    inputSchema: AUTOMATION_RISK_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.permission_risk_report',
    description:
      "Ranked permission-risk report, leading with OVER-PRIVILEGE read straight from the extracted profile / permission-set metadata: every Profile or PermissionSet that grants a god-mode or administrative system permission (Modify All Data / View All Data = critical; Author Apex, Customize Application, Manage Users, Manage Profiles/PermSets, Modify Metadata, Manage Sharing, Manage Roles, password/login policies = high) OR object-level View All / Modify All, surfaced as ONE aggregated finding per grantor (severity = the worst signal; system perms + a per-grantor count of objects escalated). PermissionSetGroups are analysed too: a PSG's effective god-mode is aggregated from its MEMBER permission sets (so a user who gets Modify All Data via a group is caught), with the muting permission set noted but not subtracted (v1 honesty boundary). A `privilege` block rosters the `modifyAllDataGrantors` / `viewAllDataGrantors` (profiles, permission sets, AND groups) and the `overPrivilegedGrantorCount`. Also rolls in unassigned permission sets and CRUD/FLS audit totals. Answers 'who has god mode / Modify All / View All / who is an admin / who is over-permissioned'. Optional `profileFilter` (a Profile api name / label or canonical `Profile:<ApiName>` id) SCOPES the report to one profile — and is HONORED: when the named profile does NOT exist in the vault the report STOPS with a `profileFilter.found: false` result (empty findings + a caveat naming the closest existing profile), never silently dropping the filter and dumping the org-wide report (a false-premise profile name therefore yields a 'profile not found', not a misleading full report). Read-only, declared confidence (literal metadata flags, not heuristics); `limit` (default 50) caps the findings. When the vault holds a captured permission-holder aggregate, the god-mode grantors carry active-holder counts via a `dataShape` holders block (`data_snapshot`, counts only) — a god-mode permission set held by 40 active users outranks one held by none.",
    inputSchema: PERMISSION_RISK_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.permission_set_consolidation',
    description:
      "Offline, vault-only CONSOLIDATION candidates for permission sets, from DECLARED grants — 'which permission sets are redundant / duplicate / consolidatable'. Sweeps every PermissionSet, compiles each one's compact grant-key list from its `grantedBy` edges (object CRUD, FLS, Apex, Flow, custom permission) plus grant properties (system `<userPermissions>`, record-type / app / tab visibility), and flags three shapes: EMPTY (no meaningful declared grants — may be intentional or a placeholder); STRICT SUBSET (every grant of A is also in B, A ⊊ B → A is a merge CANDIDATE into B); NEAR-DUPLICATE (grant overlap ≥ a disclosed Jaccard threshold, default 0.9, with neither a strict subset — clustered by the overlap relation; exact duplicates are Jaccard = 1). `candidates[]` is a single opportunity-ranked list (biggest number of declared grants a merge could eliminate first), each entry a `strict-subset` / `near-duplicate` / `empty` shape carrying refs (`{id, grantCount, inPermissionSetGroup}`); it PAGES by `limit` (default 25, max 100) / `offset` / `nextOffset` and self-fits the response byte budget (`nextOffset` always equals `offset + candidates.length`, `byteTrimmed` flags a byte-limited page, so a cursor walk never skips a candidate). `summary` carries the complete analyzed / empty / subset / cluster counts. Optional `minOverlap` (0.5..1, default 0.9) tunes the near-duplicate threshold; `includeEmpty` (default true) toggles empty candidates. This is CANDIDATE-flagging, NOT a merge verdict, and is distinct from `sfi.permission_risk_report` (over-privilege / god-mode — how DANGEROUS a grant is, not how REDUNDANT), `sfi.unassigned_permission_sets` (WHO holds a set), `sfi.effective_permissions` (the single-container-bundle union), and `sfi.what_if_merge_profiles` (a single pairwise PROFILE what-if). HONESTY (surfaced verbatim in `boundaries[]`): a strict subset / near-duplicate is a CANDIDATE from declared grants, NEVER a proven safe merge — A may be assigned to different users or exist deliberately; base-profile redundancy and safe-to-merge are OUT OF SCOPE offline (per-user live assignment data — deferred to sfi.live_permset_holders / sfi.live_user_permsets / manual review; the tool NEVER asserts a set is redundant); an empty one is not necessarily deletable; each candidate's grant-keys are its OWN declared grants, and one that is also a group component is flagged `inPermissionSetGroup`; the Jaccard threshold value is disclosed; only retrieved permission-set metadata is analysed (an incomplete family makes a relation a FLOOR, disclosed via `coverageCaveat` / `scanTruncated`). `declared` confidence. Pure, unit-testable core (`computeConsolidationCore` / `rankCandidates`), no vault dependency.",
    inputSchema: PERMISSION_SET_CONSOLIDATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.release_readiness_report',
    // HIDDEN back-compat alias (STEP-2): the ready+blockers deploy gate folded
    // into `sfi.org_risk_report` (`gate: true` MODE). Dispatchable by name /
    // run_analysis, but un-advertised on tools/list.
    hidden: true,
    description:
      'Release readiness gate composed from org risk and coverage completeness. (Superseded by `sfi.org_risk_report` with `gate: true`.)',
    inputSchema: SYNTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_impact',
    description:
      'BFS over incoming edges from a component, up to `hops` (max 3). Returns the slice of nodes and edges that depend on the target — "what breaks if I change this?". Carries a `soundness` envelope (`complete` / `blindSpots[]` / `staticCoverage`): `complete: false` with a `dynamic-apex` blind spot listing any impacted class that builds references at runtime (dynamic SOQL / reflective describe / Type.forName / untyped JSON), so the result is never implied complete when static analysis is blind. D3: a CustomField / CustomObject root ALSO carries an `unwalked-referrer-class` blind spot (`referrerClasses[]`) — whole classes of referrer are NOT modeled as incoming edges and so are NOT walked (roll-up source coupling, layout placement, flow decision/filter reads, tab/app membership), so `complete`/`full` is never reported on their absence; "no referrers" means "not checked", not proven none (use `sfi.field_360` for reconstructed Flow decision/filter readers). R6-19: also returns `diagram` — a ```mermaid graph TD``` fence of the (already-capped) impact slice, nodes labeled `{ComponentType}: {apiName}` with the root as a circle, edges labeled by edgeType — present ONLY when the slice is at or under 30 nodes; above that, `diagram` is omitted and `diagramOmittedReason` names the actual node count (never a silently-partial diagram). R6-24 Option B: when the root is a CustomField with folded report/dashboard usage, `reportUsage` names the capped referencing report/dashboard api-names (Report/Dashboard nodes are dropped at refresh — they do not appear as impact edges).',
    inputSchema: GET_IMPACT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.blast_radius_live',
    description: "Fuse the static impact graph with LIVE record magnitude — \"what breaks if I change/remove X, and how much is at stake?\". Takes the `get_impact` slice for a CustomField/CustomObject and, when the live plane is enabled, pairs every record-bearing dependency with a live COUNT (a CustomField → non-null record count, a CustomObject → total rows; e.g. \"847 records hold a non-null value\"). Code/config dependencies (Flow, Apex, validation rules, layouts, permissions) are listed WITHOUT a count — they break too, but \"records affected\" is not their unit. Leads with a vault-staleness warning when the org is ahead of the vault, stamps `provenance: 'hybrid'` carrying both planes' freshness, and routes every live query through the session cache + per-session budget. WITHOUT consent it returns the full static impact with a caveat (provenance offline_snapshot) — the static answer is never blocked on the live plane. Counts only; never reads or stores a record row. `maxLiveCounts` caps live queries per call (default 25).",
    inputSchema: BLAST_RADIUS_LIVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_formula_references',
    description:
      'List the incoming `references` edges to a field with the source nodes and edge-level metadata (e.g., formula tokenizer properties).',
    inputSchema: FIND_FORMULA_REFERENCES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_apex_usages',
    // HIDDEN back-compat alias (STEP-2): the Apex-only view folded into
    // `sfi.find_code_usages` (narrowed to nodeTypes ApexClass/ApexTrigger + the
    // Apex edge triad — data-identical). Dispatchable by name / run_analysis and
    // the migrated gold row still resolves, but un-advertised on tools/list.
    hidden: true,
    description:
      'List the Apex source files (classes and triggers) that read, write, or call into a component. Filters incoming `readsFrom`/`writesTo`/`callsApex` edges to those originating from `ApexClass:*` or `ApexTrigger:*` nodes. `boundaries[]` carries the heuristic disclosure; an empty result adds an empty≠absent line (cross-check `find_component_usages`), never a silent empty. (Superseded by `sfi.find_code_usages`, narrowed to the Apex node types.)',
    inputSchema: FIND_APEX_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.effective_permissions',
    description: "Compute a user's EFFECTIVE access — the UNION of a profile + assigned permission sets, max-wins, with each permission attributed to the container(s) that grant it. `why_cant_user_see_record` evaluates a single record question against a bundle; nothing else rolls the containers up into one combined ability — this does. Input: `profileId` (or the natural `profileApiName` / `profileName` alias — a bare name is coerced to `Profile:{Name}`, the canonical `profileId` winning when both are given) and/or `permissionSetIds[]` (at least one). Pass an optional OBJECT scope (`object` / `objectApiName` / `objectId`) to narrow to one object (\"effective permissions for {profile} ON {object}?\"): objectPermissions, the fieldsWithFls count, and recordTypeVisibilities are filtered to it and the resolved object is echoed in `appliedScope` (systemPermissions / customPermissions / apexClasses are container-wide and stay whole); an object that resolves to nothing real in this vault is `invalid-query`, NEVER a silent org-wide dump, and a bare (no-object) call is byte-identical to before. A `PermissionSetGroup:` id may be passed in `permissionSetIds[]` — it is EXPANDED into its member permission sets (declared membership) and unioned in, so a PSG-assigned user gets a real answer (a permset reachable both directly and via a group is unioned once, not double-counted). MUTING permission sets are now SUBTRACTED: each group's grant = union(members) MINUS its muting set(s), per modeled class (object CRUD, FLS, system/user perms, custom perms, Apex-class access), BEFORE the containers union max-wins — muting is group-scoped, never org-wide, so a grant conferred by the profile or a permission set assigned OUTSIDE the group is never muted. It composes each container's outgoing `grantedBy` edges (object + field + apex + custom permission), `properties.userPermissions` (system perms), and `properties.recordTypeVisibilities` (record-type visibility). `objectPermissions[]` carries the OR'd `allowCreate`/`allowRead`/`allowEdit`/`allowDelete`/`viewAllRecords`/`modifyAllRecords` per object plus `grantedBy` (the containers contributing a surviving flag) and, when a group would-be grant was muted, `mutedBy` (the muting set(s) that denied a flag — present only when non-empty); `systemPermissions[]` lists each user-permission with its `grantedBy` (+ `mutedBy` when a group muted a would-be grant that survives elsewhere); `customPermissions[]` lists each granted custom permission with its `grantedBy` (+ `mutedBy`) + `targetMissing` (true when the granted name has no `CustomPermission` definition in the vault — managed-package / not-retrieved; declared but not resolvable, and NOT folded into systemPermissions); `recordTypeVisibilities[]` unions each container's declared record-type visibility (max-wins — visible=true wins; `<visible>` omitted in older metadata counts as visible, only an explicit false hides), each entry `{recordType, visible, grantedBy}` — record-type visibility is part of THIS union now, no longer only the separate `recordtype_availability` surface (that tool remains for the per-object grouped view); a container carrying no extracted `recordTypeVisibilities` property (a vault refreshed before record-type extraction) contributes nothing and is DISCLOSED (re-run /sfi-refresh), never fabricated as 'no record types'; `summary` reports objects / fieldsWithFls / apexClasses / systemPermissions / customPermissions / recordTypeVisibilities counts. The object list PAGES (`limit` default 100 / max 200, `offset`/`hasMore`/`truncated`). `declared` confidence. `disclosures` is explicit about the boundaries: permission-set GROUP membership IS expanded and its muting set(s) SUBTRACTED per modeled class; a muting node from a vault refreshed before (no muted-perm data) or referenced-but-absent CANNOT be subtracted and is DISCLOSED as a possible OVERSTATEMENT (re-run /sfi-refresh); record-type visibility is not mutable and is never subtracted; app/tab visibility is a SEPARATE surface (now extracted — see `app_access` / `tab_availability`), not part of this union; field-level detail is summarised (use `field_access_audit`); object permission is NOT record access (record visibility needs OWD + sharing); custom permissions are declared grants, NOT system userPermissions, so they are never double-counted. Missing containers are ignored with a disclosure; if none exist → `component-not-found`. DIRECTION: this answers WHAT a given container bundle GRANTS (vault metadata); WHICH sets/PSGs a specific USER actually holds right now is runtime assignment state — use sfi.live_user_permsets (live, read-only) and feed its grantors back into this tool for a dual-provenance answer.",
    inputSchema: EFFECTIVE_PERMISSIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.who_can_run',
    description:
      "The REVERSE of `sfi.user_ability`: given a `Flow:X` (`componentId`), which Profiles / PermissionSets grant RUN access to it (from the `flowAccess` `grantedBy` edges). `granters[]` = `{granterId, granterType, granterLabel}`, paginated; `summary.granters` is the total. `declared` confidence. `boundaryNote`: a user gains it only when ASSIGNED the container (runtime), and run needs the flow active; \"who can OPEN an app\" is `app_access` (applicationVisibilities, not a grantedBy edge); report/dashboard FOLDER access needs the live plane (folder shares aren't in the offline metadata). Phantom-aware (a flow referenced only by run grants is still answerable). Unknown flow with no run grant → `component-not-found`; non-`Flow:` prefix → `invalid-query`.",
    inputSchema: WHO_CAN_RUN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.who_can_access_object',
    description: "The REVERSE of `sfi.why_cant_user_see_record`: given a `CustomObject:X` (`componentId`), ENUMERATE which profiles / permission sets / roles / groups statically gain access to that object's records, and how. Sources: (1) OWD — a public org-wide default (`owdGrantsAllInternalUsers: true`) means every internal user reads/edits every record; (2) object permissions — Profiles/PermissionSets whose `grantedBy` edge carries `allowRead`/`allowCreate`/`allowEdit`/`allowDelete` (each CRUD bit enumerated INDEPENDENTLY — records visible per OWD+sharing) or `viewAllRecords`/`modifyAllRecords` (ALL records); (3) system god-mode — `ViewAllData`/`ModifyAllData`; (4) sharing rules — the `sharedWith` role/group targets of the object's owner & criteria rules (criteria rules cite the predicate); a shared GROUP target is expanded through `hasMember` so each member it contains — transitively through nested groups — is also listed as its own granter row (a dangling member like a Territory is listed but flagged unresolved). Each `granters[]` row has `via` (e.g. `object-permission-read`/`-create`/`-edit`/`-delete`, `view-all-object`/`modify-all-object`, `system-*`, `owner-`/`criteria-sharing-rule`), `access` (`read`/`create`/`edit`/`delete`/`all`), and `scope` (`all-records` vs `shared-records`). Because CRUD bits are orthogonal, ONE principal can emit several rows (each independently addressable by `granterId|via`): `summary.total` is the ROW count, `summary.distinctGranters` is the ACTOR count — count principals by the latter. `summary` also tallies all/shared (COMPLETE), and the list PAGES (`limit` default 120 / max 250, `offset`/`hasMore`/`truncated`). `declared` confidence. `blindSpots` discloses what a STATIC view cannot enumerate — record ownership + the role hierarchy above each owner, which records match a criteria predicate, manual/Apex-managed sharing, account-teams, and sharing sets — so absence is never overstated. When the object carries RestrictionRules, an extra blind spot + a per-row caveat on the god-mode granters disclose that ANY row (View/Modify All Data included) can be narrowed at runtime — mirroring `why_cant_user_see_record`'s `unknown` god-mode verdict on such objects. `scanTruncated: true` (with a `boundaryNote`) when a Profile/PermissionSet/SharingRule scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`), so a very large org's enumeration is disclosed as possibly incomplete rather than implied complete. Unknown object → `component-not-found`; a non-`CustomObject:` prefix → `invalid-query`. When the vault holds a captured permission-holder aggregate, each Profile/PermissionSet granter on the page also carries 'held by N active users' via a `dataShape` holders block (`data_snapshot`, counts only, stamped).",
    inputSchema: WHO_CAN_ACCESS_OBJECT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.guest_exposure_report',
    description: "\"What can UNAUTHENTICATED GUEST users see in my Experience Cloud / Site communities?\" — the audit for one of the most notorious real-world Salesforce leaks (over-permissioned site guest profiles exposing PII to the open internet). Enumerates every modeled community surface (the `Network`/`CustomSite`/`ExperienceBundle` family), resolves each site's guest profile via the `Profile:{Site Label} Profile` NAMING CONVENTION (heuristic — the XML carries no `<guestProfile>` pointer), and COMPOSES the guest profile's exposure from the existing engine: object CRUD (the profile's `grantedBy` edges), FLS on PII-classified fields (reusing `pii_inventory`'s classifier, gated on the guest ALSO having object read so a field grant without object access is not counted), Apex-class access, and the community's guest sharing rules ( `SharingRule` nodes with `ruleType:'guest'`). `findings[]` is RANKED by severity: `critical` = guest can WRITE an object carrying guest-readable PII; `high` = guest READ on a PII object OR write on any object OR editable PII field; `medium` = readable PII field; `low` = read w/o PII, Apex access, guest sharing rules. Every finding carries a REAL vault `nodeId` (CustomObject/CustomField/ApexClass/SharingRule) and PER-CLAIM confidence: the CRUD/FLS/apex GRANT is `declared`, but the guest-profile identity is `heuristic` (naming convention) — so the report `confidence` is `heuristic` and each finding carries `guestLinkageConfidence:'heuristic'`. `communities[]` (COMPLETE) carries per-site metadata — `status`, `selfRegistration` (the CRITICAL self-signup switch), `enableGuestFileAccess`, correlated `networkId`/`experienceBundleId`, and `guestProfileResolved`. `findings` PAGES (`limit` default 50 / max 200, `offset`/`cursor`/`hasMore`); `summary` holds complete per-severity counts. TWO optional, composable scope axes (the applied scope is always echoed back as `appliedScope: { community, object, mode }`, so a host never assumes a filter that was silently dropped): (1) COMMUNITY — `communityId` (`Network:X` or `CustomSite:X`; a Network id resolves through its `<site>`) or the bare `networkApiName` / `networkName` / `siteApiName` aliases; (2) OBJECT (the dominant \"guest exposure for {Object}\" shape) — `objectApiName` (bare, e.g. `Contact`) or `objectId` (`CustomObject:Contact`), which filters `findings` + each community's `findingCount` to that object's guest CRUD, its fields' FLS, and its guest sharing rules (object-independent Apex findings drop out). `componentId` is dispatched BY PREFIX: `Network:` / `CustomSite:` scopes the community; `CustomObject:` scopes the object identically to `objectApiName` (so `componentId: CustomObject:Contact` is object scope, `mode: 'object'`, NEVER the org-wide `mode: 'all'`). FAIL CLOSED: with NO `Network`/`CustomSite` modeled it reports \"no Experience Cloud surface in the vault — re-run `/sfi-refresh`\", never \"no exposure\". Honesty axis (`disclosures`): object CRUD+FLS is the DECLARED grant — actual record visibility also needs OWD + guest sharing rules (record level); Visualforce-page guest access (`<pageAccesses>`) is NOT modeled (only Apex is); an unresolved guest profile is disclosed per community, never treated as \"no exposure\". A `componentId` whose prefix is not `Network:` / `CustomSite:` / `CustomObject:` (or a non-`Network:`/`CustomSite:` `communityId`, or disagreeing selectors) → `invalid-query`, never a silent org-wide fallback; a scoped community id resolving to no modeled site → `component-not-found`.",
    inputSchema: GUEST_EXPOSURE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.why_cant_user_see_record',
    description: "Walk the Salesforce sharing cascade (OWD → PermissionGrant → SystemPermission → RoleHierarchy → OwnerSharingRule → CriteriaSharingRule → RestrictionRule → ScopingRule → TerritoryAndGuestRules → ManualSharing → SharingSets → AccountTeams) for a given object and a user's access bundle. TWO-PLANE access model: seeing a record needs BOTH (A) object-level READ CRUD (from the profile UNION any assigned permission set, or system View/Modify All Data — Edit/Delete/Create all imply Read) AND (B) record-level access. Plane A is a PRECONDITION evaluated first: a user with NO object Read is `restricted` regardless of OWD (a Public-Read OWD does NOT make a record visible to a zero-permission user), and plain object Edit/Delete is NOT a record-visibility grant — on a Private object it satisfies only the precondition, so record access still depends on OWD/sharing. Plane B is granted by: object View All / Modify All records (`viewAllRecords`/`modifyAllRecords`, the only object-perm record-sharing BYPASS), system `ViewAllData`/`ModifyAllData` (god-mode bypass), a public OWD on top of the satisfied precondition, ownership, or a sharing grant. FLS (field-level security) is irrelevant to record visibility and never enters the verdict. The TerritoryAndGuestRules stage now ENUMERATES the object's attached guest / territory / territoryGroup sharing rules: each surfaces its declared detail — id, accessLevel, Experience-Cloud site name (guest) or shared target (territory), and predicate — but the verdict stays `unknown` because applicability is record-level (existence is declarable, the share decision is not); when none attach, a single `unknown` step preserves the not-modeled disclosure (absence is never \"no access\"). Owner-rule GROUP targets are also expanded through `hasMember` so a user in a NESTED public group matches a rule that grants the enclosing group. Optional `accessLevel` (`'read'` default | `'edit'` | `'delete'` | `'create'`) picks the operation: `edit` needs a ReadWrite OWD (with object Edit precondition) or object Modify-All / ModifyAllData record bypass (a read-only path is NOT edit-capable; plain object Edit on a Private object only meets the precondition); `delete` needs FullAccess OWD / ModifyAll / ownership (sharing rules and ViewAllData never grant delete) — so this answers \"who can edit/delete this record\", not just view. `create` is a SEPARATE model that does NOT flow through OWD / sharing / role hierarchy (you don't need to see existing records to create one): it short-circuits the cascade and is `visible` only when the user has object Create permission (`allowCreate` or object/system Modify-All) AND — if the object has record types — at least one VISIBLE record type (a `RecordType` stage reads `recordTypeVisibilities`; the record-type gate is ANDed onto the permission gate, so a Create grant with no visible record type is `restricted`). So this also answers \"who can create a record of this object\". REQUIRED params: `componentId` (the object/record component, e.g. `CustomObject:Account`) and `userContext` — an object describing the user's access bundle that must carry AT LEAST ONE of `profileId`, `permissionSetIds` (string[]), `roleId`, `groupIds` (string[]); an empty `userContext` is rejected with `invalid-query`. A `PermissionSetGroup:` id may be passed in `permissionSetIds[]` — it is EXPANDED into its member permission sets (declared membership) and folded into the user's context, so a PSG-assigned user gets a REAL verdict from the grant cascade rather than `unknown`; the `PermissionSetGroup` reasoning step reports how many groups were expanded and what any muting permission set did. : a group's MUTING permission set is now SUBTRACTED from the object-CRUD PRECONDITION (plane A) — a CRUD bit (or ViewAllData/ModifyAllData) a group member grants but the group's muting set denies is NOT counted, so the verdict no longer OVERSTATES access; when muting removes the object-Read/Edit/Delete/Create the operation needs, the verdict is `restricted` and both the PermissionGrant reasoning step and a top-level `mutedBy` name the muting set(s) (muting is group-scoped — a grant from the profile or a permission set assigned OUTSIDE the group survives). Muting is NOT subtracted from the record-visibility BYPASS stages (object/system View/Modify All); a muting node from a vault refreshed before (no muted-perm data) or referenced-but-absent CANNOT be subtracted and is DISCLOSED as a possible OVERSTATEMENT (re-run /sfi-refresh) — for the full muting-correct net grant use `sfi.effective_permissions`. Returns a structured reasoning chain and an aggregate verdict (visible / restricted / unknown). Stages whose answer the metadata model cannot decide report `unknown` with an explanation — when object Read is present but only unmodeled sharing (manual / teams / sets / ControlledByParent's master sharing) could grant access, the honest verdict is `unknown`, never a flat `restricted`. Offline/vault tool — it does NOT read live user assignments; pass the user's profile/permission-set/role/group ids yourself.",
    inputSchema: WHY_CANT_USER_SEE_RECORD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.layout_for_user',
    description: "Walk the Salesforce layout-routing cascade (ProfileLookup → LayoutAssignment → RecordTypeResolution) for a given object, optional record type, and profile (`profileId` / `profileApiName` / `profileName` / `profile` — a bare api name or a `Profile:` id, interchangeable, resolved + echoed as `appliedScope`). Returns the resolved layout id (or null), the record type the cascade ended up using, and a structured reasoning trail. When the Profile node does not yet carry extracted `layoutAssignments` data (the extractor's honesty boundary), the cascade reports `unknown` with an explanation rather than fabricating.",
    inputSchema: LAYOUT_FOR_USER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.user_ability',
    description: "\"What can this Profile / PermissionSet RUN or DO?\" — beyond record CRUD (which `object_access_audit` / `why_cant_user_see_record` cover). Given a `Profile:X` or `PermissionSet:X` — via `componentId` or the natural `profileApiName` / `profileId` / `permissionSetApiName` / `permissionSetId` selector (a bare name is coerced to the container prefix; `componentId` wins; the field scope and the container are SEPARATE axes, so a profile key is never stripped by a field mention): `runnableFlows` (the `Flow:` ids the container grants run access to, via the `flowAccess` grantedBy edges, paginated); `loginRestrictions` (`ipRangeCount` + `loginHoursRestricted` scalars PLUS the full `ipRanges[]` of `{startAddress, endAddress}` windows and `loginHours[]` of `{day, startTime, endTime}` per-weekday windows — Profile-only, `applies:false` and empty lists for a permission set; for a focused login/session security audit use `profile_security`); `actionPermissions` (the run/export/transfer/convert/mass-edit class of system permissions present, filtered from `userPermissions`); and `customPermissions` ( — the custom permissions the container CONFERS via its `<customPermissions>` grants, each with `targetMissing` when the granted name has no `CustomPermission` definition in the vault; custom permissions are NOT system userPermissions, so they are not double-counted with actionPermissions). `summary` tallies runnableFlows + actionPermissions + customPermissions. Pass an optional FIELD scope (`fieldId` — `CustomField:Object.Field` or bare `Object.Field` — or `fieldApiName` + `objectApiName`) to also answer \"can this container edit {Object}.{field}?\": the response adds `fieldAccess` (`{field, readable, editable}` — the container's declared FLS on that field, edit implying read, both false = no FLS granted) + echoes `appliedScope`; an unresolvable field is `invalid-query`, never a silent field-dropped answer, and a call without the field scope is byte-identical (for the full grantor breakdown on a field use `field_access_audit`). `declared` confidence. `boundaryNote`: the user must be ASSIGNED the container to gain these (runtime, not modeled), and flow run access also needs the flow active; FLS is NOT record access (record visibility still needs OWD + sharing). `flowAccess` grant edges are extracted at every refresh (PermissionSet `<flowAccesses>`); a vault refreshed before that extraction reports no runnable flows — re-run `/sfi-refresh` rather than reading it as a verified empty. A call that names NO container (no `componentId` and no profile/permission-set selector) → a named `invalid-query`; unknown id → `component-not-found`; non-Profile/PermissionSet prefix → `invalid-query`.",
    inputSchema: USER_ABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.profile_security',
    description:
      "\"What are this profile's login & session security policies?\" — a focused security-audit surface separate from `user_ability` (which is \"what can it RUN or DO\"). Given a `Profile:X` (`profileId`; a bare apiName is coerced): `loginIpRanges[]` of `{startAddress, endAddress}` windows (declared Profile metadata, already extracted from `<loginIpRanges>`) + `loginIpRangeCount`; `loginHoursByDay[]` of `{day, startTime, endTime}` per-weekday windows (declared, extracted from `<loginHours>`'s `{day}Start`/`{day}End` children — minutes since midnight, GMT; a weekday absent from the list is unrestricted) + `loginHoursRestricted` (whether ANY login-hours window is defined, from the extracted `loginHoursDefined` flag); and `sessionSecuritySettings` (`mfaRequired` / `requiresStrongAuth` / `sessionTimeoutMinutes` from the single org-wide `SessionSettings:default` node, or `null` when that node is absent). `declared` confidence. `boundaryNote`: the user must be ASSIGNED this profile at runtime to be restricted; org-wide MFA/session settings are REFRESH-GATED — a vault built before the SessionSettings type shipped returns `sessionSecuritySettings: null` until a re-refresh pulls it. Profile-only: a `PermissionSet:` id (or any non-`Profile:` prefix) → `invalid-query` (permission sets carry no login security); unknown Profile → `component-not-found`.",
    inputSchema: PROFILE_SECURITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lightning_pages',
    description:
      "Lightning record pages (FlexiPage), both directions. Given a `CustomObject:X` (`componentId`) it returns the Lightning pages FOR that object (`pages[]` of `{flexiPageId, masterLabel, pageType}`, from the `flexiPageObject` `references` edges, paginated); given a `FlexiPage:X` it returns that page's `forObject` / `pageType` / `masterLabel`. `declared` confidence. CRITICAL honesty axis (`activationDisclosure`, always present): which profile / record type / app / form factor ACTIVATES (is served) a page is NOT in the retrieved FlexiPage metadata — it is a separate Lightning App Builder assignment — so this reports the pages that EXIST for an object, NOT which one a given user sees (`layout_for_user` covers CLASSIC layouts). Object mode also accepts the natural object aliases `objectApiName` / `object` / `objectId` (resolved and echoed as `appliedScope`). A profile* argument (`profileApiName` / `profileId` / `profileName` / `profile`) is REFUSED with `invalid-query` — profile activation is not in FlexiPage metadata, so the tool never silently strips it into a bare object inventory; pass just the object, then use `layout_for_user` (Classic) or Lightning App Builder for the per-profile page. Unknown id → `component-not-found`; a non-`CustomObject:`/`FlexiPage:` prefix → `invalid-query`.",
    inputSchema: LIGHTNING_PAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_view_sharing',
    description:
      "\"Who is this list view shared with?\" — a list view's `<sharedTo>` visibility scope (the groups/roles it shows up for in the list-view picker), now captured at extraction as `visibleTo` edges. Two modes via `componentId`: a `CustomObject:X` returns ALL of the object's list views (`listViews[]`, paginated via `limit`/`offset`), a `ListView:X.Y` returns that one. Each row: `componentId` (the ListView id), `apiName`, `filterScope` (Everything/Mine/Queue/…), `visibility` (`sharedWithGroupsRoles` | `allUsersWithObjectAccess`), `sharedToCount`, and `sharedTo[]` of `{type,name,targetId,inheritance?,synthetic?}` (Group/Role targets; `roleAndSubordinates` carries an `inheritance` marker; synthetic groups like AllInternalUsers carry `synthetic`). `summary` tallies listViews / sharedWithGroupsRoles / allUsersWithObjectAccess / distinctTargets / `directRoleShareCount` (list views with at least one `sharedTo` entry whose `type === 'role'` — direct role share, NOT roleAndSubordinates; computed over ALL list views, NOT just the current page). PAGINATION CRITICAL: `summary` totals (including `directRoleShareCount`) are always over the full object's list views; per-entry `sharedTo[].type` breakdowns (role vs roleAndSubordinates) are only in paginated `listViews[]` rows — exhaust all pages via `nextCursor` before manually counting by type. `declared` confidence. CRITICAL honesty axis (`boundaryNote`, always present): this is visibility of the saved VIEW, NOT record access — a user still needs read access to the object (use `object_access_audit` / `why_cant_user_see_record`) and the records must pass the view's filter; `filterScope` is the record filter (a separate axis), not a who-can-see control; a list view with NO `<sharedTo>` is visible to all users who can see the object (\"visible only to me\" personal views are not in deployed metadata, so absence is never \"private\"). Unknown ListView → `component-not-found`; a non-`CustomObject:`/`ListView:` prefix → `invalid-query`.",
    inputSchema: LIST_VIEW_SHARING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.app_access',
    description: "Given a `CustomApplication` (`componentId`, e.g. `CustomApplication:Sales`), return what's IN the app and WHO can use it: `navType` (Standard/Console/Classic), `tabs` (the app's `CustomTab:` ids in document order, from `belongsToApp` edges), `canOpen` (the Profiles/PermissionSets whose `applicationVisibilities` mark the app `visible: true`, paginated via `limit`/`offset`), and `defaultedBy` (the granters for which this is the DEFAULT app — complete). `summary` tallies tabs / canOpen / defaultedBy. `declared` confidence. NATURAL ARGS (APP-ACCESS-REJECTS-NATURAL-ARGS): instead of the `CustomApplication:` id you may pass an app `apiName` / `app` / `application` (a bare app name → the `CustomApplication:` node when one exists, else an app-label/api-name search) or a fuzzy `nameContains` — one match resolves and echoes `appliedScope` (`{componentId, resolvedFrom, matched}`); several return an `invalid-query` pick list (never a silent pick); none → `component-not-found`. A canonical `CustomApplication:` `componentId` call carries NO `appliedScope` (byte-identical). `boundaryNote`: who-can-open is the applicationVisibilities grant — actual access also needs the user to be ASSIGNED the profile/permission set (runtime, not modeled); if no granter carries an extracted `applicationVisibilities` the list is disclosed as 'not modeled', not a verified empty. `scanTruncated: true` (with a `boundaryNote`) when the Profile/PermissionSet scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`) — the granter list may be incomplete. App visibility (`applicationVisibilities`) is extracted at every refresh; only a vault refreshed before the P11 extraction answers 'not modeled' (re-run `/sfi-refresh`). Unknown app → `component-not-found`; non-`CustomApplication:` prefix → `invalid-query`. INVERSE direction: pass a `Profile:` or `PermissionSet:` id instead and the response answers FROM the granter's own applicationVisibilities — `openableApps[]` (visible: true) and `defaultApp` (or null), one node read; a granter without the extracted property answers \"not modeled\", never a verified empty. `PermissionSetGroup:` ids are refused with the honest union explanation (PSG visibility = union of member permission sets, not directly extracted).",
    inputSchema: APP_ACCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tab_availability',
    description:
      "Given a `Profile:X` or `PermissionSet:X` — via `componentId` or the natural `profileApiName` / `profileId` / `permissionSetApiName` / `permissionSetId` selector (a bare name is coerced to the container prefix; the object and the profile are SEPARATE axes, so a profile key is never stripped by an object mention) — list the tabs it can see: each row carries the `tab`, the verbatim `visibility` enum (`DefaultOn`/`DefaultOff`/`Hidden` on a profile; `Available`/`Visible`/`None` on a permission set), and an `available` flag normalising 'the user can reach this tab'. Pass an optional `objectApiName` / `object` / `objectId` to narrow to one object's tab (\"is Case's tab available to {profile}?\") — matched by Salesforce tab-naming convention (the object api name, or `standard-<Object>`); an object with no matching tab is an honest empty for that profile, not the whole tab dump, and the resolved subject + object are echoed in `appliedScope`. `summary` tallies total / available / hidden; the list pages (`limit` default 200 / max 500, `offset`/`hasMore`/`truncated`). `declared` confidence. `boundaryNote`: a tab being available does NOT grant object access (use `object_access_audit`), and the user must be ASSIGNED this profile/permission set (runtime, not modeled); an un-extracted `tabVisibilities` is disclosed as 'not modeled'. Tab visibility is extracted at every refresh (Profile `<tabVisibilities>` and PermissionSet `<tabSettings>` both land on `properties.tabVisibilities`); only a vault refreshed before the P11 extraction answers 'not modeled' (re-run `/sfi-refresh`). Unknown id → `component-not-found`; non-Profile/PermissionSet prefix → `invalid-query`.",
    inputSchema: TAB_AVAILABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lifecycle_process',
    description: "\"What happens when {Object}.{field} becomes {value}?\" — the existing process for a specific value or stage transition (which automations already run when a record moves into a given state, e.g. an Opportunity going to Closed Won or a Case status flip). A value / stage LIFECYCLE view, not a bare DML-event view. `order_of_execution` / `what_happens_on_save` answer \"what runs on an insert/update\"; this stitches the parts into the JOURNEY of a specific transition (Opportunity → Closed Won, a Case status flip, a record updated into a state). It COMPOSES `order_of_execution` for the transition's event (default `update`; pass `event: 'insert'` for creation) — so the chain always agrees with that tool — and ANNOTATES each step with `coupledToField` (its entry condition references the transition `field`) and `coupledToValue` (the condition expression mentions the `value` literal). `process[]` is the ordered, paginated automation chain (`limit` default 100 / max 200, `offset`/`hasMore`/`truncated`); `coupledAutomation[]` is the COMPLETE subset gated on the transition (the value-add); `summary` tallies total / coupled / field-coupled / value-coupled. `confidence: 'parsed'`. `disclosures` is explicit: conditions are LISTED not EVALUATED (whether a record matches needs record data), value coupling is a literal expression match (can miss formula-encoded values / over-match a substring), and the chain excludes manual actions, the runtime audit trail, and callouts. Parent Summary (roll-up) field recalculation IS included (, inherited from `order_of_execution`'s `post-save-rollup-recalc` phase) but capped to one level and does not expand the recalculated parent's own automation. With no `field`/`value` it returns the full chain plus a hint to pass a transition. Unknown object surfaces via the underlying order_of_execution error.",
    inputSchema: LIFECYCLE_PROCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.layout_assignments',
    description:
      "The REVERSE of `sfi.layout_for_user`: enumerate every (Profile × RecordType) assignment that targets a page layout — the question an admin asks before editing or deleting a layout. `componentId` is EITHER a Layout canonical id (`Layout:Account.Account Layout`, LAYOUT mode — assignments for that ONE layout) OR a CustomObject id (`CustomObject:Account`, OBJECT mode — assignments across EVERY layout of the object, the SAME id `sfi.lightning_pages` accepts; a `CustomObject:` id is NOT mangled into a bogus `Layout:CustomObject:X`). `mode` echoes which was used. Reads the same `properties.layoutAssignments` surface the forward tool routes through (so the two agree by construction). Each assignment carries the `profileId`, `profileLabel`, the `recordType` axis (the bare `{Object}.{RT}` form, or `null` for the object's default/master assignment), and the canonical `recordTypeId`; in OBJECT mode each row ALSO carries its own `layoutId` and the response adds `layouts[]` + `summary.layouts` (the distinct layouts of the object). `summary` reports distinct profiles + total assignments (COMPLETE, not paginated). A widely-shared standard-object layout (e.g. Account) is assigned by every profile × record type — hundreds of rows past the MCP response limit — so the inline `assignments` list PAGES via `limit` (default 120, max 250) / `offset` / `hasMore` / `truncated`. `declared` confidence. Honesty axis: CLASSIC page-layout assignments via Profiles only — Lightning record pages (FlexiPage) and the org-wide default layout assign differently and are not covered (`boundaryNote`); if no profile in the vault carries an extracted `layoutAssignments` property, `boundaryNote` discloses the result is \"not modeled\", not a verified \"no assignments\". `scanTruncated: true` (with a `boundaryNote`) when the Profile scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`) — assignments may be incomplete on a very large org. Unknown Layout OR CustomObject id → `component-not-found`; a prefix that is neither `Layout:` nor `CustomObject:` → `invalid-query`.",
    inputSchema: LAYOUT_ASSIGNMENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.integration_map',
    description:
      "Return a structured topology of the org's integration surfaces: AuthProviders, NamedCredentials, RemoteSiteSettings, CspTrustedSites, ExternalDataSources, ExternalServices, ConnectedApps, NetworkAccess entries, plus the cross-type `references` edges connecting them (e.g., ExternalDataSource → AuthProvider). Optional `filter` narrows the result to one architectural cut (auth / sites / sources / services / access); default `all` returns every category. This map is ORG-WIDE (`appliedScope.mode: 'all'`): it cannot scope to one object or component — an `objectApiName` / `object` / `objectId` / `componentId` argument is REFUSED with `invalid-query` (the integration surface is not indexed by the SObject it touches), never silently answered whole-org. For callouts / connectors tied to a specific object use `find_code_usages`; for the URL surface use `endpoint_catalog`.",
    inputSchema: INTEGRATION_MAP_INPUT_SCHEMA,
  },
  {
    name: 'sfi.event_subscribers',
    description: "Given a Platform Event id (`CustomObject:{ApiName}__e`), list every subscriber (ApexTrigger, ApexClass, Flow) that emits an incoming `listensTo` edge into the event. OMIT `eventId` for CATALOG mode: every Platform Event in the org with its subscriber count (`events[]`) — answers \"what platform events does this org publish?\" (then `subscribers` is `[]` and `eventApiName` is `null`). Single-event mode returns each subscriber's identity, the emitting extractor, and edge-level subscription metadata, and now also returns `publishers` (the Flow/Apex code that EMITS the event, from modeled `writesTo` edges); catalog mode adds a per-event `publisherCount`, surfacing published-but-unsubscribed events. Honest empty list when no subscribers exist; `invalid-query` when a supplied id is not a Platform Event canonical form. P3b: programmatic `EventBus.subscribe(...)` registrations in Apex (ApexClass / ApexTrigger) are now recognized heuristically when the FIRST argument is a STATIC, resolvable channel string literal that names a real Platform Event (`__e`) — these surface as subscribers via an extractor-emitted `listensTo` edge (the same edge family as the R3 trigger/flow paths, so no module-header contradiction). Dynamic / computed channel args (a variable, method call, or concatenation) mint NO edge and remain invisible, as do managed-package listeners. `boundaries[]` carries the heuristic-detection disclosure; an empty subscriber list adds an empty≠absent line (CDC/dynamic/managed subscriptions not modeled), never a silent empty.",
    inputSchema: EVENT_SUBSCRIBERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.guidance',
    description:
      "General Salesforce best-practice guidance — the `knowledge` plane for greenfield / New-Org questions that have NO org-specific answer (Flow vs Apex, order of execution, governor limits, async Apex, trigger frameworks, bulkification, Apex testing, callouts, SFDX, unlocked packages, profiles vs permission sets, OWD/sharing, standard vs custom objects, naming, sandboxes). With `topic` (a key like `flow-vs-apex`, or a phrase that loose-matches) it returns a curated summary plus links to official Salesforce docs; without `topic` it lists available topics. Explicitly NOT specific to this org (see `disclosure`) — it points to authoritative docs and never fabricates vault data.",
    inputSchema: GUIDANCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_code_usages',
    description:
      "List the code source files (ApexClass, ApexTrigger, LightningComponentBundle, AuraDefinitionBundle, VisualforcePage, VisualforceComponent) that read, write, call, or reference a component. Subsumes the Apex-only view: narrow `nodeTypes` to `['ApexClass','ApexTrigger']` (+ the Apex edge triad) for the classic Apex-source answer. Filters incoming `readsFrom`/`writesTo`/`callsApex`/`references` edges to those originating from one of the six code node types; optional `nodeTypes` narrows to a single producer (e.g., `['LightningComponentBundle']` for LWC-only). LWC apex-import callsApex edges are `declared`; LWC field reads, Aura field accesses, and VF field touches are `heuristic`; VF controller/extension references are `declared`. `boundaries[]` always carries the heuristic-scanner disclosure; an EMPTY result adds an explicit empty≠absent line (no code usages found is NOT proof nothing uses it — cross-check `find_component_usages`), never a silent empty. Emits an always-on pagination envelope (`totalCount`/`offset`/`limit`/`hasMore`/`nextOffset`); a truncated page also returns a `nextCursor` to resume.",
    inputSchema: FIND_CODE_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lookup_record',
    description: "Given a CustomMetadataRecord or CustomSettingRecord canonical id (e.g., `CustomMetadataRecord:Marketo_Api_Setting__mdt.Default`), return the record's label, protected flag, parent type ApiName, and the full per-field value list. Each value carries `field`, `value`, `valueType`, and `isMasked`; managed-package masked content surfaces as `{ value: null, isMasked: true }` (the R2 extractor honesty axis — values masked by Salesforce as the literal `***` are NOT fabricated). `invalid-query` when the id does not start with one of the two record-type prefixes; `component-not-found` when the record id is unknown to the vault.",
    inputSchema: LOOKUP_RECORD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_field',
    description: "Given a CustomField canonical id (e.g., `CustomField:Account.Industry` or `CustomField:Marketo_Api_Setting__mdt.Number_Of_Retries__c`), return the field's label, description, type, required flag, and — for Picklist / MultiselectPicklist fields — `picklistValues`: the DECLARED value set from the field's inline value-set definition (the literal answer to \"what values are in this picklist?\"). Each entry is an object `{ value, isActive, label?, default? }`: `isActive: false` marks a DEACTIVATED value — RETAINED but not selectable for new records, though existing records may still hold it — so inactive values are LISTED-and-marked, never dropped and never presented as current (H10). (Vaults refreshed before this change stored bare value strings; those normalize to `isActive: true`.) `picklistValues` is `null` for non-picklist fields; for picklists whose value set is a GlobalValueSet reference, the tool FOLLOWS the field's `usesValueSet` edge (vaults refreshed at 0.1.10+) and returns the value set's declared values with `picklistValuesSource` citing the GlobalValueSet id — GVS-resolved values carry the SAME honestly-captured `isActive` (and `label`/`default` when the source recorded them) as an inline definition, never filtered and never UNVERIFIED. Only when the link cannot resolve (older vault, value set not retrieved) does the response fall back to `null` plus `picklistValuesNote`, so `null` never reads as \"no values\"; an EMPTY array is a real zero-value inline definition. When the parent type ends in `__mdt` (CustomMetadataDefinition), the response additionally carries `recordValues`: one entry per CustomMetadataRecord child of the parent that holds a value for this field (records lacking a value are omitted — the honesty axis). Set `includeRecordValues: false` to suppress the cross-record enumeration even for `__mdt` parents; set `true` to force it for non-`__mdt` parents (yields an empty array since those parents have no CustomMetadataRecord children).",
    inputSchema: EXPLAIN_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.safe_to_delete_field',
    description: "Is this field safe to delete, and what's the evidence? The BA's due-diligence check before retiring a field \"no one uses\" — it gathers every dependency (validation rules, flows, formulas, roll-up summaries, automation conditions, layouts, Apex, LWC) so you can prove whether anything still relies on it before signing off. Given a CustomField canonical id (`CustomField:{Object}.{Field}`), composes every incoming dependency edge into a confidence-weighted deletion verdict: `safe` (no incoming edges), `risky` (Apex/LWC references that need spot-checking — Apex evidence includes parsed-confidence AST edges covering dot-access AND fields referenced only inside inline static SOQL or constant-string Database.query literals, plus heuristic regex-scanner matches; string-BUILT dynamic SOQL stays invisible), `blocking` (declared Flow/ValidationRule/formula dependencies the platform will refuse to drop, plus two coupling classes declared on OTHER components: `rollup` — a roll-up summary on the PARENT object that aggregates, anchors on, or filters by this field, with each example naming its own `rollupRole` (`summarizedField` / `summaryForeignKey` / `summaryFilterItem`) so the citation is the coupling that actually exists; and `condition` — a criterion that TESTS this field, minted from any of the seven wired firer families: Flow entry criteria, Flow decisions, validation-rule conditions, workflow-rule criteria, and approval-process, assignment-rule, auto-response-rule and escalation-rule criteria. Each condition example carries the `firerId` of the component whose criteria it is (the example `id` is a synthetic ConditionalContext node), so an approval-process blocker is cited as an approval process rather than as a Flow. Conditions are listed, never evaluated: the vault does not know whether a runtime record satisfies them. ONE REFERRER IS COUNTED ONCE: a validation rule whose `errorConditionFormula` both references and tests a field reaches it by TWO edges tokenized from that one string, so it is reported once under `validation` (the truthful label — not `formula`, which means \"another formula FIELD references this\") and the folded row is disclosed on that example as `alsoVia: ['condition']` rather than counted again. Additive conditions never fold: a rule testing a field its direct reference could not resolve, or a Flow that WRITES and separately TESTS one field, each keep their own category, count and citation. Formula examples likewise carry the `traversalPath` (`Parent__r.Field__c`) when the reference was resolved through a cross-object relationship rather than tokenized directly), `unknown` (only unrecognised edges), or `review` (NOT proven safe — incomplete coverage, OR a standard / managed-package field with no node of its own but referenced by edges: it is reviewed from those edges with a not-modeled caveat instead of returning component-not-found; B12). Each category in the `reasoning` array carries its referrer count, up to 5 example referrers (full list via `sfi.get_impact`), and a per-category note explaining the honesty boundary. When an incoming edge carries `properties.confirmedByApi` (stamped by `sfi refresh --with-tooling-api` MetadataComponentDependency enrichment), reasoning entries/examples surface `apiConfirmed: true` as additive evidence — it does not change the verdict cascade; the tool never calls the Tooling API at query time. Pass `format: 'checklist'` to also get a `checklist` — a \"before you delete X\" Markdown checklist rendered from the verdict + reasoning, with the `coverageCaveat` surfaced FIRST (never footnoted) and removal steps ordered most-severe-first. It PROPOSES a checklist for a human and never deletes or writes to the org. Pass `format: 'proposal'` (Finding #35) to also get a `proposal` — a deploy-ready, LOCAL artifact for the field: a populated `destructiveChanges.xml` (the field) + an empty `package.xml`, each led by an evidence comment carrying the verdict, every dependency finding, the vault `sourceTreeHash`, and a REVIEW-before-deploy banner. sfi returns the file STRINGS only — it NEVER deploys, writes, or connects to the org; a human feeds the files to their own deploy tool (Gearset / Copado / `sf project deploy`). Validated against `docs/schemas/proposal.schema.json`. Emitted for EVERY verdict (a `blocking` field's proposal leads with `verdict: blocking` so it never reads as safe). When the vault holds captured data-shape facts, the response embeds the field's sampled fill rate as a stamped `data_snapshot` `dataShape` block — CONTEXT ONLY: the verdict is computed purely from the metadata graph and never moves toward safe on a sampled observation. When the heuristic PII recognizer classifies the field pii/sensitive, the response carries a `piiCompliance` block (non-verdict-lowering compliance escalation, with classification/category/message) and the checklist surfaces it FIRST, above the coverage caveat and verdict; a PII field never reads as a bland safe. Heuristic — absence of the block is NOT a clearance. HYBRID: when the static verdict would be `safe`, pass `liveEnabled: true` (or grant consent) to cross-check the field's LIVE production population before trusting that verdict — real data despite zero static references may be written by dynamic Apex, an integration, or another blind spot the scanner cannot see. A `populatedCount > 0` DOWNGRADES the verdict from `safe` to `review` and attaches a `livePopulation` evidence block (`objectApiName`/`fieldApiName`/`totalCount`/`populatedCount`/`populationRate`/`liveQueriedAt`); a zero-population result leaves `safe` standing but still attaches the evidence block, confirming the cross-check ran. The live plane is NEVER a hard dependency — offline stays fully functional; when it is off, unavailable, or the query errors (budget exhausted, org unreachable), the response fails soft to the disclosed static verdict with a `trust.limitations` line naming the missing evidence ('static-only verdict; live population not checked'). UPGRADE PATH: the roll-up coupling, condition and resolved formula-traversal edge families were added in 0.3.0, so a vault BUILT by an older sf-intelligence does not hold them and their absence proves nothing. When `manifest.version` is older than the running plugin the response carries a `builderVersionCaveat` (also mirrored into `trust.limitations` and surfaced above the verdict in the checklist) and an otherwise-`safe` verdict is reported as `review` — NOT proven safe — until `sfi refresh` rebuilds the vault. The coverage caveat cannot catch this: those metadata families WERE retrieved; the extractor that reads them did not exist yet.",
    inputSchema: SAFE_TO_DELETE_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unused_components',
    description:
      "Scan the vault for components with no incoming USAGE edges (excluding the parentOf containment edge and grantedBy access grants — a Profile / PermissionSet granting access is not usage, so a component nobody references is still unused). Default `types` is a curated subset (CustomField, ApexClass, ApexTrigger, Flow, PermissionSet, Queue, Group, Role, EmailTemplate, Letterhead, GlobalValueSet, CustomLabel, StaticResource, ValidationRule, WorkflowRule); supply `types` to narrow, or the SINGULAR `type` / `componentType` / `typeFilter` alias for one family (e.g. \"unused WebLinks\") — an unknown type is `invalid-query`, never silently answered with the default family. Pass `object` / `objectApiName` to narrow to one object's children (e.g. \"unused WebLinks on Contact\"); a type with no object parent honestly returns empty under an object filter rather than the org-wide list. The response echoes `appliedScope` ({ types, object, mode }) so a host can confirm the scope actually applied. Test ApexClasses (properties.isTest === true) are NEVER flagged as unused. Each entry carries a per-type `invisibleReferencesNote` enumerating what the v1.x extractors cannot see (dynamic SOQL, reflective Apex, permission-set assignments, runtime callouts). `byType` carries the full per-type counts (not the truncated slice); `truncated` is true when the global slice was trimmed to `limit`, and a truncated page returns a `nextCursor` to resume. When any REFERRER family (Reports, Flows, layouts, LWC, …) has incomplete coverage — errored retrieve, scoped refresh, or an in-progress staged build — the response carries a `coverageCaveat` naming the families: \"unused\" then means \"no RETRIEVED metadata references it\", never proven absence.",
    inputSchema: UNUSED_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_dependency_cycles',
    description:
      "Architect tool: find cyclic dependency clusters in the org's Apex. Runs Tarjan's strongly-connected-components over `callsApex` edges among ApexClass + ApexTrigger nodes and returns every cyclic cluster (SCC of size > 1) plus self-recursive classes (size-1 SCCs with a self-edge), ordered by size descending. Optional SCOPE: pass `componentId` (`ApexClass:`/`ApexTrigger:` id or bare class name) to narrow to the cluster CONTAINING that component (honest empty when it is in no cycle — never the org list), and/or `nameContains` to keep only clusters with a member id matching the substring; both AND together, the SCC scan stays org-wide but the returned clusters + counts reflect the scope, and `appliedScope` ({ component, nameContains, mode }) is echoed. Each `cycles[]` entry carries the member component ids, the cluster `size`, and `selfRecursive`. `summary` reports apexNodesScanned, callsApexEdgesConsidered, cyclicClusters, largestClusterSize, and truncated. Honesty axis: `callsApex` is heuristic static analysis — dynamic dispatch (Type.forName, interface polymorphism) is invisible, so the reported set is a LOWER BOUND; a cluster means the listed components statically reference one another in a loop (investigate fragility / deploy-order / test-isolation), not proven runtime recursion. `limit` (default 50, max 200) caps the returned clusters; a truncated page returns a `nextCursor` to resume.",
    inputSchema: FIND_DEPENDENCY_CYCLES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.apex_test_coverage',
    description:
      "Developer tool: map test-class references to the Apex they exercise. With `classApiName`, returns the test classes that statically reference it (`target.coveringTests`) and a `status` of has-test-references / no-test-references-found. Without it, returns the org-wide `untestedClasses` backlog — non-test ApexClasses with NO incoming `callsApex` from any test class (the gap behind the Salesforce 75%-coverage deploy gate). `summary` reports testClasses, nonTestClasses, classesWithTestReferences, classesWithoutTestReferences, truncated. Honesty axis: this is STATIC reference coverage, NOT runtime line-coverage % — a referencing test may not exercise every line and dynamic invocation is invisible, so 'untested' means 'no static test reference found', not proven zero coverage; the authoritative number comes from running the org's Apex tests. `limit` (default 100, max 500) caps the org-wide list; a truncated page returns a `nextCursor` to resume.",
    inputSchema: APEX_TEST_COVERAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.automation_build_advisor',
    description:
      "Decision-support tool: before an admin/architect builds automation on an object, brief them on what already runs there and the org-specific risks of adding more. PER-OBJECT mode (`objectApiName`): returns `existingAutomation` (record-triggered Flows with recordTriggerType+status, ApexTriggers, ValidationRules, WorkflowRules that target the object), `risks` (flow-ordering when ≥2 active record-triggered Flows share the object since Salesforce does not guarantee their order; mixed-trigger-and-flow when both paradigms are present; validation-load when ≥5 active rules; greenfield when none), and synthesised `recommendations`. ORG-WIDE GAP mode (`scope: 'flow-only-objects'`, no object): returns the set difference — org-custom objects with ≥1 ACTIVE record-triggered Flow but ZERO active Apex triggers — each annotated with its master-detail relationshipRole (master-detail-child / junction / lookup-only) and `masterDetailParents`, plus a `summary` (orgCustomCount, masterDetailChildCount, junctionCount). Use it for 'which objects run Flow logic with no trigger guard?' / cascade-delete exposure. Standard + managed-package objects are excluded. Supply EXACTLY one of objectApiName or scope. Does NOT build anything — it arms the decision. Honesty axis: every entry is a real vault node, conditions are not evaluated, and runtime Flow Trigger Order / dynamic invocation are out of scope. Pair with sfi.what_happens_on_save for the full ordered sequence.",
    inputSchema: AUTOMATION_BUILD_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.automation_collisions',
    description:
      "Field-level write-collision + save-recursion cycle detector for ONE object — 'is my org fighting itself on this object?'. Where automation_build_advisor flags OBJECT-level hazards (multiple flows, mixed paradigms), this tool looks at what those automations actually WRITE. Given `object`, walks the SAME `triggersOn` firer set (record-triggered Flow, ApexTrigger, WorkflowRule) build-advisor gathers, plus each firer's `writesTo` edges. `collisions[]`: 2+ DISTINCT automations writing the SAME field on the SAME execution path — a silent last-writer-wins fight Salesforce does not arbitrate; each writer carries componentType, active, confidence (`parsed` for declared Flow/WorkflowRule XML, `heuristic` for the Apex scanner), and timing (before-save / after-save / post-save, or before-delete when modeled). Collisions are partitioned by execution PATH (`collisionPath`): save-timing writers collide with each other, while a before-delete Flow runs on the DELETE path and is bucketed separately (`collisionPath: 'delete'`) — it is NEVER reported as colliding with a save-timing writer, so a delete-path collision is never a save collision. The finding's `weakestConfidence` is the WEAKEST across its writers. `cycles[]`: a depth-capped (4 hops) walk for a write path that returns to the queried object — `kind: 'self-write'` for the classic same-object after-trigger/workflow-field-update re-trigger (the depth-1 case), `kind: 'multi-object'` for an A-writes-B / B-writes-A loop, each with the full real-node `path`. Conditions on every automation are NOT evaluated (two writers with mutually exclusive entry criteria still collide in this report); Salesforce's own recursion GUARDS (a Flow's 'do not re-trigger' setting, workflow re-evaluation limits) are not modeled — a listed cycle is a POTENTIAL loop, not proof it fires. Only ApprovalProcess field updates and Apex writes performed by a helper class the trigger CALLS (not the trigger itself) are out of scope for this v1. `limit` (default 50, max 200) caps each list independently with a `boundaries[]` truncation note; inactive automation is still LISTED (never silently dropped) but lowers the finding's severity. Does NOT build or fix anything — read-only diagnosis.",
    inputSchema: AUTOMATION_COLLISIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.ai_exposure_report',
    description: "AI-exposure audit (the flagship): 'what data can my org's own AI see?'. Composes the extracted Agentforce GenAI surface (GenAiPromptTemplate grounding fields, and the agent action tree GenAiPlannerBundle → GenAiPlugin → GenAiFunction → the ApexClass/Flow it invokes and the fields THAT code reads/writes, plus any prompt template an action invokes) AND Einstein Bot / Agentforce agent definitions (Bot context-variable field mappings + BotVersion → GenAiPlannerBundle planner reach rolled up to the Bot) with the same `pii-detection` recognizer that backs sfi.pii_inventory, run over every exposed field. Returns `surfaces[]` (per AI surface: the object/fields it exposes, each with its heuristic PII classification, category, and the `via` mechanism) and — the actionable headline — `piiExposures[]`, the (surface, field) pairs classified pii/sensitive (e.g. 'your Reservation agent's prompt template grounds on Contact.SSN__c — PII'). No args audits org-wide; `objectApiName` narrows to fields on one object. `limit` (default 50, max 200) caps each list with a truncation note. FAIL-CLOSED: when the vault carries ZERO GenAI/Bot nodes the disposition is `no-ai-surface-modeled` with a message naming BOTH possibilities (the org has none, OR the vault predates GenAI/Bot extraction — re-run /sfi-refresh); it never implies an empty org. Honesty axis: the AI-surface wiring is DECLARED metadata, NOT a runtime trace (it does not prove the agent ran or that a grounded field was populated); PII classification is HEURISTIC (a no-signal field reads `public`); a field the vault does not model (a standard field, or an object not retrieved) is `unknown`, never silently 'not PII'; indirect exposure via an action's Apex is heuristic static analysis (dynamic access invisible); Bot dialog/intent trees are not walked.",
    inputSchema: AI_EXPOSURE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.apex_build_advisor',
    description:
      "Decision-support tool: before a developer writes Apex, brief them on what the org's existing Apex teaches. Synthesises `governorPitfalls` (the soql-in-loop / dml-in-loop risks ALREADY in the org — the patterns to avoid), `testExpectations` (the 75% production-deploy coverage gate + the org's untested-class backlog), `flsCrudNorms` (whether existing Apex enforces CRUD/FLS and how often it skips it), and — when `objectApiName` is given — `similarLogic` (the Apex that already touches that object, so you reuse instead of duplicate), plus synthesised `recommendations`. Pass a CLASS SCOPE (`componentId` = `ApexClass:{name}`/`ApexTrigger:{name}`, or bare `classApiName`/`apiName`) to brief ONE class — its pitfalls, coverage, CRUD/FLS — with `appliedScope` echoed; an unresolved/non-Apex scope is a named error, never a silent org-wide answer; omit for the org-wide briefing. Composes governor_limit_risks + apex_test_coverage + crud_fls_audit; each section degrades to null with a note if its scan can't run. Does NOT write code (backend knowledge layer). Honesty axis: heuristic static analysis over the last refresh — 'what the org's Apex shows', not a guarantee about new code.",
    inputSchema: APEX_BUILD_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_change_advisor',
    description: "Decision-support tool: before changing a field, see the whole blast radius in one briefing. Name the field with `fieldId` OR any interchangeable selector — `componentId`, `fieldApiName`, or `apiName` (precedence fieldId > componentId > fieldApiName > apiName); a bare `Object.Field` and a `CustomField:Object.Field` id both resolve, and naming no field returns a named `invalid-query`. Synthesises `makeRequired` (verdict + create-path impact count from what_if_make_field_required), `deletion` (verdict + blocking/risky dependency counts from safe_to_delete_field), and — when `newType` is given — `changeType` (compatibility + verdict + reference count from what_if_change_field_type), plus combined `recommendations`. Does NOT change anything (backend knowledge layer). Honesty axis: inherits the composed tools' boundaries — dataflow into Apex insert/update and dynamic/reflective field access are invisible, so verdicts mean 'investigate', not guarantees. `component-not-found` when the fieldId is not a CustomField in the vault. HYBRID: pass `liveEnabled: true` (or grant consent) and `makeRequired` additionally carries the field's LIVE production null-rate (`liveNullRate`), and the `recommendations` cite the live record population alongside the vault impact (with a staleness lead when the org is ahead of the vault).",
    inputSchema: FIELD_CHANGE_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_field_value',
    description:
      "Value-change impact (Data Steward / Identity & Integration lens): given a CustomField `fieldId`, what breaks if its stored VALUE changes — NOT its schema (use what_if_change_field_type for type/required/delete). Returns impact buckets (identity / integration-key / uniqueness / automation / save-pipeline / display), an overall severity, honesty-surface disclosures, and recommended pre-change checks. Identity / key / uniqueness verdicts come from the field's own metadata (externalId / unique / idLookup, identity catalog) — so a value change is flagged even on a field with ZERO references (e.g. a SAML federation key). Derived fields (formula / roll-up / auto-number) return mutable:false and re-route to their source. Honesty axis: the vault cannot see external upsert systems, the IdP side of SSO, or dynamic / managed-package code; automation buckets surface declarative value-literal couplings (the value a rule compares this field to); Apex literal comparisons remain invisible. Optional `newValue` adds a targeted collision/acceptance check. `component-not-found` when the fieldId is not a CustomField in the vault.",
    inputSchema: WHAT_IF_CHANGE_FIELD_VALUE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.value_change_audit',
    description:
      "Batch value-change audit (Data Steward lens): given an `object` and optionally a list of `fields`, risk-ranks the impact of changing each field's stored VALUE — the portfolio version of what_if_change_field_value. Name the object with `object` or `objectApiName`, or pass a `fieldId` (`CustomField:Object.Field`) whose parent IS the object (its field also seeds a one-field audit); `fieldApiName` names a single field. A `fieldId` whose parent disagrees with an explicit `object` returns a named `invalid-query` (never a silent mismatch); naming no object returns `invalid-query`. WITHOUT `fields`, auto-detects the value-sensitive fields on the object (upsert keys via externalId/unique/idLookup, identity-catalog fields, name-lexicon matches). Each row carries an overall severity, role, top impact reasons, confidence, and disclosure count; `verbosity:'detail'` inlines full buckets. Returns a severity summary + global disclosures; unknown explicit fields come back in `notFound`. This answers 'tell me if changing any of these has an impact on {object}'. Honesty axis: auto-detect can miss a value-sensitive field carrying none of those signals; per-row blast radius inherits what_if_change_field_value's boundaries (external upsert systems, IdP side of SSO, dynamic/managed-package code invisible).",
    inputSchema: VALUE_CHANGE_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_drift_check',
    description:
      "Offline↔live contradiction detection (requires the opt-in live plane). For `objectApiName`, compares the fields the vault recorded at the last refresh against a LIVE read-only describe and reports `onlyInVault` (fields in the snapshot the live org no longer returns — deleted/renamed/permission-hidden since refresh; the high-signal STALE indicator), `onlyInLiveCustom` (custom fields added live since refresh, filtered to `__`-suffixed to avoid standard-field noise), `inSync`, and a plain-language `interpretation`. The only check that uses BOTH planes at once; never mutates the org. Honesty axis: the vault models extracted custom fields + standard object definitions (not standard fields), so onlyInVault is the trustworthy drift signal. Pass `liveEnabled:true` or set SFI_LIVE_PLANE_ENABLED.",
    inputSchema: LIVE_DRIFT_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_changed_since_refresh',
    description: "'since my last refresh, which component TYPES changed?'. Reads the continuous-learning store's MOST RECENT refresh entry and returns the non-zero per-type `changedTypes` (signed: + added / − removed), `changedTypeCount`, `changedEdges`, `lastRefreshedAt`, and a plain-language `interpretation`. Takes no arguments. Read-only. Honesty axis (load-bearing): these are the changes the LAST REFRESH brought INTO the vault vs the prior snapshot — NOT what changed in the live org SINCE (an offline vault cannot know that). For the real org-side drift count, run `sfi.live_stale_check`. `available:false` for a vault with no recorded history.",
    inputSchema: WHAT_CHANGED_SINCE_REFRESH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_history',
    description:
      "Continuous-learning store: the org's refresh timeline. Every `sfi refresh` appends its per-type component/edge deltas to meta/history.jsonl; this returns that timeline (most recent first) plus `refreshCount`, `firstRefreshedAt`, `lastRefreshedAt`, and `netComponentChange` (total components last − first). Lets answers reason over 'what was true before + what changed' instead of only the latest snapshot. Read-only. Honesty axis: only covers refreshes since the store shipped (single-refresh/older vaults yield a short or empty timeline); each entry's deltas are as-recorded vs the prior refresh, not recomputed. `limit` (default 50, max 500).",
    inputSchema: ORG_HISTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.diff_snapshots',
    description: "Compare two captured vault snapshots and report the structural diff. `fromLabel` and `toLabel` name persisted snapshots under `{vaultRoot}/snapshots/`; the special value `'current'` for `toLabel` triggers a transient capture of the live graph (no persisted artefact). BOTH labels are OPTIONAL — omit them to auto-diff the TWO MOST-RECENT persisted snapshots (a one-label call defaults only the missing side). Returns `added` (ids in `to` but not `from`), `removed` (ids in `from` but not `to`), and `modified` (ids present in both whose canonicalized properties or structural identity changed). Each entry carries the component's `id`, `type`, and `apiName`. `summary` reports the full per-bucket counts; the emitted arrays are trimmed to `limit` (default 100, max 500) and `truncated` flips true when the total exceeds `limit`. When a diff is large, ONE list (the largest) is paged via `nextCursor`; the other two are disclosed by full count in `summary` + `otherSections` (echo `nextCursor` back as `cursor` to advance). Pass `summary: true` (, the folded-in `churn` view) for a compact digest: top-level `addedCount`/`removedCount`/`modifiedCount` scalars + a `topChurn` top-25 mixed changed-id list + a `disclosure`, riding along with the full slices. Edges are NOT surfaced in the output — re-query a specific component pair via `sfi.compare_components` for edge-level detail. `invalid-query` when a named label is unknown or fewer than two snapshots exist for an auto-diff.",
    inputSchema: DIFF_SNAPSHOTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.churn',
    // HIDDEN back-compat alias (STEP-2): the structural churn digest folded into
    // `sfi.diff_snapshots` (`summary: true` MODE, with labels defaulting to the
    // latest two). Dispatchable by name / run_analysis, un-advertised on tools/list.
    hidden: true,
    description:
      'Compare two persisted snapshots and return added/removed/modified counts plus top churn ids. (Superseded by `sfi.diff_snapshots` with `summary: true`.)',
    inputSchema: CHURN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.trend',
    description:
      "Timeline of persisted snapshot captures. Default (no `metric`): component/edge counts per label. Pass `metric: 'securityScore'` to trend the capture-time security posture score (0–100, higher is better — graded from permission-risk findings at snapshot create / refresh auto-capture). Pre-upgrade snapshots lack the metrics bag and return value: null with an honest disclosure.",
    inputSchema: TREND_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_components',
    description:
      "Compare two live-graph components by canonical id, returning the structural diff. `fieldDiffs` enumerates the union of top-level identity fields (type, apiName, label, parentId) and one-level-deep flattened properties; each entry carries `valueA`/`valueB`/`status` where status is `same` / `different` / `a-only` / `b-only`. `edgeDiffs` enumerates the symmetric difference of outgoing and incoming edges matched on `(direction, target, edgeType)`; each entry carries `inA` / `inB` flags. Cross-type comparisons (e.g., Profile vs PermissionSet, ApexClass vs Flow) are allowed; `typesMatch: false` signals the consumer should expect a property diff dominated by `a-only` / `b-only` entries. Unknown ids surface as `component-not-found`. Operates on the current live graph, never on snapshots. Pass `format: 'ps-diff'` to also get a `psDiff` — a deploy-tool-friendly Permission-Set / Profile grant diff (added/removed object/field/class grants from grantedBy edge presence + userPermissions set-difference, bucketed by category with a summary), validated against `docs/schemas/ps-diff.schema.json`. It PROPOSES a diff to feed Gearset/Copado and never writes to the org; an existing grant's read↔edit LEVEL change is not surfaced (the vault models those grants as edges and skips all-false grants — see the psDiff `disclosure`).",
    inputSchema: COMPARE_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.export_manifest',
    description: "Group a set of canonical component ids into a well-formed `package.xml` snippet a human can hand to Gearset / Copado / `sf project deploy`. Takes `componentIds` (non-empty array of `Type:Member` ids) and an optional `apiVersion` (default 62.0); returns `packageXml` (the manifest text — members de-duplicated and sorted per type, the `<name>` mapped to the deployable metadata-type name so e.g. `WorkflowRule`→`Workflow`, `VisualforcePage`→`ApexPage`), a `summary` (typeCount / memberCount / per-type rollup), and `skipped` (ids that are malformed or synthetic graph nodes like `ConditionalContext`, with the reason). It PROPOSES a manifest and NEVER deploys or writes to the org; it does not verify the ids exist (it packages exactly what you pass — see the `disclosure`).",
    inputSchema: EXPORT_MANIFEST_INPUT_SCHEMA,
  },
  {
    name: 'sfi.pii_inventory',
    description: "Enumerate every CustomField in the vault, classify each with the `pii-detection` recognizer (which inspects API name, declared data type, and description text), then emit a structured inventory. Filter by `classification` (`'pii' | 'sensitive' | 'all'`) and/or `category` (`'identifier' | 'contact' | 'financial' | 'health' | 'all'`); both default to `'all'`. Each emitted field carries its classification, category, data type, description, and a plain-English `reason` naming the rule that fired. `summary` reports the full per-classification and per-category counts across the matched set. The response is paginated: `limit` (default 200, max 500) and `offset` (default 0) page through the inventory, and a per-response ~38 KB byte budget trims the `fields` slice further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more matching fields remain, with `nextOffset` carrying the cursor to advance (plus a `note` when a page was byte-trimmed). Pass `format: 'csv'` (, default `'json'`) to get `csv` (this page's rows as CSV, with the freshness + heuristic-recognizer disclosures embedded as `#`-prefixed comment lines) instead of `fields` (`fields` is `[]` on a csv page — the row data is not duplicated in both encodings); `summary`/pagination fields are unchanged. The recognizer is heuristic — a field with no name-token match and no description signal classifies as `public` even if it stores PII at runtime; `EncryptedText`-typed fields ALWAYS classify as `sensitive` because the encryption type IS the declaration.",
    inputSchema: PII_INVENTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_access_audit',
    description: "Given a CustomField canonical id (`CustomField:{Object}.{Field}`), cross-walk every Profile and PermissionSet that grants access to the field via incoming `grantedBy` edges. `grants` carries one entry per (Profile or PermissionSet, permission level) pair where permission is `'read'` / `'edit'` / `'unknown'` (the last meaning the older extractor did not populate the per-flag axis). `summary` reports the unfiltered counts split four ways (profilesWithRead, profilesWithEdit, permSetsWithRead, permSetsWithEdit). `viaApexAccess` enumerates ApexClass / ApexTrigger nodes with incoming `readsFrom` / `writesTo` edges to the field — a user with execute permission on one of those classes may access the field through that code path even when the metadata-grant audit reports no direct grant. Optional `permissionType` (`'read' | 'edit' | 'all'`, default `'all'`) narrows the emitted `grants` array. A standard or managed-package field with no node of its own but referenced by fieldPermissions / Apex edges is still audited from those edges with `notModeled: true` + a `notModeledNote` (grants are accurate; data type / formula are unavailable and PII is inferred from the field name) — only an id with no node AND no inbound references is `component-not-found` (B12). Honesty axis: this is the.0 permission-grant-level audit; criteria-based and account-team sharing rules are deferred to.1. Invalid prefix surfaces as `invalid-query`. The `update` block answers \"who can UPDATE this field\": `fieldUpdatable` is false for formula / auto-number / roll-up-summary fields (value is derived); `canUpdate` lists the grantors with FLS-edit on the field AND edit on the PARENT OBJECT (the intersection — FLS-edit alone is not enough; object-edit counts explicit object Edit / object Modify All grants AND the `ModifyAllData` system permission, which implies object-edit on every object but does NOT bypass FLS); `recordEditDependency` reminds that edit access to the specific RECORD is also required (use `why_cant_user_see_record` with `accessLevel: 'edit'`).",
    inputSchema: FIELD_ACCESS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.object_access_audit',
    description: "Given a CustomObject canonical id (`CustomObject:{ApiName}`), enumerate every Profile and PermissionSet that grants OBJECT-level access via incoming `grantedBy` edges. Each `grants` entry carries the granter + its CRUD bits (`allowCreate` / `allowRead` / `allowEdit` / `allowDelete`) and the object-level `viewAllRecords` (\"View All\") / `modifyAllRecords` (\"Modify All\") flags. PermissionSetGroup-conferred access is ALSO surfaced: a PSG has no `grantedBy` edge of its own, so for each granting permission set the tool REVERSE-looks-up the groups that contain it and emits an additional `granterType: 'PermissionSetGroup'` row copying the member's CRUD flags — included as a DISTINCT access path (intentionally NOT deduped against the direct row; both are honest paths, and the PSG counts toward `summary.distinctGranters`). Muting permission sets are DISCLOSED in `note`, never subtracted. `summary` tallies how many granters hold each bit. This is the object-level counterpart to `field_access_audit` (field FLS) — and it is OBJECT permissions, NOT record-level visibility: for \"can a user see/edit a specific RECORD\" (OWD + sharing + role hierarchy) use `why_cant_user_see_record`; the two compose (a user needs the object grant here AND record access there). A standard / managed-package object with no node of its own but referenced by permission edges is still audited with `notModeled: true` + a note; an id with no node AND no inbound grants is `component-not-found`. Confidence: `declared` (object permissions are declared metadata). A non-`CustomObject:` prefix is `invalid-query`.",
    inputSchema: OBJECT_ACCESS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.recordtype_availability',
    description:
      "Given a Profile or PermissionSet canonical id (`Profile:{Name}` / `PermissionSet:{Name}`) — or the natural `profileApiName` / `profileId` / `permissionSetApiName` / `permissionSetId` selector (a bare name is coerced to the container prefix; the object and the profile are resolved as SEPARATE axes, so a profile key is never stripped by an object mention) — report which record types the user can CREATE / see, grouped by object, from the granter's `recordTypeVisibilities`. Pass an optional `objectApiName` / `object` / `objectId` to narrow to one object (\"record types on Case for {profile}?\") — an unmatched object is an honest empty for that profile, not the whole map; the resolved subject + object filter are echoed in `appliedScope`. Each record type carries `visible` (a visible record type is one the user can pick when creating a record — i.e. it gates \"who can create a record\" together with the object's Create permission from `object_access_audit`) and `default` (the user's default for that object); each object surfaces its `defaultRecordType`. `summary` tallies objects + visible record types. Confidence: `declared` (record-type visibility is declared profile metadata). `boundaryNote`: when the granter carries no extracted `recordTypeVisibilities` property (a pre-extraction / stale vault), the empty result is disclosed as \"not modeled\" (re-run `/sfi-refresh`), NOT a verified \"no record types\" — like `tab_availability`. A non-Profile/PermissionSet id is `invalid-query`; an unknown id is `component-not-found`.",
    inputSchema: RECORDTYPE_AVAILABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_overview',
    description:
      "Return a structured org-tour snapshot — the buyer-priority #9 headline answer for the new-to-this-org persona. Composes existing graph queries into ten coordinated views: per-ComponentType counts; top 10 CustomObjects ranked by inbound non-parentOf edge count (proxy for the central data model); top 10 ApexClasses ranked by inbound `callsApex` edges (proxy for the hot-path code); top 10 Profiles ranked by outgoing `grantedBy` edges (v1.x proxy for broadest profiles since user-assignment data isn't extracted); integration-surface summary (NamedCredential, AuthProvider, RemoteSiteSetting, ExternalDataSource, ExternalService, ConnectedApp + total); automation summary (WorkflowRule, ApprovalProcess, Flow, ApexTrigger + active ratio); frontend summary (LWC, Aura, VF page, VF component + legacy VF debt ratio); legacy-debt indicators bucketed into `low | medium | high` migration-candidate; top 5 ApexClasses by source bytes/line count; and the naming-convention recognizer output. Takes no arguments. Honesty axis: every \"top X\" is a heuristic proxy — should be cited as \"suggested starting point\", not \"authoritative ranking\". When the vault holds captured data-shape facts (`refresh --with-data-shape`), the response embeds `dataShape.recordCounts` — stamped approximate counts for the top objects (`data_snapshot`; storage-level, never a live read).",
    inputSchema: ORG_OVERVIEW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.domain_clusters',
    description:
      "Cluster the org's CustomObject + ApexClass + Flow nodes into SUGGESTED domain groupings using a greedy shared-edge-density algorithm. Pairs candidate components, computes density as `|shared neighbors| / max(degree(A), degree(B))`, and groups candidates whose density meets the `minDensity` threshold (default 0.3, range [0.0, 1.0]). Each cluster is named after its highest-degree CustomObject (\"{ApiName}-centered domain (suggested grouping)\") so the heuristic provenance is visible in the label itself. Returns up to `limit` clusters (default 10, max 50), sorted by member count DESC, plus an `unclustered` count of candidates that didn't meet the density bar with anyone. Pass a SEED (`componentId` / `seedComponentId` / `seed` — a canonical `Type:` id or bare api name — or an `objectApiName` / `object` / `objectId`, honored identically as a `CustomObject:` seed) to answer \"which domain owns {X}?\": the response narrows to the single cluster CONTAINING that node (or an honest empty `note`) and carries `appliedScope: { seed, mode: 'seeded' }` — never silently dropped into the org dump. Each cluster lists up to 40 `members` with the true `memberCount` + `membersTruncated` (so one large domain can't blow the response), and a per-response ~36 KB byte budget trims the cluster count further if needed (with a `note`) so the result never trips the global ~45 KB MCP response limit. When a cluster has more than 40 members, that cluster is paged via `nextCursor` (echo it back as `cursor` to walk its members); `candidateTruncated` flags a >500-per-type candidate scan. Honesty axis (load-bearing): clusters are HEURISTIC — they reflect topology, not semantics. A real org's domain boundaries are decided by humans; this tool surfaces \"these components share many edges\" as a starting point for further investigation, never as a confirmed domain assignment.",
    inputSchema: DOMAIN_CLUSTERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.changed_since',
    description: "Enumerate every vault node whose `lastModifiedDate` is at or after `since` (ISO 8601 — date-only `YYYY-MM-DD` or full UTC timestamp; the natural token `last-refresh` / `last refresh` / `last_refresh` / `refresh` (separator-insensitive) is ALSO accepted and resolves to the vault's `refreshedAt`, echoed back as `since` — for the component TYPES the last refresh itself brought in, use `what_changed_since_refresh`). Optional `types` narrows the scan; default scans every ComponentType. Optional `limit` (1-500, default 100) truncates the response; a truncated page returns a `nextCursor` to resume. Each entry carries `id`, `type`, `apiName`, `lastModifiedDate`, and `lastModifiedBy: { id, name }`. The output's `unenrichedCount` reports how many nodes (within the requested types) carry `lastModifiedDate: null` — these are the nodes the offline DX-source extractor produced without freshness data. Honesty axis (load-bearing): a non-zero `unenrichedCount` means the answer is PARTIAL. Run `sfi refresh --with-tooling-api` to enrich the freshness fields via the Tooling API integration; the tool remains fully functional against an un-enriched vault (returns `changed: []` plus the full `unenrichedCount` so consumers see the gap rather than assuming nothing has changed). the R2 Tooling API enricher covers ApexClass, ApexTrigger, Flow, Layout, CustomField, and ValidationRule; future + R3 expands coverage to the remaining types.",
    inputSchema: CHANGED_SINCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.last_modified',
    description: "Given a canonical componentId (e.g., `ApexClass:AccountController`, `CustomField:Account.Industry`, `Flow:Lead_Nurture`), return the component's freshness fields: `lastModifiedDate` (ISO 8601 or null), `lastModifiedBy: { id, name }` (or null), and `apiVersion` (number or null). The output carries an explicit `enriched: boolean` honesty flag — `true` when at least one freshness axis is populated (either from the `properties.lastModifiedDate` / `properties.lastModifiedBy` overlay written by the Tooling API enricher, OR from the legacy top-level `lastModifiedDate` field that some DX-source extractors emit pre-enrichment); `false` when every axis is null. When `enriched: false`, the `disclosure` field carries the verbatim recommendation: \" Tooling API enrichment has not run for this vault. Run `sfi refresh --with-tooling-api --target-org <alias>` to populate lastModifiedDate / lastModifiedBy / apiVersion for the enriched types.\" Honesty axis: the Tooling API enricher covers ApexClass, ApexTrigger, Flow, Layout, CustomField, and ValidationRule; other ComponentTypes return `enriched: false` until a future enrichment pass extends coverage. `lastModifiedBy` is the user who last DEPLOYED the change — not necessarily the original author. `component-not-found` when the id is unknown to the vault.",
    inputSchema: LAST_MODIFIED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_happens_on_save',
    description: "What ALREADY runs when a record on this object is created or updated — every existing automation (flows, triggers, validation rules, duplicate rules, workflow, approvals, assignment rules) that fires on save, in the order it fires. Use it before building a new automation to check what's already there and whether your new process would duplicate or collide with an existing one. Also the answer to informal asks like 'what fires / runs when I save an Account', 'everything that touches X on save', 'we keep hitting record-lock errors — what's colliding on this object', 'any automation on X I should know about before adding more', 'will this get blocked as a duplicate', 'what rollup fields update when I save this' (for WHICH automation is risky, use automation_risk_report instead). Produce the documented Salesforce order-of-execution (SOE) instantiated for THIS org and the given DML event on the target object. Walks the canonical SOE phases in order — before-save-flows (before-save record-triggered Flows — `triggersOn` edge `triggerType` RecordBeforeSave — which run FIRST, ahead of before-triggers; insert/update only), pre-save-validation (ValidationRules), duplicate-rules (DuplicateRules parented to the object, insert/update only — each step carries `duplicateRuleOperations` (the effective `Allow`/`Block`/`Alert`/`Report` set for this event) and `blocksOnSave`, plus the referenced `MatchingRule` ids via `actions`), pre-save-triggers + after-triggers (ApexTriggers whose `events` includes a matching `before <event>` / `after <event>` lifecycle entry), save (a documented placeholder for system validation + DB write), post-save-flows (record-triggered AFTER-save Flows whose `recordTriggerType` matches the event), post-save-workflows (WorkflowRules whose `triggerType` matches), post-save-assignment (Lead/Case AssignmentRules + AutoResponseRules + EscalationRules parented to the object), post-save-approval (ApprovalProcesses parented to the object), post-save-rollup-recalc (parent Summary/roll-up-summary CustomFields that aggregate this object, found via the CustomField `summaryForeignKey` property — fires on EVERY DML event, capped to ONE level, does not expand the parent's own automation), and post-save-async (ApexClasses dispatched via `dispatchesAsync` from any trigger above). Only ACTIVE automation is listed as execution steps — Draft/Obsolete Flows and active:false rules/processes (including DuplicateRule's `isActive`) are omitted from `soe` and surfaced in `inactiveConfigured` when present. Each step carries the firer's id/type/apiName, the gating `firesWhen` ConditionalContext when one exists, and an actions array enumerating the firer's outgoing edges (excluding structural parentOf/triggersOn/firesWhen). Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them. Workflow field updates can re-fire before/after-update triggers (a second pass); the composition lists each automation once. A workflow rule's time-dependent actions (workflowTimeTriggers) are SCHEDULED for a record-level offset the offline vault cannot evaluate; the rule is listed once in the synchronous post-save-workflows phase and its time-delayed actions are NOT claimed to fire at save. Roll-up recalculation is capped to one level — a grandparent's own rollup on the recalculated parent is not walked — and does not expand the parent's own triggers/flows/workflows. Entitlement-process and milestone-type metadata is modeled elsewhere in the vault (EntitlementProcess/MilestoneType, queryable via get_component / get_edges, including each milestone's declared target minutesToComplete), but this composition does not simulate entitlement milestones as an order-of-execution phase — live on-track/breached status against those target minutes is live, per-record data this offline vault cannot hold; when the target object has an active EntitlementProcess, the response carries an `entitlementProcessNotes` entry naming it — a disclosure-plus-pointer, not a simulated phase. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope. Every response also carries `conceptReasoning` (DEFAULT ON; pass `includeConceptReasoning: false` to skip it): the deterministic concept-rule engine (`sfi.interpret`) run over this component, returning CITED claims on the shared EvidenceEnvelope v2 shape plus a `completeness` digest that keeps four states apart — rules that FIRED, rules EVALUATED against this component that matched nothing, rules PROVABLY inapplicable to this component type, and rules that could NOT be evaluated (the vault lacks their metadata, or their bind shape could not be proven inapplicable). Read `completeness.noRuleCoversComponentType` FIRST: when true, NOTHING was checked and an empty `claims` list is silence, never a clean bill of health. Its bytes are RESERVED from the response budget before the rest of the answer is fitted, and its claim list is capped for size — `sfi.interpret` is the uncapped surface. Because this tool's order-of-execution payload is budget-bound, that reservation can cost extra per-step action trimming; when it does, the existing truncation disclosure names reasoning's share and how to re-query without it.",
    inputSchema: WHAT_HAPPENS_ON_SAVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.why_field_changed',
    description:
      "Trace every writer to a CustomField. Name the field with `fieldId` (`CustomField:{Object}.{Field}`), a `componentId` (a `CustomField:` id resolves to that field; a `CustomObject:` id scopes the object but must be paired with a field), or `objectApiName` + `fieldApiName` — the same identifiers a support host reaches for. Walks every incoming `writesTo` edge to the resolved field and surfaces each writer with its identity (`id`/`type`/`apiName`), its edge-level confidence (`declared` for metadata-declared writes — Flow recordCreates/Updates, WorkflowRule field-update actions; `parsed` for formula-tokenizer references; `heuristic` for Apex-scanner-emitted writes that may include false positives), the gating `firesWhen` ConditionalContext when one exists, and (for ApexTrigger writers) the trigger's lifecycle events. Each writer carries a `runnable` flag + declared `status` partitioning ACTIVE automation from dead automation (non-Active Flows / inactive rules / Inactive triggers / test-only Apex are `runnable:false` — listed for completeness, never the sole live suspect), and Active-Flow field writes made via an `<assignToReference>` the graph never stamped as a primary edge are folded in from the same supplemental source scan `sfi.field_360` uses (heuristic, `source: flow-field-writers-scan:*`). Returns a categorisation summary (`declaredCount` / `heuristicCount` / `runnableCount` / `nonRunnableCount` / `supplementalCount`); when EVERY candidate writer is non-runnable a `note` says so plainly rather than let a host read dead automation as the live cause. When a scope alias (`componentId`/`objectApiName`/`fieldApiName`) was passed, `appliedScope` (`{ component, mode: 'component' }`) echoes the resolved field. Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them; heuristic-confidence Apex writes need spot-checking before refactoring. An object-only, mis-prefixed, or disagreeing scope surfaces as a NAMED `invalid-query` (never a silent org-wide fallback); unknown but well-formed ids surface as `component-not-found`.",
    inputSchema: WHY_FIELD_CHANGED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.order_of_execution',
    description: "Emit the generic Salesforce order-of-execution (SOE) tree instantiated for THIS org's target object across every supported DML event (insert / update / delete / undelete; upsert is a client-side composition of insert + update). Sibling of `sfi.what_happens_on_save` without the event filter — returns the same per-phase step shape (including the leading `before-save-flows` phase for before-save record-triggered Flows, the `duplicate-rules` phase, and the `post-save-rollup-recalc` phase — see that tool's description for both), but as a per-event map (`byEvent.{insert|update|delete|undelete}`) carrying every potential ACTIVE automation per event. `duplicate-rules` appears on insert/update only; `post-save-rollup-recalc` appears on every event (a roll-up's underlying child record set changes on insert/update/delete/undelete alike). Draft/Obsolete Flows and active:false rules/processes (including DuplicateRule's `isActive`) are omitted from per-event `soe` and listed once in `inactiveConfigured` when present. Each per-event payload mirrors `what_happens_on_save`: phase + stepIndex + componentId/Type/apiName + optional `firesWhen` ConditionalContext + actions array (plus `duplicateRuleOperations`/`blocksOnSave` on a DuplicateRule step). Use this to render the full lifecycle map; use `what_happens_on_save` when the caller knows the specific DML event to focus on. Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them. Workflow field updates can re-fire before/after-update triggers; the composition lists each automation once. A workflow rule's time-dependent actions (workflowTimeTriggers) are SCHEDULED for a record-level offset the offline vault cannot evaluate; the rule is listed once in the synchronous post-save-workflows phase and its time-delayed actions are NOT claimed to fire at save. Roll-up recalculation is capped to one level and does not expand the parent's own automation. Entitlement-process and milestone-type metadata is modeled elsewhere in the vault (EntitlementProcess/MilestoneType, queryable via get_component / get_edges, including each milestone's declared target minutesToComplete), but this composition does not simulate entitlement milestones as an order-of-execution phase — live on-track/breached status against those target minutes is live, per-record data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    inputSchema: ORDER_OF_EXECUTION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.record_creation_paths',
    description:
      "\"How do records of this object get created?\" — the record-provenance trace an admin needs to answer \"how did this record get here?\". For an object (`objectApiName` = api name like `Case` or the canonical `CustomObject:Case`), lists every automation that INSERTS records of it — Flows whose `writesTo` edge is tagged `operation: recordCreate` — plus the triggers that fire on it (`triggersOn` edges), each with source id/type and edge confidence. Read-only, offline. HONESTY (verbatim, surfaced ALWAYS): creators are FLOW record-creates ONLY — Apex DML inserts (`insert x;` static AND `Database.insert` dynamic) are NOT modeled, so an object created only by Apex reports **0 creators**; cross-check Apex before concluding nothing creates it. `limit` (default 100, max 500) caps both returned lists — `creatorCount`/`triggerCount` are always the FULL counts, and a cut list is disclosed via `creatorsTruncated`/`triggersTruncated` (no cursor; raise `limit` to see the tail). Complements `sfi.what_happens_on_save` (the save-time automation tree) by answering the narrower who-inserts-this question.",
    inputSchema: RECORD_CREATION_PATHS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_flow',
    description: "Explain what a Flow does in plain business terms — what it is FOR, when it runs, and what it changes. The go-to answer for \"what does this flow do\", \"what is this automation for\", \"walk me through this process\", or \"explain the {Name} flow\". Given a Flow canonical id (`Flow:{ApiName}`), return a structured narrative payload that the caller (Claude / an explainer skill) composes into a natural-language explanation. The payload covers: identity (apiName, label, status, processType), trigger info (triggerType, the resolved `triggersOn` CustomObject, and the list of `firesWhen` ConditionalContexts gating the trigger), action calls (outgoing `callsApex` edges with each target's ApexClass id + type), subflow calls (: outgoing `references` edges with `referenceKind: 'subflow'` — the declared `<subflows>` calls — each naming the target `Flow:{flowName}` and whether it `resolved` in the vault; a dangling managed/uncaptured subflow surfaces `resolved: false`, never fabricated), record lookups (outgoing `readsFrom` edges collapsed by target object with per-object filter counts), record writes (outgoing `writesTo` edges classified by `operation` into `create | update | delete`), and decisions (the `properties.conditions[]` mirror surfaced one row per condition with the rendered expression text). Subflow calls were previously unmodeled and invisible here; the only STILL-invisible nested-flow path is the Apex `Flow.Interview` invocation (not a declared `<subflows>` edge). A `conditionsRuntimeNote` flags that the trigger/decision conditions are the statically-declared criteria (heuristic), NOT a runtime trace — whether a path executes is data-dependent and is not evaluated. The tool does NOT compose prose — see the `disclosure` field. For the FULL structure (every canvas element by its REAL name + the complete element-to-element connector graph of what runs next, decision rule branches, loops, formulas, and variables), call `sfi.flow_graph` — this tool is a business SUMMARY, not the raw graph. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: EXPLAIN_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.flow_graph',
    description:
      "The FAITHFUL, LOSSLESS structural graph of a Flow — every canvas element with its REAL <name>, the full element-to-element connector graph (what runs next), decision rules, assignment items, record-op filters, loops, formulas, variables, subflows, actions, and the <start> element with its entry criteria + scheduled paths. This is the tool for \"show me the structure of <Flow>\", \"what are the branches / decisions in <Flow>\", \"trace the connectors\", \"what elements does <Flow> have\", or \"give me the full element graph\" — where `sfi.explain_flow` gives a plain-business SUMMARY (and historically renamed decisions to condition-N, collapsed conditions to the word \"and\", and emitted ZERO connectors), flow_graph exposes the RAW graph so the host LLM composes the answer. `flowRef` accepts a canonical `Flow:{ApiName}` id, a bare Flow API name (fuzzy-resolved; an AMBIGUOUS bare name returns candidates as a success envelope, never a silent pick), or a Flow record id (300…/301… — fails closed with an actionable message unless a Tooling-API id index exists). The Flow source is read ON DEMAND from the vault and projected; nothing is persisted. Each `connectors[]` edge carries `from`, `to`, and `kind` (`immediate` for the start's first element, `default`, `rule` with the decision outcome `ruleName`, `fault`, `nextValue`/`noMoreValues` for a loop's two branches, `scheduled` with the `scheduledPathName`), plus `isGoTo` for reconnect / loop-back edges; `connectors[]` is authoritative and the per-element `connectsTo` fields are conveniences. Subflow `resolved` is overlaid from the vault (a dangling managed/uncaptured subflow surfaces `resolved: false`, never fabricated). HONESTY (spec §4.3, verbatim in `disclosure`): NO runtime inference — reachability, dead-branch detection, and ordering are NOT computed here (that is the host LLM's or `flow_trace`'s job); any canvas-element type the parser does not model lands in `unmodeled[]` by name, never silently dropped. Large flows: `include` narrows to a subset of body sections (`connectors|decisions|assignments|recordOps|formulas|variables|loops|actions`) and `element` returns the subgraph for ONE element (it + its immediate connectors + neighbors); any narrowing is DISCLOSED in a `narrowing` block (with `omittedSections`), and the central byte budget truncates disclosed, never silent. Invalid `Type:` prefix or a record id without an index → `invalid-query`; an unknown name / non-Flow → `component-not-found`.",
    inputSchema: FLOW_GRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.nonselective_soql',
    description:
      "Flag NON-SELECTIVE SOQL — a WHERE clause with a full-table-scan / timeout shape at large data volume. The first INDEX-AWARE static analysis of Apex: for each inline `[SELECT …]` statement in every non-test class / trigger it walks the WHERE clause (parser-grade, over the ANTLR parse tree) and scores each predicate's field against an index set — THIS org's declared CustomIndex metadata plus unique / externalId / lookup fields, unioned with a curated standard-index table (Id, Name, audit fields, RecordTypeId, OwnerId, `<Relationship>Id` foreign keys). Rules: `nonselective-non-indexed-filters` (HIGH — no predicate references an indexed field, so the read cannot narrow by index), `leading-wildcard-like` (MEDIUM — `LIKE '%foo'` defeats any index), `negative-operator-only` (MEDIUM — the sole filters are `!=` / `<>` / `NOT IN` / `EXCLUDES`), and `no-where-clause` (MEDIUM — an unbounded read). An equality / range / IN filter on any indexed field (or a foreign-key relationship traversal) makes the statement at-least-potentially selective and it is NOT flagged for the core rule. `classes` are per-component entries (`{ componentId, type, apiName, findings: [{ rule, severity, sObject, location, reason }] }`) sorted by componentId; `byRule` / `byObject` / `totalFindingCount` are the full pre-slice counts; `limit` (default 50, max 200) + `offset` / `nextOffset` self-fit the class page to the byte budget. HONESTY: a STATIC SHAPE, never the Salesforce optimizer's runtime verdict — the optimizer weighs actual record counts the vault cannot know, so a non-selective-shaped read on a SMALL table is fine; record counts are unknown offline. Predicate fields/operators are `parsed`; the index set is `declared` + standard-index knowledge. Dynamic `Database.query(str)` / string-built reads are INVISIBLE (a recall gap); an unparseable file is a named `soundness` blind spot; test classes are excluded. This is the SELECTIVITY axis, a distinct question from the in-transaction limit scan.",
    inputSchema: NONSELECTIVE_SOQL_INPUT_SCHEMA,
  },
  {
    name: 'sfi.flow_bulkification_audit',
    description:
      "Flag Flows that perform a record Create / Update / Delete or a Get Records lookup INSIDE a Loop body, plus filterless Get Records anywhere — the Flow-side complement of `sfi.governor_limit_risks`, which scans only ApexClass / ApexTrigger source and never sees Flows. For each Flow it walks the declared connector graph, computes each Loop's body (the elements reachable from its `nextValueConnector` before control returns or exits via `noMoreValuesConnector`), and reports each record element sitting inside it. Rules: `dml-in-loop` (a create / update / delete per iteration, HIGH), `get-records-in-loop` (a lookup per iteration, HIGH), and `filterless-get-records` (a Get Records with no filter / where clause — an unbounded read, MEDIUM). A record element in nested loops is attributed to the innermost. `flows` are the per-Flow entries (`{ componentId, apiName, risks: [{ rule, severity, location, loop, object, explanation }] }`) sorted by componentId; `totalRiskCount` / `byRule` are the FULL pre-slice counts; `limit` defaults to 100 (max 500) and slices over FLOWS, with `offset` / `nextOffset` paging the rest. HONESTY: findings are read from the declared connector graph (confidence: declared, NOT heuristic like the Apex-source scan); the verbatim boundary is 'iteration count unknown at rest' — a Loop may run 0 or many times, so this is a static Flow-shape smell, not a proven runtime breach. A Flow whose `.flow-meta.xml` is missing or unparseable is a named `soundness` blind spot (kind `unparsed-flow`), never silently dropped — an empty result for it is 'not checked', not 'clean'.",
    inputSchema: FLOW_BULKIFICATION_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.flow_trace',
    description:
      "Honest PROJECTION of a Flow over a caller-supplied record state — the \"what happens to THIS record\" debugger. Given `flowRef` and a `recordState` field-value map (e.g. `{ \"Status__c\": \"Active\", \"Amount__c\": 10 }`), it walks the Flow's DECLARED graph from `<start>` and returns WHICH PATH executes (`path[]` — the ordered elements, each decision with its `matchedRule` + per-condition evaluation) and WHAT it writes (`writes[]` — each `FieldWrite` with `object`/`field`/`value`/`valueKind`/`viaElement`/`persists`). This is the tool for \"what happens to this record in <Flow> if Status is Active\", \"trace <Flow> with these field values\", \"which branch runs in <Flow> when <field> is X\", \"what does <Flow> write when …\", or \"simulate <Flow> for a record where …\" — where `sfi.flow_graph` gives the raw STRUCTURE and `sfi.explain_flow` the plain-business summary, flow_trace evaluates the tractable common subset over your state. Optional `priorState` supplies `$Record__Prior` for `ISCHANGED`/`PRIORVALUE`; `maxSteps` (default 500) guards loops/cycles. It is NOT a Salesforce runtime (verbatim in `disclosure`): it never executes Apex, callouts, DML, or subflows, and never reaches across to other automation's order-of-execution. A branch that depends on data NOT in `recordState` is `unknown`, NEVER assumed — when the executed path hits such a decision, an Apex/invocable action, a subflow, or an unmodeled (wait/dynamic) element, the walk STOPS honestly with `stoppedReason:'unevaluated-branch'` and the element is listed in `unevaluated[]` with a `why`. Entry criteria are evaluated first (`entered` + `entryEvaluation[]`); a false result stops with `stoppedReason:'no-entry'`. `assumptions[]` records honest gaps (e.g. a loop collection not supplied is \"assumed empty\"; a record lookup's results are unknown). `persists` mirrors the Bug-3 precondition — an in-memory `$Record.<field>` assignment reaches the database only when the flow also performs a whole-record `$Record` update (before-save flows persist automatically); record-op writes are real DML and always persist. `flowRef` resolution + failure modes are identical to `sfi.flow_graph` (canonical id / bare name / record id; ambiguous bare name → candidates as a success envelope, never a silent pick; invalid `Type:` prefix or index-less record id → `invalid-query`; unknown name / non-Flow → `component-not-found`).",
    inputSchema: FLOW_TRACE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.flow_fault_audit',
    description:
      "Which Flows have a DML/action element with NO fault path — the flow error-handling hygiene sweep. Reads the fault coverage the Flow extractor records per node (`faultableElementCount` / `elementsWithoutFault` / `hasUnhandledFaults`) and flags flows where a faultable element (a create/update/delete/action element that can throw) has no fault connector, sorted worst-first. Each flagged flow carries a `faultSurface` — `screen` (a screen flow shows the running user an error screen) or `transactional` (an autolaunched/record-triggered flow, including before/after-save, rolls back the whole transaction and raises a surfaced runtime error). Read-only, offline. IMPORTANT HONESTY (verbatim): an unhandled fault is **surfaced, not silent** — it is UNHANDLED (surfaced and uncaught), never suppressed; adding a fault path lets you replace the default surfaced error with a graceful, retryable message, it does not change WHETHER errors surface. A vault built before the extractor captured fault coverage reports `propertyAvailable: false` (re-`/sfi-refresh` to populate) — honest, never a false zero. `limit` (default 100, max 500) caps the returned worst-first list — `flowsWithUnhandledFaults` and the element totals stay FULL counts, and a cut list is disclosed via `truncated` (no cursor; raise `limit` to see the tail); an extreme vault that saturates the internal flow-scan ceiling is disclosed via `scanTruncated`, never silently undercounted. Optional object scope (`objectApiName` / `object` / `objectId` / `CustomObject:` `componentId`) is HONORED: the sweep narrows to record-triggered flows that RUN ON that object (`triggerObject`) and echoes `appliedScope` — screen / autolaunched flows have no single object and are excluded under scope; an object absent from the vault is refused with `invalid-query`. A bare call stays org-wide and byte-identical.",
    inputSchema: FLOW_FAULT_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_apex_method',
    description: "Given an ApexClass or ApexTrigger canonical id (`ApexClass:{ClassName}` or `ApexTrigger:{TriggerName}`), return a structured narrative payload for the explainer. The payload covers: identity (apiName, type, status, apiVersion, modifiers, lineCount, sourceBytes), the async classifiers (`isQueueable`, `isSchedulable`, `isBatchable`, `hasFutureMethod`, `hasInvocableMethod`, `hasAuraEnabledMethod`, `isRestResource`), the `isTest` flag, every outgoing `callsApex` edge (target id + target ApiName), every outgoing field-access edge (`readsFrom` and `writesTo` merged into one `fieldAccess` row per field with `accessType: 'read' | 'write' | 'both'`; field accesses whose receiver is an Apex `this`/`super` member or an un-type-resolved local variable are segregated into `unresolvedFieldAccess` as raw `receiver.field` tokens — NOT real object fields, mirroring `unresolvedCallTargets` for calls), and the R2 `qualityIssues` property mirror — the structured findings (`rule` / `severity` / `location` / `explanation`, the same objects `governor_limit_risks` / `code_quality_audit` surface), empty array when the vault pre-dates. A deterministic `sharingSemantics` block answers \"does this run with sharing?\" from platform rules, not the common myth: `declared` (the source sharing keyword, or null when none), `effectiveModel` (`inherits-caller` when NO keyword on a synchronous entry — a no-keyword top-level class does NOT default to `without sharing`, it inherits the CALLER's context; `system-context` when NO keyword on async Apex — batch/schedulable/queueable/future runs in system mode invoked by the platform with no caller to inherit, so record sharing ends up unenforced because of system-context execution, NOT a `without sharing` default), `runsAsSystem` (true for async entries — they run as the system, never impersonating the user who submitted/scheduled the job), and a verbatim `note`. CRUD/FLS are a separate concern and need explicit checks regardless of the sharing model. `methodName` is accepted but surfaced verbatim — operates at class level; method-level granularity is deferred to. Honesty axis: `Structured narrative; Claude composes prose`. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`. Every response also carries `conceptReasoning` (DEFAULT ON; pass `includeConceptReasoning: false` to skip it): the deterministic concept-rule engine (`sfi.interpret`) run over this component, returning CITED claims on the shared EvidenceEnvelope v2 shape plus a `completeness` digest that keeps four states apart — rules that FIRED, rules EVALUATED against this component that matched nothing, rules PROVABLY inapplicable to this component type, and rules that could NOT be evaluated (the vault lacks their metadata, or their bind shape could not be proven inapplicable). Read `completeness.noRuleCoversComponentType` FIRST: when true, NOTHING was checked and an empty `claims` list is silence, never a clean bill of health. Its bytes are RESERVED from the response budget before the rest of the answer is fitted, and its claim list is capped for size — `sfi.interpret` is the uncapped surface.",
    inputSchema: EXPLAIN_APEX_METHOD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_formula',
    description: "Tokenize a Salesforce formula expression and return a structured narrative payload for the explainer. Accepts EITHER `formulaExpression` (an inline formula string) OR `fieldId` (a canonical CustomField id, e.g. `CustomField:Account.AnnualRevenue__c`): when `fieldId` is supplied the handler looks the field up in the vault graph, extracts its `formula` property, and runs the existing explain logic — `parentObjectApiName` defaults to the object inferred from the id (overridable). Returns `component-not-found` when the field has no formula (stored/writable field) or is not in the vault; returns `invalid-query` when neither input is supplied. The payload covers: every function call the formula uses (with a hand-curated one-line signature description per the vendored Formula.md), every field reference the tokenizer extracts (with `path` carrying the raw text and `toId` resolved against `parentObjectApiName` for single-segment refs — null when no parent context is supplied for an unscoped ref), literal counts (one row per counted numeric / string literal; tokenizer counts but doesn't extract values, so `value` is `null`), a `hasConditionalLogic` flag (true when IF / CASE / AND / OR / NOT appear), and the maximum parenthesis nesting depth as a complexity signal. Invalid formulas DO NOT raise an error envelope — `parseError` is set in the response alongside the partial structure (the nesting-depth counter runs independently of the tokenizer). Pass `format: 'vr-draft'` to also get a `vrDraft` — a before/after Validation-Rule edit scaffold around the resolved expression (the VR's `errorConditionFormula`): `before` carries the formula verbatim, `after` is `proposedExpression` (optional) or a verbatim copy of `before` to edit, and the optional `errorMessage` is echoed into both sides. It PROPOSES a draft to feed Gearset/Copado and never fetches the VR, validates the formula, or writes to the org (see the vrDraft `disclosure`).",
    inputSchema: EXPLAIN_FORMULA_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unused_fields_deep',
    description: "Optional `objectId` narrows the scan to one CustomObject — accepts the canonical id (`CustomObject:Account`) or a bare api name (`Account`); without it the scan is org-wide. Legacy `parentObjectFilter` (bare api name) is still accepted for back-compat. Scans every CustomField in scope with an eight-tier cross-walk before flagging it as unused: (1) zero incoming usage edges (excluding parentOf containment and grantedBy FLS grants — access is not usage), (2) no formula-text reference in another CustomField / ValidationRule / WorkflowRule, (3) no layout placement (layoutSections + relatedLists), (4) no SOQL-string match in an ApexClass / ApexTrigger source byproduct, (5) no apex-scanner unresolvedFieldReferences match, (6) no incoming LWC/Aura/VF `references` edge, (7) no ConditionalContext expression-text reference, (8) no `exposes` integration edge. Returns per-field checks, a per-tier invisibility warning list, a confidence tier (`high` for clean+custom+non-managed; `low` for standard/managed), and a recommendedAction. `limit` (default 100, max 500) caps the rows; because each carries the full eight-tier detail, a per-response ~36 KB byte budget trims the page further when it would exceed the global ~45 KB MCP response limit (`truncated` + a `note`), while `totalCount` / `byParentObject` / `byConfidence` keep the UNFILTERED counts; a truncated page returns a `nextCursor` to resume. Pass `format: 'csv'` (, default `'json'`) to get `csv` (this page's rows as CSV — the eight `checks.*` booleans flattened into `checks_*` columns, with the boundary + freshness disclosures embedded as `#`-prefixed comment lines) instead of `fields` (`fields` is `[]` on a csv page); `totalCount`/`byParentObject`/`byConfidence`/pagination fields are unchanged. Pass `format: 'cleanup'` (, the folded-in `field_cleanup_candidates` view) to additionally get a ranked `findings[]` roster (severity from each field's `confidence`, `summary` = `\"{id} — {recommendedAction}\"`) parallel to `fields`, plus a `disclosure` carrying the report/dashboard usage caveat (a report-only field reads as unused without `--with-reports`); findings + fields are trimmed TOGETHER to the ~36 KB budget with a `note`. Pass `format: 'proposal'` (Finding #35) to additionally get a `proposal` — a deploy-ready, LOCAL artifact: a populated `destructiveChanges.xml` bundle of THIS PAGE's `high`-confidence unused fields (+ an empty `package.xml`), each led by an evidence comment carrying per-field recommended actions, the boundary disclosures verbatim, the vault `sourceTreeHash`, and a REVIEW-before-deploy banner. `medium`/`low`-confidence and protected (standard/managed) fields are EXCLUDED from the delete set and their counts disclosed in the evidence; the bundle is capped at 200 members. sfi returns the file STRINGS only — it NEVER deploys, writes, or connects to the org; a human feeds the files to Gearset / Copado / `sf project deploy`. Validated against `docs/schemas/proposal.schema.json`. Honesty axis (verbatim): string-BUILT dynamic SOQL, LWC dynamic field access, Apex reflective access, and runtime metadata references remain invisible — inline static SOQL and constant-string Database.query field references ARE resolved (parsed-confidence Apex AST edges counted by tier 1, with the tier-4 soqlStrings text-match as backstop) — a 'high-confidence unused' flag means 'no static evidence of use', not 'definitely unused'. Fields the heuristic recognizer classifies pii/sensitive carry a machine-readable `piiClassification` field and a compliance escalation PREPENDED to `recommendedAction` (deletion may be irreversible / FERPA-GDPR-PCI-relevant, require data-retention sign-off). Heuristic — absence is NOT a clearance. Honesty axis (verbatim): string-BUILT dynamic SOQL, LWC dynamic field access, Apex reflective access, and runtime metadata references remain invisible — inline static SOQL and constant-string Database.query field references ARE resolved (parsed-confidence Apex AST edges counted by tier 1, with the tier-4 soqlStrings text-match as backstop) — a 'high-confidence unused' flag means 'no static evidence of use', not 'definitely unused'. Fields the heuristic recognizer classifies pii/sensitive carry a machine-readable `piiClassification` field and a compliance escalation PREPENDED to `recommendedAction` (deletion may be irreversible / FERPA-GDPR-PCI-relevant, require data-retention sign-off). Heuristic — absence is NOT a clearance. HYBRID: pass `liveEnabled: true` (or grant consent) to cross-check every `confidence: 'high'` field ON THE RETURNED PAGE against its live production population before trusting that tier — real data despite zero static references across all eight tiers may be written by dynamic Apex, an integration, or another blind spot the scanner cannot see. A `populatedCount > 0` DOWNGRADES that field's `confidence` from `high` to `medium` (the tier `medium` already means: no static evidence, but a blind spot could hide a reference) and attaches a `livePopulation` evidence block (`objectApiName`/`fieldApiName`/`totalCount`/`populatedCount`/`populationRate`/`liveQueriedAt`); a zero-population result leaves `high` standing but still attaches the evidence block, confirming the cross-check ran. Bounded to the page (never the full unfiltered scan) so live-query cost tracks `limit`, not `totalCount`, AND further capped to at most the first 3 high-confidence fields per page — a live wall-clock bound so a large consented org (hundreds of high-confidence unused fields) can never fire hundreds of serial live COUNTs and blow the MCP 60s client timeout; the remaining high-confidence fields keep their STATIC verdict and a `boundaries` line names the cap ('live population checked for the first N of M high-confidence fields on this page … raise the page or narrow the object to check the rest'). `byConfidence` / `totalCount` stay the STATIC pre-cross-check totals regardless (disclosed in `boundaries` when a downgrade occurs). The live plane is NEVER a hard dependency — offline stays fully functional; when it is off, unavailable, or a query errors (budget exhausted, org unreachable), the response fails soft to the disclosed static tiers with a `boundaries` line naming the missing evidence ('static-only verdict; live population not checked').",
    inputSchema: UNUSED_FIELDS_DEEP_INPUT_SCHEMA,
  },
  {
    name: 'sfi.process_builder_migration_candidates',
    description: "List active Process Builder (Flow with `processType: 'Workflow'`), WorkflowRule, and ApprovalProcess nodes as migration candidates with per-rule complexity ('simple' / 'moderate' / 'complex') and a migration-notes paragraph. Defaults: `activeOnly: true` (inactive rules are deletion candidates surfaced by `sfi.unused_components`), `includeWorkflowRules: true`, `includeApprovalProcesses: true`, `sortBy: 'complexity'` (easy migrations first). Complexity is heuristic based on edge counts, criteria-item count, and time-trigger presence. Honesty axis (verbatim): the migration tool itself (Setup → Migrate to Flow) does not run here — this tool produces the inventory. Complexity classification may rank a single-decision rule as 'simple' even when its business logic requires manual rewrite. When a list is large, ONE list is paged via `nextCursor` and the other two are disclosed by full count + `otherSections`; `scanTruncated` flags a >500-node type scan. Emits a `coverageCaveat` naming any of Flow/WorkflowRule/ApprovalProcess the refresh did not retrieve; empty lists under it are 'not checked', not 'none'. Optional object scope (`objectApiName` / `object` / `objectId` / `CustomObject:` `componentId`) is HONORED: each list narrows to candidates PARENTED to that object (`parentObjectId`) and the response echoes `appliedScope` — WorkflowRules / ApprovalProcesses always carry an object parent, a Process Builder does when the vault captured it; an object absent from the vault is refused with `invalid-query`. A bare call stays org-wide and byte-identical.",
    inputSchema: PROCESS_BUILDER_MIGRATION_CANDIDATES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unassigned_permission_sets',
    description: "List PermissionSets unassigned to users. The tool ships TWO output paths: (1) when R2 Tooling-API enrichment has run, reads `properties.assignedUserCount` as the authoritative answer (PermissionSets with count 0 surface in `unassigned[]`); (2) when enrichment has not run, falls back to a structural check — PermissionSets with no outgoing `grantedBy` edges surface as `orphanedFromComponents[]`. The `unassignedCount` field counts confirmed unassigned; `unknownAssignmentCount` separately tallies PermissionSets where assignment cannot be determined. `enrichmentStatus` reports which path the answer came from (`tooling-api-fresh` / `tooling-api-stale` / `structural-only` / `no-assignment-data`). Honesty axis ( constitutional): NEVER counts unknownAssignmentCount toward unassignedCount — separates 'no data' from 'no assignments'. Emits a `coverageCaveat` when the PermissionSet family was not retrieved (distinct from the unknownAssignmentCount enrichment axis); empty results under it are 'not retrieved'. When the vault holds a captured permission-holder aggregate (`refresh --with-data-shape`), the response embeds a `dataShape` holders block (`data_snapshot`, COUNTS ONLY — no identities): a container absent from the org-wide aggregate had FACTUALLY zero active assignments at the capture stamp, upgrading the metadata inference. For the current name-by-name holder list of one specific container, use sfi.live_permset_holders (opt-in, read-only).",
    inputSchema: UNASSIGNED_PERMISSION_SETS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.empty_queues_and_groups',
    description: "List Queue and Group nodes with zero members. Walks `properties.memberCount` (the extractor convention) and falls back to `properties.queueMembers` / `properties.groupMembers` array length. Optional `nameContains` narrows both lists to queues/groups whose apiName OR label contains the substring (case-insensitive) and echoes `appliedScope: { nameContains, mode: 'nameContains' }`; omit it for the full inventory, and a filter that matches nothing returns an honest empty result, never the bare list. The 'routing trap' case — a Queue with zero members but multiple incoming AssignmentRule references — surfaces with `incomingAssignmentRuleCount > 0`; admins must reassign routing before deletion. The `isLikelyStale` flag combines zero members + incoming refs + `lastModifiedAt > 180 days`. Member resolution that cannot decide ('unknown') is counted in `unknownMemberCountQueues` / `unknownMemberCountGroups`, NEVER toward emptiness. Honesty axis (verbatim): runtime membership changes via the Setup UI since the last vault refresh are not reflected — for the CURRENT runtime roster (and a measured vault-vs-live drift check), use sfi.live_group_members (opt-in, read-only). Emits a `coverageCaveat` (scoped to the type filter) when Queue/Group was not retrieved; empty lists under it are 'not checked', not 'none'.",
    inputSchema: EMPTY_QUEUES_AND_GROUPS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tech_debt_score',
    description: "Aggregate the unused_components, unused_fields_deep / process_builder_migration_candidates / unassigned_permission_sets / empty_queues_and_groups, qualityIssues data (when present), freshness data (when present), and the Apex API-version distribution into one weighted 0-100 score plus a category breakdown. Score direction is INVERTED — higher means MORE debt (worse), with bands low (0-25), moderate (26-50), high (51-75), critical (76-100). Default weights: deadWeight 0.20, legacyAutomation 0.20, codeQuality 0.15, freshness 0.15, apiVersions 0.15, unassignedGrants 0.15. Categories whose underlying extractor has not run are EXCLUDED via `excludedCategories[]` (with reason 'extractor-not-run' or 'user-opted-out'), never assumed to be zero — the honesty anchor. When the codeQuality axis contributes, `boundaries[]` cites that its input is the heuristic Apex scanner (confidence: heuristic), so that axis is read as indicative, not exact. Pass `weights` to re-weight any subset. Pass `excludeCategories` to opt out of a category. Surfaces top-5 `recommendedActions` ordered by contribution. This score is ORG-WIDE (`appliedScope.mode: 'all'`): it cannot scope to a single object or domain — an `objectApiName` / `object` / `objectId` / `componentId` argument is REFUSED with `invalid-query` (the composite rolls up whole-org extractors), never silently answered fleet-wide. For per-object debt run `object_access_audit` / `safe_to_delete_field` / `find_component_usages` on that object. When `meta/risk-scores.jsonl` holds a prior refresh's score (the CLI logs the score at refresh time — snapshots can't be re-scored on demand), the response also carries `scoreDelta` / `previousScore` / `previousRefreshedAt`: the signed change in tech-debt vs the prior refresh (; positive = debt grew).",
    inputSchema: TECH_DEBT_SCORE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.code_quality_audit',
    description: "General-purpose code-quality entry point. Walks every ApexClass / ApexTrigger / Flow node, reads each node's `properties.qualityIssues[]` array (populated by the `code-quality-patterns` recognizer family at extraction time), applies optional severity and rule filters, and returns the matching issues sorted by severity DESC then componentId ASC. Each issue carries `componentId` / `type` / `apiName` plus the recognizer's `rule` / `severity` / `location` / `explanation` / `confidence: 'heuristic'`. `summary` reports the FULL per-severity / per-rule / per-type counts (not the truncated slice). `severityFilter: 'all'` is the default; specific severities (`critical` / `high` / `medium` / `low` / `info`) narrow the slice. `ruleFilter: ['soql-in-loop', 'dml-in-loop']` narrows to specific rule ids. Pass a CLASS SCOPE (`componentId` = `ApexClass:{name}`/`ApexTrigger:{name}`, or bare `classApiName`/`apiName`) to audit ONE class + echo `appliedScope`; an unresolved/non-Apex scope is a named error, never a silent org-wide answer; omit for the org-wide audit. `limit` defaults to 100 (max 500); `truncated` flips true when matches exceed `limit`. A truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so findings on a node past 500 are reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — false positives are expected; static recognition has dynamic blind spots (dynamic SOQL, reflective field access invisible) — the `dynamic-apex` info rule now FLAGS the classes that use those constructs so the blind spot is visible (impact/usage/dead-code results for them may be incomplete); severity is industry-consensus, not per-org overridable.",
    inputSchema: CODE_QUALITY_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.governor_limit_risks',
    description: "Apex-specific narrowing for governor-limit-relevant patterns — the performance/scale subset of the quality catalog. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, filters to the three governor-limit rules (`soql-in-loop`, `dml-in-loop`, `database-upsert-no-options`), groups findings by class, and (when the class is the target of an incoming `callsApex` edge from an ApexTrigger) surfaces the trigger callers in `triggerContext`. Each class entry also carries `entryPaths`: the entry-point PATHS that reach the risky class, each an ordered `[entryPoint,..., thisClass]` walked backwards over incoming `callsApex` to an ApexTrigger / Flow (or the top of the Apex chain) — so a finding cites WHERE it runs from (e.g. a SOQL-in-loop reachable only from a test class is lower real-world risk than one on a trigger's hot path). Bounded (depth 6, 12 paths), cycle-safe — : when a class's real fan-in of callers exceeds what the bounded walk explored, the entry carries `entryPathsTruncated: true` (present only then) and `boundaries[]` gets a matching disclosure, so `entryPaths` is never mistaken for the complete call-path inventory. Each class entry carries its identity, a per-finding list, the trigger context, and the entry paths. `totalRiskCount` / `byRule` report the FULL pre-slice counts. `limit` defaults to 100 (max 500); the slice is over CLASSES, not individual findings. A truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so a risky class past node 500 is reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — static SOQL/DML inside a static method called from a loop is invisible; trigger-context callers are listed without per-edge confidence (use sfi.find_code_usages for the per-edge detail). Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when any scanned class uses dynamic Apex — a SOQL/DML hidden inside a `Database.query(...)` string is invisible to this static recognizer, so the risk list may be incomplete.",
    inputSchema: GOVERNOR_LIMIT_RISKS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_hardcoded_values',
    description: "'find me hardcoded IDs / emails / usernames / endpoint URLs / sandbox-test-data' surface. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, narrows to the five hardcoded-literal rules (`hardcoded-id`, `hardcoded-email`, `hardcoded-username`, `hardcoded-url`, `hardcoded-sandbox-test-data`), and emits each match with the parent component's identity plus the recognizer's `rule` / `severity` / `location` / `explanation` plus an `inTestClass: boolean` flag (true when the parent ApexClass has `properties.isTest === true`). Optional `category` ('id' / 'email' / 'username' / 'url' / 'sandbox-data') narrows to one literal family. The `hardcoded-url` rule is namespace/domain-aware: it flags external endpoint URLs baked into Apex (should be a Named Credential / Remote Site Setting) but SKIPS Salesforce platform domains (My Domain, Sites, Visualforce, the API host). `byCategory` reports the FULL per-category counts; `limit` defaults to 100 (max 500). A truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so a finding on a node past 500 is reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — managed-package embedded literals may surface as false positives; the refusal-pattern disclosure 'string literals inside @isTest classes that look like IDs may be intentional test fixtures' is appended verbatim when ANY surfaced match is in a test class. (Takes effect on ApexClass/ApexTrigger refreshed after this rule shipped.)",
    inputSchema: FIND_HARDCODED_VALUES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.crud_fls_audit',
    description: "CRUD/FLS enforcement audit. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, narrows to the two CRUD/FLS rules (`missing-crud-check`, `missing-fls-check`), groups findings by class, and surfaces the verbatim disclosure naming the HIGH false-positive rate inherited from ApexQualitySemantics.md §§ 6-7. Optional CLASS SCOPE: pass `componentId` (`ApexClass:{name}` / `ApexTrigger:{name}`) or the interchangeable `classApiName` / `apiName` to audit ONLY that class — the response echoes `appliedScope` ({ component, mode }), an unresolved id is `component-not-found`, a non-Apex type prefix is `invalid-query`, and the selector is NEVER silently stripped to an org-wide answer; omit all three for the org-wide audit. Each class entry carries its identity and a per-finding list (rule / severity / location / explanation). `totalFindingCount` / `byRule` report the FULL pre-slice counts. The class list is paginated: `limit` defaults to 100 (max 500) and `offset` (default 0) page over CLASSES, and a per-response ~36 KB byte budget trims the page further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more classes remain, with `nextOffset` to advance (plus a `note` when byte-trimmed, and a per-class `findingsTruncated` flag in the rare case one class's findings alone overflow). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): the false-positive disclosure — 'custom security utility methods are invisible to the recognizer; this finding may be a false positive if your org uses a helper like SecurityUtils.canCreate(account)' — is the load-bearing honesty surface for this tool. Also surfaced: cross-method dataflow is invisible; dynamic SOQL strings (Database.query) are stripped before pattern passes.",
    inputSchema: CRUD_FLS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.test_coverage_gaps',
    description: "(1) `properties.isTest === true` identifies test classes (excluded from the scan), (2) BFS over incoming `callsApex` edges (capped at depth 3) collects the test classes reaching each non-test class, (3) `qualityIssues[]` `fake-assertion` findings on those test classes mark meaninglessly-covered classes. Classifies each non-test ApexClass into one of three coverage statuses — `uncovered` (no test reaches it within depth 3), `fake-coverage` (covered, but EVERY covering test has fake-assertion findings), `low-quality-coverage` (covered, but SOME covering test has fake-assertion findings). Each gap entry carries `componentId` / `apiName` / `coverageStatus` / `coveringTestClassIds[]` / `fakeAssertions[]` / `recommendedAction`. `byStatus` reports the per-status counts. The gap list is paginated: `limit` (default 200, max 500) and `offset` (default 0) page over gap entries, and a per-response ~38 KB byte budget trims the page further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more gaps remain, with `nextOffset` to advance (plus a `note` when byte-trimmed). Optional `classFilter[]` narrows the scan to specific ApexClass ids (capped at 500). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one gap qualifies): the meaningful-assertion heuristic recognizes `System.assertEquals(expected, actual)` with distinct tokens; assertions via helper methods or framework wrappers are invisible. Reachability via `callsApex` does NOT cover dynamic dispatch. BFS is capped at depth 3.",
    inputSchema: TEST_COVERAGE_GAPS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_field_type',
    description: "Given a CustomField canonical id (`CustomField:{Object}.{Field}`) and a proposed new field type, returns the structured impact across every incoming dependency edge. Classifies the (currentType, newType) transition via the matrix in WhatIfSemantics.md as `forward-compatible` / `lossy` / `breaking`, then walks every incoming edge (`references` from validation rules / formulas, `readsFrom`/`writesTo` from Flow + Apex + LWC/Aura/VF, `usedInLayout` from layouts, integration references from External Service / External Data Source) and emits per-impact entries with `category` (metadata-blocker / code-needs-update / integration-touch / configuration-only), source ComponentId, edge-level `confidence`, and a one-sentence explanation. FLS grants (Profile / PermissionSet) are NOT impacts — access keys on API name, not type — and Formula / Roll-Up Summary (computed) fields return `invalid-query` because their type is derived, not stored, so a field-type change is not a valid operation (mirrors `what_if_make_field_required`). Aggregate `verdict` is `safe` / `review` / `risky` / `blocking` based on the impact mix. Supported newType values include `EncryptedText` (Shield/Classic encryption): any transition to EncryptedText is classified as `lossy` because encrypted fields cannot be used in formulas, are invisible to SOQL filters in standard queries, and Apex/Flow reading the field without SYSTEM_MODE will receive masked values. Honesty axis (verbatim): dynamic SOQL, reflective field access via `obj.get('FieldName')`, and runtime computation are invisible; compatibility matrix is conservative — narrow data-shape edge cases may behave compatibly in practice.",
    inputSchema: WHAT_IF_CHANGE_FIELD_TYPE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.picklist_integrity_scan',
    description:
      "Org-wide picklist value-set integrity scan — the INVERSE of what_if_remove_picklist_value (which starts from one value). Sweeps EVERY Picklist / MultiselectPicklist CustomField that carries an inline value set and, for each, gathers every string literal that DECLARATIVE source metadata compares or assigns against it — ValidationRule / formula-field formulas and `ISPICKVAL(field,'X')`, Flow decision criteria, Flow record-create/update LITERAL assignments (`<stringValue>` on a `writesTo` edge), Workflow-Rule criteria, and the field's own default(s) — then flags each literal that matches NO defined value (`orphaned`, HIGH; a spelling-close defined value is offered as a `nearMatch`) or matches only an INACTIVE/deactivated value (`inactive-only`, MEDIUM). Comparison vs assignment matters: an orphaned COMPARISON cannot match a defined value so it is flagged (a branch that silently died on a value rename), but an orphaned ASSIGNMENT is a defect only for a RESTRICTED picklist — an UNRESTRICTED picklist accepts free text — so an orphaned assignment to a field of unknown/unrestricted restrictedness is NOT flagged (free-text writes are not mis-flagged). Output pages over FIELDS-with-findings (`limit` 1..500 default 50, `offset`), with per-hit citations carrying source ComponentId, use kind, location, and edge/parse confidence, plus a `trust` block whose claim confidence is the WEAKEST grounding source (any `parsed` formula literal weakens the `declared` value set to `parsed`). Honesty axis (verbatim): this is a METADATA integrity check, NOT a record-value check — whether any RECORD holds a value is a runtime question for live_picklist_usage. Apex picklist-literal comparison is NOT covered (an Apex node carries no literal-bearing property and a bare-field-name scan of raw `.cls` source would cross-attribute a same-named field on a different object). Variable comparisons, dynamic SOQL/Apex strings, and reflective field access are invisible, so an empty finding is \"not checked\", not proven clean; and the offline vault does not model each field's `restricted` flag, so orphaned assignments are withheld unless the flag is present and true.",
    inputSchema: PICKLIST_INTEGRITY_SCAN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_remove_picklist_value',
    description: "Given a Picklist or MultiselectPicklist CustomField id (`CustomField:{Object}.{Field}`) and a value to remove, returns the structured impact across formula sources referencing the literal value, Apex classes/triggers with the value in their `properties.stringLiterals` array AND an existing readsFrom/writesTo edge to the field, Flow / WorkflowRule / ValidationRule firers whose `firesWhen` ConditionalContext expression references the value, and downstream ConditionalContext nodes. Each impact entry carries `category` (metadata-blocker for declarative references; code-needs-update for Apex; integration-touch / configuration-only for the rest), source ComponentId, edge-level `confidence`, and a one-sentence explanation. Compatibility is `breaking` when impacts exist and `review` when none match (the value may still be touched dynamically). R2-1: Flow record-create/update steps that assign this value to the field as a LITERAL (`<stringValue>Completed</stringValue>`, `<numberValue>`, etc.) on a `writesTo` edge ARE now detected and block; Flow steps that assign the value indirectly via `<elementReference>` (a variable, formula, or merge field) are NOT statically resolvable and are deliberately NOT matched (disclosed). Honesty axis (verbatim): variable-based picklist comparisons and dynamic SOQL strings are invisible, and Flow `<elementReference>` assignments are not matched; review dynamic comparisons and reference-based flow assignments separately before removing the value.",
    inputSchema: WHAT_IF_REMOVE_PICKLIST_VALUE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_make_field_required',
    description: "Given a CustomField id (`CustomField:{Object}.{Field}`), walks the parent object's write paths and flags incomplete writes that would fail at runtime once the field is required. Surfaces: layouts on the parent that do NOT display the field (`category: 'configuration-only'`); Flows creating records on the parent object that do NOT set the field via `recordCreate` (`category: 'metadata-blocker'`); External Service / External Data Source integrations referencing the parent (`category: 'integration-touch'`); and declarative populators that DO set the field — WorkflowRule field-updates and ApprovalProcess field-updates discovered on the field's inbound `writesTo` edges — surfaced as informational `configuration-only` findings. Those populators are CONDITIONAL (a WorkflowRule fires only on criteria match; an ApprovalProcess field-update fires only on a specific hook and only for records that go through approval), so they NEVER move the verdict to `safe` — they document a partial mitigation to verify, not a guarantee of population. When the field is already required (`properties.required === true`), returns a no-op `safe` verdict with empty impacts. NOT walked: Apex `insert acc;` sites — determining whether `acc.Industry__c` was assigned before the insert requires dataflow analysis (deferred per WhatIfSemantics.md). Honesty axis (verbatim, surfaced ALWAYS): the analysis checks layouts (UI input paths), Flow create paths, integration write surfaces, and declarative populators (Flow / Workflow / Approval field-updates) that may set the field — conditional writers do not guarantee population; Apex insert sites that may or may not set the field are invisible. HYBRID: pass `liveEnabled: true` (or grant consent) to add `liveNullRate` — the live production null-rate for the field (how many existing records have it NULL today, with a plain-language reading of what making it required means for that population), plus a `staleness` lead when the org is ahead of the vault. With the live plane on, the answer's `trust.provenance` is `hybrid` (both planes' freshness); without it, the offline verdict stands unchanged. When the vault holds captured data-shape facts, the response embeds the field's sampled fill rate as a stamped `data_snapshot` `dataShape` block — CONTEXT ONLY: the verdict never softens on a sampled observation.",
    inputSchema: WHAT_IF_MAKE_FIELD_REQUIRED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_deactivate_flow',
    description: "Given a Flow canonical id (`Flow:{ApiName}`), bare API name, or flow label / partial name (e.g. 'Consent Flow') — passed interchangeably as `flowId`, `componentId`, `flowApiName`, or `apiName` (a host naturally reaches for `componentId: Flow:…` as on get_impact; disagreeing selectors are `invalid-query`, and the resolved id is echoed in `appliedScope`) — enumerates the downstream impact of deactivating the Flow by walking every outgoing edge. When a non-canonical input is passed, the tool performs an internal fuzzy lookup (resolveComponents filtered to Flow type): if exactly one match is found it auto-resolves; if multiple candidates match it returns them for the caller to pick from; if none match it returns a helpful error with a hint to use sfi.list_components. Surfaces OUTGOING effects — `triggersOn` (the object the Flow listens to), `readsFrom` / `writesTo` (record lookups + DML), `callsApex` (Apex action calls the Flow made), `sendsEmail` (email templates the Flow sent), and subflows THIS Flow invokes (`references` / `referenceKind: 'subflow'`) — AND the INCOMING side: parent Flows that invoke THIS Flow as a subflow are BROKEN CALLERS on deactivation, surfaced as a distinct `broken-caller` category. Each impact carries category, source ComponentId, edge-level `confidence`, and a one-sentence explanation. The response also carries the Flow's current `firingConditions` (the `firesWhen` ConditionalContext list — the gating conditions the deactivation would silence). Aggregate `verdict` is `safe` (no impacts) / `risky` (callsApex only, or broken callers that are all inactive Draft/Obsolete) / `blocking` (any record write, trigger, email-send, or subflow-invocation impact, OR any broken caller that is an ACTIVE parent Flow — a subflow with active parents must not read safe). Honesty axis (verbatim): deactivation does NOT delete the Flow — its definition remains and a later reactivation restores every effect listed; only ACTIVE parent broken callers force blocking; the subflow modeling covers DECLARED <subflows> only — Apex code that invokes the Flow via Flow.Interview or @InvocableMethod chains, and non-metadata launch points (buttons, quick actions), remain invisible to the heuristic walker.",
    inputSchema: WHAT_IF_DEACTIVATE_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_disable_trigger',
    description: "Given an ApexTrigger canonical id (`ApexTrigger:{Name}`), enumerates the downstream impact of disabling the trigger by walking every outgoing edge. Surfaces `triggersOn` and `listensTo` (the parent SObject and Platform Event subscription), `writesTo` and `readsFrom` (field access from the trigger body — `parsed`-confidence where the default-on Apex AST resolved the access, `heuristic` where only the regex apex-scanner matched), `callsApex` (Apex classes the trigger invokes), and `dispatchesAsync` (async jobs the trigger queues) as `WhatIfImpactItem` entries. The response also carries the trigger's `parentObject` (the SObject the trigger attaches to) and `events` (the lifecycle phases: `before insert`, `after update`, etc.) as scalar fields so the renderer can render \"automation on Account will lose this handler\". Aggregate `verdict` follows the same cascade as `what_if_deactivate_flow`. Honesty axis (verbatim): disabling is a runtime metadata flag, not a deletion; Apex edge confidence VARIES — `parsed` where the default-on Apex AST resolved the field access, `heuristic` where only the regex apex-scanner matched; spot-check the trigger body when a finding's confidence is `heuristic`. Indirect dispatch via trigger framework base classes (TriggerHandler, fflib) may be partially invisible to the recognizer.",
    inputSchema: WHAT_IF_DISABLE_TRIGGER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_method_signature',
    description: "Given an ApexClass (`classApiName` / `componentId` / `apiName` — a bare name or an `ApexClass:` id, interchangeable, resolved + echoed as `appliedScope`), a method name, and an optional new signature string, enumerates every direct caller of the named method plus every test class exercising the target class. Walks incoming `callsApex` edges filtering by `properties.methodName === methodName` (Flow callers are accepted without methodName matching — Flow XML declares the action name at class level), then walks incoming `coversTest` edges. Each caller surfaces in `callingClasses[]` as a `WhatIfImpactItem` with `category` (`code-needs-update` for non-test code callers; `test-class-update` for test classes), source ComponentId, edge-level `confidence` (`heuristic` for the apex-scanner / Visualforce callers; `parsed` for Flow callers parsed out of the Flow `<actionCalls>` XML; `declared` for LWC/Aura `@salesforce/apex/{Class}.{method}` imports), and a one-sentence explanation. Test classes also surface in a parallel `testClassesNeedingUpdate[]` scalar array. The `newSignature` parameter is accepted for renderer context and echoed verbatim in the response — the tool does NOT parse it. Aggregate `verdict` is `safe` (no callers) / `risky` (callers present — every caller is flagged for human review because signature COMPATIBILITY is not statically proven: the caller SET is exact, but whether each call-site's arguments still type-check against the new signature is not analysed). Honesty axis (verbatim, surfaced ALWAYS): caller confidence varies by source — Apex callers are `parsed` where the default-on Apex AST resolved the call-site (`callerMethods` then names the calling method), `heuristic` where only the regex apex-scanner matched; Visualforce callers are heuristic; Flow callers are parsed from the <actionCalls> XML; LWC/Aura callers are declared via the @salesforce/apex import; dynamic dispatch via Type.forName + invoke is invisible. Test classes are identified by @isTest + naming convention (className + 'Test' suffix) and by coversTest edges; a test class that doesn't follow the naming convention and doesn't carry a @TestVisible-tagged covering reference may be missed. When an Apex caller's edge was AST-extracted, `callerMethods` names which method(s) of that caller hold a call-site to THIS specific method (enrichment only — overloaded callers collapse to one NAME, so every caller is still flagged for human review at class granularity and the verdict is unchanged); absent callerMethods means the call-site method is unknown (heuristic scanner, Flow, or LWC/Aura caller).",
    inputSchema: WHAT_IF_CHANGE_METHOD_SIGNATURE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_merge_profiles',
    description: "Given two Profile canonical ids (`Profile:{Name}`), walks both profiles' grants and visibility settings, groups them by `(settingType, settingId)`, and surfaces every pairwise disagreement as a `MergeConflict` carrying `profileAValue`, `profileBValue`, and a `recommendedPolicy` (`max` for permission ladders / Boolean OR semantics; `min` for clamp-down merges; `manual-only` for categories with no clean comparator such as layout assignments). Setting categories covered: user permissions (from `properties.userPermissions`), object permissions, field permissions, apex class access (the three `grantedBy`-edge categories), tab visibilities (`properties.tabVisibilities`), layout assignments (`properties.layoutAssignments`), and record type visibilities (`properties.recordTypeVisibilities`). The `summary` carries `totalSettings`, `agreed`, `conflicts`, and `notEvaluatedCategories` counts. Honesty axis (verbatim): surfaces conflicts but does NOT auto-resolve — recommended policies are heuristic; manually verify each conflict before applying. Profile-edition rollup (e.g., admin-level overrides) is not modeled. Tab visibility is compared ONLY when the refresh extracted `properties.tabVisibilities` — the Profile extractor emits it at every refresh, so it is normally compared; a profile from a vault refreshed before the P11 extraction lacks it, and the category is then listed in `summary.notEvaluatedCategories` with a disclosure rather than reported as a fabricated 'no tab conflicts' (remedy: re-run `/sfi-refresh`). Pass `format: 'proposal'` (Finding #35) to also get a `proposal` — a deploy-ready, LOCAL `package.xml` pulling BOTH profiles for a human to retrieve and hand-merge in their own deploy tool, led by an evidence comment carrying the verdict, the complete conflict rollups (byCategory / byPolicy), a sample of the conflicts with their recommended policy, and the vault `sourceTreeHash`. sfi does NOT auto-resolve conflicts and NEVER deploys — it returns the file STRING only; a human feeds it to Gearset / Copado / `sf project deploy`. Validated against `docs/schemas/proposal.schema.json`.",
    inputSchema: WHAT_IF_MERGE_PROFILES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_split_profile',
    description: "Given a Profile id (`Profile:{Name}`) and an ordered array of target PermissionSet ids (`PermissionSet:{Name}`), proposes a per-grant assignment via a greedy keyword-match heuristic. For each grant (user permission, object permission, field permission, apex class access): Step 1 tokenizes both the target perm-set names and the grant's settingId on camelCase + underscore + dash boundaries and assigns to the highest-overlap target (`rationale: 'keyword-match'`); Step 2 falls back to a domain-cluster match on the parent object name (`rationale: 'domain-cluster'`); Step 3 falls through to the FIRST target as the user-provided default (`rationale: 'default'`). Grants where even Step 3 cannot apply (defensively reachable when target list edge cases occur) surface in `unassignedSettings[]` with a reason — the fail-conservative posture surfaces unassignable grants rather than forcing them into an inappropriate target. Layout assignments, tab visibilities, and record-type visibilities are NOT split (Profile-only settings in the Salesforce metadata model). Honesty axis (verbatim): split clustering is approximate; the greedy keyword-match heuristic is fail-conservative — review every assignment before applying.",
    inputSchema: WHAT_IF_SPLIT_PROFILE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_assign_permset',
    description: "Permission-set what-if tool: given a target permission set (`permissionSetId` — a `PermissionSet:` or `PermissionSetGroup:` id, or a bare name) and a `baseline` container set (`{ profileId?, permissionSetIds?[] }` — the user's CURRENT profile + already-assigned permission sets, both optional), returns the NET access the user would GAIN by assigning the target. It composes the SAME effective-permissions engine as `sfi.effective_permissions` TWICE — once for the baseline WITH the target and once WITHOUT — and diffs the two max-wins, muting-applied EFFECTIVE grant sets. NET-CHANGE CORRECTNESS is the whole value: a permission the baseline already holds via its profile or ANOTHER assigned permission set is NOT counted as gained (it appears on both sides of the diff and cancels). Delta classes surfaced as GAINED: `objectPermissions` (per-object CRUD/View-Modify-All flags), `fieldPermissions` (per-field FLS read/edit), `systemPermissions` (`<userPermissions>`), `customPermissions`, and `recordTypeVisibilities`. `summary` carries the COMPLETE per-class counts + `totalChanges` + `noOp`; the detail lists page via `limit`/`offset`/`cursor` under a byte budget. MUTING composes group-scoped: if the target is a member of a baseline PSG whose muting set denies some of its perms, assigning it DIRECTLY (unmuted) re-confers those — the gain is surfaced. Verdict `safe` when no net change (already-covered / already-assigned no-op), else `review` (a grant to verify); partial coverage downgrades `safe`→`review`. Honesty axis (verbatim): the delta is the NET change under max-wins; this is a hypothetical READ (nothing is assigned); grants are `declared` metadata; object permission is not record access (record visibility still depends on OWD + sharing). Situational `disclosures`: assigning a set already in the baseline is a disclosed no-op; muting that could not be applied (a pre- muting node, or a referenced-but-absent one) means the delta may be over/understated; a baseline container not found is ignored; a container lacking record-type data yields an incomplete record-type delta. Unknown target = `component-not-found`; a wrong-type target / baseline prefix = `invalid-query`.",
    inputSchema: WHAT_IF_PERMSET_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_revoke_permset',
    description: "Permission-set what-if tool (the mirror of `sfi.what_if_assign_permset`): given a target permission set (`permissionSetId` — a `PermissionSet:` or `PermissionSetGroup:` id, or a bare name) and a `baseline` container set (`{ profileId?, permissionSetIds?[] }` — the user's CURRENT profile + assigned permission sets, which SHOULD include the target), returns the NET access the user would LOSE by revoking the target. It composes the SAME effective-permissions engine TWICE — once for the baseline (WITH the target) and once WITHOUT it — and diffs the two max-wins, muting-applied EFFECTIVE grant sets. NET-CHANGE CORRECTNESS is the whole value: a permission ALSO granted by the profile or another assigned permission set is NOT counted as lost — the user keeps it. Delta classes surfaced as LOST: `objectPermissions` (per-object CRUD flags), `fieldPermissions` (per-field FLS read/edit), `systemPermissions`, `customPermissions`, and `recordTypeVisibilities`. `summary` carries the COMPLETE per-class counts + `totalChanges` + `noOp`; the detail lists page via `limit`/`offset`/`cursor` under a byte budget. Revoking a set NOT in the baseline is a NO-OP (net loss empty), disclosed via `targetInBaseline: false`. MUTING composes group-scoped. Verdict `safe` when no net change (no-op), else `review` (a removal to verify nothing breaks); partial coverage downgrades `safe`→`review`. Honesty axis (verbatim): the delta is the NET change under max-wins; this is a hypothetical READ (nothing is revoked); grants are `declared` metadata; object permission is not record access. Situational `disclosures`: revoking a set not in the baseline is a disclosed no-op; muting that could not be applied means the delta may be over/understated; a baseline container not found is ignored; a container lacking record-type data yields an incomplete record-type delta. Unknown target = `component-not-found`; a wrong-type target / baseline prefix = `invalid-query`.",
    inputSchema: WHAT_IF_PERMSET_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_data_dictionary',
    description: "Given a CustomObject (the `objectId` accepts either the canonical id `CustomObject:{ApiName}` or a bare object api name like `Account`, coerced to the id — consistent with `generate_sharing_summary`), composes a structured markdown document covering the object's Overview, Fields (table with label/api-name/type/description/required), Relationships (lookups + master-details), Validation Rules, Page Layouts (via incoming `usedInLayout` edges), and Related Triggers/Flows (via incoming `triggersOn` edges). Returns a `GeneratedDocument` payload — frontmatter (title, generatedAt, sourceTreeHash, componentIds), body (the rendered markdown), `sectionConfidence` keyed by heading, and a `boundaries` footer carrying the verbatim freshness disclosure + the structural / inherited-confidence disclosures. Pass `format: 'csv'` to ALSO get `csv` — one row per field (`objectApiName,label,apiName,dataType,formula,description,required`) fitted to the response budget independently of `document` (rows are dropped tail-first with a `# truncated: …` comment when the object has too many fields to fit, never silently corrupted) — meant to be written to a `.csv` file for a spreadsheet. Honesty axis: document is structure, not narrative; downstream rendering layer composes prose. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`. an Entity Relationship Diagram (: a ```mermaid erDiagram``` fence of this object's OWN outgoing Lookup/Master-Detail fields PLUS every other object's inbound `lookupTo` reference to it — capped at 40 relationships, disclosed when truncated), Validation Rules, Page Layouts (via incoming `usedInLayout` edges), and Related Triggers/Flows (via incoming `triggersOn` edges). Returns a `GeneratedDocument` payload — frontmatter (title, generatedAt, sourceTreeHash, componentIds), body (the rendered markdown), `sectionConfidence` keyed by heading, and a `boundaries` footer carrying the verbatim freshness disclosure + the structural / inherited-confidence / ERD-scope disclosures. Honesty axis: document is structure, not narrative; downstream rendering layer composes prose. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: GENERATE_DATA_DICTIONARY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_admin_handbook',
    description: "Composes a structured markdown admin handbook covering the org's purpose, main objects, automation summary, permission structure, integration topology, and recent changes. Optional `personaFocus` (`'admin' | 'architect' | 'business-user' | 'developer'`, default `'admin'`) reshuffles section ordering — `'developer'` leads with main objects, automation summary, and a Codebase Footprint subsection; `'architect'` leads with Integration Topology. Returns a `GeneratedDocument` payload. Honesty axis: Recent Changes depends on enrichment — when absent the section surfaces a verbatim enrichment-command disclosure rather than fabricating activity.",
    inputSchema: GENERATE_ADMIN_HANDBOOK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_architecture_overview',
    description: "Composes a 3-4 page architecture document chaining `sfi.org_overview` + `sfi.domain_clusters` + `sfi.integration_map`. Body covers Executive Summary, Org Structure (mermaid diagram with top objects by inbound-reference count), an Entity Relationship Diagram (: a ```mermaid erDiagram``` fence of the top 12 objects by Lookup/Master-Detail relationship DEGREE — a DIFFERENT ranking than Org Structure's — showing only the relationships where BOTH endpoints made the cut; the object cap and any further relationship cap are disclosed), Domain Clustering (mermaid + table of suggested clusters), Integration Topology (mermaid + tally table), Automation Footprint, and Codebase Footprint. Returns a `GeneratedDocument` payload; pass `format: 'html'` to ALSO get a self-contained `html` page (renders the markdown + all mermaid diagrams client-side, incl. the ERD) to save as a `.html` artifact. Honesty axis: domain clusters and top-object rankings inherit heuristic confidence from the upstream composition tools — surfaced as suggested starting points, not authoritative groupings. : the two mermaid diagrams cap their node count (Org Structure: top 5 CustomObjects by inbound references; Integration Topology: first 20 integration surfaces — its Type/Count TABLE is never capped, only the diagram) — when the org exceeds either cap, an inline \"showing the top/first N of M\" line renders directly under the affected diagram AND `document.boundaries` gets a matching entry, so a large org's overview never silently reads as a complete picture of a small one.",
    inputSchema: GENERATE_ARCHITECTURE_OVERVIEW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_sharing_summary',
    description: "Composes a structured markdown sharing summary covering every CustomObject's OWD (`properties.sharingModel`), the SharingRules that apply (matched on `properties.sObjectType`) — each rule's table row now NAMES its `sharedWith` recipient in a \"Shared With\" column (05b; recipients were previously OMITTED entirely), and a `roleAndSubordinates` / `roleAndSubordinatesInternal` Role recipient is marked \"(and its subordinate roles)\" with the descending role subtree counted via the SAME `expandRoleSubordinates` helper `who_can_access_object` uses (so the two surfaces never drift) — the Profile / PermissionSet grants tallied from incoming `grantedBy` edges on the object, and the Role Hierarchy (mermaid diagram from Role node `properties.parentRoleId`). Optional `objectFilter` (string api name) narrows the scan to one CustomObject; default scans every extracted object (capped at 50 — : when the org has MORE than 50 matching objects, the response carries `scanTruncated: true` + the TRUE `totalMatchingObjects` count, the `document.body` Overview line reads \"N of M matching (capped...)\", and `document.boundaries` names the cap and recommends `objectFilter` for full per-object coverage — never silently read as complete). Returns a `GeneratedDocument` payload. Honesty axis: Role-hierarchy data depends on sharing extractors having processed `roles/` metadata; absent role nodes surface a disclosure rather than an empty diagram. An incomplete subordinate subtree (a child Role node not retrieved, or the scan capped) is disclosed in `boundaries`, never silently treated as complete; the `roleAndSubordinatesInternal` internal-vs-portal exclusion CANNOT be applied offline (Role nodes carry no portal marker) and is disclosed too. B29: when `objectFilter` names an object that matched no RETRIEVED CustomObject but IS referenced elsewhere (inbound edges — a phantom from a managed package or outside the retrieve scope), the response carries a structured `targetMissing { id, referencedBy }` and the body discloses \"not retrieved\" rather than a silent \"no objects matched\" — so an FLS/sharing review is never handed an empty answer that reads as \"no sharing\".",
    inputSchema: GENERATE_SHARING_SUMMARY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_compliance_report',
    description: "Composes a structured markdown compliance report chaining `sfi.pii_inventory` + `sfi.field_access_audit` (per top-PII-field, capped at 25) + per-object `sharingModel` lookup. Body covers Executive Summary, PII Inventory by Category (tables per category), Field Access Audit (per-field profile/perm-set grant counts), Sharing Model Exposure (OWD per parent object), Risk Flags (PII fields with ≥3 read grants), and Object + FLS Exposure (principals with BOTH object reach AND FLS read on a regulated field). Object reach is the UNION of an explicit object-permission grant AND org-wide god-mode (`ModifyAllData`/`ViewAllData` on `userPermissions`) — so a System Administrator with no explicit object row is folded in, not missed; ViewAllData maps to read-level only. Returns a `GeneratedDocument` payload. Honesty axis: PII classifications inherit the recognizer's heuristic provenance — fields flagged here may not store PII at runtime, and unflagged fields may. Dynamic Apex / runtime SOQL are invisible to the access-audit. DISCLOSED GAP: god-mode granted via a Permission Set Group or muting permission set is not folded into Object+FLS exposure (userPermissions modeled on Profile/PermissionSet nodes only).",
    inputSchema: GENERATE_COMPLIANCE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_onboarding_doc',
    description: "Composes a structured markdown new-admin / new-developer tour chaining `sfi.generate_admin_handbook` + `sfi.generate_architecture_overview` + `sfi.org_overview` for top objects + a custom-field-label glossary builder (heuristic on labels appearing in fewer than 5 objects). Body covers What This Org Does, Main Data Model (top 3 objects), Common Workflows, How Security Works, Naming Conventions, Glossary, Key Contacts (or disclosure when enrichment absent), and Where To Go Next (persona-specific tool hints). Optional `personaFocus` (`'admin' | 'developer'`, default `'admin'`). Returns a `GeneratedDocument` payload. Honesty axis: glossary entries are heuristic — a label on a single object MAY be org-specific terminology or may simply be an underused standard label. Key Contacts depends on enrichment.",
    inputSchema: GENERATE_ONBOARDING_DOC_INPUT_SCHEMA,
  },
  // v2.7 R2 — deep code understanding tier (call-graph / downstream-effects /
  // test-coverage-for-method / meaningful-test-audit / method-reachability).
  // All five operate at CLASS granularity; method-level edge resolution is
  // deferred to v2.7.1.
  {
    name: 'sfi.call_graph',
    description: "Deep code tool: given a root `ApexClass:` or `ApexTrigger:` id and an optional `direction` (`'downstream' | 'upstream' | 'both'`; defaults to `'both'`), BFS over `callsApex` edges up to `maxDepth` hops (default 3, max 5). Returns the discovered nodes (each labelled with the shortest-path hop count from the root), the traversed edges — each carrying `methods` (the methods of the target class the source invokes) — a `cycleDetected: boolean`, the `maxDepthReached`, and the disclosure. The optional `method` arg narrows the root's DIRECT edges to those involving that method, e.g. `direction:'upstream' + method:'deleteRecord'` answers \"who calls Root.deleteRecord\" (deeper hops are unfiltered). Cycle detection is keyed by node id; a back-edge during the walk flips the flag without aborting. Both-direction walks dedupe overlapping nodes/edges. Honesty axis (verbatim): method-level call TARGETS are surfaced via `methods`; AST-extracted edges (`source: 'apex-ast'`) ALSO carry `callerMethods` — the method(s) of the SOURCE class that contain the call-site, as a class-level UNION (the source methods that call ANY method of the target, NOT partitioned to the specific target method even when the `method` filter is applied). Edges WITHOUT it (the heuristic Apex scanner, Flow/declared callers, or a pre-upgrade vault) leave the caller method UNKNOWN — absence is not 'no caller'. Invalid prefix surfaces as `invalid-query`; unknown root resolves to an empty walk (root-only response, NOT an error envelope).",
    inputSchema: CALL_GRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.downstream_effects',
    description: "Given an `ApexClass:`, `ApexTrigger:`, OR `CustomObject:` id, surfaces what downstream automation and side effects are reachable. **Apex root** (`ApexClass:`/`ApexTrigger:`): walks downstream `callsApex` BFS (capped at `maxDepth`, default 3, max 5) then for every reachable class surfaces its outgoing `writesTo` (`category: 'field-write'`), `dispatchesAsync` (`category: 'async-dispatch'`), and `sendsEmail` (`category: 'email'`) edges as categorised side effects. Optional `method` narrows the root's DIRECT outgoing `callsApex` edges to those whose `methods[]` include that target method — e.g. `method: 'deleteRecord'` follows only callees invoked via `deleteRecord` from the root (deeper hops unfiltered). **Object root** (`CustomObject:`): discovers automation via incoming `triggersOn` (ApexTrigger, Flow, WorkflowRule) and outgoing `parentOf` (ApprovalProcess — parented on the object, no `triggersOn`), returning them in `automationNodes[]`; for each firer collects direct declarative effects (`writesTo` / `sendsEmail` / `dispatchesAsync` on the firer node) plus Apex effects reachable via `callsApex` BFS (workflow/approval/flow Apex actions and trigger handlers) into the same `effects[]` slice — answers \"what automation runs on this object and what does it do\". Each effect carries the source id/apiName, the target id/type/apiName (when resolvable), the producing edge type and source. `summary` reports per-category counts across the slice. Honesty axis (verbatim): optional `method` filters target methods on the root hop only — the CALLER-side method (which method of the root body performs each call) is available on AST-extracted edges via `callerMethods` (see call_graph) but downstream_effects does NOT surface it; HTTP callouts are NOT a effect category — only the / extractor-emitted edges count; Apex email (`Messaging.sendEmail`) and DML deletes are likewise invisible, so an EMPTY effects list means \"no MODELED effects\" — never \"side-effect-free\" (the disclosure says so explicitly on empty results). Invalid prefix surfaces as `invalid-query`; unknown root surfaces as `component-not-found`.",
    inputSchema: DOWNSTREAM_EFFECTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.test_coverage_for_method',
    description: "Deep code tool: given an `ApexClass:` or `ApexTrigger:` id (accepted interchangeably as `classApiName`, `componentId`, or `apiName` — a bare name or the canonical id; disagreeing selectors are `invalid-query`, and the resolved id is echoed in `appliedScope`) and an optional `methodName`, walks upstream `callsApex` + `dispatchesAsync` BFS (capped at depth 3) and surfaces every test class (nodes with `properties.isTest === true`) that reaches the target. Each `coveringTestClasses` entry carries the test class id, apiName, and shortest-path depth. **:** when `methodName` is supplied, each covering test ALSO carries `exercisesMethod` — true when its shortest reaching path enters the target via a `callsApex` edge whose `methods[]` includes that method, i.e. the test actually exercises the CHANGED method, not just the class — and the payload carries `methodCoveringCount` (tests with `exercisesMethod === true`; `null` for a class-level query). So a changed method names the test(s) that cover IT. Heuristic + shortest-path (a method reachable only via a longer alternate path may read false; `dispatchesAsync` hops carry no method index); `methods[]` populates on vaults refreshed after, older vaults fall back to the scalar `methodName`. The depth-3 cap and dynamic-dispatch invisibility surface verbatim in `disclosure`. Invalid prefix surfaces as `invalid-query`; unknown target surfaces as `component-not-found`. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when the analyzed class uses dynamic Apex, since reflective invocation can make the test→method mapping incomplete.",
    inputSchema: TEST_COVERAGE_FOR_METHOD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.meaningful_test_audit',
    description: "Lists every ApexClass with `properties.isTest === true` with a heuristic assertion-meaningfulness score. Each `tests[]` entry carries `assertionCount` (from `properties.assertionCount` when the R2 recognizer ran; 0 otherwise), `fakeAssertionCount` (count of `qualityIssues[]` entries with `rule === 'fake-assertion'`), `sourceBytes`, a per-KB `density` metric, and the verbatim per-test fake-assertion locations for follow-up triage. Ranking: `fakeAssertionCount` DESC, then `density` ASC (sparse asserts surface higher). Optional `classFilter` narrows to specific ApexClass ids; `nameContains` narrows to the test classes whose api name contains a case-insensitive substring (a needle matching nothing returns an honest empty list, never the org-wide leaderboard); `targetClass` (or its `componentId` / `classApiName` aliases) instead scores the covering tests of a PRODUCTION class. The applied scope is always echoed as `appliedScope` (`org-wide` / `class-filter` / `name-filter` / `covering-tests`) so a scoped answer is never mistaken for the full roster. Honesty axis (verbatim): `assertionCount` counts `System.assert*` and the modern `Assert.*` class; the fake-assertion recognizer is still scoped to `System.assertEquals` shapes — helper methods (`MyTestHelper.assertField`) and framework wrappers are invisible to both. A test with high fakeAssertionCount MAY actually have meaningful tests via a custom assertion helper.",
    inputSchema: MEANINGFUL_TEST_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.method_reachability',
    description: "Given an ApexClass / ApexTrigger (`classApiName` / `componentId` / `apiName` — a bare name or an `ApexClass:` / `ApexTrigger:` id, interchangeable, resolved + echoed as `appliedScope`), walks upstream `callsApex` BFS (capped at depth 3) and classifies the reachable upstream set against the entry-point taxonomy: `ApexTrigger` (any), `ApexClass` with `properties.isRestResource === true` (REST), `properties.hasAuraEnabledMethod === true` (Aura), `properties.hasInvocableMethod === true` (Flow / Process Builder), or any of `properties.isQueueable` / `properties.isBatchable` / `properties.isSchedulable` (async dispatch). Verdict cascade: `entry-point-reachable` (at least one entry point reaches the target), else `test-only-reachable` (at least one test class reaches it), else `likely-dead-code` (neither). Honesty axis (verbatim): dynamic dispatch (Type.forName) and reflective invocation are invisible — a class genuinely invoked at runtime via reflection will surface as `likely-dead-code`. Trigger framework base classes (TriggerHandler, fflib) may be partially invisible. Invalid prefix surfaces as `invalid-query`; unknown target surfaces as `component-not-found`. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when the analyzed class uses dynamic Apex, since a reflective caller can make the reachability verdict wrong.",
    inputSchema: METHOD_REACHABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tests_for_change',
    description: "Smart test selection (test-impact analysis): given `changedComponents` (1..500 ApexClass / ApexTrigger ids or bare class names — each entry may also be a `review_change`-shaped selector object `{ componentId }` / `{ type, apiName }` with an ignored `changeKind`; a single component may instead be passed as a TOP-LEVEL `componentId` / `{ type, apiName }`, folded into a one-item set — the canonical string-array call is byte-identical), returns the MINIMAL set of test classes to run plus the inverse risk signal — changed components no test reaches. For each changed Apex component, BFS upstream over INCOMING `callsApex` AND `dispatchesAsync` edges (depth-3 capped, same as `sfi.test_coverage_for_method`) and collects every reached `properties.isTest === true` node. `selectedTests` is the union (each entry carries `minDepth` and the `coversChanges` ids it exercises). `perChange` reports per-component coverage; `uncoveredChanges` lists changed non-test classes NO test reaches (the unguarded surface). A changed component that is itself a test class is added at depth 0 (run it directly) and never counted as uncovered. Non-Apex `Type:` prefixes bucket into `unsupportedChanges`; well-formed-but-absent Apex ids bucket into `notFoundChanges` — neither fails the batch. Honesty axis (verbatim): CLASS granularity (method-level promised.1); dynamic dispatch (Type.forName), reflective invocation, and managed-package test classes are invisible; BFS depth-3 capped — deeper coverage chains surface as uncovered. A component in uncoveredChanges is UNGUARDED — run the full suite when any change is uncovered or a deep chain is suspected.",
    inputSchema: TESTS_FOR_CHANGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.review_change',
    description: "Pre-deploy change review (the CI/deploy gate): given `components` (1..500 change entries a host assembles from a PR / package.xml / `git diff`; each carries `changeKind` plus its selector — EITHER `{ type, apiName }` OR a single `componentId` (`Type:ApiName`, the canonical id straight from `sfi.resolve`) — the two are equivalent), returns a per-component risk verdict, its direct dependents, and the tests to run — ordered most-dangerous first. For each component it composes THREE existing signals, not reimplemented: (a) IMPACT — direct INCOMING edges (the query `sfi.get_impact` / `sfi.promotion_readiness` build on), EXCLUDING grantedBy (a Profile/PermissionSet FLS grant is ACCESS, not a breakage dependency) and parentOf (structural) per the access≠usage rule; (b) TESTS — the covering set from `sfi.tests_for_change` (Apex only; everything else is not-applicable); (c) VERDICT from the shared blocking/risky/review/safe vocabulary. Classification: a DELETED component with ANY dependent = `blocking` (removing it breaks them; a heuristic-only dependent still blocks — a false positive fails CLOSED, the safe direction for a gate); a MODIFIED component with firm (declared/parsed) dependents = `risky`, with heuristic-only readers = `review`; a zero-dependent change in a family the vault does not fully cover = `review` (absence is 'not checked', surfaced as coverageCaveat); an ADDED component absent from the vault = `safe` (its OWN forward references are NOT analysed — only name-collision + tests), an ADDED id that already exists = `review` (collision). A modified/deleted id the vault lacks = `review`, never fabricated. FRONTEND BUNDLES (LightningComponentBundle / Aura / Visualforce) also compose OUTBOUND risk the inbound-dependent model misses: a modified/added bundle with (almost) no incoming dependents is floored at `review` (never a bare `safe`) when it `callsApex` a controller or `references` a CustomPermission / FlexiPage — `outboundApex` / `outboundWires` name them and `selectedTests` carries the covering tests of the called Apex controllers (the bundle has no Apex tests of its own). `overallVerdict` is the worst across the set; `summary` tallies are always full (the `limit` cap only trims the inlined `reviewed[]` detail, and the most-dangerous rows sort first so the gate is never hidden). Honesty: analysis is against the LAST VAULT REFRESH of the TARGET org, which may drift from what is deployed — re-refresh before trusting a `safe`. Dependents are DIRECT (single-hop); the full transitive blast radius is `sfi.get_impact`. SELECTION ≠ VALIDATION. Optional `checkAccessParity: true` (default false; ADDITIVE `accessParity` section, omitting keeps the default output byte-for-byte unchanged) folds in a grant-completeness ('ships for nobody') check: each added/modified field/object with ZERO modeled Profile/PermissionSet grant (and no ViewAllData/ModifyAllData or standard-default access) is flagged as a candidate that would deploy invisible — did you forget the permission set? Zero-grant direction only (the 'ships for everybody' breadth is deferred to `sfi.live_permset_holders`), stamped with the vault's last refresh. CROSS-VAULT (`againstVault`, a registered alias OR a path to an org-kb): composes to answer 'will this changeset break anything in PROD?' — it opens that vault READ-ONLY and computes EVERY signal (dependents, verdict, tests, coverage) against ITS graph instead of the current (sandbox) one. It discloses `againstVault` (the target + its last refresh) with a prominent 'impact is against that vault, NOT the current one' note, `absentInAgainstVault` (changeset ids labelled modified/deleted that are ABSENT from the target — added relative to it, own contents not analysed), and an `extractorVersionCaveat` when the two vaults' product versions differ. Omitting `againstVault` keeps the default current-vault review byte-for-byte unchanged.",
    inputSchema: REVIEW_CHANGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cdc_subscribers',
    description: "Given an optional `sObjectFilter` (e.g., 'Account', 'Order__c'), enumerate every ApexTrigger, ApexClass, and Flow that emits an incoming `listensTo` edge into a Change Data Capture (CDC) event. recognizes CDC events by NAME PATTERN on the target apiName — standard objects use `{ObjectName}ChangeEvent` (no separator); custom objects use `{ObjectNameWithout__c}__ChangeEvent`. The sibling of `sfi.event_subscribers` (which handles `__e` Platform Events) — both walk the same R3 `listensTo` edge family but filter by different target name patterns. When `sObjectFilter` is supplied the tool computes the synthetic ChangeEvent id from the filter; when omitted every CDC-recognizable event in the graph is scanned. The summary surfaces total subscribers and unique change events. Honesty axis (verbatim): CDC subscription detection here recognizes by name pattern only — `EventBus.subscribe(...)` programmatic registration is invisible, and per-channel filter expressions in `*.platformEventChannelMember-meta.xml` are not extracted.",
    inputSchema: CDC_SUBSCRIBERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.async_chain_depth',
    description: "Given an ApexClass canonical id (`ApexClass:{Name}`), walks the transitive async chain via outgoing `dispatchesAsync` edges, capped at 10 hops. Returns `maxDepth` (deepest reached), `cyclesDetected` (true when a back-edge in the BFS spanning tree appears), `truncated` (true when depth 10 was hit with more nodes pending), `branchPoints` (classes with `>= 2` distinct downstream targets, sorted by branchCount DESC), and `chains` (every walked edge with its depth, sorted depth ASC then fromId/toId ASC). The `chainAsync` synthetic edge is NOT persisted to the graph — only this tool surfaces it. Honesty axis (verbatim): the Apex scanner producing `dispatchesAsync` is heuristic; reflective dispatch (`Type.forName + invoke`) and helper-wrapper dispatch (`MyHelper.enqueue(new MyJob())`) are invisible, so the walked chain may UNDERSTATE the runtime depth. Invalid prefix surfaces as `invalid-query`; unknown but well-formed ids surface as `component-not-found`.",
    inputSchema: ASYNC_CHAIN_DEPTH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.scheduled_job_catalog',
    description: "Returns one entry per ApexClass with `properties.isSchedulable === true`, with the per-class `scheduledByCalls` array surfaced from inbound `dispatchesAsync` edges whose `properties.dispatchMechanism === 'schedule'`. Each entry carries the class id, apiName, `isSchedulable: true`, the `scheduledByCalls` (caller class plus per-edge cron expression when available), and any `cronExpressions[]` property the apex-scanner populated. Optional `nameContains` narrows BOTH the Schedulable-class catalog and the scheduledFlows section to entries whose apiName contains the substring (case-insensitive) and echoes `appliedScope: { nameContains, mode: 'nameContains' }`; omit it for the intentionally org-wide catalog, and a filter that matches nothing returns an honest empty catalog, never the bare list. T7: the response also carries a `scheduledFlows` section — Flows whose `<start><schedule>` declares a design-time schedule (`scheduleFrequency` e.g. `Weekly`, `scheduleStartDate`, `scheduleStartTime`). `scheduleStartTime` is UTC (trailing `Z`); the local wall-clock run time depends on the org's default timezone, which the vault does not hold, so it is disclosed in UTC framing. This declarative Flow schedule is DISTINCT from the Apex Schedulable CronTrigger runtime registration (which lives only in the Tooling API). Honesty axis (verbatim): scanning for System.schedule() invocations is heuristic — the Apex scanner detects literal call sites only, NOT runtime registration via Tooling API. A class flagged `isSchedulable: true` may not currently be scheduled; conversely, a class scheduled via a helper-wrapper or dynamic class load is invisible to the scanner. The Flow schedule is the design-time metadata declaration, not proof the Flow is currently active.",
    inputSchema: SCHEDULED_JOB_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.outbound_message_catalog',
    description: "Returns one entry per OutboundMessage node (the promotion of the dangling-by-design `<outboundMessages>` references) with the endpoint URL, payload shape (fields list), integration user, the includeSessionId / useDeadLetterQueue flags, and the WorkflowRules that invoke it via incoming `references` edges. Optional `objectFilter` narrows to one parent CustomObject (e.g., 'Account'). `entriesByObject` groups entries by parent object key for renderer convenience. Honesty axis (verbatim): endpoint URLs are captured verbatim from `<outboundMessages><endpointUrl>` and NOT VALIDATED — does not probe the URL, does not confirm the destination exists, and does not confirm the message is actually invoked at runtime.",
    inputSchema: OUTBOUND_MESSAGE_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.endpoint_catalog',
    description: "Returns every URL / endpoint participating in an integration in one structured response, split four ways — `inboundApis` (from `exposes` edges to synthetic ExternalApi:{kind}/{path} targets; REST / Aura / Invocable), `outboundMessages` (from OutboundMessage `endpointUrl` properties), `externalDataSources` (from ExternalDataSource `endpoint` properties), and `namedCredentials` (from NamedCredential `url` properties). Each entry carries `endpointKind` discriminator, `direction` (inbound / outbound), `sourceComponentId`, and `url`. The URL-axis sibling of `sfi.integration_map` (which surfaces nodes + wiring) and `sfi.outbound_message_catalog` (which surfaces one category in depth). ORG-WIDE: an object / component argument is REFUSED with `invalid-query` (no endpoint→object association), never silently answered whole-org. Honesty axis (verbatim): URLs are captured verbatim; does NOT probe, does NOT validate, and does NOT confirm the destination exists or is reachable. Runtime registrations (e.g., a NamedCredential resolved via custom metadata at runtime) may carry a stored URL that differs from the actual production destination.",
    inputSchema: ENDPOINT_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_meaning',
    description: "Vocabulary + semantic-disambiguation tier — the 'what does this field actually mean in our org?' surface. Given a CustomField canonical id (`CustomField:{Object}.{Field}`), returns the field's declared shape (apiName, label, description, type, parent object, and — when present — `picklistValues` as `{ value, label, isActive }` entries where `isActive: false` marks a deactivated value that is retained-but-not-selectable and listed-and-marked rather than dropped (H10); a corresponding boundary surfaces when any value is inactive), asymmetric `usageFrequency` (incoming `readsFrom` vs incoming `writesTo` edge counts — reveals scratch-field patterns), the `sourceOfTruth` classification (`manual` | `derived` | `integration-synced` | `manual-and-coded` | `unknown` with `declared`/`heuristic` confidence) and `semanticCategory` classification (`identifier` | `status` | `amount` | `date` | `reference` | `descriptor` | `unknown`; always `heuristic` confidence), the top-3 `similarFields` by label/apiName token overlap ( TF-IDF is the canonical source per PLAN- §3; the lightweight overlap fallback ships here so the tool produces output independent of presence), and a `boundaries` array surfacing the -wide honesty axes (vocabulary is org-specific; usage frequency is static analysis only; classification is heuristic on writes-fabric inference; semantic category is name-pattern, not type-semantic). When the classifier has not populated `sourceOfTruth` / `semanticCategory` (pre- vaults), both default to `unknown` and the classification-missing boundary surfaces. Invalid prefix → `invalid-query`; unknown id → `component-not-found`.",
    inputSchema: FIELD_MEANING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.disambiguate_concepts',
    description: "Vocabulary + semantic-disambiguation tier — the 'is `Status` the same as `Stage` here?' surface. Takes two org-specific concept tokens (`conceptA`, `conceptB`) and returns per-concept matching-field buckets, per-axis differences (parent-object distribution, declared types, picklist-values, usage-pattern), and an optional `suggestedWhenToUseEach` inference (`null` when bucket parent-object distributions overlap — the tool refuses to fabricate distinction). A field matches a concept when (1) its apiName tokenized form overlaps the concept's tokens, OR (2) its label tokenized form overlaps, OR (3) `properties.semanticCategory.value` equals the concept (lowercased). The `boundaries` array carries the verbatim honesty anchor: 'Vocabulary is org-specific — one org's Status is another org's Stage; the tool reports what THIS org's metadata declares, not industry convention. Verify each field's label, description, and usage before treating the disambiguation as authoritative.' When `conceptA` equals `conceptB` (case-insensitive trimmed), buckets are returned identically with empty `differences` — the skill detects this and refuses to fabricate a distinction. Optional `limit` (1-200, default 50) caps each bucket's `matchingFields` slice.",
    inputSchema: DISAMBIGUATE_CONCEPTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_provenance',
    description: "Vocabulary + semantic-disambiguation tier — the 'is this field manually entered or automated?' surface. Given a CustomField canonical id, returns the `sourceOfTruth` classification + confidence plus the full structural trace: `declaredAsFormula` (formula expression when the field has one), `declaredAsAutoNumber` (displayFormat when the field is auto-number), ALL `apexWriters` (with `isIntegrationTagged` from outgoing `references` edges to NamedCredential / ExternalDataSource — the integration-synced classifier signal), ALL `flowWriters`, ALL `triggerWriters`, and the `noWritersDetected` boolean (false for formula / auto-number fields per PLAN- — the declaration IS the source). The trace lists EVERY writer, not just the ones used in the classification cascade, so callers can verify the classification's basis. `boundaries` carries the verbatim 'dynamic SOQL, reflective field access, and managed-package writers may be invisible' disclosure; when classification is heuristic the additional 'classification is heuristic on writes-fabric inference' boundary surfaces. Invalid prefix → `invalid-query`; unknown id → `component-not-found`.",
    inputSchema: FIELD_PROVENANCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.interpret',
    description:
      "WHEN to reach for this: the user asks what a component structurally IMPLIES, or the CONSEQUENCES of a design — 'what happens to child records if I delete this parent?', 'is this field derived/formula or a roll-up (read-only)?', 'why can't I see these records by default?', 'do I have stacked record-triggered automations on this object (execution order undefined)?', 'why did my save fail with this status code?', 'does this territory sharing rule grant access based on the user's territory assignment?'. You may pass a NATURAL identifier (`Account.Amount__c`, a bare object name, a class name) — it is put through the same shared resolver `sfi.resolve` uses and the chosen anchor is echoed in `resolvedFrom`; an identifier matching several components returns `invalid-query` naming every candidate, never a silent pick. A canonical id skips resolution entirely. Call this tool, then fold the returned `claim` text into your answer with `sfi.synthesize_answer` (which carries the `groundedIn` ids as citations). RM-wire reasoning surface — the 'what does this component STRUCTURALLY imply?' tool. Given ONE component `componentId` (any canonical id, e.g. `CustomField:Account.Amount__c`, `CustomObject:Order__c`, `Flow:Order_Sync`), runs the DETERMINISTIC concept-rule reasoning engine over an offline graph slice assembled for it and returns grounded, CITED interpretations — never an LLM inference, never a live read. For each applicable curated `ConceptRule` (status-code cross-reference, master-detail cascade + roll-up, junction structural-pattern detection (an object with two master-detail parents — the many-to-many signature, not a proven pure-connector intent), field derived/formula source detection, automation collision [stacked / co-resident record-triggered automations, execution order undefined], OWD sharing posture, coupled-write [firer-anchored], async-boundary [Queueable/Batch/Scheduled/@future Apex, and dispatchesAsync call sites, run in a SEPARATE transaction — writes not visible to the enqueuing save, effect deferred], external-api-surface [an Apex class annotated @RestResource / @AuraEnabled / @InvocableMethod exposes an entry point reachable OUTSIDE the record UI and its automation — an integration/security surface where FLS/CRUD are NOT auto-enforced in Apex and must be coded, while record-level sharing depends on the class-level with/without-sharing declaration — a separate concern; it does NOT assert the endpoint is insecure or WHO calls it], apex-sharing-mode [an Apex class declared `without sharing` runs in SYSTEM context and does NOT enforce the running user's record-level sharing (often intentional, not by itself a vulnerability); `inherited sharing` enforces the caller's sharing only when the class is the entry point, so enforcement depends on the execution context; FLS/CRUD are a SEPARATE concern and the declaration is class-level, not per-method — the DECLARED posture, not a proven access outcome], system-context-external-surface [an Apex class that is BOTH declared `without sharing` AND externally reachable via @RestResource / @AuraEnabled / @InvocableMethod — an external caller can reach code that runs in SYSTEM context and does NOT enforce the running user's record-level sharing, so the COMBINATION is a security-REVIEW priority; it may still be intentional and is NOT by itself a vulnerability, FLS/CRUD are a SEPARATE concern, and it is the DECLARED posture, not a proven access outcome], view-modify-all object grant [a permission set or profile that grants object-level View All Records / Modify All Records on an object — holders can READ (View All), or read/edit/delete (Modify All), EVERY record of that object regardless of the org-wide default, sharing rules, role hierarchy, or manual shares, so it OVERRIDES record-level sharing even when OWD reads Private (closing the OWD concept's acknowledged gap); Modify All is the stronger form that INCLUDES View All, so on a Modify-All grant both fire as one escalating grant; object-level only — does NOT bypass field-level security, is NOT the org-wide View All Data / Modify All Data SYSTEM permission, says nothing about other objects, and does NOT assert WHO HOLDS the permission set/profile (an assignment/live question) — the DECLARED grant, not a proven per-user access outcome; many grantors on one object read as an ENUMERATED SET]) it emits at most one `Interpretation` carrying the `claim`, the `groundedIn` component ids it is grounded in (no citation ⇒ no claim), a `confidence` that is the WEAKEST of the rule ceiling and its matched edges (never asserted above its ground), the firing `ruleId`/`concept`, and a per-rule `coverageCaveat`. Optional ADDITIVE filters narrow which rules run: `concepts` (keep only rules for these concept ids) and `ruleIds` (keep only these rule ids) — an EMPTY array matches NO rule. Output carries `rulesConsidered` / `rulesFired`, a `sliceTruncated` flag (a hub whose edge count exceeds the cap forces coverage to at most `partial` so an absence rule can never read `complete` over a clipped slice), a `trust` block (`provenance: 'offline_snapshot'`, confidence = weakest across fired interpretations or `unknown` when none, completeness from coverage), and a `disclosure`. HONESTY: when NO rule fires, `rendered` + `disclosure` say 'no concept rule fired for this component — this is NOT a claim that nothing depends on it', so an absence of matched rules is never read as an absence of dependencies. Unknown id surfaces as `component-not-found` (phantom-aware). When a natural identifier was resolved, `resolvedFrom` names the identifier, the match kind and the score — relay it, because the user named one thing and the claims are about another.",
    inputSchema: INTERPRET_INPUT_SCHEMA,
  },
  // v2.2 R2 — universal find-anywhere + discovery surface.
  {
    name: 'sfi.find_field_anywhere',
    description: "Universal-search surface — answers 'where is this field used anywhere in the org?' for one CustomField id, passed as `targetId` or its alias `fieldId` (field-tool-family parity). Walks every incoming non-parentOf edge to the field and groups the referrers by ComponentType: ApexClass / ApexTrigger reads/writes, Flow record-ops, Layout placements, ValidationRule formula refs, SharingRule criteria refs, etc. Each reference carries the referrer's identity, the edge type (`readsFrom` / `writesTo` / `references` / `usedInLayout`), the edge's source extractor, the stored confidence (`declared` for layout/formula edges, `parsed` for Apex edges the default-on AST resolved — including fields referenced only inside inline static SOQL or constant-string Database.query literals — and `heuristic` for regex apex-scanner / lwc-scanner edges), and the per-edge properties. Returns `byEdgeType` counts across the FULL set (not the truncated slice). When a ComponentType bucket overflows `limit`, that section is paged via `nextCursor` and the rest are disclosed by count + `otherSections` (echo `nextCursor` back as `cursor` to walk section-by-section). Honesty axis (verbatim): string-BUILT dynamic SOQL, reflective field access (`obj.get('FieldName')`), and managed-package code are invisible to the graph edges this tool walks — inline STATIC SOQL and constant-string Database.query field references ARE resolved (parsed Apex edges). Invalid prefix → `invalid-query`.",
    inputSchema: FIND_FIELD_ANYWHERE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_semantic_field',
    description: "Semantic-discovery surface — answers 'do we already have a field for X?'. Takes a natural-language `description` and ranks CustomFields by token-overlap (Jaccard) between the query tokens and each field's combined apiName + label + description bag, tokenized per `SemanticSearchSemantics.md` § 'Tokenization rules' (suffix strip, namespace strip, underscore + CamelCase split, lowercase, length filter, stop-word filter). Returns the top `limit` matches above `minScore` (default 0.1); a truncated page returns a `nextCursor` to resume. Each match carries `confidence: 'heuristic'` ( enforcement at the type level), the score, the `matchedTokens` array, and the parent objectId. Optional `objectIds` narrows to fields on a subset of objects. The `boundaries` array surfaces the verbatim honesty anchor on every call: 'this is a similarity-ranked recommendation … verify the returned field's label and description before treating as the answer.'",
    inputSchema: FIND_SEMANTIC_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_hardcoded_values_anywhere',
    description: "Cross-corpus hardcoded-value surface — extends `sfi.find_hardcoded_values` (Apex-only) with formula expressions (CustomField.formula), ValidationRule.errorConditionFormula, and WorkflowRule.formula. Supports exact-value mode (`value` specified — `confidence: 'declared'`), shape mode (`category` of `id`/`email`/`date`/`numeric` — `confidence: 'heuristic'`), and combined mode (both). `scope` narrows the searched corpora (default all four). Returns `byCategory` and `bySource` tallies across the FULL set. KEY USE CASE: to find every ValidationRule whose errorConditionFormula references a CustomPermission guard (e.g. `NOT($Permission.SkipValidation)`), use exact-value mode: `find_hardcoded_values_anywhere({ value: '$Permission.SkipValidation', scope: ['validation-rule'] })`. The formula text is stored offline in node properties and is fully searchable. Do NOT claim `$Permission.*` guards in errorConditionFormula are undetectable from metadata — they are present as text in the vault and this tool returns matching ValidationRule nodes. Honesty axes (verbatim): numeric category has very high false-positive rate (loop counters, indices, constants); ID category is filtered to a key-prefix allowlist; matches in `@isTest`-annotated classes may be intentional test fixtures. Must specify at least one of `value` or `category`. A truncated page returns a `nextCursor` to resume.",
    inputSchema: FIND_HARDCODED_VALUES_ANYWHERE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_clone_patterns',
    description:
      "Structural clone-detection surface. TWO modes. **Seed mode** (`componentId` given) — 'are there other classes / flows like THIS one?': computes the structural fingerprint (set of called Apex / read fields / written fields; triggeredObject for Flow) from outgoing edges and ranks every other same-type component by Jaccard similarity. For Apex: `0.40*callsApexJaccard + 0.30*readsFromJaccard + 0.30*writesToJaccard`. For Flow: `0.40*calledApexJaccard + 0.20*fieldReadJaccard + 0.20*fieldWriteJaccard + 0.20*triggeredObjectMatch`. Returns `matches` above `minScore` (default 0.3) with `similarityBreakdown`. **Cluster mode** (`componentId` OMITTED) — 'where are the copy-pasted classes in this org?': scans every component of `type` (default `ApexClass`; or `ApexTrigger`/`Flow`), scores all pairs, and union-finds those `>= minScore` into `clusters`, each with a stable `clusterId`, its members, and its tightest pair (`topScore`/`topPair`). O(n²), capped at 800 nodes. Every result is `confidence: 'heuristic'`. Honesty axis (verbatim): the fingerprint approximates structural shape, not behavior — two classes with identical fingerprints may behave differently. Cross-type comparison is not supported.",
    inputSchema: FIND_CLONE_PATTERNS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_dead_code',
    description: "Cross-cutting dead-code surface — composes `method_reachability` verdict, entry-point taxonomy (REST / Aura / Invocable / Queueable / Batchable / Schedulable / triggers), and zero-usage detection into a single cascade verdict per candidate: `definitely_dead` (zero incoming USAGE edges and not own entry point), `likely_dead` (test-class-only reach), `uncertain` (entry-point reach or own entry point). A Flow is its OWN entry point unless its status is Obsolete/InvalidDraft (R2-12): an Active, Draft, or unknown-status Flow is `uncertain` (never definitely_dead/likely_dead), because Flow edges are all OUTGOING so a live flow has ~0 incoming edges by nature — flagging it dead would delete running automation; only Obsolete/InvalidDraft flows fall through to definitely_dead. : subflow invocation (flow-calls-flow) IS now modeled as an incoming `references` edge, so an Obsolete/InvalidDraft flow still invoked as a subflow by another flow reads `uncertain` (it has a live dependent) instead of definitely_dead — delete the referencing flow first. `parentOf` (structural) and `grantedBy` (Profile / PermissionSet access grants) edges are excluded — access is not usage, so a class nobody calls or a field nothing references is dead even when profiles grant access to it. Scope to ONE component with `componentId` (`ApexClass:`/`ApexTrigger:`/`Flow:`/`CustomField:` id) — or a bare class name via `classApiName`/`apiName` — to get just that node's verdict (`uncertain` included) + `appliedScope`; an unresolved id is `component-not-found`, a non-dead-code prefix is `invalid-query`, never a silent org-wide top-N. Default `types` covers ApexClass / ApexTrigger / Flow / CustomField. `includeUncertain` (default false) suppresses the noisy uncertain bucket. Test classes (properties.isTest === true) are NEVER flagged as dead — they ARE entry points for the test-runner. Returns `byVerdict` and `byType` tallies across the FULL set; truncated slice flips `truncated: true` and a truncated page returns a `nextCursor` to resume. Honesty axis (verbatim): dynamic dispatch, reflective invocation, framework wiring (TriggerHandler / fflib), and managed-package callers are invisible to the graph edges this tool walks. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when a candidate class uses dynamic Apex — a class reached only reflectively will read as dead — so a `dead` verdict on a flagged class needs a human check before deletion. When any CALLER family (LWC, Aura, Flows, FlexiPages, Visualforce, …) has incomplete coverage — errored retrieve, scoped refresh, or an in-progress staged build — the response adds a `coverageCaveat` naming the families: an un-retrieved caller would fake death.",
    inputSchema: FIND_DEAD_CODE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.package_impact',
    description:
      "Managed-package boundary surface — 'what does the {namespace} package touch, and what of MINE breaks if I uninstall/upgrade it?'. No InstalledPackage metadata is modelled; package membership is derived from the API-name NAMESPACE PREFIX (a leaf name splitting into >= 3 '__'-segments — `NS__Object__c` — is namespaced; `Object__c` and standard names are not). INVENTORY mode (no `namespace`) scans every node and lists the packages visible in the vault with component counts, most-entangled first — including packages present ONLY via your EXTENSIONS (`extensionCount` > 0 with `componentCount` 0: components you parented under a package's objects), so a package whose own objects are phantoms (e.g. HEDA `hed`, whose managed objects come down as phantom references) is still surfaced as installed instead of reading as 'no packages'. IMPACT mode (`namespace`, e.g. 'SBQQ' — OR a `namespacePrefix` / `packageId` / `componentId` selector: the Salesforce-shaped `namespacePrefix` synonym a host reaches for, a bare namespace, or the `InstalledPackage:<namespace>` id the catalog returns, each resolved to the namespace instead of silently falling back to INVENTORY; an unrecognized selector is an `invalid-query`, never a silent full inventory) returns the package's visible components, `yourDependencies` (incoming non-parentOf edges from components OUTSIDE the namespace — the uninstall blast radius, each carrying fromId/fromType/edgeType/confidence), and `yourExtensions` (your components parented UNDER a package component — custom fields you added to `SBQQ__Quote__c`, orphaned on uninstall). Verdict is staged so it can NEVER read soft-safe while a touchpoint or blind spot is present: `has-dependencies`; `members-present-no-static-inbound` (the package HAS visible members but no STATIC inbound reference — you are carrying its metadata, NOT 'safe to uninstall'); `incomplete-scan` (the node/edge scan was truncated); `review` (no visible members but the absence is un-provable — a producer family was not fully retrieved); or the bare `no-detected-dependencies` ONLY when nothing hides a touchpoint (no members, complete scan, no coverage gap) — the caveat and the verdict AGREE (NEVER 'safe to uninstall'). Honesty axis (verbatim): managed Apex referenced via dot-notation (NS.ClassName) and namespaced components without a standard suffix are invisible; a package's INTERNAL components are usually never retrieved, so packageComponentCount reflects what you can SEE; even `no-detected-dependencies` means no STATIC evidence in retrieved metadata (dynamic SOQL, Type.forName, merge-field references, and unretrieved metadata are invisible) — validate every uninstall in a sandbox first.",
    inputSchema: PACKAGE_IMPACT_INPUT_SCHEMA,
  },
  // v2.6a R2 — CPQ specialist tier. Three tools layered on top of the
  // v1.6 record extractors via the `cpq-extractor` heuristic
  // specialization. All three carry the verbatim recognition-axis
  // disclosure on every emitted response; the `SBQQ__` namespace prefix
  // is the structural recognition signal.
  {
    name: 'sfi.cpq_rule_chain',
    description: "Given a CpqProductRule or CpqPriceRule canonical id, returns the chain of rules of the same type sharing the same parent CustomObject (the SBQQ__ rule object definition), sorted by `(active DESC, evaluationOrder ASC, id ASC)`. Each chain entry carries the rule's id, apiName, label, active flag, evaluationOrder, and a 1-indexed `position`. The input rule's position is surfaced separately as `targetPosition`. Honesty axis (verbatim, surfaced ALWAYS): the rule chain reflects the -extracted CPQ records only; Apex-customized CPQ rule firing logic (custom `SBQQ.QuoteCalculatorPlugin` implementations) is invisible; runtime re-ordering via the CPQ pricing API is invisible. The chain order shown is the declared evaluation order, not the runtime order. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: CPQ_RULE_CHAIN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cpq_quote_template_breakdown',
    description: "Given a CpqQuoteTemplate canonical id, returns the template's top-level configuration (`templateContentReference` from the `SBQQ__Template__c` field, `documentFormat`, `landscape`, `pageBreakBefore`, `active`, `defaultTemplate`) plus a best-effort `sections` list derived from values whose `field` token begins with `SBQQ__Section__c`. Honesty axis (verbatim, surfaced ALWAYS): the full section / field mapping sub-records (`SBQQ__TemplateSection__c`, `SBQQ__TemplateContent__c`) are NOT extracted by — the sections surfaced here are a best-effort projection from the template's top-level values mirror; a complete breakdown requires opening the template in the CPQ Quote Template Editor. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: CPQ_QUOTE_TEMPLATE_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cpq_dependency_map',
    description: "Walks the values mirror of every requested CPQ-typed node and surfaces every string-encoded `SBQQ__`-prefixed field reference as a heuristic dependency entry. When `cpqComponentId` is provided, the walker scans only that one component; when omitted, it scans every CPQ-typed node in the vault and pages the resulting dependency list by `limit` (default 50, max 200) — a truncated page returns a `nextCursor` to resume. Each dependency entry carries `fromComponentId`, `fromComponentType`, `fromApiName`, the matched `referencedFieldToken`, and an `occurrenceCount`. Honesty axis (verbatim, surfaced ALWAYS): CPQ dependency mapping is heuristic — string-value scanning catches direct field references but misses formula-walked dependencies, numeric id references, and dynamic-dispatch resolutions. Use this output as a starting point for impact analysis, not as an authoritative dependency graph.",
    inputSchema: CPQ_DEPENDENCY_MAP_INPUT_SCHEMA,
  },
  // v3.0 — unified field forensics synthesis tier (PLAN-v3.0).
  // Two compositional tools over the v0.1-v2.9 extracted graph;
  // surfaces the verbatim Q165 disclosure naming the v1.x extraction
  // gap (`dataNotAvailable: ['list-view-filters', 'reports',
  // 'dashboards']`) on every response. The single accompanying
  // extraction extension (EmailTemplate body merge) ships in the
  // `email-template` extractor; both tools COMPOSE — they do not
  // extract — and the value lies in compositional ergonomics for
  // cross-tier field-forensics questions.
  {
    name: 'sfi.field_360',
    description: "A complete 360 profile of a single FIELD — everything that touches that field across validation, formulas, automation, code, UI, integrations, and emails, in one place. (Field forensics — this is about a field, NOT a user Profile or permissions.) The go-to answer for \"give me the full profile of this field\", \"the full picture of {Object}.{Field}\", \"everything that uses {Object}.{Field}\", \"what touches this field across automation and code\", or a BA's field impact assessment before a change. unified field-forensics synthesis tool. Given a CustomField canonical id (or short `<Object>.<Field>` form), composes every prior tier's reads of the field into one structured response with ten optional content sections (`validates`, `formulas`, `writers`, `readers`, `ui`, `integrations`, `automations`, `emails`, `dependencies`, `summary`) plus the constitutional honesty axis. A validation rule that reaches the field BOTH ways (a direct `references` edge and its own condition's `readsFrom`, both tokenized from one `errorConditionFormula`) is listed ONCE under `validates` — `validates` and `automations` never both hold one rule — with the fold named in `boundaries[]`; the folded rows still count on the automation RISK axis, so `riskLevel` is unaffected by the collapse. Optional `includeSections` narrows the response; `maxRowsPerSection` (default 50, max 200) bounds per-section row counts; `groupBy` (default `'source'`) reshuffles the rendering hint. The `summary` carries per-section unfiltered counts AND a `riskLevel` (`'low' | 'medium' | 'high'`) computed per PLAN- §4.1 with the specific `riskFactors[]` enumerated; PII risk factors are computed live via the heuristic pii recognizer (EncryptedText / SSN / financial names), not read from a stamped property. The `boundaries[]` array carries the verbatim disclosure naming which surfaces are composed vs folded elsewhere (list views, reports, dashboards); `dataNotAvailable: ['list-view-filters', 'reports', 'dashboards']` surfaces verbatim regardless of section filter. D3: a Flow decision / record-trigger filter that references this field carries NO `readsFrom` edge (it is a `firesWhen` edge to a ConditionalContext), so such Flow reads are RECONSTRUCTED from the graph's ConditionalContext `fieldRefs` and surfaced in `readers` as heuristic-confidence rows (`source: flow-condition-reads-scan:*`, deduped against real `readsFrom` readers) — otherwise `readers` would read 0 for a field several Flows filter on; `boundaries[]` also names the referrer classes still NOT composed into any section (roll-up source coupling, layout related-list placement). Top-level `confidence` reports `'mixed'` when sections span tiers (the typical case for any real-org field). Honesty axis (verbatim, ALWAYS): synthesis without omission disclosure is a contract violation; the report is the COMPLETE answer ONLY for extracted axes. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`. When the vault holds captured data-shape facts (`refresh --with-data-shape`), the response embeds a `dataShape` block — the field's sampled fill rate as a stamped `data_snapshot` (sampled + TTL-checked; context, never a live read). Every response also carries `conceptReasoning` (DEFAULT ON; pass `includeConceptReasoning: false` to skip it): the deterministic concept-rule engine (`sfi.interpret`) run over this component, returning CITED claims on the shared EvidenceEnvelope v2 shape plus a `completeness` digest that keeps four states apart — rules that FIRED, rules EVALUATED against this component that matched nothing, rules PROVABLY inapplicable to this component type, and rules that could NOT be evaluated (the vault lacks their metadata, or their bind shape could not be proven inapplicable). Read `completeness.noRuleCoversComponentType` FIRST: when true, NOTHING was checked and an empty `claims` list is silence, never a clean bill of health. Its bytes are RESERVED from the response budget before the rest of the answer is fitted, and its claim list is capped for size — `sfi.interpret` is the uncapped surface.",
    inputSchema: FIELD_360_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_lineage',
    description: "Trace where a field's value comes from and what it feeds — its data provenance upstream (which automations, formulas, code, or integrations set it) and its downstream effects (what reads it, what fires because of it). Answers \"where does this field get its value\", \"what depends on this field\", \"trace this field across automation and code\". provenance + downstream-effects walker. Given a CustomField canonical id (or short `<Object>.<Field>` form) and a `direction` (`'upstream' | 'downstream' | 'both'`), walks the writers (upstream) or effects (downstream) graph up to `maxDepth` hops (default 3, max 5). Upstream sources carry `sourceKind` (`'workflow-field-update' | 'flow-assignment' | 'apex-write' | 'process-builder-assignment' | 'formula-source' | 'flow-input-field' | 'integration-inbound' | 'source-of-truth-field'`), `depth`, `confidence`, and `reachableVia[]` for the per-source path. flow dataflow: a FLOW writer no longer dead-ends the upstream walk — the extractor traces each DML input assignment back through the flow's internal assignment chain (variables, formulas, record-lookup outputs, loops), and the walk surfaces those record fields as `flow-input-field` sources one hop past the flow and RECURSES into them, so a field written by Flow A from a field written by Flow B chains end-to-end. Per-hop confidence is the trace label: `declared` ONLY for direct $Record / single-record-lookup chains (incl. clean single-Assign variable hops), `heuristic` through formulas/loops/non-Assign operators; inputs the extractor could not statically resolve (ambiguous reassigned variables, relationship traversals, action/screen outputs, chains past the trace depth cap) surface as the DISCLOSED `upstream.flowDataflow.unresolvedInputCount` — never as guessed fields — and flow write edges from a pre-tracer vault are counted in `flowDataflow.untracedFlowWriteEdges` (re-refresh to trace them). Downstream effects carry `effectKind` (`'flow-decision-branch' | 'apex-if-clause' | 'workflow-fire' | 'validation-fire' | 'integration-outbound' | 'email-fire' | 'formula-recompute' | 'flow-field-write'`), `conditionId` when the effect was sourced from a ConditionalContext, and the verbatim `firesWhen` literal when the edge carries one; a `flow-field-write` effect is the downstream mirror of the flow dataflow (a Flow READS this field and writes its value onward into `targetFields[]` — the walk continues into each written field at depth + 1). The upstream payload also carries a `formulaChain { maxDepth, crossesObject }` summary computed from the `formula-source` entries — `maxDepth >= 2` means this field's formula references ANOTHER formula (a multi-hop recompute cascade), and `crossesObject` flags a cross-object formula reference. source-of-truth fields are terminal in the upstream walk; cycle-detection + depth-bound discipline applies in both directions. `includeFieldsOfTruth` / `includeFiresWhen` default to true. Honesty axis (verbatim, ALWAYS): conditions in `firesWhen` are listed but NOT EVALUATED; the walk is depth-bounded — deeper transitive provenance is NOT walked; lineage inherits the same `dataNotAvailable[]` disclosure as `sfi.field_360`. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: FIELD_LINEAGE_INPUT_SCHEMA,
  },
  // v3.1 — cross-org / sandbox-vs-prod comparison tier (4 tools). Reads
  // two registered vaults through `@sf-intelligence/vault`'s registry
  // primitives, then composes per-pair diff over the existing
  // v0.1-v3.0 extraction surface. No new ComponentTypes / EdgeTypes /
  // properties — pure composition tier per PLAN-v3.1 §1.
  {
    name: 'sfi.compare_vaults',
    description: "Given two registered vault aliases, returns a structured diff identifying `added` (in B only), `removed` (in A only), and `shapeModified` (in both with at least one non-volatile property differing) components. Optional `objectFilter` narrows to one object's parented graph; optional `typeFilter` narrows to one ComponentType family. The volatile-property filter (default ON) suppresses lastModifiedDate / lastModifiedBy / source-tree-hash / manifest-timestamp drift inherited verbatim from. : `edgeDrift` covers what node-hash comparison alone misses — for every component present in BOTH vaults (independent of whether its own properties matched), it diffs the two vaults' OUTGOING edge sets (identity = edgeType + toId + referenceKind when present) and reports per-component `edgesAdded[]` / `edgesRemoved[]` (capped at 200 components / 50 rows each, `summary` holds the true totals); a referenceKind change on an otherwise-identical edge appears as one removed + one added row, not a single 'modified' row. `extractorVersionCaveat` is present when the two vaults' manifests report different sf-intelligence product versions — an edge-set (or node) difference between differently-extracted vaults may reflect an EXTRACTOR change, not a real org change. `boundaries[]` ALWAYS surfaces (1) the volatile-filter disclosure naming the suppressed property paths and the `includeVolatileProperties: true` opt-out, (2) the api-name-match correspondence disclosure (renamed components appear as remove+add, NOT as modified), and (3) the edgeDrift scope disclosure. Unknown alias surfaces as the verbatim `vault alias '{alias}' is not registered. Run \\`sfi register-vault {alias} <path>\\` first, or \\`sfi list-vaults\\` to see what's registered.` refusal — the honesty anchor. Pass `format: 'markdown'` to also get a rendered `markdown` drift dashboard (summary counts + added/removed/shape-modified/edge-drift tables with per-property A→B drift) over the same buckets. : `sfi.compare_object_across_vaults` shares this SAME edgeDrift axis (reusing the identical diff primitive), scoped to one object's own components.",
    inputSchema: COMPARE_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.promotion_readiness',
    description:
      "Promotion readiness: a focused lens on compare_vaults(sandbox → prod). Given two registered vault aliases (`sandbox`, `prod`), returns the SANDBOX-ONLY component set — present in sandbox, absent from prod — i.e. exactly what a deploy must ADD, ranked by how many OTHER sandbox components depend on each one (distinct inbound edges in the sandbox graph) so you deploy the most-depended-on first. Each `promotionItems[]` entry carries `inboundDependencyCount` + a `dependedOnBy` sample; `byType` buckets the set; `summary.sandboxOnlyCount` is the true total (the list is capped at 200). Honesty: the dependency count is a deploy-ORDER priority HINT, not a strict topological order (a dependent may already be in prod or be sandbox-only itself); it is a vault-only structural diff over each vault's last refresh and does NOT deploy or validate against the live org; renamed components read as remove+add; it compares presence, not field/permission shape drift (use compare_vaults shapeModified for that). Unknown alias surfaces the register-vault directive. Optional `typeFilter`.",
    inputSchema: PROMOTION_READINESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_object_across_vaults',
    description: "Given a CustomObject api-name and two registered vault aliases, returns the field-by-field diff — `addedFields` (in B only), `removedFields` (in A only), `shapeModifiedFields` (in both with at least one non-volatile property differing) — plus `objectLevelDrift` for CustomObject-level property differences (sharingModel, description, deploymentStatus). `objectExistsInA` / `objectExistsInB` surface false when the named object is missing from a vault. `unchangedFieldCount` / `totalFieldCountA` / `totalFieldCountB` quantify the unfiltered sets so consumers see the baseline. : `edgeDrift` shares the SAME axis `sfi.compare_vaults` has — for the object node itself and every paired field present in BOTH vaults (independent of whether its own properties matched), it diffs the two vaults' OUTGOING edge sets (identity = edgeType + toId + referenceKind when present) and reports per-component `edgesAdded[]` / `edgesRemoved[]` (capped at 200 components / 50 rows each, `summary` holds the true totals); a referenceKind change on an otherwise-identical edge appears as one removed + one added row, not a single 'modified' row. `extractorVersionCaveat` is present when the two vaults' manifests report different sf-intelligence product versions — an edge-set (or node) difference between differently-extracted vaults may reflect an EXTRACTOR change, not a real org change. `boundaries[]` ALWAYS carries the volatile-property filter disclosure, the field-api-name-match correspondence disclosure (renamed fields appear as remove+add), and the edgeDrift scope disclosure. Unknown alias surfaces as the verbatim refusal.",
    inputSchema: COMPARE_OBJECT_ACROSS_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_profile_across_vaults',
    description: "Given a Profile name and two registered vault aliases, returns per-grant-category drift — `grantDiffs.objectPermissions`, `.fieldPermissions`, `.tabVisibilities`, `.apexClassAccesses`, `.userPermissions`. Each `GrantDiff` carries `targetId`, `side` (`'A' | 'B' | 'both'`), `valueA`, `valueB`. `summary.totalDriftCount` / `perCategoryDriftCount` quantify the drift. `summary.notEvaluatedCategories` lists categories a compared vault did not extract: `tabVisibilities` IS extracted at every refresh and compared normally — but when EITHER vault's refresh predates the P11 extraction (no `properties.tabVisibilities` on the profile), that category is excluded from the counts and disclosed via `notEvaluatedCategories` + a boundary, rather than reported as a fabricated 'no drift' (remedy: re-run `/sfi-refresh` on the stale vault). `boundaries[]` ALWAYS surfaces the profile-edition-rollup disclosure verbatim — when vault A and vault B come from different editions, user-permission set drift may reflect edition differences not configuration drift. cannot reliably detect the edition. Unknown alias surfaces as the verbatim refusal.",
    inputSchema: COMPARE_PROFILE_ACROSS_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_mapping_between_objects',
    description: "Map the fields of one object onto another for a conversion or migration — which field on object A corresponds to which field on object B, and which fields have no match and would lose data. Answers \"map {A} fields to {B} for conversion\", \"which {A} fields lose data converting to {B}\", \"what's the field mapping between these two objects\" (the classic Lead-to-Contact conversion mapping). honesty-anchor tool: given TWO CustomObject api-names, returns a heuristic field pairing for migration mapping (the Lead-vs-Contact conversion case). `vault` is OPTIONAL — omit it (the normal single-vault install) to map within the SERVED vault; supply a registered alias only in a multi-vault-registry deployment. With no registry, a self-referential alias (the served vault's directory name or path) still answers from the served vault with a single-vault disclosure; any other alias gets an honest alias-not-found refusal plus the omit-`vault` hint. Each `FieldPair` carries `fieldA` / `fieldB` shape (apiName, label, type), the Jaccard `labelSimilarity` over tokenized api-name + label tokens, the `typeCompatible` flag from the static type-compatibility table (text↔text, number↔number, date↔date, picklist↔picklist, reference↔reference), and `confidence: 'heuristic'`. Optional `similarityThreshold` (default 0.50) suppresses pairs below the floor; `includeTypeIncompatible: true` retains label-matched pairs whose types disagree (each flagged `typeMismatch: true`). `unpairedFromA` / `unpairedFromB` list fields without a suggested match. `boundaries[]` ALWAYS surfaces the verbatim phrase: 'field-mapping suggestions are heuristic — labels are matched by token overlap and types by compatibility table. Verify each suggested pair against your business rules before relying on the mapping for a migration script.' A release without this phrase is a contract violation regardless of test-suite green (PLAN- §10 constitutional axis).",
    inputSchema: FIELD_MAPPING_BETWEEN_OBJECTS_INPUT_SCHEMA,
  },
  // v3.2 — OmniStudio composition tier. The
  // `sfi.datatransform_field_map` tool composes the v3.2-R2c
  // OmniDataTransform extractor (journal 0167) into a readable
  // source-to-target field-mapping table; the per-row
  // `declared`/`parsed` confidence is the load-bearing honesty axis,
  // and the Native-vs-Vlocity disclosure surfaces verbatim in
  // `boundaries[]` on every response.
  {
    name: 'sfi.datatransform_field_map',
    description: "Given an OmniDataTransform canonical id (`OmniDataTransform:{Name}_{VersionNumber}`), returns the DataRaptor's source-to-target field mapping plus the operation-type metadata (Extract / Load / Transform). Composes the -R2c extractor's node (top-level `<sourceObject>`, `<inputType>`, `<interfaceClass>` with `<type>` fallback, `<active>` flag, `<description>`) with a fresh re-parse of the source XML for the per-row `<omniDataTransformItem>` table. Each `mappings[]` row carries `name`, `sourceField` (verbatim `<inputFieldName>`), `targetField` (verbatim `<outputFieldName>`), `outputObjectName`, `upsertKey`, `requiredForUpsert`, `disabled`, and a per-row `confidence` — `declared` when both field paths arrive as direct XML elements with no colon-prefix alias, `parsed` when either path uses the designer-controlled `{ObjectAlias}:{fieldPath}` convention (the -R2c extractor's edge-level confidence split). `sourceObject` and `targetObject` surface the top-level source SObject and the best-effort target SObject (first non-`json` `outputObjectName`); `operationType` pins the raw `<type>` element verbatim. `inputSampleJson` / `outputSampleJson` carry the designer's `<expectedInputJson>` / `<expectedOutputJson>` payloads when present. `boundaries[]` ALWAYS surfaces (1) the Native-vs-Vlocity disclosure and (2) the per-row confidence disclosure explaining the `declared`/`parsed` axis. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: DATATRANSFORM_FIELD_MAP_INPUT_SCHEMA,
  },
  // v3.2 — OmniStudio declarative-process tier. The
  // `sfi.decision_table_browse` tool is the Q179 row-data honesty
  // anchor of the v3.2 wave; row content is NEVER enumerated and
  // the verbatim refusal phrase surfaces in `boundaries[]` on every
  // response.
  {
    name: 'sfi.decision_table_browse',
    description: "Given a DecisionTable canonical id (`DecisionTable:{SetupName}`), returns the table's parameter shape — `dataSourceType` (`CsvUpload` | `SObject` | `Manual`), `executionType` (`HBASE` | `OnPrem`), `inputParams[]` (each `{ name, type, defaultValue }` ordered by `<sequence>`) and `outputParams[]` (each `{ name, type }`) — and ALWAYS sets `rows: null`. will NOT enumerate row content; row data lives in the CSV uploaded to Salesforce Files, in the `sourceObject` SObject records, or in the OmniStudio designer's row-editor UI. The honesty anchor: `boundaries[]` ALWAYS carries the verbatim phrase 'DecisionTable rows live in CSV uploads or SObject records, not in the metadata XML. cannot enumerate row content. To see the actual rows, query the row data source (SObject record query or the original CSV).' followed by a dataSourceType-specific row-store hint, then the Native-vs-Vlocity disclosure for discipline consistency. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: DECISION_TABLE_BROWSE_INPUT_SCHEMA,
  },
  // v3.2 R3b — the "walk this IP's action chain" Q177 surface.
  // Composes the v3.2-R2 OmniIntegrationProcedure node metadata with
  // a fresh re-parse of the source XML (for per-action shape and the
  // terminal Response Action's `additionalOutput`) and a per-step
  // endpoint classification (REST / DataRaptor / nested IP / Remote
  // Action). REST URLs and Apex `class.method` targets are surfaced
  // verbatim with `parsed` confidence — v3.2 does NOT probe URLs and
  // does NOT emit Apex-edge resolution (v3.3 follow-up). Four
  // verbatim boundary disclosures surface ALWAYS — Native-vs-Vlocity,
  // v3.3 Apex-coupling deferral, OmniProcessElement record-level,
  // and the REST-endpoint reachability caveat.
  {
    name: 'sfi.integration_procedure_chain',
    description: "Given an OmniIntegrationProcedure canonical id, returns the IP's identity metadata (`omniProcessKey`, `versionNumber`, `subType`, `type`, `uniqueName`, `isActive`), the ordered action chain (one row per `<omniProcessElements>` child, sorted by sequenceNumber ASC, each carrying `name`, `type`, `description`, `sequenceNumber`, `isActive`, and the optional `executionConditionalFormula`), the `externalEndpoints[]` per-step breakdown (kind `'rest' | 'dataraptor' | 'remote-action' | 'integration-procedure'`; REST steps surface the verbatim `restPath` and `namedCredential`, DataRaptor / nested-IP steps surface the resolved `targetId` when the target is in the vault and `null` for dangling references, Remote Action steps surface `class.method` verbatim — no Apex-edge resolution per deferral), and the parsed `responseShape` from the terminal Response Action's `additionalOutput`. Optional `includeChildPropertySetConfig: true` attaches each action's parsed `propertySetConfig` JSON blob (1-10kB per action). REST URLs are surfaced with `parsed` confidence — does NOT probe the URL or verify the Named Credential against live state. `boundaries[]` ALWAYS surfaces FOUR verbatim disclosures: (1) the Native-vs-Vlocity-Legacy axis ( anchor), (2) the Apex-coupling deferral, (3) the OmniProcessElement record-level boundary ( anchor), and (4) the REST-endpoint reachability caveat. Non-IP prefixes surface as `invalid-query`; unknown well-formed ids surface as `component-not-found`; missing source files surface as `component-not-found` with the verbatim source path.",
    inputSchema: INTEGRATION_PROCEDURE_CHAIN_INPUT_SCHEMA,
  },
  // v3.2 R3a — the "walk this OmniScript end-to-end" Q176 surface.
  // Composes the v3.2-R2 OmniScript node properties with a fresh re-
  // parse of the source XML (for per-step shape) and the outgoing
  // `dispatchesOmniAction` edge family (for the IP / DataRaptor / OS
  // dispatch targets). Three verbatim boundary disclosures surface
  // ALWAYS — Native-vs-Vlocity, OmniProcessElement record-level,
  // and the v3.3 Apex-coupling deferral.
  {
    name: 'sfi.omniscript_flow',
    description: "Given an OmniScript canonical id (`OmniScript:{ApiName}`), returns the parsed step sequence (the `<omniProcessElements>` children walked recursively, sorted by `level` ASC then `sequenceNumber` ASC), the downstream IP / DataRaptor / sibling-OmniScript dispatches resolved through `dispatchesOmniAction` outgoing edges (each entry carries `stepName`, `stepType`, `targetId` — null when dangling — `targetRawName`, and edge `confidence`), and the OmniScript's identity metadata (`omniProcessType`, `versionNumber`, `language`, `subType`, `type`, `uniqueName`, `isActive`, `isWebCompEnabled`) sourced from the R2 extractor's node properties. Optional `includeChildPropertySetConfig: true` attaches each step's parsed `propertySetConfig` JSON blob to its entry (off by default — blobs can be kilobytes per step). The / / honesty anchors surface ALWAYS in `boundaries[]`: (1) Native-vs-Vlocity-Legacy detection is heuristic; (2) OmniProcessElement record-level data is out of scope; (3) Apex-to-OmniProcess coupling (`implements omnistudio.VlocityOpenInterface`) is a follow-up — not yet in the graph. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: OMNISCRIPT_FLOW_INPUT_SCHEMA,
  },
  // v3.2 R3d — the "what's inside this FlexCard" surface. Composes
  // the v3.2 R2 OmniUiCard extractor's node properties (identity,
  // dataSourceType, dataSourceContextVariables) with a fresh
  // re-parse of the source XML's `<propertySetConfig>` JSON blob
  // (for the recursive widget tree) and the outgoing
  // `dispatchesOmniAction` edge family (for Action-widget OmniScript
  // / IP dispatches). Two verbatim boundary disclosures surface
  // ALWAYS — the propertySetConfig-parsing caveat (widget order
  // follows the JSON, not the visual designer's drag-drop order)
  // AND Native-vs-Vlocity-Legacy.
  {
    name: 'sfi.omniuicard_widget_breakdown',
    description: "Given an OmniUiCard canonical id (`OmniUiCard:{ApiName}`), returns the FlexCard's identity metadata (`omniUiCardType`, `authorName`, `versionNumber`, `isActive`, `isManagedUsingStdDesigner` — sourced from the R2 extractor's node properties), the parsed `states[]` array each carrying `name`, `stateIndex`, recursive `widgetCount`, and the full recursive `widgets[]` tree (each widget carries `name`, `element`, `elementLabel`, `type`, and nested `children[]` for Block / Datatable Row containers), the declared `dataSource` (`type` + `contextVariables[]`), and the `dispatchedActions[]` list resolved through outgoing `dispatchesOmniAction` edges (each entry: `stateName`, `stateIndex`, `widgetLabel`, `actionListIndex`, `actionType` ('OmniScript' | 'Integration Procedure'), `targetId`, `targetRawName`, edge `confidence`). The widget tree is re-parsed from the source XML on demand because the propertySetConfig blob is large (tens of KB per real-org card) and the R2 extractor stores only aggregate counts on the node. `boundaries[]` ALWAYS surfaces (1) the propertySetConfig-parsing disclosure verbatim explaining widget order follows the JSON's declared order, not the visual designer's drag-drop order, AND (2) the Native-vs-Vlocity-Legacy disclosure. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: OMNIUICARD_WIDGET_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_component_usages',
    description:
      "The universal \"where is this component used?\" answer for ANY canonical component type (`componentId`) — one entry point instead of fanning out across find_field_anywhere / find_code_usages / get_impact / grep. Also the answer to informal asks like 'who has this permission set / which profiles grant it', 'what references / calls into this component', 'is this still used anywhere' — it answers what points TO a named component (use search_components to find components MATCHING a description). Composes two evidence tiers: (1) GRAPH — incoming dependency edges to the target, grouped by referrer type, each carrying edge `confidence`, EXCLUDING access grants (`grantedBy`) and structural `parentOf` (access is not usage); (2) GREP supplement (`text-match` tier, `includeGrep` default true) — a literal search of Apex AND frontend bundle source (LWC/Aura/Visualforce — `$Label`/`$Resource`/`@salesforce` module references) for the api name, catching references the graph does not model (dynamic SOQL, reflective access, CustomMetadataType / CustomLabel / StaticResource refs). `graphReferrers[]` (type + count + sample), `grepSupplement` (matches with path/line/snippet), `summary` (counts + `hasStaticEvidence`), `boundaries[]`, `truncated`. ACCESS-GRANT section: grants stay OUT of `graphReferrers`, but a separate `grantedBy` section (`{count, granters[{id,type}]}`) surfaces the granting containers when the target is a `CustomPermission` (its only incoming edges ARE grants — this answers \"which Profiles / PermissionSets grant it?\"; always present for that type, count 0 = no container grants it) or when the target has zero usage edges but incoming `grantedBy` edges; absent otherwise. HONESTY: empty graph + empty grep = \"no static evidence in the vault\" (in `boundaries`), NEVER \"nothing uses this\" — dynamic constructs, un-modeled families (reports/dashboards/list-views), and managed packages are invisible; grants are NOT usage, so `grantedBy` never counts toward `hasStaticEvidence`. Phantom-aware (a referenced-but-not-retrieved target still answers from its edges, including a granted-but-undefined managed-package CustomPermission). Specialized tools (find_field_anywhere, layout_assignments, …) stay for a deeper single-family answer; this unifies the common case. Non-canonical id → `invalid-query`; an id with no node, no referrers AND no grants → `component-not-found`.",
    inputSchema: FIND_COMPONENT_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.installed_package_catalog',
    description:
      "Answer \"what packages are installed in this org?\" from the `InstalledPackage` metadata the refresh extracts (`installedPackages/<namespace>.installedPackage-meta.xml`). Each `packages[]` row is a managed/unlocked package: `namespace` (the prefix its components carry — `hed__Course__c` -> `hed`) and the installed `versionNumber` (e.g. `8.293`, or `null` when not declared). `summary.count` is the total; the list is COMPLETE (orgs have tens of packages, not thousands) and sorted by namespace. Optional `namespacePrefix` narrows the catalog to the package whose namespace EXACTLY equals it (case-insensitive — a namespace prefix is a single token like `hed`, not a substring) and echoes `appliedScope: { namespacePrefix, mode: 'namespacePrefix' }`; omit it for the full catalog, and a prefix that matches nothing returns an honest empty scope (with a scoped `boundaryNote`), never the full list. `declared` confidence. This is the package INVENTORY with real version + namespace data — not inferred from component prefixes — and grounds the managed-extension taxonomy; for what a namespace's components TOUCH use `package_impact`. `boundaryNote`: an empty list is disclosed as 'not modeled' (no InstalledPackage metadata / pre-extraction refresh), not a verified 'no packages'; component namespace prefixes still indicate ownership without this catalog. Emits a `coverageCaveat` when InstalledPackage was not retrieved; an empty catalog under it is 'not retrieved', not a verified 'no packages'.",
    inputSchema: INSTALLED_PACKAGE_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.annotations',
    description:
      'Read the curated annotations overlay (`meta/annotations.jsonl`): ownership, lifecycle status (e.g. deprecated), glossary synonyms, domain grouping, and notes that humans stated — or AI proposed and a human confirmed — about org components. Provenance `annotation` (curated, NOT derived from the org snapshot); unconfirmed `source: ai` entries are PROPOSALS, not facts. Optional `componentId` / `key` narrow the read. Annotations survive refreshes; orphans (annotated ids no longer in the graph) surface in the refresh pulse and `sfi annotate orphans`.',
    inputSchema: ANNOTATIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.propose_annotation',
    description:
      "Record an AI-PROPOSED annotation (owner / status / glossary / domain / note) for a component. Written ALWAYS as `source: 'ai', confirmed: false` — confirmation is a human act via `sfi.confirm_annotation` (or CLI `sfi annotate confirm <id> <key>`); discard with `sfi.reject_annotation`. Session rate-cap (20) prevents flooding. Local vault-file write only (meta/annotations.jsonl) — never touches Salesforce. Propose when the user TELLS you meaning worth keeping ('this field is deprecated', 'RevOps owns this') so the knowledge outlives the session as a reviewable proposal.",
    inputSchema: PROPOSE_ANNOTATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.review_annotations',
    description:
      "List UNCONFIRMED annotation proposals from `meta/annotations.jsonl` (AI proposals awaiting human sign-off). Optional `componentId` / `key` / `author` filters. Confirmed curated facts are excluded — use `sfi.annotations` for the full overlay. Pair with `sfi.confirm_annotation` / `sfi.reject_annotation` so a host can close the review loop over MCP without dropping to the CLI.",
    inputSchema: REVIEW_ANNOTATIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.confirm_annotation',
    description:
      "Confirm an AI-proposed annotation: re-writes the existing (componentId, key) value as `source: 'human', confirmed: true` — the same write as CLI `sfi annotate confirm <componentId> <key>`. Idempotent when already confirmed. Local vault-file write only — never touches Salesforce. Ask the user before confirming.",
    inputSchema: CONFIRM_ANNOTATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.reject_annotation',
    description:
      "Reject (discard) an UNCONFIRMED annotation proposal by writing `op: 'unset'` for the (componentId, key) pair — dedicated reject verb wrapping CLI `sfi annotate <id> --key <k> --unset`. Refuses already-confirmed entries (those are curated facts; remove them via the CLI unset path). Local vault-file write only — never touches Salesforce. Ask the user before rejecting.",
    inputSchema: REJECT_ANNOTATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.component_history',
    description:
      "The component's change timeline from the vault's OWN git history (`sfi vault git enable`): `git log --follow` over its source file — one entry per source-changing refresh — merged with the org-declared metadata lastModified stamps; optional capped unified diff of the most recent change (`includeLatestDiff`). A vault without history answers `available: false` with the enable hint, never an error. Local repo only; refresh-granularity, not the org audit trail.",
    inputSchema: COMPONENT_HISTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.component_change_attribution',
    description:
      "Who changed this component in Setup, and when — OFFLINE, from persisted SetupAuditTrail rows (`meta/setup-audit-trail.jsonl` written by `sfi refresh --with-audit-trail`). Given a `componentId` and/or `objectApiName`, heuristically correlates free-form Display/Section text against the component API name (confidence always `heuristic`, disclosed) and returns matched action / actor / timestamp rows. A vault that never ran `--with-audit-trail` answers `available: false` with the enable hint. Complements `sfi.component_history` (vault-git refresh-granularity, not org audit) and `sfi.live_setup_audit_trail` (live, 180-day org retention). Coverage starts only when the flag was first enabled; SetupAuditTrail does not log every category of org change.",
    inputSchema: COMPONENT_CHANGE_ATTRIBUTION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.component_as_of',
    description:
      "The component AS IT WAS at a git ref in the vault's own history: `git show <ref>:<sourcePath>` re-run through the SAME extractor the refresh uses for that type → declared properties-as-of (apiName/label/type + extractor properties). Types without a wired as-of extractor return capped raw historical content with `extracted: false`. A vault without history answers `available: false` + the enable hint; an unknown ref fails structured with a coverage note. Local repo only.",
    inputSchema: COMPONENT_AS_OF_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_error',
    description:
      "Decode a PASTED Salesforce error string back to the org component that produced it — the support desk's first-line tool. Input: `errorText` (the raw error / fault-email / stack trace; the aliases `error` / `message` / `errorMessage` / `text` are also accepted) + optional `object` SObject narrowing hint. Runs RANKED, HEURISTIC match strategies, each candidate carrying its own `confidence` + a `why`: (1) VALIDATION RULE — the message segment (after `FIELD_CUSTOM_VALIDATION_EXCEPTION`, or a bare pasted banner) is compared to every `ValidationRule.errorMessage`; an EXACT (trimmed) equality is `declared`, a normalized/substring match is `heuristic`; returns the rule id, object, `active` flag, and `errorConditionFormula`. (2) FLOW FAULT — recognizes fault-email shapes ('An error occurred at element X', 'Flow API Name: Y') and resolves the flow API name to a real `Flow:` node (`declared`); the element name is echoed and cross-checked against the flow's action calls, but flow ELEMENTS are not separate graph nodes offline (disclosed, not fabricated). (3) APEX — recognizes stack frames ('Class.MyClass.myMethod: line N', 'Trigger.MyTrigger: line N', 'System.XException') and resolves the class/trigger to a real node (`declared`); the offending LINE is not resolvable offline. (4) DUPLICATE RULES — 'duplicate' phrasing + an `object` hint lists the ACTIVE `DuplicateRule` nodes on that object (`heuristic` listing — the error text does not name which rule fired). (5) STATUS-CODE TAXONOMY — recognizes common REST/API statusCodes (`REQUIRED_FIELD_MISSING`, `UNABLE_TO_LOCK_ROW`, `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`, `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`, …) and explains the CATEGORY + which component TYPES can produce it — clearly category-level, NOT a specific match; for automation-abort codes it cross-references the triggers/flows declared on the hinted object (`triggersOn`). `disposition` mirrors `sfi.resolve`: `matched` (one confident source), `ambiguous` (several ranked candidates), or `none` — FAIL CLOSED, a source is never fabricated. On `none`, `triedStrategies` + `nextSteps` guide the next move (e.g. `sfi.what_happens_on_save` on the object). Matching is against DECLARED metadata, not a runtime trace — every candidate confidence + a verbatim `disclosure` say so; the candidate list is byte-budgeted (`truncated`).",
    inputSchema: EXPLAIN_ERROR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_debug_log',
    description:
      "Decode a PASTED Apex DEBUG LOG, flow fault text, or governor-limit exception back to the org component that ran — the developer/support runtime-triage wedge, ZERO org access. Where `sfi.explain_error` decodes a SAVE-time error banner (validation/duplicate rule) back to the rule that blocked the write, THIS tool decodes a DEVELOPER debug log and a RUNTIME governor-limit exception back to the Apex class/trigger/flow that executed. Input: `logText` (the pasted log / stack trace / `System.LimitException` line; the aliases `debugLog` / `log` / `text` / `content` are also accepted) + optional `object` SObject hint. Strategies, each candidate carrying its own `confidence` + a `why`: (1) APEX IDENTITY — every class/trigger named in the log (stack frames `Class.X.method: line N` / `Trigger.Y: line N`, debug-log `CODE_UNIT_STARTED`/`METHOD_ENTRY` event lines, `__sfdc_trigger/Y` markers) resolves to a real `ApexClass:`/`ApexTrigger:` node (`declared`); the offending LINE is not resolvable offline (disclosed); unresolved names (managed/not-retrieved) are reported, never fabricated. (2) GOVERNOR LIMIT — a runtime `System.LimitException` (`Too many SOQL queries: 101`, `Too many DML statements`, `Apex CPU time limit exceeded`, `Apex heap size too large`, or an exceeding `LIMIT_USAGE` block) is classified to a limit TYPE and cross-referenced against `sfi.governor_limit_risks`: for each resolved Apex class in the log the static loop-risk findings are surfaced, with the ones whose rule maps to the fired limit (`soql-in-loop` for a SOQL limit, `dml-in-loop` for a DML limit) ranked first — a HEURISTIC correlation, the static scan is where the limit MOST LIKELY came from, not a runtime proof. (3) FLOW FAULT — a `Flow API Name:` embedded in the log resolves to a real `Flow:` node (`declared`). (4) STATUS-CODE taxonomy — a recognized REST/API status code is explained at the CATEGORY level (reused from explain_error, never a specific match). `disposition` mirrors `sfi.resolve`: `matched` (one confident source), `ambiguous` (several ranked), or `none` — FAIL CLOSED, a source is never fabricated; on `none`, `triedStrategies` + `nextSteps` (e.g. `sfi.governor_limit_risks`, `sfi.call_graph`) guide the next move. Matching is offline string-matching against declared metadata + the static governor-risk scan, not a runtime trace — every candidate confidence + a verbatim `disclosure` say so; the candidate list is byte-budgeted (`truncated`).",
    inputSchema: EXPLAIN_DEBUG_LOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.history_tracking_gaps',
    description: "Compliance audit: 'which sensitive fields have no field-history tracking enabled?'. Composes the SAME classification engine `sfi.pii_inventory` uses (regulated-data recognizer over CustomField API name / data type / description) with the extractors' own declared `trackHistory` (CustomField) / `enableHistory` (CustomObject) booleans — no new extraction, no live org read. Enumerates every CustomField (optionally scoped to one `objectApiName`), classifies each `pii` / `sensitive` / `public`, and flags a GAP: a regulated field whose declared `trackHistory` is `false` or absent (Salesforce's own default for an omitted element). Every gap additionally names whether its PARENT OBJECT even has history enabled — an object with `enableHistory: false` means NO field on it can be tracked at all, so that case is a DISTINCT, higher-severity `gapKind: 'object-history-disabled'` (severity `critical`) finding rather than an indistinguishable `field-not-tracked` (severity `high`) one. Results are GROUPED by object (`groups[]`), each carrying a real `CustomObject:` node id, `objectModeled`, and `objectHistoryEnabled` (`true` / `false` / `null` when the object's own metadata was never retrieved — UNKNOWN, never assumed enabled or disabled). `summary` reports the full pre-page counts (`totalGapFields`, `objectsWithGaps`, `objectsWithHistoryDisabled`, `byClassification`, `byGapKind`) so pagination never destabilizes them. Honesty axis (`confidenceAxis` + `trust.limitations`): the regulated-data classification is HEURISTIC (same false-positive/false-negative shape as the sibling classifier tool — a field with no name/type/description signal reads `public` even if it stores sensitive data at runtime); `trackHistory` / `enableHistory` readout is DECLARED (read verbatim from metadata, not inferred). Salesforce does not support history tracking on every field type regardless of the declared flags (formula fields hold no stored value; some platform system/audit fields are never trackable) — this tool does not model those per-type trackability rules, so a formula (`isFormula`) or synthesized system (`isSystem`) field can still appear in `gaps`; filter on those flags if only fixable gaps are wanted. Fails soft on an object with zero fields or an unmodeled object (empty `groups`, no error — never fabricated). `limit` (default 200, max 500) + `offset`/`cursor` continuation page `groups`' flattened field set with a ~45 KB byte-budget trim, the same shape the sibling classifier tool uses.",
    inputSchema: HISTORY_TRACKING_GAPS_INPUT_SCHEMA,
  },
];

/**
 * Canonical tool roster with MCP protocol annotations, shared
 * `outputSchema` (MCP-01 b), + INFRA-12-DEEP `livePlane` tags stamped on
 * every entry. Any live-reaching tool (`livePlane !== 'never'`) → openWorld;
 * pure vault-local tools stay vault-local.
 * `livePlane` is derived via {@link livePlaneForTool} (primary for live
 * tools, opt-in for audited hybrid/enrichment tools, never otherwise).
 */
export const V01_TOOLS: readonly ToolDefinition[] = V01_TOOLS_BASE.map(
  (tool) =>
    Object.freeze({
      ...tool,
      livePlane: livePlaneForTool(tool.name),
      annotations: mcpProtocolAnnotationsFor(tool.name),
      outputSchema: MCP_TOOL_OUTPUT_SCHEMA,
    }),
);

/**
 * The set of `V01_TOOLS` names indexed for O(1) membership checks in
 * `dispatchTool`. Built once at module load.
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  V01_TOOLS.map((tool) => tool.name),
);

/** Name → roster entry for O(1) livePlane lookup at dispatch. */
const TOOL_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  V01_TOOLS.map((tool) => [tool.name, tool]),
);

export { KNOWN_TOOL_NAMES, TOOL_BY_NAME };

/**
 * Route a `tools/call` request to its per-tool handler. v0.1 implements
 * one handler at a time; the dispatcher matches by `toolName`, runs the
 * tool's Zod parse against `args`, calls the handler, and serializes the
 * `McpResponse` or `McpError` envelope through `jsonResult`. Any tool
 * still without an implementation falls through to the not-implemented
 * branch and unknown names hit `unknown-tool`.
 *
 * INFRA-12-DEEP: before the switch, the invoked tool's `livePlane` tag is
 * minted into a LiveCapability and bound onto Context so composed
 * sub-handlers inherit the *top-level* capability (they cannot independently
 * read ambient standing consent).
 *
 * @example
 *   const result = await dispatchTool(ctx, 'sfi.search_components', { query: 'Industry' });
 *   // => { content: [{ type: 'text', text: '{"data":{"matches":[...]}, ...}' }],
 *   //      structuredContent: { data: { matches: [...] }, ... } }
 */
