/// <reference types="vitest/globals" />

/**
 * THE HONESTY GATE — every tool in the roster, audited for the bug family
 * 0.3.2 was a public apology for.
 *
 * ## What this replaces
 *
 * `end-to-end.test.ts` already sweeps the roster, and already ends each call
 * with an assertion. That assertion rejects exactly two envelopes:
 * `not-implemented` and `unknown-tool`. A tool returning `{ totalCount: 0 }`
 * for an object that does not exist passes it clean — which is precisely the
 * shape that shipped seven times in 0.3.2. The gate built to catch the family
 * accepted the family.
 *
 * Two structural problems came with it:
 *
 *   1. Its roster is a HAND-WRITTEN array of `[toolName, args]` pairs. It
 *      lists 141 tools; `V01_TOOLS` holds 217. 76 tools — including
 *      `find_component_usages` and `who_can_access_object`, two of the seven
 *      0.3.2 archetypes — have never been swept at all. A hand-maintained
 *      roster silently stops covering anything added after it was written.
 *   2. Its fixture is the edu-org tree in the separate
 *      `sf-intelligence-builder` harness, which CI does not have. The sweep
 *      cannot run on any machine but a maintainer's.
 *
 * This file fixes both: the roster is DERIVED from `V01_TOOLS` (so a new tool
 * cannot be born uncovered) and the vault is `examples/demo-vault`, which is
 * git-tracked in full — DuckDB graph included — so the gate runs anywhere
 * vitest runs.
 *
 * ## VACUITY RISK of THIS file
 *
 * The laws themselves are defended in `envelope-honesty.ts`. The specific ways
 * this SWEEP could pass while asserting nothing, and what stops each:
 *
 *   (W1) **The vault goes missing and the suite skips.** `scan:leaks` passes
 *        when its gitignored config is absent; this must not. Defence:
 *        `resolveDemoVaultRoot()` THROWS. There is no `skipIf` in this file.
 *   (W2) **Argument derivation degrades until every call returns
 *        `invalid-query`.** Structured errors are honest, so a sweep whose
 *        every call errored would report zero findings and look green while
 *        auditing nothing. Defence: `it('actually reaches handlers')` asserts
 *        a floor on the number of calls that returned a `data` payload, and
 *        the per-law evaluation counters below assert the laws fired.
 *   (W3) **A law stops firing after a payload-shape change.** Defence: the
 *        anti-vacuity test asserts each law's evaluation count against a
 *        DERIVED denominator (payloads with data / tools advertising an object
 *        scope), not a magic number.
 *   (W4) **The backlog gets absorbed by an allowlist.** Defence: there is no
 *        allowlist in this file. Every currently-failing tool is named in the
 *        failure message. If the list shrinks, tools were fixed; if it is
 *        deleted, the gate was.
 *
 * ## This gate is RED, on purpose
 *
 * It fails today, naming every tool that breaks a law. That list is a defect
 * backlog, not a reason to soften the gate. House doctrine: do not weaken an
 * assertion to get green.
 */

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '../../packages/contracts/src/index.js';
import { listNodesByType } from '../../packages/graph/src/index.js';
import {
  buildContext,
  dispatchTool,
  shutdown,
  V01_TOOLS,
  type Context,
} from '../../packages/mcp/src/index.js';

import { resolveDemoVaultRoot, demoVaultTruthManifest } from './demo-vault-paths.js';
import {
  deriveArgs,
  deriveGhostScopeArgs,
  objectScopeKeys,
  sampleFromNodes,
  schemaProperties,
  GHOST_OBJECT,
  type VaultSample,
} from './derived-tool-args.js';
import {
  addChecks,
  auditEnvelope,
  auditScopeRefusal,
  formatFindings,
  NO_CHECKS,
  type HonestyChecks,
  type HonestyFinding,
} from './envelope-honesty.js';

/** Component types sampled to build real argument values. */
const SAMPLE_TYPES = [
  'ApexClass',
  'ApexTrigger',
  'CustomField',
  'CustomObject',
  'Flow',
  'PermissionSet',
  'Profile',
] as const;

