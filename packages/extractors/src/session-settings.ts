import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * The REAL root element of the file that carries org session security.
 *
 * Salesforce does not emit a `Session.settings-meta.xml` and there is no
 * `<SessionSettings>` root: the session block is NESTED inside
 * `settings/Security.settings-meta.xml`, whose root is `<SecuritySettings>`.
 * Both halves of that fact were wrong before 0.3.1 (the refresh dispatcher
 * matched the non-existent filename; this extractor demanded the non-existent
 * root), which is why `SessionSettings:default` never populated on any org.
 */
export const SECURITY_SETTINGS_ROOT_ELEMENT = 'SecuritySettings';

/** The nested block inside `<SecuritySettings>` that carries session policy. */
export const SESSION_SETTINGS_BLOCK = 'sessionSettings';

/** Fixed org-level id — a single SessionSettings node per org, no parent scope. */
const NODE_ID = 'SessionSettings:default';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
export const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize fast-xml-parser's "scalar when one, array when many" shape into an
 * array. `undefined` → `[]`, so a caller never distinguishes "absent" from
 * "empty" by accident.
 */
export const toArray = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Read a `<Foo>true</Foo>` boolean element. Returns `true` only when the
 * element is present and its trimmed value is exactly `"true"`; `false` for
 * an explicit `"false"`; and `null` when the element is absent (so callers
 * can distinguish "policy disabled" from "policy not declared in this org").
 */
export const optionalBoolean = (
  rootObj: Record<string, unknown>,
  key: string,
): boolean | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined) return null;
  return String(raw) === 'true';
};

/**
 * Salesforce's `<sessionTimeout>` is a DISCRETE ENUM STRING (`FourHours`,
 * `ThirtyMinutes`, …), NOT an integer — the pre-0.3.1 `parseInt` on it yielded
 * `null` on every real org.
 *
 * This table is OURS: the platform emits the enum, never a minute count, so any
 * minute figure downstream is a DERIVATION by this product and must be labelled
 * as such (`sessionTimeoutMinutesDerivedFrom` records the enum it came from).
 * An enum this table does not know maps to `null` rather than a guess, and the
 * raw enum is always preserved verbatim in `sessionTimeout`.
 */
const SESSION_TIMEOUT_ENUM_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  FifteenMinutes: 15,
  ThirtyMinutes: 30,
  SixtyMinutes: 60,
  TwoHours: 120,
  FourHours: 240,
  EightHours: 480,
  TwelveHours: 720,
  TwentyFourHours: 1440,
});

/**
 * Map a raw `<sessionTimeout>` enum to minutes using {@link SESSION_TIMEOUT_ENUM_MINUTES}.
 * `null` for an absent element AND for an enum value this build does not know —
 * a value never invented, so an unrecognised enum reads as "we cannot convert
 * this", not as a fabricated duration.
 */
export const sessionTimeoutMinutesFor = (rawEnum: string | null): number | null => {
  if (rawEnum === null) return null;
  return SESSION_TIMEOUT_ENUM_MINUTES[rawEnum] ?? null;
};

/**
 * Read a scalar leaf VERBATIM as the string the XML carried. Settings values are
 * discrete enums (`FourHours`, `UpperLowerCaseNumericSpecialCharacters`,
 * `strict-origin-when-cross-origin`) and booleans-as-text; coercing them loses
 * information and, for `sessionTimeout`, produced `null`. `null` when absent or
 * when the child is a nested block rather than a leaf.
 */
export const optionalRawString = (
  rootObj: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return null;
  return String(raw);
};

/**
 * Collect every SCALAR child of a parsed block as `key -> verbatim string`,
 * sorted by key so the property is byte-stable across runs. Nested blocks are
 * skipped (they are modeled explicitly by their own property), and a repeated
 * scalar keeps its FIRST occurrence — settings blocks carry no repeated
 * scalars, so this is a defensive rule, not a lossy one.
 */
export const collectScalarLeaves = (
  block: Record<string, unknown>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(block).sort()) {
    const raw = unwrapSingle(block[key]);
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'object') continue;
    out[key] = String(raw);
  }
  return out;
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

/**
 * Read + validate + parse `settings/Security.settings-meta.xml` and return its
 * `<SecuritySettings>` root object. Shared by BOTH singletons this one file
 * produces (`SessionSettings:default` and `SecuritySettings:default`) so the
 * root-element contract lives in exactly one place.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<SecuritySettings>`
 */
