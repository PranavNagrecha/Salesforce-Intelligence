import { basename, dirname, extname } from 'node:path';

import { splitPathSegments } from '@sf-intelligence/core';

/**
 * The shape returned by `deriveNestedObjectAndApiName`.
 */
export interface NestedPathParts {
  readonly objectApiName: string;
  readonly apiName: string;
}

/**
 * The shape returned by `deriveEmailTemplateFolderAndName`.
 */
export interface EmailTemplatePathParts {
  readonly folderName: string;
  readonly templateName: string;
}

/**
 * Derive a Salesforce component API name from a metadata file path by
 * stripping a known suffix from the basename.
 *
 * If the basename ends with `suffix`, the suffix is removed and what
 * remains is returned. If the suffix is not present, the function falls
 * back to returning the basename with its trailing extension removed
 * (via `path.extname`). If the basename has no extension either, it is
 * returned unchanged.
 *
 * @example
 *   deriveComponentApiName('/foo/Account.object-meta.xml', '.object-meta.xml');
 *   // => 'Account'
 *
 *   deriveComponentApiName('Account.xml', '.object-meta.xml');
 *   // => 'Account' (suffix absent; falls back to extname stripping)
 */
export const deriveComponentApiName = (filePath: string, suffix: string): string => {
  // NOT `basename()`: `node:path` is bound to the HOST separator, so on a POSIX
  // host `basename('a\\b\\Welcome.email')` returns the WHOLE string. That is
  // the same class of bug as the `split('/')` below — a metadata path arrives
  // with whichever separator the walking platform used, and every derivation
  // here has to accept both.
  const segments = splitPathSegments(filePath);
  const base = segments[segments.length - 1] ?? '';
  if (suffix.length > 0 && base.endsWith(suffix)) {
    return base.slice(0, base.length - suffix.length);
  }
  const ext = extname(base);
  return ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
};

/**
 * Salesforce entity variants that a `.object-meta.xml` file may describe.
 *
 * The variant determines which elements are required by the
 * `CustomObject` extractor. `StandardObject` is documented for
 * completeness; the extractor never runs on standard objects in v0.1
 * (they appear only as edge targets).
 *
 * The canonical ID prefix is always `CustomObject:` regardless of
 * variant; consumers recover the variant from the API name suffix.
 *
 * @see docs/vendor/salesforce-metadata/CustomObject.md
 */
export type EntityVariant =
  | 'CustomObject'
  | 'CustomSetting'
  | 'CustomMetadataType'
  | 'PlatformEvent'
  | 'BigObject'
  | 'KnowledgeArticle'
  | 'StandardObject';

/**
 * Derive the Salesforce entity variant for a `.object-meta.xml` file
 * from its API name suffix and the presence of a `<customSettingsType>`
 * element.
 *
 * Implements the precedence in `CustomObject.md`:
 *
 * ```
 * Variant := match apiName suffix:
 *   '__mdt' -> 'CustomMetadataType'
 *   '__e'   -> 'PlatformEvent'
 *   '__b'   -> 'BigObject'
 *   '__kav' -> 'KnowledgeArticle'
 *   '__c'   if hasCustomSettingsType -> 'CustomSetting'
 *   '__c'   otherwise                -> 'CustomObject'
 *   else                             -> 'StandardObject'
 * ```
 *
 * @example
 *   deriveEntityVariant('Country__mdt', false);          // => 'CustomMetadataType'
 *   deriveEntityVariant('Marketo_Api_Settings__c', true); // => 'CustomSetting'
 *   deriveEntityVariant('CustomerProject__c', false);     // => 'CustomObject'
 *   deriveEntityVariant('Account', false);                // => 'StandardObject'
 */
export const deriveEntityVariant = (
  apiName: string,
  hasCustomSettingsType: boolean,
): EntityVariant => {
  if (apiName.endsWith('__mdt')) return 'CustomMetadataType';
  if (apiName.endsWith('__e')) return 'PlatformEvent';
  if (apiName.endsWith('__b')) return 'BigObject';
  if (apiName.endsWith('__kav')) return 'KnowledgeArticle';
  if (apiName.endsWith('__c')) {
    return hasCustomSettingsType ? 'CustomSetting' : 'CustomObject';
  }
  return 'StandardObject';
};

