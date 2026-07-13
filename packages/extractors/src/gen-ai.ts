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

import { deriveComponentApiName } from './path-utils.js';

/**
 * R6-13 — Agentforce / Einstein GenAI extraction tier.
 *
 * Four generative-AI metadata families that were entirely unmodeled before
 * R6-13 (zero ComponentType, zero extraction) — the org's OWN AI surface,
 * which the product's "the backend your Salesforce AI can trust" positioning
 * previously could not see:
 *
 *   - `GenAiFunction`       — one agent action (`genAiFunctions/`). Names the
 *     Apex class / Flow it invokes (`invocationTarget` + `invocationTargetType`).
 *   - `GenAiPlugin`         — one agent topic (`genAiPlugins/`): a category of
 *     actions. References the `GenAiFunction`s it groups (`genAiFunctions >
 *     functionName`).
 *   - `GenAiPlannerBundle`  — one agent definition / planner (`genAiPlannerBundles/`,
 *     nested folder-per-agent). References the `GenAiPlugin` topics and loose
 *     `GenAiFunction` knowledge actions it orchestrates.
 *   - `GenAiPromptTemplate` — one prompt template (`genAiPromptTemplates/`):
 *     the prompt body + the object/field merge-fields it GROUNDS on. The
 *     highest-signal privacy surface — a prompt template that grounds on
 *     `Contact.SSN__c` feeds that field's value into an LLM.
 *
 * All edges REUSE the existing generic `references` EdgeType tagged with a
 * `properties.referenceKind` discriminator (no new EdgeType — mirroring
 * CustomPermission / PlatformEventChannel). Every edge is `declared`: each
 * reference (a `<functionName>`, a `<genAiPluginName>`, an `<invocationTarget>`,
 * an explicit `{!$Input:Account.Industry}` merge-field, a `<relatedField>`) is
 * an explicit metadata pointer, not a heuristic inference.
 *
 * HONESTY axis:
 *   - A prompt template's grounding merge-field resolves to a real
 *     `CustomField:{Object}.{Field}` id ONLY when the merge-field's input
 *     reference is DECLARED as an SObject input (`<inputs>` with
 *     `<definition>SOBJECT://{Object}</definition>`). A merge-field whose input
 *     is a primitive, a relationship traversal (`{!$Input:X.Rel.Field}`), or
 *     undeclared is recorded in `properties.unresolvedGroundingRefs` rather
 *     than minting a phantom field edge from a guessed object.
 *   - The RUNTIME behaviour of the agent (which topic the planner actually
 *     selects, whether a grounded field is populated, what the LLM does with
 *     it) is NOT modeled — this is the DECLARED wiring, not an execution trace.
 *
 * Bot / BotVersion (legacy Einstein Bots) were deliberately OUT of scope for
 * the original R6-13 slice (verification org shape + nested folder layout).
 * They landed as R7-C7 (`bot.ts`); `sfi.ai_exposure_report` now composes both
 * the GenAI tier and Bot context-variable / planner reach.
 */

const EXTRACTOR_SOURCE = 'gen-ai-extractor';

const GEN_AI_FUNCTION_SUFFIX = '.genAiFunction-meta.xml';
const GEN_AI_PLUGIN_SUFFIX = '.genAiPlugin-meta.xml';
const GEN_AI_PLANNER_BUNDLE_SUFFIX = '.genAiPlannerBundle-meta.xml';
const GEN_AI_PROMPT_TEMPLATE_SUFFIX = '.genAiPromptTemplate-meta.xml';

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
 * `parse()` silently truncates on mismatched tags). Mirrors
 * `standard-value-set.ts` so the GenAI tier shares one parse contract.
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

/**
 * Accumulate `references` edges keyed by target id so a field referenced via
 * two kinds (e.g. a `relatedField` that is ALSO a grounding merge-field) emits
 * ONE edge — the graph edge PK is `(fromId,toId,edgeType,source)`, so two
 * `references` edges to the same target would collide and one would silently
 * drop at import. First kind (in priority order of emission) wins.
 */
class ReferenceAccumulator {
  private readonly byTarget = new Map<ComponentId, string>();

