/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  getNodeById,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { assessValueChange } from '../../src/tools/value-change-risk.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0', refreshedAt: '2026-06-01T00:00:00Z', sourceOrg: 'me@example.com',
  components: {}, edges: {}, sourceTreeHash: 'sha256:fixture', coverageComputedAt: '2026-06-01T00:00:00.000Z',
  coverage: [],
};
const mkNode = (o: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'x', label: null, parentId: null, sourcePath: 'x', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const FED_FIELD = 'CustomField:User.FederationIdentifier';

/** Build a one-off graph seeded with the FederationIdentifier field + given SAML configs. */
const withConfigs = async (
  mappings: readonly string[],
  authProviders: readonly { providerType: string; registrationHandler: string | null }[] = [],
  handlersReferencingFed: readonly string[] = [],
): Promise<{ ctx: Context; store: GraphStore; dir: string }> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-sso-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value;
  const nodes: Node[] = [
    mkNode({ id: 'CustomObject:User', type: 'CustomObject', apiName: 'User' }),
    mkNode({ id: FED_FIELD, type: 'CustomField', apiName: 'FederationIdentifier', parentId: 'CustomObject:User', properties: { dataType: 'Text' } }),
    ...mappings.map((m, i) => mkNode({ id: `SamlSsoConfig:Cfg${i}`, type: 'SamlSsoConfig', apiName: `Cfg${i}`, properties: { identityMapping: m } })),
    ...authProviders.map((ap, i) => mkNode({ id: `AuthProvider:Ap${i}`, type: 'AuthProvider', apiName: `Ap${i}`, properties: { providerType: ap.providerType, registrationHandler: ap.registrationHandler } })),
    ...handlersReferencingFed.map((h) => mkNode({ id: `ApexClass:${h}`, type: 'ApexClass', apiName: h })),
  ];
  const edges: Edge[] = [
    { fromId: 'CustomObject:User', toId: FED_FIELD, edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
    ...handlersReferencingFed.map((h) => ({ fromId: `ApexClass:${h}`, toId: FED_FIELD, edgeType: 'readsFrom' as const, confidence: 'heuristic' as const, source: 'apex-scanner', properties: {} })),
  ];
  const seed: ExtractionResult = { nodes, edges };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  return { ctx: { vaultRoot: dir, manifest: MANIFEST, graph: store }, store, dir };
};

const assessFed = async (ctx: Context) => {
  const node = await getNodeById(ctx.graph, FED_FIELD as Node['id']);
  if (!node.ok || node.value === null) throw new Error('FED field missing');
  const r = await assessValueChange(ctx, node.value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('FederationIdentifier SSO gating', () => {
  it('is CRITICAL when a SAML config maps by FederationId (the real FederationId case)', async () => {
    const { ctx, store, dir } = await withConfigs(['FederationId', 'UserId']); // mirrors a real FederationId/UserId mix
    try {
      const a = await assessFed(ctx);
      expect(a.overallSeverity).toBe('critical');
      const identity = a.buckets.find((b) => b.bucket === 'identity')!;
      expect(identity.severity).toBe('critical');
      expect(identity.confidence).toBe('confirmed');
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('downgrades to low when SSO maps by Username/UserId only', async () => {
    const { ctx, store, dir } = await withConfigs(['UserId']);
    try {
      const a = await assessFed(ctx);
      const identity = a.buckets.find((b) => b.bucket === 'identity')!;
      expect(identity.severity).toBe('low');
      expect(identity.summary).toMatch(/not Federation ID/);
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('downgrades to low + discloses when no SamlSsoConfig exists (the no-SAML-config case)', async () => {
    const { ctx, store, dir } = await withConfigs([]);
    try {
      const a = await assessFed(ctx);
      const identity = a.buckets.find((b) => b.bucket === 'identity')!;
      expect(identity.severity).toBe('low');
      expect(a.disclosures.some((d) => /No SamlSsoConfig/i.test(d))).toBe(true);
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('raises to MEDIUM + discloses the Apex registration handler when an OIDC login provider exists (no SAML FedId)', async () => {
    const { ctx, store, dir } = await withConfigs([], [{ providerType: 'OpenIdConnect', registrationHandler: 'MyOidcRegHandler' }]);
    try {
      const identity = (await assessFed(ctx)).buckets.find((b) => b.bucket === 'identity')!;
      expect(identity.severity).toBe('medium');
      expect(identity.summary).toMatch(/OIDC/);
      expect((await assessFed(ctx)).disclosures.some((d) => /registration handler/i.test(d) && /MyOidcRegHandler/.test(d))).toBe(true);
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('does NOT raise for a social data-connector AuthProvider (null registration handler — the social-connector case)', async () => {
    const { ctx, store, dir } = await withConfigs([], [{ providerType: 'Google', registrationHandler: null }]);
    try {
      expect((await assessFed(ctx)).buckets.find((b) => b.bucket === 'identity')!.severity).toBe('low');
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('SAML FederationId still wins over an OIDC provider (critical)', async () => {
    const { ctx, store, dir } = await withConfigs(['FederationId'], [{ providerType: 'OpenIdConnect', registrationHandler: 'X' }]);
    try {
      expect((await assessFed(ctx)).overallSeverity).toBe('critical');
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads the handler Apex: an OIDC handler that references FederationIdentifier is surfaced as the mapping', async () => {
    const { ctx, store, dir } = await withConfigs([], [{ providerType: 'OpenIdConnect', registrationHandler: 'OidcRegHandler' }], ['OidcRegHandler']);
    try {
      const identity = (await assessFed(ctx)).buckets.find((b) => b.bucket === 'identity')!;
      expect(identity.severity).toBe('medium');
      expect(identity.summary).toContain('OidcRegHandler');
      expect(identity.summary).toMatch(/reference FederationIdentifier/i);
      expect(identity.evidence).toContain('ApexClass:OidcRegHandler');
    } finally { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); }
  });
});
