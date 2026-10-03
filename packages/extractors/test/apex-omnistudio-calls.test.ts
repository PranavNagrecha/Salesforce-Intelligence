/// <reference types="vitest/globals" />

import { buildApexScannerEdges } from '../src/apex-edges.js';

/**
 * Apex calling INTO OmniStudio: the class is a caller of the Integration
 * Procedure / DataRaptor it runs by name, so it gets the same
 * `dispatchesOmniAction` edge an OmniScript step does — and none of the
 * phantoms the generic call/field sweeps used to mint for the namespaced
 * runtime class. Synthetic Acme names.
 */

const SOURCE = `public with sharing class Acme_IntakeService {
  public static Map<String, Object> save(Map<String, Object> input) {
    Map<String, Object> options = new Map<String, Object>();
    Object out = omnistudio.IntegrationProcedureService.runIntegrationService('Acme_SaveIntake', input, options);
    omnistudio.IntegrationProcedureService.runIntegrationService('Acme_SaveIntake', input, options);
    vlocity_cmt.DRProcessResult r = vlocity_cmt.DRGlobal.process(new Map<String, Object>{ 'a' => 1 }, 'AcmeIntakeLoad');
    omnistudio.IntegrationProcedureService.runIntegrationService('Acme_' + input.get('step'), input, options);
    Acme_Helper.log('saved');
    return (Map<String, Object>) out;
  }
}`;

describe('buildApexScannerEdges — Apex → OmniStudio runtime calls', () => {
  const { edges } = buildApexScannerEdges(SOURCE, 'ApexClass:Acme_IntakeService');
  const dispatch = edges.filter((e) => e.edgeType === 'dispatchesOmniAction');

  it('emits one dispatch edge per literal target, keyed the way the graph resolves OmniStudio callers', () => {
    expect(dispatch.map((e) => e.toId).sort()).toEqual(['OmniDataTransform:AcmeIntakeLoad', 'OmniIntegrationProcedure:Acme_SaveIntake']);
    const ip = dispatch.find((e) => e.toId === 'OmniIntegrationProcedure:Acme_SaveIntake');
    expect(ip?.confidence).toBe('heuristic');
    expect(ip?.properties).toMatchObject({
      via: 'apex',
      mechanism: 'apex-runtime-service',
      runtimeServices: ['omnistudio.IntegrationProcedureService'],
      methods: ['runIntegrationService'],
      integrationProcedureKey: 'Acme_SaveIntake',
      callSites: 2,
    });
    expect(dispatch.find((e) => e.toId === 'OmniDataTransform:AcmeIntakeLoad')?.properties).toMatchObject({
      runtimeServices: ['vlocity_cmt.DRGlobal'],
      bundle: 'AcmeIntakeLoad',
    });
  });

  it('mints no phantom org class or field for the runtime service — and keeps real calls', () => {
    const ids = edges.map((e) => `${e.edgeType} ${e.toId}`);
    expect(ids).not.toContain('callsApex ApexClass:IntegrationProcedureService');
    expect(ids).not.toContain('callsApex ApexClass:DRGlobal');
    expect(ids.some((i) => i.startsWith('readsFrom CustomField:omnistudio.'))).toBe(false);
    expect(ids.some((i) => i.startsWith('readsFrom CustomField:vlocity_cmt.'))).toBe(false);
    expect(ids).toContain('callsApex ApexClass:Acme_Helper');
  });

  it('does not treat another namespace, or an org class of the same name, as OmniStudio', () => {
    const other = buildApexScannerEdges(
      `public class Acme_Other {
        public void run() {
          acmepkg.IntegrationProcedureService.runIntegrationService('Acme_X', null, null);
          IntegrationProcedureService.runIntegrationService('Acme_Y', null, null);
        }
      }`,
      'ApexClass:Acme_Other',
    ).edges;
    expect(other.filter((e) => e.edgeType === 'dispatchesOmniAction')).toEqual([]);
    // An un-namespaced call is an org class — its callsApex edge stays.
    expect(other.some((e) => e.edgeType === 'callsApex' && e.toId === 'ApexClass:IntegrationProcedureService')).toBe(true);
  });
});
