/// <reference types="vitest/globals" />

/**
 * whereProperty AND-array — compiler round-trip + validator tests (Commit A,
 * edits 3 & 4). The build compiler (`build-concept-model.mjs`) must:
 *   - `renderBind` a polymorphic `whereProperty` array to a deterministic TS
 *     literal (`whereProperty: [{ key, equals }, …]`) that RE-PARSES to the
 *     same value (round-trip), while a scalar `whereProperty` renders exactly
 *     as before (`whereProperty: { key, equals }`);
 *   - `assertBind` ACCEPT a non-empty array (each element validated by the
 *     shared where-mapping check) and REJECT an empty array or a bad element.
 *
 * Like check-concept-model.test.ts, the `.mjs` is imported in a CHILD process
 * (the repo's `tsc --build` compiles `test/` without `allowJs`, so a direct
 * `.mjs` import would break the build). The child JSON-decodes a scenario from
 * env, exercises the shipped functions, and prints a JSON result.
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const scriptUrl = pathToFileURL(
  join(repoRoot, 'packages/mcp/scripts/build-concept-model.mjs'),
).href;

// `renderBind` the bind in env.PROBE, then re-parse the emitted literal and
// report whether the parsed `whereProperty` deep-equals the input (round-trip).
const RENDER_PROBE =
  "import(process.env.SCRIPT).then(m => { const bind = JSON.parse(process.env.PROBE); const rendered = m.renderBind(bind); let roundtrips = false; try { const parsed = (0, eval)('(' + rendered + ')'); roundtrips = JSON.stringify(parsed.whereProperty) === JSON.stringify(bind.whereProperty); } catch (e) { roundtrips = false; } process.stdout.write(JSON.stringify({ rendered, roundtrips })); })";

const render = (bind: unknown): { rendered: string; roundtrips: boolean } => {
  const out = execSync(`node -e ${JSON.stringify(RENDER_PROBE)}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: scriptUrl, PROBE: JSON.stringify(bind) },
  });
  return JSON.parse(out);
};

// `assertBind` the bind in env.PROBE; report ok / error message.
const ASSERT_PROBE =
  "import(process.env.SCRIPT).then(m => { const bind = JSON.parse(process.env.PROBE); let ok = true, err = null; try { m.assertBind(bind, 'conceptRules[0].bind'); } catch (e) { ok = false; err = e.message; } process.stdout.write(JSON.stringify({ ok, err })); })";

const assertBind = (bind: unknown): { ok: boolean; err: string | null } => {
  const out = execSync(`node -e ${JSON.stringify(ASSERT_PROBE)}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: scriptUrl, PROBE: JSON.stringify(bind) },
  });
  return JSON.parse(out);
};

describe('build-concept-model renderBind — whereProperty polymorphism (edit 4)', () => {
  it('renders an AND-array to the deterministic TS literal and round-trips', () => {
    const bind = {
      componentTypes: ['ApexClass'],
      whereProperty: [
        { key: 'sharingModel', equals: 'without sharing' },
        { key: 'hasAuraEnabledMethod', equals: true },
        { key: 'isTest', equals: false },
      ],
    };
    const { rendered, roundtrips } = render(bind);
    expect(rendered).toContain(
      "whereProperty: [{ key: 'sharingModel', equals: 'without sharing' }, { key: 'hasAuraEnabledMethod', equals: true }, { key: 'isTest', equals: false }]",
    );
    expect(roundtrips).toBe(true);
  });

  it('renders a scalar whereProperty exactly as before (no array brackets)', () => {
    const bind = {
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'sharingModel', equals: 'without sharing' },
    };
    const { rendered, roundtrips } = render(bind);
    expect(rendered).toContain(
      "whereProperty: { key: 'sharingModel', equals: 'without sharing' }",
    );
    // …and does NOT emit the array form for a scalar.
    expect(rendered).not.toContain('whereProperty: [');
    expect(roundtrips).toBe(true);
  });
});

describe('build-concept-model assertBind — whereProperty AND-array validation (edit 3)', () => {
  it('ACCEPTS a non-empty array of well-formed mappings', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: [
        { key: 'sharingModel', equals: 'without sharing' },
        { key: 'isTest', equals: false },
      ],
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('REJECTS an empty array', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: [],
    });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty must be a non-empty array');
  });

  it('REJECTS an array element missing a required key', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: [{ key: 'sharingModel' }],
    });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty[0]');
    expect(err).toContain('missing required key(s): equals');
  });

  it('REJECTS an array element with a non-scalar equals', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: [{ key: 'sharingModel', equals: { nested: true } }],
    });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty[0].equals must be a string, number, or boolean');
  });

  it('still ACCEPTS the scalar form (byte-verbatim behavior preserved)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'sharingModel', equals: 'without sharing' },
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });
});

// operator-class whereProperty (in / notIn / neq) — validator + codegen.
describe('build-concept-model assertBind — operator-class whereProperty (in / notIn / neq)', () => {
  it('ACCEPTS an `in` clause with a non-empty scalar array', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] },
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('ACCEPTS `notIn` and `neq` clauses', () => {
    expect(
      assertBind({ componentTypes: ['ConditionalContext'], whereProperty: { key: 'kind', notIn: ['flow-decision'] } }).ok,
    ).toBe(true);
    expect(
      assertBind({ componentTypes: ['ConditionalContext'], whereProperty: { key: 'kind', neq: 'flow-decision' } }).ok,
    ).toBe(true);
  });

  it('ACCEPTS an operator clause COMPOSED with an equals clause in an AND-array', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ConditionalContext'],
      whereProperty: [
        { key: 'synthesized', equals: false },
        { key: 'kind', in: ['criteria', 'formula'] },
      ],
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('REJECTS an empty `in` array (non-empty required)', () => {
    const { ok, err } = assertBind({ componentTypes: ['ConditionalContext'], whereProperty: { key: 'kind', in: [] } });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty.in must be a non-empty array');
  });

  it('REJECTS a non-scalar `in` array element', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', in: [{ nested: true }] },
    });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty.in[0] must be a string, number, or boolean');
  });

  it('REJECTS TWO operators in one clause (exactly one required)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', equals: 'formula', in: ['formula'] },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });

  it('REJECTS a canonical id hidden inside an `in` array member (leak-guard)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', in: ['formula', 'ApexClass:Ns__Secret'] },
    });
    expect(ok).toBe(false);
    expect(err).toContain('whereProperty.in[1]');
  });
});

describe('build-concept-model renderBind — operator-class whereProperty round-trip', () => {
  it('renders an `in` clause and re-parses to the same value', () => {
    const { rendered, roundtrips } = render({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] },
    });
    expect(rendered).toContain(
      "whereProperty: { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] }",
    );
    expect(roundtrips).toBe(true);
  });

  it('renders `notIn` and `neq` clauses that round-trip', () => {
    const notIn = render({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', notIn: ['flow-decision'] },
    });
    expect(notIn.rendered).toContain("whereProperty: { key: 'kind', notIn: ['flow-decision'] }");
    expect(notIn.roundtrips).toBe(true);
    const neq = render({
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', neq: 'flow-decision' },
    });
    expect(neq.rendered).toContain("whereProperty: { key: 'kind', neq: 'flow-decision' }");
    expect(neq.roundtrips).toBe(true);
  });
});

// isNull operator (nullish present/absent test) — validator + codegen.
describe('build-concept-model assertBind — isNull whereProperty operator', () => {
  it('ACCEPTS `isNull: true` and `isNull: false` clauses', () => {
    expect(
      assertBind({ componentTypes: ['CustomField'], whereProperty: { key: 'defaultValue', isNull: true } }).ok,
    ).toBe(true);
    expect(
      assertBind({ componentTypes: ['CustomField'], whereProperty: { key: 'defaultValue', isNull: false } }).ok,
    ).toBe(true);
  });

  it('ACCEPTS `isNull` AND-ed with an equals clause (the A1 required+no-default shape)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['CustomField'],
      whereProperty: [
        { key: 'required', equals: true },
        { key: 'defaultValue', isNull: true },
      ],
    });
    expect(ok).toBe(true);
    expect(err).toBeNull();
  });

  it('REJECTS a non-boolean `isNull` operand', () => {
    const { ok, err } = assertBind({
      componentTypes: ['CustomField'],
      whereProperty: { key: 'defaultValue', isNull: 'x' },
    });
    expect(ok).toBe(false);
    expect(err).toContain('isNull must be a boolean');
  });

  it('REJECTS two operators in one clause (`equals` + `isNull`)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['CustomField'],
      whereProperty: { key: 'defaultValue', equals: 'a', isNull: true },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });
});

describe('build-concept-model renderBind — isNull whereProperty round-trip', () => {
  it('renders an `isNull: true` clause that round-trips', () => {
    const { rendered, roundtrips } = render({
      componentTypes: ['CustomField'],
      whereProperty: { key: 'defaultValue', isNull: true },
    });
    expect(rendered).toContain("whereProperty: { key: 'defaultValue', isNull: true }");
    expect(roundtrips).toBe(true);
  });

  it('renders an `isNull: false` clause that round-trips', () => {
    const { rendered, roundtrips } = render({
      componentTypes: ['CustomField'],
      whereProperty: { key: 'defaultValue', isNull: false },
    });
    expect(rendered).toContain("whereProperty: { key: 'defaultValue', isNull: false }");
    expect(roundtrips).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// anyElement operator (existential array-element matcher) — validator + codegen.
// ---------------------------------------------------------------------------
describe('build-concept-model assertBind — anyElement whereProperty operator', () => {
  it('ACCEPTS the object-element form (qualityIssues[].rule ∈ {…})', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } },
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('ACCEPTS the scalar-array form (no inner key — the element IS the value)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexTrigger'],
      whereProperty: { key: 'events', anyElement: { in: ['before insert', 'after update'] } },
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('ACCEPTS inner `equals` / `neq` scalar operators', () => {
    expect(
      assertBind({
        componentTypes: ['ApexClass'],
        whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', equals: 'dml-in-loop' } },
      }).ok,
    ).toBe(true);
    expect(
      assertBind({
        componentTypes: ['ApexClass'],
        whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', neq: 'hardcoded-id' } },
      }).ok,
    ).toBe(true);
  });

  it('composes anyElement in an outer AND-array with a scalar clause', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: [
        { key: 'isTest', equals: false },
        { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } },
      ],
    });
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('REJECTS a non-mapping anyElement operand', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: 'soql-injection' },
    });
    expect(ok).toBe(false);
    expect(err).toContain('anyElement must be a mapping');
  });

  it('REJECTS an inner clause with NO operator', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule' } },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });

  it('REJECTS an inner clause with TWO operators', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', equals: 'a', in: ['b'] } },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });

  it('REJECTS an inner `isNull` (not a valid inner operator — flat scalar only)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', isNull: true } },
    });
    expect(ok).toBe(false);
    // isNull is not in WHERE_INNER_OPERATORS, so it surfaces as an unknown key
    // (no valid operator present).
    expect(err).toContain('exactly one operator');
  });

  it('REJECTS a nested anyElement inner (no recursion)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: {
        key: 'qualityIssues',
        anyElement: { key: 'nested', anyElement: { in: ['x'] } },
      },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });

  it('REJECTS an empty inner `in` array', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', in: [] } },
    });
    expect(ok).toBe(false);
    expect(err).toContain('anyElement.in must be a non-empty array');
  });

  it('REJECTS an empty inner `key` string', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: '', in: ['x'] } },
    });
    expect(ok).toBe(false);
    expect(err).toContain('anyElement.key must be a non-empty string');
  });

  it('REJECTS mixing anyElement with a sibling operator on the OUTER clause (exactly-one)', () => {
    const { ok, err } = assertBind({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { in: ['x'] }, equals: 'y' },
    });
    expect(ok).toBe(false);
    expect(err).toContain('exactly one operator');
  });
});

describe('build-concept-model renderBind — anyElement whereProperty round-trip', () => {
  it('renders the object-element form and round-trips', () => {
    const { rendered, roundtrips } = render({
      componentTypes: ['ApexClass'],
      whereProperty: {
        key: 'qualityIssues',
        anyElement: { key: 'rule', in: ['soql-injection', 'dml-in-loop'] },
      },
    });
    expect(rendered).toContain(
      "whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection', 'dml-in-loop'] } }",
    );
    expect(roundtrips).toBe(true);
  });

  it('renders the scalar-array form (no inner key) and round-trips', () => {
    const { rendered, roundtrips } = render({
      componentTypes: ['ApexTrigger'],
      whereProperty: { key: 'events', anyElement: { in: ['before insert', 'after update'] } },
    });
    expect(rendered).toContain(
      "whereProperty: { key: 'events', anyElement: { in: ['before insert', 'after update'] } }",
    );
    expect(roundtrips).toBe(true);
  });

  it('renders an inner `neq` / `equals` scalar operand that round-trips', () => {
    const neq = render({
      componentTypes: ['ApexClass'],
      whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', neq: 'hardcoded-id' } },
    });
    expect(neq.rendered).toContain(
      "whereProperty: { key: 'qualityIssues', anyElement: { key: 'rule', neq: 'hardcoded-id' } }",
    );
    expect(neq.roundtrips).toBe(true);
  });
});
