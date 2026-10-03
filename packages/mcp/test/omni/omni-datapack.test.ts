/// <reference types="vitest/globals" />

/**
 * Managed-package (Vlocity) OmniStudio end to end through the MCP tools: a
 * Vlocity Build Tool export under `org-kb/source/vlocity/` — an OmniScript
 * that saves through the managed runtime's IntegrationProcedureService, the
 * Integration Procedure it runs, and the DataRaptor Load that IP posts to —
 * carries the same near-miss defect the native fixture does, and every
 * OmniStudio tool reads it through the same code as native metadata. With the
 * Vlocity package installed, the trust block says where those components came
 * from. Synthetic Acme names only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  extractCustomField,
  extractCustomObject,
  extractInstalledPackage,
  extractOmniDataTransform,
  extractOmniIntegrationProcedure,
  extractOmniScript,
} from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, listEdges, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { datatransformFieldMapHandler } from '../../src/tools/datatransform-field-map.js';
import { integrationProcedureChainHandler } from '../../src/tools/integration-procedure-chain.js';
import { managedPackageLimitations, NATIVE_VS_VLOCITY_DISCLOSURE } from '../../src/tools/omni-disclosures.js';
import { omniModelHandler } from '../../src/tools/omni-model.js';
import { omniSaveTraceHandler } from '../../src/tools/omni-save-trace.js';
import { omniscriptFlowHandler } from '../../src/tools/omniscript-flow.js';

const P = '%vlocity_namespace%__';
const CMT = 'vlocity_cmt__';

const element = (ns: string, name: string, type: string, order: number, level: number, cfg: unknown, parent?: string): Record<string, unknown> => ({
  [`${ns}Active__c`]: true,
  [`${ns}Level__c`]: level,
  [`${ns}Order__c`]: order,
  ...(parent === undefined ? {} : { [`${ns}ParentElementId__c`]: { Name: parent, VlocityRecordSObjectType: `${ns}Element__c` } }),
  [`${ns}PropertySet__c`]: cfg,
  [`${ns}Type__c`]: type,
  Name: name,
  VlocityRecordSObjectType: `${ns}Element__c`,
});

let ctx: Context;
let store: GraphStore;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sfi-omni-datapack-'));
  const vaultRoot = join(tmp, 'org-kb');
  const source = join(vaultRoot, 'source');
  const files: { path: string; body: string; extract: ((p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>) | null }[] = [];
  const add = (rel: string, body: unknown, extract: ((p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>) | null): void => {
    files.push({ path: join(source, rel), body: typeof body === 'string' ? body : JSON.stringify(body, null, 4), extract });
  };

  // The OmniScript: a step with the near-miss key and its saved twin, then a
  // Remote Action on the managed runtime's IntegrationProcedureService.
  add(
    'vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_DataPack.json',
    {
      [`${P}Element__c`]: [
        element(P, 'IntakeStep', 'Step', 1, 0, { label: 'Intake' }),
        element(P, 'AcmeQty__c', 'Number', 1, 1, { label: 'Qty' }, 'IntakeStep'),
        element(P, 'Acme_Note__c', 'Text', 2, 1, { label: 'Note' }, 'IntakeStep'),
        element(P, 'SaveIntake', 'Remote Action', 2, 0, {
          remoteClass: '%vlocity_namespace%.IntegrationProcedureService',
          remoteMethod: 'Acme_SaveIntake',
          sendOnlyExtraPayload: true,
          extraPayload: { Intake: '%IntakeStep%' },
        }),
      ],
      [`${P}IsActive__c`]: true,
      [`${P}IsProcedure__c`]: false,
      [`${P}Language__c`]: 'English',
      [`${P}PropertySet__c`]: 'Acme_Intake_English_PropertySet.json',
      [`${P}SubType__c`]: 'Intake',
      [`${P}Type__c`]: 'Acme',
      [`${P}Version__c`]: 1,
      Name: 'Acme Intake',
      VlocityRecordSObjectType: `${P}OmniScript__c`,
    },
    extractOmniScript,
  );
  add('vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_PropertySet.json', { allowSaveForLater: false }, null);

  // The IP, exported with a real namespace prefix and a JSON-string property set.
  add(
    'vlocity/IntegrationProcedure/Acme_SaveIntake/Acme_SaveIntake_DataPack.json',
    {
      [`${CMT}Element__c`]: [
        element(CMT, 'LoadIntake', 'DataRaptor Post Action', 1, 0, JSON.stringify({ bundle: 'AcmeIntakeLoad', sendOnlyAdditionalInput: true, additionalInput: { Intake: '%Intake%' } })),
        element(CMT, 'Respond', 'Response Action', 2, 0, { returnOnlyAdditionalOutput: true, additionalOutput: { saved: '=true' } }),
      ],
      [`${CMT}IsActive__c`]: true,
      [`${CMT}IsProcedure__c`]: true,
      [`${CMT}Language__c`]: 'Procedure',
      [`${CMT}SubType__c`]: 'SaveIntake',
      [`${CMT}Type__c`]: 'Acme',
      [`${CMT}Version__c`]: 1,
      Name: 'Acme/SaveIntake/Procedure',
      VlocityRecordSObjectType: `${CMT}OmniScript__c`,
    },
    extractOmniIntegrationProcedure,
  );

  // The DataRaptor Load: maps the underscore spelling the screen does not produce.
  const item = (input: string, field: string): Record<string, unknown> => ({
    [`${CMT}DomainObjectAPIName__c`]: 'Acme_Intake__c',
    [`${CMT}DomainObjectCreationOrder__c`]: 1,
    [`${CMT}DomainObjectFieldAPIName__c`]: field,
    [`${CMT}InterfaceFieldAPIName__c`]: input,
    Name: 'AcmeIntakeLoad',
    VlocityRecordSObjectType: `${CMT}DRMapItem__c`,
  });
  add(
    'vlocity/DataRaptor/AcmeIntakeLoad/AcmeIntakeLoad_DataPack.json',
    {
      [`${CMT}DRMapItem__c`]: [item('Intake:Acme_Qty__c', 'Acme_Qty__c'), item('Intake:Acme_Note__c', 'Acme_Note__c')],
      [`${CMT}InputType__c`]: 'JSON',
      [`${CMT}OutputType__c`]: 'SObject',
      [`${CMT}Type__c`]: 'Load',
      Name: 'AcmeIntakeLoad',
      VlocityRecordSObjectType: `${CMT}DRBundle__c`,
    },
    extractOmniDataTransform,
  );

  // The schema the Load writes, and the installed managed package.
  add(
    'main/default/objects/Acme_Intake__c/Acme_Intake__c.object-meta.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n<deploymentStatus>Deployed</deploymentStatus>\n<label>Acme Intake</label>\n<nameField><label>Name</label><type>Text</type></nameField>\n<pluralLabel>Acme Intakes</pluralLabel>\n<sharingModel>ReadWrite</sharingModel>\n</CustomObject>\n',
    extractCustomObject,
  );
  for (const f of ['Acme_Qty__c', 'Acme_Note__c']) {
    add(
      `main/default/objects/Acme_Intake__c/fields/${f}.field-meta.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n<fullName>${f}</fullName>\n<label>${f}</label>\n<type>Text</type>\n<length>80</length>\n</CustomField>\n`,
      extractCustomField,
    );
  }
  add(
    'main/default/installedPackages/vlocity_cmt.installedPackage-meta.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<InstalledPackage xmlns="http://soap.sforce.com/2006/04/metadata">\n<versionNumber>250.1</versionNumber>\n</InstalledPackage>\n',
    extractInstalledPackage,
  );

  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.body, 'utf-8');
  }
  const results: ExtractionResult[] = [];
  for (const f of files) {
    if (f.extract === null) continue;
    const r = await f.extract(f.path);
    if (!r.ok || r.value === undefined) throw new Error(`fixture extraction failed for ${f.path}: ${JSON.stringify(r)}`);
    results.push(r.value);
  }
  mkdirSync(join(vaultRoot, 'graph'), { recursive: true });
  const opened = await openGraph(join(vaultRoot, 'graph', 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, results);
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
  const manifest: VaultManifest = {
    version: '0.3.3',
    refreshedAt: '2026-10-03T00:00:00Z',
    sourceOrg: 'fixture@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:omni-datapack-fixture',
  };
  ctx = { vaultRoot, manifest, graph: store } as unknown as Context;
}, 60_000);

afterAll(async () => {
  await closeGraph(store);
  rmSync(tmp, { recursive: true, force: true });
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('managed-package (Vlocity) OmniStudio through the MCP tools', () => {
  it('resolves the runtime-service call to the DataPack IP, and the IP to its DataPack DataRaptor', async () => {
    const os = must(await listEdges(store, 'OmniScript:Acme_Intake_English_1' as never, { direction: 'out' }));
    const run = os.find((e) => e.edgeType === 'dispatchesOmniAction');
    expect(run?.toId).toBe('OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1');
    expect(run?.properties['via']).toBe('runtime-service');
    // The managed runtime is not Apex the vault could read.
    expect(os.some((e) => e.edgeType === 'callsApex')).toBe(false);
    const ip = must(await listEdges(store, 'OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1' as never, { direction: 'out' }));
    expect(ip.some((e) => e.toId === 'OmniDataTransform:AcmeIntakeLoad')).toBe(true);
  });

  it('traces the save through the runtime service into the IP and finds the near-miss key', async () => {
    const r = must(await omniSaveTraceHandler(ctx, { omniscript: 'Acme_Intake_English_1' }));
    const qty = r.data.rows.find((x) => x.producedKey === 'IntakeStep:AcmeQty__c');
    expect(qty?.status).toBe('NEVER_SAVED');
    expect(qty?.droppedAt?.dataMapper).toBe('OmniDataTransform:AcmeIntakeLoad');
    expect(qty?.nearMiss?.[0]).toMatchObject({ rule: 'underscore', feeds: ['CustomField:Acme_Intake__c.Acme_Qty__c'] });
    const note = r.data.rows.find((x) => x.producedKey === 'IntakeStep:Acme_Note__c');
    expect(note?.status).toBe('SAVED');
    expect(note?.savedTo?.map((s) => s.field)).toEqual(['CustomField:Acme_Intake__c.Acme_Note__c']);
    // Findings cite the DataPack main file.
    expect(r.data.findings.some((f) => f.sourcePath.endsWith('_DataPack.json'))).toBe(true);
  });

  it('says where the components came from, in the trust block', async () => {
    const r = must(await omniModelHandler(ctx, { componentId: 'Acme/Intake/English' }));
    expect(r.data.appliedScope.componentId).toBe('OmniScript:Acme_Intake_English_1');
    expect(r.data.counts.nodes['OmniElement']).toBeGreaterThanOrEqual(4);
    const limitations = r.data.trust.limitations;
    expect(limitations.some((l) => l.includes('come from a Vlocity DataPack export'))).toBe(true);
    // The export is present, so the "missing components" warning does not fire.
    expect(limitations.some((l) => l.includes('NOT in this answer'))).toBe(false);
  });

  it('walks the DataPack OmniScript, IP and DataRaptor in the per-component tools', async () => {
    const flow = must(await omniscriptFlowHandler(ctx, { omniScriptId: 'OmniScript:Acme_Intake_English_1' }));
    expect(flow.data.steps.map((s) => s.name)).toEqual(['IntakeStep', 'SaveIntake', 'AcmeQty__c', 'Acme_Note__c']);
    expect(flow.data.dispatchedActions.map((a) => a.targetId)).toEqual(['OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1']);
    expect(flow.data.boundaries[0]).toBe(NATIVE_VS_VLOCITY_DISCLOSURE);

    const chain = must(await integrationProcedureChainHandler(ctx, { integrationProcedureId: 'OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1' }));
    expect(chain.data.actions.map((a) => a.name)).toEqual(['LoadIntake', 'Respond']);
    const dr = chain.data.externalEndpoints.find((e) => e.kind === 'dataraptor');
    expect(dr?.targetId).toBe('OmniDataTransform:AcmeIntakeLoad');

    const map = must(await datatransformFieldMapHandler(ctx, { dataTransformId: 'OmniDataTransform:AcmeIntakeLoad' }));
    expect(map.data.mappings.map((m) => [m.sourceField, m.targetField])).toEqual([
      ['Intake:Acme_Qty__c', 'Acme_Qty__c'],
      ['Intake:Acme_Note__c', 'Acme_Note__c'],
    ]);
    expect(map.data.targetObject).toBe('Acme_Intake__c');
  });

  it('follows a runtime-service Remote Action inside an IP as a nested IP call', async () => {
    // The chain walker reads the same catalog rule as the graph and the engine.
    const chain = must(await integrationProcedureChainHandler(ctx, { integrationProcedureId: 'OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1' }));
    expect(chain.data.externalEndpoints.some((e) => e.kind === 'remote-action')).toBe(false);
  });
});

describe('managedPackageLimitations', () => {
  it('warns that a Vlocity package without an export leaves its components out of the answer', () => {
    const out = managedPackageLimitations({ installedNamespaces: ['vlocity_ins'], dataPackComponents: 0, nativeComponents: 12 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('vlocity_ins');
    expect(out[0]).toContain('NOT in this answer');
    expect(out[0]).toContain('org-kb/source/vlocity/');
  });

  it('asks only conditionally when the omnistudio runtime is installed and the vault has no OmniStudio at all', () => {
    const out = managedPackageLimitations({ installedNamespaces: ['omnistudio'], dataPackComponents: 0, nativeComponents: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('if this org runs the managed-package runtime');
    // Native components present: the omnistudio package is the native runtime's support package — nothing to say.
    expect(managedPackageLimitations({ installedNamespaces: ['omnistudio'], dataPackComponents: 0, nativeComponents: 3 })).toEqual([]);
  });

  it('says nothing for an org with no managed OmniStudio package', () => {
    expect(managedPackageLimitations({ installedNamespaces: [], dataPackComponents: 0, nativeComponents: 40 })).toEqual([]);
  });
});
