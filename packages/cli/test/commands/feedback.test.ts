/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFeedbackExport,
  recordFeedback,
  scrubText,
} from '../../src/commands/feedback.js';

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-feedback-'));

describe('scrubText', () => {
  it('redacts emails, URLs, and Salesforce record ids but keeps component/api names', () => {
    expect(scrubText('email me@acme.com about it')).toContain('[email]');
    expect(scrubText('see https://acme.my.salesforce.com/x')).toContain('[url]');
    expect(scrubText('record 0015000001abcEFAAY here')).toContain('[id]');
    // A component / api name is NOT PII — it stays.
    const kept = scrubText('where is Account.Industry__c used');
    expect(kept).toContain('Account.Industry__c');
  });
});

describe('recordFeedback + buildFeedbackExport', () => {
  it('records a rating locally and exports it scrubbed alongside the route gaps', async () => {
    const dir = await tmp();
    try {
      const feedbackPath = join(dir, 'feedback.jsonl');
      const gapPath = join(dir, 'gaps.jsonl');
      await writeFile(
        gapPath,
        `${JSON.stringify({ at: 'x', question: 'who can see records owned by admin@acme.com', category: 'folder-access', intent: 'unrouted' })}\n`,
        'utf8',
      );
      expect(await recordFeedback('the SSN answer was off for https://acme.my.salesforce.com', 'wrong', feedbackPath)).toBe(true);

      const exp = await buildFeedbackExport({ gapPath, feedbackPath, all: true });
      expect(exp.counts.routeGaps).toBe(1);
      expect(exp.counts.ratings).toBe(1);
      // The route gap keeps its category/intent (the routing signal).
      expect(exp.routeGaps[0]?.category).toBe('folder-access');
      // PII is scrubbed from BOTH the gap and the rating questions.
      const blob = JSON.stringify(exp);
      expect(blob).not.toMatch(/admin@acme\.com/);
      expect(blob).not.toMatch(/acme\.my\.salesforce\.com/);
      expect(blob).toContain('[email]');
      expect(exp.ratings[0]?.rating).toBe('wrong');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty export (never throws) when no logs exist', async () => {
    const dir = await tmp();
    try {
      const exp = await buildFeedbackExport({ gapPath: join(dir, 'none.jsonl'), feedbackPath: join(dir, 'none2.jsonl') });
      expect(exp.counts).toEqual({ routeGaps: 0, ratings: 0, routeGapsExcludedByScope: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // P14-FEEDBACK-gaplog-scope (FINDINGS P-GAPLOG-GLOBAL): the gap log file is
  // machine-global, so the EXPORT must scope to one vault — an export from
  // vault A may never contain vault B's question text.
  it('scopes the export to the given vault: other vaults and unstamped legacy entries are excluded', async () => {
    const dir = await tmp();
    try {
      const gapPath = join(dir, 'gaps.jsonl');
      const lines = [
        JSON.stringify({ at: 'x', question: 'vault A question', category: 'unrouted', intent: 'unrouted', vaultRoot: '/work/a/org-kb' }),
        JSON.stringify({ at: 'x', question: 'vault B secret component question', category: 'unrouted', intent: 'unrouted', vaultRoot: '/work/b/org-kb' }),
        JSON.stringify({ at: 'x', question: 'legacy unstamped question', category: 'unrouted', intent: 'unrouted' }),
      ];
      await writeFile(gapPath, `${lines.join('\n')}\n`, 'utf8');

      const scoped = await buildFeedbackExport({
        gapPath,
        feedbackPath: join(dir, 'none.jsonl'),
        vaultRoot: '/work/a/org-kb',
      });
      expect(scoped.counts.routeGaps).toBe(1);
      expect(scoped.counts.routeGapsExcludedByScope).toBe(2);
      const blob = JSON.stringify(scoped);
      expect(blob).toContain('vault A question');
      expect(blob).not.toContain('vault B secret');
      expect(blob).not.toContain('legacy unstamped');

      // --all restores the whole-machine export (review-before-share path).
      const all = await buildFeedbackExport({
        gapPath,
        feedbackPath: join(dir, 'none.jsonl'),
        vaultRoot: '/work/a/org-kb',
        all: true,
      });
      expect(all.counts.routeGaps).toBe(3);
      expect(all.counts.routeGapsExcludedByScope).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
