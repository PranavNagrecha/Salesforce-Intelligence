/// <reference types="vitest/globals" />
/**
 * AUDIT-F4 — EvidenceEnvelope v2 builders + runtime assert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TrustSummary } from '@sf-intelligence/contracts';

import {
  assertEvidenceEnvelopeV2,
  buildInterpretEvidenceEnvelope,
  buildSafeToDeleteEvidenceEnvelope,
  EVIDENCE_ENVELOPE_VERSION,
  EvidenceEnvelopeError,
} from '../../src/tools/evidence-envelope.js';

const trust = (status: TrustSummary['completeness']['status']): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: { snapshotRefreshedAt: '2026-08-01T00:00:00.000Z' },
  completeness: { status },
  limitations: ['unit-test'],
});

describe('EvidenceEnvelope v2 (AUDIT-F4)', () => {
  it('assertEvidenceEnvelopeV2 accepts a valid envelope', () => {
    const envelope = buildInterpretEvidenceEnvelope({
      interpretations: [],
      trust: trust('complete'),
      disclosure: 'test disclosure',
    });
    expect(envelope.envelopeVersion).toBe(2);
    expect(envelope.claims).toEqual([]);
    expect(envelope.absence?.status).toBe('unknown');
    expect(() => assertEvidenceEnvelopeV2(envelope)).not.toThrow();
  });

  it('assertEvidenceEnvelopeV2 rejects a wrong version', () => {
    expect(() =>
      assertEvidenceEnvelopeV2({
        envelopeVersion: 1,
        claims: [],
        evidence: [],
        coverage: { status: 'complete' },
        freshness: {},
        trust: trust('complete'),
      }),
    ).toThrow(EvidenceEnvelopeError);
  });

  it('buildInterpretEvidenceEnvelope projects interpretation claims', () => {
    const envelope = buildInterpretEvidenceEnvelope({
      interpretations: [
        {
          ruleId: 'r1',
          concept: 'master-detail-cascade',
          claim: 'cascade deletes children',
          groundedIn: ['CustomObject:Account', 'CustomField:Account.Parent__c'],
          confidence: 'declared',
          coverageCaveat: null,
          modelVersion: '1',
          provenance: 'offline_snapshot',
        },
      ],
      trust: trust('partial'),
      coverageCaveat: 'Flow family not retrieved',
      disclosure: 'offline only',
    });
    expect(envelope.claims).toHaveLength(1);
    expect(envelope.claims[0]?.claim).toBe('cascade deletes children');
    expect(envelope.evidence.map((e) => e.componentId)).toEqual([
      'CustomObject:Account',
      'CustomField:Account.Parent__c',
    ]);
    expect(envelope.coverage).toEqual({
      status: 'partial',
      message: 'Flow family not retrieved',
    });
    expect(envelope.disclosure).toBe('offline only');
  });

  it('buildSafeToDeleteEvidenceEnvelope maps safe to unknown (not proven-none)', () => {
    const safe = buildSafeToDeleteEvidenceEnvelope({
      fieldId: 'CustomField:Account.Unused__c',
      verdict: 'safe',
      reasoning: [],
      trust: trust('complete'),
    });
    expect(safe.absence?.status).toBe('unknown');
    expect(safe.absence?.verdict).toBe('safe');
    expect(safe.absence?.note).toMatch(/not a proven-none claim/i);

    const partial = buildSafeToDeleteEvidenceEnvelope({
      fieldId: 'CustomField:Account.Unused__c',
      verdict: 'review',
      reasoning: [],
      coverageCaveat: {
        status: 'partial',
        missingCoverage: ['Flow'],
        message: 'Flow not retrieved',
      },
      trust: {
        ...trust('partial'),
        completeness: { status: 'partial', missingCoverage: ['Flow'] },
      },
    });
    expect(partial.absence?.status).toBe('not-checked');
    expect(partial.coverage.message).toBe('Flow not retrieved');
  });

  it('buildSafeToDeleteEvidenceEnvelope lifts reasoning examples into evidence', () => {
    const envelope = buildSafeToDeleteEvidenceEnvelope({
      fieldId: 'CustomField:Account.Status__c',
      verdict: 'blocking',
      reasoning: [
        {
          category: 'flow',
          verdict: 'blocking',
          count: 1,
          examples: [{ id: 'Flow:Update_Account' }],
          note: 'Referenced by an active Flow',
        },
      ],
      trust: trust('complete'),
    });
    expect(envelope.claims[0]?.claim).toBe('Referenced by an active Flow');
    expect(envelope.evidence).toEqual([
      { componentId: 'CustomField:Account.Status__c', role: 'target' },
      {
        componentId: 'Flow:Update_Account',
        role: 'flow',
        note: 'category verdict: blocking (count 1)',
      },
    ]);
    expect(envelope.absence?.status).toBe('unknown');
  });
});

/**
 * ENVELOPEVERSION-DUPLICATED-LITERAL.
 *
 * `envelopeVersion` is NOT a per-tool field: the v2 envelope is opt-in and is
 * constructed ONLY in `evidence-envelope.ts`, for `sfi.interpret` and
 * `sfi.safe_to_delete_field`. That centralisation is correct and is left alone.
 * What was NOT centralised is the version NUMBER itself: it was a bare `2` in
 * three independent places inside the module — both builders plus the
 * fail-closed assertion that validates their output — so a bump had to be
 * applied three times in lockstep, and a half-applied bump would make the
 * module reject envelopes it had just built.
 *
 * These assertions pin the single-constant arrangement. The emitted value is
 * unchanged, so no tool's output moves; what changes is that it can only be
 * changed in one place.
 */
describe('ENVELOPEVERSION-DUPLICATED-LITERAL — one constant, no stray literals', () => {
  const moduleSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'tools',
      'evidence-envelope.ts',
    ),
    'utf8',
  );

  it('both builders emit the shared constant, not a bare literal', () => {
    // FAIL-BEFORE: two `envelopeVersion: 2,` object literals lived here.
    expect(moduleSource).not.toMatch(/envelopeVersion:\s*\d/);
    const uses = moduleSource.match(/envelopeVersion: EVIDENCE_ENVELOPE_VERSION,/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('the fail-closed assert validates against the SAME constant', () => {
    // FAIL-BEFORE: the guard compared against its own hardcoded `!== 2`, so it
    // could silently disagree with the builders after a partial bump.
    expect(moduleSource).toContain(
      'if (value.envelopeVersion !== EVIDENCE_ENVELOPE_VERSION)',
    );
  });

  it('the constant is still 2 — this is a refactor, not a version bump', () => {
    expect(EVIDENCE_ENVELOPE_VERSION).toBe(2);
  });

  it('every envelope the module builds carries the constant', () => {
    const interpret = buildInterpretEvidenceEnvelope({
      interpretations: [],
      trust: trust('complete'),
      disclosure: 'test disclosure',
    });
    const del = buildSafeToDeleteEvidenceEnvelope({
      fieldId: 'CustomField:Account.Test__c',
      verdict: 'safe',
      reasoning: [],
      trust: trust('complete'),
    });
    expect(interpret.envelopeVersion).toBe(EVIDENCE_ENVELOPE_VERSION);
    expect(del.envelopeVersion).toBe(EVIDENCE_ENVELOPE_VERSION);
  });
});
