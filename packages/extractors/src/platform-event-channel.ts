import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const EXTRACTOR_SOURCE = 'platform-event-channel-extractor';

const CHANNEL_FILE_SUFFIX = '.platformEventChannel-meta.xml';
const MEMBER_FILE_SUFFIX = '.platformEventChannelMember-meta.xml';
const CHANNEL_ROOT = 'PlatformEventChannel';
const MEMBER_ROOT = 'PlatformEventChannelMember';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent/empty. */
const optionalString = (
  rootObj: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  return s.length === 0 ? null : s;
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates on mismatched tags).
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/** Parse trusted local XML into the root element object, or a typed error. */
const parseRoot = (
  xml: string,
  path: string,
  rootElement: string,
): Result<Record<string, unknown>, ExtractorError> => {
  // Local trusted disk content; XXE not a concern.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
  const root = unwrapSingle(parsed[rootElement]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${rootElement}> root`,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * CR-CAP-18: extract a PlatformEventChannel node from a flat
 * `platformEventChannels/{ChannelName}__chn.platformEventChannel-meta.xml`
 * file. The node id is `PlatformEventChannel:{ChannelName}__chn` (the `__chn`
 * fullName suffix is preserved so a member's `<eventChannel>` resolves to
 * exactly this id). A PlatformEventChannel is the publish/stream container; it
 * carries `<channelType>` (`event` for custom Platform Event channels, `data`
 * for Change Data Capture channels), `<eventType>` (`custom` when the channel
 * carries the org's own events, `standard` for platform-defined streams) and
 * `<label>`.
 *
 * Node-only: the channel→member `parentOf` and member→event `references` edges
 * are emitted by the MEMBER extractor (a member knows its parent channel via
 * `<eventChannel>`; the channel file lists no members). This mirrors the v1.0
 * CustomObject↔CustomField split where the child file owns the parent edge.
 *
 * @example
 *   const r = await extractPlatformEventChannel(
 *     '…/platformEventChannels/Application_Event_Channel__chn.platformEventChannel-meta.xml',
 *   );
 *   // r.value.nodes[0].id === 'PlatformEventChannel:Application_Event_Channel__chn'
 */
export const extractPlatformEventChannel = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;
  const rootResult = parseRoot(xmlResult.value, path, CHANNEL_ROOT);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, CHANNEL_FILE_SUFFIX);
  const label = optionalString(rootObj, 'label');
  const node: Node = {
    id: `${CHANNEL_ROOT}:${apiName}`,
    type: 'PlatformEventChannel',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      channelType: optionalString(rootObj, 'channelType'),
      // `<eventType>` distinguishes a channel carrying the org's OWN events
      // (`custom`) from one carrying platform-defined streams (`standard`).
      // Read verbatim; `null` when the org omitted it.
      eventType: optionalString(rootObj, 'eventType'),
      label,
    },
  };
  return ok({ nodes: [node], edges: [] });
};

/**
 * Prefix a bare entity name with `CustomObject:` to form the canonical id. The
 * selectedEntity in the source XML is always a bare api name (`Application_Event__e`
 * for an `event` channel, `AccountChangeEvent` / `Account` for a `data` channel);
 * Platform Events and CDC entities are modeled as `CustomObject` nodes. Defends
 * against an already-prefixed value to avoid `CustomObject:CustomObject:…`.
 */
const toEntityNodeId = (selectedEntity: string): string =>
  selectedEntity.startsWith('CustomObject:')
    ? selectedEntity
    : `CustomObject:${selectedEntity}`;

/**
 * PLATFORM-EVENT-CHANNEL-CHANGEEVENTS-PHANTOM: a CUSTOM Platform Event / CDC
 * channel is a retrieved metadata component whose fullName always ends in
 * `__chn` (`Widget_Event__chn`), so `PlatformEventChannel:{name}` names
 * a real node (or a targetMissing-by-design one when the channel file was not
 * retrieved). The STANDARD Change Data Capture channel is the platform built-in
 * `ChangeEvents` stream: every standard-CDC `PlatformEventChannelMember`
 * (`ChangeEvents_ContactChangeEvent`, …) declares `<eventChannel>ChangeEvents`,
 * but that channel has NO metadata file and therefore NO node — a `parentOf`
 * edge / `parentId` pointing at `PlatformEventChannel:ChangeEvents` is a phantom
 * endpoint `get_component` cannot resolve (a dead end one hop from the member).
 *
 * Recognise the standard channel by the ABSENCE of the `__chn` custom suffix and
 * omit the phantom parent (no `parentOf` edge, `parentId: null`). The membership
 * fact is preserved verbatim on `properties.eventChannel`, and the load-bearing
 * member→ChangeEvent `references` edge is untouched, so `cdc_subscribers` still
 * reports enablement.
 */
const CUSTOM_CHANNEL_SUFFIX = '__chn';
const isCustomChannel = (eventChannel: string): boolean =>
  eventChannel.endsWith(CUSTOM_CHANNEL_SUFFIX);

/**
 * CR-CAP-18: extract a PlatformEventChannelMember from a flat
 * `platformEventChannelMembers/{MemberName}__chn.platformEventChannelMember-meta.xml`
 * file. A member binds ONE entity (`<selectedEntity>`) onto one channel
 * (`<eventChannel>`) with an optional per-member `<filterExpression>`.
 *
 * Emits (a DEDICATED extractor is required — the generic `childRefs` path
 * cannot carry `filterExpression`, cannot emit a `parentOf` edge, and cannot
 * set the channel parentId):
 *   - the member node, with `parentId` = `PlatformEventChannel:{eventChannel}`
 *     for a CUSTOM `__chn` channel; `parentId: null` for the platform's standard
 *     `ChangeEvents` CDC channel, which has no metadata component / node (see
 *     PLATFORM-EVENT-CHANNEL-CHANGEEVENTS-PHANTOM / {@link isCustomChannel}).
 *   - a `parentOf` edge FROM the channel TO the member (parent→child, mirroring
 *     `buildOutboundMessageNodes` and CustomField→CustomObject) — emitted ONLY
 *     for a custom `__chn` channel; SKIPPED for the standard channel so no edge
 *     dead-ends at a non-existent `PlatformEventChannel:ChangeEvents`.
 *   - a `references` edge FROM the member TO `CustomObject:{selectedEntity}`,
 *     the load-bearing publish-topology edge, carrying
 *     `properties.referenceKind = 'platformEventChannelMember'` and the verbatim
 *     declared `filterExpression` (when present) so the consumer surfaces the
 *     per-channel filter without a second hop. NO new EdgeType.
 *
 * HONESTY: the `filterExpression` is the DECLARED XML text — it is NOT runtime
 * filter EVALUATION (which records actually flow through the channel needs
 * record-level data the offline vault does not have). Confidence is `declared`.
 *
 * targetMissing: for a `data` channel the `selectedEntity` is a CDC/standard
 * entity often absent from an offline vault. This extractor always emits the
 * `references` edge to the would-be node id; the IMPORTER stamps
 * `targetMissing` against the final node set (the extractor cannot know vault
 * membership), mirroring every other dangling-by-design reference.
 */
export const extractPlatformEventChannelMember = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;
  const rootResult = parseRoot(xmlResult.value, path, MEMBER_ROOT);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, MEMBER_FILE_SUFFIX);
  const nodeId = `${MEMBER_ROOT}:${apiName}`;
  const eventChannel = optionalString(rootObj, 'eventChannel');
  const selectedEntity = optionalString(rootObj, 'selectedEntity');
  const filterExpression = optionalString(rootObj, 'filterExpression');

  // PLATFORM-EVENT-CHANNEL-CHANGEEVENTS-PHANTOM: only a CUSTOM `__chn` channel
  // names a real (or targetMissing-by-design) channel node. The standard
  // `ChangeEvents` CDC stream has no metadata file, so binding to it via
  // `parentOf` / `parentId` would mint a dead-end phantom endpoint.
  const isStandardChannel =
    eventChannel !== null && !isCustomChannel(eventChannel);
  const channelId =
    eventChannel === null || isStandardChannel
      ? null
      : `PlatformEventChannel:${eventChannel}`;

  const node: Node = {
    id: nodeId,
    type: 'PlatformEventChannelMember',
    apiName,
    label: null,
    parentId: channelId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      eventChannel,
      selectedEntity,
      ...(filterExpression !== null ? { filterExpression } : {}),
      // Honest disclosure: this member subscribes an entity to the platform's
      // standard CDC channel, which is not a retrievable metadata component —
      // so there is deliberately no channel node to hop to.
      ...(isStandardChannel ? { standardChannel: true } : {}),
    },
  };

  const edges: Edge[] = [];
  // parentOf: channel → member (parent→child), only when the parent channel
  // is named (it always is on real metadata; guard against a malformed file).
  if (channelId !== null) {
    edges.push({
      fromId: channelId,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
  }
  // references: member → event/CDC entity. The load-bearing publish-topology
  // edge; carries the declared per-member filterExpression + channelKind tag.
  if (selectedEntity !== null) {
    edges.push({
      fromId: nodeId,
      toId: toEntityNodeId(selectedEntity),
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {
        referenceKind: 'platformEventChannelMember',
        ...(filterExpression !== null ? { filterExpression } : {}),
      },
    });
  }

  return ok({ nodes: [node], edges });
};