  add(targetId: ComponentId, referenceKind: string): void {
    if (!this.byTarget.has(targetId)) this.byTarget.set(targetId, referenceKind);
  }

  edges(fromId: ComponentId): Edge[] {
    return [...this.byTarget.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([toId, referenceKind]) => ({
        fromId,
        toId,
        edgeType: 'references' as const,
        confidence: 'declared' as const,
        source: EXTRACTOR_SOURCE,
        properties: { referenceKind },
      }));
  }
}

const makeNode = (
  type: Node['type'],
  apiName: string,
  path: string,
  label: string | null,
  properties: Readonly<Record<string, unknown>>,
): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label,
  parentId: null,
  sourcePath: path,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

// ============================================================================
// GenAiFunction — one agent action
// ============================================================================

/**
 * Extract a `GenAiFunction` node — one Agentforce action. Captures the action
 * `<masterLabel>` (as the node label), `<description>`, and the
 * `<invocationTarget>` / `<invocationTargetType>` pair naming what the action
 * runs. Emits a DECLARED `references` edge to the invoked component when the
 * target type is one this vault models a node for:
 *   - `apex`  → `ApexClass:{invocationTarget}`  (referenceKind `genAiFunctionApexTarget`)
 *   - `flow`  → `Flow:{invocationTarget}`        (referenceKind `genAiFunctionFlowTarget`)
 * Other invocation types (`api`, `externalService`, standard invocable
 * actions) carry no clean graph node, so the target is surfaced on properties
 * only — no phantom edge is minted.
 */
export const extractGenAiFunction = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, 'GenAiFunction', path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const apiName = deriveComponentApiName(path, GEN_AI_FUNCTION_SUFFIX);
  const nodeId: ComponentId = `GenAiFunction:${apiName}`;
  const masterLabel = firstText(root, 'masterLabel');
  const description = firstText(root, 'description');
  const invocationTarget = firstText(root, 'invocationTarget');
  const invocationTargetType = firstText(root, 'invocationTargetType');

  const refs = new ReferenceAccumulator();
  if (invocationTarget !== null && invocationTargetType !== null) {
    if (invocationTargetType === 'apex') {
      refs.add(`ApexClass:${invocationTarget}`, 'genAiFunctionApexTarget');
    } else if (invocationTargetType === 'flow') {
      refs.add(`Flow:${invocationTarget}`, 'genAiFunctionFlowTarget');
    }
  }

  const node = makeNode('GenAiFunction', apiName, path, masterLabel, {
    ...(description !== null ? { description } : {}),
    ...(invocationTarget !== null ? { invocationTarget } : {}),
    ...(invocationTargetType !== null ? { invocationTargetType } : {}),
    isConfirmationRequired: coerceBoolean(unwrapSingle(root['isConfirmationRequired'])),
  });
  return ok({ nodes: [node], edges: refs.edges(nodeId) });
};

// ============================================================================
// GenAiPlugin — one agent topic (a category of actions)
// ============================================================================

/**
 * Extract a `GenAiPlugin` node — one Agentforce topic. Captures
 * `<masterLabel>` (label), `<description>`, `<pluginType>` (`Topic` /
 * `APICustomTopic`), `<scope>` (the topic's job description), `<language>`,
 * and the list of member action names. Emits ONE DECLARED `references` edge
 * per `<genAiFunctions><functionName>` to `GenAiFunction:{functionName}`
 * (referenceKind `genAiPluginFunction`) — the topic → action wiring.
 */
