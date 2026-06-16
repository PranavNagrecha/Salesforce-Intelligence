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

import { parseEmailTemplateBody } from './email-template-body-parser.js';
import { deriveEmailTemplateFolderAndName } from './path-utils.js';

const EMAIL_TEMPLATE_FILE_SUFFIX = '.email-meta.xml';
const ROOT_ELEMENT = 'EmailTemplate';
const EXTRACTOR_SOURCE = 'email-template-extractor';
const REQUIRED_ELEMENTS = ['name', 'subject', 'type', 'available'] as const;

const ALLOWED_TYPES = ['text', 'html', 'custom', 'visualforce'] as const;
type TemplateType = (typeof ALLOWED_TYPES)[number];

const ALLOWED_ENCODINGS = [
  'UTF-8',
  'ISO-8859-1',
  'Shift_JIS',
  'ISO-2022-JP',
  'EUC-JP',
  'UTF-16',
] as const;
type Encoding = (typeof ALLOWED_ENCODINGS)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Every EmailTemplate element the extractor
 * reads is single-occurrence; this helper tolerates either shape.
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

/** Locate the `<EmailTemplate>` root and verify required children per `EmailTemplate.md`. */
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
 * Compute body length for `bodyLength` property per the doc:
 *   - For `visualforce` templates, always `0` (the body lives in the
 *     referenced VF page, not inline).
 *   - For `text` / `html` / `custom`, the character length of the
 *     `<content>` body, or `0` when `<content>` is absent.
 */
const computeBodyLength = (
  rootObj: Record<string, unknown>,
  templateType: TemplateType,
): number => {
  if (templateType === 'visualforce') return 0;
  const content = unwrapSingle(rootObj['content']);
  if (content === undefined || content === null) return 0;
  return String(content).length;
};

/**
 * Read the `<content>` body as a string, returning `''` for absent or
 * null content and for visualforce templates (whose merge tokens live
 * in the referenced VF page and are picked up by the visualforce-page
 * extractor). Used by the v3.0 body-merge scan.
 */
const extractBodyForMergeScan = (
  rootObj: Record<string, unknown>,
  templateType: TemplateType,
): string => {
  if (templateType === 'visualforce') return '';
  const raw = unwrapSingle(rootObj['content']);
  if (raw === undefined || raw === null) return '';
  return String(raw);
};

/**
 * Extract a Node and zero-or-more edges from a single Salesforce
 * `*.email-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<EmailTemplate>` root
 * per the vendored `EmailTemplate.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'EmailTemplate'`
 * and a `references` edge set. v1.3 emitted at most one edge (the
 * `<letterhead>` reference); v3.0 augments the edge set with one
 * `references` edge per distinct field merged inside the `<content>`
 * body — see PLAN-v3.0 §3 + §4 R2.
 *
 * The canonical ID is `EmailTemplate:{FolderName}.{TemplateName}`,
 * where `FolderName` is derived from the directory chain between the
 * `email/` ancestor and the file, and `TemplateName` is the filename
 * minus `.email-meta.xml`. Per the doc, flattened nested folders
 * (`email/A/B/Template.email-meta.xml`) preserve the slash in
 * `FolderName` (here, `A/B`), so the canonical id becomes
 * `EmailTemplate:A/B.Template`.
 *
 * The `<letterhead>` element produces a `references` edge with
 * `confidence: 'declared'` and `properties.role: 'letterhead'`. The
 * edge dangles when the named Letterhead is not in the extracted set
 * (a real-world scenario for templates inherited from managed
 * packages).
 *
 * The v3.0 body-merge scan tokenizes the `<content>` body for
 * `{!Object.Field}` and conditional `{!IF(... Object.Field ...)}`
 * merges. Each distinct field produces one `references` edge with
 * `confidence: 'parsed'`, `properties.role: 'body-merge'`,
 * `properties.mergeContext` (the verbatim `{!...}` token), and
 * `properties.conditional` (true when the reference appeared inside a
 * function-call merge). When ANY conditional merge appears, the
 * EmailTemplate node's `properties.richTemplateSyntaxDetected` flag is
 * set so consumers can surface the "field refs captured; firing logic
 * NOT captured" disclosure per PLAN-v3.0 §4. Visualforce templates
 * skip the body scan — their merge tokens live in the referenced VF
 * page and are picked up by the visualforce-page extractor.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, unrecognized `<type>` or `<encoding>`,
 * or path not under `email/{FolderName}/`).
 *
 * @example
 *   const result = await extractEmailTemplate(
 *     'force-app/main/default/email/Sales/WelcomeEmail.email-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'EmailTemplate:Sales.WelcomeEmail'
 *   }
 */
