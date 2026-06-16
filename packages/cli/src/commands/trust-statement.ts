/**
 * The first question any enterprise tester asks before pointing a new tool at
 * their Salesforce org is "what is this going to DO to my org?" This is the
 * loud, one-screen answer, printed at the end of `sfi init` and mirrored on the
 * website. Every line is a guarantee the product actually enforces elsewhere in
 * the codebase (read-only retrieve, offline vault, opt-in live plane, the
 * `files` publish whitelist + leak audit) — keep them in lockstep.
 */

/** The five standing guarantees, each a `(headline, detail)` pair. */
export const TRUST_GUARANTEES: ReadonlyArray<{ readonly headline: string; readonly detail: string }> = [
  {
    headline: 'READ-ONLY to your org',
    detail:
      'sf-intelligence never writes, deploys, or modifies anything in Salesforce. ' +
      'It only RETRIEVES metadata (`sf project retrieve`). No create, no update, no delete.',
  },
  {
    headline: 'OFFLINE by default',
    detail:
      'Every answer comes from the local vault built at the last refresh — not a live call. ' +
      'The org is contacted only when you run `sfi refresh`.',
  },
  {
    headline: 'LOCAL & private',
    detail:
      'The vault lives on THIS machine (org-kb/) and is never uploaded anywhere. ' +
      'No telemetry, no phone-home — feedback (`sfi feedback`) is captured locally and shared only if you choose to.',
  },
  {
    headline: 'Live plane is OFF until you turn it on',
    detail:
      'The opt-in live read-only plane (capped record counts/samples) stays disabled until you set ' +
      'SFI_LIVE_PLANE_ENABLED=1 (or `sfi.live_consent`). Even enabled it is READ-ONLY and runs only a curated query roster — never arbitrary SOQL, never a write.',
  },
  {
    headline: 'The npm package ships NO org data',
    detail:
      'The published package contains only code (a `files` whitelist blocks the vault/source/snapshots). ' +
      'Every public version has been downloaded and grepped clean of org identifiers (the leak audit).',
  },
];

/** Render the trust statement as a boxed, one-screen terminal notice. */
export const formatTrustStatement = (): string => {
  const lines: string[] = [];
  lines.push('');
  lines.push('  ┌─ What sf-intelligence does (and does NOT) to your org ─────────────');
  lines.push('  │');
  for (const g of TRUST_GUARANTEES) {
    lines.push(`  │  ✓ ${g.headline}`);
    for (const wrapped of wrap(g.detail, 64)) {
      lines.push(`  │      ${wrapped}`);
    }
    lines.push('  │');
  }
  lines.push('  └────────────────────────────────────────────────────────────────────');
  lines.push('');
  return lines.join('\n');
};

/** Soft-wrap `text` to at most `width` columns on word boundaries. */
const wrap = (text: string, width: number): string[] => {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
};
