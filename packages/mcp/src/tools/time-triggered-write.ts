/**
 * A workflow field update fired from a TIME TRIGGER is extracted as the same
 * `writesTo` / `references` edges as an immediate one, stamped
 * `timeTriggered: true`. It runs hours or days after the save, in its own
 * transaction — so it is a writer of the field, but never a same-save write.
 * The one predicate every save-order / collision consumer uses to tell them
 * apart.
 */
export const isTimeTriggeredEdge = (edge: {
  readonly properties: Readonly<Record<string, unknown>>;
}): boolean => edge.properties['timeTriggered'] === true;
