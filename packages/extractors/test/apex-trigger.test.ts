/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractApexTrigger } from '../src/apex-trigger.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/triggers/ContactTrigger.trigger';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-apex-trigger/ContactTrigger.json';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>50.0</apiVersion>
    <status>Active</status>
</ApexTrigger>`;

/**
 * Write a `.trigger` and matching `.trigger-meta.xml` pair to a freshly
 * created temp directory and return both absolute paths. Caller deletes
 * `dir`.
 */
const writeTempApexTrigger = async (
  triggerName: string,
  triggerBody: string,
  metaXml: string = VALID_META_XML,
): Promise<{ dir: string; triggerPath: string; metaPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-trigger-'));
  const triggerPath = join(dir, `${triggerName}.trigger`);
  const metaPath = `${triggerPath}-meta.xml`;
  await writeFile(triggerPath, triggerBody, 'utf-8');
  await writeFile(metaPath, metaXml, 'utf-8');
  return { dir, triggerPath, metaPath };
};

describe('extractApexTrigger', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the ContactTrigger fixture', async () => {
      // The extractor stores the path verbatim as `sourcePath`. The golden
      // file uses harness-rooted relative paths; vitest runs from the package
      // dir and `process.chdir` is unsupported, so we call with the absolute
      // path and patch the golden's `sourcePath` to match. Every other field
      // is asserted by deep equality.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractApexTrigger(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('scanner wiring', () => {
    it('emits triggersOn alongside scanner-derived callsApex, sorted by toId', async () => {
      // The scanner walks brace-balanced inner blocks of the trigger
      // body. Wrapping the call in `if (true) { ... }` gives it a
      // method body to scan; a single-statement trigger has zero inner
      // blocks and yields no scanner edges (covered by the
      // ContactTrigger golden fixture).
      const body = `trigger Foo on Account (after insert) {
  if (true) {
    OtherClass.foo(trigger.newMap);
  }
}`;
      const { dir, triggerPath } = await writeTempApexTrigger('Foo', body);
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).not.toHaveProperty('apexScannerWarnings');

        // toId-asc, edgeType-asc order — declared triggersOn and
        // heuristic callsApex sort interleaved with reads, not by
        // origin.
        const shapes = result.value.edges.map((e) => ({
          toId: e.toId,
          edgeType: e.edgeType,
          confidence: e.confidence,
          source: e.source,
        }));
        // The `trigger.newMap` field access (G3) is dropped — `trigger` is an
        // unresolvable context receiver, not an object, so `CustomField:trigger.newMap`
        // was a dangling phantom edge. Only the real callsApex + the declared
        // triggersOn remain.
        expect(shapes).toEqual([
          {
            toId: 'ApexClass:OtherClass',
            edgeType: 'callsApex',
            confidence: 'heuristic',
            source: 'apex-scanner',
          },
          {
            toId: 'CustomObject:Account',
            edgeType: 'triggersOn',
            confidence: 'declared',
            source: 'apex-trigger-extractor',
          },
        ]);
        // Owner ID is consistent across all edges.
        for (const edge of result.value.edges) {
          expect(edge.fromId).toBe('ApexTrigger:Foo');
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures method-level trigger → handler dispatch on the callsApex edge (P4-C5)', async () => {
      // The canonical trigger-handler pattern: the trigger dispatches to two
      // handler methods. The callsApex edge to the handler must carry BOTH on
      // methods[] — the "trigger → handler method" dispatch edge.
      const body = `trigger AccountTrigger on Account (after insert, after update) {
  if (Trigger.isInsert) {
    Sample_Handler.afterInsert(Trigger.newMap);
  }
  if (Trigger.isUpdate) {
    Sample_Handler.afterUpdate(Trigger.newMap, Trigger.oldMap);
  }
}`;
      const { dir, triggerPath } = await writeTempApexTrigger('AccountTrigger', body);
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatch = result.value.edges.find(
          (e) => e.edgeType === 'callsApex' && e.toId === 'ApexClass:Sample_Handler',
        );
        expect(dispatch).toBeDefined();
        expect(dispatch?.fromId).toBe('ApexTrigger:AccountTrigger');
        expect(dispatch?.properties['methods']).toEqual(['afterInsert', 'afterUpdate']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a declared dispatchesAsync edge for an enqueued Queueable', async () => {
      // The dispatch names the target via `new X(...)` — a shape the regex
      // scanner is blind to. Before the wiring fix this real dependency was
      // dropped; now it surfaces as a declared dispatchesAsync edge alongside
      // the always-present triggersOn.
      const body = `trigger Bar on Account (after insert) {
  if (Trigger.isAfter) {
    System.enqueueJob(new MyQueueable(Trigger.new));
  }
}`;
      const { dir, triggerPath } = await writeTempApexTrigger('Bar', body);
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatch = result.value.edges.find(
          (e) => e.edgeType === 'dispatchesAsync',
        );
        expect(dispatch).toBeDefined();
        expect(dispatch?.toId).toBe('ApexClass:MyQueueable');
        expect(dispatch?.confidence).toBe('declared');
        // The declared triggersOn edge is unaffected.
        expect(
          result.value.edges.some((e) => e.edgeType === 'triggersOn'),
        ).toBe(true);
        // Suppression: the same `new MyQueueable()` must NOT also
        // produce a parallel heuristic `references` edge — the dispatch
        // keeps ONLY its `dispatchesAsync` edge.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' && e.toId === 'ApexClass:MyQueueable',
          ),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a references edge for a new X() passed as a method argument', async () => {
      // `Dispatcher.Run(new HandlerClass())` names HandlerClass only via
      // the constructor — the IDENT.IDENT( scanner is blind to it. The
      // generic-instantiation sweep captures it as a heuristic
      // `references` edge (NOT dispatchesAsync — this is not an async
      // dispatch shape). Mirrors the IEEAccountTrigger case.
      const body = `trigger Acct on Account (after insert) {
  Dispatcher.Run(new HandlerClass());
}`;
      const { dir, triggerPath } = await writeTempApexTrigger('Acct', body);
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const reference = result.value.edges.find(
          (e) =>
            e.edgeType === 'references' && e.toId === 'ApexClass:HandlerClass',
        );
        expect(reference).toBeDefined();
        expect(reference?.confidence).toBe('heuristic');
        expect(reference?.source).toBe('apex-scanner');
        expect(reference?.properties).toMatchObject({
          mechanism: 'instantiation',
        });
        // The declared triggersOn edge is still emitted alongside it.
        const triggersOn = result.value.edges.find(
          (e) => e.edgeType === 'triggersOn',
        );
        expect(triggersOn?.toId).toBe('CustomObject:Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the .trigger is missing', async () => {
      const result = await extractApexTrigger('/does/not/exist/Nope.trigger');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/does/not/exist/Nope.trigger');
    });

    it('returns file-not-found with metadata-file-missing when only .trigger exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-trigger-'));
      const triggerPath = join(dir, 'Foo.trigger');
      await writeFile(
        triggerPath,
        'trigger Foo on Account (after insert) {}',
        'utf-8',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
        expect(result.error.path).toBe(`${triggerPath}-meta.xml`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the .trigger-meta.xml is malformed', async () => {
      const { dir, triggerPath, metaPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Foo on Account (after insert) {}',
        '<?xml version="1.0"?><ApexTrigger><apiVersion>50.0</wrongClose></ApexTrigger>',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta XML root is not <ApexTrigger>', async () => {
      const { dir, triggerPath, metaPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Foo on Account (after insert) {}',
        '<?xml version="1.0"?><WrongRoot><apiVersion>50.0</apiVersion><status>Active</status></WrongRoot>',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <ApexTrigger> root');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <apiVersion> is missing from the meta XML', async () => {
      const { dir, triggerPath, metaPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Foo on Account (after insert) {}',
        '<?xml version="1.0"?><ApexTrigger><status>Active</status></ApexTrigger>',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <apiVersion>');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <status> is missing from the meta XML', async () => {
      const { dir, triggerPath, metaPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Foo on Account (after insert) {}',
        '<?xml version="1.0"?><ApexTrigger><apiVersion>50.0</apiVersion></ApexTrigger>',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <status>');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the .trigger header cannot be parsed', async () => {
      const { dir, triggerPath } = await writeTempApexTrigger(
        'Empty',
        '// just a comment, no trigger here\n',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('cannot parse trigger header');
        expect(result.error.path).toBe(triggerPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the trigger name does not match the filename', async () => {
      const { dir, triggerPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Bar on Account (after insert) {}',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'trigger name Bar does not match filename Foo',
        );
        expect(result.error.path).toBe(triggerPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the event list contains an unknown event', async () => {
      const { dir, triggerPath } = await writeTempApexTrigger(
        'Foo',
        'trigger Foo on Account (before sneeze) {}',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('unknown trigger event: before sneeze');
        expect(result.error.path).toBe(triggerPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // v1.5-R3: Platform Event subscriber recognition. A trigger on an
  // `__e`-suffixed object is a Platform Event subscriber; v1.5 emits
  // a `listensTo` edge in addition to the existing `triggersOn`. The
  // `isPlatformEventSubscriber` property flips to true so the v1.5
  // `sfi.list_components` propertyFilter can route to subscribers
  // without walking edges. See IntegrationTopologySemantics.md Rule 1.
  describe('v1.5 Platform Event subscriber recognition', () => {
    it('emits listensTo alongside triggersOn for an __e-suffixed object', async () => {
      const { dir, triggerPath } = await writeTempApexTrigger(
        'AccountChangeSubscriber',
        `trigger AccountChangeSubscriber on Account_Change__e (after insert) {
  for (Account_Change__e evt : Trigger.New) {}
}`,
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.properties['isPlatformEventSubscriber']).toBe(true);
        // Both `triggersOn` and `listensTo` target the same
        // CustomObject node. They are NOT synonyms — `triggersOn`
        // records the event lifecycle, `listensTo` records the
        // subscription semantics.
        const triggersOn = result.value.edges.find(
          (e) => e.edgeType === 'triggersOn',
        );
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        expect(triggersOn?.toId).toBe('CustomObject:Account_Change__e');
        expect(listensTo).toBeDefined();
        expect(listensTo?.toId).toBe('CustomObject:Account_Change__e');
        expect(listensTo?.confidence).toBe('declared');
        expect(listensTo?.source).toBe('apex-trigger-extractor');
        expect(listensTo?.properties).toMatchObject({
          eventName: 'Account_Change__e',
          mechanism: 'triggerOnPlatformEvent',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('extracts the full v1.5 surface from the synthetic AccountChangeTrigger fixture', async () => {
      // On-disk synthetic trigger on Account_Change__e. Validates the
      // listensTo edge produced from real fixtures, mirroring the
      // ContactTrigger golden coverage but for the v1.5 case.
      const fixturePath = resolve(
        HARNESS_ROOT,
        'tests/fixtures/synthetic-v1.5/triggers/AccountChangeTrigger.trigger',
      );
      const result = await extractApexTrigger(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.properties['isPlatformEventSubscriber']).toBe(true);
      const listensTo = result.value.edges.find(
        (e) => e.edgeType === 'listensTo',
      );
      expect(listensTo?.toId).toBe('CustomObject:Account_Change__e');
    });

    it('does NOT emit listensTo for a sObject trigger (no __e suffix)', async () => {
      const { dir, triggerPath } = await writeTempApexTrigger(
        'AccountTrigger',
        'trigger AccountTrigger on Account (after insert) {}',
      );
      try {
        const result = await extractApexTrigger(triggerPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.properties['isPlatformEventSubscriber']).toBe(false);
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        expect(listensTo).toBeUndefined();
        // triggersOn is still emitted for the sObject case.
        const triggersOn = result.value.edges.find(
          (e) => e.edgeType === 'triggersOn',
        );
        expect(triggersOn?.toId).toBe('CustomObject:Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