/**
 * Derive a parent component's API name from a file path by walking up
 * `parentDirLevel` directories from the file's immediate parent.
 *
 * A `parentDirLevel` of 1 returns the immediate parent directory name; 2
 * returns the grandparent; and so on. Returns an empty string when the
 * path does not have enough directory segments to satisfy the request.
 *
 * @example
 *   // For a CustomField under an object:
 *   deriveParentApiName('objects/Account/fields/Industry__c.field-meta.xml', 2);
 *   // => 'Account'
 *
 *   deriveParentApiName('Foo.xml', 1);
 *   // => '' (no parent directory)
 */
export const deriveParentApiName = (filePath: string, parentDirLevel: number): string => {
  if (parentDirLevel < 1) {
    return '';
  }
  // Segment-wise for the same reason as `deriveComponentApiName`: a native
  // Windows path must resolve identically on any host. Walking `parentDirLevel`
  // levels up is an index from the end, with the filename at index 0.
  const segments = splitPathSegments(filePath);
  const name = segments[segments.length - 1 - parentDirLevel];
  if (name === undefined || name.length === 0 || name === '.') {
    return '';
  }
  return name;
};

/**
 * Derive `{ objectApiName, apiName }` from a nested metadata path of the
 * shape `.../objects/{ObjectApiName}/{expectedImmediateParent}/{ApiName}{suffix}`.
 *
 * The component's `apiName` is the basename with `suffix` stripped; the
 * `objectApiName` is the grandparent directory (two levels above the
 * file). The function asserts the immediate parent directory equals
 * `expectedImmediateParent` and that the grandparent directory is non-empty.
 *
 * Returns `null` when either assertion fails — the caller maps the null
 * result to a `malformed-input` `ExtractorError` with the canonical
 * "cannot resolve parent object from path" message.
 *
 * Used by extractors for metadata types nested under their parent object's
 * directory (RecordType, BusinessProcess, etc.).
 *
 * @example
 *   deriveNestedObjectAndApiName(
 *     'objects/Opportunity/businessProcesses/Sales_Process.businessProcess-meta.xml',
 *     '.businessProcess-meta.xml',
 *     'businessProcesses',
 *   );
 *   // => { objectApiName: 'Opportunity', apiName: 'Sales_Process' }
 */
export const deriveNestedObjectAndApiName = (
  filePath: string,
  suffix: string,
  expectedImmediateParent: string,
): NestedPathParts | null => {
  const apiName = deriveComponentApiName(filePath, suffix);
  const immediateParent = basename(dirname(filePath));
  const objectApiName = deriveParentApiName(filePath, 2);
  if (
    immediateParent !== expectedImmediateParent ||
    objectApiName.length === 0
  ) {
    return null;
  }
  return { objectApiName, apiName };
};

/**
 * Derive `{ folderName, templateName }` from an EmailTemplate metadata
 * file path of the shape
 * `.../email/{FolderName}/{TemplateName}{suffix}`.
 *
 * Walks the path's directory segments from right to left until an
 * `email` segment is found, then joins everything between that segment
 * and the file with `/` to form the `folderName`. This preserves the
 * "flattened nested folders" behavior documented in `EmailTemplate.md`:
 * a path `email/A/B/Template.email-meta.xml` yields
 * `folderName = "A/B"`. The common case `email/Folder/Template.email-meta.xml`
 * yields `folderName = "Folder"`.
 *
 * Returns `null` when:
 *   - the path contains no `email/` ancestor, or
 *   - the `email/` ancestor is the file's immediate parent (i.e., no
 *     folder segment between them) — even Salesforce's unfoldered
 *     templates land under a synthetic `unfiled$public` folder.
 *
 * The caller maps a null result to a `malformed-input` ExtractorError.
 *
 * @example
 *   deriveEmailTemplateFolderAndName(
 *     'force-app/main/default/email/Sales/WelcomeEmail.email-meta.xml',
 *     '.email-meta.xml',
 *   );
 *   // => { folderName: 'Sales', templateName: 'WelcomeEmail' }
 *
 *   deriveEmailTemplateFolderAndName(
 *     'email/A/B/Nested.email-meta.xml',
 *     '.email-meta.xml',
 *   );
 *   // => { folderName: 'A/B', templateName: 'Nested' }
 */