/** One tool's response, parsed. */
interface SweepRow {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly envelope: Record<string, unknown>;
}

/** One tool's response to a deliberately unresolvable object scope. */
interface ScopeRow {
  readonly tool: string;
  readonly scopeKeys: readonly string[];
  readonly envelope: Record<string, unknown>;
}

const parseEnvelope = (
  content: readonly { type: string; text?: string }[],
): Record<string, unknown> => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as Record<string, unknown>;
};

const hasData = (envelope: Record<string, unknown>): boolean => {
  const data = envelope['data'];
  return data !== null && typeof data === 'object' && !Array.isArray(data);
};

let workdir = '';
let ctx: Context | null = null;
let sample: VaultSample | null = null;
let sweep: SweepRow[] = [];
let trimmedProbes: SweepRow[] = [];
let scopeProbes: ScopeRow[] = [];

beforeAll(async () => {
  // W1: throws if the vault is not there. No skip path.
  const demoVault = resolveDemoVaultRoot();

  // Copy before opening: DuckDB takes a write lock and may append a WAL, and
  // the demo vault is a TRACKED artefact. A test that dirties the working
  // tree it is asserting against is its own kind of dishonesty.
  workdir = await mkdtemp(join(tmpdir(), 'sfi-honesty-sweep-'));
  const vaultRoot = join(workdir, 'org-kb');
  await cp(demoVault, vaultRoot, { recursive: true });

  const built = await buildContext(vaultRoot);
  if (!built.ok) {
    throw new Error(`buildContext failed: ${built.error.kind} — ${built.error.message}`);
  }
  ctx = built.value;

  const byType = new Map<string, readonly Node[]>();
  for (const type of SAMPLE_TYPES) {
    const nodes = await listNodesByType(ctx.graph, type, { limit: 5 });
    byType.set(type, nodes.ok ? nodes.value : []);
  }
  sample = sampleFromNodes(byType, vaultRoot);

  // ONE dispatch pass over the derived roster, shared by every test below.
  sweep = [];
  for (const tool of V01_TOOLS) {
    const args = deriveArgs(tool, sample);
    const result = await dispatchTool(ctx, tool.name, args);
    sweep.push({ tool: tool.name, args, envelope: parseEnvelope(result.content) });
  }

  // A second pass for Law 2, and the sharpest probe in this file: re-call every
  // tool that advertises a `limit` with `limit: 1`.
  //
  // A payload only has to describe a trimmed page honestly once it has BEEN
  // trimmed, and a demo vault small enough to fit in git rarely trims anything
  // on default arguments. Forcing the smallest legal page is what turns "this
  // tool would lie about a trimmed page" from a code-reading exercise into an
  // observation. It is how `sfi.field_cleanup_candidates` was caught reporting
  // `truncated: false` while shipping 1 of 25 rows.
  //
  // `limit: 1` is derived, not chosen per tool: it is the minimum every one of
  // these schemas declares (`minimum: 1`).
  trimmedProbes = [];
  for (const tool of V01_TOOLS) {
    if (!('limit' in schemaProperties(tool.inputSchema))) continue;
    const args = { ...deriveArgs(tool, sample), limit: 1 };
    const result = await dispatchTool(ctx, tool.name, args);
    trimmedProbes.push({ tool: tool.name, args, envelope: parseEnvelope(result.content) });
  }

  // A third pass for Law 3: only the tools that advertise an object scope.
  scopeProbes = [];
  for (const tool of V01_TOOLS) {
    const scopeKeys = objectScopeKeys(tool);
    if (scopeKeys.length === 0) continue;
    const result = await dispatchTool(ctx, tool.name, deriveGhostScopeArgs(tool, sample));
    scopeProbes.push({ tool: tool.name, scopeKeys, envelope: parseEnvelope(result.content) });
  }
});

afterAll(async () => {
  if (ctx !== null) {
    await shutdown(ctx);
    ctx = null;
  }
  if (workdir.length > 0) {
    await rm(workdir, { recursive: true, force: true });
  }
});

