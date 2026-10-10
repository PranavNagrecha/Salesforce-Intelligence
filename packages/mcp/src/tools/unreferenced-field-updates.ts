/**
 * Workflow field updates that NAME a field but that nothing fires (A03 / C04).
 *
 * A `<fieldUpdates>` definition runs only when a workflow rule or an approval
 * process action names it. The workflow extractor hangs writer edges on rule
 * nodes, so a definition no rule uses mints nothing — and "what writes this
 * field" said nothing about it, which a host read as "workflow field updates
 * were not retrieved". This scan reads the retrieved workflow files and lists
 * such definitions as writers on paper only: never runnable, never counted as
 * writers.
 *
 * Kept in its own module: it is its own writer source, separate from the Flow
 * writer scan.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { listWorkflowFieldUpdates } from '@sf-intelligence/extractors';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

const SUFFIX = '.workflow-meta.xml';

/** One field-update definition that names the field but nothing fires. */
export interface UnreferencedFieldUpdate {
  /** `WorkflowFieldUpdate:{Object}.{name}` (scaffolding id, not a vault node). */
  readonly id: string;
  /** Object whose workflow file defines it. */
  readonly definedOn: string;
  readonly operation: string | null;
  readonly value: string | null;
  /** Cross-object only: the relationship it writes through (target not resolved offline). */
  readonly targetObject?: string;
  /** `exact` = same-object update of this field; `name-only` = cross-object, same field name. */
  readonly match: 'exact' | 'name-only';
  readonly sourcePath: string;
}

/**
 * Field updates defined in `source/workflows/*.workflow-meta.xml` that set
 * `{objectApiName}.{fieldApiName}` (or, cross-object, a field of that name)
 * and are named by no workflow rule and no other component in the graph.
 * Fail-soft: a vault with no workflows directory yields `[]`.
 */
export const findUnreferencedFieldUpdates = async (
  ctx: Context,
  objectApiName: string,
  fieldApiNameIn: string,
): Promise<readonly UnreferencedFieldUpdate[]> => {
  // Accept `Field__c` or `Object.Field__c`.
  const fieldApiName = fieldApiNameIn.slice(fieldApiNameIn.lastIndexOf('.') + 1);
  const dir = join(ctx.vaultRoot, 'source', 'workflows');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(SUFFIX)).sort();
  } catch {
    return [];
  }
  const out: UnreferencedFieldUpdate[] = [];
  for (const file of files) {
    const owner = file.slice(0, -SUFFIX.length);
    let xml: string;
    try {
      xml = await readFile(join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const def of listWorkflowFieldUpdates(xml)) {
      if (def.referencedByWorkflowRule || def.field === null) continue;
      const bare = def.field.includes('.') ? def.field.slice(def.field.lastIndexOf('.') + 1) : def.field;
      let match: UnreferencedFieldUpdate['match'] | null = null;
      if (def.targetObject === null) {
        const fq = def.field.includes('.') ? def.field : `${owner}.${def.field}`;
        if (fq === `${objectApiName}.${fieldApiName}`) match = 'exact';
      } else if (bare === fieldApiName) {
        match = 'name-only';
      }
      if (match === null) continue;
      const id = `WorkflowFieldUpdate:${owner}.${def.name}`;
      // An approval process (or anything else) that names it fires it; its
      // writer row, if resolvable, comes from that component.
      const refs = await listEdges(ctx.graph, id as ComponentId, { direction: 'in' });
      if (refs.ok && refs.value.length > 0) continue;
      out.push({
        id,
        definedOn: owner,
        operation: def.operation,
        value: def.value,
        ...(def.targetObject !== null ? { targetObject: def.targetObject } : {}),
        match,
        sourcePath: `source/workflows/${file}`,
      });
    }
  }
  // Exact matches first; then by id.
  return out.sort((a, b) =>
    a.match !== b.match ? (a.match === 'exact' ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
};

/** The note `why_field_changed` attaches when it lists such definitions. */
export const UNREFERENCED_FIELD_UPDATES_NOTE =
  'Workflow field updates defined in the retrieved workflow files that set this field but that no workflow rule, approval process or other component names. They never fire on their own, so they are not writers; deleting the field still requires removing them. `name-only` = a cross-object update whose target object is not resolved offline.';
