/// <reference types="vitest/globals" />
/**
 * RM-1b(2) — GOLDEN LOCK for the table-driven `classifyEdge`.
 *
 * `classifyEdge` was refactored to look up the curated `EDGE_SEMANTICS`
 * concept-model table instead of an inline switch. This test pins that the
 * refactor is BYTE-IDENTICAL: for a representative edge of every branch (the
 * formula-tokenizer special case, every `(edgeType, sourceType)` result, every
 * per-edgeType default, and the top-level unknown-edgeType default) the new
 * table-driven `classifyEdge` returns exactly what the ORIGINAL inline switch
 * returned. The original mapping is captured verbatim below as an oracle so any
 * future drift in the model data (or the lookup) fails here.
 */
import type { ComponentId, ComponentType, Edge, Node } from '@sf-intelligence/contracts';

import { classifyEdge } from '../../src/tools/safe-to-delete-field.js';

// ── Oracle: the ORIGINAL classifyEdge switch, captured verbatim (pre-RM-1b(2)) ──
type Classification = { category: string; verdict: string };
const originalClassifyEdge = (edge: Edge, fromNode: Node): Classification => {
  const fromType = fromNode.type;
  // INTENTIONAL post-RM-1b(2) extension, not drift. The single
  // formula-tokenizer special case became an ordered source-keyed list, because
  // `references` gained two more field->field producers on this branch and the
  // referrer ComponentType cannot tell them apart. Classifying by type alone
  // made safe_to_delete_field cite a roll-up summary that does not exist for
  // every resolved formula traversal (127 fields on one real vault) — a
  // fabricated citation on an otherwise-correct verdict.
  if (edge.edgeType === 'references' && edge.source === 'formula-tokenizer') {
    return { category: 'formula', verdict: 'blocking' };
  }
  if (edge.edgeType === 'references' && edge.source === 'rollup-summary') {
    return { category: 'rollup', verdict: 'blocking' };
  }
  if (
    edge.edgeType === 'references' &&
    edge.source === 'relationship-resolver' &&
    fromType === 'CustomField'
  ) {
    return { category: 'formula', verdict: 'blocking' };
  }
  switch (edge.edgeType) {
    case 'readsFrom':
      if (fromType === 'ApexClass' || fromType === 'ApexTrigger') {
        return { category: 'apex', verdict: 'risky' };
      }
      if (fromType === 'Flow') {
        return { category: 'flow', verdict: 'blocking' };
      }
      // INTENTIONAL post-RM-1b(2) extension, not drift: a ConditionalContext's
      // readsFrom edges name the fields its condition TESTS. They used to fall
      // through to {unknown, risky} — in practice to nothing at all, since the
      // edges were never emitted — which is how a field used only in a Flow
      // entry criterion could be reported as deletable.
      if (fromType === 'ConditionalContext') {
        return { category: 'condition', verdict: 'blocking' };
      }
      if (
        fromType === 'LightningComponentBundle' ||
        fromType === 'AuraDefinitionBundle'
      ) {
        return { category: 'frontend', verdict: 'risky' };
      }
      return { category: 'unknown', verdict: 'risky' };
    case 'writesTo':
      if (fromType === 'ApexClass' || fromType === 'ApexTrigger') {
        return { category: 'apex', verdict: 'blocking' };
      }
      if (fromType === 'Flow') {
        return { category: 'flow', verdict: 'blocking' };
      }
      if (fromType === 'WorkflowRule') {
        return { category: 'workflow', verdict: 'blocking' };
      }
      if (
        fromType === 'LightningComponentBundle' ||
        fromType === 'AuraDefinitionBundle'
      ) {
        return { category: 'frontend', verdict: 'risky' };
      }
      return { category: 'unknown', verdict: 'blocking' };
    case 'references':
      if (fromType === 'ValidationRule') {
        return { category: 'validation', verdict: 'blocking' };
      }
      if (
        fromType === 'VisualforcePage' ||
        fromType === 'VisualforceComponent'
      ) {
        return { category: 'frontend', verdict: 'risky' };
      }
      if (fromType === 'QuickAction') {
        return { category: 'layout', verdict: 'risky' };
      }
      if (
        fromType === 'Report' ||
        fromType === 'Dashboard' ||
        fromType === 'ListView' ||
        fromType === 'ReportType'
      ) {
        return { category: 'analytics', verdict: 'blocking' };
      }
      if (fromType === 'FlexiPage') {
        return { category: 'ui', verdict: 'blocking' };
      }
      if (fromType === 'RestrictionRule' || fromType === 'ScopingRule') {
        return { category: 'sharing', verdict: 'blocking' };
      }
      return { category: 'unknown', verdict: 'risky' };
    case 'usedInLayout':
      return { category: 'layout', verdict: 'review' };
    case 'grantedBy':
      return { category: 'permission', verdict: 'review' };
    default:
      return { category: 'unknown', verdict: 'risky' };
  }
};

