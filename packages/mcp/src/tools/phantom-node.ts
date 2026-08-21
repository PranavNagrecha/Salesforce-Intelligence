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
 *
 * ONE id shape is STRUCTURAL rather than a coverage gap: a Change Data Capture
 * entity (`CustomObject:AccountChangeEvent`). No refresh on any org can retrieve
 * it, so the generic "Run `sfi refresh` if it should be retrievable" remedy is a
 * fix-it the product cannot deliver; that branch says so explicitly and points
 * at the parent object instead.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { STANDARD_OBJECT_FIELD_SNAPSHOT } from '@sf-intelligence/extractors';
import {
  changeEventParentApiName,
  isChangeEventEntityId,
  listEdges,
} from '@sf-intelligence/graph';

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
  // CHANGEEVENT-IS-NOT-A-RETRIEVE-GAP: a `CustomObject:{X}ChangeEvent` target is
  // a Change Data Capture stream the platform synthesises; the Metadata API
  // emits no component for it on ANY org. The generic phantom message below ends
  // in "Run `sfi refresh` if it should be retrievable" — a fix-it that can never
  // work here, and one that reads the absence as a coverage gap. Answer with the
  // STRUCTURAL fact instead. Keyed on id SHAPE alone (not edges/coverage), so
  // this is the one branch that must precede the reference count.
  if (isChangeEventEntityId(id)) {
    const parent = changeEventParentApiName(id.slice('CustomObject:'.length));
    return (
      `\`${id}\` is a Change Data Capture (CDC) stream entity, NOT a retrievable ` +
      `${kindLabel} — the platform synthesises it from the parent object's CDC ` +
      `configuration and the Metadata API never emits it as a component, so no ` +
      `\`sfi refresh\` on any org can put it in this vault. This is STRUCTURAL, not a ` +
      `coverage gap` +
      (refs > 0
        ? `; ${refs} edge(s) in this org already point at it (e.g. an Apex CDC trigger ` +
          `or a channel member).`
        : '.') +
      (parent !== null
        ? ` Read \`CustomObject:${parent}\` for the object itself, or ` +
          `\`sfi.cdc_subscribers\` for what reacts to the stream.`
        : ' Use `sfi.cdc_subscribers` for what reacts to the stream.')
    );
  }
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
