/**
 * SOE-FRAMEWORK-HANDLERS — the handler classes a managed trigger framework runs.
 *
 * A managed trigger framework (EDA's TDTM, a package's `ns.TriggerHandler`)
 * ships ONE trigger per object inside the package and dispatches org-written
 * subclasses of its base class from a REGISTRATION RECORD. The record is data
 * the vault never holds, and the package trigger's body is invisible, so no
 * `triggersOn` / `callsApex` edge reaches those classes: a save-order answer
 * built from edges alone omitted them and a host said "nothing custom runs
 * before the save".
 *
 * This module lists, for the saved object, every org Apex class that
 *   (a) extends a base class from another namespace (the same
 *       {@link isFrameworkSubclass} predicate `method_reachability` and
 *       `find_dead_code` use — one definition, not a second copy), and
 *   (b) touches the object: an edge to `CustomObject:<Object>` or one of its
 *       fields, or the object's API name in the class source (a
 *       constructor-style `new Obj__c(Id = …, F__c = v)` leaves no edge).
 * Each is a CONDITIONAL step — it runs only if registered — placed in the
 * trigger phase its source names for this event (`Before<Event>` /
 * `After<Event>`, as an enum member or a method name); when the source names
 * neither, `phase: 'unknown'` and the step sits under `pre-save-triggers`,
 * the earliest point it could run. Test classes are never handlers.
 *
 * ONE shared module so `what_happens_on_save` and `order_of_execution` cannot
 * drift. Cost: one node scan, one batched edge query, one source read per
 * non-test framework subclass.
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { type GraphStore, listEdgesForNodes } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import { isFrameworkSubclass } from './apex-reachability.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

export type SoeDmlEvent = 'insert' | 'update' | 'delete' | 'undelete';

/** Why a framework-handler step is conditional, and what is known about when it runs. */
export interface SoeFrameworkRegistration {
  readonly reason: 'framework-registered-handler';
  /** The dotted superclass (`<ns>.<Base>`). The base is a package class, not a vault node. */
  readonly baseClass: string;
  /**
   * `before` / `after` when the class source names that trigger context for
   * this event; `unknown` when it names neither (the step is then listed under
   * `pre-save-triggers`, the earliest point it could run).
   */
  readonly phase: 'before' | 'after' | 'unknown';
}

/** A step body the SOE tools spread into their own `SoeStep` (phase + stepIndex added there). */
export interface SoeFrameworkHandlerStep {
  readonly componentId: ComponentId;
  readonly componentType: 'ApexClass';
  readonly apiName: string;
  readonly actions: readonly { readonly kind: string; readonly targetId: ComponentId; readonly description: string }[];
  readonly conditionalOn: SoeFrameworkRegistration;
}

/** One sentence, emitted once per response that lists at least one handler step. */
export const SOE_FRAMEWORK_HANDLERS_NOTE =
  'Steps with `conditionalOn.reason: framework-registered-handler` are org Apex classes that extend a trigger-framework base class from another namespace (`conditionalOn.baseClass`) and touch this object; the package\'s own trigger runs them only if a registration record names them, and that record is data this vault does not hold, so they run only if registered. `conditionalOn.phase` is before/after when the class source names that context for this event, else unknown (listed under pre-save-triggers as the earliest point it could run).';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readSource = async (vaultRoot: string, node: Node): Promise<string> => {
  if (node.sourcePath === null || node.sourcePath.length === 0) return '';
  try {
    return await readFile(resolveVaultSourcePath(vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return '';
  }
};

/**
 * The handler steps for `objectApiName`, split by the trigger phase they
 * belong in. A class whose source names both contexts for the event appears
 * in both lists. A failed graph query is an error — nothing is claimed that
 * was not read.
 */
export const buildFrameworkHandlerSteps = async (
  ctx: { readonly graph: GraphStore; readonly vaultRoot: string },
  objectApiName: string,
  events: readonly SoeDmlEvent[],
): Promise<Result<{ readonly before: SoeFrameworkHandlerStep[]; readonly after: SoeFrameworkHandlerStep[] }, string>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ApexClass']);
  if (!scan.ok) return err(scan.error.message);
  const candidates = scan.value.nodes.filter(
    (n) => isFrameworkSubclass(n) && n.properties['isTest'] !== true,
  );
  const before: SoeFrameworkHandlerStep[] = [];
  const after: SoeFrameworkHandlerStep[] = [];
  if (candidates.length === 0) return ok({ before, after });

  const edges = await listEdgesForNodes(
    ctx.graph,
    candidates.map((c) => c.id),
    { direction: 'out' },
  );
  if (!edges.ok) return err(edges.error.message);

  const objectId = `CustomObject:${objectApiName}`;
  const fieldPrefix = `CustomField:${objectApiName}.`;
  // Apex is case-insensitive; the name must stand alone (not `Obj__c_Other__c`).
  const nameInSource = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(objectApiName)}(?![A-Za-z0-9_])`, 'i');
  const contextInSource = (context: 'before' | 'after', source: string): boolean =>
    events.some((e) => new RegExp(`\\b${context}${e}\\b`, 'i').test(source));

  for (const cls of candidates) {
    const out = edges.value.get(cls.id) ?? [];
    const touchesByEdge = out.some((e) => e.toId === objectId || e.toId.startsWith(fieldPrefix));
    const source = await readSource(ctx.vaultRoot, cls);
    if (!touchesByEdge && !nameInSource.test(source)) continue;

    const step = (phase: SoeFrameworkRegistration['phase']): SoeFrameworkHandlerStep => ({
      componentId: cls.id,
      componentType: 'ApexClass',
      apiName: cls.apiName,
      actions: out
        .filter((e) => e.edgeType === 'writesTo')
        .map((e) => ({ kind: 'writesTo', targetId: e.toId, description: `writesTo ${e.toId}` })),
      conditionalOn: {
        reason: 'framework-registered-handler',
        baseClass: cls.properties['superclass'] as string,
        phase,
      },
    });
    const runsBefore = contextInSource('before', source);
    const runsAfter = contextInSource('after', source);
    if (runsBefore) before.push(step('before'));
    if (runsAfter) after.push(step('after'));
    if (!runsBefore && !runsAfter) before.push(step('unknown'));
  }
  return ok({ before, after });
};