export const parseSecuritySettingsFile = async (
  path: string,
): Promise<Result<Record<string, unknown>, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. The default entity-
  // expansion cap is raised to mirror the other settings-tier extractors.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion cap).
  // Catch it so a single pathological file becomes a per-file `parse-error`
  // rather than aborting the refresh pipeline.
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

  const root = unwrapSingle(parsed[SECURITY_SETTINGS_ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${SECURITY_SETTINGS_ROOT_ELEMENT}> root`,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * Build the single `SessionSettings:default` node from an already-parsed
 * `<SecuritySettings>` root. Exported so the `SecuritySettings` extractor —
 * which owns the same file — can co-emit this node without a second read.
 *
 * Everything in the nested `<sessionSettings>` block is captured VERBATIM in
 * `properties.sessionSettings` (a `key -> string` map, values never coerced),
 * with `declaredKeys` / `declaredKeyCount` naming exactly what the org
 * declared. A missing block yields an empty map — distinguishable from a
 * declared-but-false switch, which is the whole point.
 *
 * `mfaRequired` and `requiresStrongAuth` are kept as first-class properties
 * because two concept rules bind them. On a real org they are `null`: neither
 * `MFARequired` nor `enableRequiredStrongAuthForUILogins` is among the keys
 * `SecuritySettings` carries. That `null` is the honest "not declared here" —
 * it is deliberately NOT defaulted to `false`.
 */
export const buildSessionSettingsNode = (
  rootObj: Record<string, unknown>,
  path: string,
): Node => {
  const rawBlock = unwrapSingle(rootObj[SESSION_SETTINGS_BLOCK]);
  const block =
    typeof rawBlock === 'object' && rawBlock !== null
      ? (rawBlock as Record<string, unknown>)
      : {};
  const sessionSettings = collectScalarLeaves(block);
  const declaredKeys = Object.keys(sessionSettings);
  const sessionTimeout = optionalRawString(block, 'sessionTimeout');
  const sessionTimeoutMinutes = sessionTimeoutMinutesFor(sessionTimeout);

  return {
    id: NODE_ID,
    type: 'SessionSettings',
    // The org-level singleton has no meaningful API name of its own; both
    // `apiName` and `label` use the stable `SessionSettings` moniker so the
    // node renders and resolves consistently.
    apiName: 'SessionSettings',
    label: 'Session Settings',
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      // Bound by the two MFA concept rules. `null` = not declared in this org's
      // retrieved metadata (NOT "disabled") — see the doc comment above.
      mfaRequired: optionalBoolean(block, 'MFARequired'),
      requiresStrongAuth: optionalBoolean(block, 'enableRequiredStrongAuthForUILogins'),
      // RAW enum verbatim, e.g. 'FourHours'.
      sessionTimeout,
      // OUR derivation from the enum — Salesforce emits no minute count.
      sessionTimeoutMinutes,
      sessionTimeoutMinutesDerivedFrom: sessionTimeoutMinutes === null ? null : sessionTimeout,
      // Every leaf the org declared in the block, verbatim.
      sessionSettings,
      declaredKeys,
      declaredKeyCount: declaredKeys.length,
      sourceRootElement: SECURITY_SETTINGS_ROOT_ELEMENT,
      sourceBlock: SESSION_SETTINGS_BLOCK,
    },
  };
};

/**
 * Extract the org-wide session-security policy from the nested
 * `<sessionSettings>` block of `settings/Security.settings-meta.xml`.
 *
 * SessionSettings is an ORG-LEVEL metadata singleton — there is exactly one
 * per org — so this extractor emits one `Node` with the fixed id
 * `SessionSettings:default` and zero edges (the policy is org-wide; it has no
 * inter-component references).
 *
 * In the refresh pipeline the file is dispatched to the `SecuritySettings`
 * extractor, which co-emits this node from the SAME parse. This entry point is
 * the session-only view of that file, kept as the registered `SessionSettings`
 * extractor and used directly by tests.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<SecuritySettings>`
 *
 * @example
 *   const result = await extractSessionSettings(
 *     'force-app/main/default/settings/Security.settings-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'SessionSettings:default'
 */
export const extractSessionSettings = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const rootResult = await parseSecuritySettingsFile(path);
  if (!rootResult.ok) return rootResult;
  return ok({ nodes: [buildSessionSettingsNode(rootResult.value, path)], edges: [] });
};
