/// <reference types="vitest/globals" />
/**
 * v4.1 — scale proof: full offline refresh on a large synthetic source tree.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/** Field count for scale-refresh test (override via SCALE_REFRESH_FIELD_COUNT). */
export const SCALE_REFRESH_FIELD_COUNT = Number(
  process.env.SCALE_REFRESH_FIELD_COUNT ?? '1000',
);

export const SCALE_REFRESH_BUDGET_MS = Number(
  process.env.SCALE_REFRESH_BUDGET_MS ?? '600000',
);

const objectXml = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>ScaleObj</label>
    <nameField><label>Name</label><type>Text</type></nameField>
    <pluralLabel>ScaleObjs</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`;

const fieldXml = (name: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${name}__c</fullName>
    <label>${name}</label>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
</CustomField>
`;

const writeSource = async (
  cwd: string,
  relPath: string,
  content: string,
): Promise<void> => {
  const full = join(cwd, 'org-kb', 'source', relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
};

const stageScaleSource = async (cwd: string, fieldCount: number): Promise<void> => {
  await writeSource(
    cwd,
    'main/default/objects/ScaleObj/ScaleObj.object-meta.xml',
    objectXml(),
  );
  for (let i = 0; i < fieldCount; i++) {
    await writeSource(
      cwd,
      `main/default/objects/ScaleObj/fields/F_${i}__c.field-meta.xml`,
      fieldXml(`F_${i}`),
    );
  }
};

describe('scale refresh (v4.1)', () => {
  it(
    `refreshes ${SCALE_REFRESH_FIELD_COUNT} custom fields within ${SCALE_REFRESH_BUDGET_MS}ms`,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'sfi-scale-refresh-'));
      try {
        const metaDir = join(cwd, 'org-kb', 'meta');
        await mkdir(metaDir, { recursive: true });
        await writeFile(
          join(metaDir, 'config.json'),
          JSON.stringify({
            targetOrg: 'scale-test',
            vaultRoot: join(cwd, 'org-kb'),
            version: '0.1.0',
            createdAt: '2026-05-29T00:00:00.000Z',
            snapshotOnRefresh: false,
          }),
          'utf8',
        );

        await stageScaleSource(cwd, SCALE_REFRESH_FIELD_COUNT);

        const started = performance.now();
        const result = await runRefresh({
          cwd,
          noPull: true,
          types: 'CustomObject,CustomField',
        });
        const elapsed = performance.now() - started;

        expect(result.status).not.toBe('failed');
        expect(elapsed).toBeLessThan(SCALE_REFRESH_BUDGET_MS);

        const paths = vaultPaths(join(cwd, 'org-kb'));
        expect(await stat(paths.graphDb)).toBeDefined();
        const manifest = JSON.parse(
          await readFile(paths.manifest, 'utf8'),
        ) as { components: Record<string, number> };
        const fields = manifest.components['CustomField'] ?? 0;
        expect(fields).toBeGreaterThanOrEqual(SCALE_REFRESH_FIELD_COUNT - 10);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SCALE_REFRESH_BUDGET_MS + 60_000,
  );
});
