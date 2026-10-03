/// <reference types="vitest/globals" />

import { saveSnapshot } from '@sf-intelligence/vault';

import { captureLiveSnapshot } from '../../src/tools/diff-snapshots.js';
import { omniChangedSinceHandler } from '../../src/tools/omni-changed-since.js';

import { buildOmniFixture, type OmniFixture } from './omni-fixture.js';

let fx: OmniFixture;

beforeAll(async () => {
  fx = await buildOmniFixture();
  // A "previous refresh": v1 of the Acme Cart script was the active one, and
  // one DataMapper's source was different.
  const now = await captureLiveSnapshot(fx.store, fx.ctx.manifest, fx.vaultRoot);
  if (!now.ok) throw new Error(now.error.message);
  const nodes = now.value.nodes.map((n) => {
    if (n.id === 'OmniScript:Acme_Cart_English_1') return { ...n, runtime: { ...(n.runtime ?? {}), isActive: true } };
    if (n.id === 'OmniScript:Acme_Cart_English_2') return { ...n, runtime: { ...(n.runtime ?? {}), isActive: false } };
    if (n.id === 'OmniDataTransform:AcmeLineTransform_1') return { ...n, runtime: { ...(n.runtime ?? {}), sourceHash: 'an-older-source' } };
    return n;
  });
  const saved = await saveSnapshot(fx.vaultRoot, {
    ...now.value,
    meta: { ...now.value.meta, label: 'refresh-previous', sourceTreeHash: 'sha256:previous' },
    nodes,
  });
  if (!saved.ok) throw new Error(saved.error.message);
}, 60_000);

afterAll(async () => {
  await fx.cleanup();
});

describe('sfi.omni_changed_since', () => {
  it('reports the active-version change with its element-level diff, and a mapper whose source changed', async () => {
    const r = await omniChangedSinceHandler(fx.ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.snapshot).toMatchObject({ label: 'refresh-previous', runtimeRecorded: true, sourceHashed: true });
    const cart = d.changes.find((c) => c.key === 'Acme_Cart_English');
    expect(cart).toMatchObject({
      change: 'active-version-changed',
      before: { activeId: 'OmniScript:Acme_Cart_English_1' },
      now: { activeId: 'OmniScript:Acme_Cart_English_2' },
    });
    expect(cart?.semantic?.renamed).toBe(1);
    expect(cart?.semantic?.sample[0]).toMatch(/OldWrapChoice → WrapChoice/);
    const mapper = d.changes.find((c) => c.key === 'AcmeLineTransform');
    expect(mapper?.change).toBe('mapper-changed');
    expect(mapper?.unknownReason).toBeUndefined();
    // Everything else is unchanged and not listed.
    expect(d.changes.map((c) => c.key).sort()).toEqual(['AcmeLineTransform', 'Acme_Cart_English']);
  });

  it('refuses an unknown snapshot label', async () => {
    const r = await omniChangedSinceHandler(fx.ctx, { snapshot: 'refresh-never' });
    expect(r.ok).toBe(false);
  });
});
