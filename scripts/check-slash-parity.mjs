#!/usr/bin/env node
/**
 * P11-slash-commands — CI parity guard between the Claude Code `/sfi-*` slash
 * commands (`.claude/commands/sfi-*.md`) and the `sfi` CLI.
 *
 * The slash commands are thin wrappers: each one instructs the agent to run one
 * or more `sfi <subcommand>` invocations. The real drift risk is a CLI command
 * being renamed or removed while its slash wrapper keeps telling the agent to
 * run the old name — a break that ships silently. This guard FAILS (exit 1) when
 * any `sfi <subcommand>` referenced by a slash command is not a registered CLI
 * command, and when a slash file's own name maps to neither a CLI command nor an
 * allow-listed composite wizard.
 *
 * It also prints (without failing) the CLI commands that have no slash wrapper —
 * advanced commands like `mcp` / `snapshot` / `register-vault` intentionally
 * don't get one, so that list is informational, not a gate.
 *
 * Run: `pnpm check:slash-parity` (exit 0 = in parity).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProgram } from '../packages/cli/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// SFI_SLASH_COMMANDS_DIR overrides the scanned directory (tests point it at a
// fixture); defaults to the product's own slash commands.
const commandsDir = process.env.SFI_SLASH_COMMANDS_DIR ?? join(root, '.claude/commands');

/**
 * Slash commands that legitimately do NOT map 1:1 to a single CLI subcommand —
 * composite first-run wizards that chain several real `sfi` commands. Their
 * referenced `sfi <subcommand>` calls are still parity-checked below.
 */
const COMPOSITE_SLASH = new Set(['onboard']);

// 1. The real CLI subcommands (commander is the source of truth).
const cliCommands = new Set(createProgram().commands.map((c) => c.name()));

// 2. Each slash file + the `sfi <subcommand>` invocations it references.
//    Match both inline code (`sfi init`) and fenced/leading-line forms
//    (`sfi refresh --no-pull`), taking the first word after `sfi`.
const SUBCOMMAND_RE = /(?:^|[`\s])sfi\s+([a-z][a-z-]+)/gm;
const slashFiles = readdirSync(commandsDir)
  .filter((f) => /^sfi-.*\.md$/.test(f))
  .sort();

const problems = [];
const referenced = new Set();
const wrappedByName = new Set();

for (const file of slashFiles) {
  const slashName = file.replace(/^sfi-/, '').replace(/\.md$/, ''); // sfi-init.md -> init
  // The slash file's own name must be a CLI command or an allow-listed composite.
  if (!cliCommands.has(slashName) && !COMPOSITE_SLASH.has(slashName)) {
    problems.push(
      `${file}: /sfi-${slashName} maps to neither a CLI command nor an allow-listed composite wizard`,
    );
  } else if (cliCommands.has(slashName)) {
    wrappedByName.add(slashName);
  }

  const text = readFileSync(join(commandsDir, file), 'utf8');
  for (const m of text.matchAll(SUBCOMMAND_RE)) {
    const sub = m[1];
    referenced.add(sub);
    if (!cliCommands.has(sub)) {
      problems.push(`${file}: references \`sfi ${sub}\`, which is not a registered CLI command`);
    }
  }
}

// 3. Report.
console.log('slash ↔ CLI parity');
console.log(`  CLI commands:      ${[...cliCommands].sort().join(', ')}`);
console.log(`  slash commands:    ${slashFiles.map((f) => `/${f.replace(/\.md$/, '')}`).join(', ')}`);
console.log(`  referenced via sfi: ${[...referenced].sort().join(', ')}`);
const unwrapped = [...cliCommands].filter((c) => !wrappedByName.has(c)).sort();
console.log(`  CLI commands with no slash wrapper (informational): ${unwrapped.join(', ') || '(none)'}`);

if (problems.length > 0) {
  console.error('\nslash/CLI parity FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nOK — every slash command and its `sfi` invocations map to real CLI commands.');
