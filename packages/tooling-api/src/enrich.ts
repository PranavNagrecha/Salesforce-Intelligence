/**
 * The v1.7 freshness enricher.
 *
 * Given an opened `ToolingApiClient` and the in-memory set of vault
 * nodes whose freshness should be hydrated, the enricher issues one
 * SOQL query per ComponentType (the API allows batched name-IN lookups
 * up to 200 names per WHERE) and folds the result back into the input
 * shape: `{ componentId, lastModifiedDate, lastModifiedBy, apiVersion }`
 * per enriched node, plus a per-row error list.
 *
 * Per-type query shape per `docs/vendor/salesforce-metadata/ToolingApi.md`
 * §"Per-type queries":
 *   - ApexClass: SELECT Id, Name, LastModifiedDate, LastModifiedBy.Name,
 *     LastModifiedById, ApiVersion FROM ApexClass WHERE Name IN (...).
 *   - ApexTrigger: same shape.
 *   - Flow: SELECT Id, MasterLabel, DeveloperName, LastModifiedDate,
 *     LastModifiedBy.Name, LastModifiedById, ApiVersion
 *     FROM FlowDefinitionView WHERE DeveloperName IN (...).
 *   - Layout: SELECT Id, Name, LastModifiedDate, LastModifiedBy.Name,
 *     LastModifiedById FROM Layout WHERE Name IN (...).
 *   - CustomField: SELECT Id, DeveloperName, TableEnumOrId,
 *     EntityDefinition.QualifiedApiName, LastModifiedDate,
 *     LastModifiedBy.Name, LastModifiedById FROM CustomField
 *     WHERE DeveloperName IN (...) — correlated back to the vault id
 *     via `EntityDefinition.QualifiedApiName` (the parent object's
 *     ApiName), NOT `TableEnumOrId` (a key-prefix Id for custom objects).
 *   - ValidationRule: SELECT Id, ValidationName, EntityDefinitionId,
 *     EntityDefinition.QualifiedApiName, LastModifiedDate,
 *     LastModifiedBy.Name, LastModifiedById FROM ValidationRule
 *     WHERE ValidationName IN (...) — correlated back to the vault id
 *     via `EntityDefinition.QualifiedApiName` (the parent object's
 *     ApiName), NOT `EntityDefinitionId` (a key-prefix Id for custom
 *     objects), same as CustomField.
 *
 * Honesty axes:
 *   - The `--with-tooling-api` flag is opt-in; default `sfi refresh`
 *     produces an un-enriched vault. The `unenrichedCount` surfaced by
 *     `sfi.changed_since` is what tells consumers the result is partial.
 *   - Managed-package internals (those whose canonical id does not
 *     match a vault Node) are not surfaced; the enricher logs and
 *     drops them.
 *   - Per-type errors are isolated: an `INVALID_FIELD` failure on
 *     ApexClass does NOT abort the Flow query. Per-type errors are
 *     surfaced in the result's `errors` array.
 *
 * The default rate-limit pause between batched queries is 200ms — the
 * "be a good API citizen" floor documented in `ToolingApi.md`
 * §"Minimum interval throttle". Tests override via the option.
 */

import type {
  ComponentId,
  ComponentType,
  Node,
} from '@sf-intelligence/contracts';

import type { ToolingApiClient } from './client.js';

