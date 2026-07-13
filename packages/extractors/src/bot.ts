import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName, deriveParentApiName } from './path-utils.js';

/**
 * R7-C7 — Einstein Bot / Agentforce agent extraction tier. The leftover
 * R6-13 explicitly deferred: "Bot's nested folder-per-bot layout doesn't fit
 * the flat generic pattern."
 *
 * Real files nest TWO ways under `bots/`:
 *
 *   - `Bot` (`bots/{BotName}/{BotName}.bot-meta.xml`) — the bot/agent
 *     DEFINITION. Like `GenAiPlannerBundle`, the file's own basename embeds
 *     the full bot name, so its apiName is basename-derived (the folder
 *     nesting is transparent to identity — see `gen-ai.ts`'s
 *     `extractGenAiPlannerBundle` for the same pattern).
 *   - `BotVersion` (`bots/{BotName}/{fullName}.botVersion-meta.xml`, e.g.
 *     `bots/Foo/v3.botVersion-meta.xml`) — one version of that bot. UNLIKE
 *     `Bot`, real files are named bare (`v1.botVersion-meta.xml`,
 *     `v2.botVersion-meta.xml`, …): the basename alone does NOT disambiguate
 *     across bots (every bot has its own "v1"). The apiName is
 *     `{BotName}.{fileBasename}` — the immediate parent DIRECTORY name +
 *     the file's own suffix-stripped basename — verified against a real
 *     retrieve to match Salesforce's own manifest `fullName` for this type
 *     EXACTLY (e.g. `Campus_Support_Agent.v3`).
 *
 * Both are parsed with `fast-xml-parser` (not the flat regex scanner in
 * `enterprise-metadata.ts`) because `Bot`'s own top-level `<label>` and its
 * nested `<botMlDomain><label>` are DIFFERENT elements with the SAME tag
 * name — a flat whole-file `<label>` scan would take the FIRST occurrence in
 * document order, which (verified against real files) is `botMlDomain`'s
 * label, not the bot's own. `fast-xml-parser` scopes each nesting level
 * correctly, mirroring `gen-ai.ts`'s existing structured-parse pattern.
 *
 * HONESTY axis (corrected against real retrieves from two live orgs, not
 * assumed from documentation):
 *   - Neither `Bot` nor `BotVersion` carry any `status` / `active` /
 *     `versionNumber` element in real retrieved files — a version's
 *     identity IS its own `fullName` (mirrors the `MilestoneType` precedent:
 *     no separate `<name>`, the file's own name is the display name). This
 *     tier does NOT fabricate a status/active property.
 *   - `<botDialogs>` / `<botIntents>` full trees (messages, steps, NLU
 *     training phrases) are NOT extracted — only their COUNT. A modern
 *     Agentforce-template `BotVersion` carries ZERO `<botIntents>` and
 *     instead references a `GenAiPlannerBundle` via
 *     `<conversationDefinitionPlanners><genAiPlannerName>`; a legacy
 *     dialog-tree bot carries `<botIntents>` and no planner reference. Both
 *     shapes are handled — this tier does not assume one generation only.
 *   - `<contextVariables>` emit DECLARED `references` edges to the
 *     SObject fields they map (`contextVariableMappings` →
 *     `CustomField:{Object}.{Field}`, referenceKind
 *     `botContextVariableField`). An `includeInPrompt: true` flag is
 *     carried on the edge properties (Agentforce injects that variable
 *     into the LLM prompt). Unmappable entries (no fieldName / no
 *     resolvable Object.Field) stay counted in `contextVariableCount`
 *     but mint no phantom edge. Composed by `sfi.ai_exposure_report`.
 *   - `botUser` is captured as a raw property, never a fabricated `User:`
 *     edge — there is no `User` ComponentType in this vault (mirrors
 *     `QueueRoutingConfig.userOverflowAssignee`'s existing precedent).
 */

const EXTRACTOR_SOURCE = 'bot-extractor';

