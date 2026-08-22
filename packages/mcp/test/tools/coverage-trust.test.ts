/// <reference types="vitest/globals" />

import type { CoverageEntry, VaultManifest } from '@sf-intelligence/contracts';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import {
  buildCoverageCaveat,
  VALUE_LITERAL_READER_COVERAGE,
} from '../../src/tools/coverage-trust.js';

/**
 * FIX-3 (coverage-spine): `ConditionalContext` is a SYNTHETIC node type the
 * extractor MINTS while parsing a declarative firer's condition (Flow decision,
 * WorkflowRule criteria, …) — never a Salesforce metadata family `sf project
 * retrieve` pulls. Nothing in `buildCoverageEntries` ever writes it a coverage
 * row (measured on a real 96-row vault manifest: zero rows, ever), so listing
 * it as a REQUIRED coverage family made `VALUE_LITERAL_READER_COVERAGE`
 * permanently, unfalsifiably incomplete — even a vault whose every real,
 * retrievable dependency family landed cleanly still read as "coverage
 * unknown" for `ConditionalContext`, because no code path could ever satisfy
 * that requirement.
 *
 * The chosen fix: `ConditionalContext`'s only real coverage signal is its
 * PARENT FIRER types' retrieval (WorkflowRule / ValidationRule / ApprovalProcess
 * / AutoResponseRule / AssignmentRule / EscalationRule / Flow — the same seven
 * the `firesWhen` edge type and the concept model's `ConditionalContext` binds
 * already name) — a condition can only be missed if the firer that carries it
 * was never retrieved. So `ConditionalContext` itself is dropped from the
 * required-coverage list and its real parent families are named instead,
 * preserving the actual signal instead of a phantom one.
 */
describe('VALUE_LITERAL_READER_COVERAGE (FIX-3: ConditionalContext is synthetic, not retrieved)', () => {
  it('does not name the synthetic ConditionalContext type as a required coverage family', () => {
    expect(VALUE_LITERAL_READER_COVERAGE).not.toContain('ConditionalContext');
  });

  it('names every real ConditionalContext-producing firer family instead', () => {
    // The exact seven `firesWhen` producers (contracts.ts EdgeType doc +
    // concept-model.ts ConditionalContext binds) — a condition hidden inside
    // any of them is invisible if that firer type was not retrieved.
    for (const firer of [
      'WorkflowRule',
      'ValidationRule',
      'ApprovalProcess',
      'AutoResponseRule',
      'AssignmentRule',
      'EscalationRule',
      'Flow',
    ]) {
      expect(VALUE_LITERAL_READER_COVERAGE).toContain(firer);
    }
  });

  const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
    types.map((type) => ({
      type,
      requested: true,
      retrieved: 1,
      errored: false,
      neverModeled: false,
    }));

  const contextWith = (coverage: readonly CoverageEntry[]): Context => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-22T00:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:fixture',
      coverageComputedAt: '2026-08-22T00:00:00.000Z',
      coverage,
    };
    return {
      vaultRoot: '/tmp/not-used',
      manifest,
      graph: {} as Context['graph'],
      liveCapability: mintLiveCapability('opt-in'),
    };
  };

  // The REAL shape a fully-covered vault manifest has: a row for every family
  // the retrieve actually touches. Every element of VALUE_LITERAL_READER_COVERAGE
  // now qualifies — `ConditionalContext` is provably absent from it (asserted
  // above), so there is no synthetic type left to special-case out.
  const REAL_VAULT_FULLY_COVERED = completeCoverage([...VALUE_LITERAL_READER_COVERAGE]);

  it('a vault fully covered on every REAL family reads complete — no phantom caveat', () => {
    const ctx = contextWith(REAL_VAULT_FULLY_COVERED);
    const caveat = buildCoverageCaveat(
      ctx,
      [...VALUE_LITERAL_READER_COVERAGE],
      'Deletion safety',
    );
    expect(caveat).toBeUndefined();
  });

  it('a real coverage gap (a genuine firer family not retrieved) still fires the caveat', () => {
    const ctx = contextWith(
      completeCoverage(
        (VALUE_LITERAL_READER_COVERAGE as readonly string[]).filter(
          (t) => t !== 'ApprovalProcess',
        ),
      ),
    );
    const caveat = buildCoverageCaveat(
      ctx,
      [...VALUE_LITERAL_READER_COVERAGE],
      'Deletion safety',
    );
    expect(caveat).toBeDefined();
    expect(caveat?.missingCoverage).toContain('ApprovalProcess');
    expect(caveat?.missingCoverage).not.toContain('ConditionalContext');
  });
});
