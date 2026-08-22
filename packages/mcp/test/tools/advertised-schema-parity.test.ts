/// <reference types="vitest/globals" />

/**
 * FIELD-360-ADVERTISED-SECTIONS-UNDERSTATE-SCHEMA.
 *
 * A tool has TWO input contracts: the Zod schema the handler validates against,
 * and the JSON Schema advertised to the MCP host in the roster. When they
 * disagree, a host that validates arguments before sending them rejects calls
 * the handler would have served — and the failure is invisible from inside this
 * repo, because every unit test calls the handler directly and never sees the
 * advertised schema.
 *
 * `sfi.field_360` had exactly that drift: `SECTION_NAMES` (and therefore the
 * Zod enum, the handler, and the response) carried 12 sections, while the
 * advertised enum still listed the 10 from PLAN-v3.0 §4. The two missing ones
 * were `rollups` and `listViews` — the sections added specifically so roll-up
 * summary couplings and saved-list-view referrers stop being silently dropped.
 * So the drift made two bug fixes unreachable through a strict host, and the
 * schema's own JSDoc had shrugged this off as "a code-review concern".
 *
 * The fix interpolates the tuple. This test is what keeps it interpolated.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { changedSinceInputSchema } from '../../src/tools/changed-since.js';
import { SECTION_NAMES } from '../../src/tools/field-360.js';
import { V01_TOOLS } from '../../src/tools/index.js';
import { COMPONENT_TYPES } from '../../src/tools/list-components.js';
import { unusedComponentsInputSchema } from '../../src/tools/unused-components.js';
import {
  computeParityViolations,
  enforcedInputSchemas,
  type ParityAxis,
} from '../helpers/advertised-schema-parity.js';

const advertisedSectionEnum = (): readonly string[] => {
  const tool = V01_TOOLS.find((t) => t.name === 'sfi.field_360');
  if (tool === undefined) throw new Error('sfi.field_360 missing from roster');
  const schema = tool.inputSchema as {
    properties?: { includeSections?: { items?: { enum?: readonly string[] } } };
  };
  const values = schema.properties?.includeSections?.items?.enum;
  if (values === undefined) throw new Error('advertised includeSections enum missing');
  return values;
};

describe('sfi.field_360 advertises exactly the sections it implements', () => {
  it('the advertised enum equals SECTION_NAMES, in order', () => {
    // FAIL-BEFORE: 10 advertised vs 12 implemented.
    expect(advertisedSectionEnum()).toEqual([...SECTION_NAMES]);
  });

  it('rollups and listViews are advertised — a strict host may request them', () => {
    // Named individually because these two are the whole point: each exists to
    // stop a class of referrer being dropped, and each was unrequestable.
    expect(advertisedSectionEnum()).toContain('rollups');
    expect(advertisedSectionEnum()).toContain('listViews');
  });

  it('the description counts the sections it lists, and lists all of them', () => {
    const description =
      V01_TOOLS.find((t) => t.name === 'sfi.field_360')?.description ?? '';
    expect(description).toContain(
      `${String(SECTION_NAMES.length)} optional content sections`,
    );
    for (const section of SECTION_NAMES) {
      expect(description).toContain(`\`${section}\``);
    }
  });
});

/**
 * COMPONENT-TYPE-ENUM-ADVERTISED-VS-VALIDATED.
 *
 * The same class of drift, on a different axis, and this test exists because
 * the version above did NOT catch it.
 *
 * `sfi.unused_components` and `sfi.changed_since` each carried a hand-copied
 * `COMPONENT_TYPES` array whose own comment claimed to be "the full superset"
 * of the contracts `ComponentType` union. Both had drifted — to 47 and 46 of
 * 101 — so each rejected ~54 types its extractors retrieve and model
 * (`FlexiPage`, `CustomPermission`, every CPQ and OmniStudio tier) with
 * `invalid-query`.
 *
 * A first repair spread the canonical list into the ADVERTISED schemas only,
 * leaving both Zod validators stale. That is strictly worse than the drift it
 * replaced: the advertised set went to 101 while the validators still accepted
 * 47 and 46, so a host trusting the advertisement had 54 and 55 types rejected
 * instead of 2 and 1. The suite stayed green throughout, because the only
 * parity test in this file named `sfi.field_360`.
 *
 * Hence: assert the advertised enum against the TOOL'S OWN validator, for every
 * tool that advertises a component-type enum. Asserting against a shared
 * constant would have passed while both halves disagreed.
 */
