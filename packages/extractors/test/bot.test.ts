/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { extractBot, extractBotVersion } from '../src/bot.js';

/**
 * Write `content` to `relPath` under a fresh temp directory (creating any
 * intermediate directories — Bot/BotVersion nest under `bots/{BotName}/`,
 * mirroring `gen-ai.test.ts`'s `genAiPlannerBundles/{agent}/` fixture helper).
 * Fixtures use SYNTHETIC bot/version names — no real org identifiers, per
 * privacy policy (the real shapes were verified against two live orgs; only
 * the STRUCTURE is mirrored here, never a real bot/agent name).
 */
const writeTempXml = async (
  relPath: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-bot-'));
  const path = join(dir, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

const edgeTo = (edges: readonly Edge[], toId: string): Edge | undefined =>
  edges.find((e) => e.toId === toId);

describe('extractBot', () => {
  it('parses an Agentforce-template bot and counts contextVariables', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="http://soap.sforce.com/2006/04/metadata">
    <agentTemplate>AiCopilot__AgentforceAgent</agentTemplate>
    <agentType>EinsteinServiceAgent</agentType>
    <botMlDomain>
        <label>Campus Support Agent</label>
        <name>Campus_Support_Agent</name>
    </botMlDomain>
    <botSource>None</botSource>
    <botUser>agentuser@example.invalid</botUser>
    <contextVariables>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserContactId</fieldName>
            <messageType>EmbeddedMessaging</messageType>
        </contextVariableMappings>
        <dataType>Text</dataType>
        <developerName>ChannelType</developerName>
        <includeInPrompt>true</includeInPrompt>
        <label>Channel Type</label>
    </contextVariables>
    <contextVariables>
        <dataType>Text</dataType>
        <developerName>ChatSessionId</developerName>
        <includeInPrompt>false</includeInPrompt>
        <label>Chat Session Id</label>
    </contextVariables>
    <description>Answers campus support questions.</description>
    <label>Agent Plum</label>
    <logPrivateConversationData>false</logPrivateConversationData>
    <richContentEnabled>true</richContentEnabled>
    <sessionTimeout>0</sessionTimeout>
    <type>ExternalCopilot</type>
</Bot>`;
    const { dir, path } = await writeTempXml(
      'bots/Campus_Support_Agent/Campus_Support_Agent.bot-meta.xml',
      xml,
    );
    try {
      const result = await extractBot(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('Bot:Campus_Support_Agent');
      expect(node.type).toBe('Bot');
      expect(node.apiName).toBe('Campus_Support_Agent');
      // Bot's OWN top-level <label> (distinct from the nested botMlDomain
      // label) — the collision the flat enterprise-metadata scanner cannot
      // safely resolve is exactly why this is a dedicated XMLParser extractor.
      expect(node.label).toBe('Agent Plum');
      expect(node.parentId).toBeNull();
      expect(node.properties['description']).toBe('Answers campus support questions.');
      expect(node.properties['type']).toBe('ExternalCopilot');
      expect(node.properties['agentType']).toBe('EinsteinServiceAgent');
      expect(node.properties['agentTemplate']).toBe('AiCopilot__AgentforceAgent');
      expect(node.properties['botSource']).toBe('None');
      expect(node.properties['botUser']).toBe('agentuser@example.invalid');
      expect(node.properties['richContentEnabled']).toBe(true);
      expect(node.properties['logPrivateConversationData']).toBe(false);
      expect(node.properties['sessionTimeout']).toBe('0');
      expect(node.properties['contextVariableCount']).toBe(2);
      expect(node.properties['contextVariableFieldRefs']).toEqual([
        'CustomField:MessagingSession.EndUserContactId',
      ]);
      expect(node.properties['botMlDomain']).toEqual({
        label: 'Campus Support Agent',
        name: 'Campus_Support_Agent',
      });
      // Context-variable field mappings become declared references edges;
      // the Bot -> BotVersion parentOf edge is still emitted by the
      // BotVersion extractor (child owns the parent edge).
      expect(result.value.edges).toHaveLength(1);
      const ctxEdge = result.value.edges[0];
      expect(ctxEdge?.toId).toBe('CustomField:MessagingSession.EndUserContactId');
      expect(ctxEdge?.properties['referenceKind']).toBe('botContextVariableField');
      expect(ctxEdge?.properties['includeInPrompt']).toBe(true);
      expect(ctxEdge?.properties['contextVariable']).toBe('ChannelType');
      expect(ctxEdge?.confidence).toBe('declared');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a legacy from-scratch bot with no agentTemplate/agentType/botUser/botMlDomain label collision risk', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="http://soap.sforce.com/2006/04/metadata">
    <botMlDomain>
        <label>Legacy Bot</label>
        <name>Legacy_Bot</name>
    </botMlDomain>
    <botSource>None</botSource>
    <description>A bot from scratch.</description>
    <label>Legacy Bot Display Name</label>
    <logPrivateConversationData>false</logPrivateConversationData>
    <richContentEnabled>true</richContentEnabled>
    <sessionTimeout>0</sessionTimeout>
    <type>Bot</type>
</Bot>`;
    const { dir, path } = await writeTempXml(
      'bots/Legacy_Bot/Legacy_Bot.bot-meta.xml',
      xml,
    );
    try {
      const result = await extractBot(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // The generic flat scanner would take the FIRST <label> in document
      // order (botMlDomain's "Legacy Bot"), not the Bot's own top-level
      // <label> ("Legacy Bot Display Name") — this asserts the dedicated
      // XMLParser extractor resolves the RIGHT one via structural scoping.
      expect(node.label).toBe('Legacy Bot Display Name');
      expect(node.properties['botMlDomain']).toEqual({ label: 'Legacy Bot', name: 'Legacy_Bot' });
      expect(node.properties['type']).toBe('Bot');
      expect('agentType' in node.properties).toBe(false);
      expect('agentTemplate' in node.properties).toBe(false);
      expect('botUser' in node.properties).toBe(false);
      expect(node.properties['contextVariableCount']).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns malformed-input for a non-Bot root', async () => {
    const { dir, path } = await writeTempXml(
      'bots/Broken/Broken.bot-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?><NotABot/>',
    );
    try {
      const result = await extractBot(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractBotVersion', () => {
  it('derives a directory-disambiguated apiName, counts dialogs, and emits parentOf + planner references edges', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<BotVersion xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>v3</fullName>
    <articleAnswersGPTEnabled>false</articleAnswersGPTEnabled>
    <botDialogs>
        <developerName>Welcome</developerName>
        <label>Welcome</label>
    </botDialogs>
    <botDialogs>
        <developerName>Error_Handler</developerName>
        <label>Error Handler</label>
    </botDialogs>
    <citationsEnabled>false</citationsEnabled>
    <conversationDefinitionPlanners>
        <genAiPlannerName>Campus_Support_Agent_v3</genAiPlannerName>
    </conversationDefinitionPlanners>
    <entryDialog>Welcome</entryDialog>
    <knowledgeFallbackEnabled>false</knowledgeFallbackEnabled>
    <toneType>Casual</toneType>
</BotVersion>`;
    const { dir, path } = await writeTempXml(
      'bots/Campus_Support_Agent/v3.botVersion-meta.xml',
      xml,
    );
    try {
      const result = await extractBotVersion(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // Directory-disambiguated: filename alone ("v3") would collide across
      // every bot in the org — every bot has its own "v3".
      expect(node.id).toBe('BotVersion:Campus_Support_Agent.v3');
      expect(node.apiName).toBe('Campus_Support_Agent.v3');
      expect(node.parentId).toBe('Bot:Campus_Support_Agent');
      expect(node.properties['dialogCount']).toBe(2);
      expect(node.properties['intentCount']).toBe(0);
      expect(node.properties['entryDialog']).toBe('Welcome');
      expect(node.properties['toneType']).toBe('Casual');
      expect(node.properties['knowledgeFallbackEnabled']).toBe('false');
      expect(node.properties['citationsEnabled']).toBe('false');
      expect(node.properties['plannerNames']).toEqual(['Campus_Support_Agent_v3']);

      const parentEdge = result.value.edges.find((e) => e.edgeType === 'parentOf');
      expect(parentEdge).toBeDefined();
      expect(parentEdge?.fromId).toBe('Bot:Campus_Support_Agent');
      expect(parentEdge?.toId).toBe('BotVersion:Campus_Support_Agent.v3');
      expect(parentEdge?.confidence).toBe('declared');

      const plannerEdge = edgeTo(result.value.edges, 'GenAiPlannerBundle:Campus_Support_Agent_v3');
      expect(plannerEdge).toBeDefined();
      expect(plannerEdge?.fromId).toBe('BotVersion:Campus_Support_Agent.v3');
      expect(plannerEdge?.edgeType).toBe('references');
      expect(plannerEdge?.confidence).toBe('declared');
      expect(plannerEdge?.properties['referenceKind']).toBe('botVersionPlanner');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts legacy <botIntents> and tolerates zero planner references (dialog-tree-only bot)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<BotVersion xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>v1</fullName>
    <botDialogs>
        <developerName>Welcome</developerName>
    </botDialogs>
    <botIntents>
        <intentName>Reset_Password</intentName>
    </botIntents>
    <botIntents>
        <intentName>Check_Status</intentName>
    </botIntents>
    <mainMenuDialog>Welcome</mainMenuDialog>
</BotVersion>`;
    const { dir, path } = await writeTempXml(
      'bots/Legacy_Bot/v1.botVersion-meta.xml',
      xml,
    );
    try {
      const result = await extractBotVersion(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('BotVersion:Legacy_Bot.v1');
      expect(node.properties['dialogCount']).toBe(1);
      expect(node.properties['intentCount']).toBe(2);
      expect(node.properties['plannerNames']).toEqual([]);
      expect('entryDialog' in node.properties).toBe(false);

      // Still emits the parentOf edge; zero references edges (no planner).
      const edgeTypes = result.value.edges.map((e) => e.edgeType).sort();
      expect(edgeTypes).toEqual(['parentOf']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('derives the bot name from whatever the immediate parent directory is, even outside bots/', async () => {
    // `extractBotVersion` trusts the dispatcher (`segments.includes('bots')`)
    // to have already confirmed the file lives under `bots/`; called
    // directly (as this test does, bypassing the dispatcher) it derives the
    // bot name from the immediate parent directory VERBATIM, whatever that
    // directory happens to be named — `deriveParentApiName(path, 1)` only
    // returns '' for a bare filename with NO directory component at all
    // (impossible to reach via a real, readable file path; `process.chdir`
    // — the only way to construct that case — is unsupported in vitest's
    // worker pool, per this suite's existing convention).
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<BotVersion xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>v1</fullName>
</BotVersion>`;
    const { dir, path } = await writeTempXml('Stray/v1.botVersion-meta.xml', xml);
    try {
      const result = await extractBotVersion(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('BotVersion:Stray.v1');
      expect(result.value.nodes[0]?.parentId).toBe('Bot:Stray');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
