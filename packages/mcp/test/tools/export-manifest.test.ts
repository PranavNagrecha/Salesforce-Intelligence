/// <reference types="vitest/globals" />
/**
 * P8-manifest-export — `buildExportManifest` groups canonical ids into a
 * well-formed package.xml. Pure, so this is a fast T-unit. The load-bearing
 * checks: members grouped/sorted/de-duped per type, the `<name>` mapped to the
 * deployable metadata-type name, synthetic + malformed ids skipped, XML special
 * characters escaped, and the result PARSES (a stack-based well-formedness
 * check, since there is no XML parser in this package's deps).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExportManifest } from '../../src/tools/export-manifest.js';

/** Repo root, from this file at `packages/mcp/test/tools/`. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

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

/**
 * R6 drift guard (census finding 005). The `METADATA_API_NAME` map in
 * `export-manifest.ts` carried only a COMMENT ("KEEP IN SYNC with
 * `packages/cli/src/commands/refresh.ts`") as its guard, and the comment had
 * already failed: refresh.ts carried 12 aliases, the manifest emitter 9. The
 * three missing ones were the org-level settings singletons, which the org
 * describe exposes ONLY as the umbrella `Settings` xmlName — so
 * `export_manifest({ componentIds: ['SecuritySettings:default'] })` emitted
 * `<name>SecuritySettings</name>`, a package.xml that cannot deploy, while the
 * summary reported it packaged cleanly (`memberCount: 1`, `skipped: []`).
 *
 * This replaces the comment with a DERIVED check: parse the alias literal out
 * of BOTH sources and require the manifest emitter to cover every entry
 * refresh.ts declares. Shaped after `full-scan-adoption.test.ts`.
 */
describe('R6 — METADATA_API_NAME drift against the retrieve manifest', () => {
  const readAliasLiteral = (file: string): Record<string, string> => {
    const src = readFileSync(file, 'utf8');
    const start = src.indexOf('const METADATA_API_NAME');
    expect(start).toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(open);
    const body = src.slice(open + 1, end).replace(/\/\/[^\n]*/g, '');
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*'([^']+)'/g)) {
      out[m[1] as string] = m[2] as string;
    }
    expect(Object.keys(out).length).toBeGreaterThan(0);
    return out;
  };

  it('covers every alias the retrieve manifest declares, with the same value', () => {
    const retrieveSide = readAliasLiteral(
      join(REPO_ROOT, 'packages/cli/src/commands/refresh.ts'),
    );
    const manifestSide = readAliasLiteral(
      join(REPO_ROOT, 'packages/mcp/src/tools/export-manifest.ts'),
    );
    const drift = Object.entries(retrieveSide)
      .filter(([type, apiName]) => manifestSide[type] !== apiName)
      .map(([type, apiName]) => `${type} → ${apiName} (emitter has ${String(manifestSide[type])})`);
    expect(drift).toEqual([]);
  });

  it('packages the org-level settings singletons under the umbrella Settings type', () => {
    const out = buildExportManifest(
      ['SecuritySettings:default', 'SessionSettings:default', 'FieldServiceSettings:default'],
      '62.0',
    );
    for (const bucket of out.summary.byType) {
      expect(bucket.metadataName).toBe('Settings');
    }
    expect(out.packageXml).not.toContain('<name>SecuritySettings</name>');
    expect(out.packageXml).not.toContain('<name>SessionSettings</name>');
    expect(out.packageXml).not.toContain('<name>FieldServiceSettings</name>');
    expect(out.packageXml).toContain('<name>Settings</name>');
  });

  /**
   * Half a fix is still an undeployable manifest: `<name>Settings</name>` with
   * `<members>default</members>` names no settings file. The Metadata API
   * member for a Settings entry is the `[FeatureName]` of the
   * `[FeatureName].settings` file — `Security` and `FieldService` here.
   * SessionSettings has NO file of its own (refresh.ts: "Salesforce emits no
   * `Session.settings-meta.xml`"; it is a nested block of Security), so it
   * addresses the SAME member and must fold into it, not invent `Session`.
   */
  it('names the settings file as the member, folding SessionSettings into Security', () => {
    const out = buildExportManifest(
      ['SecuritySettings:default', 'SessionSettings:default', 'FieldServiceSettings:default'],
      '62.0',
    );
    expect(out.packageXml).toContain('<members>Security</members>');
    expect(out.packageXml).toContain('<members>FieldService</members>');
    expect(out.packageXml).not.toContain('<members>default</members>');
    expect(out.packageXml).not.toContain('<members>Session</members>');
    // Security + Session are ONE deployable member, not two.
    expect(out.summary.typeCount).toBe(1);
    expect(out.summary.memberCount).toBe(2);
  });
});
