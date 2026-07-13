/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractTimeSheetTemplate } from '../src/time-sheet-template.js';

/**
 * Write a `timeSheetTemplates/{Name}.timeSheetTemplate-meta.xml`-style file
 * under a fresh temp directory. Returns the temp-dir root (for cleanup) and
 * the absolute path.
 */
const writeTempTimeSheetTemplateXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-time-sheet-template-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractTimeSheetTemplate', () => {
  describe('happy path', () => {
    it('extracts all required elements plus optional description', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <description>Standard weekly time sheet</description>
   <frequency>Weekly</frequency>
   <masterLabel>Standard Weekly</masterLabel>
   <startDate>2018-10-18</startDate>
   <workWeekEndDay>Sunday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Standard_Weekly.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('TimeSheetTemplate:Standard_Weekly');
        expect(node.type).toBe('TimeSheetTemplate');
        expect(node.apiName).toBe('Standard_Weekly');
        expect(node.label).toBe('Standard Weekly');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.properties['active']).toBe(true);
        expect(node.properties['frequency']).toBe('Weekly');
        expect(node.properties['masterLabel']).toBe('Standard Weekly');
        expect(node.properties['startDate']).toBe('2018-10-18');
        expect(node.properties['workWeekStartDay']).toBe('Monday');
        expect(node.properties['workWeekEndDay']).toBe('Sunday');
        expect(node.properties['description']).toBe('Standard weekly time sheet');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('omits description and assignedTo when absent (not defaulted)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>false</active>
   <frequency>Monthly</frequency>
   <masterLabel>Contractor Monthly</masterLabel>
   <startDate>2020-01-01</startDate>
   <workWeekEndDay>Friday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Contractor_Monthly.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['active']).toBe(false);
        expect(node.properties['description']).toBeNull();
        expect(Object.keys(node.properties)).not.toContain('assignedTo');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('assignments', () => {
    it('captures multiple <timeSheetTemplateAssignments><assignedTo> blocks, deduplicated + sorted, with NO edge', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <frequency>Daily</frequency>
   <masterLabel>Daily Field Techs</masterLabel>
   <startDate>2021-06-01</startDate>
   <workWeekEndDay>Saturday</workWeekEndDay>
   <workWeekStartDay>Sunday</workWeekStartDay>
   <timeSheetTemplateAssignments>
       <assignedTo>Field_Technician</assignedTo>
   </timeSheetTemplateAssignments>
   <timeSheetTemplateAssignments>
       <assignedTo>admin</assignedTo>
   </timeSheetTemplateAssignments>
   <timeSheetTemplateAssignments>
       <assignedTo>admin</assignedTo>
   </timeSheetTemplateAssignments>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Daily_Field_Techs.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['assignedTo']).toEqual(['Field_Technician', 'admin']);
        // No edge minted — the guide's "IDs" description is ambiguous
        // (Profile name vs opaque record Id); never fabricate a reference.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('handles a single (non-array) timeSheetTemplateAssignments occurrence', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <frequency>Daily</frequency>
   <masterLabel>label</masterLabel>
   <startDate>2018-10-18</startDate>
   <workWeekEndDay>Tuesday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
   <timeSheetTemplateAssignments>
       <assignedTo>admin</assignedTo>
   </timeSheetTemplateAssignments>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Solo.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['assignedTo']).toEqual(['admin']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edges', () => {
    it('emits zero edges', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <frequency>Weekly</frequency>
   <masterLabel>label</masterLabel>
   <startDate>2018-10-18</startDate>
   <workWeekEndDay>Sunday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'NoEdges.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
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
      const path = '/nonexistent/Missing.timeSheetTemplate-meta.xml';
      const result = await extractTimeSheetTemplate(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Bad.timeSheetTemplate-meta.xml',
        '<?xml version="1.0"?><TimeSheetTemplate><active>true</wrongClose></TimeSheetTemplate>',
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <TimeSheetTemplate>', async () => {
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'Wrong.timeSheetTemplate-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <TimeSheetTemplate> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a required element (masterLabel) is missing', async () => {
      const xml = `<?xml version="1.0"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <frequency>Weekly</frequency>
   <startDate>2018-10-18</startDate>
   <workWeekEndDay>Sunday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'NoMasterLabel.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <masterLabel>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a required element (frequency) is missing', async () => {
      const xml = `<?xml version="1.0"?>
<TimeSheetTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
   <active>true</active>
   <masterLabel>label</masterLabel>
   <startDate>2018-10-18</startDate>
   <workWeekEndDay>Sunday</workWeekEndDay>
   <workWeekStartDay>Monday</workWeekStartDay>
</TimeSheetTemplate>`;
      const { dir, path } = await writeTempTimeSheetTemplateXml(
        'NoFrequency.timeSheetTemplate-meta.xml',
        xml,
      );
      try {
        const result = await extractTimeSheetTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <frequency>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
