/// <reference types="vitest/globals" />

import { ok } from '@sf-intelligence/core';

import { howToSeeHandler } from '../../src/tools/how-to-see.js';
import { claimQuery, compiledComponentNames, liveVerifyHandler, type LiveVerifyDeps } from '../../src/tools/live-verify.js';

import { buildPersonaFixture, type PersonaFixture } from './persona-fixture.js';

let fx: PersonaFixture;
beforeAll(async () => {
  fx = await buildPersonaFixture();
}, 60_000);
afterAll(async () => {
  await fx.cleanup();
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

/** Fake live plane: the gate always passes; queries answer from `rows`. */
const fake = (rows: Record<string, unknown>[], seen: string[] = []): LiveVerifyDeps => ({
  gate: async () => ok('fixture-org'),
  query: async (_org, soql) => {
    seen.push(soql);
    return ok(rows);
  },
});

describe('sfi.live_verify', () => {
  it('confirms a permission-set grant and compares it with the vault', async () => {
    const seen: string[] = [];
    const r = must(
      await liveVerifyHandler(
        fx.ctx,
        { claim: { kind: 'object-permission', container: 'Acme_Portal', object: 'Acme_Order__c', permission: 'edit' } },
        fake([{ SobjectType: 'Acme_Order__c', PermissionsEdit: true }], seen),
      ),
    );
    expect(r.data.verdict).toBe('CONFIRMED');
    expect(r.data.vaultSays).toEqual({ container: 'PermissionSet:Acme_Portal', edit: true });
    expect(r.data.matchesVault).toBe(true);
    expect(seen[0]).toContain("FROM ObjectPermissions WHERE SobjectType = 'Acme_Order__c'");
    expect(r.data.trust.provenance).toBe('live_org');
  });

  it('flags drift when the live org disagrees with the vault', async () => {
    const r = must(
      await liveVerifyHandler(
        fx.ctx,
        { claim: { kind: 'object-permission', container: 'Acme_Portal', object: 'Acme_Order__c', permission: 'edit' } },
        fake([{ SobjectType: 'Acme_Order__c', PermissionsEdit: false }]),
      ),
    );
    expect(r.data.verdict).toBe('REFUTED');
    expect(r.data.matchesVault).toBe(false);
  });

  it('reports ACTIVE_BUT_NOT_COMPILED when no compiled component exists for an active OmniScript', async () => {
    const r = must(
      await liveVerifyHandler(fx.ctx, { claim: { kind: 'omniscript-compiled', type: 'Acme', subType: 'PortalIntake', language: 'English' } }, fake([])),
    );
    expect(r.data.verdict).toBe('REFUTED');
    expect(r.data.code).toBe('ACTIVE_BUT_NOT_COMPILED');
    // The vault side is real: the active, web-component-enabled version.
    expect(r.data.vaultSays).toMatchObject({ versions: [{ id: 'OmniScript:Acme_PortalIntake_English_1', isActive: true, isWebCompEnabled: true }] });
    const found = must(
      await liveVerifyHandler(
        fx.ctx,
        { claim: { kind: 'omniscript-compiled', type: 'Acme', subType: 'PortalIntake', language: 'English' } },
        fake([{ DeveloperName: 'acmePortalIntakeEnglish' }]),
      ),
    );
    expect(found.data.verdict).toBe('CONFIRMED');
    expect(compiledComponentNames('Acme', 'PortalIntake', 'English')).toContain('acmePortalIntakeEnglish');
  });

  it('builds read-only SELECTs only, Tooling where the object needs it', () => {
    expect(claimQuery({ kind: 'validation-rules', object: 'Acme_Order__c' })).toMatchObject({ tooling: true });
    expect(claimQuery({ kind: 'omni-active-version', type: 'Acme', subType: 'PortalSave' }).soql).toMatch(/^SELECT .* FROM OmniProcess /);
  });

  it('refuses a claim with unsafe characters before any query runs', async () => {
    const { liveVerifyInputSchema } = await import('../../src/tools/live-verify.js');
    expect(liveVerifyInputSchema.safeParse({ claim: { kind: 'validation-rules', object: "x' OR Name != '" } }).success).toBe(false);
  });
});

describe('sfi.how_to_see', () => {
  it('gives the Setup path for a permission set object setting, and the OmniStudio path for a script element', async () => {
    const ps = must(await howToSeeHandler(fx.ctx, { componentId: 'PermissionSet:Acme_Portal', object: 'Acme_Order__c' }));
    expect(ps.data.steps).toEqual(['Setup', 'Permission Sets', 'Acme Portal', 'Object Settings', 'Acme_Order__c']);
    const os = must(await howToSeeHandler(fx.ctx, { componentId: 'OmniScript:Acme_PortalIntake_English_1', elementPath: 'OrderStep/Status' }));
    expect(os.data.steps).toEqual(['App Launcher', 'OmniStudio', 'OmniScripts', 'Acme / PortalIntake', 'version 1 (English)', 'open OrderStep/Status']);
    const field = must(await howToSeeHandler(fx.ctx, { componentId: 'CustomField:Acme_Order__c.Acme_Status__c' }));
    expect(field.data.steps.slice(0, 2)).toEqual(['Setup', 'Object Manager']);
    expect(field.data.urlPath).toBe('/lightning/setup/ObjectManager/Acme_Order__c/FieldsAndRelationships/view');
  });

  it('refuses a component the vault does not hold', async () => {
    const r = await howToSeeHandler(fx.ctx, { componentId: 'CustomObject:Acme_Missing__c' });
    expect(r.ok).toBe(false);
  });
});
