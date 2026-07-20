/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractQueue } from '../src/queue.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEAD_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.1/queues/Lead_Queue.queue-meta.xml';
const LEAD_GOLDEN_PATH_REL = 'tests/golden/extractor-queue/Lead_Queue.json';
const MULTI_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.1/queues/Multi_Queue.queue-meta.xml';
const MULTI_GOLDEN_PATH_REL = 'tests/golden/extractor-queue/Multi_Queue.json';

/**
 * Write a `.queue-meta.xml` file under a fresh temp directory. Returns the
 * temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempQueueXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-queue-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractQueue', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Lead_Queue fixture (single <queueSobject>)', async () => {
      // The extractor stores `sourcePath` verbatim. Because vitest's cwd
      // is the package directory and `process.chdir` is unsupported in
      // vitest's worker pool, we call the extractor with the absolute
      // path and patch the golden's `sourcePath` to match.
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEAD_GOLDEN_PATH_REL);

      const result = await extractQueue(fixtureAbsPath);
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

    itHarness('produces the golden output for the Multi_Queue fixture (two <queueSobject> entries)', async () => {
      // Multi_Queue owns both Lead and Case. The extractor must emit
      // one `sharedWith` edge per distinct sobjectType, both with
      // `properties.relationship = 'queueOwner'`.
      const fixtureAbsPath = resolve(HARNESS_ROOT, MULTI_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MULTI_GOLDEN_PATH_REL);

      const result = await extractQueue(fixtureAbsPath);
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

  describe('sharedWith edges', () => {
    itHarness('emits two sharedWith edges for a Multi_Queue with two <queueSobject> rows', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, MULTI_FIXTURE_PATH_REL);
      const result = await extractQueue(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(2);
      const targets = result.value.edges.map((e) => e.toId).sort();
      expect(targets).toEqual(['CustomObject:Case', 'CustomObject:Lead']);
      for (const edge of result.value.edges) {
        expect(edge.fromId).toBe('Queue:Multi_Queue');
        expect(edge.edgeType).toBe('sharedWith');
        expect(edge.confidence).toBe('declared');
        expect(edge.source).toBe('queue-extractor');
        expect(edge.properties).toEqual({ relationship: 'queueOwner' });
      }
    });

    it('emits zero edges for a queue with no <queueSobject>', async () => {
      // Per Queue.md "Optional repeated elements": an absent
      // `<queueSobject>` is a documented happy path — `sobjectTypeCount`
      // is 0 and zero `sharedWith` edges are emitted.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Notification Only</name>
  <doesSendEmailToMembers>true</doesSendEmailToMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'Notification_Only.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['sobjectTypeCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates repeated <queueSobject> entries for the same sobjectType', async () => {
      // Per Queue.md: "emit at most one edge per `(queue, sobjectType)`
      // pair." Duplicate rows still bump `sobjectTypeCount` (which counts
      // the raw rows), but the edge set is deduplicated.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Duplicate</name>
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
  <queueSobject>
    <sobjectType>Lead</sobjectType>
  </queueSobject>
  <queueSobject>
    <sobjectType>Lead</sobjectType>
  </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'Duplicate.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('CustomObject:Lead');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R6-18: queueRoutingConfig reference edge', () => {
    it('emits a declared references edge to QueueRoutingConfig when <queueRoutingConfig> is present', async () => {
      // Verified against a real Queue file from a live org:
      // `<queueRoutingConfig>cases_Routing_config</queueRoutingConfig>`
      // resolving to a real QueueRoutingConfig fullName retrieved from the
      // same org. The value is a declared metadata pointer to a
      // QueueRoutingConfig fullName, not a heuristic guess.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <doesIncludeBosses>true</doesIncludeBosses>
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
  <name>Case_Routing_Queue</name>
  <queueRoutingConfig>Standard_Case_Routing</queueRoutingConfig>
  <queueSobject>
    <sobjectType>Case</sobjectType>
  </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'Case_Routing_Queue.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['queueRoutingConfig']).toBe(
          'Standard_Case_Routing',
        );
        expect(result.value.edges).toContainEqual(
          expect.objectContaining({
            fromId: 'Queue:Case_Routing_Queue',
            toId: 'QueueRoutingConfig:Standard_Case_Routing',
            edgeType: 'references',
            confidence: 'declared',
            source: 'queue-extractor',
            properties: { referenceKind: 'queueRoutingConfig' },
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no QueueRoutingConfig edge when <queueRoutingConfig> is absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No_Routing</name>
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'No_Routing.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.edgeType === 'references'),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional properties', () => {
    it('defaults missing optional fields to null and memberCount to 0 with empty memberEmails', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Bare</name>
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Bare.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          description: null,
          email: null,
          doesSendEmailToMembers: false,
          doesIncludeBosses: false,
          queueRoutingConfig: null,
          sobjectTypeCount: 0,
          memberCount: 0,
          memberEmails: [],
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads doesIncludeBosses=true and memberCount=3 from FM_Approvals_Graduate real-org XML shape', async () => {
      // Real-org XML: <queueMembers><users><user> nesting — the old code
      // read rootObj['members'] (always empty) and never read doesIncludeBosses.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>true</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>FM - Approvals - Graduate</name>
    <queueMembers>
        <users>
            <user>cjones2@neutral-org.example</user>
            <user>lbraverman@neutral-org.example</user>
            <user>spoczos@neutral-org.example</user>
        </users>
    </queueMembers>
    <queueSobject>
        <sobjectType>Utilization__c</sobjectType>
    </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('FM_Approvals_Graduate.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Queue:FM_Approvals_Graduate');
        expect(node.properties['memberCount']).toBe(3);
        expect(node.properties['doesIncludeBosses']).toBe(true);
        expect(node.properties['memberEmails']).toEqual([
          'cjones2@neutral-org.example',
          'lbraverman@neutral-org.example',
          'spoczos@neutral-org.example',
        ]);
        // hasMember edges for each declared user member
        const memberEdges = result.value.edges.filter((e) => e.edgeType === 'hasMember');
        expect(memberEdges).toHaveLength(3);
        const memberTargets = memberEdges.map((e) => e.toId).sort();
        expect(memberTargets).toEqual([
          'User:cjones2@neutral-org.example',
          'User:lbraverman@neutral-org.example',
          'User:spoczos@neutral-org.example',
        ]);
        for (const edge of memberEdges) {
          expect(edge.fromId).toBe('Queue:FM_Approvals_Graduate');
          expect(edge.edgeType).toBe('hasMember');
          expect(edge.confidence).toBe('declared');
          expect(edge.source).toBe('queue-extractor');
          expect(edge.properties).toEqual({ memberKind: 'user' });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads memberCount=7 from ME_Article_Approval_Queue real-org XML shape', async () => {
      // Verifies that the <queueMembers><users><user> nesting is correctly
      // navigated for a queue with 7 declared user members.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>true</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>ME_Article Approval Queue</name>
    <queueMembers>
        <users>
            <user>wnettleton@neutral-org.example</user>
            <user>cyang@neutral-org.example</user>
            <user>lcady@neutral-org.example</user>
            <user>mburke@neutral-org.example</user>
            <user>nmcquade@neutral-org.example</user>
            <user>phoeg@neutral-org.example</user>
            <user>tfunk@neutral-org.example</user>
        </users>
    </queueMembers>
    <queueSobject>
        <sobjectType>KnowledgeArticleVersion</sobjectType>
    </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('ME_Article_Approval_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Queue:ME_Article_Approval_Queue');
        expect(node.properties['memberCount']).toBe(7);
        expect(node.properties['doesIncludeBosses']).toBe(true);
        const memberEdges = result.value.edges.filter((e) => e.edgeType === 'hasMember');
        expect(memberEdges).toHaveLength(7);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads memberCount=2 and emits hasMember edges for Sample_Payment_Approval real-org XML shape', async () => {
      // Verifies v1.2 member resolution: memberEmails array on node properties
      // and hasMember edges emitted for each <user> element.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>true</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>Sample Payment Approval</name>
    <queueMembers>
        <users>
            <user>jsherman@neutral-org.example</user>
            <user>tlackraj@neutral-org.example</user>
        </users>
    </queueMembers>
    <queueSobject>
        <sobjectType>Payment__c</sobjectType>
    </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Sample_Payment_Approval.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Queue:Sample_Payment_Approval');
        expect(node.properties['memberCount']).toBe(2);
        const memberEmails = node.properties['memberEmails'] as string[];
        expect(memberEmails).toContain('jsherman@neutral-org.example');
        expect(memberEmails).toContain('tlackraj@neutral-org.example');
        const memberEdges = result.value.edges.filter((e) => e.edgeType === 'hasMember');
        expect(memberEdges).toHaveLength(2);
        const memberTargets = memberEdges.map((e) => e.toId).sort();
        expect(memberTargets).toEqual([
          'User:jsherman@neutral-org.example',
          'User:tlackraj@neutral-org.example',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.queue-meta.xml';
      const result = await extractQueue(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempQueueXml(
        'Bad.queue-meta.xml',
        '<?xml version="1.0"?><Queue><name>X</wrongClose></Queue>',
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Queue>', async () => {
      const { dir, path } = await writeTempQueueXml(
        'Wrong.queue-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Queue> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <name> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'NoName.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <name>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <doesSendEmailToMembers> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No Send</name>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'NoSend.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <doesSendEmailToMembers>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <queueSobject> row is missing <sobjectType>', async () => {
      // Per Queue.md error table: a `<queueSobject>` row without
      // `<sobjectType>` is malformed input.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Missing SobjectType</name>
  <doesSendEmailToMembers>false</doesSendEmailToMembers>
  <queueSobject>
    <someOtherChild>Junk</someOtherChild>
  </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml(
        'NoSobjectType.queue-meta.xml',
        xml,
      );
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <sobjectType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
