/// <reference types="vitest/globals" />

import {
  scanFrontendSource,
  type FrontendDialect,
} from '../src/frontend-scanner.js';

describe('scanFrontendSource — cross-dialect error cases', () => {
  it('rejects empty input with empty-source', () => {
    const result = scanFrontendSource('', 'lwc');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-source');
    expect(result.error.offset).toBe(0);
  });

  it('rejects whitespace-only input with empty-source', () => {
    const result = scanFrontendSource('   \n\t  ', 'aura');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-source');
  });

  it('rejects unknown dialect with unknown-dialect', () => {
    // Type-system guard — Zod validation should prevent this in
    // practice. We force it here to verify the runtime guard.
    const result = scanFrontendSource(
      'something',
      'random' as unknown as FrontendDialect,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unknown-dialect');
  });
});

describe('scanFrontendSource — LWC', () => {
  it('detects an Apex default import as an apexCall', () => {
    const result = scanFrontendSource(
      `import method from '@salesforce/apex/AccountService.fetch';`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apexCalls).toHaveLength(1);
    expect(result.value.apexCalls[0]?.className).toBe('AccountService');
    expect(result.value.apexCalls[0]?.methodName).toBe('fetch');
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.componentRefs).toEqual([]);
    expect(result.value.dialect).toBe('lwc');
  });

  it('detects an Apex named import as an apexCall', () => {
    const result = scanFrontendSource(
      `import { refreshApex } from '@salesforce/apex/AccountService.fetch';`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apexCalls).toHaveLength(1);
    expect(result.value.apexCalls[0]?.className).toBe('AccountService');
    expect(result.value.apexCalls[0]?.methodName).toBe('fetch');
  });

  it('detects a schema import as a read fieldAccess', () => {
    const result = scanFrontendSource(
      `import INDUSTRY_FIELD from '@salesforce/schema/Account.Industry__c';`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    const access = result.value.fieldAccesses[0];
    expect(access?.type).toBe('read');
    expect(access?.object).toBe('Account');
    expect(access?.field).toBe('Industry__c');
  });

  it('detects a record.Field write', () => {
    const result = scanFrontendSource(
      `function update(r) { r.Industry__c = 'Tech'; }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = result.value.fieldAccesses.filter((a) => a.type === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.object).toBe('r');
    expect(writes[0]?.field).toBe('Industry__c');
  });

  it('detects a this.record.Field write (chain skips intermediate)', () => {
    const result = scanFrontendSource(
      `update() { this.record.Industry__c = 'Tech'; }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = result.value.fieldAccesses.filter((a) => a.type === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.object).toBe('record');
    expect(writes[0]?.field).toBe('Industry__c');
  });

  it('detects a record.Field read', () => {
    const result = scanFrontendSource(
      `function read(r) { return r.Industry__c; }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.object).toBe('r');
    expect(reads[0]?.field).toBe('Industry__c');
  });

  it('detects getRecord fields literal array as multiple reads', () => {
    const result = scanFrontendSource(
      `getRecord({ recordId, fields: ['Account.Name', 'Account.Industry'] });`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads).toHaveLength(2);
    expect(reads.map((r) => `${r.object}.${r.field}`)).toEqual([
      'Account.Name',
      'Account.Industry',
    ]);
  });

  it('deduplicates the same field read', () => {
    const result = scanFrontendSource(
      `function f(a, b) { return a.Industry__c + b.Industry__c; }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both `a.Industry__c` and `b.Industry__c` have different objects,
    // so they are NOT duplicates. Confirm we see both.
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads).toHaveLength(2);

    // Now confirm SAME-(object,field) deduplicates.
    const dup = scanFrontendSource(
      `function f(a) { return a.Industry__c + a.Industry__c; }`,
      'lwc',
    );
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    const dupReads = dup.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(dupReads).toHaveLength(1);
  });

  it('ignores accesses inside line comments', () => {
    const result = scanFrontendSource(
      `function f() {\n  // this.record.Foo__c = 1;\n  return 0;\n}`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('ignores accesses inside string literals', () => {
    const result = scanFrontendSource(
      `function f() { const sql = 'SELECT Foo FROM Account'; const x = 'rec.Foo__c'; return sql; }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The `'rec.Foo__c'` literal has lowercase first IDENT (`rec`)
    // and an uppercase second IDENT (`Foo__c`); without string
    // stripping it would match the read pattern. Confirm it doesn't.
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('ignores accesses inside block comments', () => {
    const result = scanFrontendSource(
      `function f() {\n  /* a.Foo__c = 1; */ return 0;\n}`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('does not match lowercase-second-IDENT property accesses', () => {
    // `this.helperMethod()` is bundle-internal and emits no edges.
    // The lowercase-second-IDENT filter handles it.
    const result = scanFrontendSource(
      `function f() { return this.helperMethod(); }`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.apexCalls).toEqual([]);
  });
});

describe('scanFrontendSource — Aura', () => {
  it('detects a c:Component markup tag', () => {
    const result = scanFrontendSource(
      `<aura:component>\n  <c:CustomerCard recordId="{!v.recId}" />\n</aura:component>`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('CustomerCard');
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.apexCalls).toEqual([]);
  });

  it('detects a $A.get event reference', () => {
    const result = scanFrontendSource(
      `var event = $A.get('e.c:caseUpdate');`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('caseUpdate');
  });

  it('deduplicates the same component name across markup and event ref', () => {
    const result = scanFrontendSource(
      `<c:FooBar />\n<c:FooBar />`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('FooBar');
  });

  it('ignores accesses inside HTML comments', () => {
    const result = scanFrontendSource(
      `<aura:component>\n  <!-- <c:Hidden /> -->\n  <c:Visible />\n</aura:component>`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('Visible');
  });

  it('does not extract field accesses or apex calls', () => {
    // Per LwcAuraVfScannerSemantics.md, Aura emits neither writesTo
    // (server-action pattern) nor a field-access shape from `v.attr`.
    const result = scanFrontendSource(
      `({ doInit: function(component) { component.set('v.foo', component.get('v.bar')); } })`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.apexCalls).toEqual([]);
  });

  it('matches two distinct component tags', () => {
    const result = scanFrontendSource(
      `<aura:component>\n  <c:Header />\n  <c:Footer />\n</aura:component>`,
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(2);
    expect(result.value.componentRefs.map((r) => r.componentName)).toEqual([
      'Header',
      'Footer',
    ]);
  });
});

describe('scanFrontendSource — VF', () => {
  it('detects a {!Object.Field} merge token as a read', () => {
    const result = scanFrontendSource(
      `<apex:outputText value="{!Account.Name}" />`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    const access = result.value.fieldAccesses[0];
    expect(access?.type).toBe('read');
    expect(access?.object).toBe('Account');
    expect(access?.field).toBe('Name');
  });

  it('detects a {!Object.Custom__c} custom field merge token', () => {
    const result = scanFrontendSource(
      `<apex:outputText value="{!opp.StageName}" /> <apex:outputText value="{!Account.Industry__c}" />`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(2);
    expect(
      result.value.fieldAccesses.map((a) => `${a.object}.${a.field}`),
    ).toEqual(['opp.StageName', 'Account.Industry__c']);
  });

  it('detects a {!ClassName.method()} Apex call', () => {
    const result = scanFrontendSource(
      `<apex:commandButton action="{!MyClass.staticMethod()}" />`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apexCalls).toHaveLength(1);
    expect(result.value.apexCalls[0]?.className).toBe('MyClass');
    expect(result.value.apexCalls[0]?.methodName).toBe('staticMethod');
    // The Apex call should NOT also yield a field-access read for
    // (MyClass, staticMethod) — the `(` lookahead in the merge regex
    // excludes call shapes.
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('detects an <apex:include pageName="X" /> as a componentRef', () => {
    const result = scanFrontendSource(
      `<apex:page>\n  <apex:include pageName="Header" />\n</apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('Header');
  });

  it('detects a <c:Footer /> custom component tag', () => {
    const result = scanFrontendSource(
      `<apex:page>\n  <c:Footer />\n</apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('Footer');
  });

  it('ignores merge tokens inside HTML comments', () => {
    const result = scanFrontendSource(
      `<apex:page>\n  <!-- {!Account.Foo__c} -->\n  <apex:outputText value="{!Account.Name}" />\n</apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    expect(result.value.fieldAccesses[0]?.field).toBe('Name');
  });

  it('ignores merge tokens inside VF directive comments', () => {
    const result = scanFrontendSource(
      `<apex:page>\n  <%-- {!Account.Bar__c} --%>\n  <apex:outputText value="{!Account.Name}" />\n</apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    expect(result.value.fieldAccesses[0]?.field).toBe('Name');
  });

  it('does NOT extract controller="X" attribute from <apex:page>', () => {
    // The `controller` attribute is parsed by the VisualforcePage
    // extractor at wiring time, not by the scanner. The scanner
    // should NOT emit a callsApex edge from the attribute.
    const result = scanFrontendSource(
      `<apex:page controller="MyController"></apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apexCalls).toEqual([]);
  });

  it('deduplicates the same merge token used twice', () => {
    const result = scanFrontendSource(
      `<apex:outputText value="{!Account.Name}" /> <apex:outputText value="{!Account.Name}" />`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
  });

  it('deduplicates the same component name across <apex:include> and <c:Tag>', () => {
    const result = scanFrontendSource(
      `<apex:include pageName="Shared" /> <c:Shared />`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.componentRefs).toHaveLength(1);
    expect(result.value.componentRefs[0]?.componentName).toBe('Shared');
  });
});

describe('scanFrontendSource — determinism', () => {
  it('returns identical output for repeated calls', () => {
    const source = `import method from '@salesforce/apex/AccountService.fetch';\nfunction f() { return obj.Industry__c; }`;
    const a = scanFrontendSource(source, 'lwc');
    const b = scanFrontendSource(source, 'lwc');
    expect(a).toEqual(b);
  });
});

describe('scanFrontendSource — resourceRefs (P14-USAGE-label-static-graph)', () => {
  it('LWC: detects label and resourceUrl imports as resourceRefs', () => {
    const result = scanFrontendSource(
      [
        `import WELCOME from '@salesforce/label/c.Welcome_Message';`,
        `import LOGO from '@salesforce/resourceUrl/BrandLogo';`,
        `// import IGNORED from '@salesforce/label/c.Commented_Out';`,
      ].join('\n'),
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resourceRefs).toEqual([
      expect.objectContaining({ kind: 'label', apiName: 'Welcome_Message' }),
      expect.objectContaining({ kind: 'staticResource', apiName: 'BrandLogo' }),
    ]);
  });

  it('LWC: does NOT capture namespaced (managed-package) label imports', () => {
    const result = scanFrontendSource(
      `import X from '@salesforce/label/ns.Packaged_Label';`,
      'lwc',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resourceRefs).toEqual([]);
  });

  it('Aura: detects $Label.c.X in markup and $Resource.X, deduped', () => {
    const result = scanFrontendSource(
      [
        `<aura:component>`,
        `  <span>{!$Label.c.Welcome_Message}</span>`,
        `  <img src="{!$Resource.BrandLogo}"/>`,
        `  <img src="{!$Resource.BrandLogo}"/>`,
        `</aura:component>`,
      ].join('\n'),
      'aura',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resourceRefs).toEqual([
      expect.objectContaining({ kind: 'label', apiName: 'Welcome_Message' }),
      expect.objectContaining({ kind: 'staticResource', apiName: 'BrandLogo' }),
    ]);
  });

  it('VF: detects $Label.X (no c. namespace), $Resource.X, and $Setup custom-setting reads', () => {
    const result = scanFrontendSource(
      [
        `<apex:page>`,
        `  <apex:outputText value="{!$Label.Site_Welcome}"/>`,
        `  <apex:image url="{!$Resource.BrandLogo}"/>`,
        `  <apex:outputText value="{!$Setup.Batch_Config__c.Timeout__c}"/>`,
        `</apex:page>`,
      ].join('\n'),
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resourceRefs).toEqual([
      expect.objectContaining({ kind: 'label', apiName: 'Site_Welcome' }),
      expect.objectContaining({ kind: 'staticResource', apiName: 'BrandLogo' }),
      expect.objectContaining({ kind: 'customSetting', apiName: 'Batch_Config__c' }),
    ]);
  });

  it('VF: an Aura-style $Label.c.X never captures the bare namespace token', () => {
    const result = scanFrontendSource(
      `<apex:page><span>{!$Label.c.Strayed}</span></apex:page>`,
      'vf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resourceRefs.map((r) => r.apiName)).not.toContain('c');
  });
});
