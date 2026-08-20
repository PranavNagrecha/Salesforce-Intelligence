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
 * PRESENT in the advertised descriptions that carry it, and ABSENT from every
 * indexed document. A host must still read the caveat; the funnel must not.
 */
import { describe, expect, it } from 'vitest';

import { buildToolDocs } from '../../src/semantic-funnel.js';
import {
  CORPUS_BOILERPLATE_MARKERS,
  stripCorpusBoilerplate,
} from '../../src/tools/corpus-boilerplate.js';
import { V01_TOOLS } from '../../src/tools/index.js';

describe('repeated boilerplate reaches hosts but never the retrieval corpus', () => {
  it('every marker is carried by at least one ADVERTISED description', () => {
    for (const marker of CORPUS_BOILERPLATE_MARKERS) {
      const carriers = V01_TOOLS.filter((t) =>
        (t.description ?? '').includes(marker),
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
      (t) =>
        !CORPUS_BOILERPLATE_MARKERS.some((m) => (t.description ?? '').includes(m)),
    );
    expect(clean.length).toBeGreaterThan(0);
    for (const t of clean) {
      expect(stripCorpusBoilerplate(t.description ?? '')).toBe(t.description ?? '');
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
    const carrier = V01_TOOLS.find((t) => (t.description ?? '').includes(marker));
    expect(carrier).toBeDefined();
    const full = carrier?.description ?? '';
    const stripped = stripCorpusBoilerplate(full);
    expect(stripped.length).toBeLessThan(full.length);
    expect(stripped).toBe(full.slice(0, full.indexOf(marker)).trimEnd());
    expect(stripped).not.toContain(marker);
  });
});
