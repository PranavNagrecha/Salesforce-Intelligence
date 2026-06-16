/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractApexClass } from '../src/apex-class.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/classes/MRK_ClearLogsBatch.cls';
const GOLDEN_PATH_REL = 'tests/golden/extractor-apex-class/MRK_ClearLogsBatch.json';
const SMOKE_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/classes/MRK_MockCalloutTest.cls';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>50.0</apiVersion>
    <status>Active</status>
</ApexClass>`;

/**
 * Write a `.cls` and matching `.cls-meta.xml` pair to a freshly-created temp
 * directory and return the `.cls` absolute path. Caller deletes `dir`.
 */
const writeTempApexClass = async (
  className: string,
  clsBody: string,
  metaXml: string = VALID_META_XML,
): Promise<{ dir: string; clsPath: string; metaPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-class-'));
  const clsPath = join(dir, `${className}.cls`);
  const metaPath = `${clsPath}-meta.xml`;
  await writeFile(clsPath, clsBody, 'utf-8');
  await writeFile(metaPath, metaXml, 'utf-8');
  return { dir, clsPath, metaPath };
};

describe('extractApexClass', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the MRK_ClearLogsBatch fixture', async () => {
      // The extractor stores the path verbatim as `sourcePath`. The golden
      // file uses harness-rooted relative paths; vitest runs from the package
      // dir and `process.chdir` is unsupported, so we call with the absolute
      // path and patch the golden's `sourcePath` to match. Every other field
      // is asserted by deep equality.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractApexClass(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('secondary smoke', () => {
    itHarness('marks isTest true and parses annotations for MRK_MockCalloutTest', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SMOKE_FIXTURE_PATH_REL);
      const result = await extractApexClass(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('ApexClass:MRK_MockCalloutTest');
      expect(node.type).toBe('ApexClass');
      expect(node.properties['isTest']).toBe(true);
      expect(node.properties['annotations']).toEqual(['@isTest']);
      expect(node.properties['modifiers']).toEqual(['global']);
      expect(node.properties['implements']).toEqual(['HttpCalloutMock']);
      // v0.3 wiring: every scanner-derived edge carries the heuristic
      // label and the `apex-scanner` source. We don't byte-check edge
      // contents here (that's the golden-output test's job); the smoke
      // assertion just confirms the wiring is in place.
      for (const edge of result.value.edges) {
        expect(edge.fromId).toBe('ApexClass:MRK_MockCalloutTest');
        expect(edge.confidence).toBe('heuristic');
        expect(edge.source).toBe('apex-scanner');
      }
      expect(node.properties).not.toHaveProperty('apexScannerWarnings');
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the .cls is missing', async () => {
      const result = await extractApexClass('/does/not/exist/Nope.cls');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/does/not/exist/Nope.cls');
    });

    it('returns file-not-found with metadata-file-missing when only .cls exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-class-'));
      const clsPath = join(dir, 'Foo.cls');
      await writeFile(clsPath, 'public class Foo {}', 'utf-8');
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
        expect(result.error.path).toBe(`${clsPath}-meta.xml`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the .cls-meta.xml is malformed', async () => {
      const { dir, clsPath, metaPath } = await writeTempApexClass(
        'Foo',
        'public class Foo {}',
        '<?xml version="1.0"?><ApexClass><apiVersion>50.0</wrongClose></ApexClass>',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta XML root is not <ApexClass>', async () => {
      const { dir, clsPath, metaPath } = await writeTempApexClass(
        'Foo',
        'public class Foo {}',
        '<?xml version="1.0"?><WrongRoot><apiVersion>50.0</apiVersion><status>Active</status></WrongRoot>',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <ApexClass> root');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <apiVersion> is missing from the meta XML', async () => {
      const { dir, clsPath, metaPath } = await writeTempApexClass(
        'Foo',
        'public class Foo {}',
        '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
      );
      try {
        const result = await extractApexClass(clsPath);
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
      const { dir, clsPath, metaPath } = await writeTempApexClass(
        'Foo',
        'public class Foo {}',
        '<?xml version="1.0"?><ApexClass><apiVersion>50.0</apiVersion></ApexClass>',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <status>');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the .cls has no class declaration', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'Empty',
        '// just a comment, no class here\n',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'no class or interface declaration found',
        );
        expect(result.error.path).toBe(clsPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the class name does not match the filename', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'Foo',
        'public class Bar {}',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('class name Bar does not match filename Foo');
        expect(result.error.path).toBe(clsPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not silently swallow scanner unbalanced-braces errors', async () => {
      // The class header parses fine (`public class Bar` + `{`), so the
      // extractor's class-declaration check passes; but the scanner's
      // brace walk sees an unmatched `{` and returns an
      // `unbalanced-braces` error. The extractor must still emit the
      // Node and surface the failure as `apexScannerWarnings`.
      const { dir, clsPath } = await writeTempApexClass(
        'Bar',
        'public class Bar { void run() {',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        const warnings = node.properties['apexScannerWarnings'];
        expect(Array.isArray(warnings)).toBe(true);
        expect(warnings).toHaveLength(1);
        expect((warnings as string[])[0]).toMatch(/^apex-scanner: unbalanced-braces at offset \d+: /);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits scanner-derived edges with the documented shape and no warnings', async () => {
      // A small, deterministic body that exercises one write
      // (`o.Industry__c = 'X';`), one method call (`OtherClass.helper()`),
      // and one read (`o.Name`). `o` is a parameter typed `MyObj__c`, so the
      // scanner RESOLVES the receiver to its declared type — the field edges
      // target `CustomField:MyObj__c.*`, not the alias `CustomField:o.*`.
      // Verifies the (fromId, toId, edgeType, confidence, source) tuple for
      // each and confirms the success path omits `apexScannerWarnings`.
      const body =
        "public class Foo { void run(MyObj__c o) { o.Industry__c = 'X'; OtherClass.helper(); String name = o.Name; } }";
      const { dir, clsPath } = await writeTempApexClass('Foo', body);
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).not.toHaveProperty('apexScannerWarnings');

        // Edges are sorted by toId asc, then edgeType asc. Three edges
        // expected.
        const shapes = result.value.edges.map((e) => ({
          fromId: e.fromId,
          toId: e.toId,
          edgeType: e.edgeType,
          confidence: e.confidence,
          source: e.source,
        }));
        expect(shapes).toEqual([
          {
            fromId: 'ApexClass:Foo',
            toId: 'ApexClass:OtherClass',
            edgeType: 'callsApex',
            confidence: 'heuristic',
            source: 'apex-scanner',
          },
          {
            fromId: 'ApexClass:Foo',
            toId: 'CustomField:MyObj__c.Industry__c',
            edgeType: 'writesTo',
            confidence: 'heuristic',
            source: 'apex-scanner',
          },
          {
            fromId: 'ApexClass:Foo',
            toId: 'CustomField:MyObj__c.Name',
            edgeType: 'readsFrom',
            confidence: 'heuristic',
            source: 'apex-scanner',
          },
        ]);

        // Properties carry the scanner span; callsApex also carries the
        // method name.
        const callsApex = result.value.edges.find(
          (e) => e.edgeType === 'callsApex',
        );
        expect(callsApex?.properties).toMatchObject({
          methodName: 'helper',
        });
        expect(typeof (callsApex?.properties as { offset: unknown }).offset).toBe(
          'number',
        );
        expect(typeof (callsApex?.properties as { length: unknown }).length).toBe(
          'number',
        );
        const writesTo = result.value.edges.find(
          (e) => e.edgeType === 'writesTo',
        );
        expect(Object.keys(writesTo?.properties ?? {}).sort()).toEqual([
          'length',
          'offset',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not treat a class keyword buried in a comment as the real class', async () => {
      const clsBody = `// public class FakeOne {} -- not the real one
/*
  public class FakeTwo {}
*/
private class RealClass {}`;
      const { dir, clsPath } = await writeTempApexClass('RealClass', clsBody);
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('ApexClass:RealClass');
        expect(node.properties['modifiers']).toEqual(['private']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // v1.5-R3: async / job / API-surface property classifiers and the
  // listensTo / exposes / dispatchesAsync edge producers. All seven
  // boolean properties default to `false` and are always present so
  // the v1.5 `sfi.list_components(propertyFilter=...)` enum can route
  // by property without distinguishing "absent" from "false". See
  // IntegrationTopologySemantics.md §"Async / job classifier
  // patterns" and PLAN-v1.5.md §3 for the production rules.
  describe('v1.5 async / API classifier booleans', () => {
    it('emits all seven booleans as false on a plain class', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'Plain',
        'public class Plain { void run() {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props).toBeDefined();
        if (!props) return;
        expect(props['isQueueable']).toBe(false);
        expect(props['isSchedulable']).toBe(false);
        expect(props['isBatchable']).toBe(false);
        expect(props['hasFutureMethod']).toBe(false);
        expect(props['hasInvocableMethod']).toBe(false);
        expect(props['hasAuraEnabledMethod']).toBe(false);
        expect(props['isRestResource']).toBe(false);
        // restUrlMapping is omitted from properties when no
        // @RestResource is present (mirrors apexScannerWarnings — the
        // absent case stays out of the golden output).
        expect(props).not.toHaveProperty('restUrlMapping');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets isQueueable when implements Queueable appears in the clause', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountIndexer',
        'public class AccountIndexer implements Database.AllowsCallouts, Queueable { void execute(QueueableContext ctx) {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['isQueueable']).toBe(true);
        expect(props?.['isSchedulable']).toBe(false);
        expect(props?.['isBatchable']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets isSchedulable when implements Schedulable appears', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'NightlyJob',
        'global class NightlyJob implements Schedulable { global void execute(SchedulableContext ctx) {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['isSchedulable']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets isBatchable when implements Database.Batchable<...> appears', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'MyBatch',
        'public class MyBatch implements Database.Batchable<sObject>, Database.Stateful { Iterable<sObject> start(Database.BatchableContext ctx) { return null; } void execute(Database.BatchableContext ctx, List<sObject> scope) {} void finish(Database.BatchableContext ctx) {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['isBatchable']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets hasFutureMethod when any method carries @future', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountActions',
        `public class AccountActions {
  @future(callout=true)
  public static void notifyExternal(Set<Id> ids) {}
  public void inline() {}
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['hasFutureMethod']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets hasInvocableMethod when any method carries @InvocableMethod', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountActions',
        `public class AccountActions {
  @InvocableMethod(label='Snooze')
  public static List<Result> snooze(List<Input> inputs) { return null; }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['hasInvocableMethod']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets hasAuraEnabledMethod when any method carries @AuraEnabled', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountService',
        `public class AccountService {
  @AuraEnabled(cacheable=true)
  public static List<Account> getAccounts() { return null; }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['hasAuraEnabledMethod']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets isRestResource and captures the urlMapping argument', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountResource',
        `@RestResource(urlMapping='/Accounts/*')
global class AccountResource {
  @HttpGet
  global static void doGet() {}
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['isRestResource']).toBe(true);
        expect(result.value.nodes[0]?.properties['restUrlMapping']).toBe(
          '/Accounts/*',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // v1.5-R3: edge producers. listensTo for Triggerable<{Event}__e>,
  // exposes for the three API-surface annotations, dispatchesAsync for
  // the three inline-constructor dispatch shapes.
  describe('v1.5 declared edges', () => {
    it('emits a listensTo edge for implements Triggerable<{Event}__e>', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountChangeSubscriber',
        'public class AccountChangeSubscriber implements Triggerable<Account_Change__e> { public void run(Triggerable.Context<Account_Change__e> ctx) {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        expect(listensTo).toBeDefined();
        expect(listensTo?.fromId).toBe('ApexClass:AccountChangeSubscriber');
        expect(listensTo?.toId).toBe('CustomObject:Account_Change__e');
        expect(listensTo?.confidence).toBe('declared');
        expect(listensTo?.source).toBe('apex-class-extractor');
        expect(listensTo?.properties).toMatchObject({
          eventName: 'Account_Change__e',
          mechanism: 'implementsTriggerable',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT emit listensTo for Triggerable<NonEvent> (no __e suffix)', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'WeirdSubscriber',
        'public class WeirdSubscriber implements Triggerable<Account> { public void run(Triggerable.Context<Account> ctx) {} }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        expect(listensTo).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an exposes edge for @RestResource with the synthetic ExternalApi:rest/{path} id', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountResource',
        `@RestResource(urlMapping='/Accounts')
global class AccountResource {
  @HttpGet
  global static void doGet() {}
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const exposes = result.value.edges.filter(
          (e) => e.edgeType === 'exposes',
        );
        expect(exposes).toHaveLength(1);
        expect(exposes[0]?.toId).toBe('ExternalApi:rest/Accounts');
        expect(exposes[0]?.confidence).toBe('declared');
        expect(exposes[0]?.properties).toMatchObject({
          kind: 'rest',
          urlMapping: '/Accounts',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an exposes edge for @AuraEnabled with the synthetic ExternalApi:aura/{Class} id', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountService',
        `public class AccountService {
  @AuraEnabled
  public static List<Account> getAccounts() { return null; }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const exposes = result.value.edges.filter(
          (e) => e.edgeType === 'exposes',
        );
        expect(exposes).toHaveLength(1);
        expect(exposes[0]?.toId).toBe('ExternalApi:aura/AccountService');
        expect(exposes[0]?.confidence).toBe('declared');
        expect(exposes[0]?.properties).toMatchObject({
          kind: 'aura',
          className: 'AccountService',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an exposes edge for @InvocableMethod with the synthetic ExternalApi:invocable/{Class} id', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountActions',
        `public class AccountActions {
  @InvocableMethod(label='Bulk Snooze')
  public static List<Result> snooze(List<Input> inputs) { return null; }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const exposes = result.value.edges.filter(
          (e) => e.edgeType === 'exposes',
        );
        expect(exposes).toHaveLength(1);
        expect(exposes[0]?.toId).toBe(
          'ExternalApi:invocable/AccountActions',
        );
        expect(exposes[0]?.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a dispatchesAsync edge for System.enqueueJob(new X())', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'AccountHandler',
        `public class AccountHandler {
  public void onAfterInsert(List<Account> accs) {
    System.enqueueJob(new AccountIndexer(accs));
  }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatches = result.value.edges.filter(
          (e) => e.edgeType === 'dispatchesAsync',
        );
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]?.toId).toBe('ApexClass:AccountIndexer');
        expect(dispatches[0]?.confidence).toBe('declared');
        expect(dispatches[0]?.properties).toMatchObject({
          dispatchMechanism: 'enqueueJob',
        });
        // Suppression: the `new AccountIndexer(...)` inside enqueueJob
        // must NOT also surface as a parallel heuristic `references`
        // edge — the dispatch keeps ONLY its `dispatchesAsync` edge.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' &&
              e.toId === 'ApexClass:AccountIndexer',
          ),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a references edge for a generic new X() that is not an async dispatch', async () => {
      // A `new HandlerClass()` passed as a method argument is captured
      // by the generic-instantiation sweep as a heuristic `references`
      // edge (the IDENT.IDENT( scanner is blind to `new X()`). It is NOT
      // a dispatchesAsync shape, so no dispatch edge is produced.
      const { dir, clsPath } = await writeTempApexClass(
        'AccountTriggerHandler',
        `public class AccountTriggerHandler {
  public void run() {
    Dispatcher.Run(new HandlerClass());
  }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
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
        // No dispatchesAsync edge — this is a plain instantiation.
        expect(
          result.value.edges.some((e) => e.edgeType === 'dispatchesAsync'),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a dispatchesAsync edge for Database.executeBatch(new X())', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'BatchRunner',
        `public class BatchRunner {
  public void run() {
    Database.executeBatch(new MyAccountBatch(), 200);
  }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatches = result.value.edges.filter(
          (e) => e.edgeType === 'dispatchesAsync',
        );
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]?.toId).toBe('ApexClass:MyAccountBatch');
        expect(dispatches[0]?.properties).toMatchObject({
          dispatchMechanism: 'executeBatch',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a dispatchesAsync edge for System.schedule(name, cron, new X())', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'Scheduler',
        `public class Scheduler {
  public void kick() {
    System.schedule('Nightly Run', '0 0 2 * * ?', new AccountNightlyJob());
  }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatches = result.value.edges.filter(
          (e) => e.edgeType === 'dispatchesAsync',
        );
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]?.toId).toBe('ApexClass:AccountNightlyJob');
        expect(dispatches[0]?.properties).toMatchObject({
          dispatchMechanism: 'schedule',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT emit dispatchesAsync for an enqueueJob shape that lives inside a string literal', async () => {
      // The dispatch site is inside a quoted string — it should be
      // blanked out by the comment/string strip pass before the
      // regex sees it. Verifies the v0.3 string-strip discipline
      // extends to the v1.5 dispatch detector.
      const { dir, clsPath } = await writeTempApexClass(
        'Stringy',
        `public class Stringy {
  String s = 'System.enqueueJob(new NotARealJob())';
  void run() {}
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dispatches = result.value.edges.filter(
          (e) => e.edgeType === 'dispatchesAsync',
        );
        expect(dispatches).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('extracts the full v1.5 surface from the synthetic AccountActions fixture', async () => {
      // On-disk synthetic that exercises @future, @InvocableMethod,
      // @AuraEnabled, and implements Queueable in one class. This is
      // the canonical multi-surface fixture for the v1.5 extension.
      const fixturePath = resolve(
        HARNESS_ROOT,
        'tests/fixtures/synthetic-v1.5/classes/AccountActions.cls',
      );
      const result = await extractApexClass(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.properties['isQueueable']).toBe(true);
      expect(node?.properties['hasFutureMethod']).toBe(true);
      expect(node?.properties['hasInvocableMethod']).toBe(true);
      expect(node?.properties['hasAuraEnabledMethod']).toBe(true);
      expect(node?.properties['isRestResource']).toBe(false);
      // Two exposes edges (aura + invocable) — REST is absent.
      const exposes = result.value.edges.filter(
        (e) => e.edgeType === 'exposes',
      );
      expect(exposes.map((e) => e.toId).sort()).toEqual([
        'ExternalApi:aura/AccountActions',
        'ExternalApi:invocable/AccountActions',
      ]);
    });

    itHarness('extracts dispatchesAsync edges from the synthetic AccountHandler fixture', async () => {
      // On-disk synthetic exercising all three inline-constructor
      // dispatch shapes: enqueueJob, executeBatch, schedule.
      const fixturePath = resolve(
        HARNESS_ROOT,
        'tests/fixtures/synthetic-v1.5/classes/AccountHandler.cls',
      );
      const result = await extractApexClass(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dispatches = result.value.edges.filter(
        (e) => e.edgeType === 'dispatchesAsync',
      );
      // Sort by toId for deterministic assertion.
      const targets = dispatches.map((e) => e.toId).sort();
      expect(targets).toEqual([
        'ApexClass:AccountIndexer',
        'ApexClass:AccountNightlyJob',
        'ApexClass:AccountReindexBatch',
      ]);
      // All three carry declared confidence and dispatchMechanism.
      for (const e of dispatches) {
        expect(e.confidence).toBe('declared');
        expect(e.properties).toHaveProperty('dispatchMechanism');
      }
    });

    it('combines listensTo + exposes (Queueable + @InvocableMethod) into one class', async () => {
      // A v1.5 synthetic that exercises both the Triggerable
      // listensTo and the @InvocableMethod exposes simultaneously.
      // The Queueable interface produces no edge on its own but
      // flips `isQueueable: true` so the architect's "find all
      // Queueable classes" question routes through propertyFilter.
      const { dir, clsPath } = await writeTempApexClass(
        'MultiSurface',
        `public class MultiSurface implements Queueable, Triggerable<Account_Change__e> {
  @InvocableMethod(label='Kick')
  public static void kick(List<String> ids) {}
  public void run(Triggerable.Context<Account_Change__e> ctx) {}
  public void execute(QueueableContext ctx) {}
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.properties['isQueueable']).toBe(true);
        expect(node?.properties['hasInvocableMethod']).toBe(true);
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        const exposes = result.value.edges.find(
          (e) => e.edgeType === 'exposes',
        );
        expect(listensTo?.toId).toBe('CustomObject:Account_Change__e');
        expect(exposes?.toId).toBe('ExternalApi:invocable/MultiSurface');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // v2.1: code-quality recognizer family is wired into apex-class.ts.
  // The property is always present so consumers can filter by
  // `qualityIssues.length > 0` without an absent-vs-empty distinction.
  describe('v2.1 qualityIssues property', () => {
    it('emits an empty qualityIssues array on a clean class', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'Clean',
        '// Standard service class.\npublic with sharing class Clean { public static Integer doMath(Integer a, Integer b) { return a + b; } }',
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props).toBeDefined();
        if (!props) return;
        expect(props['qualityIssues']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('populates qualityIssues for a class containing a SOQL-in-loop', async () => {
      const { dir, clsPath } = await writeTempApexClass(
        'OppSvc',
        `public class OppSvc {
  public static void run(List<Id> ids) {
    for (Id id : ids) {
      Opportunity o = [SELECT Id FROM Opportunity WHERE Id = :id];
    }
  }
}`,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props).toBeDefined();
        if (!props) return;
        const issues = props['qualityIssues'] as ReadonlyArray<{
          readonly rule: string;
          readonly severity: string;
          readonly confidence: string;
        }>;
        expect(Array.isArray(issues)).toBe(true);
        const rules = issues.map((i) => i.rule);
        expect(rules).toContain('soql-in-loop');
        const soql = issues.find((i) => i.rule === 'soql-in-loop');
        expect(soql?.severity).toBe('critical');
        expect(soql?.confidence).toBe('heuristic');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('flags old-api-version when the metadata declares apiVersion < 50', async () => {
      const oldApiMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>30.0</apiVersion>
    <status>Active</status>
</ApexClass>`;
      const { dir, clsPath } = await writeTempApexClass(
        'Legacy',
        'public class Legacy {}',
        oldApiMeta,
      );
      try {
        const result = await extractApexClass(clsPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props).toBeDefined();
        if (!props) return;
        const issues = props['qualityIssues'] as ReadonlyArray<{
          readonly rule: string;
        }>;
        const rules = issues.map((i) => i.rule);
        expect(rules).toContain('old-api-version');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
