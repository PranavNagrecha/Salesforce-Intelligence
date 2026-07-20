/**
 * RM-review F18 — backfill proofs for the three shipped concept rules that
 * previously had ZERO test reference (so a drift or dead binding would have
 * surfaced only on a real vault). Each proof fires the rule against a synthetic
 * grounded slice and asserts the cited/confidence output, plus a negative case.
 *
 * Two of these also lock the RM-review cluster fix (EC-16 `fromTypeIn`): a
 * PERMISSION-SET grantor must NOT fire the PROFILE-provenance rule.
 *
 * No real org data — synthetic ids only.
 */

import type { ConfidenceLevel, Edge, Node } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import { interpret, type Coverage, type GroundedSlice } from '../../src/knowledge/reason.js';

const node = (
  id: string,
  type: Node['type'],
  properties: Record<string, unknown> = {},
): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `synthetic/${id}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const edge = (
  fromId: string,
  toId: string,
  edgeType: Edge['edgeType'],
  confidence: ConfidenceLevel,
  properties: Record<string, unknown> = {},
): Edge => ({ fromId, toId, edgeType, confidence, source: 'synthetic-test', properties });

const COMPLETE: Coverage = { status: 'complete', caveat: null };

const ruleById = (id: string) => {
  const rule = CONCEPT_RULES.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`rule not found: ${id}`);
  return rule;
};

describe('rule:duplicate-rule/blocks-on-update-action — proof', () => {
  const DR = 'DuplicateRule:Ns__ContactDupBlock';

  it('fires on a DuplicateRule with actionOnUpdate Block — cites it, declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(DR, 'DuplicateRule', { actionOnUpdate: 'Block' })],
      edges: [],
    };
    const out = interpret(ruleById('rule:duplicate-rule/blocks-on-update-action'), slice, COMPLETE, DR);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:duplicate-rule-blocks-save');
    expect(out[0]!.groundedIn).toEqual([DR]);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim).toContain('actionOnUpdate Block');
  });

  it('does NOT fire when actionOnUpdate is Allow', () => {
    const slice: GroundedSlice = {
      nodes: [node(DR, 'DuplicateRule', { actionOnUpdate: 'Allow' })],
      edges: [],
    };
    expect(interpret(ruleById('rule:duplicate-rule/blocks-on-update-action'), slice, COMPLETE, DR)).toEqual([]);
  });
});

describe('rule:integration/outbound-message-soap-endpoint — proof', () => {
  const OM = 'OutboundMessage:Ns__NotifyExternalSystem';

  it('fires on an OutboundMessage carrying an endpointUrl — cites it, declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(OM, 'OutboundMessage', { endpointUrl: 'https://example.test/soap/endpoint' })],
      edges: [],
    };
    const out = interpret(ruleById('rule:integration/outbound-message-soap-endpoint'), slice, COMPLETE, OM);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:outbound-message-soap-callout-posture');
    expect(out[0]!.groundedIn).toEqual([OM]);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('soap endpoint');
  });

  it('does NOT fire when endpointUrl is absent (isNull:false requires the property present)', () => {
    const slice: GroundedSlice = { nodes: [node(OM, 'OutboundMessage', {})], edges: [] };
    expect(interpret(ruleById('rule:integration/outbound-message-soap-endpoint'), slice, COMPLETE, OM)).toEqual([]);
  });
});

describe('rule:access/profile-field-grant-provenance — proof (+ EC-16 fromTypeIn cluster fix)', () => {
  const PROFILE = 'Profile:Ns__SalesProfile';
  const PERMSET = 'PermissionSet:Ns__SalesPermSet';
  const FIELD = 'CustomField:Ns__Account.Ns__Secret__c';

  it('fires on a Profile--grantedBy-->CustomField edge — names a PROFILE grant, declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(PROFILE, 'Profile'), node(FIELD, 'CustomField')],
      edges: [edge(PROFILE, FIELD, 'grantedBy', 'declared', { readable: true })],
    };
    const out = interpret(ruleById('rule:access/profile-field-grant-provenance'), slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:permission-provenance-profile-vs-permset');
    expect(out[0]!.claim).toContain('PROFILE');
  });

  it('[EC-16 fromTypeIn] a PERMISSION-SET grantor does NOT fire the PROFILE-provenance rule (F1 cluster fix)', () => {
    const slice: GroundedSlice = {
      nodes: [node(PERMSET, 'PermissionSet'), node(FIELD, 'CustomField')],
      edges: [edge(PERMSET, FIELD, 'grantedBy', 'declared', { readable: true })],
    };
    // Neither anchoring on the field nor on the permission set may mislabel the
    // permission-set grant as a profile grant.
    expect(interpret(ruleById('rule:access/profile-field-grant-provenance'), slice, COMPLETE, FIELD)).toEqual([]);
    expect(interpret(ruleById('rule:access/profile-field-grant-provenance'), slice, COMPLETE, PERMSET)).toEqual([]);
  });
});