describe('roster coverage is derived, not listed', () => {
  /**
   * The coverage claim, asserted rather than commented. `V01_TOOLS` is the
   * array `createServer` advertises, so equality here means the sweep reached
   * every dispatchable tool — including the five `hidden` ones, which are
   * dispatchable by name and by `run_analysis` and are therefore just as able
   * to lie.
   */
  it('sweeps every tool the server advertises', () => {
    expect(sweep).toHaveLength(V01_TOOLS.length);
    expect(sweep.map((row) => row.tool).sort()).toEqual(
      [...V01_TOOLS].map((tool) => tool.name).sort(),
    );
  });

  /**
   * W2 — the sweep must actually REACH handlers. Argument derivation is
   * heuristic; if it rotted until every call returned a validation error the
   * sweep would report zero findings while auditing nothing.
   *
   * The floor is a third of the roster: low enough not to be brittle when a
   * tool gains a required argument, high enough that a wholesale collapse of
   * argument derivation fails the gate rather than silencing it.
   */
  it('actually reaches handlers rather than bouncing off validation', () => {
    const answered = sweep.filter((row) => hasData(row.envelope));
    expect(answered.length).toBeGreaterThan(Math.floor(V01_TOOLS.length / 3));
  });
});

describe('ground truth from the demo vault', () => {
  /**
   * `examples/demo-vault/truth/manifest.json` ships a `toolExpectations[]`
   * array that, until now, had ZERO consumers anywhere in the repository. It
   * is independent truth — authored from `DEMO-ORG-SPEC.md`, not dumped from
   * DuckDB — and it is what makes the rest of this file mean something: a
   * sweep over a vault that answers nothing correctly could satisfy every
   * honesty law by disclosing its way out of every question.
   */
  it('answers every expectation in truth/manifest.json', async () => {
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const truth = JSON.parse(await readFile(demoVaultTruthManifest(), 'utf8')) as {
      toolExpectations?: readonly {
        id: string;
        tool: string;
        args: Record<string, unknown>;
        expect: Record<string, unknown>;
      }[];
    };
    const expectations = truth.toolExpectations ?? [];
    expect(expectations.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const expectation of expectations) {
      const envelope = parseEnvelope(
        (await dispatchTool(liveCtx, expectation.tool, expectation.args)).content,
      );
      const data = envelope['data'] as Record<string, unknown> | undefined;
      if (data === undefined) {
        failures.push(`${expectation.id}: ${JSON.stringify(envelope['error'])}`);
        continue;
      }
      const idsOf = (value: unknown): readonly string[] =>
        Array.isArray(value)
          ? value.map((row) =>
              typeof row === 'object' && row !== null
                ? String((row as Record<string, unknown>)['componentId'] ?? '')
                : '',
            )
          : [];
      const want = expectation.expect;

      if (want['verdict'] !== undefined && data['verdict'] !== want['verdict']) {
        failures.push(
          `${expectation.id}: verdict ${String(data['verdict'])} != ${String(want['verdict'])}`,
        );
      }
      if (want['disposition'] !== undefined && data['disposition'] !== want['disposition']) {
        failures.push(
          `${expectation.id}: disposition ${String(data['disposition'])} != ${String(want['disposition'])}`,
        );
      }
      if (want['topCandidateId'] !== undefined) {
        const top = idsOf(data['candidates'])[0];
        if (top !== want['topCandidateId']) {
          failures.push(`${expectation.id}: top candidate ${String(top)} != ${String(want['topCandidateId'])}`);
        }
      }
      for (const [key, listKey] of [
        ['classesInclude', 'classes'],
        ['matchesInclude', 'matches'],
      ] as const) {
        const wanted = want[key];
        if (!Array.isArray(wanted)) continue;
        const got = idsOf(data[listKey]);
        for (const id of wanted) {
          if (!got.includes(String(id))) {
            failures.push(`${expectation.id}: ${listKey} missing ${String(id)} (got ${JSON.stringify(got)})`);
          }
        }
      }
      if (want['objectModeled'] !== undefined && data['objectModeled'] !== want['objectModeled']) {
        failures.push(`${expectation.id}: objectModeled ${String(data['objectModeled'])}`);
      }
      if (typeof want['minActiveComponents'] === 'number') {
        const summary = data['summary'] as Record<string, unknown> | undefined;
        const active = Number(summary?.['activeComponents'] ?? 0);
        if (active < want['minActiveComponents']) {
          failures.push(
            `${expectation.id}: activeComponents ${String(active)} < ${String(want['minActiveComponents'])}`,
          );
        }
      }
    }

    expect(failures, `truth/manifest.json expectations failed:\n${failures.join('\n')}`).toEqual([]);
  });
});

