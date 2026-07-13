/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import {
  extractGenAiFunction,
  extractGenAiPlannerBundle,
  extractGenAiPlugin,
  extractGenAiPromptTemplate,
} from '../src/gen-ai.js';

/**
 * Write `content` to `relPath` under a fresh temp directory (creating any
 * intermediate directories — GenAiPlannerBundle nests under
 * `genAiPlannerBundles/{agent}/`). Returns the temp-dir root (for cleanup)
 * and the absolute file path. Fixtures use SYNTHETIC agent/topic/field names.
 */
const writeTempXml = async (
  relPath: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-gen-ai-'));
  const path = join(dir, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** Find the single `references` edge whose target is `toId`, or fail. */
const edgeTo = (edges: readonly Edge[], toId: string): Edge | undefined =>
  edges.find((e) => e.toId === toId);

describe('extractGenAiFunction', () => {
  it('parses masterLabel/description and emits an apex invocation-target edge', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>look up an order's shipment status</description>
    <invocationTarget>Get_Order_Status</invocationTarget>
    <invocationTargetType>apex</invocationTargetType>
    <isConfirmationRequired>false</isConfirmationRequired>
    <masterLabel>get_order_status</masterLabel>
</GenAiFunction>`;
    const { dir, path } = await writeTempXml(
      'genAiFunctions/Get_Order_Status.genAiFunction-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiFunction(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('GenAiFunction:Get_Order_Status');
      expect(node.type).toBe('GenAiFunction');
      expect(node.apiName).toBe('Get_Order_Status');
      expect(node.label).toBe('get_order_status');
      expect(node.parentId).toBeNull();
      expect(node.properties['invocationTarget']).toBe('Get_Order_Status');
      expect(node.properties['invocationTargetType']).toBe('apex');
      expect(node.properties['isConfirmationRequired']).toBe(false);

      const edge = edgeTo(result.value.edges, 'ApexClass:Get_Order_Status');
      expect(edge).toBeDefined();
      expect(edge?.edgeType).toBe('references');
      expect(edge?.confidence).toBe('declared');
      expect(edge?.properties['referenceKind']).toBe('genAiFunctionApexTarget');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits a flow invocation-target edge for invocationTargetType=flow', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="http://soap.sforce.com/2006/04/metadata">
    <invocationTarget>Escalate_Case</invocationTarget>
    <invocationTargetType>flow</invocationTargetType>
    <masterLabel>escalate_case</masterLabel>
</GenAiFunction>`;
    const { dir, path } = await writeTempXml(
      'genAiFunctions/Escalate_Case.genAiFunction-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiFunction(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = edgeTo(result.value.edges, 'Flow:Escalate_Case');
      expect(edge?.properties['referenceKind']).toBe('genAiFunctionFlowTarget');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mints NO edge for a non-apex/flow invocation type (api/externalService)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="http://soap.sforce.com/2006/04/metadata">
    <invocationTarget>SomeExternalService</invocationTarget>
    <invocationTargetType>externalService</invocationTargetType>
    <masterLabel>call_service</masterLabel>
</GenAiFunction>`;
    const { dir, path } = await writeTempXml(
      'genAiFunctions/Call_Service.genAiFunction-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiFunction(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(0);
      expect(result.value.nodes[0]?.properties['invocationTargetType']).toBe('externalService');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractGenAiPlugin', () => {
  it('emits one references edge per member functionName (multiple blocks)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlugin xmlns="http://soap.sforce.com/2006/04/metadata">
    <developerName>Order_Management</developerName>
    <masterLabel>Order Management</masterLabel>
    <language>en_US</language>
    <description>Handle order status and returns</description>
    <pluginType>Topic</pluginType>
    <scope>Answer questions about a customer's orders</scope>
    <canEscalate>true</canEscalate>
    <genAiFunctions>
        <functionName>Get_Order_Status</functionName>
    </genAiFunctions>
    <genAiFunctions>
        <functionName>Start_Return</functionName>
    </genAiFunctions>
</GenAiPlugin>`;
    const { dir, path } = await writeTempXml(
      'genAiPlugins/Order_Management.genAiPlugin-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPlugin(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.id).toBe('GenAiPlugin:Order_Management');
      expect(node?.label).toBe('Order Management');
      expect(node?.properties['pluginType']).toBe('Topic');
      expect(node?.properties['scope']).toBe("Answer questions about a customer's orders");
      expect(node?.properties['functionCount']).toBe(2);
      expect(node?.properties['functionNames']).toEqual(['Get_Order_Status', 'Start_Return']);

      expect(edgeTo(result.value.edges, 'GenAiFunction:Get_Order_Status')?.properties['referenceKind']).toBe(
        'genAiPluginFunction',
      );
      expect(edgeTo(result.value.edges, 'GenAiFunction:Start_Return')).toBeDefined();
      expect(result.value.edges).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a topic with zero functions', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlugin xmlns="http://soap.sforce.com/2006/04/metadata">
    <developerName>Empty_Topic</developerName>
    <masterLabel>Empty Topic</masterLabel>
    <language>en_US</language>
    <pluginType>Topic</pluginType>
</GenAiPlugin>`;
    const { dir, path } = await writeTempXml(
      'genAiPlugins/Empty_Topic.genAiPlugin-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPlugin(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.properties['functionCount']).toBe(0);
      expect(result.value.edges).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractGenAiPlannerBundle', () => {
  it('derives apiName from the nested basename and emits plugin + function edges', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Order Support Agent</masterLabel>
    <description>Helps customers with orders and returns</description>
    <plannerType>AiCopilot__ReAct</plannerType>
    <capabilities>Reasoning</capabilities>
    <capabilities>Grounding</capabilities>
    <genAiPlugins>
        <genAiPluginName>Order_Management</genAiPluginName>
    </genAiPlugins>
    <genAiPlugins>
        <genAiPluginName>Billing_Questions</genAiPluginName>
    </genAiPlugins>
    <genAiFunctions>
        <genAiFunctionName>Get_Knowledge_Article</genAiFunctionName>
    </genAiFunctions>
</GenAiPlannerBundle>`;
    // Nested folder-per-agent layout: genAiPlannerBundles/{agent}/{agent}...
    const { dir, path } = await writeTempXml(
      'genAiPlannerBundles/Order_Support_Agent/Order_Support_Agent.genAiPlannerBundle-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPlannerBundle(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.id).toBe('GenAiPlannerBundle:Order_Support_Agent');
      expect(node?.label).toBe('Order Support Agent');
      expect(node?.properties['plannerType']).toBe('AiCopilot__ReAct');
      expect(node?.properties['capabilities']).toEqual(['Reasoning', 'Grounding']);
      expect(node?.properties['pluginCount']).toBe(2);
      expect(node?.properties['functionCount']).toBe(1);

      expect(edgeTo(result.value.edges, 'GenAiPlugin:Order_Management')?.properties['referenceKind']).toBe(
        'plannerBundlePlugin',
      );
      expect(edgeTo(result.value.edges, 'GenAiPlugin:Billing_Questions')).toBeDefined();
      expect(edgeTo(result.value.edges, 'GenAiFunction:Get_Knowledge_Article')?.properties['referenceKind']).toBe(
        'plannerBundleFunction',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractGenAiPromptTemplate', () => {
  it('resolves grounding merge-fields via declared SObject inputs (declared field edges)', async () => {
    // {!$Input:Guest.Loyalty_Number__c} resolves because the Guest input is a
    // declared SOBJECT://Contact. {!$Input:Account.Industry} resolves via the
    // Account input. {!$Input:Guest} (no field) grounds on the object.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Draft Loyalty Follow-up</masterLabel>
    <type>einstein_gpt__flex</type>
    <visibility>Global</visibility>
    <templateVersions>
        <content>Hi {!$Input:Guest.Name}, your loyalty number {!$Input:Guest.Loyalty_Number__c} for {!$Input:Account.Industry}. Ground: {!$Input:Guest}</content>
        <inputs>
            <apiName>Guest</apiName>
            <definition>SOBJECT://Contact</definition>
            <referenceName>Input:Guest</referenceName>
            <required>true</required>
        </inputs>
        <inputs>
            <apiName>Account</apiName>
            <definition>SOBJECT://Account</definition>
            <referenceName>Input:Account</referenceName>
            <required>true</required>
        </inputs>
        <versionNumber>1</versionNumber>
    </templateVersions>
</GenAiPromptTemplate>`;
    const { dir, path } = await writeTempXml(
      'genAiPromptTemplates/Draft_Loyalty_Followup.genAiPromptTemplate-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPromptTemplate(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.id).toBe('GenAiPromptTemplate:Draft_Loyalty_Followup');
      expect(node?.label).toBe('Draft Loyalty Follow-up');
      expect(node?.properties['templateType']).toBe('einstein_gpt__flex');
      expect(node?.properties['versionCount']).toBe(1);

      // Field grounding resolves via the declared SObject inputs.
      expect(edgeTo(result.value.edges, 'CustomField:Contact.Name')?.properties['referenceKind']).toBe(
        'promptTemplateGroundingField',
      );
      expect(edgeTo(result.value.edges, 'CustomField:Contact.Loyalty_Number__c')).toBeDefined();
      expect(edgeTo(result.value.edges, 'CustomField:Account.Industry')).toBeDefined();
      // Object-level ground ({!$Input:Guest} with no field).
      expect(edgeTo(result.value.edges, 'CustomObject:Contact')?.properties['referenceKind']).toBe(
        'promptTemplateGroundingObject',
      );
      const grounding = node?.properties['groundingFieldRefs'] as readonly string[];
      expect(grounding).toContain('CustomField:Contact.Loyalty_Number__c');
      expect(node?.properties['unresolvedGroundingRefs']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discloses undeclared / primitive / relationship-traversal merge-fields instead of minting phantoms', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Mixed Grounding</masterLabel>
    <type>einstein_gpt__flex</type>
    <templateVersions>
        <content>Undeclared {!$Input:Mystery.Secret__c}; primitive {!$Input:Tone.Value}; traversal {!$Input:Guest.Account.Name}</content>
        <inputs>
            <apiName>Tone</apiName>
            <definition>primitive://String</definition>
            <referenceName>Input:Tone</referenceName>
        </inputs>
        <inputs>
            <apiName>Guest</apiName>
            <definition>SOBJECT://Contact</definition>
            <referenceName>Input:Guest</referenceName>
        </inputs>
    </templateVersions>
</GenAiPromptTemplate>`;
    const { dir, path } = await writeTempXml(
      'genAiPromptTemplates/Mixed_Grounding.genAiPromptTemplate-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPromptTemplate(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No phantom field edge for the undeclared input or the primitive input.
      expect(edgeTo(result.value.edges, 'CustomField:Mystery.Secret__c')).toBeUndefined();
      expect(edgeTo(result.value.edges, 'CustomField:Tone.Value')).toBeUndefined();
      // No phantom for the relationship traversal leaf either.
      expect(result.value.edges.some((e) => e.toId.startsWith('CustomField:Account'))).toBe(false);
      const unresolved = result.value.nodes[0]?.properties['unresolvedGroundingRefs'] as readonly string[];
      expect(unresolved).toContain('$Input:Mystery.Secret__c');
      expect(unresolved).toContain('$Input:Tone.Value');
      expect(unresolved).toContain('$Input:Guest.Account.Name');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures relatedEntity/relatedField and Flow/Apex data providers', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Summarize Account</masterLabel>
    <type>einstein_gpt__field</type>
    <relatedEntity>Account</relatedEntity>
    <relatedField>Description</relatedField>
    <templateVersions>
        <content>Summary using {!$Flow:Fetch_Products.Prompt} and {!$Apex:GetTerritory.Result}</content>
        <templateDataProviders>
            <definition>flow://Fetch_Related_Cases</definition>
            <referenceName>Flow:Fetch_Related_Cases</referenceName>
        </templateDataProviders>
        <templateDataProviders>
            <definition>apex://AccountEnricher</definition>
            <referenceName>Apex:AccountEnricher</referenceName>
        </templateDataProviders>
    </templateVersions>
</GenAiPromptTemplate>`;
    const { dir, path } = await writeTempXml(
      'genAiPromptTemplates/Summarize_Account.genAiPromptTemplate-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPromptTemplate(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(edgeTo(result.value.edges, 'CustomObject:Account')?.properties['referenceKind']).toBe(
        'promptTemplateRelatedEntity',
      );
      expect(edgeTo(result.value.edges, 'CustomField:Account.Description')?.properties['referenceKind']).toBe(
        'promptTemplateRelatedField',
      );
      // Content merge-field data providers.
      expect(edgeTo(result.value.edges, 'Flow:Fetch_Products')?.properties['referenceKind']).toBe(
        'promptTemplateDataProvider',
      );
      expect(edgeTo(result.value.edges, 'ApexClass:GetTerritory')).toBeDefined();
      // Structural data-provider definitions.
      expect(edgeTo(result.value.edges, 'Flow:Fetch_Related_Cases')).toBeDefined();
      expect(edgeTo(result.value.edges, 'ApexClass:AccountEnricher')).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes a field referenced as BOTH relatedField and a grounding merge-field into one edge', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Dup Field</masterLabel>
    <type>einstein_gpt__field</type>
    <relatedEntity>Account</relatedEntity>
    <relatedField>Industry</relatedField>
    <templateVersions>
        <content>Industry is {!$Input:Account.Industry}</content>
        <inputs>
            <apiName>Account</apiName>
            <definition>SOBJECT://Account</definition>
            <referenceName>Input:Account</referenceName>
        </inputs>
    </templateVersions>
</GenAiPromptTemplate>`;
    const { dir, path } = await writeTempXml(
      'genAiPromptTemplates/Dup_Field.genAiPromptTemplate-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPromptTemplate(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const industryEdges = result.value.edges.filter((e) => e.toId === 'CustomField:Account.Industry');
      // Exactly ONE edge (relatedField wins as first-priority), not two that
      // would collide on the (fromId,toId,edgeType,source) PK.
      expect(industryEdges).toHaveLength(1);
      expect(industryEdges[0]?.properties['referenceKind']).toBe('promptTemplateRelatedField');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('errors on a wrong root element', async () => {
    const xml = `<?xml version="1.0"?><NotAPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>x</masterLabel></NotAPromptTemplate>`;
    const { dir, path } = await writeTempXml(
      'genAiPromptTemplates/Bad.genAiPromptTemplate-meta.xml',
      xml,
    );
    try {
      const result = await extractGenAiPromptTemplate(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file-not-found for a missing file', async () => {
    const result = await extractGenAiPromptTemplate('/nonexistent/Missing.genAiPromptTemplate-meta.xml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('file-not-found');
  });
});
