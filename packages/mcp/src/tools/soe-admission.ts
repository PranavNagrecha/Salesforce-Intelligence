/**
 * Shared admission gate for SOE composition tools (`what_happens_on_save`,
 * `order_of_execution`). Allows answers when automation targets the object
 * even if the object's own `CustomObject` node was not retrieved (standard
 * objects).
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

export interface SoeAdmissionResult {
  readonly admitted: boolean;
  readonly objectModeled: boolean;
  /**
   * Meaningful only when NOT admitted: the object id is the target of inbound
   * edges (e.g. permission-set object grants) but has no definition and no
   * automation in the vault. That is a PHANTOM — an object the org references
   * but whose metadata was never retrieved (typically a managed-package or
   * filtered object), as opposed to a flat-out unknown id. Lets the caller
   * explain *why* it can't answer instead of a bare "not found".
   */
  readonly referencedButNotModeled?: boolean;
}

export const OBJECT_NOT_MODELED_BOUNDARY =
  "The object's own metadata definition is not in this vault (common for standard objects like Account/Contact whose object-meta.xml was not retrieved). The automation steps below are real vault nodes that target this object via triggersOn/parentOf edges; field and layout context for the object itself may be incomplete.";

/**
 * Decide whether SOE tools may compose for `objectId`. Admits when the
 * object node exists OR incoming automation / outgoing parented rules exist.
 */
export const evaluateSoeAdmission = async (
  ctx: Context,
  objectId: ComponentId,
): Promise<Result<SoeAdmissionResult, string>> => {
  const nodeResult = await getNodeById(ctx.graph, objectId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const objectModeled = nodeResult.value !== null;
  if (objectModeled) {
    return ok({ admitted: true, objectModeled: true });
  }

  const triggersOn = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!triggersOn.ok) {
    return err(triggersOn.error.message);
  }
  if (triggersOn.value.length > 0) {
    return ok({ admitted: true, objectModeled: false });
  }

  const parentOf = await listEdges(ctx.graph, objectId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!parentOf.ok) {
    return err(parentOf.error.message);
  }
  if (parentOf.value.length > 0) {
    return ok({ admitted: true, objectModeled: false });
  }

  // Not a save target. Distinguish a genuinely unknown id from a PHANTOM: an
  // object the org references (permission-set grants, declared refs) but whose
  // definition was never retrieved. The importer flags those inbound edges
  // `targetMissing`; here it's enough that the id is some edge's target.
  const inbound = await listEdges(ctx.graph, objectId, { direction: 'in' });
  if (!inbound.ok) {
    return err(inbound.error.message);
  }
  return ok({
    admitted: false,
    objectModeled: false,
    referencedButNotModeled: inbound.value.length > 0,
  });
};

export const composeSoeDisclosure = (
  baseDisclosure: string,
  objectModeled: boolean,
): string =>
  objectModeled ? baseDisclosure : `${baseDisclosure} ${OBJECT_NOT_MODELED_BOUNDARY}`;

/**
 * The `component-not-found` message for an object SOE can't compose for.
 * When the object is a phantom (referenced by grants but never retrieved) the
 * message says so and points at the fix, instead of implying the id is bogus.
 */
export const soeNotAdmittedMessage = (
  objectId: ComponentId,
  referencedButNotModeled: boolean,
): string =>
  referencedButNotModeled
    ? `\`${objectId}\` is referenced by this org (e.g. permission-set grants) but its definition was never retrieved into this vault — typically a managed-package or filtered object. Save-order can't be composed without the object's own metadata and automation. Run \`sfi refresh\` if it is retrievable, otherwise treat it as external.`
    : `no automation or object definition for \`${objectId}\` in this vault`;
