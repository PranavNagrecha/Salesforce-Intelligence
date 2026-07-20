/**
 * Known martech (marketing-technology) integration lookup.
 *
 * Finding #44: martech connections (Marketing Cloud Connect / Pardot /
 * Account Engagement / Marketo / HubSpot) exist in a vault's retrieved
 * metadata TODAY — as an `InstalledPackage` node keyed by namespace
 * (`packages/extractors/src/installed-package.ts`), or as a `NamedCredential`
 * / `ExternalDataSource` endpoint URL — but nothing translates the raw
 * namespace/host into the vendor name an admin actually asks about ("is
 * Pardot connected?"). This module IS that translation: a small, static,
 * additive lookup table. It adds NO new extraction, NO new EdgeType, and NO
 * new ComponentType — every namespace and endpoint pattern here keys off
 * nodes `installed-package.ts` / `named-credential.ts` /
 * `external-data-source.ts` already extract. Consumed by
 * `tools/integration-map.ts`'s `martechConnectors` section.
 *
 * HONESTY BOUNDARY — read before trusting a match:
 *   - Namespace matches are STRUCTURAL: an `InstalledPackage` node whose
 *     `namespace` (fullName) equals a known martech namespace. This rides on
 *     `declared` metadata (the org's own retrieved `installedPackage` sidecar
 *     file) — as reliable as `installed_package_catalog` itself.
 *   - Endpoint matches are a HEURISTIC hostname-regex test against a
 *     `NamedCredential` / `ExternalDataSource` node's declared endpoint URL.
 *     An org that self-hosts a proxy in front of a martech vendor, or names a
 *     credential after a vendor without actually pointing at it, will not
 *     match either way (false negative / false positive both possible) — this
 *     is `heuristic` confidence, never `declared`.
 *   - The namespace table itself is PUBLIC ISV-listing knowledge (each entry
 *     verified against vendor documentation / Salesforce Help error-message
 *     namespacing as of 2026-07 — see each entry's `basis`), NOT re-verified
 *     against a live org retrieve. A vendor can rename or re-namespace a
 *     package across major versions; treat a match as "likely X", not a
 *     certainty — confirm in Setup > Installed Packages for anything
 *     decision-critical.
 *   - This table is MARTECH-scoped only (finding #44's ask) — it is
 *     deliberately not a general ISV namespace registry.
 */

export type MartechCategory =
  | 'Marketing Automation'
  | 'Sales Engagement / Marketing Automation'
  | 'Inbound Marketing / CRM Sync';

export interface KnownMartechConnector {
  readonly productName: string;
  readonly vendor: string;
  readonly category: MartechCategory;
  /** One-line basis for the match, surfaced verbatim so a caller can judge freshness. */
  readonly basis: string;
}

/**
 * Namespace (`InstalledPackage` node's `namespace` property, also its
 * component API-name prefix) -> known martech connector. Keys are lowercase;
 * {@link lookupKnownMartechNamespace} lowercases the candidate before
 * indexing — namespaces are treated case-insensitively, mirroring
 * `package-impact.ts`'s own `namespaceOf` convention.
 */
export const KNOWN_MARTECH_NAMESPACES: Readonly<Record<string, KnownMartechConnector>> = {
  et4ae5: {
    productName: 'Marketing Cloud Connect',
    vendor: 'Salesforce',
    category: 'Marketing Automation',
    basis:
      "et4ae5 is Marketing Cloud Connect's own Apex namespace, visible in its own error identifiers (e.g. `et4ae5.MCBaseException.InvalidParameterException`) — legacy ExactTarget (\"ET\") heritage naming, unchanged since the Salesforce acquisition.",
  },
  pi: {
    productName: 'Pardot / Account Engagement',
    vendor: 'Salesforce',
    category: 'Marketing Automation',
    basis:
      'pi__ is the field prefix the Pardot-Salesforce connector grafts onto Lead/Contact (e.g. pi__score__c, pi__grade__c, pi__utm_source__c). CAVEAT: "pi" is a short, generic-looking namespace token — corroborate with installed_package_catalog\'s versionNumber before treating a match as certain.',
  },
  mkto_si: {
    productName: 'Marketo Sales Insight',
    vendor: 'Adobe (Marketo Engage)',
    category: 'Sales Engagement / Marketing Automation',
    basis:
      'mkto_si is the Marketo Sales Insight (MSI) managed-package namespace, visible in its own Apex trigger names (e.g. mkto_si.RemoveInterestingMomentLinebreaksContact). CAVEAT: Marketo\'s core lead-sync package (Marketo Lead Management) is largely retired and does not reliably carry a distinct managed namespace in retrieved metadata — an MLM-only org is more reliably caught by the endpoint-based Marketo pattern below, not this namespace.',
  },
};

