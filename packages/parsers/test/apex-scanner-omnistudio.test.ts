/// <reference types="vitest/globals" />

import { scanApexSource } from '../src/apex-scanner.js';

/**
 * Apex calling INTO OmniStudio's runtime: an Integration Procedure run by its
 * `Type_SubType` key, a DataRaptor run by its bundle name. The scanner reports
 * every call with what is written before the class (the namespace) and the
 * callable name when it is a static literal. Synthetic Acme names.
 */

const scan = (body: string) => {
  const r = scanApexSource(`public class Acme_IntakeService {\n${body}\n}`);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.omniStudioCalls;
};

describe('scanApexSource — OmniStudio runtime calls', () => {
  it('reads the IP key (1st argument) and the DataRaptor bundle (2nd argument) with their namespaces', () => {
    const calls = scan(`
      public Map<String, Object> save(Map<String, Object> input) {
        Map<String, Object> options = new Map<String, Object>();
        Object out = omnistudio.IntegrationProcedureService.runIntegrationService('Acme_SaveIntake', input, options);
        vlocity_cmt.DRProcessResult r = vlocity_cmt.DRGlobal.process(new Map<String, Object>{ 'a' => 1, 'b' => 2 }, 'AcmeIntakeLoad');
        omnistudio.DRGlobal.processObjectsJSON(JSON.serialize(input), 'AcmeIntakeExtract');
        return (Map<String, Object>) out;
      }`);
    expect(calls.map((c) => [c.kind, c.namespace, c.className, c.methodName, c.target])).toEqual([
      ['integration-procedure', 'omnistudio', 'IntegrationProcedureService', 'runIntegrationService', 'Acme_SaveIntake'],
      ['data-mapper', 'vlocity_cmt', 'DRGlobal', 'process', 'AcmeIntakeLoad'],
      ['data-mapper', 'omnistudio', 'DRGlobal', 'processObjectsJSON', 'AcmeIntakeExtract'],
    ]);
  });

  it('reports a key built at runtime as unresolved, never guessed', () => {
    const calls = scan(`
      public void run(String key) {
        omnistudio.IntegrationProcedureService.runIntegrationService('Acme_' + key, null, null);
        omnistudio.IntegrationProcedureService.runIntegrationService(key, null, null);
      }`);
    expect(calls.map((c) => c.target)).toEqual([null, null]);
  });

  it('ignores a commented-out call and is not derailed by quotes or commas in comments and strings', () => {
    const calls = scan(`
      public void run() {
        // omnistudio.IntegrationProcedureService.runIntegrationService('Acme_Old', null, null);
        omnistudio.DRGlobal.process(new Map<String, Object>{ 'k' => 'x, y' }, /* don't */ 'AcmeBundle');
      }`);
    expect(calls.map((c) => [c.className, c.target])).toEqual([['DRGlobal', null]]);
    // The bundle argument carries a comment, so it is not ONE literal — unresolved, not guessed.
    const clean = scan(`
      public void run() {
        omnistudio.DRGlobal.process(new Map<String, Object>{ 'k' => 'x, y' }, 'AcmeBundle');
      }`);
    expect(clean.map((c) => c.target)).toEqual(['AcmeBundle']);
  });

  it('reports what is written before the class, including nothing', () => {
    const calls = scan(`
      public void run() {
        IntegrationProcedureService.runIntegrationService('Acme_Local', null, null);
      }`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.namespace).toBeNull();
  });

  it('skips runtime methods that do not take a callable name', () => {
    expect(scan(`public void run() { omnistudio.DRGlobal.somethingElse('x'); }`)).toEqual([]);
  });
});

describe('scanApexSource — Schema describe chains are not class calls', () => {
  it('drops the sObject / field token in a describe chain and keeps real class calls', () => {
    const r = scanApexSource(`public class Acme_RecordTypes {
      public static Id intakeType() {
        Id rt = Schema.SObjectType.Account.getRecordTypeInfosByName().get('Intake').getRecordTypeId();
        String label = Schema.SObjectType.Account.fields.Name.getDescribe().getLabel();
        return Acme_Helper.pick(rt, label);
      }
    }`);
    if (!r.ok) throw new Error(r.error.message);
    const classes = r.value.methodCalls.map((c) => c.className);
    expect(classes).not.toContain('Account');
    expect(classes).not.toContain('Name');
    expect(classes).toContain('Acme_Helper');
  });
});