describe('0.3.2 archetype regression locks', () => {
  /**
   * These four PASS today. They exist so the 0.3.2 fixes cannot regress
   * silently — the fixes live in handlers no test pins, and the honesty laws
   * below would not notice a tool that started answering a ghost scope with a
   * clean zero if the whole gate were ever narrowed.
   */
  it('refuses an unresolvable object scope on the tool that shipped the bug', async () => {
    expect(ctx).not.toBeNull();
    const envelope = parseEnvelope(
      (
        await dispatchTool(ctx as Context, 'sfi.unused_fields_deep', {
          objectApiName: GHOST_OBJECT,
        })
      ).content,
    );
    const error = envelope['error'] as { kind?: string } | undefined;
    expect(error?.kind).toBe('invalid-query');
    expect(envelope['data']).toBeUndefined();
  });

  it('refuses an unresolvable object on who_can_access_object', async () => {
    expect(ctx).not.toBeNull();
    const envelope = parseEnvelope(
      (
        await dispatchTool(ctx as Context, 'sfi.who_can_access_object', {
          objectApiName: GHOST_OBJECT,
        })
      ).content,
    );
    expect((envelope['error'] as { kind?: string } | undefined)?.kind).toBe(
      'component-not-found',
    );
  });

  it('excludes a component’s own declaration from its usage evidence', async () => {
    expect(ctx).not.toBeNull();
    expect(sample).not.toBeNull();
    const envelope = parseEnvelope(
      (
        await dispatchTool(ctx as Context, 'sfi.find_component_usages', {
          componentId: (sample as VaultSample).classId,
        })
      ).content,
    );
    const data = envelope['data'] as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    const grep = data?.['grepSupplement'] as Record<string, unknown> | undefined;
    // The 0.3.2 bug: a class's own `class Foo` declaration counted as evidence
    // that something used it. The fix publishes the exclusion count, so the
    // key's PRESENCE is the regression lock — a handler that stopped
    // subtracting self-matches would stop publishing it.
    expect(grep).toBeDefined();
    expect(typeof grep?.['selfMatchesExcluded']).toBe('number');
  });

  it('refuses find_hardcoded_values_anywhere with no value and no category', async () => {
    expect(ctx).not.toBeNull();
    // The 0.3.2 bug: an unsatisfiable scan reported its own zero as a
    // completed one. An unsatisfiable REQUEST must now be refused outright.
    const envelope = parseEnvelope(
      (await dispatchTool(ctx as Context, 'sfi.find_hardcoded_values_anywhere', {})).content,
    );
    expect((envelope['error'] as { kind?: string } | undefined)?.kind).toBe('invalid-query');
  });
});

