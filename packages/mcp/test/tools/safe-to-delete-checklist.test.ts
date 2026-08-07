/// <reference types="vitest/globals" />
/**
 * P8-destructive-checklist — `safe_to_delete_field(format: 'checklist')` renders
 * a "before you delete X" Markdown checklist. `renderDeleteChecklist` is pure,
 * so this is a fast T-unit. Load-bearing checks: the coverageCaveat is surfaced
 * FIRST (before the verdict, never footnoted), removal steps are `- [ ]` items
 * ordered most-severe-first, and the disclosure marks it propose-only.
 */
import type { ComponentId, ComponentType, TrustSummary } from '@sf-intelligence/contracts';

import { buildSafeToDeleteEvidenceEnvelope } from '../../src/tools/evidence-envelope.js';
import {
  renderDeleteChecklist,
  type SafeToDeleteFieldOutput,
} from '../../src/tools/safe-to-delete-field.js';

const TRUST: TrustSummary = {
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: { snapshotRefreshedAt: '2026-01-01T00:00:00.000Z' },
  completeness: { status: 'partial' },
  limitations: [],
};

const withEnvelope = (
  data: Omit<SafeToDeleteFieldOutput, 'evidenceEnvelope'>,
): SafeToDeleteFieldOutput => ({
  ...data,
  evidenceEnvelope: buildSafeToDeleteEvidenceEnvelope(data),
});

const sample = (withCaveat: boolean): SafeToDeleteFieldOutput =>
  withEnvelope({
    fieldId: 'CustomField:Account.Acme__c' as ComponentId,
    verdict: 'blocking',
    reasoning: [
      {
        category: 'layout',
        verdict: 'review',
        count: 2,
        examples: [
          { id: 'Layout:Account-L' as ComponentId, type: 'Layout' as ComponentType, apiName: 'Account-L' },
        ],
        note: 'Appears on 2 page layouts.',
      },
      {
        category: 'flow',
        verdict: 'blocking',
        count: 1,
        examples: [
          { id: 'Flow:Acme_Flow' as ComponentId, type: 'Flow' as ComponentType, apiName: 'Acme_Flow' },
        ],
        note: 'A Flow writes this field.',
      },
    ],
    ...(withCaveat
      ? { coverageCaveat: { status: 'partial', missingCoverage: ['Flow'], message: 'Flow coverage is partial.' } }
      : {}),
    trust: TRUST,
  });

describe('P8-destructive-checklist — renderDeleteChecklist', () => {
  it('surfaces the coverageCaveat BEFORE the verdict and renders ordered checklist items', () => {
    const md = renderDeleteChecklist(sample(true));
    // caveat appears, and before the verdict line (never footnoted)
    expect(md).toContain('Coverage caveat');
    expect(md.indexOf('Coverage caveat')).toBeLessThan(md.indexOf('Verdict:'));
    // checkbox items present
    expect(md).toContain('- [ ]');
    // most-severe-first: the blocking flow ranks above the review layout
    expect(md.indexOf('**flow**')).toBeLessThan(md.indexOf('**layout**'));
    // mdTable detail rendered
    expect(md).toContain('Category');
    expect(md).toContain('Severity');
    // propose-only disclosure
    expect(md).toMatch(/never deploys|verify against your org/i);
  });

  it('omits the caveat block when coverage is complete', () => {
    const md = renderDeleteChecklist(sample(false));
    expect(md).not.toContain('Coverage caveat');
    expect(md).toContain('Verdict:');
  });

  it('handles a field with no dependencies', () => {
    const clean = withEnvelope({
      fieldId: 'CustomField:Account.Unused__c' as ComponentId,
      verdict: 'safe',
      reasoning: [],
      trust: TRUST,
    });
    const md = renderDeleteChecklist(clean);
    expect(md).toContain('No inbound dependencies');
    expect(md).not.toContain('- [ ]');
  });
});