const BOT_SUFFIX = '.bot-meta.xml';
const BOT_VERSION_SUFFIX = '.botVersion-meta.xml';
const BOT_ROOT = 'Bot';
const BOT_VERSION_ROOT = 'BotVersion';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize a fast-xml-parser child into an array (tolerates scalar / array / absent). */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; only a literal `true` is truthy (SF default). */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Read the first text value of an element as a trimmed non-empty string, or null. */
const firstText = (obj: Record<string, unknown>, key: string): string | null => {
  const value = unwrapSingle(obj[key]);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

/** Read every text value of a repeatable scalar element as trimmed non-empty strings. */
const allText = (obj: Record<string, unknown>, key: string): readonly string[] =>
  toArray(obj[key])
    .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
    .filter((s) => s.length > 0);

/**
 * Read and strictly-validate a file as XML, then parse it. Validates before
 * parsing so malformed input surfaces as `parse-error` (fast-xml-parser's
 * `parse()` silently truncates on mismatched tags). Mirrors `gen-ai.ts`.
 */
const readParsedXml = async (
  path: string,
): Promise<Result<Record<string, unknown>, ExtractorError>> => {
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
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  try {
    return ok(parser.parse(xmlText) as Record<string, unknown>);
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
};

/** Resolve the single root element `<Root>` of the parsed XML, or a `malformed-input` error. */
const resolveRoot = (
  parsed: Record<string, unknown>,
  rootElement: string,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[rootElement]);
  if (typeof root !== 'object' || root === null) {
    return err({ kind: 'malformed-input', path, message: `expected <${rootElement}> root` });
  }
  return ok(root as Record<string, unknown>);
};

const makeNode = (
  type: Node['type'],
  apiName: string,
  path: string,
  parentId: ComponentId | null,
  label: string | null,
  properties: Readonly<Record<string, unknown>>,
): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label,
  parentId,
  sourcePath: path,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

// ============================================================================
// Bot — the bot/agent definition
// ============================================================================

/**
 * Resolve a context-variable mapping's field pointer to a `CustomField:` id.
 *
 * Salesforce stores either `Object.Field` in `<fieldName>` (common) or a bare
 * field API name with the object on `<SObjectType>`. Anything else is
 * unresolvable — no phantom edge.
 */
const resolveContextVariableFieldId = (
  fieldName: string | null,
  sObjectType: string | null,
): ComponentId | null => {
  if (fieldName === null) return null;
  if (fieldName.includes('.')) {
    const [objectPart, ...rest] = fieldName.split('.');
    const fieldPart = rest.join('.');
    if (!objectPart || !fieldPart || fieldPart.includes('.')) return null;
    return `CustomField:${objectPart}.${fieldPart}`;
  }
  if (sObjectType === null || sObjectType.length === 0) return null;
  return `CustomField:${sObjectType}.${fieldName}`;
};

/**
 * Extract a `Bot` node — one Einstein Bot / Agentforce agent definition.
 * Captures the bot's own `<label>` (as the node label, NOT `botMlDomain`'s
 * nested label — see the module doc for why a flat scan would get this
 * wrong), `<description>`, `<type>` (`Bot` | `ExternalCopilot` |
 * `InternalCopilot`), the Agentforce-template-only `<agentType>` /
 * `<agentTemplate>` (omitted on legacy from-scratch bots), `<botSource>`,
 * `<botUser>` (a raw username property — no `User` ComponentType exists to
 * edge to), `<richContentEnabled>`, `<logPrivateConversationData>`,
 * `<sessionTimeout>`, a `contextVariableCount` (COUNT of `<contextVariables>`
 * blocks), `contextVariableFieldRefs` (the resolvable field mappings), and
 * `botMlDomain` (`{ label, name }`, omitted when the element is absent).
 *
 * Emits one DECLARED `references` edge per resolvable
 * `<contextVariableMappings>` field (`referenceKind: 'botContextVariableField'`,
 * with `includeInPrompt` when the variable opts into the LLM prompt). The
 * `Bot` → `BotVersion` `parentOf` edge is emitted by {@link extractBotVersion},
 * not here — a Bot's own file cannot enumerate its version files without a
 * directory scan, mirroring the `PlatformEventChannel` /
 * `PlatformEventChannelMember` child-owns-the-parent-edge split.
 */
export const extractBot = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, BOT_ROOT, path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const apiName = deriveComponentApiName(path, BOT_SUFFIX);
  const nodeId: ComponentId = `${BOT_ROOT}:${apiName}`;
  const label = firstText(root, 'label');
  const description = firstText(root, 'description');
  const type = firstText(root, 'type');
  const agentType = firstText(root, 'agentType');
  const agentTemplate = firstText(root, 'agentTemplate');
  const botSource = firstText(root, 'botSource');
  const botUser = firstText(root, 'botUser');
  const sessionTimeout = firstText(root, 'sessionTimeout');
  const contextVariableBlocks = toArray(root['contextVariables']);
  const contextVariableCount = contextVariableBlocks.length;

  // Deduplicate field edges by target id; prefer includeInPrompt=true when
  // the same field is mapped by more than one context variable.
  const fieldEdgeByTarget = new Map<
    ComponentId,
    { includeInPrompt: boolean; developerName: string | null }
  >();
  for (const block of contextVariableBlocks) {
    if (typeof block !== 'object' || block === null) continue;
    const cv = block as Record<string, unknown>;
    const developerName = firstText(cv, 'developerName');
    const includeInPrompt = coerceBoolean(unwrapSingle(cv['includeInPrompt']));
    for (const mapping of toArray(cv['contextVariableMappings'])) {
      if (typeof mapping !== 'object' || mapping === null) continue;
      const m = mapping as Record<string, unknown>;
      const fieldId = resolveContextVariableFieldId(
        firstText(m, 'fieldName'),
        firstText(m, 'SObjectType'),
      );
      if (fieldId === null) continue;
      const existing = fieldEdgeByTarget.get(fieldId);
      if (existing === undefined || (includeInPrompt && !existing.includeInPrompt)) {
        fieldEdgeByTarget.set(fieldId, { includeInPrompt, developerName });
      }
    }
  }
  const contextVariableFieldRefs = [...fieldEdgeByTarget.keys()].sort();

  const botMlDomainRaw = unwrapSingle(root['botMlDomain']);
  const botMlDomain =
    typeof botMlDomainRaw === 'object' && botMlDomainRaw !== null
      ? {
          label: firstText(botMlDomainRaw as Record<string, unknown>, 'label'),
          name: firstText(botMlDomainRaw as Record<string, unknown>, 'name'),
        }
      : null;

  const node = makeNode(BOT_ROOT, apiName, path, null, label, {
    ...(description !== null ? { description } : {}),
    ...(type !== null ? { type } : {}),
    ...(agentType !== null ? { agentType } : {}),
    ...(agentTemplate !== null ? { agentTemplate } : {}),
    ...(botSource !== null ? { botSource } : {}),
    ...(botUser !== null ? { botUser } : {}),
    richContentEnabled: coerceBoolean(unwrapSingle(root['richContentEnabled'])),
    logPrivateConversationData: coerceBoolean(unwrapSingle(root['logPrivateConversationData'])),
    ...(sessionTimeout !== null ? { sessionTimeout } : {}),
    contextVariableCount,
    ...(contextVariableFieldRefs.length > 0
      ? { contextVariableFieldRefs }
      : {}),
    ...(botMlDomain !== null ? { botMlDomain } : {}),
  });

  const edges: Edge[] = contextVariableFieldRefs.map((toId) => {
    const meta = fieldEdgeByTarget.get(toId)!;
    return {
      fromId: nodeId,
      toId,
      edgeType: 'references' as const,
      confidence: 'declared' as const,
      source: EXTRACTOR_SOURCE,
      properties: {
        referenceKind: 'botContextVariableField',
        ...(meta.includeInPrompt ? { includeInPrompt: true } : {}),
        ...(meta.developerName !== null ? { contextVariable: meta.developerName } : {}),
      },
    };
  });

  return ok({ nodes: [node], edges });
};

