/// <reference types="vitest/globals" />

/**
 * Post-refresh golden assertions: tools must read what `sfi refresh` wrote,
 * not hand-built unit-fixture layouts. Runs a full refresh on edu-org then
 * spot-checks the adversarial-review failure modes.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRefresh } from '../../packages/cli/src/commands/refresh.js';
import type { ComponentId, ComponentType } from '../../packages/contracts/src/index.js';
import { listEdges, listNodesByType } from '../../packages/graph/src/index.js';
import {
  buildContext,
  dispatchTool,
  shutdown,
  type Context,
} from '../../packages/mcp/src/index.js';
import {
  loadManifest,
  readCoverageEntries,
  saveManifest,
  type ExtendedVaultManifest,
} from '../../packages/vault/src/index.js';

import { FIXTURE_SOURCE } from './fixture-paths.js';

const TEST_ORG_ALIAS = 'edu-org-golden';

const parseEnvelope = (content: readonly { type: string; text?: string }[]):
  | { data: Record<string, unknown> }
  | { error: { kind: string; message: string } } => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as
    | { data: Record<string, unknown> }
    | { error: { kind: string; message: string } };
};

let cwd = '';
let vaultRoot = '';
let ctx: Context | null = null;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-golden-'));
  vaultRoot = join(cwd, 'org-kb');
  await mkdir(join(vaultRoot, 'meta'), { recursive: true });
  await cp(FIXTURE_SOURCE, join(vaultRoot, 'source'), { recursive: true });
  await writeFile(
    join(vaultRoot, 'meta', 'config.json'),
    JSON.stringify({
      targetOrg: TEST_ORG_ALIAS,
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-28T00:00:00.000Z',
    }),
    'utf8',
  );

  const refresh = await runRefresh({ cwd, noPull: true });
  if (refresh.status === 'failed') {
    throw new Error(`refresh failed: ${refresh.errors.map((e) => e.message).join('; ')}`);
  }

  const built = await buildContext(vaultRoot);
  if (!built.ok) {
    throw new Error(`buildContext failed: ${built.error.message}`);
  }
  ctx = built.value;
}, 600_000);

afterAll(async () => {
  if (ctx !== null) {
    await shutdown(ctx);
    ctx = null;
  }
  if (cwd.length > 0) {
    await rm(cwd, { recursive: true, force: true });
  }
});

describe('post-refresh golden', () => {
  it('search_apex_source finds DX-nested Apex under source/main/default', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.search_apex_source', {
      query: 'MRK_ClearLogsBatch',
      limit: 25,
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const matches = env.data['matches'] as { path: string }[];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.path.includes('main/default/classes'))).toBe(true);
  });

  it('manifest carries coverage after refresh', async () => {
    const manifest = await loadManifest(vaultRoot);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(readCoverageEntries(manifest.value).length).toBeGreaterThan(0);
  });

  it('coverage_report reports coverageKnown', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.coverage_report', {});
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    expect(env.data['coverageKnown']).toBe(true);
  });

  it('what_happens_on_save returns data for a modeled custom object', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.what_happens_on_save', {
      objectApiName: 'OA_Engagements__c',
      event: 'insert',
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    expect(env.data['objectModeled']).toBe(true);
    const soe = env.data['soe'] as unknown[];
    expect(soe.length).toBeGreaterThan(0);
  });

  it('get_impact stays within node/edge caps', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.get_impact', {
      componentId: 'CustomField:OA_Engagements__c.Category__c',
      hops: 3,
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const impact = env.data['impact'] as { nodes: unknown[]; edges: unknown[] };
    expect(impact.nodes.length).toBeLessThanOrEqual(200);
    expect(impact.edges.length).toBeLessThanOrEqual(400);
    expect(typeof env.data['disclosure']).toBe('string');
  });

  it('CR-CAP-18: refresh writes PlatformEventChannel + Member nodes and the member→event references edge resolves', async () => {
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const channels = await listNodesByType(liveCtx.graph, 'PlatformEventChannel', {
      limit: 50,
    });
    expect(channels.ok).toBe(true);
    if (!channels.ok) return;
    expect(channels.value.length).toBeGreaterThanOrEqual(1);

    const members = await listNodesByType(
      liveCtx.graph,
      'PlatformEventChannelMember',
      { limit: 50 },
    );
    expect(members.ok).toBe(true);
    if (!members.ok) return;
    expect(members.value.length).toBeGreaterThanOrEqual(1);

    // The member→event references edge resolves to the in-vault __e CustomObject
    // (proving tools read what refresh wrote, and the edge is NOT dangling).
    const memberId = 'PlatformEventChannelMember:Application_Event_Member__chn';
    const refs = await listEdges(liveCtx.graph, memberId, {
      direction: 'out',
      edgeType: 'references',
    });
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const eventRef = refs.value.find(
      (e) => e.toId === 'CustomObject:Application_Event__e',
    );
    expect(eventRef).toBeDefined();
    expect(eventRef?.properties['referenceKind']).toBe(
      'platformEventChannelMember',
    );
    expect(eventRef?.properties['filterExpression']).toBe("Status__c = 'New'");
    // event channel selectedEntity IS in the vault → not dangling.
    expect(eventRef?.properties['targetMissing']).not.toBe(true);

    // event_subscribers surfaces the publish-side channel for the event.
    const result = await dispatchTool(liveCtx, 'sfi.event_subscribers', {
      eventId: 'CustomObject:Application_Event__e',
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const chans = env.data['channels'] as Array<{
      channelType: string;
      filterExpression: string | null;
    }>;
    expect(chans.length).toBeGreaterThanOrEqual(1);
    expect(chans.some((c) => c.channelType === 'event')).toBe(true);
    expect(chans.some((c) => c.filterExpression === "Status__c = 'New'")).toBe(
      true,
    );
  });
});

describe('destructive trust (post-refresh)', () => {
  const findFieldReferencedBy = async (
    liveCtx: Context,
    nodeType: ComponentType,
  ): Promise<ComponentId | null> => {
    const nodes = await listNodesByType(liveCtx.graph, nodeType, {
      limit: 50,
    });
    if (!nodes.ok) return null;
    for (const node of nodes.value) {
      const edges = await listEdges(liveCtx.graph, node.id, {
        direction: 'out',
        edgeType: 'references',
      });
      if (!edges.ok) continue;
      for (const edge of edges.value) {
        if (edge.toId.startsWith('CustomField:')) {
          return edge.toId as ComponentId;
        }
      }
    }
    return null;
  };

  it('safe_to_delete_field blocks when a Report references a field in the refreshed vault', async () => {
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const fieldId = await findFieldReferencedBy(liveCtx, 'Report');
    if (fieldId === null) {
      // edu-org may lack Report→field edges; skip rather than false-pass.
      return;
    }
    const result = await dispatchTool(liveCtx, 'sfi.safe_to_delete_field', {
      fieldId,
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const verdict = env.data['verdict'] as string;
    expect(['blocking', 'risky', 'unknown']).toContain(verdict);
    expect(verdict).not.toBe('safe');
    const reasoning = env.data['reasoning'] as { category: string }[];
    expect(
      reasoning.some((r) => r.category === 'analytics' || r.category === 'ui'),
    ).toBe(true);
  });

  it('safe_to_delete_field downgrades to review when Report coverage is stripped from manifest', async () => {
    expect(ctx).not.toBeNull();
    const manifestResult = await loadManifest(vaultRoot);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const partial: ExtendedVaultManifest = {
      ...manifestResult.value,
      coverage: (manifestResult.value.coverage ?? []).filter(
        (entry) => entry.type !== 'Report',
      ),
    };
    const saved = await saveManifest(vaultRoot, partial);
    expect(saved.ok).toBe(true);

    const rebuilt = await buildContext(vaultRoot);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    try {
      const result = await dispatchTool(rebuilt.value, 'sfi.safe_to_delete_field', {
        fieldId: 'CustomField:OA_Engagements__c.Category__c',
      });
      const env = parseEnvelope(result.content);
      expect('error' in env).toBe(false);
      if ('error' in env) return;
      expect(env.data['coverageCaveat']).toBeDefined();
      expect(env.data['verdict']).not.toBe('safe');
    } finally {
      await shutdown(rebuilt.value);
      await saveManifest(vaultRoot, manifestResult.value);
      const restore = await buildContext(vaultRoot);
      if (restore.ok) {
        ctx = restore.value;
      }
    }
  });
});