/** One endpoint-hostname heuristic: any NamedCredential/ExternalDataSource endpoint whose host matches `hostPattern` is a likely connection to this vendor. */
export interface MartechEndpointPattern extends KnownMartechConnector {
  readonly hostPattern: RegExp;
}

export const KNOWN_MARTECH_ENDPOINT_PATTERNS: readonly MartechEndpointPattern[] = [
  {
    productName: 'Marketing Cloud Connect',
    vendor: 'Salesforce',
    category: 'Marketing Automation',
    basis: 'Endpoint host matches a Salesforce Marketing Cloud API domain (marketingcloudapis.com / exacttarget.com).',
    hostPattern: /(^|\.)(marketingcloudapis|exacttarget)\.com$/i,
  },
  {
    productName: 'Pardot / Account Engagement',
    vendor: 'Salesforce',
    category: 'Marketing Automation',
    basis: 'Endpoint host matches a Pardot API domain (pardot.com).',
    hostPattern: /(^|\.)pardot\.com$/i,
  },
  {
    productName: 'Marketo',
    vendor: 'Adobe (Marketo Engage)',
    category: 'Sales Engagement / Marketing Automation',
    basis: 'Endpoint host matches a Marketo REST/SOAP API domain (marketo.com / mktorest.com / mktoapi.com).',
    hostPattern: /(^|\.)(marketo|mktorest|mktoapi)\.com$/i,
  },
  {
    productName: 'HubSpot',
    vendor: 'HubSpot',
    category: 'Inbound Marketing / CRM Sync',
    basis:
      "Endpoint host matches a HubSpot API domain (hubapi.com / hubspot.com). No reliable managed-package namespace was found for HubSpot's Salesforce connector — its integration is predominantly Connected-App/OAuth-based rather than namespace-heavy field grafting — so endpoint matching is the only signal for HubSpot in this table.",
    hostPattern: /(^|\.)(hubapi|hubspot)\.com$/i,
  },
];

/** Case-insensitive namespace lookup. Returns `null` when not a known martech namespace. */
export const lookupKnownMartechNamespace = (namespace: string): KnownMartechConnector | null =>
  KNOWN_MARTECH_NAMESPACES[namespace.trim().toLowerCase()] ?? null;

/**
 * Extract a hostname from a raw endpoint/URL string and test it against every
 * known martech endpoint pattern. Returns the first match — the patterns are
 * disjoint enough in practice that ordering rarely matters. Returns `null`
 * when the string is not a parseable absolute URL (e.g. a bare
 * `callout:Alias` credential value) or matches nothing.
 */
export const lookupKnownMartechEndpoint = (
  rawUrl: string,
): MartechEndpointPattern | null => {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return null;
  }
  for (const pattern of KNOWN_MARTECH_ENDPOINT_PATTERNS) {
    if (pattern.hostPattern.test(host)) return pattern;
  }
  return null;
};

/** Verbatim confidence disclosure — surfaced on every `martechConnectors` section (`tools/integration-map.ts`). */
export const MARTECH_CONNECTOR_DISCLOSURE =
  'martechConnectors is a HEURISTIC lookup, not a new extraction: namespace matches key off the InstalledPackage nodes installed-package.ts already extracts (declared confidence — as reliable as installed_package_catalog); endpoint matches are a hostname-regex heuristic against NamedCredential/ExternalDataSource endpoint URLs AND Active RemoteSiteSetting URLs (heuristic confidence — a self-hosted proxy in front of a vendor evades this, and a coincidental domain match is possible though unlikely). The namespace table is public ISV-listing knowledge verified as of 2026-07, not re-verified against a live org retrieve — a vendor can rename or re-namespace a package across major versions. An org with a real martech connection that surfaces NOTHING here either predates the InstalledPackage/NamedCredential/RemoteSiteSetting retrieve, uses a namespace/endpoint this table does not yet know, or connects via a mechanism invisible to static metadata (a callout to an IP address, or a host neither a NamedCredential nor a RemoteSiteSetting declares). A RemoteSiteSetting-sourced match means the org authorizes an outbound callout to the vendor host but no NamedCredential/InstalledPackage corroborates it — likely a pre-NamedCredential Apex callout (confirm the callout class). Absence here is not proof of no connection — see installed_package_catalog and package_impact for the full namespace picture this table only decorates.';
