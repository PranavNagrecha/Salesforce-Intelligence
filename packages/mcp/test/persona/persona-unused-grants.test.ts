/// <reference types="vitest/globals" />

import { readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { personaUnusedGrantsHandler } from '../../src/tools/persona-unused-grants.js';

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

describe('sfi.persona_unused_grants', () => {
  it('classifies every granted operation from what the persona can actually run', async () => {
    const r = must(await personaUnusedGrantsHandler(fx.ctx, { permissionSets: ['Acme_Portal'] }));
    const status = Object.fromEntries(
      r.data.objects.map((o) => [o.object, Object.fromEntries(Object.entries(o.ops).map(([op, v]) => [op, v.status]))]),
    );
    expect(status).toEqual({
      Acme_Audit__c: { create: 'USED' },
      Acme_Batch_Status__c: { create: 'UNUSED', edit: 'UNUSED' },
      Acme_Log__c: { create: 'USED' },
      Acme_Note__c: { edit: 'UNKNOWN' },
      // The Load creates Orders but never updates them (no Id mapped); the open
      // generic helper could be handed an Order, so edit is UNKNOWN — never UNUSED.
      Acme_Order__c: { create: 'USED', edit: 'UNKNOWN' },
      Acme_Signal__e: { create: 'USED' },
    });
    expect(r.data.appliedScope.containers).toEqual(['PermissionSet:Acme_Portal']);
  });

  it('reports UNUSED_EDIT on the object nothing reachable writes, never on the logger-written one', async () => {
    const r = must(await personaUnusedGrantsHandler(fx.ctx, { permissionSets: ['Acme_Portal'] }));
    const codes = r.data.findings.map((f) => [f.code, (f.evidence['object'] as string) ?? '', f.verdict]);
    expect(codes).toContainEqual(['UNUSED_EDIT', 'Acme_Batch_Status__c', 'defect']);
    expect(codes).toContainEqual(['UNUSED_CREATE', 'Acme_Batch_Status__c', 'defect']);
    expect(codes.filter(([, object]) => object === 'Acme_Log__c')).toEqual([]);
    const unusedEdit = r.data.findings.find((f) => f.code === 'UNUSED_EDIT');
    expect(unusedEdit?.componentId).toBe('PermissionSet:Acme_Portal');
    expect(unusedEdit?.line).toBeGreaterThan(0);
  });

  it('marks the generic-helper object UNKNOWN with the reason, and the system-mode-only use', async () => {
    const r = must(await personaUnusedGrantsHandler(fx.ctx, { permissionSets: ['Acme_Portal'] }));
    const note = r.data.objects.find((o) => o.object === 'Acme_Note__c');
    expect(note?.ops.edit?.unknownReasons?.[0]).toMatch(/Acme_GenericDml\.saveAny/);
    const audit = r.data.findings.find((f) => f.code === 'USED_ONLY_IN_SYSTEM_MODE');
    expect(audit?.evidence['object']).toBe('Acme_Audit__c');
    expect(r.data.objects.find((o) => o.object === 'Acme_Audit__c')?.ops.create?.systemModeOnly).toBe(true);
  });

  it('checks field edit grants against the fields reachable writers write', async () => {
    const r = must(await personaUnusedGrantsHandler(fx.ctx, { permissionSets: ['Acme_Portal'] }));
    const order = r.data.objects.find((o) => o.object === 'Acme_Order__c');
    expect(order?.fieldEdits).toMatchObject({ editable: 3, written: 2, status: 'UNUSED', notWritten: ['Acme_Order__c.Acme_Internal_Code__c'] });
    expect(r.data.findings.some((f) => f.code === 'UNUSED_FIELD_EDIT' && f.verdict === 'defect')).toBe(true);
  });

  it('resolves a persona declared in org-kb/config/personas.json, and refuses an unknown one', async () => {
    mkdirSync(join(fx.vaultRoot, 'config'), { recursive: true });
    writeFileSync(join(fx.vaultRoot, 'config', 'personas.json'), JSON.stringify({ personas: { 'Portal user': { permissionSets: ['Acme_Portal'] } } }));
    const r = must(await personaUnusedGrantsHandler(fx.ctx, { persona: 'portal user' }));
    expect(r.data.appliedScope).toMatchObject({ name: 'Portal user', source: 'config', containers: ['PermissionSet:Acme_Portal'] });
    const missing = await personaUnusedGrantsHandler(fx.ctx, { persona: 'Nobody' });
    expect(missing.ok).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER (CH-8): an unreadable reachable Apex file is disclosed, not silently skipped', async () => {
    const find = (dir: string): string | null => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          const hit = find(p);
          if (hit !== null) return hit;
        } else if (e.name === 'Acme_Notes.cls') return p;
      }
      return null;
    };
    const file = find(fx.vaultRoot);
    expect(file).not.toBeNull();
    if (file === null) return;
    renameSync(file, `${file}.moved`);
    try {
      const r = must(await personaUnusedGrantsHandler(fx.ctx, { permissionSets: ['Acme_Portal'] }));
      // Before: the read error was a bare `continue` — no limitation, `complete`.
      expect(r.data.trust.limitations.some((l) => l.includes('could not be read'))).toBe(true);
      expect(r.data.trust.completeness.status).toBe('partial');
    } finally {
      renameSync(`${file}.moved`, file);
    }
  });
});