describe('component-type enums: advertised set equals what the validator accepts', () => {
  const advertisedTypeEnum = (toolName: string): readonly string[] => {
    const tool = V01_TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) throw new Error(`${toolName} missing from roster`);
    const schema = tool.inputSchema as {
      properties?: { types?: { items?: { enum?: readonly string[] } } };
    };
    const values = schema.properties?.types?.items?.enum;
    if (values === undefined) {
      throw new Error(`${toolName} advertised types enum missing`);
    }
    return values;
  };

  it.each([
    ['sfi.unused_components', unusedComponentsInputSchema, {}],
    [
      'sfi.changed_since',
      changedSinceInputSchema,
      { since: '2026-01-01T00:00:00Z' },
    ],
  ])(
    '%s: every advertised component type is accepted by its own Zod schema',
    (toolName, schema, extra) => {
      const advertised = advertisedTypeEnum(toolName as string);
      const rejected = advertised.filter(
        (t) =>
          !(
            schema as {
              safeParse: (v: unknown) => { success: boolean };
            }
          ).safeParse({ ...(extra as object), types: [t] }).success,
      );
      // FAIL-BEFORE: 54 rejected for unused_components, 55 for changed_since.
      expect(rejected).toEqual([]);
      expect(advertised.length).toBe(COMPONENT_TYPES.length);
    },
  );

  it('both tools validate against the canonical, compile-time-proven list', () => {
    // `list-components.ts` is the single source of truth: `satisfies readonly
    // ComponentType[]` proves every entry is real, and `ComponentTypesComplete`
    // proves every ComponentType is present, so the build fails before this
    // test can drift.
    for (const toolName of ['sfi.unused_components', 'sfi.changed_since']) {
      expect(advertisedTypeEnum(toolName)).toEqual([...COMPONENT_TYPES]);
    }
  });
});

/**
 * THE GENERALISED GATE.
 *
 * Both blocks above are correct and both are NARROW: three tools, one property
 * each, on the `enum` axis alone. A single batch then shipped ten tools whose
 * advertised schema disagreed with the validator on the axes nobody checked —
 * the property SET, `required`, and `additionalProperties` — and every one of
 * them walked past a green suite.
 *
 * The correct assertion already existed in `route-question-schema-parity.
 * test.ts`: `Object.keys(schema.shape).sort()` against the advertised keys. It
 * was scoped to one tool. Here it runs over EVERY tool `dispatchTool` routes,
 * plus `required`, plus `.strict()` ⇒ `additionalProperties: false`, plus the
 * enum axis in BOTH directions.
 *
 * Known disagreements live in `advertised-schema-parity-baseline.json` with a
 * per-entry reason. The baseline is matched EXACTLY: an unlisted violation
 * fails, a listed-but-gone violation fails, and a violation whose key list
 * changed fails — so it can only be shortened by repairs.
 */
