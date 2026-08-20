/// <reference types="vitest/globals" />

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REPORT_DASHBOARD_NODE_CAP,
  PERSISTED_ANALYTICS_EDGE_PROPERTY_KEYS,
  PERSISTED_DASHBOARD_PROPERTY_KEYS,
  PERSISTED_REPORT_PROPERTY_KEYS,
} from '../src/refresh-pipeline.js';

/**
 * REPORT-DASHBOARD-GRAPH-PERSISTENCE — doc-parity guard.
 *
 * A skill file is not documentation, it is INSTRUCTION: whatever it says, the
 * assistant will say to a user and act on. Two false claims shipped in
 * `developer-field-deep-dive` past a green gate — the cap default stated as
 * 1000 when it is 5000, and "`references` edges to their fields" promising the
 * exact report -> field edge layer this design deliberately REJECTED. Both
 * `doc-sync` and `skill-gateway` passed, because neither cross-checks a skill's
 * factual assertions against the code they describe. Nothing did. Hence this.
 *
 * Two directions, because both failure modes actually occurred:
 *   1. a number stated in prose must equal the constant it names;
 *   2. a capability the code does NOT provide must not be promised.
 *
 * Hermetic: reads repo files, no org, no network.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKILLS = [
  '.claude/skills/developer-field-deep-dive/SKILL.md',
  '.claude/skills/business-user-orientation/SKILL.md',
] as const;

const readDoc = async (rel: string): Promise<string> =>
  readFile(join(REPO_ROOT, rel), 'utf8');

/**
 * Markdown-blockquote-safe prose view of a doc. The skills wrap these passages
 * in `>` quote markers, and a leading `>` lands mid-phrase once lines are
 * joined ("edges > to their fields"), which silently defeats any `\s+`-based
 * phrase match — this guard's first draft missed a reintroduced defect for
 * exactly that reason. Strip the markers, then collapse whitespace.
 */
const prose = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/^\s*>+\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');

describe('report/dashboard persistence — skill + docs must not outrun the code', () => {
  it('every doc that names SFI_REPORT_NODE_CAP states the REAL default', async () => {
    for (const rel of [...SKILLS, 'docs/configuration.md']) {
      const text = await readDoc(rel);
      if (!text.includes('SFI_REPORT_NODE_CAP')) continue;
      // The stated default must be the constant, and no OTHER plausible cap
      // number may appear in the same sentence-ish window.
      expect(
        text.includes(String(DEFAULT_REPORT_DASHBOARD_NODE_CAP)),
        `${rel} names SFI_REPORT_NODE_CAP but never states its real default ${DEFAULT_REPORT_DASHBOARD_NODE_CAP}`,
      ).toBe(true);
      for (const window of text.split(/\n\n+/)) {
        if (!window.includes('SFI_REPORT_NODE_CAP')) continue;
        const stated = [...window.matchAll(/default\s+`?(\d{3,})`?/gi)].map((m) => m[1]);
        for (const n of stated) {
          expect(
            Number(n),
            `${rel} states cap default ${n}; the constant is ${DEFAULT_REPORT_DASHBOARD_NODE_CAP}`,
          ).toBe(DEFAULT_REPORT_DASHBOARD_NODE_CAP);
        }
      }
    }
  });

  it('no doc promises a report/dashboard -> FIELD edge (the rejected layer)', async () => {
    // The measured decision: analytics -> CustomField edges were ~94% of the
    // persisted rows for an answer the folded property already gives, so they
    // are NOT persisted. A doc that promises them makes the assistant offer a
    // graph walk that returns nothing.
    const FORBIDDEN = [
      /`references`\s+edges?\s+to\s+their\s+fields/i,
      /edges?\s+to\s+(?:its|their)\s+(?:referenced\s+)?fields/i,
      /report\s*->\s*field\s+edge/i,
    ];
    // Scope to a SENTENCE and skip sentences that explicitly DENY the edge —
    // the docs are required to say "there is NO report -> field edge", and a
    // guard that flags its own required denial is a guard nobody keeps.
    const DENIAL = /\b(no|not|never|without|rather than|instead of|deliberately)\b/i;
    for (const rel of SKILLS) {
      const text = await readDoc(rel);
      const sentences = prose(text).split(/(?<=[.;:])\s+/);
      for (const sentence of sentences) {
        if (DENIAL.test(sentence)) continue;
        for (const pattern of FORBIDDEN) {
          const hit = pattern.exec(sentence);
          expect(
            hit,
            `${rel} promises a report/dashboard -> field EDGE ("${hit?.[0] ?? ''}") in: ` +
              `"${sentence.slice(0, 160)}" — field usage is persisted as a node ` +
              'PROPERTY and never an edge.',
          ).toBeNull();
        }
      }
    }
  });

  it('the id shape stated in docs is LEAF-folder, never a full directory chain', async () => {
    // A full-chain id (`Report:Parent/Leaf/X`) is one no dashboard reference
    // and no retrieve member ever names — measured on a real org, it left 93
    // dashboard->report edges dangling against reports that WERE in the vault.
    for (const rel of [...SKILLS, 'docs/configuration.md']) {
      const text = await readDoc(rel);
      const ids = [...text.matchAll(/`(?:Report|Dashboard):\{([^}]*)\}/g)].map((m) => m[1]);
      for (const seg of ids) {
        expect(
          seg,
          `${rel} documents an id keyed on \`{${seg ?? ''}}\`; it must name the LEAF folder`,
        ).toMatch(/LeafFolder/);
      }
    }
  });

  it('the privacy allow-lists never admit a freeform-text key', async () => {
    // Belt-and-braces on the guarantee itself: if someone adds `description`,
    // `runningUser`, a filter `value`, or a `masterLabel` to an allow-list,
    // this fails before any vault is written.
    const FORBIDDEN_KEYS = [
      'description',
      'runningUser',
      'value',
      'values',
      'sourceValues',
      'masterLabel',
      'label',
      'name',
      'title',
    ];
    for (const [label, set] of [
      ['report node', PERSISTED_REPORT_PROPERTY_KEYS],
      ['dashboard node', PERSISTED_DASHBOARD_PROPERTY_KEYS],
      ['analytics edge', PERSISTED_ANALYTICS_EDGE_PROPERTY_KEYS],
    ] as const) {
      for (const key of FORBIDDEN_KEYS) {
        expect(set.has(key), `${label} allow-list admits freeform key \`${key}\``).toBe(false);
      }
    }
    // …and the presence boolean that REPLACED the text is still allowed, so
    // this guard can't be "satisfied" by deleting the capability.
    expect(PERSISTED_REPORT_PROPERTY_KEYS.has('descriptionPresent')).toBe(true);
    expect(PERSISTED_DASHBOARD_PROPERTY_KEYS.has('descriptionPresent')).toBe(true);
  });
});
