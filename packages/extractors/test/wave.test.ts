/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractWaveDashboard,
  extractWaveDataflow,
  extractWaveXmd,
  isObjectFieldRef,
} from '../src/wave.js';

const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-wave-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('isObjectFieldRef', () => {
  it('accepts single-dot Object.Field API names', () => {
    expect(isObjectFieldRef('Opportunity.StageName')).toBe(true);
    expect(isObjectFieldRef('Account.Industry__c')).toBe(true);
    expect(isObjectFieldRef('MyObj__c.Status__c')).toBe(true);
  });

  it('rejects bare columns, multi-hop paths, and empty segments', () => {
    expect(isObjectFieldRef('StageName')).toBe(false);
    expect(isObjectFieldRef('Sales')).toBe(false);
    expect(isObjectFieldRef('Account.Parent.Name')).toBe(false);
    expect(isObjectFieldRef('.StageName')).toBe(false);
    expect(isObjectFieldRef('Account.')).toBe(false);
    expect(isObjectFieldRef('')).toBe(false);
  });
});

describe('extractWaveDashboard', () => {
  it('extracts top-level meta and marks content as unmodeled', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveDashboard xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <content xsi:nil="true"/>
    <application>Synthetic_Analytics_App</application>
    <masterLabel>Ops Overview</masterLabel>
    <description>Synthetic CRMA dashboard fixture</description>
    <templateAssetSourceName>sfdc_internal__Ops</templateAssetSourceName>
    <dateVersion>1</dateVersion>
</WaveDashboard>`;
    const { dir, path } = await writeTempXml('Ops_Overview.wdash-meta.xml', xml);
    try {
      const result = await extractWaveDashboard(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('WaveDashboard:Ops_Overview');
      expect(node.type).toBe('WaveDashboard');
      expect(node.apiName).toBe('Ops_Overview');
      expect(node.label).toBe('Ops Overview');
      expect(node.properties['application']).toBe('Synthetic_Analytics_App');
      expect(node.properties['masterLabel']).toBe('Ops Overview');
      expect(node.properties['description']).toBe('Synthetic CRMA dashboard fixture');
      expect(node.properties['templateAssetSourceName']).toBe('sfdc_internal__Ops');
      expect(node.properties['dateVersion']).toBe('1');
      expect(node.properties['contentModeled']).toBe(false);
      expect(result.value.edges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to API name when masterLabel is absent', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveDashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <application>App1</application>
</WaveDashboard>`;
    const { dir, path } = await writeTempXml('Bare_Dash.wdash-meta.xml', xml);
    try {
      const result = await extractWaveDashboard(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]!.label).toBe('Bare_Dash');
      expect(result.value.nodes[0]!.properties['masterLabel']).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file-not-found / malformed-input on bad inputs', async () => {
    const missing = await extractWaveDashboard('/does/not/exist.wdash-meta.xml');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('file-not-found');

    const { dir, path } = await writeTempXml(
      'Wrong.wdash-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?><WaveDataflow xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>x</masterLabel></WaveDataflow>',
    );
    try {
      const result = await extractWaveDashboard(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractWaveDataflow', () => {
  it('extracts top-level meta and marks content as unmodeled', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveDataflow xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <content xsi:nil="true"/>
    <application>Synthetic_Analytics_App</application>
    <masterLabel>Daily Sync</masterLabel>
    <description>Synthetic CRMA dataflow fixture</description>
    <dataflowType>User</dataflowType>
</WaveDataflow>`;
    const { dir, path } = await writeTempXml('Daily_Sync.wdf-meta.xml', xml);
    try {
      const result = await extractWaveDataflow(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('WaveDataflow:Daily_Sync');
      expect(node.type).toBe('WaveDataflow');
      expect(node.label).toBe('Daily Sync');
      expect(node.properties['application']).toBe('Synthetic_Analytics_App');
      expect(node.properties['dataflowType']).toBe('User');
      expect(node.properties['contentModeled']).toBe(false);
      expect(result.value.edges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns malformed-input when the root is not WaveDataflow', async () => {
    const { dir, path } = await writeTempXml(
      'Wrong.wdf-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?><WaveDashboard xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>x</masterLabel></WaveDashboard>',
    );
    try {
      const result = await extractWaveDataflow(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractWaveXmd', () => {
  it('emits references edges for Object.Field dimension/measure customizations', async () => {
    // Synthetic fixture: field customizations that close the CRMA CustomField
    // blind spot. Names are synthetic — no live org identifiers.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveXmd xmlns="http://soap.sforce.com/2006/04/metadata">
    <application>Synthetic_Analytics_App</application>
    <dataset>Opportunity_Pipeline</dataset>
    <type>User</type>
    <dimensions>
        <field>Opportunity.StageName</field>
        <isDerived>false</isDerived>
        <label>Pipeline Stage</label>
        <origin>Opportunity.StageName</origin>
        <showInExplorer>true</showInExplorer>
        <sortIndex>0</sortIndex>
    </dimensions>
    <dimensions>
        <field>Account.Industry__c</field>
        <isDerived>false</isDerived>
        <label>Industry</label>
        <showInExplorer>false</showInExplorer>
        <sortIndex>1</sortIndex>
    </dimensions>
    <dimensions>
        <field>StageName</field>
        <isDerived>false</isDerived>
        <label>Bare column — no CustomField edge</label>
        <sortIndex>2</sortIndex>
    </dimensions>
    <measures>
        <field>Amount</field>
        <formatPrefix>$</formatPrefix>
        <isDerived>false</isDerived>
        <label>Amount (USD)</label>
        <origin>Opportunity.Amount</origin>
        <sortIndex>0</sortIndex>
    </measures>
    <measures>
        <field>DerivedCount</field>
        <isDerived>true</isDerived>
        <label>Derived — no CustomField edge</label>
        <sortIndex>1</sortIndex>
    </measures>
    <dates>
        <alias>CloseDate</alias>
        <firstDayOfWeek>0</firstDayOfWeek>
        <fiscalMonthOffset>0</fiscalMonthOffset>
        <label>Close Date</label>
        <sortIndex>0</sortIndex>
        <type>DateOnly</type>
    </dates>
</WaveXmd>`;
    const { dir, path } = await writeTempXml('Opportunity_Pipeline.xmd-meta.xml', xml);
    try {
      const result = await extractWaveXmd(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('WaveXmd:Opportunity_Pipeline');
      expect(node.type).toBe('WaveXmd');
      expect(node.label).toBe('Opportunity_Pipeline');
      expect(node.properties['dataset']).toBe('Opportunity_Pipeline');
      expect(node.properties['xmdType']).toBe('User');
      expect(node.properties['dimensionCount']).toBe(3);
      expect(node.properties['measureCount']).toBe(2);
      expect(node.properties['dateCount']).toBe(1);
      expect(node.properties['referencedFields']).toEqual([
        'Account.Industry__c',
        'Opportunity.Amount',
        'Opportunity.StageName',
      ]);

      expect(result.value.edges).toHaveLength(3);
      expect(result.value.edges).toEqual([
        {
          fromId: 'WaveXmd:Opportunity_Pipeline',
          toId: 'CustomField:Account.Industry__c',
          edgeType: 'references',
          confidence: 'declared',
          source: 'wave-xmd-extractor',
          properties: { referenceKind: 'waveXmdFieldCustomization' },
        },
        {
          fromId: 'WaveXmd:Opportunity_Pipeline',
          toId: 'CustomField:Opportunity.Amount',
          edgeType: 'references',
          confidence: 'declared',
          source: 'wave-xmd-extractor',
          properties: { referenceKind: 'waveXmdFieldCustomization' },
        },
        {
          fromId: 'WaveXmd:Opportunity_Pipeline',
          toId: 'CustomField:Opportunity.StageName',
          edgeType: 'references',
          confidence: 'declared',
          source: 'wave-xmd-extractor',
          properties: { referenceKind: 'waveXmdFieldCustomization' },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes identical Object.Field refs across dimensions and measures', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveXmd xmlns="http://soap.sforce.com/2006/04/metadata">
    <dataset>Dup_Dataset</dataset>
    <dimensions>
        <field>Account.Name</field>
        <isDerived>false</isDerived>
        <origin>Account.Name</origin>
        <sortIndex>0</sortIndex>
    </dimensions>
    <measures>
        <field>Account.Name</field>
        <isDerived>false</isDerived>
        <origin>Account.Name</origin>
        <sortIndex>0</sortIndex>
    </measures>
</WaveXmd>`;
    const { dir, path } = await writeTempXml('Dup_Dataset.xmd-meta.xml', xml);
    try {
      const result = await extractWaveXmd(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      expect(result.value.edges[0]!.toId).toBe('CustomField:Account.Name');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits zero edges when no Object.Field customizations are present', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WaveXmd xmlns="http://soap.sforce.com/2006/04/metadata">
    <dataset>Bare_Xmd</dataset>
    <dimensions>
        <field>Region</field>
        <isDerived>false</isDerived>
        <label>Region</label>
        <sortIndex>0</sortIndex>
    </dimensions>
</WaveXmd>`;
    const { dir, path } = await writeTempXml('Bare_Xmd.xmd-meta.xml', xml);
    try {
      const result = await extractWaveXmd(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
      expect(Object.keys(result.value.nodes[0]!.properties)).not.toContain('referencedFields');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file-not-found / malformed-input on bad inputs', async () => {
    const missing = await extractWaveXmd('/does/not/exist.xmd-meta.xml');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('file-not-found');

    const { dir, path } = await writeTempXml(
      'Wrong.xmd-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?><WaveDashboard xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>x</masterLabel></WaveDashboard>',
    );
    try {
      const result = await extractWaveXmd(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
