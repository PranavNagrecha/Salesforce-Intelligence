/// <reference types="vitest/globals" />

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDemoSource } from '../../src/commands/demo.js';

describe('sfi demo — bundled synthetic source', () => {
  it('resolves a real demo source tree (shipped demo-source/ or in-repo examples/)', () => {
    const src = resolveDemoSource();
    expect(src).not.toBeNull();
    expect(existsSync(src as string)).toBe(true);
  });

  it('the resolved tree contains the synthetic Verdant Energy schema', () => {
    const src = resolveDemoSource() as string;
    // Project__c is the spine of the demo org; its presence proves we found the
    // right tree (not an empty/foreign directory).
    expect(existsSync(join(src, 'objects', 'Project__c', 'Project__c.object-meta.xml'))).toBe(true);
    expect(existsSync(join(src, 'objects', 'Payment__c', 'Payment__c.object-meta.xml'))).toBe(true);
  });
});
