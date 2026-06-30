/**
 * Source-file fallback for Flow field writers the graph extractor missed —
 * especially SObject-variable `assignToReference` / `recordUpdates` paths
 * that never emit a `writesTo` edge (pre-bundle or non-$Record DML).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { listNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

export interface SupplementalFlowFieldWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly fieldApiName: string;
  readonly mechanism: 'inputAssignments' | 'assignToReference';
}

/** Parse `<variables>` blocks mapping var name → SObject objectType. */
const parseSObjectVariables = (xml: string): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const varBlock = /<variables>([\s\S]*?)<\/variables>/g;
  let m: RegExpExecArray | null;
  while ((m = varBlock.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const nameMatch = /<name>([^<]+)<\/name>/.exec(block);
    const typeMatch = /<dataType>([^<]+)<\/dataType>/.exec(block);
    const objMatch = /<objectType>([^<]+)<\/objectType>/.exec(block);
    if (
      nameMatch?.[1] !== undefined &&
      typeMatch?.[1] === 'SObject' &&
      objMatch?.[1] !== undefined
    ) {
      out.set(nameMatch[1], objMatch[1]);
    }
  }
  return out;
};

const scanFlowXml = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): ReadonlyArray<{ fieldApiName: string; mechanism: SupplementalFlowFieldWriter['mechanism'] }> => {
  const hits: Array<{ fieldApiName: string; mechanism: SupplementalFlowFieldWriter['mechanism'] }> =
    [];
  const sobjectVars = parseSObjectVariables(xml);

  // recordCreates/recordUpdates `<inputAssignments><field>`.
  const inputFieldPattern = new RegExp(
    `<field>(${fieldApiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})<\\/field>`,
    'g',
  );
  if (inputFieldPattern.test(xml)) {
    hits.push({ fieldApiName, mechanism: 'inputAssignments' });
  }

  // `<assignToReference>Var.Field</assignToReference>` on SObject vars for this object.
  const assignPattern = /<assignToReference>([^<]+)<\/assignToReference>/g;
  let am: RegExpExecArray | null;
  while ((am = assignPattern.exec(xml)) !== null) {
    const ref = am[1] ?? '';
    const dot = ref.indexOf('.');
    if (dot <= 0) continue;
    const varName = ref.slice(0, dot);
    const f = ref.slice(dot + 1);
    if (f !== fieldApiName) continue;
    const obj = sobjectVars.get(varName);
    if (obj === objectApiName) {
      hits.push({ fieldApiName: f, mechanism: 'assignToReference' });
    }
  }

  return hits;
};

/**
 * Scan deployed Flow source files for writes to `{objectApiName}.{fieldApiName}`
 * that the graph may not have stamped as `writesTo` edges.
 */
export const scanSupplementalFlowFieldWriters = async (
  ctx: Context,
  objectApiName: string,
  fieldApiName: string,
): Promise<readonly SupplementalFlowFieldWriter[]> => {
  const flows = await listNodesByType(ctx.graph, 'Flow', { limit: 500, offset: 0 });
  if (!flows.ok) return [];
  const out: SupplementalFlowFieldWriter[] = [];
  for (const node of flows.value) {
    if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) continue;
    try {
      const xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
      const hits = scanFlowXml(xml, objectApiName, fieldApiName);
      for (const hit of hits) {
        out.push({
          componentId: node.id,
          apiName: node.apiName,
          fieldApiName: hit.fieldApiName,
          mechanism: hit.mechanism,
        });
      }
    } catch {
      // unreadable source — skip
    }
  }
  out.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  return out;
};
