/**
 * AUDIT-F8 helpers — brand org free text for the structured JSON surface.
 */

import {
  asUntrustedOrgText,
  type UntrustedOrgText,
} from '@sf-intelligence/contracts';

/** Brand a non-empty string; return undefined when absent/empty. */
export const brandOrgText = (
  value: string | null | undefined,
): UntrustedOrgText | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return asUntrustedOrgText(value);
};

/** Pull a string description from a node properties bag when present. */
export const descriptionFromProperties = (
  properties: Readonly<Record<string, unknown>>,
): string | undefined => {
  const raw = properties['description'] ?? properties['inlineHelpText'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
};
