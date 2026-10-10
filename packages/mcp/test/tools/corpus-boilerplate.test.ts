/// <reference types="vitest/globals" />

/**
 * CORPUS-BOILERPLATE-POLLUTES-IDF.
 *
 * `tool.description` is BOTH the host-facing contract and the funnel's
 * retrieval document. A block repeated verbatim across N tools is ideal for a
 * reader and poison for retrieval: it depresses the document frequency of every
 * term it contains, for every tool in the corpus.
 *
 * Two measured regressions motivate the strip, and this file pins both:
 *
 *  1. A declared-only permission WARNING on four tools broke FOUR routing
 *     tests, including `sfi.org_card` — a tool the change never touched.
 *  2. A `conceptReasoning` block on four component-anchored tools displaced
 *     `sfi.interpret` from a top-5 recall assertion by 0.0010 of a score point.
 *     NEITHER parent branch failed alone; only the merge did. That is the
 *     dangerous shape: two individually-correct changes that are jointly wrong,
 *     invisible to both branches' green gates.
 *
 * The invariant is one-directional and must stay that way: every marker is
 * PRESENT in the long-form text that carries it, and ABSENT from every indexed
 * document. A host must still be able to read the caveat; the funnel must not.
 *
 * The long-form text is `retrievalDocument(tool)`: a tool's `reference` when it
 * has one (the core tools, whose advertised `description` is the short
 * contract and whose long form `sfi.describe_analysis {detail:'full'}`
 * serves), else its `description`.
 */
import { describe, expect, it } from 'vitest';

import { buildToolDocs } from '../../src/semantic-funnel.js';
import {
  CORPUS_BOILERPLATE_MARKERS,
  stripCorpusBoilerplate,
} from '../../src/tools/corpus-boilerplate.js';
import { V01_TOOLS, advertisedTools, retrievalDocument } from '../../src/tools/index.js';

describe('repeated boilerplate reaches hosts but never the retrieval corpus', () => {
  it('every marker is carried by at least one long-form tool text', () => {
    for (const marker of CORPUS_BOILERPLATE_MARKERS) {
      const carriers = V01_TOOLS.filter((t) =>
        retrievalDocument(t).includes(marker),
      );
      // A marker nobody carries is dead config — it would strip nothing and
      // silently rot, which is how the drift this repo keeps fixing begins.
      expect(
        carriers.length,
        `no advertised description carries marker: ${marker.slice(0, 48)}…`,
      ).toBeGreaterThan(0);
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: no marker survives into any indexed document', () => {
    const docs = buildToolDocs();
    for (const marker of CORPUS_BOILERPLATE_MARKERS) {
      for (const [tool, doc] of docs) {
        expect(
          doc.includes(marker),
          `${tool} indexed a boilerplate marker: ${marker.slice(0, 48)}…`,
        ).toBe(false);
      }
    }
  });

  it('a description carrying no boilerplate is returned BYTE-IDENTICAL', () => {
    // The strip must be incapable of perturbing a tool it does not target.
    const clean = V01_TOOLS.filter(
      (t) => !CORPUS_BOILERPLATE_MARKERS.some((m) => retrievalDocument(t).includes(m)),
    );
    expect(clean.length).toBeGreaterThan(0);
    for (const t of clean) {
      expect(stripCorpusBoilerplate(retrievalDocument(t))).toBe(retrievalDocument(t));
    }
  });

  it('no short advertised core description carries a boilerplate block', () => {
    // The core descriptions are the per-session token budget: a repeated
    // block belongs in `reference`, which the host reads only on request.
    for (const t of advertisedTools('core')) {
      for (const marker of CORPUS_BOILERPLATE_MARKERS) {
        expect(t.description.includes(marker), `${t.name}: ${marker.slice(0, 40)}…`).toBe(false);
      }
    }
  });

  it('a half-matched bounded rule leaves the text ALONE rather than truncating', () => {
    // A bounded rule whose marker appears but whose tail does not must not eat
    // the rest of the description — silently deleting real capability prose is
    // worse than leaving boilerplate indexed.
    const bounded = CORPUS_BOILERPLATE_MARKERS[0] as string;
    const text = `Real capability prose.${bounded}truncated mid-rule with no closing tail`;
    expect(stripCorpusBoilerplate(text)).toBe(text);
  });

  it('strips only the boilerplate, preserving the prose that precedes it', () => {
    const marker = 'Every response also carries `conceptReasoning`';
    const carrier = V01_TOOLS.find((t) => retrievalDocument(t).includes(marker));
    expect(carrier).toBeDefined();
    const full = carrier === undefined ? '' : retrievalDocument(carrier);
    const stripped = stripCorpusBoilerplate(full);
    expect(stripped.length).toBeLessThan(full.length);
    expect(stripped).toBe(full.slice(0, full.indexOf(marker)).trimEnd());
    expect(stripped).not.toContain(marker);
  });
});
