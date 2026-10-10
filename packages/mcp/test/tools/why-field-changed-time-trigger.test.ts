/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node, VaultManifest } from '@sf-intelligence/contracts';
import { extractWorkflowRule } from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { whyFieldChangedHandler } from '../../src/tools/why-field-changed.js';

/**
 * A workflow field update fired only from a rule's time trigger is a live,
 * scheduled writer — not a definition "nothing fires". Synthetic fixture,
 * extracted by the real workflow extractor.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (id: string, type: Node['type'], parentId: string | null = null): Node => ({
  id,
  type,
  apiName: id.slice(id.indexOf(':') + 1),
  label: null,
  parentId,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const FIELD = 'CustomField:Invoice__c.Status__c';

const WORKFLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldUpdates>
        <fullName>Set_Expired</fullName>
        <field>Status__c</field>
        <literalValue>Expired</literalValue>
        <name>Set Expired</name>
        <operation>Literal</operation>
    </fieldUpdates>
    <rules>
        <fullName>Expire_Rule</fullName>
        <active>true</active>
        <formula>true</formula>
        <triggerType>onCreateOnly</triggerType>
        <workflowTimeTriggers>
            <actions>
                <name>Set_Expired</name>
                <type>FieldUpdate</type>
            </actions>
            <timeLength>30</timeLength>
            <workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit>
        </workflowTimeTriggers>
    </rules>
</Workflow>`;

describe('why_field_changed — time-triggered workflow field updates', () => {
  it('FAIL-BEFORE/PASS-AFTER: the rule is a runnable, time-triggered writer and the update is not "nothing fires"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-wfc-timed-'));
    mkdirSync(join(dir, 'source', 'workflows'), { recursive: true });
    const wfPath = join(dir, 'source', 'workflows', 'Invoice__c.workflow-meta.xml');
    writeFileSync(wfPath, WORKFLOW);
    const extracted = await extractWorkflowRule(wfPath);
    if (!extracted.ok) throw new Error(extracted.error.message);
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error('open failed');
    const store = opened.value;
    try {
      const imp = await importExtractionResults(store, [
        {
          nodes: [node('CustomObject:Invoice__c', 'CustomObject'), node(FIELD, 'CustomField', 'CustomObject:Invoice__c')],
          edges: [],
        },
        extracted.value,
      ]);
      if (!imp.ok) throw new Error('import failed');
      const ctx: Context = {
        vaultRoot: dir,
        manifest: MANIFEST,
        graph: store,
        liveCapability: mintLiveCapability('opt-in'),
      };
      const r = await whyFieldChangedHandler(ctx, { fieldId: FIELD });
      if (!r.ok) throw new Error(r.error.message);
      const w = r.value.data.writers.find((x) => x.id === 'WorkflowRule:Invoice__c.Expire_Rule');
      expect(w?.runnable).toBe(true);
      expect(w?.timeTriggered).toBe(true);
      expect(r.value.data.unreferencedFieldUpdates).toBeUndefined();
    } finally {
      await closeGraph(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
