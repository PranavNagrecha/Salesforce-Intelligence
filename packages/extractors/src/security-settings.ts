import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';

import {
  buildSessionSettingsNode,
  collectScalarLeaves,
  parseSecuritySettingsFile,
  SECURITY_SETTINGS_ROOT_ELEMENT,
  SESSION_SETTINGS_BLOCK,
  toArray,
  unwrapSingle,
} from './session-settings.js';

/** Fixed org-level id — a single SecuritySettings node per org, no parent scope. */
const NODE_ID = 'SecuritySettings:default';

/** Top-level `<SecuritySettings>` children that are NESTED blocks, not scalars. */
const PASSWORD_POLICIES_BLOCK = 'passwordPolicies';
const NETWORK_ACCESS_BLOCK = 'networkAccess';
const SINGLE_SIGN_ON_BLOCK = 'singleSignOnSettings';

/**
 * Nested blocks this extractor models explicitly. Any OTHER nested top-level
 * child is reported by name in `unmodeledBlocks` rather than silently dropped
 * — "we saw a block and did not model it" is a different claim from "the org
 * does not have one", and only the first is true here.
 */
const MODELED_BLOCKS: ReadonlySet<string> = new Set([
  SESSION_SETTINGS_BLOCK,
  PASSWORD_POLICIES_BLOCK,
  NETWORK_ACCESS_BLOCK,
  SINGLE_SIGN_ON_BLOCK,
]);

/** One trusted-IP window from `<networkAccess><ipRanges>`. */
export interface TrustedIpRange {
  readonly start: string | null;
  readonly end: string | null;
  readonly description: string | null;
}

/** Read one scalar child of a parsed block as a verbatim string, or `null`. */
const scalar = (block: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(block[key]);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return null;
  return String(raw);
};

/**
 * Read a nested block as a `key -> verbatim string` map, or `null` when the
 * block is absent. `null` (block NOT declared) and `{}` (block declared with no
 * leaves) are deliberately different values — presence is decided by the KEY,
 * not by the parsed value, because fast-xml-parser renders `<foo></foo>` as the
 * empty STRING rather than an empty object.
 */
const blockAsStringMap = (
  rootObj: Record<string, unknown>,
  key: string,
): Readonly<Record<string, string>> | null => {
  if (!(key in rootObj)) return null;
  const raw = unwrapSingle(rootObj[key]);
  if (typeof raw !== 'object' || raw === null) return {};
  return collectScalarLeaves(raw as Record<string, unknown>);
};

/**
 * Read `<networkAccess><ipRanges>` windows. fast-xml-parser gives a single
 * occurrence as an object and repeats as an array, so both shapes normalize
 * through `toArray`. Each window keeps `start` / `end` / `description`
 * verbatim; an absent child is `null`, never an empty string.
 */
const readTrustedIpRanges = (rootObj: Record<string, unknown>): readonly TrustedIpRange[] => {
  const raw = unwrapSingle(rootObj[NETWORK_ACCESS_BLOCK]);
  if (typeof raw !== 'object' || raw === null) return [];
  const networkAccess = raw as Record<string, unknown>;
  const ranges: TrustedIpRange[] = [];
  for (const entry of toArray(networkAccess['ipRanges'])) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    ranges.push({
      start: scalar(row, 'start'),
      end: scalar(row, 'end'),
      description: scalar(row, 'description'),
    });
  }
  return ranges;
};

/**
 * Build the single `SecuritySettings:default` node from an already-parsed
 * `<SecuritySettings>` root — everything in the file EXCEPT the nested
 * `<sessionSettings>` block, which is the separate `SessionSettings:default`
 * singleton (a password policy is not a session policy, and the two are
 * separate Setup surfaces with separate audit questions).
 *
 * Values are captured VERBATIM as strings. Salesforce settings values are
 * discrete enums (`NinetyDays`, `ThreeAttempts`,
 * `UpperLowerCaseNumericSpecialCharacters`) and booleans-as-text; coercing them
 * would lose the enum and, historically, silently produced `null`.
 */
export const buildSecuritySettingsNode = (
  rootObj: Record<string, unknown>,
  path: string,
): Node => {
  const topLevelBlocks = Object.keys(rootObj).sort();
  const unmodeledBlocks = topLevelBlocks.filter((key) => {
    if (MODELED_BLOCKS.has(key)) return false;
    const raw = unwrapSingle(rootObj[key]);
    return typeof raw === 'object' && raw !== null;
  });
  const trustedIpRanges = readTrustedIpRanges(rootObj);
  // Every top-level SCALAR leaf: enableRequireHttpsConnection,
  // enableAdminLoginAsAnyUser, canUsersGrantLoginAccess,
  // redirectBlockModeEnabled, the COEP/COOP header switches, and whatever else
  // this org's API version emits. Collected generically so a new platform
  // toggle lands without a code change instead of being dropped.
  // A declared-but-empty nested block (`<passwordPolicies></passwordPolicies>`)
  // parses as the empty STRING, so it would otherwise land here as a bogus
  // scalar toggle. Modeled block names are removed by name.
  const orgToggles = Object.fromEntries(
    Object.entries(collectScalarLeaves(rootObj)).filter(([key]) => !MODELED_BLOCKS.has(key)),
  );

  return {
    id: NODE_ID,
    type: 'SecuritySettings',
    // The org-level singleton has no meaningful API name of its own; both
    // `apiName` and `label` use the stable `SecuritySettings` moniker so the
    // node renders and resolves consistently (mirrors SessionSettings).
    apiName: 'SecuritySettings',
    label: 'Security Settings',
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      passwordPolicies: blockAsStringMap(rootObj, PASSWORD_POLICIES_BLOCK),
      networkAccessIpRanges: trustedIpRanges,
      networkAccessIpRangeCount: trustedIpRanges.length,
      singleSignOnSettings: blockAsStringMap(rootObj, SINGLE_SIGN_ON_BLOCK),
      orgToggles,
      topLevelBlocks,
      unmodeledBlocks,
      // The four `enableClickjack*` switches live INSIDE `<sessionSettings>` in
      // the real payload, so they are on the SessionSettings node, not here.
      sessionSettingsPresent: SESSION_SETTINGS_BLOCK in rootObj,
      sourceRootElement: SECURITY_SETTINGS_ROOT_ELEMENT,
    },
  };
};

/**
 * Extract the org-wide security settings from `settings/Security.settings-meta.xml`
 * (root `<SecuritySettings>`).
 *
 * ONE file, TWO org-level singleton nodes — this is the file's registered
 * extractor and it co-emits both from a single parse:
 *   - `SecuritySettings:default` — password policy, trusted-IP network access,
 *     SSO settings, and the top-level org security toggles.
 *   - `SessionSettings:default` — the nested `<sessionSettings>` block
 *     (built by `buildSessionSettingsNode`; two concept rules bind that node's
 *     `mfaRequired` / `requiresStrongAuth`, which is why it keeps its own id).
 *
 * Zero edges: org-wide policy has no inter-component references.
 *
 * Error cases (all from {@link parseSecuritySettingsFile}):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<SecuritySettings>`
 *
 * @example
 *   const result = await extractSecuritySettings(
 *     'force-app/main/default/settings/Security.settings-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes.map((n) => n.id));
 *   // => ['SecuritySettings:default', 'SessionSettings:default']
 */
export const extractSecuritySettings = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const rootResult = await parseSecuritySettingsFile(path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;
  return ok({
    nodes: [buildSecuritySettingsNode(rootObj, path), buildSessionSettingsNode(rootObj, path)],
    edges: [],
  });
};