// ============================================================================
// BotVersion — one version of a Bot
// ============================================================================

/**
 * Extract a `BotVersion` node — one version of a `Bot`
 * (`bots/{BotName}/{fullName}.botVersion-meta.xml`). The apiName is
 * directory-disambiguated (`{BotName}.{fileBasename}`) — see the module doc
 * for why the bare basename alone would collide across bots.
 *
 * Captures `dialogCount` (COUNT of `<botDialogs>` blocks — the full
 * dialog/message trees are NOT extracted; out of scope, matching the R6-24
 * report-detail value-omission discipline extended to conversational
 * content), `intentCount` (COUNT of legacy `<botIntents>` blocks — 0 on
 * every Agentforce-template `BotVersion` verified against a real org),
 * `entryDialog`, `toneType`, `knowledgeFallbackEnabled`, `citationsEnabled`
 * (each a raw XML string, omitted when the element is absent — never
 * defaulted), and `plannerNames` (the
 * `<conversationDefinitionPlanners><genAiPlannerName>` targets, deduplicated
 * + sorted).
 *
 * Emits:
 *   - a DECLARED `parentOf` edge FROM `Bot:{BotName}` TO this node (the
 *     directory name IS the declaration — every `BotVersion` file lives
 *     under exactly one `Bot`'s folder).
 *   - one DECLARED `references` edge per `plannerNames` entry to
 *     `GenAiPlannerBundle:{name}` (`referenceKind: 'botVersionPlanner'`) —
 *     the real, verified link between the legacy `Bot` metadata type and the
 *     R6-13 Agentforce GenAI tier.
 */
