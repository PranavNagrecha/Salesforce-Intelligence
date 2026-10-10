/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../../src/server.js';
import {
  expectedArgsHint,
  normalizeToolArgs,
  schemaShape,
} from '../../src/tools/arg-normalizer.js';
import { dispatchTool } from '../../src/tools/index.js';

/**
 * CH-1 / DEV-12 / ADM-10 — FAIL-BEFORE/PASS-AFTER.
 *
 * Before: runTool only called `schema.safeParse(args)`. Every non-strict tool
 * schema STRIPPED an arg it did not declare, so a host that guessed the
 * sibling tool's name (`componentId` for get_edges' `nodeId`, `object` for
 * `objectApiName`) got either a bare `nodeId: Required` or — worse — a
 * confident, UNSCOPED answer with no warning.
 *
 * After: one dispatch-level normalizer maps the guessed name onto the tool's
 * real arg when unambiguous, reports anything still dropped, and every
 * invalid-query names the expected args with an example.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'normalizer-fixture',
  components: { CustomObject: 0 },
  edges: {},
  sourceTreeHash: 'sha256:normalizer-fixture',
} as never;

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-argnorm-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const call = async (
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const r = await dispatchTool(ctx, name, args);
  return JSON.parse((r.content?.[0] as { readonly text: string }).text) as Record<
    string,
    unknown
  >;
};

describe('normalizeToolArgs (pure)', () => {
  const objectTool = z.object({
    objectApiName: z.string().optional(),
    limit: z.number().optional(),
  });

  it('maps object / objectName / sobject onto objectApiName, stripping a CustomObject: prefix', () => {
    expect(normalizeToolArgs(objectTool, { object: 'Invoice__c' }).args).toEqual({
      objectApiName: 'Invoice__c',
    });
    expect(normalizeToolArgs(objectTool, { objectName: 'Invoice__c' }).renamed).toEqual([
      { from: 'objectName', to: 'objectApiName' },
    ]);
    expect(
      normalizeToolArgs(objectTool, { componentId: 'CustomObject:Invoice__c' }).args,
    ).toEqual({ objectApiName: 'Invoice__c' });
  });

  it('maps componentId <-> nodeId <-> targetId and adds the id prefix for a typed name', () => {
    const nodeTool = z.object({ nodeId: z.string().min(1) });
    expect(normalizeToolArgs(nodeTool, { componentId: 'ApexClass:AccountService' }).args).toEqual({
      nodeId: 'ApexClass:AccountService',
    });
    expect(normalizeToolArgs(nodeTool, { fieldId: 'Invoice__c.Amount__c' }).args).toEqual({
      nodeId: 'CustomField:Invoice__c.Amount__c',
    });
  });

  it('wraps a singular permissionSetId into the plural array arg', () => {
    const t = z.object({ permissionSetIds: z.array(z.string()).optional() });
    expect(normalizeToolArgs(t, { permissionSetId: 'PermissionSet:Sales_Ops' }).args).toEqual({
      permissionSetIds: ['PermissionSet:Sales_Ops'],
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: a bare name renamed onto a typed id arg gains the family prefix', () => {
    const t = z.object({ fieldId: z.string().optional(), limit: z.number().optional() });
    expect(normalizeToolArgs(t, { fieldApiName: 'Invoice__c.Amount__c' }).args).toEqual({
      fieldId: 'CustomField:Invoice__c.Amount__c',
    });
    // An already-canonical value is never double-prefixed.
    expect(normalizeToolArgs(t, { field: 'CustomField:Invoice__c.Amount__c' }).args).toEqual({
      fieldId: 'CustomField:Invoice__c.Amount__c',
    });
    const p = z.object({ permissionSetIds: z.array(z.string()).optional() });
    expect(normalizeToolArgs(p, { permissionSet: 'Sales_Ops' }).args).toEqual({
      permissionSetIds: ['PermissionSet:Sales_Ops'],
    });
  });

  it('never overwrites a canonical value the caller already supplied', () => {
    const r = normalizeToolArgs(objectTool, { objectApiName: 'Project__c', object: 'Invoice__c' });
    expect(r.args['objectApiName']).toBe('Project__c');
    expect(r.ignored).toEqual(['object']);
  });

  it('leaves an alias the tool already consumes in its own preprocess alone', () => {
    const t = z.preprocess(
      (raw) => {
        const r = raw as Record<string, unknown>;
        return { ...r, nodeId: r['nodeId'] ?? r['componentId'] };
      },
      z.object({ nodeId: z.string() }),
    );
    const r = normalizeToolArgs(t, { componentId: 'Flow:Invoice_Flow' });
    expect(r.renamed).toEqual([]);
    expect(r.ignored).toEqual([]);
  });

  it('reports an undeclared arg with no alias as ignored (never silently stripped)', () => {
    const r = normalizeToolArgs(objectTool, { objectApiName: 'Invoice__c', colour: 'red' });
    expect(r.ignored).toEqual(['colour']);
  });

  it('sees through ZodEffects (refine) wrappers', () => {
    const t = z.object({ a: z.string().optional() }).refine(() => true);
    expect(Object.keys(schemaShape(t) ?? {})).toEqual(['a']);
  });

  it('expectedArgsHint names required args, an example, and sfi.resolve', () => {
    const hint = expectedArgsHint(z.object({ fieldId: z.string(), limit: z.number().optional() }));
    expect(hint).toContain('required: fieldId');
    expect(hint).toContain('"fieldId":"CustomField:Account.Industry"');
    expect(hint).toContain('sfi.resolve');
  });
});

describe('dispatch (runTool) — real tools', () => {
  it('get_edges accepts componentId for nodeId (was: "nodeId: Required")', async () => {
    const body = await call('sfi.get_edges', { componentId: 'CustomObject:Invoice__c' });
    const error = body['error'] as { kind: string; message: string } | undefined;
    expect(error?.message ?? '').not.toContain('nodeId: Required');
  });

  it('an ignored arg on a successful call is disclosed on the envelope', async () => {
    const body = await call('sfi.health_check', { objectApiName: 'Invoice__c', colour: 'red' });
    expect(body['error']).toBeUndefined();
    const notes = body['argumentNotes'] as { ignored?: string[]; warning?: string };
    expect(notes.ignored).toEqual(['objectApiName', 'colour']);
    expect(notes.warning).toContain('did NOT scope the answer');
  });

  it('FAIL-BEFORE/PASS-AFTER: field_access_audit accepts fieldApiName as an Object.Field name', async () => {
    const body = await call('sfi.field_access_audit', { fieldApiName: 'Invoice__c.Amount__c' });
    const error = body['error'] as { kind: string; message: string } | undefined;
    expect(error?.message ?? '').not.toContain("must start with 'CustomField:'");
  });

  it('FAIL-BEFORE/PASS-AFTER: an invalid-query after a rename names the rename', async () => {
    const body = await call('sfi.get_edges', { componentId: '' });
    const error = body['error'] as { kind: string; message: string };
    expect(error.kind).toBe('invalid-query');
    expect(error.message).toContain('componentId→nodeId');
    expect(error.message).not.toMatch(/[^.!?)] Expected args/);
  });

  it('a Zod invalid-query names the expected args, an example, and sfi.resolve', async () => {
    const body = await call('sfi.get_edges', {});
    const error = body['error'] as { kind: string; message: string };
    expect(error.kind).toBe('invalid-query');
    expect(error.message).toContain('nodeId');
    expect(error.message).toContain('Example:');
    expect(error.message).toContain('sfi.resolve');
  });
});
