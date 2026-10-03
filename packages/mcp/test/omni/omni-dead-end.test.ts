/// <reference types="vitest/globals" />

/**
 * DEAD_END_SECTION (spec F5 phase 2): a section entered for a population whose
 * entry step hides itself for part of that population. Synthetic fixture: the
 * Assets section is entered by age, its entry step shows only for a care group
 * computed by a Set Values formula.
 */

import { omniPathSimulatorHandler } from '../../src/tools/omni-path-simulator.js';

import { buildOmniFixture, script, type OmniFixture } from './omni-fixture.js';

const rule = (field: string, data: string): Record<string, unknown> => ({
  group: { operator: 'AND', rules: [{ field, condition: '=', data }] },
});

const assets = script({
  type: 'Acme',
  subType: 'Assets',
  language: 'English',
  version: 1,
  active: true,
  elements: [
    {
      name: 'Flags',
      type: 'Set Values',
      cfg: {
        elementValueMap: {
          isCareGroup: '=AND(CONTAINS(%Benefits%, "Health"), %NeedsCare% == "Yes")',
          ageYears: '=AGE(%BirthDate%)',
        },
      },
    },
    { name: 'AssetStart', type: 'Step', cfg: { show: rule('isCareGroup', 'true') }, children: [{ name: 'AssetKind', type: 'Text' }] },
    { name: 'CareStart', type: 'Step', cfg: { show: rule('NeedsCare', 'Yes') }, children: [{ name: 'CareKind', type: 'Text' }] },
  ],
});

let fx: OmniFixture;
beforeAll(async () => {
  fx = await buildOmniFixture({
    extraOmniScripts: [{ file: 'Acme_Assets_English_1.os-meta.xml', body: assets }],
    config: { sectionEntries: [{ omniscript: 'Acme/Assets', step: 'AssetStart', enteredWhen: '%ageYears% >= 65', section: 'Assets' }] },
  });
}, 60_000);
afterAll(async () => {
  await fx.cleanup();
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe('sfi.omni_path_simulator — DEAD_END_SECTION', () => {
  it('finds answers that enter the section while its entry step is hidden, from the declared section entry', async () => {
    const r = must(await omniPathSimulatorHandler(fx.ctx, { omniscript: 'Acme_Assets_English_1' }));
    const check = r.data.deadEndChecks.find((c) => c.step === 'AssetStart');
    expect(check).toMatchObject({ verdict: 'defect', source: 'config', section: 'Assets' });
    expect(Number(check?.witness?.['ageYears'])).toBeGreaterThanOrEqual(65);
    // The entry step reads a Set Values flag; the search ran over its real inputs.
    expect(check?.variables).toEqual(['Benefits', 'NeedsCare', 'ageYears']);
    expect(check?.assumptions[0]).toMatch(/ageYears = AGE\(%BirthDate%\).*free input/);
    const finding = r.data.findings.find((f) => f.code === 'DEAD_END_SECTION');
    expect(finding).toMatchObject({ verdict: 'defect', confidence: 'inferred', elementPath: 'AssetStart' });
    expect(finding?.citations[0]?.elementPath).toBe('AssetStart');
  });

  it('is clear when the entry step shows for everyone the section is entered for', async () => {
    const r = must(
      await omniPathSimulatorHandler(fx.ctx, {
        omniscript: 'Acme_Assets_English_1',
        sections: [{ step: 'CareStart', enteredWhen: '%NeedsCare% == "Yes"', section: 'Care' }],
      }),
    );
    const care = r.data.deadEndChecks.find((c) => c.step === 'CareStart');
    expect(care).toMatchObject({ verdict: 'clear', source: 'input', witness: null });
    expect(r.data.findings.filter((f) => f.code === 'DEAD_END_SECTION').map((f) => f.elementPath)).toEqual(['AssetStart']);
  });

  it('says unknown, with the reason, when the entry condition cannot be evaluated or the step does not exist', async () => {
    const r = must(
      await omniPathSimulatorHandler(fx.ctx, {
        omniscript: 'Acme_Assets_English_1',
        sections: [
          { step: 'CareStart', enteredWhen: 'MYSTERY(%x%)' },
          { step: 'NoSuchStep', enteredWhen: '%x% == 1' },
        ],
      }),
    );
    const [mystery, missing] = r.data.deadEndChecks.filter((c) => c.source === 'input');
    expect(mystery?.verdict).toBe('unknown');
    expect(mystery?.unknownReason).toMatch(/could not be evaluated/);
    expect(missing?.unknownReason).toMatch(/no top-level step 'NoSuchStep'/);
    expect(r.data.findings.filter((f) => f.code === 'DEAD_END_SECTION' && f.verdict === 'unknown')).toHaveLength(2);
  });

  it('checks nothing when no section is declared or passed', async () => {
    const r = must(await omniPathSimulatorHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    expect(r.data.deadEndChecks).toEqual([]);
  });
});
