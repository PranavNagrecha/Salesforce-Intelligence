/// <reference types="vitest/globals" />

/**
 * Longitudinal tools: trend, churn, org_history after refresh + snapshots.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRefresh } from '../../packages/cli/src/commands/refresh.js';
import { runSnapshotCreate } from '../../packages/cli/src/commands/snapshot.js';
import {
  buildContext,
  dispatchTool,
  shutdown,
  type Context,
} from '../../packages/mcp/src/index.js';

import { FIXTURE_SOURCE } from './fixture-paths.js';

const parseEnvelope = (content: readonly { type: string; text?: string }[]):
  | { data: Record<string, unknown> }
  | { error: unknown } => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as
    | { data: Record<string, unknown> }
    | { error: unknown };
};

let cwd = '';
let ctx: Context | null = null;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-snapshot-trend-'));
  const vaultRoot = join(cwd, 'org-kb');
  await mkdir(join(vaultRoot, 'meta'), { recursive: true });

  await cp(FIXTURE_SOURCE, join(vaultRoot, 'source'), { recursive: true });

  await writeFile(
    join(vaultRoot, 'meta', 'config.json'),
    JSON.stringify({
      targetOrg: 'snapshot-trend-test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-29T00:00:00.000Z',
      snapshotOnRefresh: false,
    }),
    'utf8',
  );

  const refresh = await runRefresh({ cwd, noPull: true });
  if (refresh.status === 'failed') {
    throw new Error(refresh.fatalError ?? 'refresh failed');
  }

  const snap1 = await runSnapshotCreate({ cwd, label: 'snap-a' });
  const snap2 = await runSnapshotCreate({ cwd, label: 'snap-b' });
  if (!snap1.ok || !snap2.ok) {
    throw new Error('snapshot create failed');
  }

  const built = await buildContext(vaultRoot);
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  ctx = built.value;
}, 120_000);

afterAll(async () => {
  if (ctx !== null) {
    await shutdown(ctx);
    ctx = null;
  }
  if (cwd.length > 0) {
    await rm(cwd, { recursive: true, force: true });
  }
});

describe('snapshot trend (v4.1)', () => {
  it('sfi.trend lists persisted snapshot points', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.trend', {});
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const points = env.data['points'] as unknown[];
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it('sfi.churn compares two snapshot labels', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.churn', {
      fromLabel: 'snap-a',
      toLabel: 'snap-b',
    });
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    expect(env.data['fromLabel']).toBe('snap-a');
    expect(env.data['toLabel']).toBe('snap-b');
  });

  it('sfi.org_history is readable after refresh', async () => {
    expect(ctx).not.toBeNull();
    const result = await dispatchTool(ctx as Context, 'sfi.org_history', {});
    const env = parseEnvelope(result.content);
    expect('error' in env).toBe(false);
    if ('error' in env) return;
    const entries = env.data['entries'] as unknown[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