// ── Builders ────────────────────────────────────────────────────────────────
const makeNode = (type: ComponentType): Node => ({
  id: `${type}:X` as ComponentId,
  type,
  apiName: 'X',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeEdge = (edgeType: Edge['edgeType'], source: string): Edge => ({
  fromId: 'X:X' as ComponentId,
  toId: 'CustomField:Account.F__c' as ComponentId,
  edgeType,
  confidence: 'declared',
  source,
  properties: {},
});

// ── Representative case per branch: (edgeType, source, fromType) -> expected ───
interface Case {
  readonly name: string;
  readonly edgeType: Edge['edgeType'];
  readonly source: string;
  readonly fromType: ComponentType;
  readonly expected: Classification;
}

const CASES: readonly Case[] = [
  // 1. formula-tokenizer special case — beats the references/ValidationRule branch.
  { name: 'formula special-case (over ValidationRule)', edgeType: 'references', source: 'formula-tokenizer', fromType: 'ValidationRule', expected: { category: 'formula', verdict: 'blocking' } },
  { name: 'formula special-case (generic source node)', edgeType: 'references', source: 'formula-tokenizer', fromType: 'CustomField', expected: { category: 'formula', verdict: 'blocking' } },
  // 2. readsFrom
  { name: 'readsFrom ApexClass', edgeType: 'readsFrom', source: 'apex-scanner', fromType: 'ApexClass', expected: { category: 'apex', verdict: 'risky' } },
  { name: 'readsFrom ApexTrigger', edgeType: 'readsFrom', source: 'apex-scanner', fromType: 'ApexTrigger', expected: { category: 'apex', verdict: 'risky' } },
  { name: 'readsFrom Flow', edgeType: 'readsFrom', source: 'flow-extractor', fromType: 'Flow', expected: { category: 'flow', verdict: 'blocking' } },
  { name: 'readsFrom ConditionalContext (entry criterion)', edgeType: 'readsFrom', source: 'condition-extractor', fromType: 'ConditionalContext', expected: { category: 'condition', verdict: 'blocking' } },
  { name: 'readsFrom LWC', edgeType: 'readsFrom', source: 'lwc-scanner', fromType: 'LightningComponentBundle', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'readsFrom Aura', edgeType: 'readsFrom', source: 'aura-scanner', fromType: 'AuraDefinitionBundle', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'readsFrom default (Profile)', edgeType: 'readsFrom', source: 'x', fromType: 'Profile', expected: { category: 'unknown', verdict: 'risky' } },
  // 3. writesTo
  { name: 'writesTo ApexClass', edgeType: 'writesTo', source: 'apex-scanner', fromType: 'ApexClass', expected: { category: 'apex', verdict: 'blocking' } },
  { name: 'writesTo ApexTrigger', edgeType: 'writesTo', source: 'apex-scanner', fromType: 'ApexTrigger', expected: { category: 'apex', verdict: 'blocking' } },
  { name: 'writesTo Flow', edgeType: 'writesTo', source: 'flow-extractor', fromType: 'Flow', expected: { category: 'flow', verdict: 'blocking' } },
  { name: 'writesTo WorkflowRule', edgeType: 'writesTo', source: 'workflow-extractor', fromType: 'WorkflowRule', expected: { category: 'workflow', verdict: 'blocking' } },
  { name: 'writesTo LWC', edgeType: 'writesTo', source: 'lwc-scanner', fromType: 'LightningComponentBundle', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'writesTo Aura', edgeType: 'writesTo', source: 'aura-scanner', fromType: 'AuraDefinitionBundle', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'writesTo default (Profile)', edgeType: 'writesTo', source: 'x', fromType: 'Profile', expected: { category: 'unknown', verdict: 'blocking' } },
  // 4. references (non-formula source)
  { name: 'references CustomField (roll-up coupling)', edgeType: 'references', source: 'rollup-summary', fromType: 'CustomField', expected: { category: 'rollup', verdict: 'blocking' } },
  // The regression this split exists to prevent: a resolved formula traversal
  // must NOT be cited as a roll-up summary.
  { name: 'references CustomField (resolved formula traversal)', edgeType: 'references', source: 'relationship-resolver', fromType: 'CustomField', expected: { category: 'formula', verdict: 'blocking' } },
  // Same resolver, FlexiPage referrer: a related-list alias is a UI dependency
  // and must keep falling through to the FlexiPage row, not the formula rule.
  { name: 'references FlexiPage (related-list alias)', edgeType: 'references', source: 'relationship-resolver', fromType: 'FlexiPage', expected: { category: 'ui', verdict: 'blocking' } },
  { name: 'references ValidationRule', edgeType: 'references', source: 'enterprise-metadata', fromType: 'ValidationRule', expected: { category: 'validation', verdict: 'blocking' } },
  { name: 'references VisualforcePage', edgeType: 'references', source: 'x', fromType: 'VisualforcePage', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'references VisualforceComponent', edgeType: 'references', source: 'x', fromType: 'VisualforceComponent', expected: { category: 'frontend', verdict: 'risky' } },
  { name: 'references QuickAction', edgeType: 'references', source: 'x', fromType: 'QuickAction', expected: { category: 'layout', verdict: 'risky' } },
  { name: 'references Report', edgeType: 'references', source: 'x', fromType: 'Report', expected: { category: 'analytics', verdict: 'blocking' } },
  { name: 'references Dashboard', edgeType: 'references', source: 'x', fromType: 'Dashboard', expected: { category: 'analytics', verdict: 'blocking' } },
  { name: 'references ListView', edgeType: 'references', source: 'x', fromType: 'ListView', expected: { category: 'analytics', verdict: 'blocking' } },
  { name: 'references ReportType', edgeType: 'references', source: 'x', fromType: 'ReportType', expected: { category: 'analytics', verdict: 'blocking' } },
  { name: 'references FlexiPage', edgeType: 'references', source: 'x', fromType: 'FlexiPage', expected: { category: 'ui', verdict: 'blocking' } },
  { name: 'references RestrictionRule', edgeType: 'references', source: 'x', fromType: 'RestrictionRule', expected: { category: 'sharing', verdict: 'blocking' } },
  { name: 'references ScopingRule', edgeType: 'references', source: 'x', fromType: 'ScopingRule', expected: { category: 'sharing', verdict: 'blocking' } },
  { name: 'references default (Layout)', edgeType: 'references', source: 'x', fromType: 'Layout', expected: { category: 'unknown', verdict: 'risky' } },
  // 5. usedInLayout / grantedBy (fromType-independent)
  { name: 'usedInLayout', edgeType: 'usedInLayout', source: 'x', fromType: 'Layout', expected: { category: 'layout', verdict: 'review' } },
  { name: 'grantedBy PermissionSet', edgeType: 'grantedBy', source: 'x', fromType: 'PermissionSet', expected: { category: 'permission', verdict: 'review' } },
  { name: 'grantedBy Profile', edgeType: 'grantedBy', source: 'x', fromType: 'Profile', expected: { category: 'permission', verdict: 'review' } },
  // 6. edgeType not in the table -> top-level default
  { name: 'unknown edgeType (triggersOn)', edgeType: 'triggersOn', source: 'x', fromType: 'Flow', expected: { category: 'unknown', verdict: 'risky' } },
];

describe('RM-1b(2) classifyEdge — table-driven is byte-identical to the original switch', () => {
  for (const c of CASES) {
    it(`${c.name} → {${c.expected.category}, ${c.expected.verdict}}`, () => {
      const edge = makeEdge(c.edgeType, c.source);
      const node = makeNode(c.fromType);
      const actual = classifyEdge(edge, node);
      // (a) the refactor matches the captured original oracle exactly, and
      // (b) both match the documented expected classification.
      expect(actual).toEqual(originalClassifyEdge(edge, node));
      expect(actual).toEqual(c.expected);
    });
  }
});
