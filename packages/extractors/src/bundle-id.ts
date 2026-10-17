/** The namespace Salesforce markup uses for the org's own components. */
const LOCAL_NAMESPACE_PREFIX = 'c:';

/**
 * Canonical id of a Lightning bundle (LWC or Aura) from either spelling of its
 * name. The bundle extractors derive the name from the bundle directory, which
 * never carries a namespace; markup that references a component writes
 * `c:name` for the org's own components. Both resolve to the same id here, so
 * a reference edge lands on the node the bundle extractor minted. Any other
 * namespace (`flowruntime:`, a managed package) names a component outside this
 * source tree: its id keeps the namespace so it never claims a local bundle of
 * the same name.
 */
export const bundleId = (
  type: 'LightningComponentBundle' | 'AuraDefinitionBundle',
  name: string,
): string =>
  `${type}:${name.startsWith(LOCAL_NAMESPACE_PREFIX) ? name.slice(LOCAL_NAMESPACE_PREFIX.length) : name}`;

/** True when a markup component reference names one of the org's own components. */
export const isLocalComponentRef = (name: string): boolean =>
  name.startsWith(LOCAL_NAMESPACE_PREFIX);
