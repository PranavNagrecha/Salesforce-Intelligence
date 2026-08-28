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

const QUEUE_FILE_SUFFIX = '.queue-meta.xml';
const ROOT_ELEMENT = 'Queue';
const EXTRACTOR_SOURCE = 'queue-extractor';
const REQUIRED_ELEMENTS = ['name', 'doesSendEmailToMembers'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence Queue elements
 * (`<name>`, `<doesSendEmailToMembers>`, etc.) use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<queueSobject>` and `<members>` which may
 * appear zero, one, or many times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * The `memberKind` recorded for a `<queueMembers>` child element this
 * extractor has no VERIFIED canonical-id shape for. Such a channel is counted
 * — dropping it is what produced the false `memberCount: 0` — but no
 * `hasMember` edge is asserted for it, mirroring the Group extractor's
 * "counted, but topology not asserted" rule for an unrecognised `<type>`.
 */
const UNMODELED_MEMBER_KIND = 'unmodeled';

/** One `<queueMembers>` child element, as published on `properties.memberChannels`. */
interface MemberChannel {
  /** The wrapper element name, verbatim from the XML (e.g. `users`, `roles`). */
  readonly channel: string;
  /** `user` / `role` for an asserted channel, else {@link UNMODELED_MEMBER_KIND}. */
  readonly memberKind: string;
  /** Leaf references counted beneath the wrapper. */
  readonly memberCount: number;
  /** Whether `hasMember` edges were emitted for this channel. */
  readonly topologyAsserted: boolean;
}

/** Canonical-id shape for a `<queueMembers>` channel whose topology we assert. */
interface AssertedMemberChannel {
  readonly idPrefix: 'User' | 'Role';
  readonly memberKind: 'user' | 'role';
}

/**
 * The `<queueMembers>` channels whose membership topology is turned into
 * `hasMember` edges.
 *
 * Deliberately SHORT and evidence-grounded: `<users><user>…</user></users>` and
 * `<roles><role>…</role></roles>` are the two channels observed verbatim in
 * real `*.queue-meta.xml` retrieved from a live org (one queue in that corpus
 * declares `<roles>` and no `<users>` at all — the case this table exists for).
 * Target ids follow the Group extractor's variant table: `User:{ref}` is
 * dangling by design (there is NO `User` ComponentType), `Role:{ref}` resolves.
 *
 * Adding a row here is an ASSERTION about a canonical id shape, so a channel is
 * only added once its element name has been seen on disk. Everything else is
 * still COUNTED by the generic walk — this table decides edges, never the count,
 * which is exactly why an unlisted channel can no longer become a silent zero.
 */
const ASSERTED_MEMBER_CHANNELS: Readonly<Record<string, AssertedMemberChannel>> = {
  users: { idPrefix: 'User', memberKind: 'user' },
  roles: { idPrefix: 'Role', memberKind: 'role' },
};

/**
 * Collect every non-empty leaf scalar beneath a `<queueMembers>` child element,
 * at any depth, in document order.
 *
 * Written structurally rather than against a hardcoded child-element name
 * (`users` → `user`, `roles` → `role`, …) so a channel whose inner element is
 * spelled differently than expected still yields its references instead of an
 * empty array. Self-closing wrappers (`<users/>`) parse to `''` and are
 * dropped, so a declared-but-empty channel counts 0 rather than 1.
 */
const collectLeafRefs = (value: unknown): readonly string[] => {
  const refs: string[] = [];
  const visit = (current: unknown): void => {
    if (current === undefined || current === null) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (typeof current === 'object') {
      for (const child of Object.values(current as Record<string, unknown>)) {
        visit(child);
      }
      return;
    }
    const text = String(current).trim();
    if (text.length > 0) refs.push(text);
  };
  visit(value);
  return refs;
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
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

/** Locate the `<Queue>` root and verify required children per `Queue.md`. */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;
  for (const required of REQUIRED_ELEMENTS) {
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  return ok(rootObj);
};

/**
 * Walk the `<queueSobject>` rows and return the ordered list of distinct
 * `<sobjectType>` values. Duplicates are folded to a single entry per
 * `Queue.md` ("emit at most one edge per `(queue, sobjectType)` pair").
 * Returns a `malformed-input` error when any row is missing
 * `<sobjectType>`.
 */
const collectSobjectTypes = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<{ readonly sobjectTypes: readonly string[]; readonly rowCount: number }, ExtractorError> => {
  const rows = toArray(rootObj['queueSobject']);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sobjectType>',
      });
    }
    const sobjectTypeRaw = unwrapSingle(
      (row as Record<string, unknown>)['sobjectType'],
    );
    if (sobjectTypeRaw === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sobjectType>',
      });
    }
    const sobjectType = String(sobjectTypeRaw);
    if (seen.has(sobjectType)) continue;
    seen.add(sobjectType);
    ordered.push(sobjectType);
  }
  return ok({ sobjectTypes: ordered, rowCount: rows.length });
};

/**
 * Extract a Node and edges from a single Salesforce `*.queue-meta.xml`
 * file.
 *
 * Reads the file, parses it as XML, validates the `<Queue>` root per the
 * vendored `Queue.md` spec, and returns an `ExtractionResult` containing
 * one `Node` of type `'Queue'` and one `sharedWith` edge per distinct
 * `<sobjectType>` (with `edge.properties.relationship = 'queueOwner'`).
 * Duplicate `<queueSobject>` rows targeting the same `sobjectType` are
 * deduplicated.
 *
 * The canonical ID derives from the filename, not from the `<name>`
 * element. `<name>` is the human-readable display label; the filename's
 * basename (minus `.queue-meta.xml`) is the API name.
 *
 * `<queueMembers>` is walked across EVERY member channel it declares, not just
 * `<users>`: `properties.memberCount` is the total over all channels,
 * `properties.memberChannels` names each channel with its own count and whether
 * `hasMember` edges were asserted for it, `properties.queueMembersDeclared`
 * says whether the element was present at all, and
 * `properties.queueMembersUnparsed` says whether a declared block carried
 * content this extractor could not read. A role-staffed queue previously
 * extracted as `memberCount: 0` — which `sfi.empty_queues_and_groups` renders
 * as "empty, review for deletion". `properties.memberEmails` remains the
 * `<users>` channel only. `<queueRoutingConfig>`, when present,
 * is read into `properties.queueRoutingConfig` (a bare string) AND (R6-18)
 * emits a declared `references` edge to `QueueRoutingConfig:{Name}`
 * (`edge.properties.referenceKind = 'queueRoutingConfig'`) — Omni-Channel's
 * "how are cases routed to agents" walks this edge from the Queue to its
 * routing behavior. Verified against a real Queue file from a live org.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<name>` or `<doesSendEmailToMembers>`, or any
 * `<queueSobject>` row missing `<sobjectType>`).
 *
 * @example
 *   const result = await extractQueue(
 *     'force-app/main/default/queues/Tier1_Support.queue-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Queue:Tier1_Support'
 *   }
 */