describe('every tool advertises exactly the input contract it enforces', () => {
  interface BaselineEntry {
    readonly tool: string;
    readonly axis: ParityAxis;
    readonly fingerprint: string;
    readonly reason: string;
  }

  const baseline: readonly BaselineEntry[] = (
    JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'advertised-schema-parity-baseline.json'),
        'utf8',
      ),
    ) as { readonly entries: readonly BaselineEntry[] }
  ).entries;

  const key = (v: { readonly tool: string; readonly axis: string; readonly fingerprint: string }): string =>
    `${v.tool} :: ${v.axis} :: ${v.fingerprint}`;

  const violations = computeParityViolations(V01_TOOLS);

  it('every advertised tool has a dispatch arm with a resolvable Zod validator', () => {
    // `computeParityViolations` throws rather than skipping when an arm cannot
    // be parsed; this asserts the coverage NUMBER so a silently shrinking map
    // is visible too.
    const bindings = enforcedInputSchemas();
    const rosterNames = new Set(V01_TOOLS.map((t) => t.name));
    const unbound = [...rosterNames].filter((name) => !bindings.has(name));
    expect(unbound).toEqual([]);
    expect(bindings.size).toBeGreaterThanOrEqual(rosterNames.size);
  });

  it('has no advertised-vs-enforced disagreement outside the reasoned baseline', () => {
    const baselined = new Set(baseline.map(key));
    const unlisted = violations.filter((v) => !baselined.has(key(v)));
    // FAIL-BEFORE: this gate reported 45 disagreements across 37 tools on the
    // commit it landed against; 18 of them across 15 tools were introduced by
    // the batch under review and are repaired in the same change, leaving the
    // 27 pre-existing rows in the baseline beside it.
    expect(unlisted.map(key)).toEqual([]);
  });

  it('the baseline holds no stale rows — it can only shrink', () => {
    const live = new Set(violations.map(key));
    const stale = baseline.filter((entry) => !live.has(key(entry)));
    expect(stale.map(key)).toEqual([]);
  });

  it('every baseline row carries a reason a reader can act on', () => {
    const thin = baseline.filter((entry) => entry.reason.trim().length < 40);
    expect(thin.map((entry) => `${entry.tool}/${entry.axis}`)).toEqual([]);
  });

  // ── Named regressions, so a re-break says which finding came back ────────
  const advertisedKeysOf = (name: string): readonly string[] => {
    const tool = V01_TOOLS.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`${name} missing from roster`);
    const schema = tool.inputSchema as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    return Object.keys(schema.properties ?? {}).sort();
  };

  it('sfi.order_of_execution advertises the per-event pagination it built', () => {
    // FAIL-BEFORE: advertised exactly {objectApiName}. `events`/`event`/
    // `includeInactive`/`limit`/`offset`/`cursor` were accepted and unreachable.
    for (const knob of ['events', 'event', 'includeInactive', 'limit', 'offset', 'cursor']) {
      expect(advertisedKeysOf('sfi.order_of_execution')).toContain(knob);
    }
    const schema = V01_TOOLS.find((t) => t.name === 'sfi.order_of_execution')
      ?.inputSchema as { readonly additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });

  it('sfi.what_happens_on_save advertises the re-query its own output names', () => {
    // The response says "re-query with includeInactive: true for the full list".
    // FAIL-BEFORE: that re-query was unconstructible from the advertised schema.
    expect(advertisedKeysOf('sfi.what_happens_on_save')).toContain('includeInactive');
    expect(advertisedKeysOf('sfi.what_happens_on_save')).toContain('phase');
  });

  it('sfi.find_hardcoded_values advertises excludeTestClasses and its scope keys', () => {
    for (const knob of ['excludeTestClasses', 'componentId', 'nameContains']) {
      expect(advertisedKeysOf('sfi.find_hardcoded_values')).toContain(knob);
    }
  });

  it('sfi.lifecycle_process advertises the RecordType scoping axis', () => {
    // Unadvertised, a caller asking a record-type-scoped question silently got
    // the UNSCOPED answer — the scope decides which automation is excluded.
    for (const knob of ['objectId', 'recordType', 'recordTypeId', 'businessProcess']) {
      expect(advertisedKeysOf('sfi.lifecycle_process')).toContain(knob);
    }
  });
});
