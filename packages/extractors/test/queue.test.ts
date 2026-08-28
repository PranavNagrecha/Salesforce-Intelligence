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
          // A queue with no <queueMembers> at all was still SCANNED across
          // every channel: `memberChannels: []` is the sentinel that says so.
          queueMembersDeclared: false,
          queueMembersUnparsed: false,
          memberChannels: [],
          memberSource: 'user-direct',
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

  // ───────────────────────────────────────────────────────────────────────────
  // MEMBER CHANNELS — a queue staffed by a role or a group is NOT an empty queue
  //
  // `<queueMembers>` is a container of one WRAPPER ELEMENT PER MEMBER CHANNEL,
  // not a flat user list. Real Queue XML retrieved from a live org carries both
  // `<users><user>…</user></users>` and `<roles><role>…</role></roles>`, and one
  // queue in that corpus declares `<roles>` with NO `<users>` at all. Counting
  // only the `users` channel reported that queue as `memberCount: 0`, which
  // `sfi.empty_queues_and_groups` renders as "empty — review for deletion".
  // That is the opposite of the truth.
  //
  // The extractor therefore counts EVERY channel the XML declares (a deny-list,
  // not an allow-list of element names) and publishes `memberChannels` so a
  // consumer can tell "0 because there are none" from "0 because we only looked
  // at users": a node that carries `memberChannels` was scanned across every
  // channel; a node with no such property came from a users-only refresh.
  // ───────────────────────────────────────────────────────────────────────────
  describe('member channels', () => {
    interface Channel {
      readonly channel: string;
      readonly memberKind: string;
      readonly memberCount: number;
      readonly topologyAsserted: boolean;
    }
    const channelsOf = (props: Record<string, unknown>): readonly Channel[] =>
      props['memberChannels'] as readonly Channel[];

    it('a queue whose ONLY members are a role does NOT report zero members', async () => {
      // The real-org shape, verbatim: <queueMembers><roles><role>…</role></roles>
      // with no <users> block whatsoever.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>false</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>Role Staffed Queue</name>
    <queueMembers>
        <roles>
            <role>Regional_Reviewer</role>
        </roles>
    </queueMembers>
    <queueSobject>
        <sobjectType>Case</sobjectType>
    </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Role_Staffed_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // THE BUG: this was 0, and `empty_queues_and_groups` called the queue empty.
        expect(node.properties['memberCount']).toBe(1);
        // No user is fabricated out of a role member.
        expect(node.properties['memberEmails']).toEqual([]);
        expect(channelsOf(node.properties)).toEqual([
          { channel: 'roles', memberKind: 'role', memberCount: 1, topologyAsserted: true },
        ]);
        // The role topology is asserted as a hasMember edge, exactly as the
        // Group extractor's `Role` variant does.
        const memberEdges = result.value.edges.filter((e) => e.edgeType === 'hasMember');
        expect(memberEdges).toHaveLength(1);
        expect(memberEdges[0]?.toId).toBe('Role:Regional_Reviewer');
        expect(memberEdges[0]?.properties).toEqual({ memberKind: 'role' });
        expect(memberEdges[0]?.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a queue whose ONLY members are a public group does NOT report zero members', async () => {
      // The wrapper element name for the group channel is NOT hardcoded by the
      // extractor, so this case cannot become a false zero if the schema spells
      // it differently than a reader expects. Both spellings must count.
      for (const wrapper of [
        '<groups><group>Support_Team</group></groups>',
        '<publicGroups><publicGroup>Support_Team</publicGroup></publicGroups>',
      ]) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>false</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>Group Staffed Queue</name>
    <queueMembers>
        ${wrapper}
    </queueMembers>
    <queueSobject>
        <sobjectType>Case</sobjectType>
    </queueSobject>
</Queue>`;
        const { dir, path } = await writeTempQueueXml('Group_Staffed_Queue.queue-meta.xml', xml);
        try {
          const result = await extractQueue(path);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const node = result.value.nodes[0];
          expect(node).toBeDefined();
          if (!node) return;
          expect(node.properties['memberCount']).toBe(1);
          const channels = channelsOf(node.properties);
          expect(channels).toHaveLength(1);
          expect(channels[0]?.memberCount).toBe(1);
          // Counted honestly, but the membership topology is NOT asserted for a
          // channel this extractor has no verified id shape for — mirroring the
          // Group extractor's "counted, but topology not asserted" rule.
          expect(channels[0]?.topologyAsserted).toBe(false);
          expect(result.value.edges.filter((e) => e.edgeType === 'hasMember')).toEqual([]);
          // ...and the node says so, so a consumer never reads the silence as
          // "this queue has only these members".
          expect(node.properties['memberSource']).toBe('unknown');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    it('counts roles AND users on a queue that declares both', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>false</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>Mixed Queue</name>
    <queueMembers>
        <roles>
            <role>Regional_Reviewer</role>
        </roles>
        <users>
            <user>first.reviewer@neutral-org.example</user>
            <user>second.reviewer@neutral-org.example</user>
        </users>
    </queueMembers>
    <queueSobject>
        <sobjectType>Case</sobjectType>
    </queueSobject>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Mixed_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // 1 role + 2 users. The old code answered 2 and silently dropped the role.
        expect(node.properties['memberCount']).toBe(3);
        expect(node.properties['memberEmails']).toEqual([
          'first.reviewer@neutral-org.example',
          'second.reviewer@neutral-org.example',
        ]);
        expect(channelsOf(node.properties)).toEqual([
          { channel: 'roles', memberKind: 'role', memberCount: 1, topologyAsserted: true },
          { channel: 'users', memberKind: 'user', memberCount: 2, topologyAsserted: true },
        ]);
        expect(node.properties['memberSource']).toBe('role-resolved');
        const targets = result.value.edges
          .filter((e) => e.edgeType === 'hasMember')
          .map((e) => e.toId)
          .sort();
        expect(targets).toEqual([
          'Role:Regional_Reviewer',
          'User:first.reviewer@neutral-org.example',
          'User:second.reviewer@neutral-org.example',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('publishes memberChannels even when there is no <queueMembers> at all (typed absence)', async () => {
      // R1 in spirit: whether every channel was scanned is decided by whether
      // the node CARRIES `memberChannels`, never by whether it is empty. This
      // queue was scanned across every channel and genuinely holds none.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Truly Empty Queue</name>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Truly_Empty_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(Object.keys(node.properties)).toContain('memberChannels');
        expect(channelsOf(node.properties)).toEqual([]);
        expect(node.properties['queueMembersDeclared']).toBe(false);
        expect(node.properties['memberCount']).toBe(0);
        // A confirmed-clean queue must NOT be poisoned into 'unknown' — that
        // would break the one tool whose job is to find empty queues.
        expect(node.properties['memberSource']).toBe('user-direct');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counts EVERY <queueMembers> block, not just the first', async () => {
      // `unwrapSingle` kept `value[0]` and dropped the rest. A second block's
      // channels vanishing is the same "we only looked at one place" defect as
      // the users-only count, so the walk must aggregate across blocks.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Two Block Queue</name>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <queueMembers>
        <roles>
            <role>Regional_Reviewer</role>
        </roles>
    </queueMembers>
    <queueMembers>
        <users>
            <user>second.block@neutral-org.example</user>
        </users>
    </queueMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Two_Block_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['memberCount']).toBe(2);
        expect(node.properties['memberEmails']).toEqual(['second.block@neutral-org.example']);
        expect(channelsOf(node.properties)).toEqual([
          { channel: 'roles', memberKind: 'role', memberCount: 1, topologyAsserted: true },
          { channel: 'users', memberKind: 'user', memberCount: 1, topologyAsserted: true },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses to call a queue empty off a <queueMembers> block it could not read', async () => {
      // Well-formed XML, schema-invalid content. A `memberCount: 0` derived
      // from a block we did not understand is a CONFIDENT ZERO — the exact
      // thing `sfi.empty_queues_and_groups` must never be handed.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Unreadable Members Queue</name>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <queueMembers>unexpected text</queueMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Unreadable_Members_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['queueMembersUnparsed']).toBe(true);
        expect(node.properties['memberSource']).toBe('unknown');
        expect(node.properties['memberCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('distinguishes an EMPTY <users/> channel from an absent <queueMembers>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Declared Empty Queue</name>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <queueMembers>
        <users/>
    </queueMembers>
</Queue>`;
      const { dir, path } = await writeTempQueueXml('Declared_Empty_Queue.queue-meta.xml', xml);
      try {
        const result = await extractQueue(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['queueMembersDeclared']).toBe(true);
        expect(node.properties['queueMembersUnparsed']).toBe(false);
        expect(channelsOf(node.properties)).toEqual([
          { channel: 'users', memberKind: 'user', memberCount: 0, topologyAsserted: true },
        ]);
        expect(node.properties['memberCount']).toBe(0);
        // An empty wrapper for an UNMODELED channel must not flip the verdict
        // either — nothing was dropped, so nothing is unknown.
        expect(node.properties['memberSource']).toBe('user-direct');
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
