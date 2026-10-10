/**
 * Restriction / scoping rule filter paths that may end on a field but resolved
 * to no edge onto it.
 *
 * A `<recordFilter>` can test a field on a RELATED object through a
 * relationship path (`Advisor__r.Region__c = $User.Id`), and Salesforce refuses
 * to delete a field a rule's filter names. The refresh pass
 * `resolveRecordFilterPathEdges` mints a `references` edge (`pathRole: 'tail'`)
 * onto the field a path ends on when it can resolve every hop. A path it could
 * not resolve, or one on a vault built before that pass existed, leaves no
 * edge: matched by the field's NAME here so `safe_to_delete_field` reports the
 * `sharing` row as not checked instead of "checked, none". The path is parsed
 * with the same function the extractor uses, so the two never disagree.
 */

import type { ComponentId, ComponentType } from '@sf-intelligence/contracts';
import { recordFilterRelationshipPaths } from '@sf-intelligence/extractors';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/** The rule families whose `recordFilter` can hold a relationship path. */
export const RECORD_FILTER_RULE_TYPES: readonly ComponentType[] = ['RestrictionRule', 'ScopingRule'];

/** One rule filter path whose tail names the field but holds no edge onto it. */
export interface RuleFilterPathGap {
  readonly ruleId: string;
  readonly path: string;
}

/**
 * Every RestrictionRule / ScopingRule filter path that ends on a field named
 * `fieldApiName` and that no `pathRole: 'tail'` edge resolved. A path resolved
 * to a field on another object is not a gap. Only custom fields are checked: a
 * standard field cannot be deleted.
 */
export const findRuleFilterPathGaps = async (
  ctx: Context,
  fieldApiName: string,
): Promise<readonly RuleFilterPathGap[]> => {
  const name = fieldApiName.slice(fieldApiName.lastIndexOf('.') + 1).toLowerCase();
  if (!name.endsWith('__c')) return [];
  const scan = await scanAllNodesOfTypes(ctx.graph, RECORD_FILTER_RULE_TYPES);
  // A failed read is "not checked", never "no rule tests it".
  if (!scan.ok) return [{ ruleId: 'RestrictionRule:*', path: '(rule scan failed)' }];
  const gaps: RuleFilterPathGap[] = [];
  for (const rule of scan.value.nodes) {
    // Parsed from the raw filter every rule node carries (any builder), with
    // the same function the refresh pass used to write `recordFilterPaths`.
    const filter = rule.properties['recordFilter'];
    const paths = typeof filter === 'string' ? recordFilterRelationshipPaths(filter) : [];
    const matching = paths.filter((p) => p.slice(p.lastIndexOf('.') + 1).toLowerCase() === name);
    if (matching.length === 0) continue;
    const edges = await listEdges(ctx.graph, rule.id as ComponentId, {
      direction: 'out',
      edgeType: 'references',
    });
    const resolved = new Set(
      (edges.ok ? edges.value : [])
        .filter((e) => e.properties['pathRole'] === 'tail')
        .map((e) => e.properties['recordFilterPath']),
    );
    for (const path of matching) {
      if (!resolved.has(path)) gaps.push({ ruleId: rule.id, path });
    }
  }
  return gaps;
};