export const extractEmailTemplate = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveEmailTemplateFolderAndName(
    path,
    EMAIL_TEMPLATE_FILE_SUFFIX,
  );
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive FolderName from path',
    });
  }

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale EmailTemplate XML (bodies can be
  // large HTML blobs).
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

  const templateTypeRaw = String(unwrapSingle(rootObj['type']));
  if (!ALLOWED_TYPES.includes(templateTypeRaw as TemplateType)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid template type: ${templateTypeRaw}`,
    });
  }
  const templateType = templateTypeRaw as TemplateType;

  const encodingRaw = optionalString(rootObj, 'encoding');
  if (
    encodingRaw !== null &&
    !ALLOWED_ENCODINGS.includes(encodingRaw as Encoding)
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid encoding: ${encodingRaw}`,
    });
  }

  const { folderName, templateName } = pathParts;
  const scopedApiName = `${folderName}.${templateName}`;
  const nodeId = `${ROOT_ELEMENT}:${scopedApiName}`;
  const label = String(unwrapSingle(rootObj['name']));
  const subject = String(unwrapSingle(rootObj['subject']));
  const available = coerceBoolean(unwrapSingle(rootObj['available']));
  const letterheadName = optionalString(rootObj, 'letterhead');
  const visualforcePageRef = optionalString(rootObj, 'contentVisualforcePage');

  // v3.0 body merge-token scan. The `<content>` element holds the body
  // text/HTML; per PLAN-v3.0 §3 + §4 R2, we tokenize `{!Object.Field}`
  // and `{!FN(...Object.Field...)}` patterns and emit `references`
  // edges with `confidence: 'parsed'`. Visualforce templates skip the
  // scan since their merge tokens live in the referenced VF page.
  const bodyParse = parseEmailTemplateBody(
    extractBodyForMergeScan(rootObj, templateType),
  );

  const mergeFieldIds = bodyParse.references.map(
    (ref) => `CustomField:${ref.objectApiName}.${ref.fieldApiName}`,
  );

  const node: Node = {
    id: nodeId,
    type: 'EmailTemplate',
    apiName: scopedApiName,
    label,
    // Per `EmailTemplate.md`: EmailFolder is not extracted in v1.3, so
    // templates have no graph parent — `parentId` is always null.
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      subject,
      templateType,
      available,
      description: optionalString(rootObj, 'description'),
      encoding: encodingRaw,
      letterheadName,
      style: optionalString(rootObj, 'style'),
      uiType: optionalString(rootObj, 'uiType'),
      visualforcePageRef,
      bodyLength: computeBodyLength(rootObj, templateType),
      // v3.0 additive properties (PLAN-v3.0 §4 emails section). The
      // body-merge extension surfaces three new keys; `mergeFields`
      // mirrors the canonical edge target ids, `referencedObjects`
      // is the dedup'd object summary, and `richTemplateSyntaxDetected`
      // is the conditional-merge boolean.
      mergeFields: mergeFieldIds,
      referencedObjects: bodyParse.referencedObjects,
      richTemplateSyntaxDetected: bodyParse.richTemplateSyntaxDetected,
    },
  };

  // Per `EmailTemplate.md` §"Edges": one `references` edge is emitted
  // when `<letterhead>` is present. v3.0 augments with one `references`
  // edge per distinct merged field; both edge families share the
  // `references` EdgeType but carry different `properties.role` markers
  // so consumers can distinguish letterhead from body-merge references.
  const edges: Edge[] = [];
  if (letterheadName !== null) {
    edges.push({
      fromId: nodeId,
      toId: `Letterhead:${letterheadName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { role: 'letterhead' },
    });
  }
  for (const ref of bodyParse.references) {
    edges.push({
      fromId: nodeId,
      toId: `CustomField:${ref.objectApiName}.${ref.fieldApiName}`,
      edgeType: 'references',
      confidence: 'parsed',
      source: EXTRACTOR_SOURCE,
      properties: {
        role: 'body-merge',
        mergeContext: ref.mergeContext,
        conditional: ref.conditional,
      },
    });
  }

  return ok({ nodes: [node], edges });
};