describe('THE GATE', () => {
  /**
   * LAWS 1 + 2 over the derived roster.
   *
   * Findings are accumulated rather than thrown so ONE run produces the whole
   * backlog. A gate that dies on the first violation reports one bug and hides
   * the rest — which is how a class of defects survives a green suite.
   */
  it('every tool types its absences and describes its pages honestly', () => {
    let checks: HonestyChecks = NO_CHECKS;
    const findings: HonestyFinding[] = [];
    for (const row of sweep) {
      const audit = auditEnvelope(row.tool, row.envelope);
      checks = addChecks(checks, audit.checks);
      findings.push(...audit.findings);
    }

    const byTool = new Map<string, number>();
    for (const finding of findings) {
      byTool.set(finding.tool, (byTool.get(finding.tool) ?? 0) + 1);
    }
    const summary =
      `${String(findings.length)} honesty violation(s) across ${String(byTool.size)} of ` +
      `${String(V01_TOOLS.length)} tools ` +
      `(typed-absence evaluated ${String(checks.typedAbsence)}x, ` +
      `pagination ${String(checks.pagination)}x).`;

    expect(findings, `${summary}\n\n${formatFindings(findings)}\n`).toEqual([]);
  });

  /**
   * LAW 2 again, under the condition it exists for: a page that was actually
   * trimmed. See the `limit: 1` note in `beforeAll`.
   */
  it('every paginated tool describes a deliberately trimmed page honestly', () => {
    let checks: HonestyChecks = NO_CHECKS;
    const findings: HonestyFinding[] = [];
    for (const row of trimmedProbes) {
      const audit = auditEnvelope(row.tool, row.envelope);
      checks = addChecks(checks, audit.checks);
      findings.push(...audit.findings.filter((f) => f.rule === 'pagination-completeness'));
    }

    const summary =
      `${String(findings.length)} pagination violation(s) across ${String(trimmedProbes.length)} ` +
      `tools re-called with limit: 1 (law evaluated ${String(checks.pagination)}x).`;

    expect(findings, `${summary}\n\n${formatFindings(findings)}\n`).toEqual([]);
  });

  /**
   * LAW 3 over every tool that ADVERTISES an object scope — derived from each
   * schema's properties, so tools nobody remembered to sweep are included.
   *
   * `unused_fields_deep`'s own tool description states the product law: "An
   * object name that matches nothing in the vault is refused with
   * `invalid-query` rather than silently returning `{fields: [], totalCount:
   * 0}`." This asserts that sentence against the whole roster.
   */
  it('every object-scoped tool refuses a scope that does not resolve', () => {
    let checks: HonestyChecks = NO_CHECKS;
    const findings: HonestyFinding[] = [];
    for (const probe of scopeProbes) {
      const audit = auditScopeRefusal(
        probe.tool,
        probe.scopeKeys.join('/'),
        GHOST_OBJECT,
        probe.envelope,
      );
      checks = addChecks(checks, audit.checks);
      findings.push(...audit.findings);
    }

    const summary =
      `${String(findings.length)} of ${String(scopeProbes.length)} object-scoped tools ` +
      `answered a question about an object that does not exist ` +
      `(law evaluated ${String(checks.scopeRefusal)}x).`;

    expect(findings, `${summary}\n\n${formatFindings(findings)}\n`).toEqual([]);
  });
});

describe('anti-vacuity', () => {
  /**
   * W3 — every law must be shown to have FIRED, against a denominator derived
   * from this run rather than a hardcoded number. A law that silently stopped
   * evaluating reports zero findings and is indistinguishable from a law that
   * passed; these assertions are what tell them apart.
   */
  it('every law actually evaluated', () => {
    let checks: HonestyChecks = NO_CHECKS;
    for (const row of sweep) checks = addChecks(checks, auditEnvelope(row.tool, row.envelope).checks);
    for (const probe of scopeProbes) {
      checks = addChecks(
        checks,
        auditScopeRefusal(probe.tool, probe.scopeKeys.join('/'), GHOST_OBJECT, probe.envelope).checks,
      );
    }

    const payloadsWithData = sweep.filter((row) => hasData(row.envelope)).length;
    const objectScopedTools = V01_TOOLS.filter((tool) => objectScopeKeys(tool).length > 0).length;

    // Law 0 sees every envelope.
    expect(checks.legacyStub).toBe(sweep.length);
    // Law 1 must fire on a real share of the payloads that carry data. A
    // quarter is well below what the tree does today and well above zero.
    expect(checks.typedAbsence).toBeGreaterThan(payloadsWithData / 4);
    // Law 2 must fire on the paginated tools, in BOTH passes.
    expect(checks.pagination).toBeGreaterThan(10);
    const trimmedEvaluated = trimmedProbes.filter((row) => hasData(row.envelope)).length;
    expect(trimmedProbes.length).toBeGreaterThan(20);
    expect(trimmedEvaluated).toBeGreaterThan(10);
    // Law 3 must fire once per object-scoped tool — exactly, not approximately.
    expect(checks.scopeRefusal).toBe(objectScopedTools);
    expect(objectScopedTools).toBeGreaterThan(20);
  });
});
