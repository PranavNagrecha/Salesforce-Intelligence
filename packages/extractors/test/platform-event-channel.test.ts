/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractPlatformEventChannel,
  extractPlatformEventChannelMember,
} from '../src/platform-event-channel.js';

const makeTemp = (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'sfi-platform-event-channel-'));

// CR-CAP-18: PlatformEventChannel + PlatformEventChannelMember model the
// PUBLISH/stream-routing topology (channel 1—* member, member 1—1 entity).
// Channel→member is `parentOf`; member→event is `references` carrying the
// declared per-member `filterExpression`. NO new EdgeType.
describe('CR-CAP-18 platform-event-channel extractors', () => {
  it('extracts a PlatformEventChannel node with channelType + label (node-only, no edges)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'Application_Event_Channel__chn.platformEventChannel-meta.xml',
      );
      await writeFile(
        path,
        '<PlatformEventChannel xmlns="http://soap.sforce.com/2006/04/metadata"><channelType>event</channelType><label>Application Event Channel</label></PlatformEventChannel>',
        'utf8',
      );
      const result = await extractPlatformEventChannel(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      // The `__chn` fullName suffix is preserved in the canonical id so a
      // member's <eventChannel> resolves to exactly this node.
      expect(node?.id).toBe(
        'PlatformEventChannel:Application_Event_Channel__chn',
      );
      expect(node?.type).toBe('PlatformEventChannel');
      expect(node?.apiName).toBe('Application_Event_Channel__chn');
      expect(node?.parentId).toBeNull();
      expect(node?.properties.channelType).toBe('event');
      expect(node?.properties.label).toBe('Application Event Channel');
      // LANE-E: `<eventType>` distinguishes a channel carrying the org's own
      // events from one carrying platform-defined streams. Read verbatim;
      // `null` when the org omitted it, never guessed from channelType.
      expect(node?.properties).toHaveProperty('eventType');
      // Channel is a node-only container; member files carry the edges.
      expect(result.value.edges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts a PlatformEventChannelMember: parentOf(channel→member) + references(member→event) carrying filterExpression', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'Application_Event_Member__chn.platformEventChannelMember-meta.xml',
      );
      await writeFile(
        path,
        "<PlatformEventChannelMember xmlns=\"http://soap.sforce.com/2006/04/metadata\"><eventChannel>Application_Event_Channel__chn</eventChannel><selectedEntity>Application_Event__e</selectedEntity><filterExpression>Status__c = 'New'</filterExpression></PlatformEventChannelMember>",
        'utf8',
      );
      const result = await extractPlatformEventChannelMember(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.value.nodes[0];
      expect(node?.id).toBe(
        'PlatformEventChannelMember:Application_Event_Member__chn',
      );
      expect(node?.type).toBe('PlatformEventChannelMember');
      // member node's parentId is the channel id (parent→child convention).
      expect(node?.parentId).toBe(
        'PlatformEventChannel:Application_Event_Channel__chn',
      );
      expect(node?.properties.eventChannel).toBe(
        'Application_Event_Channel__chn',
      );
      expect(node?.properties.selectedEntity).toBe('Application_Event__e');
      expect(node?.properties.filterExpression).toBe("Status__c = 'New'");

      // parentOf is emitted FROM the channel TO the member (parent→child),
      // mirroring buildOutboundMessageNodes / CustomField→CustomObject.
      const parentOf = result.value.edges.find(
        (e) => e.edgeType === 'parentOf',
      );
      expect(parentOf?.fromId).toBe(
        'PlatformEventChannel:Application_Event_Channel__chn',
      );
      expect(parentOf?.toId).toBe(
        'PlatformEventChannelMember:Application_Event_Member__chn',
      );

      // references is the load-bearing topology edge member→event; it carries
      // the declared per-member filterExpression + channelKind so the consumer
      // surfaces the filter without a second hop.
      const ref = result.value.edges.find((e) => e.edgeType === 'references');
      expect(ref?.fromId).toBe(
        'PlatformEventChannelMember:Application_Event_Member__chn',
      );
      expect(ref?.toId).toBe('CustomObject:Application_Event__e');
      expect(ref?.confidence).toBe('declared');
      expect(ref?.properties.referenceKind).toBe('platformEventChannelMember');
      expect(ref?.properties.filterExpression).toBe("Status__c = 'New'");
      // The `event`-channel selectedEntity resolves to a real __e CustomObject
      // node in-vault → targetMissing is unset.
      expect(ref?.properties.targetMissing).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // PLATFORM-EVENT-CHANNEL-CHANGEEVENTS-PHANTOM: a standard-CDC member declares
  // <eventChannel>ChangeEvents</eventChannel> — the platform built-in channel
  // has NO metadata file / node, so a parentOf edge or parentId pointing at
  // PlatformEventChannel:ChangeEvents is a dead-end phantom. The member must
  // omit that phantom parent while keeping its member→ChangeEvent references
  // edge. RED PRE-FIX: parentId === 'PlatformEventChannel:ChangeEvents' and a
  // parentOf edge to it exists.
  it('standard ChangeEvents CDC channel: omits the phantom parentOf edge + nulls parentId (PLATFORM-EVENT-CHANNEL-CHANGEEVENTS-PHANTOM)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'ChangeEvents_WidgetChangeEvent.platformEventChannelMember-meta.xml',
      );
      await writeFile(
        path,
        '<PlatformEventChannelMember xmlns="http://soap.sforce.com/2006/04/metadata"><eventChannel>ChangeEvents</eventChannel><selectedEntity>WidgetChangeEvent</selectedEntity></PlatformEventChannelMember>',
        'utf8',
      );
      const result = await extractPlatformEventChannelMember(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.value.nodes[0];
      // No phantom parent: parentId is null and the standard-channel disclosure
      // flag is set, but the channel name is still recorded as a fact.
      expect(node?.parentId).toBeNull();
      expect(node?.properties.standardChannel).toBe(true);
      expect(node?.properties.eventChannel).toBe('ChangeEvents');

      // No parentOf edge dead-ending at PlatformEventChannel:ChangeEvents.
      const parentOf = result.value.edges.filter(
        (e) => e.edgeType === 'parentOf',
      );
      expect(parentOf).toEqual([]);
      expect(
        result.value.edges.some(
          (e) => e.toId === 'PlatformEventChannel:ChangeEvents',
        ),
      ).toBe(false);
      expect(
        result.value.edges.some(
          (e) => e.fromId === 'PlatformEventChannel:ChangeEvents',
        ),
      ).toBe(false);

      // The load-bearing member→ChangeEvent references edge is untouched, so
      // cdc_subscribers still reports CDC enablement for this entity.
      const ref = result.value.edges.find((e) => e.edgeType === 'references');
      expect(ref?.toId).toBe('CustomObject:WidgetChangeEvent');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('custom __chn channel keeps its parentOf edge + parentId (no regression from the standard-channel guard)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'Custom_Member__chn.platformEventChannelMember-meta.xml',
      );
      await writeFile(
        path,
        '<PlatformEventChannelMember xmlns="http://soap.sforce.com/2006/04/metadata"><eventChannel>Custom_Channel__chn</eventChannel><selectedEntity>Widget__e</selectedEntity></PlatformEventChannelMember>',
        'utf8',
      );
      const result = await extractPlatformEventChannelMember(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.parentId).toBe('PlatformEventChannel:Custom_Channel__chn');
      expect(node?.properties.standardChannel).toBeUndefined();
      const parentOf = result.value.edges.find((e) => e.edgeType === 'parentOf');
      expect(parentOf?.fromId).toBe('PlatformEventChannel:Custom_Channel__chn');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('data-channel member: bare CDC entity name is prefixed CustomObject: (targetMissing is import-stamped, not extractor-set)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'Order_Member__chn.platformEventChannelMember-meta.xml',
      );
      // a `data` channel selectedEntity is a CDC/standard entity typically
      // absent from an offline vault → references emitted to the would-be node;
      // the IMPORTER stamps targetMissing against the final node set (the
      // extractor cannot know vault membership), so the extractor does NOT
      // set targetMissing here.
      await writeFile(
        path,
        '<PlatformEventChannelMember xmlns="http://soap.sforce.com/2006/04/metadata"><eventChannel>Order_Channel__chn</eventChannel><selectedEntity>AccountChangeEvent</selectedEntity></PlatformEventChannelMember>',
        'utf8',
      );
      const result = await extractPlatformEventChannelMember(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ref = result.value.edges.find((e) => e.edgeType === 'references');
      expect(ref?.toId).toBe('CustomObject:AccountChangeEvent');
      // No filterExpression present → property omitted, not null/empty.
      expect(ref?.properties.filterExpression).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
