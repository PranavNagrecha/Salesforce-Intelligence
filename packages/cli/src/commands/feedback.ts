import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { gapLogPath } from '@sf-intelligence/mcp';
import { Command } from 'commander';

/** Issues channel — surfaced in doctor / README / website so feedback has a home. */
export const FEEDBACK_ISSUES_URL = 'https://github.com/PranavNagrecha/Salesforce-Intelligence/issues';

/** Local ratings log. `SFI_FEEDBACK_LOG_PATH` overrides (tests). Local-only. */
export const feedbackLogPath = (): string =>
  process.env['SFI_FEEDBACK_LOG_PATH'] ?? join(homedir(), '.sf-intelligence', 'feedback.jsonl');

export type FeedbackRating = 'wrong' | 'weak';

export interface FeedbackEntry {
  readonly at: string;
  readonly question: string;
  readonly rating: FeedbackRating;
}

/** Record a one-key "this answer was wrong/weak" marker locally (best-effort). */
export const recordFeedback = async (
  question: string,
  rating: FeedbackRating,
  path: string = feedbackLogPath(),
): Promise<boolean> => {
  const entry: FeedbackEntry = { at: new Date().toISOString(), question, rating };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
};

/**
 * Scrub a free-text question of obvious org PII before export: emails, URLs, and
 * Salesforce 15/18-char record ids. Component/api names are NOT PII and are kept
 * (they're the signal that makes the feedback useful).
 */
export const scrubText = (s: string): string =>
  s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g, (m) => (/^[0-9a-zA-Z]+$/.test(m) && /[0-9]/.test(m) && /[a-zA-Z]/.test(m) ? '[id]' : m));

const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip a garbled line */
    }
  }
  return out;
};

export interface FeedbackExport {
  readonly generatedAt: string;
  readonly routeGaps: ReadonlyArray<{ question: string; category: string; intent: string }>;
  readonly ratings: ReadonlyArray<{ question: string; rating: string }>;
  readonly counts: {
    readonly routeGaps: number;
    readonly ratings: number;
    /**
     * Gap entries DROPPED by vault scoping (other vaults' gaps + unstamped
     * pre-0.1.10 entries). Surfaced so a small export never silently reads
     * as "that's all the gaps this machine has" (P14-FEEDBACK-gaplog-scope).
     */
    readonly routeGapsExcludedByScope: number;
  };
}

/**
 * Build the scrubbed, shareable export from the local gap + ratings logs.
 *
 * SCOPING (P14-FEEDBACK-gaplog-scope / FINDINGS P-GAPLOG-GLOBAL): the gap log
 * FILE is machine-global, but question text routinely names org-specific
 * components — a multi-org machine must not bundle every org's questions into
 * one shareable file. Entries are stamped with their vault at log time; by
 * default only gaps stamped with `opts.vaultRoot` are exported, and unstamped
 * legacy entries are excluded. `all: true` restores the whole-machine export
 * (review it before sharing). Ratings are NOT scoped — `feedback mark` is a
 * deliberate, user-authored act on this machine.
 */
export const buildFeedbackExport = async (opts?: {
  gapPath?: string;
  feedbackPath?: string;
  vaultRoot?: string;
  all?: boolean;
}): Promise<FeedbackExport> => {
  const allGaps = await readJsonl(opts?.gapPath ?? gapLogPath());
  const gaps =
    opts?.all === true
      ? allGaps
      : allGaps.filter(
          (g) =>
            typeof g['vaultRoot'] === 'string' &&
            opts?.vaultRoot !== undefined &&
            g['vaultRoot'] === opts.vaultRoot,
        );
  const ratings = await readJsonl(opts?.feedbackPath ?? feedbackLogPath());
  return {
    generatedAt: new Date().toISOString(),
    routeGaps: gaps.map((g) => ({
      question: scrubText(String(g['question'] ?? '')),
      category: String(g['category'] ?? 'unknown'),
      intent: String(g['intent'] ?? 'unknown'),
    })),
    ratings: ratings.map((r) => ({
      question: scrubText(String(r['question'] ?? '')),
      rating: String(r['rating'] ?? ''),
    })),
    counts: {
      routeGaps: gaps.length,
      ratings: ratings.length,
      routeGapsExcludedByScope: allGaps.length - gaps.length,
    },
  };
};

/** Register the `sfi feedback` subcommand (mark + export). Local-only, no phone-home. */
export const registerFeedbackCommand = (program: Command): void => {
  const feedback = program
    .command('feedback')
    .description('Local-only feedback: mark a weak/wrong answer, or export a scrubbed file to share');

  feedback
    .command('mark <question>')
    .description('Record that an answer to <question> was wrong or weak (stored locally)')
    .option('--wrong', 'the answer was wrong')
    .option('--weak', 'the answer was weak/incomplete')
    .action(async (question: string, flags: { wrong?: boolean; weak?: boolean }): Promise<void> => {
      const rating: FeedbackRating = flags.wrong ? 'wrong' : 'weak';
      const ok = await recordFeedback(question, rating);
      process.stdout.write(
        ok
          ? `Recorded (${rating}), locally only. Export with \`sfi feedback export\`; nothing leaves your machine.\n`
          : 'Could not write the local feedback log.\n',
      );
    });

  feedback
    .command('export')
    .description(
      'Write a scrubbed, shareable feedback file (route gaps + ratings) — no org PII, nothing uploaded. Gaps are scoped to the CURRENT vault by default; --all exports the whole machine-global log (review before sharing on a multi-org machine).',
    )
    .option('--out <file>', 'output path', 'sfi-feedback.json')
    .option('--all', 'include every vault\'s gaps + unstamped pre-0.1.10 entries (machine-global)')
    .action(async (flags: { out: string; all?: boolean }): Promise<void> => {
      const vaultRoot = resolve(process.cwd(), 'org-kb');
      const data = await buildFeedbackExport({
        vaultRoot,
        ...(flags.all === true ? { all: true } : {}),
      });
      // An all-zero export is a meaningless file — say so instead of writing
      // one the user then shares expecting it to carry signal.
      if (data.counts.routeGaps === 0 && data.counts.ratings === 0) {
        process.stdout.write(
          'Nothing to export yet — no route gaps or ratings are logged for this vault.\n' +
            (data.counts.routeGapsExcludedByScope > 0
              ? `(${data.counts.routeGapsExcludedByScope} gap(s) from other vaults / older versions exist — \`--all\` exports the machine-global log; review it before sharing.)\n`
              : 'Mark a weak answer first: `sfi feedback mark "<question>" --wrong` (or `--weak`).\n'),
        );
        return;
      }
      const out = resolve(process.cwd(), flags.out);
      try {
        await writeFile(out, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      } catch (cause) {
        process.stderr.write(
          `Could not write ${out}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
            'Pick a writable path with `--out <file>`.\n',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `Wrote ${out} — ${data.counts.routeGaps} route gap(s) + ${data.counts.ratings} rating(s), scrubbed.\n` +
          (data.counts.routeGapsExcludedByScope > 0 && flags.all !== true
            ? `(${data.counts.routeGapsExcludedByScope} gap(s) from other vaults / older versions were EXCLUDED — \`--all\` includes them.)\n`
            : '') +
          `Share it on ${FEEDBACK_ISSUES_URL} to turn your test into a roadmap.\n`,
      );
    });
};
