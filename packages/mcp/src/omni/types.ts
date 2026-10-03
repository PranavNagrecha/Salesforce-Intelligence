/**
 * Shared shapes of the OmniStudio analysis engine — the element-level model
 * (spec F1) and the findings every OmniStudio audit tool emits.
 *
 * The model is built ON DEMAND from the vault's retrieved source (the same
 * re-parse-the-source pattern `omniscript_flow` and
 * `integration_procedure_chain` use) rather than materialised as graph
 * ComponentTypes: a real org carries ~20k elements across its versions, and
 * every per-type registry in the product would otherwise have to learn four
 * sub-component types. The ids and edge vocabulary below are stable and
 * citable all the same.
 */

/** Finding / edge confidence. `inferred` is the product's `heuristic` tier. */
export type OmniConfidence = 'declared' | 'parsed' | 'inferred';

/** A pointer an auditor can open: the component, its file, the element, the line. */
export interface OmniCitation {
  readonly componentId: string;
  readonly sourcePath: string;
  /** `Step/Block/Element` inside an OmniScript / IP, or `item[3]` in a DataMapper. */
  readonly elementPath?: string;
  readonly line?: number;
}

/** F1 node kinds. */
export type OmniModelNodeKind = 'OmniElement' | 'OmniIpStep' | 'OmniDataKey' | 'DataMapperItem';

/** F1 edge kinds (spec §3.2). */
export type OmniModelEdgeKind =
  | 'containsElement'
  | 'producesKey'
  | 'readsKey'
  | 'sendsToIp'
  | 'stepOutputs'
  | 'dmReads'
  | 'dmWrites'
  | 'writesField'
  | 'deletesVia'
  | 'prefillsKey';

/** One F1 node. `properties` carries the per-kind fields of spec §3.1. */
export interface OmniModelNode {
  readonly id: string;
  readonly kind: OmniModelNodeKind;
  readonly owner: string;
  readonly sourcePath: string;
  readonly line: number | null;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** One F1 edge. */
export interface OmniModelEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: OmniModelEdgeKind;
  readonly confidence: OmniConfidence;
  readonly sourcePath: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Three-valued verdict of a finding: a proven defect, or one that cannot be decided. */
export type OmniVerdict = 'defect' | 'unknown';

/** One audit finding (every OmniStudio audit tool emits this shape). */
export interface OmniFinding {
  /** Stable code, e.g. `NEVER_SAVED`, `DEAD_REFERENCE`, `SCREEN_ONLY_DELETE`. */
  readonly code: string;
  readonly verdict: OmniVerdict;
  /** The component the finding is about (`OmniScript:…`, `OmniIntegrationProcedure:…`). */
  readonly componentId: string;
  readonly sourcePath: string;
  /** Element path inside the component (`Step/Block/Element`), when element-level. */
  readonly elementPath: string | null;
  readonly line: number | null;
  readonly message: string;
  readonly confidence: OmniConfidence;
  /** Why the verdict is `unknown` (present only then). */
  readonly unknownReason?: string;
  /** Code-specific evidence. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly citations: readonly OmniCitation[];
}

/** Deterministic finding order: componentId, elementPath, code, message. */
export const compareFindings = (a: OmniFinding, b: OmniFinding): number => {
  const keys: (keyof OmniFinding)[] = ['componentId', 'elementPath', 'code', 'message'];
  for (const k of keys) {
    const x = String(a[k] ?? '');
    const y = String(b[k] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** Id helpers (spec §3.1). */
export const omniElementId = (uniqueName: string, idPath: string): string =>
  `OmniElement:${uniqueName}#${idPath}`;
export const omniIpStepId = (ipUniqueName: string, idPath: string): string =>
  `OmniIpStep:${ipUniqueName}#${idPath}`;
export const omniDataKeyId = (owner: string, rawPath: string): string =>
  `OmniDataKey:${owner}#${rawPath}`;
export const dataMapperItemId = (dmUniqueName: string, index: number): string =>
  `DataMapperItem:${dmUniqueName}#${index}`;
