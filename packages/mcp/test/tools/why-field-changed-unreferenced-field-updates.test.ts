/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { whyFieldChangedHandler } from '../../src/tools/why-field-changed.js';

/**
 * A03 / C04: a workflow field update that sets the field but that no rule or
 * approval process names never fires. It was invisible (no edge), so a host
 * concluded workflow field updates were "not retrieved". Synthetic fixture.
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
  apiName: id.slice(id.lastIndexOf('.') + 1).replace(/^[A-Za-z]+:/, ''),
  label: null,
  parentId,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const FIELD = 'CustomField:Invoice__c.Status__c';

const fu = (name: string, field: string, extra = ''): string =>
  `<fieldUpdates><fullName>${name}</fullName><field>${field}</field><literalValue>Sent</literalValue><name>${name}</name><operation>Literal</operation>${extra}</fieldUpdates>`;

const WORKFLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
${fu('Orphan_Status', 'Status__c')}
${fu('Approval_Status', 'Status__c')}
${fu('Other_Field', 'Notes__c')}
</Workflow>`;

const CHILD_WORKFLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
${fu('Stamp_Parent', 'Status__c', '<targetObject>InvoiceId</targetObject>')}
</Workflow>`;

describe('why_field_changed — unreferenced workflow field updates', () => {
  it('FAIL-BEFORE/PASS-AFTER: a field update nothing fires is disclosed apart, never as a writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-wfc-ufu-'));
    mkdirSync(join(dir, 'source', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'source', 'workflows', 'Invoice__c.workflow-meta.xml'), WORKFLOW);
    writeFileSync(join(dir, 'source', 'workflows', 'InvoiceLine__c.workflow-meta.xml'), CHILD_WORKFLOW);
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error('open failed');
    const store = opened.value;
    try {
      const imp = await importExtractionResults(store, [
        {
          nodes: [
            node('CustomObject:Invoice__c', 'CustomObject'),
            node(FIELD, 'CustomField', 'CustomObject:Invoice__c'),
            node('ApprovalProcess:Invoice__c.Approve', 'ApprovalProcess', 'CustomObject:Invoice__c'),
          ],
          edges: [
            {
              fromId: 'ApprovalProcess:Invoice__c.Approve',
              toId: 'WorkflowFieldUpdate:Invoice__c.Approval_Status',
              edgeType: 'references',
              confidence: 'declared',
              source: 'approval-process-extractor',
              properties: { actionType: 'FieldUpdate' },
            },
          ],
        },
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
      const data = r.value.data;
      expect(data.writers).toEqual([]);
      expect(data.unreferencedFieldUpdates?.items.map((i) => [i.id, i.match])).toEqual([
        ['WorkflowFieldUpdate:Invoice__c.Orphan_Status', 'exact'],
        ['WorkflowFieldUpdate:InvoiceLine__c.Stamp_Parent', 'name-only'],
      ]);
      expect(data.unreferencedFieldUpdates?.items[0]?.value).toBe('Sent');
    } finally {
      await closeGraph(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
