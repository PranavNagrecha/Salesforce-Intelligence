import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractValidationRule } from '../src/validation-rule.js';

/**
 * B10: a validation rule that shows its error ON a field depends on that field
 * even when its formula never reads it. No edge was minted, so delete-safety
 * missed it. Synthetic fixture.
 */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Amount_Positive</fullName>
    <active>false</active>
    <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
    <errorDisplayField>Review_Flag__c</errorDisplayField>
    <errorMessage>Amount must be positive</errorMessage>
</ValidationRule>`;

describe('validation rule errorDisplayField', () => {
  it('FAIL-BEFORE/PASS-AFTER: mints a declared references edge to the error display field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-vr-edf-'));
    try {
      const vrDir = join(dir, 'objects', 'Invoice__c', 'validationRules');
      mkdirSync(vrDir, { recursive: true });
      const path = join(vrDir, 'Amount_Positive.validationRule-meta.xml');
      writeFileSync(path, XML);
      const r = await extractValidationRule(path);
      if (!r.ok) throw new Error(r.error.message);
      const display = r.value.edges.filter(
        (e) => e.properties['referenceKind'] === 'errorDisplayField',
      );
      expect(display).toEqual([
        {
          fromId: 'ValidationRule:Invoice__c.Amount_Positive',
          toId: 'CustomField:Invoice__c.Review_Flag__c',
          edgeType: 'references',
          confidence: 'declared',
          source: 'validation-rule-extractor',
          properties: { referenceKind: 'errorDisplayField' },
        },
      ]);
      // The formula's own read is still there.
      expect(r.value.edges.some((e) => e.toId === 'CustomField:Invoice__c.Amount__c')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
