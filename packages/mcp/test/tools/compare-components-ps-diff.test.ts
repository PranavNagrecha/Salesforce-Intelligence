/// <reference types="vitest/globals" />
/**
 * P8-draft-ps-diff — `compare_components(format: 'ps-diff')` reshapes the base
 * fieldDiffs + edgeDiffs into a deploy-tool-friendly grant diff, and that diff
 * validates against the published JSON Schema (docs/schemas/ps-diff.schema.json).
 *
 * `buildPsDiff` is pure (no graph), so this is a fast T-unit over a synthetic
 * CompareComponentsOutput. A dependency-free validator (covering the draft-07
 * subset the schema uses) checks conformance — and a deliberately-broken sample
 * proves the validator actually rejects, so a passing case means something.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ComponentId, EdgeType } from '@sf-intelligence/contracts';

import {
  buildPsDiff,
  type CompareComponentsOutput,
  type EdgeDiff,
  type FieldDiff,
} from '../../src/tools/compare-components.js';

type JsonSchema = Record<string, unknown>;

/** Minimal draft-07 subset validator (type / required / properties /
 * additionalProperties:false / items / enum / local $ref). Pushes a message
 * per violation; an empty array means the value conforms. */
function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (typeof schema.$ref === 'string') {
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    let resolved: unknown = root;
    for (const p of parts) resolved = (resolved as Record<string, unknown>)[p];
    validateAgainstSchema(value, resolved as JsonSchema, root, path, errors);
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    }
    return;
  }
  const type = schema.type;
  if (type === undefined) return; // unconstrained (valueA / valueB)
  if (type === 'string' && typeof value !== 'string') errors.push(`${path}: expected string`);
  if (type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    const items = schema.items as JsonSchema | undefined;
    if (items) value.forEach((v, i) => validateAgainstSchema(v, items, root, `${path}[${i}]`, errors));
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    for (const req of required) {
      if (!(req in obj)) errors.push(`${path}: missing required '${req}'`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errors.push(`${path}: unexpected property '${k}'`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) validateAgainstSchema(obj[k], sub, root, `${path}.${k}`, errors);
    }
  }
}

const SCHEMA: JsonSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/schemas/ps-diff.schema.json', import.meta.url)),
    'utf8',
  ),
) as JsonSchema;

const id = (s: string): ComponentId => s as ComponentId;

/** A synthetic base diff exercising every PsDiff source path. */
const sampleBase = (): CompareComponentsOutput => {
  const edgeDiffs: EdgeDiff[] = [
    // removed object grant (A only)
    { direction: 'outgoing', target: id('CustomObject:Account'), edgeType: 'grantedBy' as EdgeType, inA: true, inB: false },
    // added field grant (B only)
    { direction: 'outgoing', target: id('CustomField:Account.Name'), edgeType: 'grantedBy' as EdgeType, inA: false, inB: true },
    // unchanged class grant (both) — skipped, level change invisible
    { direction: 'outgoing', target: id('ApexClass:Foo'), edgeType: 'grantedBy' as EdgeType, inA: true, inB: true },
    // non-grant edge — ignored
    { direction: 'outgoing', target: id('Flow:Bar'), edgeType: 'references' as EdgeType, inA: true, inB: false },
  ];
  const fieldDiffs: FieldDiff[] = [
    // userPermissions set-diff: +ModifyAllData, -ViewAllData
    {
      path: 'properties.userPermissions',
      valueA: ['ApiEnabled', 'ViewAllData'],
      valueB: ['ApiEnabled', 'ModifyAllData'],
      status: 'different',
    },
    // scalar metadata change
    { path: 'properties.license', valueA: 'Salesforce', valueB: 'Platform', status: 'different' },
    // vault-derived grant COUNTS — non-deployable noise, must be excluded
    { path: 'properties.fieldGrantCount', valueA: 38, valueB: 6, status: 'different' },
    { path: 'properties.objectGrantCount', valueA: 12, valueB: 11, status: 'different' },
    // unchanged — skipped
    { path: 'label', valueA: 'X', valueB: 'X', status: 'same' },
  ];
  return { idA: id('PermissionSet:A'), idB: id('PermissionSet:B'), typesMatch: true, fieldDiffs, edgeDiffs };
};

describe('P8-draft-ps-diff — compare_components ps-diff format', () => {
  it('reshapes grants and userPermissions, skipping unchanged + non-grant edges', () => {
    const d = buildPsDiff(sampleBase());
    const find = (category: string, key: string) =>
      d.changes.find((c) => c.category === category && c.key === key);

    expect(d.bothPermissionLike).toBe(true);
    expect(find('objectPermissions', 'CustomObject:Account')?.change).toBe('removed');
    expect(find('fieldPermissions', 'CustomField:Account.Name')?.change).toBe('added');
    expect(find('userPermissions', 'ModifyAllData')?.change).toBe('added');
    expect(find('userPermissions', 'ViewAllData')?.change).toBe('removed');
    expect(find('license', 'properties.license')?.change).toBe('changed');
    // unchanged class grant + non-grant edge + 'same' field are absent
    expect(find('classAccesses', 'ApexClass:Foo')).toBeUndefined();
    expect(d.changes.some((c) => c.key === 'Flow:Bar')).toBe(false);
    // vault-derived grant-count properties are EXCLUDED (non-deployable noise)
    expect(d.changes.some((c) => c.key.includes('GrantCount'))).toBe(false);
    expect(d.summary.byCategory.some((b) => b.category.endsWith('GrantCount'))).toBe(false);
    expect(d.summary.added).toBe(2);
    expect(d.summary.removed).toBe(2);
    expect(d.summary.changed).toBe(1);
  });

  it('flags non-permission ids honestly', () => {
    const base = { ...sampleBase(), idA: id('CustomObject:Account'), idB: id('CustomObject:Contact') };
    expect(buildPsDiff(base).bothPermissionLike).toBe(false);
  });

  it('output validates against the published JSON Schema', () => {
    const d = buildPsDiff(sampleBase());
    const errors: string[] = [];
    validateAgainstSchema(d, SCHEMA, SCHEMA, '$', errors);
    expect(errors).toEqual([]);
  });

  it('the validator actually rejects a malformed payload (not a no-op)', () => {
    const broken = { ...buildPsDiff(sampleBase()), summary: 'oops', extra: 1 };
    const errors: string[] = [];
    validateAgainstSchema(broken, SCHEMA, SCHEMA, '$', errors);
    expect(errors.length).toBeGreaterThan(0);
  });
});
