/**
 * Shared trigger-bypass enrichment + top-level warnings for both SOE tools.
 */

import type { GraphStore } from '@sf-intelligence/graph';

import { bypassWarnings, enrichTriggerStepsWithHandlerEffects } from './soe-trigger-effects.js';

type SoeTriggerSteps = Parameters<typeof enrichTriggerStepsWithHandlerEffects>[1];

export const annotateSoeTriggerBypass = async (
  graph: GraphStore,
  steps: SoeTriggerSteps,
  objectApiName: string,
): Promise<{ readonly handlerEnriched: boolean; readonly triggerBypassWarnings: readonly string[] }> => {
  const handlerEnriched = await enrichTriggerStepsWithHandlerEffects(
    graph,
    steps as Parameters<typeof enrichTriggerStepsWithHandlerEffects>[1],
    objectApiName,
  );
  const triggerBypassWarnings = bypassWarnings(steps);
  return { handlerEnriched, triggerBypassWarnings };
};
