/// <reference types="vitest/globals" />

import { listEdges } from '@sf-intelligence/graph';

import { omniCompletionAuditHandler } from '../../src/tools/omni-completion-audit.js';
import { omniDeadReferencesHandler } from '../../src/tools/omni-dead-references.js';
import { omniEditBlockAuditHandler } from '../../src/tools/omni-edit-block-audit.js';
import { omniFormSpecHandler } from '../../src/tools/omni-form-spec.js';
import { omniModelHandler } from '../../src/tools/omni-model.js';
import { omniPathSimulatorHandler } from '../../src/tools/omni-path-simulator.js';
import { omniPrefillTraceHandler } from '../../src/tools/omni-prefill-trace.js';
import { omniSaveTraceHandler } from '../../src/tools/omni-save-trace.js';
import { omniVersionDiffHandler } from '../../src/tools/omni-version-diff.js';

import { buildOmniFixture, type OmniFixture } from './omni-fixture.js';

let fx: OmniFixture;

beforeAll(async () => {
  fx = await buildOmniFixture();
}, 60_000);

afterAll(async () => {
  await fx.cleanup();
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('graph regressions (§11.1 / §11.2)', () => {
  it('resolves an OmniScript → IP key and IP → DataMapper bundle onto the versioned nodes', async () => {
    const os = must(await listEdges(fx.store, 'OmniScript:Acme_Cart_English_2' as never, { direction: 'out' }));
    const ipEdge = os.find((e) => e.properties['targetRawName'] === 'Acme_SaveCart');
    expect(ipEdge?.toId).toBe('OmniIntegrationProcedure:Acme_SaveCart_English_2');
    expect(ipEdge?.properties['targetResolution']).toBe('active-version');
    expect(os.filter((e) => e.properties['targetMissing'] === true)).toEqual([]);
    const ipOut = must(await listEdges(fx.store, 'OmniIntegrationProcedure:Acme_SaveCart_English_2' as never, { direction: 'out' }));
    expect(ipOut.some((e) => e.toId === 'OmniDataTransform:AcmeLineTransform_1')).toBe(true);
  });

  it('emits the Edit Block deleteIPKey dependency (§11.5)', async () => {
    const os = must(await listEdges(fx.store, 'OmniScript:Acme_Cart_English_2' as never, { direction: 'out' }));
    expect(os.some((e) => e.toId === 'OmniIntegrationProcedure:Acme_DeleteRow_English_1' && e.properties['via'] === 'deleteIPKey')).toBe(true);
  });

  it('mints no CustomObject from a Transform mapper JSON input path', async () => {
    const dmOut = must(await listEdges(fx.store, 'OmniDataTransform:AcmeLineTransform_1' as never, { direction: 'out' }));
    expect(dmOut.filter((e) => e.toId.startsWith('CustomObject:'))).toEqual([]);
  });
});

describe('sfi.omni_model', () => {
  it('models the active version from a Type/SubType/Language key', async () => {
    const r = must(await omniModelHandler(fx.ctx, { componentId: 'Acme/Cart/English' }));
    expect(r.data.appliedScope.componentId).toBe('OmniScript:Acme_Cart_English_2');
    expect(r.data.counts.nodes['OmniElement']).toBeGreaterThan(10);
    expect(r.data.nodes?.every((n) => n.id.startsWith('OmniDataKey:') || n.id.startsWith('OmniElement:'))).toBe(true);
  });

  it('pins an inactive version only when asked', async () => {
    const r = must(await omniModelHandler(fx.ctx, { componentId: 'Acme_Cart_English_1' }));
    expect(r.data.appliedScope.componentId).toBe('OmniScript:Acme_Cart_English_2');
    expect(r.data.appliedScope.redirectedFrom).toBe('OmniScript:Acme_Cart_English_1');
    const pinned = must(await omniModelHandler(fx.ctx, { componentId: 'Acme_Cart_English_1', version: 1 }));
    expect(pinned.data.appliedScope.componentId).toBe('OmniScript:Acme_Cart_English_1');
  });

  it('models a DataMapper by bundle name', async () => {
    const r = must(await omniModelHandler(fx.ctx, { componentId: 'AcmeLineTransform', include: 'edges' }));
    expect(r.data.counts.nodes['DataMapperItem']).toBe(4);
    expect(r.data.edges?.some((e) => e.kind === 'dmReads')).toBe(true);
  });
});

describe('sfi.omni_save_trace', () => {
  it('reports the near-miss key as NEVER_SAVED at the mapper, with the field it would feed', async () => {
    const r = must(await omniSaveTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2', step: 'CartStep' }));
    const qty = r.data.rows.find((x) => x.producedKey === 'CartStep:LineEditBlock:AcmeQty__c');
    expect(qty?.status).toBe('NEVER_SAVED');
    expect(qty?.defect).toBe(true);
    expect(qty?.droppedAt?.dataMapper).toBe('OmniDataTransform:AcmeLineTransform_1');
    expect(qty?.nearMiss).toEqual([
      { key: 'LineEditBlock:Acme_Qty__c', rule: 'underscore', feeds: ['CustomField:Acme_Order__c.Acme_Qty__c'] },
    ]);
    const note = r.data.rows.find((x) => x.producedKey === 'CartStep:LineEditBlock:Acme_Note__c');
    expect(note?.status).toBe('SAVED');
    expect(note?.savedTo?.map((s) => s.field)).toEqual(['CustomField:Acme_Order__c.Acme_Note__c']);
    expect(note?.silentFailureSteps.length).toBeGreaterThan(0);
  });

  it('emits NEVER_SAVED and ORPHAN_WRITE findings with citations', async () => {
    const r = must(await omniSaveTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    const codes = r.data.findings.map((f) => f.code).sort();
    expect(codes).toEqual(['NEVER_SAVED', 'ORPHAN_WRITE']);
    const orphan = r.data.orphanWrites[0];
    expect(orphan?.expectedScreenKey).toBe('CartStep:LineEditBlock:Acme_Qty__c');
    expect(orphan?.nearMiss[0]?.key).toBe('CartStep:LineEditBlock:AcmeQty__c');
    for (const f of r.data.findings) {
      expect(f.citations.length).toBeGreaterThan(0);
      expect(f.sourcePath.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', async () => {
    const a = must(await omniSaveTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    const b = must(await omniSaveTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });

  it('refuses two selectors naming different scripts', async () => {
    const r = await omniSaveTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2', componentId: 'OmniScript:Acme_Pets_English_1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

describe('sfi.omni_dead_references', () => {
  it('finds the renamed element left in a show rule, the label comparison and the whitespace keys', async () => {
    const r = must(await omniDeadReferencesHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    const dead = r.data.findings.filter((f) => f.code === 'DEAD_REFERENCE');
    expect(dead.map((f) => f.elementPath)).toContain('CartStep/OldChoiceBlock');
    expect(dead.find((f) => f.elementPath === 'CartStep/OldChoiceBlock')?.evidence['renamedTo']).toMatchObject({ name: 'WrapChoice' });
    const label = r.data.findings.filter((f) => f.code === 'LABEL_NOT_VALUE');
    expect(label.map((f) => f.elementPath)).toEqual(['CartStep/WrapLabelBlock']);
    const ws = r.data.findings.filter((f) => f.code === 'WHITESPACE_KEY').map((f) => f.evidence['value']);
    expect(ws).toEqual(expect.arrayContaining([' sectionName', 'saveFlag ', ' LogError']));
  });

  it('sweeps the vault, including JSON-valued custom metadata', async () => {
    const r = must(await omniDeadReferencesHandler(fx.ctx, { codes: ['WHITESPACE_KEY'] }));
    const values = r.data.findings.map((f) => f.evidence['value'] ?? f.evidence['key']);
    expect(values).toEqual(expect.arrayContaining([' sectionName', 'saveFlag ', ' LogError', 'isPremium ']));
    expect(r.data.appliedScope).toMatchObject({ mode: 'vault' });
  });
});

describe('sfi.omni_version_diff', () => {
  it('reports the rename and the reference it left behind', async () => {
    const r = must(await omniVersionDiffHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    expect(r.data.diff.from.componentId).toBe('OmniScript:Acme_Cart_English_1');
    expect(r.data.diff.renamed).toHaveLength(1);
    const rn = r.data.diff.renamed[0];
    expect([rn?.from.name, rn?.to.name]).toEqual(['OldWrapChoice', 'WrapChoice']);
    expect(rn?.staleReferences.map((s) => s.elementPath)).toEqual(['CartStep/OldChoiceBlock']);
  });
});

describe('sfi.omni_edit_block_audit', () => {
  it('flags screen-only delete and a delete key with no payload, not the wired blocks', async () => {
    const r = must(await omniEditBlockAuditHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    const by = (code: string): string[] => r.data.findings.filter((f) => f.code === code).map((f) => f.elementPath ?? '');
    expect(by('SCREEN_ONLY_DELETE')).toEqual(['CartStep/LineEditBlock']);
    expect(by('DELETE_KEY_NO_PAYLOAD')).toEqual(['CartStep/NoteEditBlock']);
    const gift = r.data.editBlocks.find((b) => b.elementPath === 'CartStep/GiftEditBlock');
    expect(gift?.deleteMechanisms.map((m) => m.mechanism)).toEqual(['deleteIPKey']);
    const wrap = r.data.editBlocks.find((b) => b.elementPath === 'CartStep/WrapEditBlock');
    expect(wrap?.deleteMechanisms.map((m) => m.mechanism)).toEqual(['deleteChildAction']);
    const line = r.data.editBlocks.find((b) => b.elementPath === 'CartStep/LineEditBlock');
    expect(line?.recordIdentity.carried).toBe(true);
  });

  it('flags the card type whose Id the shared mapper never carries', async () => {
    const r = must(await omniEditBlockAuditHandler(fx.ctx, { omniscript: 'Acme_Pets_English_1' }));
    expect(r.data.findings.filter((f) => f.code === 'EDIT_INSERTS_DUPLICATE').map((f) => f.elementPath)).toEqual(['PetStep/ToyEditBlock']);
  });

  it('flags a delete that orphans child records with no server guard (joins F7)', async () => {
    const pets = must(await omniEditBlockAuditHandler(fx.ctx, { omniscript: 'Acme_Pets_English_1' }));
    const dwg = pets.data.findings.filter((f) => f.code === 'DELETE_WITHOUT_GUARD');
    expect(dwg.map((f) => [f.elementPath, f.verdict, f.confidence])).toEqual([['PetStep/PetEditBlock', 'defect', 'inferred']]);
    expect(dwg[0]?.evidence?.['orphanedFields']).toEqual(['CustomField:Acme_Pet_Toy__c.Acme_Pet__c']);
    expect(pets.data.editBlocks.find((b) => b.elementPath === 'PetStep/PetEditBlock')?.recordIdentity.objectsWritten).toEqual(['Acme_Pet__c']);
    // The cart's delete-wired blocks save no object, so nothing is attributed to them.
    const cart = must(await omniEditBlockAuditHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    expect(cart.data.findings.filter((f) => f.code === 'DELETE_WITHOUT_GUARD')).toEqual([]);
  });
});

describe('sfi.omni_completion_audit', () => {
  it('flags an unconditional completion after swallowed writes, and the success flag nobody reads', async () => {
    const r = must(await omniCompletionAuditHandler(fx.ctx, { ip: 'Acme_SaveCart' }));
    const cws = r.data.findings.filter((f) => f.code === 'COMPLETE_WITHOUT_SUCCESS');
    expect(cws.map((f) => f.elementPath)).toEqual(['TryBlock/MarkComplete']);
    expect(cws[0]?.confidence).toBe('inferred');
    const flag = r.data.findings.filter((f) => f.code === 'SUCCESS_FLAG_NEVER_READ');
    expect(flag).toHaveLength(1);
    expect(flag[0]?.evidence['brokenReads']).toEqual(['ErrorStep']);
  });

  it('treats a configured completion marker as parsed', async () => {
    const configured = await buildOmniFixture({
      config: { completionMarkers: [{ remoteClass: 'Acme_SectionService', remoteMethod: 'updateStepStatus' }] },
    });
    try {
      const r = must(await omniCompletionAuditHandler(configured.ctx, { ip: 'Acme_SaveCart' }));
      expect(r.data.findings.find((f) => f.code === 'COMPLETE_WITHOUT_SUCCESS')?.confidence).toBe('parsed');
      expect(r.data.config.status).toBe('loaded');
    } finally {
      await configured.cleanup();
    }
  });
});

describe('sfi.omni_form_spec', () => {
  it('describes inputs with sample values that satisfy them, and flags the patterns', async () => {
    const r = must(await omniFormSpecHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2', step: 'CartStep' }));
    const inputs = r.data.steps.flatMap((s) => s.inputs);
    const zip = inputs.find((i) => i.key === 'CartStep:Acme_Zip__c');
    expect(zip).toMatchObject({ inputKind: 'masked', mask: '99999', pattern: '^[0-9]+$', maxLength: 5, required: true });
    expect(String(zip?.sampleValue)).toMatch(/^[0-9]{5}$/);
    const ext = inputs.find((i) => i.key === 'CartStep:Acme_Ext__c');
    expect(ext).toMatchObject({ inputKind: 'text', maxLength: 4, required: false });
    expect(String(ext?.sampleValue)).toMatch(/^[0-9]{1,4}$/);
    const radio = inputs.find((i) => i.key === 'CartStep:WrapChoice');
    expect(radio?.options).toEqual([{ stored: 'Yes', label: 'Label_Yes' }, { stored: 'No', label: 'Label_No' }]);
    expect(radio?.sampleValue).toBe('Yes');
    const codes = r.data.findings.map((f) => `${f.code}:${f.elementPath ?? ''}`).sort();
    expect(codes).toEqual(['PATTERN_INVALID_IN_BROWSER:CartStep/Acme_Code__c', 'PATTERN_WEAKER_THAN_MASK:CartStep/Acme_Zip__c']);
    expect(r.data.patternsDeclared).toBe(3);
  });
});

describe('sfi.omni_path_simulator', () => {
  it('shows a block only for the stored option name, and names what it could not decide', async () => {
    const r = must(await omniPathSimulatorHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2', answers: { WrapChoice: 'Yes' } }));
    const cart = r.data.steps.find((s) => s.name === 'CartStep');
    expect(cart?.shown).toBe('true');
    const err = r.data.steps.find((s) => s.name === 'ErrorStep');
    expect(err?.shown).toBe('unknown');
    expect(err?.unknownBecause).toEqual(['saveFlag ']);
  });
});

describe('sfi.omni_prefill_trace', () => {
  it('confirms a field that returns at its own key, and flags one that returns under another key in the same card', async () => {
    const r = must(await omniPrefillTraceHandler(fx.ctx, { omniscript: 'Acme_Cart_English_2' }));
    const note = r.data.rows.find((x) => x.producedKey === 'CartStep:LineEditBlock:Acme_Note__c');
    expect(note?.status).toBe('PREFILLED');
    expect(note?.prefilledBy?.[0]?.ip).toBe('OmniIntegrationProcedure:Acme_CartPrefill_English_1');
    const color = r.data.rows.find((x) => x.producedKey === 'CartStep:LineEditBlock:Acme_Color__c');
    expect(color?.status).toBe('NEVER_PREFILLED');
    expect(color?.returnedElsewhere?.map((x) => x.screenKey)).toEqual(['CartStep:LineEditBlock:Colour']);
    expect(r.data.findings.map((f) => `${f.code}:${f.elementPath ?? ''}`)).toEqual(['NEVER_PREFILLED:CartStep/LineEditBlock/Acme_Color__c']);
  });
});
