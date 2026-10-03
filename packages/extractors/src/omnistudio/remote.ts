import type { Edge } from '@sf-intelligence/contracts';

/**
 * OmniStudio → Apex coupling, shared by the OmniScript, Integration Procedure
 * and FlexCard extractors.
 *
 * Any OmniStudio element whose configuration names a `remoteClass` runs that
 * Apex class: a Remote Action, a Try Catch Block's failure handler, a
 * Calculation Action, a File upload element, a FlexCard `ApexRemote` data
 * source or action. The runtime enters the class through its routing method
 * (`invokeMethod` for `VlocityOpenInterface` / `VlocityOpenInterface2`, `call`
 * for `System.Callable`) and passes `remoteMethod` as the routed name — so the
 * edge names the routed method in `methods[]` and says how it is reached in
 * `entryVia`.
 *
 * Normalisation is limited to what the platform itself does: surrounding
 * whitespace is trimmed for the target id (the raw value stays on the edge as
 * `targetRawName`, so a whitespace defect remains visible), and a managed
 * class written `ns.ClassName` targets its `ns__ClassName` component id.
 *
 * One managed class is not Apex the org owns but the OmniStudio runtime
 * itself: `IntegrationProcedureService` in a managed namespace (`vlocity_cmt`,
 * `vlocity_ins`, `vlocity_ps`, `omnistudio`, or the export placeholder
 * `%vlocity_namespace%`) runs the Integration Procedure whose `Type_SubType`
 * key is the `remoteMethod` — the managed-package way to call an IP from a
 * Remote Action. Such a call is an IP dispatch ({@link runtimeServiceCall}),
 * never a `callsApex` edge to a package class.
 */

/** The Apex class an OmniStudio `remoteClass` value names. */
export interface ApexRemoteTarget {
  /** Component api name (`ClassName` or `ns__ClassName`). */
  readonly apiName: string;
  /** The value exactly as written. */
  readonly raw: string;
  /** Managed-package namespace when written `ns.ClassName`. */
  readonly namespace: string | null;
}

// A namespace prefix starts with a letter and may hold single underscores
// (`vlocity_cmt`, `vlocity_ins`); `%vlocity_namespace%` is the export placeholder.
const NAMESPACED = /^([A-Za-z](?:[A-Za-z0-9]|_(?!_))*|%vlocity_namespace%)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The export placeholder a managed DataPack writes in place of its namespace. */
const PLACEHOLDER = '%vlocity_namespace%';

/** Resolve a `remoteClass` value to its Apex class, or null when it names none. */
export const apexRemoteTarget = (value: unknown): ApexRemoteTarget | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ns = NAMESPACED.exec(trimmed);
  if (ns !== null) {
    return { apiName: `${ns[1] as string}__${ns[2] as string}`, raw: value, namespace: ns[1] as string };
  }
  if (!PLAIN.test(trimmed)) return null;
  return { apiName: trimmed, raw: value, namespace: null };
};

/** Namespaces whose `IntegrationProcedureService` is the OmniStudio runtime. */
const RUNTIME_NAMESPACES: ReadonlySet<string> = new Set(['vlocity_cmt', 'vlocity_ins', 'vlocity_ps', 'omnistudio', PLACEHOLDER]);

/** An OmniStudio runtime-service call: the IP a Remote Action runs through the package. */
export interface RuntimeServiceCall {
  readonly kind: 'integration-procedure';
  /** The Integration Procedure key (`Type_SubType`) — the `remoteMethod`, trimmed. */
  readonly key: string;
  /** The service class exactly as written. */
  readonly service: string;
}

const IP_KEY = /^[A-Za-z0-9_]+$/;

/**
 * The Integration Procedure a `remoteClass` / `remoteMethod` pair runs when the
 * class is the managed runtime's `IntegrationProcedureService`, else null. An
 * un-namespaced `IntegrationProcedureService` is left alone: it names an org
 * class, not the package's.
 */
export const runtimeServiceCall = (target: ApexRemoteTarget | null, remoteMethod: unknown): RuntimeServiceCall | null => {
  if (target === null || target.namespace === null) return null;
  if (!RUNTIME_NAMESPACES.has(target.namespace.toLowerCase())) return null;
  const cls = target.apiName.slice(target.apiName.indexOf('__') + 2);
  if (cls.toLowerCase() !== 'integrationprocedureservice') return null;
  const key = typeof remoteMethod === 'string' ? remoteMethod.trim() : '';
  return IP_KEY.test(key) ? { kind: 'integration-procedure', key, service: target.raw.trim() } : null;
};

