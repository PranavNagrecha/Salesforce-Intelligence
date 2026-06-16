/**
 * Phantom-component disclosure.
 *
 * Some components are referenced by a retrieved org (permission-set grants,
 * Apex/LWC/test references, dependency edges) but their OWN definition was
 * never pulled into the vault — a managed-package component, or one outside the
 * retrieve scope. The graph still holds the inbound edges, so a tool asked
 * about such an id finds "0 of its own metadata" and would otherwise report a
 * bare "not found", which reads as "this doesn't exist" rather than the truth:
 * "this exists in the org but wasn't retrieved here."
 *
 * This mirrors the SOE `referencedButNotModeled` disclosure (soe-admission.ts)
 * and generalizes it so any `component-not-found` path can be honest about a
 * phantom. Keep the two messages consistent in spirit.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { STANDARD_OBJECT_FIELD_SNAPSHOT } from '@sf-intelligence/extractors';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

const STANDARD_OBJECT_API_NAMES = new Set<string>(STANDARD_OBJECT_FIELD_SNAPSHOT);

const standardObjectApiName = (id: string): string | null => {
  if (!id.startsWith('CustomObject:')) return null;
  const api = id.slice('CustomObject:'.length);
  return STANDARD_OBJECT_API_NAMES.has(api) ? api : null;
};

/** Standard field ids like `CustomField:Account.Industry` (not custom `__c` fields). */
const isKnownStandardFieldId = (id: string): boolean => {
  if (!id.startsWith('CustomField:')) return false;
  const rest = id.slice('CustomField:'.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return false;
  const objectApi = rest.slice(0, dot);
  const fieldApi = rest.slice(dot + 1);
  if (!STANDARD_OBJECT_API_NAMES.has(objectApi)) return false;
  return !fieldApi.endsWith('__c') && !fieldApi.endsWith('__mdt');
};

/**
 * Build a `component-not-found` message for `id` that distinguishes a
 * genuinely-unknown id from a PHANTOM (referenced-but-not-retrieved).
 *
 * @param ctx       MCP context (for the graph)
 * @param id        the missing component's canonical id
 * @param kindLabel human type word for the bare message ("ApexClass", "Flow")
 *
 * @example
 *   message: await phantomAwareNotFoundMessage(ctx, classId, 'ApexClass')
 */

export const phantomAwareNotFoundMessage = async (
  ctx: Context,
  id: ComponentId,
  kindLabel: string,
): Promise<string> => {
  const inbound = await listEdges(ctx.graph, id, { direction: 'in' });
  const refs = inbound.ok ? inbound.value.length : 0;
  if (refs === 0) {
    if (standardObjectApiName(id) !== null) {
      return (
        `\`${id}\` is a standard object whose own definition may not be retrieved into a custom-metadata vault — ` +
        `this is NOT proof the object is absent from the org. Field tools may still be incomplete until describe-backed refresh.`
      );
    }
    if (isKnownStandardFieldId(id)) {
      return (
        `\`${id}\` is a standard-object field that may not be modeled in this vault — ` +
        `Metadata API retrieve does not emit uncustomized standard fields as separate metadata. ` +
        `This is NOT proof the field is absent from the org.`
      );
    }
    return `no ${kindLabel} with id ${id}`;
  }
  return (
    `\`${id}\` is referenced by ${refs} other component(s) in this org ` +
    `(e.g. code, tests, or permission grants) but its own ${kindLabel} ` +
    `definition was never retrieved into the vault — typically a managed-package ` +
    `component or one outside the retrieve scope. Run \`sfi refresh\` if it should ` +
    `be retrievable; otherwise treat it as external.`
  );
};