export const extractGenAiPlugin = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, 'GenAiPlugin', path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const apiName = deriveComponentApiName(path, GEN_AI_PLUGIN_SUFFIX);
  const nodeId: ComponentId = `GenAiPlugin:${apiName}`;
  const masterLabel = firstText(root, 'masterLabel');
  const description = firstText(root, 'description');
  const pluginType = firstText(root, 'pluginType');
  const scope = firstText(root, 'scope');
  const language = firstText(root, 'language');

  // Each `<genAiFunctions>` block carries one `<functionName>`; the block
  // itself repeats. Collect every member function name, de-duplicated + sorted.
  const functionNames = [
    ...new Set(
      toArray(root['genAiFunctions']).flatMap((block) =>
        typeof block === 'object' && block !== null
          ? allText(block as Record<string, unknown>, 'functionName')
          : [],
      ),
    ),
  ].sort();

  const refs = new ReferenceAccumulator();
  for (const functionName of functionNames) {
    refs.add(`GenAiFunction:${functionName}`, 'genAiPluginFunction');
  }

  const node = makeNode('GenAiPlugin', apiName, path, masterLabel, {
    ...(description !== null ? { description } : {}),
    ...(pluginType !== null ? { pluginType } : {}),
    ...(scope !== null ? { scope } : {}),
    ...(language !== null ? { language } : {}),
    functionNames,
    functionCount: functionNames.length,
  });
  return ok({ nodes: [node], edges: refs.edges(nodeId) });
};

// ============================================================================
// GenAiPlannerBundle — one agent definition (planner)
// ============================================================================

/**
 * Extract a `GenAiPlannerBundle` node — one Agentforce agent / planner
 * definition. Stored nested under `genAiPlannerBundles/{agent}/`; the node's
 * apiName is the file basename (which equals the agent's fullName). Captures
 * `<masterLabel>` (label), `<description>`, `<plannerType>`, and `<capabilities>`.
 * Emits DECLARED `references` edges for the topics and loose knowledge actions
 * the planner orchestrates:
 *   - `<genAiPlugins><genAiPluginName>`   → `GenAiPlugin:{name}`   (`plannerBundlePlugin`)
 *   - `<genAiFunctions><genAiFunctionName>` → `GenAiFunction:{name}` (`plannerBundleFunction`)
 */
export const extractGenAiPlannerBundle = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, 'GenAiPlannerBundle', path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const apiName = deriveComponentApiName(path, GEN_AI_PLANNER_BUNDLE_SUFFIX);
  const nodeId: ComponentId = `GenAiPlannerBundle:${apiName}`;
  const masterLabel = firstText(root, 'masterLabel');
  const description = firstText(root, 'description');
  const plannerType = firstText(root, 'plannerType');
  const capabilities = allText(root, 'capabilities');

  const pluginNames = [
    ...new Set(
      toArray(root['genAiPlugins']).flatMap((block) =>
        typeof block === 'object' && block !== null
          ? allText(block as Record<string, unknown>, 'genAiPluginName')
          : [],
      ),
    ),
  ].sort();
  const functionNames = [
    ...new Set(
      toArray(root['genAiFunctions']).flatMap((block) =>
        typeof block === 'object' && block !== null
          ? allText(block as Record<string, unknown>, 'genAiFunctionName')
          : [],
      ),
    ),
  ].sort();

  const refs = new ReferenceAccumulator();
  for (const name of pluginNames) refs.add(`GenAiPlugin:${name}`, 'plannerBundlePlugin');
  for (const name of functionNames) refs.add(`GenAiFunction:${name}`, 'plannerBundleFunction');

  const node = makeNode('GenAiPlannerBundle', apiName, path, masterLabel, {
    ...(description !== null ? { description } : {}),
    ...(plannerType !== null ? { plannerType } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    pluginNames,
    pluginCount: pluginNames.length,
    functionNames,
    functionCount: functionNames.length,
  });
  return ok({ nodes: [node], edges: refs.edges(nodeId) });
};

// ============================================================================
// GenAiPromptTemplate — one prompt template (the grounding surface)
// ============================================================================

/** Parse `SOBJECT://{Object}` (a prompt-template input definition) → the object api name, or null. */
const sObjectFromDefinition = (definition: string | null): string | null => {
  if (definition === null) return null;
  const match = /^SOBJECT:\/\/(.+)$/.exec(definition);
  return match?.[1] ?? null;
};

/** A grounding merge-field parsed out of a prompt template's `<content>`. */
interface MergeField {
  /** Provider type prefix — `Input`, `Flow`, `Apex`, … (the `$X:` head). */
  readonly type: string;
  /** The reference name after the type prefix (before the first `.`). */
  readonly reference: string;
  /** The dotted field path after the reference (may be empty for an object-level ground). */
  readonly fieldPath: readonly string[];
}