/** One call site of an OmniStudio component into an Apex class. */
export interface ApexRemoteCall {
  readonly target: ApexRemoteTarget;
  /** `remoteMethod` exactly as written, or null. */
  readonly remoteMethod: string | null;
  /** Where the call sits: element / step name, or a FlexCard state + widget label. */
  readonly site: string;
  /** Element / step type, or the FlexCard source kind (`dataSource`, `DataAction`, …). */
  readonly siteType: string;
  /**
   * Object api names the call passes as LITERAL arguments (`objectApiName:
   * 'Acme_Order__c'` in `additionalInput` / `remoteOptions` / `inputMap`) — how a
   * generic adapter learns which object to write. Merge fields are not values
   * and are never included.
   */
  readonly objectArgs?: readonly string[];
}

const OBJECT_ARG_KEY = /^(s?objectapiname|objectname|objecttype|sobjecttype|sobjectname|sobject|object)$/i;
const LITERAL_OBJECT = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Literal object-name arguments in an element's configuration — the keys
 * `objectApiName` / `sObjectType` / `objectName` / … inside `additionalInput`,
 * `remoteOptions`, `inputMap`, `extraPayload` or at the top level, whose value is
 * a plain api name (not a `%merge%` / `{field}` reference).
 */
export const literalObjectArgs = (config: Readonly<Record<string, unknown>> | null): string[] => {
  if (config === null) return [];
  const found = new Set<string>();
  const scan = (obj: unknown): void => {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && OBJECT_ARG_KEY.test(k.trim()) && LITERAL_OBJECT.test(v.trim())) found.add(v.trim());
    }
  };
  scan(config);
  for (const key of ['additionalInput', 'remoteOptions', 'inputMap', 'extraPayload', 'options']) scan(config[key]);
  return [...found].sort();
};

/**
 * Aggregate call sites into ONE `callsApex` edge per target class (the same
 * shape the Apex scanner emits): `methods[]` holds every routed method,
 * `callSites[]` every site. Sorted by target id; deterministic.
 */
export const buildApexRemoteEdges = (
  fromId: string,
  calls: readonly ApexRemoteCall[],
  source: string,
): Edge[] => {
  const byTarget = new Map<string, ApexRemoteCall[]>();
  const byIp = new Map<string, { readonly call: ApexRemoteCall; readonly svc: RuntimeServiceCall }[]>();
  for (const c of calls) {
    const svc = runtimeServiceCall(c.target, c.remoteMethod);
    if (svc !== null) {
      byIp.set(svc.key, [...(byIp.get(svc.key) ?? []), { call: c, svc }]);
      continue;
    }
    // Any other class written with the export placeholder is a package class
    // whose real namespace the export does not say: no component id to name.
    if (c.target.namespace === PLACEHOLDER) continue;
    const key = c.target.apiName;
    byTarget.set(key, [...(byTarget.get(key) ?? []), c]);
  }
  const edges: Edge[] = [];
  // A runtime-service call runs an Integration Procedure: one dispatch edge per
  // IP key, which the import resolves onto the version that runs.
  for (const [key, sites] of [...byIp].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const first = sites[0] as { readonly call: ApexRemoteCall; readonly svc: RuntimeServiceCall };
    edges.push({
      fromId,
      toId: `OmniIntegrationProcedure:${key}`,
      edgeType: 'dispatchesOmniAction',
      confidence: 'parsed',
      source,
      properties: {
        stepName: first.call.site,
        stepType: first.call.siteType,
        integrationProcedureKey: key,
        via: 'runtime-service',
        runtimeService: first.svc.service,
        callSites: sites.map((s) => ({ site: s.call.site, siteType: s.call.siteType })).sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)),
      },
    });
  }
  for (const [apiName, sites] of [...byTarget].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const methods = [
      ...new Set(sites.map((s) => s.remoteMethod?.trim() ?? '').filter((m) => m.length > 0)),
    ].sort();
    const rawNames = [...new Set(sites.map((s) => s.target.raw).filter((r) => r !== apiName))].sort();
    const namespace = sites[0]?.target.namespace ?? null;
    edges.push({
      fromId,
      toId: `ApexClass:${apiName}`,
      edgeType: 'callsApex',
      confidence: 'parsed',
      source,
      properties: {
        methods,
        entryVia: 'omnistudio-remote',
        callSites: sites
          .map((s) => ({
            site: s.site,
            siteType: s.siteType,
            remoteMethod: s.remoteMethod,
            ...(s.objectArgs !== undefined && s.objectArgs.length > 0 ? { objectArgs: s.objectArgs } : {}),
          }))
          .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : (a.remoteMethod ?? '').localeCompare(b.remoteMethod ?? ''))),
        ...(rawNames.length > 0 ? { targetRawName: rawNames.length === 1 ? rawNames[0] : rawNames } : {}),
        ...(namespace !== null ? { namespace } : {}),
      },
    });
  }
  return edges;
};
