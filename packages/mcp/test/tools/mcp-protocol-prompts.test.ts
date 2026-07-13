/**
 * MCP-01 (c) — prompts capability: generators + admin playbooks list/get.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';


import {
  MCP_PROMPTS,
  getMcpPrompt,
} from '../../src/prompts.js';

const GENERATOR_NAMES = [
  'sfi.generate_data_dictionary',
  'sfi.generate_admin_handbook',
  'sfi.generate_onboarding_doc',
  'sfi.generate_architecture_overview',
  'sfi.generate_sharing_summary',
  'sfi.generate_compliance_report',
] as const;

const PLAYBOOK_NAMES = [
  'sfi.playbook_pre_deploy',
  'sfi.playbook_onboard',
  'sfi.playbook_security_audit',
  'sfi.playbook_cleanup',
  'sfi.playbook_health',
] as const;

describe('MCP-01 (c) prompts', () => {
  it('lists the curated generators + org-wide playbooks', () => {
    const names = MCP_PROMPTS.map((p) => p.name);
    expect(names).toEqual([...GENERATOR_NAMES, ...PLAYBOOK_NAMES]);
    for (const prompt of MCP_PROMPTS) {
      expect(prompt.description?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('getMcpPrompt returns user messages naming the target tool', () => {
    const dict = getMcpPrompt('sfi.generate_data_dictionary', {
      objectApiName: 'Account',
    });
    expect(dict.messages).toHaveLength(1);
    expect(dict.messages[0]?.role).toBe('user');
    const text = (dict.messages[0]?.content as { readonly text: string }).text;
    expect(text).toContain('sfi.generate_data_dictionary');
    expect(text).toContain('CustomObject:Account');

    const preDeploy = getMcpPrompt('sfi.playbook_pre_deploy', undefined);
    const playbookText = (
      preDeploy.messages[0]?.content as { readonly text: string }
    ).text;
    expect(playbookText).toContain('sfi.org_risk_report');
    expect(playbookText).toContain('pre-deploy');
  });

  it('rejects unknown prompt names with InvalidParams', () => {
    try {
      getMcpPrompt('sfi.not_a_prompt', undefined);
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });
});
