/// <reference types="vitest/globals" />
/**
 * P8-manifest-export — `buildExportManifest` groups canonical ids into a
 * well-formed package.xml. Pure, so this is a fast T-unit. The load-bearing
 * checks: members grouped/sorted/de-duped per type, the `<name>` mapped to the
 * deployable metadata-type name, synthetic + malformed ids skipped, XML special
 * characters escaped, and the result PARSES (a stack-based well-formedness
 * check, since there is no XML parser in this package's deps).
 */
import { buildExportManifest } from '../../src/tools/export-manifest.js';

/** Minimal well-formedness check: tags balance and nest (prolog stripped). */
const isWellFormed = (xml: string): boolean => {
  const body = xml.replace(/<\?xml[^>]*\?>/g, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)(\s[^>]*)?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    const selfClose = m[4] === '/';
    if (selfClose) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
};

describe('P8-manifest-export — buildExportManifest', () => {
  it('groups by type, maps metadata names, sorts + de-dupes, skips synthetic/malformed', () => {
    const out = buildExportManifest(
      [
        'CustomField:Account.Name__c',
        'CustomField:Account.Industry',
        'CustomField:Account.Name__c', // duplicate
        'CustomObject:Account',
        'WorkflowRule:Account.MyRule',
        'VisualforcePage:MyPage',
        'ConditionalContext:WorkflowRule:Account.MyRule.condition-0', // synthetic → skip
        'BadId', // no colon → skip
      ],
      '62.0',
    );

    const bucket = (type: string) => out.summary.byType.find((b) => b.type === type);
    expect(bucket('CustomField')?.members).toBe(2); // de-duped
    expect(bucket('WorkflowRule')?.metadataName).toBe('Workflow');
    expect(bucket('VisualforcePage')?.metadataName).toBe('ApexPage');
    expect(out.summary.typeCount).toBe(4);
    expect(out.summary.memberCount).toBe(5);

    const skippedIds = out.skipped.map((s) => s.id);
    expect(skippedIds).toContain('BadId');
    expect(skippedIds.some((id) => id.startsWith('ConditionalContext:'))).toBe(true);

    // members sorted within a type
    expect(out.packageXml).toContain('<members>Account.Industry</members>');
    expect(out.packageXml.indexOf('Account.Industry')).toBeLessThan(
      out.packageXml.indexOf('Account.Name__c'),
    );
    // deployable <name> mapping present verbatim
    expect(out.packageXml).toContain('<name>Workflow</name>');
    expect(out.packageXml).toContain('<name>ApexPage</name>');
    expect(out.packageXml).toContain('<version>62.0</version>');
  });

  it('emits well-formed XML and escapes special characters in member names', () => {
    const out = buildExportManifest(['Report:Sales & Marketing <Q1>'], '62.0');
    expect(out.packageXml).toContain('<members>Sales &amp; Marketing &lt;Q1&gt;</members>');
    expect(out.packageXml).not.toMatch(/<members>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(isWellFormed(out.packageXml)).toBe(true);
  });

  it('honors an apiVersion override and PROPOSES (never deploys)', () => {
    const out = buildExportManifest(['ApexClass:Foo'], '59.0');
    expect(out.version).toBe('59.0');
    expect(out.packageXml).toContain('<version>59.0</version>');
    expect(out.disclosure).toMatch(/PROPOSES|never deploys/i);
  });
});