export const extractBotVersion = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, BOT_VERSION_ROOT, path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const botName = deriveParentApiName(path, 1);
  if (botName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot resolve parent bot from path for BotVersion',
    });
  }
  const versionSuffix = deriveComponentApiName(path, BOT_VERSION_SUFFIX);
  const apiName = `${botName}.${versionSuffix}`;
  const botId: ComponentId = `${BOT_ROOT}:${botName}`;
  const nodeId: ComponentId = `${BOT_VERSION_ROOT}:${apiName}`;

  const dialogCount = toArray(root['botDialogs']).length;
  const intentCount = toArray(root['botIntents']).length;
  const entryDialog = firstText(root, 'entryDialog');
  const toneType = firstText(root, 'toneType');
  const knowledgeFallbackEnabled = firstText(root, 'knowledgeFallbackEnabled');
  const citationsEnabled = firstText(root, 'citationsEnabled');

  const plannerNames = [
    ...new Set(
      toArray(root['conversationDefinitionPlanners']).flatMap((block) =>
        typeof block === 'object' && block !== null
          ? allText(block as Record<string, unknown>, 'genAiPlannerName')
          : [],
      ),
    ),
  ].sort();

  const node = makeNode(BOT_VERSION_ROOT, apiName, path, botId, null, {
    dialogCount,
    intentCount,
    ...(entryDialog !== null ? { entryDialog } : {}),
    ...(toneType !== null ? { toneType } : {}),
    ...(knowledgeFallbackEnabled !== null ? { knowledgeFallbackEnabled } : {}),
    ...(citationsEnabled !== null ? { citationsEnabled } : {}),
    plannerNames,
  });

  const edges: Edge[] = [
    {
      fromId: botId,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
    ...plannerNames.map(
      (name): Edge => ({
        fromId: nodeId,
        toId: `GenAiPlannerBundle:${name}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { referenceKind: 'botVersionPlanner' },
      }),
    ),
  ];

  return ok({ nodes: [node], edges });
};