/**
 * Parse every `{!$Type:Reference.FieldPath}` merge-field out of prompt content.
 * The template's merge-field grammar is `{!$[Type]:[ReferenceName].[FieldPath]}`
 * (e.g. `{!$Input:Recipient.Name}`, `{!$Input:Account.Industry}`,
 * `{!$Flow:Fetch_Products.Prompt}`). Whitespace inside the braces is tolerated.
 */
const parseMergeFields = (content: string): readonly MergeField[] => {
  const out: MergeField[] = [];
  const re = /\{!\s*\$(\w+)\s*:\s*([A-Za-z0-9_.]+)\s*\}/g;
  for (const match of content.matchAll(re)) {
    const type = match[1];
    const body = match[2];
    if (type === undefined || body === undefined) continue;
    const segments = body.split('.').filter((s) => s.length > 0);
    const reference = segments[0];
    if (reference === undefined) continue;
    out.push({ type, reference, fieldPath: segments.slice(1) });
  }
  return out;
};

/**
 * Extract a `GenAiPromptTemplate` node plus its DECLARED grounding edges — the
 * privacy-critical GenAI surface. Beyond the bare node (`masterLabel`,
 * template `type`, `visibility`), it resolves the object/field data the prompt
 * feeds into the LLM:
 *
 *   1. `<relatedEntity>` / `<relatedField>` (field-generation templates):
 *      → `CustomObject:{relatedEntity}` (`promptTemplateRelatedEntity`) and
 *        `CustomField:{relatedEntity}.{relatedField}` (`promptTemplateRelatedField`).
 *   2. `<templateVersions><content>` grounding merge-fields:
 *      - `{!$Input:Ref.Field}` where `Ref` is a DECLARED SObject input
 *        (`<inputs><definition>SOBJECT://{Object}</definition>`) →
 *        `CustomField:{Object}.{Field}` (`promptTemplateGroundingField`), or
 *        `CustomObject:{Object}` when the merge-field is object-level (no field).
 *      - `{!$Flow:Name.…}` → `Flow:{Name}` (`promptTemplateDataProvider`).
 *      - `{!$Apex:Name.…}` → `ApexClass:{Name}` (`promptTemplateDataProvider`).
 *   3. `<templateDataProviders><definition>` — `flow://Name` → `Flow:{Name}`,
 *      `apex://Name` → `ApexClass:{Name}` (`promptTemplateDataProvider`).
 *
 * A merge-field whose input is undeclared, a primitive (not `SOBJECT://`), or
 * a relationship traversal (`{!$Input:X.Rel.Field}` — length > 1 field path)
 * is recorded in `properties.unresolvedGroundingRefs` rather than minting a
 * phantom `CustomField` edge from a guessed object. Confidence is `declared`
 * for every emitted edge — the merge-field / metadata pointer IS the
 * declaration, though the RUNTIME population of a grounded field is not modeled.
 */
