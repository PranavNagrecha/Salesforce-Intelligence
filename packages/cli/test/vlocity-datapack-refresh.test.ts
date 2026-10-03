/// <reference types="vitest/globals" />

/**
 * Managed-package (Vlocity) OmniStudio through the refresh: a DataPack folder
 * under the vault source is ONE OmniStudio component (its sibling files ride
 * with it), DataPack types sf-intelligence does not model are disclosed as
 * skipped, the Metadata API reconcile never deletes an export, and an offline
 * refresh links a DataPack OmniScript to its DataPack Integration Procedure
 * the way it links native ones. Synthetic Acme names.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraph, getNodeById, listEdges, openGraph } from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';
import { walkAndExtract } from '../src/refresh-pipeline.js';
import { reconcileSourceDeletions } from '../src/source-reconcile.js';

const P = '%vlocity_namespace%__';

const el = (name: string, type: string, order: number, cfg: unknown, parent = ''): Record<string, unknown> => ({
  [`${P}Active__c`]: true,
  [`${P}Order__c`]: order,
  [`${P}ParentElementName__c`]: parent,
  [`${P}PropertySet__c`]: cfg,
  [`${P}Type__c`]: type,
  Name: name,
});

/** Write the managed-package export under `<source>/vlocity/`. */
const writeExport = async (source: string): Promise<void> => {
  const pack = async (kind: string, key: string, main: unknown, siblings: Record<string, unknown> = {}): Promise<void> => {
    const dir = join(source, 'vlocity', kind, key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}_DataPack.json`), JSON.stringify(main, null, 4), 'utf8');
    for (const [name, body] of Object.entries(siblings)) await writeFile(join(dir, name), JSON.stringify(body), 'utf8');
  };
  await pack(
    'OmniScript',
    'Acme_Intake_English',
    {
      [`${P}Element__c`]: [
        el('IntakeStep', 'Step', 1, { label: 'Intake' }),
        el('Acme_Note__c', 'Text', 1, { label: 'Note' }, 'IntakeStep'),
        el('SaveIntake', 'Integration Procedure Action', 2, { integrationProcedureKey: 'Acme_SaveIntake' }),
      ],
      [`${P}IsActive__c`]: true,
      [`${P}IsProcedure__c`]: false,
      [`${P}Language__c`]: 'English',
      [`${P}PropertySet__c`]: 'Acme_Intake_English_PropertySet.json',
      [`${P}SubType__c`]: 'Intake',
      [`${P}Type__c`]: 'Acme',
      [`${P}Version__c`]: 2,
      Name: 'Acme Intake',
      VlocityRecordSObjectType: `${P}OmniScript__c`,
    },
    { 'Acme_Intake_English_PropertySet.json': { allowSaveForLater: true } },
  );
  await pack('IntegrationProcedure', 'Acme_SaveIntake', {
    [`${P}Element__c`]: [el('SaveIt', 'DataRaptor Post Action', 1, { bundle: 'AcmeSaveIntake' })],
    [`${P}IsActive__c`]: true,
    [`${P}IsProcedure__c`]: true,
    [`${P}Language__c`]: 'Procedure',
    [`${P}SubType__c`]: 'SaveIntake',
    [`${P}Type__c`]: 'Acme',
    [`${P}Version__c`]: 1,
    Name: 'Acme/SaveIntake/Procedure',
    VlocityRecordSObjectType: `${P}OmniScript__c`,
  });
  // A DataPack type sf-intelligence does not model.
  await pack('Product2', 'Widget', { Name: 'Widget', VlocityRecordSObjectType: 'Product2' });
};

const dirs: string[] = [];
const temp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'sfi-datapack-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('Vlocity DataPacks in the refresh walk', () => {
  it('extracts each DataPack folder as one component and discloses unmodeled DataPack types', async () => {
    const source = await temp();
    await writeExport(source);
    const walked = await walkAndExtract(source, null);
    expect(walked.failures).toEqual([]);
    const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id)).sort();
    expect(ids).toEqual(['OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1', 'OmniScript:Acme_Intake_English_2']);
    const script = walked.results.flatMap((r) => r.nodes).find((n) => n.type === 'OmniScript');
    expect(script?.properties['allowSaveForLater']).toBe(true); // the sibling file rode with the folder
    expect(walked.skippedDirectories).toEqual({ vlocity: 1 }); // Product2 — not modeled, disclosed
  });

  it('never reconciles a DataPack away against the Metadata API retrieve', async () => {
    const root = await temp();
    const source = join(root, 'source');
    const authoritative = join(root, 'retrieve');
    await writeExport(source);
    await mkdir(join(authoritative, 'main', 'default', 'omniScripts'), { recursive: true });
    const result = await reconcileSourceDeletions(source, authoritative, new Set(['OmniScript', 'OmniIntegrationProcedure']));
    expect(result.deletedPaths).toEqual([]);
    await expect(access(join(source, 'vlocity', 'OmniScript', 'Acme_Intake_English', 'Acme_Intake_English_DataPack.json'))).resolves.toBeUndefined();
  });

  it('builds the graph offline and links the DataPack OmniScript to its DataPack Integration Procedure', async () => {
    const cwd = await temp();
    const vaultRoot = join(cwd, 'org-kb');
    const paths = vaultPaths(vaultRoot);
    await mkdir(paths.meta, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ targetOrg: 'test', vaultRoot, version: '0.1.0', createdAt: '2026-10-03T00:00:00.000Z' }), 'utf8');
    await writeExport(paths.source);
    const result = await runRefresh({ cwd, noPull: true });
    expect(result.status).not.toBe('failed');
    const opened = await openGraph(paths.graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const node = await getNodeById(opened.value, 'OmniScript:Acme_Intake_English_2');
      expect(node.ok && node.value?.sourcePath).toBe('source/vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_DataPack.json');
      expect(node.ok && node.value?.properties['sourceFormat']).toBe('vlocity-datapack');
      const out = await listEdges(opened.value, 'OmniScript:Acme_Intake_English_2', { direction: 'out' });
      if (!out.ok) throw new Error(out.error.message);
      const ip = out.value.find((e) => e.edgeType === 'dispatchesOmniAction');
      // Resolved at import by the IP's callable key, exactly like a native call.
      expect(ip?.toId).toBe('OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1');
      expect(ip?.properties['targetRawName']).toBe('Acme_SaveIntake');
    } finally {
      await closeGraph(opened.value);
    }
  }, 60_000);
});
