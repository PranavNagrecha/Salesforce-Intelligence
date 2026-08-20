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
import { describe, expect, it } from 'vitest';

import { changedSinceInputSchema } from '../../src/tools/changed-since.js';
import { SECTION_NAMES } from '../../src/tools/field-360.js';
import { V01_TOOLS } from '../../src/tools/index.js';
import { COMPONENT_TYPES } from '../../src/tools/list-components.js';
import { unusedComponentsInputSchema } from '../../src/tools/unused-components.js';

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
