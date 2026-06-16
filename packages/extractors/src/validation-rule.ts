import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  extractConditions,
  type ConditionSource,
} from './condition-extractor.js';
import { buildReferencesEdges } from './formula-references.js';
import { deriveComponentApiName, deriveParentApiName } from './path-utils.js';

const VALIDATION_RULE_FILE_SUFFIX = '.validationRule-meta.xml';
const ROOT_ELEMENT = 'ValidationRule';
const VALIDATION_RULES_DIR_NAME = 'validationRules';
const REQUIRED_ELEMENTS = ['errorConditionFormula', 'errorMessage', 'active'] as const;
const FORMULA_ELEMENT_NAME = 'errorConditionFormula';

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. ValidationRule elements the extractor reads
 * are all single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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
 * Coerce an XML scalar element to a nullable string. Missing or
 * `undefined` becomes `null`; everything else stringifies. Used for
 * optional string-valued elements that default to `null`.
 */
const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  return String(v);
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

/**
 * Locate and validate the `<ValidationRule>` root in a parsed XML tree,
 * then verify every required child element is present.
 */
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
 * Derive `{ObjectApiName, RuleApiName}` from a `*.validationRule-meta.xml`
 * path.
 *
 * Per the vendored ValidationRule doc, the file lives at
 * `.../objects/{ObjectApiName}/validationRules/{RuleApiName}.validationRule-meta.xml`.
 * The function asserts the immediate parent directory is `validationRules`
 * and that an enclosing directory (the ObjectApiName) exists.
 */
const derivePathParts = (
  path: string,
): Result<{ objectApiName: string; ruleApiName: string }, ExtractorError> => {
  const ruleApiName = deriveComponentApiName(path, VALIDATION_RULE_FILE_SUFFIX);
  const immediateParent = basename(dirname(path));
  const objectApiName = deriveParentApiName(path, 2);
  if (immediateParent !== VALIDATION_RULES_DIR_NAME || objectApiName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive ObjectApiName from path',
    });
  }
  return ok({ objectApiName, ruleApiName });
};

/**
 * Extract a Node and edges from a single Salesforce
 * `*.validationRule-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates required elements per the
 * vendored `ValidationRule.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'ValidationRule'`, one `parentOf` edge
 * from the enclosing CustomObject, and zero or more `references` edges —
 * one per distinct field referenced in `errorConditionFormula`, sorted by
 * `toId` for determinism. Tokenizer errors on the formula are tolerated:
 * the Node and `parentOf` edge still emit, just without `references`.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, or unrecognized DX path layout).
 *
 * @example
 *   const result = await extractValidationRule(
 *     'tests/fixtures/edu-org/source/main/default/objects/Project__c/validationRules/Block_nulling_Advisor_on_EN_students.validationRule-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'ValidationRule:Project__c.Block_nulling_Advisor_on_EN_students'
 *   }
 */
export const extractValidationRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = derivePathParts(path);
  if (!pathParts.ok) return pathParts;
  const { objectApiName, ruleApiName } = pathParts.value;

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
  // cap of 1000). Catch it here so a single pathological file becomes a
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

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `ValidationRule:${objectApiName}.${ruleApiName}`;
  const errorConditionFormula = String(unwrapSingle(rootObj['errorConditionFormula']));
  const errorMessage = String(unwrapSingle(rootObj['errorMessage']));
  const active = coerceBoolean(unwrapSingle(rootObj['active']));

  // v2.0a — A ValidationRule has exactly one condition surface (the
  // `<errorConditionFormula>`). An empty formula emits ZERO
  // ConditionalContext nodes per `ConditionalContextSemantics.md`
  // §"ValidationRule conditions"; the lifecycle narrator treats this
  // as "always-true". The fail-conservative `length === 0` check
  // mirrors the spec's "empty formula" edge case.
  const conditionSources: readonly ConditionSource[] =
    errorConditionFormula.length === 0
      ? []
      : [{ kind: 'formula', expression: errorConditionFormula }];
  const { conditionNodes, firesWhenEdges, conditionsMirror } =
    extractConditions({
      parentId: nodeId,
      sources: conditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  const node: Node = {
    id: nodeId,
    type: 'ValidationRule',
    apiName: ruleApiName,
    label: ruleApiName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: toNullableString(rootObj['description']),
      errorConditionFormula,
      errorMessage,
      errorDisplayField: toNullableString(rootObj['errorDisplayField']),
      active,
      conditions: conditionsMirror,
    },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: 'validation-rule-extractor',
    properties: {},
  };

  const referencesEdges = buildReferencesEdges(
    errorConditionFormula,
    nodeId,
    objectApiName,
    FORMULA_ELEMENT_NAME,
  );

  return ok({
    nodes: [node, ...conditionNodes],
    edges: [parentEdge, ...referencesEdges, ...firesWhenEdges],
  });
};