export const extractGenAiPromptTemplate = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const parsed = await readParsedXml(path);
  if (!parsed.ok) return parsed;
  const rootResult = resolveRoot(parsed.value, 'GenAiPromptTemplate', path);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;

  const apiName = deriveComponentApiName(path, GEN_AI_PROMPT_TEMPLATE_SUFFIX);
  const nodeId: ComponentId = `GenAiPromptTemplate:${apiName}`;
  const masterLabel = firstText(root, 'masterLabel');
  const templateType = firstText(root, 'type');
  const visibility = firstText(root, 'visibility');
  const description = firstText(root, 'description');
  const relatedEntity = firstText(root, 'relatedEntity');
  const relatedField = firstText(root, 'relatedField');

  const refs = new ReferenceAccumulator();
  const groundingFieldRefs = new Set<ComponentId>();
  const unresolvedGroundingRefs = new Set<string>();

  // (1) related entity / field — the object a field-generation template writes
  // INTO. relatedField is a target-field exposure (the AI's output lands here).
  if (relatedEntity !== null) {
    refs.add(`CustomObject:${relatedEntity}`, 'promptTemplateRelatedEntity');
    if (relatedField !== null) {
      const fieldId: ComponentId = `CustomField:${relatedEntity}.${relatedField}`;
      refs.add(fieldId, 'promptTemplateRelatedField');
      groundingFieldRefs.add(fieldId);
    }
  }

  // Build the input-reference → SObject map across all versions, plus scan each
  // version's content for grounding merge-fields and its data-provider defs.
  const versions = toArray(root['templateVersions']).filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  );
  let versionCount = 0;
  for (const version of versions) {
    versionCount += 1;
    // input referenceName (e.g. `Input:Recipient`) → SObject (e.g. `Contact`).
    const inputSObject = new Map<string, string>();
    for (const rawInput of toArray(version['inputs'])) {
      if (typeof rawInput !== 'object' || rawInput === null) continue;
      const input = rawInput as Record<string, unknown>;
      const referenceName = firstText(input, 'referenceName');
      const sObject = sObjectFromDefinition(firstText(input, 'definition'));
      if (referenceName !== null && sObject !== null) {
        inputSObject.set(referenceName, sObject);
      }
    }

    const content = firstText(version, 'content') ?? '';
    for (const mf of parseMergeFields(content)) {
      const referenceName = `${mf.type}:${mf.reference}`;
      if (mf.type === 'Flow') {
        refs.add(`Flow:${mf.reference}`, 'promptTemplateDataProvider');
        continue;
      }
      if (mf.type === 'Apex') {
        refs.add(`ApexClass:${mf.reference}`, 'promptTemplateDataProvider');
        continue;
      }
      if (mf.type !== 'Input') continue; // $User / $Organization / $Label etc. are not record grounding
      const sObject = inputSObject.get(referenceName);
      if (sObject === undefined) {
        // Undeclared input reference — do NOT guess an object from the bare
        // reference name (that mints a phantom field). Disclose it instead.
        unresolvedGroundingRefs.add(`$${referenceName}${mf.fieldPath.length > 0 ? `.${mf.fieldPath.join('.')}` : ''}`);
        continue;
      }
      if (mf.fieldPath.length === 0) {
        refs.add(`CustomObject:${sObject}`, 'promptTemplateGroundingObject');
      } else if (mf.fieldPath.length === 1) {
        const fieldId: ComponentId = `CustomField:${sObject}.${mf.fieldPath[0]}`;
        refs.add(fieldId, 'promptTemplateGroundingField');
        groundingFieldRefs.add(fieldId);
      } else {
        // Relationship traversal (Input:X.Rel.Field) — the leaf field lives on
        // a related object this parser cannot resolve without the schema graph.
        unresolvedGroundingRefs.add(`$${referenceName}.${mf.fieldPath.join('.')}`);
      }
    }

    // Data providers declared structurally (apex:// / flow:// definitions).
    for (const rawProvider of toArray(version['templateDataProviders'])) {
      if (typeof rawProvider !== 'object' || rawProvider === null) continue;
      const provider = rawProvider as Record<string, unknown>;
      const definition = firstText(provider, 'definition');
      if (definition === null) continue;
      const apexMatch = /^apex:\/\/(.+)$/.exec(definition);
      const flowMatch = /^flow:\/\/(.+)$/.exec(definition);
      if (apexMatch?.[1] !== undefined) {
        refs.add(`ApexClass:${apexMatch[1]}`, 'promptTemplateDataProvider');
      } else if (flowMatch?.[1] !== undefined) {
        refs.add(`Flow:${flowMatch[1]}`, 'promptTemplateDataProvider');
      }
    }
  }

  const node = makeNode('GenAiPromptTemplate', apiName, path, masterLabel, {
    ...(templateType !== null ? { templateType } : {}),
    ...(visibility !== null ? { visibility } : {}),
    ...(description !== null ? { description } : {}),
    ...(relatedEntity !== null ? { relatedEntity } : {}),
    ...(relatedField !== null ? { relatedField } : {}),
    versionCount,
    groundingFieldRefs: [...groundingFieldRefs].sort(),
    groundingFieldCount: groundingFieldRefs.size,
    ...(unresolvedGroundingRefs.size > 0
      ? { unresolvedGroundingRefs: [...unresolvedGroundingRefs].sort() }
      : {}),
  });
  return ok({ nodes: [node], edges: refs.edges(nodeId) });
};
