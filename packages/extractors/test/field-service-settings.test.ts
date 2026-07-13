/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractFieldServiceSettings } from '../src/field-service-settings.js';

/**
 * Write a `settings/FieldService.settings-meta.xml`-style file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the absolute
 * path.
 */
const writeTempFieldServiceSettingsXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-fsl-settings-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractFieldServiceSettings', () => {
  describe('happy path', () => {
    it('extracts fieldServiceEnabled, workOrdersEnabled, and schedulingOptimizationEnabled into one org-level node', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FieldServiceSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldServiceOrgPref>true</fieldServiceOrgPref>
  <enableWorkOrders>true</enableWorkOrders>
  <o2EngineEnabled>false</o2EngineEnabled>
</FieldServiceSettings>`;
      const { dir, path } = await writeTempFieldServiceSettingsXml(
        'FieldService.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractFieldServiceSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('FieldServiceSettings:default');
        expect(node.type).toBe('FieldServiceSettings');
        expect(node.apiName).toBe('FieldServiceSettings');
        expect(node.label).toBe('Field Service Settings');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.properties['fieldServiceEnabled']).toBe(true);
        expect(node.properties['workOrdersEnabled']).toBe(true);
        expect(node.properties['schedulingOptimizationEnabled']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('surfaces absent policy elements as null (distinguishing "not declared" from "disabled")', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FieldServiceSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <isLocationHistoryEnabled>false</isLocationHistoryEnabled>
</FieldServiceSettings>`;
      const { dir, path } = await writeTempFieldServiceSettingsXml(
        'FieldService.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractFieldServiceSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['fieldServiceEnabled']).toBeNull();
        expect(node.properties['workOrdersEnabled']).toBeNull();
        expect(node.properties['schedulingOptimizationEnabled']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edges', () => {
    it('emits zero edges (FieldServiceSettings is an org-wide singleton with no references)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FieldServiceSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldServiceOrgPref>true</fieldServiceOrgPref>
</FieldServiceSettings>`;
      const { dir, path } = await writeTempFieldServiceSettingsXml(
        'FieldService.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractFieldServiceSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/FieldService.settings-meta.xml';
      const result = await extractFieldServiceSettings(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempFieldServiceSettingsXml(
        'FieldService.settings-meta.xml',
        '<?xml version="1.0"?><FieldServiceSettings><fieldServiceOrgPref>true</wrongClose></FieldServiceSettings>',
      );
      try {
        const result = await extractFieldServiceSettings(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <FieldServiceSettings>', async () => {
      const { dir, path } = await writeTempFieldServiceSettingsXml(
        'FieldService.settings-meta.xml',
        '<?xml version="1.0"?><SessionSettings><MFARequired>true</MFARequired></SessionSettings>',
      );
      try {
        const result = await extractFieldServiceSettings(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <FieldServiceSettings> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
