/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomTab } from '../src/custom-tab.js';

/** Write `content` to a `.tab-meta.xml` file under a fresh temp directory. */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-tab-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCustomTab — target edges (CUSTOM-TAB-TARGET-UNGRAPHED)', () => {
  // A Visualforce (`page`) tab points at a VisualforcePage via <page>. Before
  // the fix the extractor emitted zero edges for a page tab, so the target VF
  // page read as unused (`unused_components` flagged it deletable) and
  // "what does this tab open?" could not hop tab -> page on the graph.
  it('emits a references edge CustomTab -> VisualforcePage for a <page> tab', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My VF Tab</label>
    <motif>Custom53: Bell</motif>
    <page>My_VF_Page</page>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_VF_Tab.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetEdge = result.value.edges.find(
        (e) => e.toId === 'VisualforcePage:My_VF_Page',
      );
      expect(targetEdge).toBeDefined();
      if (!targetEdge) return;
      expect(targetEdge.fromId).toBe('CustomTab:My_VF_Tab');
      expect(targetEdge.edgeType).toBe('references');
      expect(targetEdge.confidence).toBe('declared');
      expect(targetEdge.source).toBe('custom-tab-extractor');
      expect(targetEdge.properties).toEqual({
        referenceKind: 'tabTarget',
        tabType: 'page',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits a references edge CustomTab -> FlexiPage for a <flexiPage> tab', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Flexi Tab</label>
    <motif>Custom53: Bell</motif>
    <flexiPage>My_Flexi_Page</flexiPage>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_Flexi_Tab.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([
        {
          fromId: 'CustomTab:My_Flexi_Tab',
          toId: 'FlexiPage:My_Flexi_Page',
          edgeType: 'references',
          confidence: 'declared',
          source: 'custom-tab-extractor',
          properties: { referenceKind: 'tabTarget', tabType: 'flexiPage' },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits a references edge CustomTab -> LightningComponentBundle for a <lwcComponent> tab', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My LWC Tab</label>
    <motif>Custom53: Bell</motif>
    <lwcComponent>myLwcCmp</lwcComponent>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_LWC_Tab.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges[0];
      expect(edge?.toId).toBe('LightningComponentBundle:myLwcCmp');
      expect(edge?.properties).toEqual({ referenceKind: 'tabTarget', tabType: 'lwc' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits a references edge CustomTab -> AuraDefinitionBundle for a <auraComponent> tab', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Aura Tab</label>
    <motif>Custom53: Bell</motif>
    <auraComponent>MyAuraCmp</auraComponent>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_Aura_Tab.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges[0];
      expect(edge?.toId).toBe('AuraDefinitionBundle:MyAuraCmp');
      expect(edge?.properties).toEqual({ referenceKind: 'tabTarget', tabType: 'aura' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A <url> (web) tab has no in-org destination component, so it must emit
  // NO target edge (targetName is null for url variants).
  it('emits no target edge for a <url> tab', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Web Tab</label>
    <motif>Custom53: Bell</motif>
    <url>https://example.invalid/page</url>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_Web_Tab.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // An object-variant tab keeps ONLY its existing CustomObject -> CustomTab
  // parentOf edge (for a __c object) — no self-referential target edge.
  it('keeps the object-variant parentOf edge and emits no target edge', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
    <customObject>true</customObject>
    <motif>Custom53: Bell</motif>
</CustomTab>`;
    const { dir, path } = await writeTempXml('My_Object__c.tab-meta.xml', xml);
    try {
      const result = await extractCustomTab(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([
        {
          fromId: 'CustomObject:My_Object__c',
          toId: 'CustomTab:My_Object__c',
          edgeType: 'parentOf',
          confidence: 'declared',
          source: 'custom-tab-extractor',
          properties: {},
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