export const extractQueue = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, QUEUE_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const label = String(unwrapSingle(rootObj['name']));

  const sobjectResult = collectSobjectTypes(rootObj, path);
  if (!sobjectResult.ok) return sobjectResult;
  const { sobjectTypes, rowCount } = sobjectResult.value;

  // MEMBER CHANNELS. `<queueMembers>` is NOT a flat user list — it is a
  // container of one WRAPPER ELEMENT PER MEMBER CHANNEL:
  //   <queueMembers>
  //     <roles><role>Regional_Reviewer</role></roles>
  //     <users><user>someone@example.invalid</user></users>
  //   </queueMembers>
  // Reading only `queueMembers.users.user` counted a role-staffed queue as
  // `memberCount: 0`, and `sfi.empty_queues_and_groups` — the one tool whose
  // job is to name the EMPTY queues — then reported that queue as empty for
  // deletion. That is the opposite of the truth, so the count now walks EVERY
  // channel the XML declares.
  //
  // Channel names are a DENY-LIST, not an allow-list: the walk enumerates
  // whatever children `<queueMembers>` actually carries and counts the leaf
  // references beneath each. A channel this extractor has no VERIFIED id shape
  // for is still counted — it just does not get a `hasMember` edge, mirroring
  // the Group extractor's "counted, but topology not asserted" rule. That is
  // what keeps a schema element nobody here has seen from silently becoming a
  // zero again.
  const queueMembersRaw = rootObj['queueMembers'];
  const queueMembersDeclared = queueMembersRaw !== undefined;
  const memberChannels: MemberChannel[] = [];
  const memberEdges: Edge[] = [];
  let memberEmails: readonly string[] = [];

  // Every `<queueMembers>` block is walked, not just the first. `unwrapSingle`
  // would keep `value[0]` and silently drop a second block's channels — the
  // same "we only looked at one place" shape as the users-only bug. Refs are
  // accumulated PER CHANNEL NAME across blocks so the emitted channel list
  // stays one row per channel.
  const refsByChannel = new Map<string, string[]>();
  // A `<queueMembers>` block that does not parse to an element container (it
  // carried raw text instead of wrappers) is NOT evidence of an empty queue.
  // Reporting `memberCount: 0` off it would be a confident zero from something
  // we could not read, which is the defect this whole walk exists to kill.
  let queueMembersUnparsed = false;

  for (const rawBlock of toArray(queueMembersRaw)) {
    if (typeof rawBlock === 'object' && rawBlock !== null) {
      for (const [channel, value] of Object.entries(rawBlock as Record<string, unknown>)) {
        const existing = refsByChannel.get(channel);
        const refs = collectLeafRefs(value);
        if (existing === undefined) refsByChannel.set(channel, [...refs]);
        else existing.push(...refs);
      }
      continue;
    }
    // `<queueMembers/>` and `<queueMembers></queueMembers>` parse to `''` and
    // are genuinely empty; anything else scalar is text we did not understand.
    if (String(rawBlock ?? '').trim().length > 0) queueMembersUnparsed = true;
  }

  // Sorted so the emitted channel list and edge order are deterministic
  // regardless of the order Salesforce happened to serialize the wrappers in.
  for (const channel of [...refsByChannel.keys()].sort()) {
    const refs: readonly string[] = refsByChannel.get(channel) ?? [];
    const spec = ASSERTED_MEMBER_CHANNELS[channel];
    if (spec === undefined) {
      memberChannels.push({
        channel,
        memberKind: UNMODELED_MEMBER_KIND,
        memberCount: refs.length,
        topologyAsserted: false,
      });
      continue;
    }
    if (spec.memberKind === 'user') memberEmails = [...refs];
    for (const ref of refs) {
      memberEdges.push({
        fromId: nodeId,
        toId: `${spec.idPrefix}:${ref}`,
        edgeType: 'hasMember',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { memberKind: spec.memberKind },
      });
    }
    memberChannels.push({
      channel,
      memberKind: spec.memberKind,
      memberCount: refs.length,
      topologyAsserted: true,
    });
  }

  const memberCount = memberChannels.reduce(
    (total, entry) => total + entry.memberCount,
    0,
  );
  // `memberSource` is the vocabulary `sfi.empty_queues_and_groups` already
  // reads off the node (it defaults to `'user-direct'` when the extractor does
  // not tag it — which is how a role-staffed queue used to be labelled as a
  // plain zero). An UNMODELED channel that actually carries references means we
  // counted members whose KIND we cannot name, so the honest label is
  // `'unknown'`: that consumer then refuses to assert emptiness rather than
  // guessing. An unmodeled wrapper that is EMPTY dropped nothing, so it must
  // not poison a genuinely-clean queue into `'unknown'`.
  const memberSource: 'unknown' | 'role-resolved' | 'user-direct' =
    queueMembersUnparsed ||
    memberChannels.some((c) => !c.topologyAsserted && c.memberCount > 0)
      ? 'unknown'
      : memberChannels.some((c) => c.memberKind === 'role' && c.memberCount > 0)
        ? 'role-resolved'
        : 'user-direct';

  const node: Node = {
    id: nodeId,
    type: 'Queue',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: optionalString(rootObj, 'description'),
      email: optionalString(rootObj, 'email'),
      doesSendEmailToMembers: coerceBoolean(
        unwrapSingle(rootObj['doesSendEmailToMembers']),
      ),
      doesIncludeBosses: coerceBoolean(unwrapSingle(rootObj['doesIncludeBosses'])),
      queueRoutingConfig: optionalString(rootObj, 'queueRoutingConfig'),
      sobjectTypeCount: rowCount,
      memberCount,
      memberEmails,
      // TYPED ABSENCE (in the spirit of the MCP tier's
      // `absence-disclosure.ts`, which packages/extractors must not import):
      // whether every member channel was scanned is decided by whether the node
      // CARRIES `memberChannels`, never by whether it is empty. A node with
      // `memberChannels: []` was walked across every declared channel and holds
      // none; a node from an older, users-only refresh carries no such property
      // at all, and its `memberCount: 0` is "we only looked at users", not
      // "there are none". `queueMembersDeclared` separates a queue with no
      // `<queueMembers>` element from one that declares empty wrappers, and
      // `queueMembersUnparsed` flags a block whose content this extractor could
      // not read at all: its `memberCount: 0` is "we could not tell", never
      // "there are none".
      queueMembersDeclared,
      queueMembersUnparsed,
      memberChannels,
      memberSource,
    },
  };

  const edges: Edge[] = sobjectTypes.map((sobjectType) => ({
    fromId: nodeId,
    toId: `CustomObject:${sobjectType}`,
    edgeType: 'sharedWith' as const,
    confidence: 'declared' as const,
    source: EXTRACTOR_SOURCE,
    properties: { relationship: 'queueOwner' },
  }));

  // R6-18: `<queueRoutingConfig>` was already read into
  // `properties.queueRoutingConfig` (a bare string) but never turned into an
  // edge. Verified against a real Queue file from a live org
  // (`<queueRoutingConfig>cases_Routing_config</queueRoutingConfig>`
  // resolving to a real `QueueRoutingConfig` fullName retrieved from the same
  // org) — the value is a declared metadata pointer, not a heuristic guess.
  // Queues REFERENCE routing configs, never the reverse; the routing config
  // file itself carries no back-pointer to the queues that use it.
  const routingConfigEdges: Edge[] =
    rootObj['queueRoutingConfig'] !== undefined
      ? [
          {
            fromId: nodeId,
            toId: `QueueRoutingConfig:${String(unwrapSingle(rootObj['queueRoutingConfig']))}`,
            edgeType: 'references' as const,
            confidence: 'declared' as const,
            source: EXTRACTOR_SOURCE,
            properties: { referenceKind: 'queueRoutingConfig' },
          },
        ]
      : [];

  return ok({
    nodes: [node],
    edges: [...edges, ...memberEdges, ...routingConfigEdges],
  });
};
