/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';
import { SETUP_AUDIT_TRAIL_FILENAME } from '../src/setup-audit-trail.js';

/**
 * #39 — `runRefresh --with-audit-trail` with injectable SOQL (no live org).
 */

const seedVault = async (cwd: string): Promise<{ readonly vaultRoot: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(paths.source, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'fixture',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-27T00:00:00.000Z',
    }),
    'utf8',
  );
  const classesDir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(classesDir, { recursive: true });
  await writeFile(
    join(classesDir, 'AlphaController.cls'),
    `public class AlphaController { public static void greet() { System.debug('hi'); } }`,
    'utf8',
  );
  await writeFile(
    join(classesDir, 'AlphaController.cls-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
  return { vaultRoot };
};

describe('runRefresh with --with-audit-trail', () => {
  it('persists SetupAuditTrail rows via injectable SOQL and leaves default refresh offline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-audit-'));
    try {
      const { vaultRoot } = await seedVault(cwd);
      const queries: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        withAuditTrail: true,
        auditTrailSoql: async (query) => {
          queries.push(query);
          return [
            {
              Id: '0Axxx0000001',
              Action: 'changedApexClass',
              Section: 'Apex Class',
              CreatedDate: '2026-06-01T10:00:00.000Z',
              Display: 'Changed Apex Class AlphaController',
              CreatedBy: { Name: 'Fixture Admin' },
            },
          ];
        },
      });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.auditTrail).toBeDefined();
      expect(result.auditTrail?.outcome).toBe('ok');
      expect(result.auditTrail?.appended).toBe(1);
      expect(queries.some((q) => q.includes('FROM SetupAuditTrail'))).toBe(true);
      expect(queries.some((q) => q.includes('LAST_N_DAYS:180'))).toBe(true);

      const raw = await readFile(
        join(vaultPaths(vaultRoot).meta, SETUP_AUDIT_TRAIL_FILENAME),
        'utf8',
      );
      expect(raw).toContain('0Axxx0000001');
      expect(raw).toContain('AlphaController');
      // Leak guard: the synthetic fixture must never surface a real user
      // email / org domain (real SetupAuditTrail rows carry them).
      expect(raw).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not query SetupAuditTrail when --with-audit-trail is unset', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-no-audit-'));
    try {
      await seedVault(cwd);
      let called = false;
      const result = await runRefresh({
        cwd,
        noPull: true,
        auditTrailSoql: async () => {
          called = true;
          return [];
        },
      });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.auditTrail).toBeUndefined();
      expect(called).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps refresh status green when the audit-trail SOQL throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-audit-fail-'));
    try {
      await seedVault(cwd);
      const result = await runRefresh({
        cwd,
        noPull: true,
        withAuditTrail: true,
        auditTrailSoql: async () => {
          throw new Error('synthetic audit soql failure');
        },
      });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.auditTrail?.outcome).toBe('query-failed');
      expect(result.auditTrail?.message).toContain('synthetic audit soql failure');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