/** Per-call options for `enrichLastModified`. */
export interface EnrichmentOptions {
  readonly client: ToolingApiClient;
  /** ComponentTypes to enrich. Nodes of other types are passed through. */
  readonly types: readonly ComponentType[];
  /**
   * Minimum interval between batched SOQL queries in milliseconds.
   * Defaults to 200 — the floor documented in
   * `ToolingApi.md` §"Minimum interval throttle".
   */
  readonly rateLimitPauseMs?: number;
  /**
   * Injectable sleep for tests. Defaults to a `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One enriched-node payload. */
export interface NodeEnrichment {
  readonly componentId: ComponentId;
  readonly lastModifiedDate: string;
  readonly lastModifiedBy: { readonly id: string; readonly name: string };
  readonly apiVersion: number | null;
}

/** Per-node error rowfrom a failed enrichment query. */
export interface EnrichmentError {
  readonly componentId: ComponentId;
  readonly error: string;
}

/** Result shape returned by the enrichment runner. */
export interface EnrichmentResult {
  readonly enrichedCount: number;
  readonly enrichments: readonly NodeEnrichment[];
  readonly errors: readonly EnrichmentError[];
}

/** Max names per WHERE clause. Per-type batch ceiling. */
const BATCH_MAX_NAMES = 200;

/** Default rate-limit interval — Tooling API "be a good citizen" floor. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 200;

/**
 * Shape per row from each per-type SOQL query. Only the fields the
 * enricher reads are declared; the Tooling API returns additional
 * columns (`attributes`, etc.) that are ignored.
 */
interface ToolingRow {
  readonly Id: string;
  readonly Name?: string;
  readonly DeveloperName?: string;
  readonly MasterLabel?: string;
  readonly ValidationName?: string;
  readonly TableEnumOrId?: string;
  readonly EntityDefinitionId?: string;
  /**
   * CustomField's parent SObject API name via the EntityDefinition
   * relationship. For a CUSTOM object `TableEnumOrId` is a key-prefix
   * SObject Id (e.g. `01Ixx…`), NOT the ApiName; this relationship column
   * carries the real `My_Object__c` form the vault id is built from.
   */
  readonly EntityDefinition?: { readonly QualifiedApiName?: string };
  readonly LastModifiedDate?: string;
  readonly LastModifiedById?: string;
  readonly LastModifiedBy?: { readonly Name?: string };
  readonly ApiVersion?: number | string;
}

interface PerTypeDispatch {
  /** Per-row tooling object name (e.g., ApexClass, Layout). */
  readonly objectName: string;
  /** Comma-separated SOQL projection. */
  readonly columns: string;
  /** WHERE-key column. */
  readonly whereColumn: string;
  /**
   * Extract the WHERE-IN search key for the input vault node. Returns
   * `null` when the node carries no usable key (the enricher skips
   * those rows but reports them as `missing-key`).
   */
  readonly nodeToKey: (node: Node) => string | null;
  /**
   * Build the canonical ComponentId from a tooling row. Used to map
   * the response back to a vault node. Returns `null` when the row
   * doesn't carry enough columns (e.g., a managed-package row whose
   * DeveloperName lacks a parent reference); those rows are dropped.
   */
  readonly rowToComponentId: (row: ToolingRow) => ComponentId | null;
}

/**
 * Per-type dispatch table. Each entry encodes the SOQL projection, the
 * WHERE key, and the bidirectional mapping between a vault Node and a
 * Tooling row. The shape is uniform so the runner's main loop is one
 * function rather than per-type branches.
 */
const DISPATCH: Readonly<Partial<Record<ComponentType, PerTypeDispatch>>> = Object.freeze({
  ApexClass: {
    objectName: 'ApexClass',
    columns:
      'Id, Name, LastModifiedDate, LastModifiedById, LastModifiedBy.Name, ApiVersion',
    whereColumn: 'Name',
    nodeToKey: (node) => node.apiName.length > 0 ? node.apiName : null,
    rowToComponentId: (row) =>
      typeof row.Name === 'string' && row.Name.length > 0
        ? `ApexClass:${row.Name}`
        : null,
  },
  ApexTrigger: {
    objectName: 'ApexTrigger',
    columns:
      'Id, Name, LastModifiedDate, LastModifiedById, LastModifiedBy.Name, ApiVersion',
    whereColumn: 'Name',
    nodeToKey: (node) => node.apiName.length > 0 ? node.apiName : null,
    rowToComponentId: (row) =>
      typeof row.Name === 'string' && row.Name.length > 0
        ? `ApexTrigger:${row.Name}`
        : null,
  },
  Flow: {
    // FlowDefinitionView is the canonical user-facing flow handle per
    // ToolingApi.md; the `DeveloperName` column matches the vault's
    // canonical id `Flow:{DeveloperName}` directly.
    objectName: 'FlowDefinitionView',
    columns:
      'Id, DeveloperName, MasterLabel, LastModifiedDate, LastModifiedById, LastModifiedBy.Name, ApiVersion',
    whereColumn: 'DeveloperName',
    nodeToKey: (node) => node.apiName.length > 0 ? node.apiName : null,
    rowToComponentId: (row) =>
      typeof row.DeveloperName === 'string' && row.DeveloperName.length > 0
        ? `Flow:${row.DeveloperName}`
        : null,
  },
  Layout: {
    objectName: 'Layout',
    columns:
      'Id, Name, LastModifiedDate, LastModifiedById, LastModifiedBy.Name',
    whereColumn: 'Name',
    // The Layout's vault canonical id is `Layout:{Object}-{LayoutName}`
    // and the Tooling API's `Name` column carries the same dot-or-dash
    // separated form; passthrough.
    nodeToKey: (node) => node.apiName.length > 0 ? node.apiName : null,
    rowToComponentId: (row) =>
      typeof row.Name === 'string' && row.Name.length > 0
        ? `Layout:${row.Name}`
        : null,
  },
  CustomField: {
    objectName: 'CustomField',
    columns:
      'Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, LastModifiedDate, LastModifiedById, LastModifiedBy.Name',
    whereColumn: 'DeveloperName',
    // CustomField apiName at the vault level usually ends with `__c`
    // (e.g., Industry__c); the Tooling API strips this suffix in
    // DeveloperName. The enricher queries by the bare developer name,
    // then re-adds the `__c` suffix when constructing the canonical
    // id from the row.
    nodeToKey: (node) => {
      const bare = node.apiName.endsWith('__c')
        ? node.apiName.slice(0, -3)
        : node.apiName;
      return bare.length > 0 ? bare : null;
    },
    rowToComponentId: (row) => {
      if (typeof row.DeveloperName !== 'string' || row.DeveloperName.length === 0) {
        return null;
      }
      // The vault id is `CustomField:{ObjectApiName}.{Field}__c`. For a
      // CUSTOM object `TableEnumOrId` is a key-prefix SObject Id
      // (e.g. `01Ixx…`), NOT the ApiName, so building the id from it would
      // never match the vault node and the row would be dropped silently.
      // `EntityDefinition.QualifiedApiName` carries the real object ApiName
      // for both standard and custom objects, so build the id from it.
      const objectApiName = row.EntityDefinition?.QualifiedApiName;
      if (typeof objectApiName !== 'string' || objectApiName.length === 0) {
        return null;
      }
      const suffix = row.DeveloperName.endsWith('__c') ? '' : '__c';
      return `CustomField:${objectApiName}.${row.DeveloperName}${suffix}`;
    },
  },
  ValidationRule: {
    objectName: 'ValidationRule',
    columns:
      'Id, ValidationName, EntityDefinitionId, EntityDefinition.QualifiedApiName, LastModifiedDate, LastModifiedById, LastModifiedBy.Name',
    whereColumn: 'ValidationName',
    nodeToKey: (node) => {
      // Vault canonical id is `ValidationRule:{Parent}.{Name}`; the
      // `apiName` stores `{Parent}.{Name}` so split on the final dot
      // to isolate the rule name. When apiName has no dot we fall
      // back to the whole string (anomalous but harmless).
      const dot = node.apiName.lastIndexOf('.');
      const name = dot === -1 ? node.apiName : node.apiName.slice(dot + 1);
      return name.length > 0 ? name : null;
    },
    rowToComponentId: (row) => {
      if (typeof row.ValidationName !== 'string' || row.ValidationName.length === 0) {
        return null;
      }
      // `EntityDefinitionId` for a CUSTOM object is a key-prefix SObject Id
      // (e.g. `01Ixx…`), NOT the ApiName, so building the id from it would
      // never match the vault node `ValidationRule:{ObjectApiName}.{Name}`
      // and the row would be dropped silently (same class as CustomField's
      // `TableEnumOrId`). `EntityDefinition.QualifiedApiName` carries the
      // real object ApiName for both standard and custom objects.
      const objectApiName = row.EntityDefinition?.QualifiedApiName;
      if (typeof objectApiName !== 'string' || objectApiName.length === 0) {
        return null;
      }
      return `ValidationRule:${objectApiName}.${row.ValidationName}`;
    },
  },
});

/** SOQL-quote a value safely. The Tooling API expects single-quoted strings.
 * Escape backslash before the quote — order matters, else a trailing `\` lets the
 * escaped quote terminate the literal (SOQL injection). */
const soqlQuote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Default sleep used between batched queries. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the freshness enrichment pass.
 *
 * @example
 *   const result = await enrichLastModified(
 *     { client, types: ['ApexClass', 'Flow'] },
 *     vaultNodes,
 *   );
 *   console.log(`Enriched ${result.enrichedCount} components.`);
 */
export const enrichLastModified = async (
  opts: EnrichmentOptions,
  nodes: readonly Node[],
): Promise<EnrichmentResult> => {
  const pauseMs = opts.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const enrichments: NodeEnrichment[] = [];
  const errors: EnrichmentError[] = [];

  // Group input nodes by ComponentType. Only the types the caller
  // requested are touched; others are passed through unchanged
  // (they do not contribute to enrichedCount).
  const nodesByType = new Map<ComponentType, Node[]>();
  for (const node of nodes) {
    if (!opts.types.includes(node.type)) continue;
    const bucket = nodesByType.get(node.type);
    if (bucket === undefined) {
      nodesByType.set(node.type, [node]);
    } else {
      bucket.push(node);
    }
  }

  let queriesIssued = 0;
  for (const type of opts.types) {
    const dispatch = DISPATCH[type];
    if (dispatch === undefined) {
      // Type not yet in the enricher's dispatch table. Surface every
      // node of this type as a per-row error so the caller knows the
      // gap.
      const typeNodes = nodesByType.get(type) ?? [];
      for (const node of typeNodes) {
        errors.push({
          componentId: node.id,
          error: `type '${type}' is not in the v1.7 R2 dispatch table`,
        });
      }
      continue;
    }
    const typeNodes = nodesByType.get(type) ?? [];
    if (typeNodes.length === 0) continue;

    // Index by canonical id for the response correlation step.
    const byId = new Map<ComponentId, Node>();
    const keysToQuery: string[] = [];
    const keyToNode = new Map<string, Node>();
    for (const node of typeNodes) {
      const key = dispatch.nodeToKey(node);
      if (key === null) {
        errors.push({
          componentId: node.id,
          error: 'missing apiName/key for tooling-api lookup',
        });
        continue;
      }
      byId.set(node.id, node);
      if (!keyToNode.has(key)) keyToNode.set(key, node);
      keysToQuery.push(key);
    }

    // Batch the WHERE-IN clause to BATCH_MAX_NAMES per query.
    const seen = new Set<ComponentId>();
    for (let i = 0; i < keysToQuery.length; i += BATCH_MAX_NAMES) {
      if (queriesIssued > 0 && pauseMs > 0) {
        await sleep(pauseMs);
      }
      const batch = keysToQuery.slice(i, i + BATCH_MAX_NAMES);
      const inList = batch.map(soqlQuote).join(', ');
      const soql =
        `SELECT ${dispatch.columns} FROM ${dispatch.objectName} ` +
        `WHERE ${dispatch.whereColumn} IN (${inList})`;
      queriesIssued += 1;
      const queryResult = await opts.client.query<ToolingRow>(soql);
      if (!queryResult.ok) {
        // A per-type failure attaches the error to every node in the
        // batch; downstream consumers see the granular axis.
        for (const node of typeNodes.slice(i, i + BATCH_MAX_NAMES)) {
          if (seen.has(node.id)) continue;
          errors.push({
            componentId: node.id,
            error: `${queryResult.error.kind}: ${queryResult.error.message}`,
          });
        }
        continue;
      }

      for (const row of queryResult.value) {
        const canonical = dispatch.rowToComponentId(row);
        if (canonical === null) continue;
        const node = byId.get(canonical);
        if (node === undefined) {
          // The Tooling API returned a component the vault doesn't
          // have (managed-package internal, race with a recent
          // deploy, etc.). Silently skip; the consumer's `unenrichedCount`
          // captures the visible gap.
          continue;
        }
        if (seen.has(node.id)) continue;
        seen.add(node.id);

        const lastModifiedDate =
          typeof row.LastModifiedDate === 'string' && row.LastModifiedDate.length > 0
            ? row.LastModifiedDate
            : null;
        const lastModifiedById =
          typeof row.LastModifiedById === 'string' && row.LastModifiedById.length > 0
            ? row.LastModifiedById
            : null;
        const lastModifiedByName =
          row.LastModifiedBy !== undefined &&
          typeof row.LastModifiedBy.Name === 'string' &&
          row.LastModifiedBy.Name.length > 0
            ? row.LastModifiedBy.Name
            : null;
        if (lastModifiedDate === null) {
          // Defensive: row carried no date despite a successful query.
          errors.push({
            componentId: node.id,
            error: 'Tooling row missing LastModifiedDate',
          });
          continue;
        }

        const apiVersion = parseApiVersion(row.ApiVersion);

        enrichments.push({
          componentId: node.id,
          lastModifiedDate,
          lastModifiedBy: {
            id: lastModifiedById ?? '',
            name: lastModifiedByName ?? '',
          },
          apiVersion,
        });
      }
    }
  }

  return {
    enrichedCount: enrichments.length,
    enrichments,
    errors,
  };
};

/**
 * Parse the Tooling API's `ApiVersion` column to a number. The column
 * can come back as either a string (`'60.0'`) or a number (`60.0`)
 * depending on the org's API version; both shapes are tolerated.
 */
const parseApiVersion = (raw: number | string | undefined): number | null => {
  if (raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};