export const deriveEmailTemplateFolderAndName = (
  filePath: string,
  suffix: string,
): EmailTemplatePathParts | null => {
  const templateName = deriveComponentApiName(filePath, suffix);
  // Walk up from the file's immediate parent collecting segments until we hit
  // `email`.
  //
  // This used to read `dir.split('/')` on the claim that "Windows paths are
  // normalized at the loader boundary". There is no such boundary: the walk
  // builds `abs` with `join(currentDir, entry.name)` and hands the native path
  // to the extractor unmodified. On Windows every segment therefore collapsed
  // into one, `emailIndex` stayed -1, and EVERY EmailTemplate returned null →
  // `malformed-input` → zero EmailTemplate nodes in the vault, while the
  // refresh still reported `partial` and carried on. Silent data loss.
  //
  // `splitPathSegments` accepts either separator, so the comment is replaced by
  // a shared helper that cannot drift from its claim.
  //
  // Note this no longer routes through `dirname()`. `node:path` is bound to the
  // HOST flavour, so on a POSIX host `dirname` cannot see a backslash and the
  // function would still be untestable off-Windows — the coverage gap that let
  // the original bug ship. Dropping the final segment is the same operation and
  // is separator-agnostic, so the Windows behaviour is now provable everywhere.
  const allSegments = splitPathSegments(filePath);
  if (allSegments.length < 2) {
    return null;
  }
  const segments = allSegments.slice(0, -1);
  // Find the *last* occurrence of the literal `email` segment; this
  // handles paths that may contain `email` higher up in unusual repo
  // layouts (e.g., a workspace dir named `email-templates`).
  let emailIndex = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] === 'email') {
      emailIndex = i;
      break;
    }
  }
  if (emailIndex === -1) {
    return null;
  }
  // Folder segments are everything between `email/` and the file.
  // At least one segment is required — an unfoldered template
  // (immediate child of `email/`) is not a documented happy path.
  const folderSegments = segments.slice(emailIndex + 1);
  if (folderSegments.length === 0) {
    return null;
  }
  return {
    folderName: folderSegments.join('/'),
    templateName,
  };
};

/**
 * Derive `{ objectApiName, apiName }` from a filename of the shape
 * `{ObjectApiName}.{ApiName}{suffix}` — the convention used by
 * PathAssistant files, where the filename encodes both names separated by
 * a single dot. Splits on the **first** dot so record-type names
 * containing dots round-trip correctly.
 *
 * Returns `null` when the basename (after stripping `suffix`) contains no
 * dot — the caller maps null to a `malformed-input` `ExtractorError`.
 *
 * @example
 *   deriveDotSplitObjectAndApiName(
 *     'pathAssistants/Opportunity.Enterprise.pathAssistant-meta.xml',
 *     '.pathAssistant-meta.xml',
 *   );
 *   // => { objectApiName: 'Opportunity', apiName: 'Enterprise' }
 */
export const deriveDotSplitObjectAndApiName = (
  filePath: string,
  suffix: string,
): NestedPathParts | null => {
  const stem = deriveComponentApiName(filePath, suffix);
  const firstDot = stem.indexOf('.');
  if (firstDot <= 0 || firstDot >= stem.length - 1) {
    return null;
  }
  return {
    objectApiName: stem.slice(0, firstDot),
    apiName: stem.slice(firstDot + 1),
  };
};

/**
 * Derive a bundle's API name from a directory path. Unlike file-based
 * components (CustomField, ApexClass, etc.) whose API name lives in
 * the file's basename, bundle-based components (LightningComponentBundle,
 * AuraDefinitionBundle) take their API name from the *directory* name
 * — every file in the bundle stems from that same name.
 *
 * Trailing slashes are tolerated: `lwc/accountCard/` and `lwc/accountCard`
 * yield the same result. Returns an empty string when the path resolves
 * to a root segment with no meaningful basename (e.g., `/`, `.`).
 *
 * @example
 *   deriveBundleApiName('force-app/main/default/lwc/accountQuickPanel');
 *   // => 'accountQuickPanel'
 *
 *   deriveBundleApiName('force-app/main/default/aura/CaseManager/');
 *   // => 'CaseManager'
 */
export const deriveBundleApiName = (dirPath: string): string => {
  // Strip exactly one trailing slash if present so `basename` doesn't
  // collapse to '' on `lwc/foo/`. Multiple trailing slashes are a
  // caller-side mistake; we do not attempt to clean them.
  const trimmed =
    dirPath.length > 1 && dirPath.endsWith('/')
      ? dirPath.slice(0, -1)
      : dirPath;
  const name = basename(trimmed);
  if (name.length === 0 || name === '.') return '';
  return name;
};
