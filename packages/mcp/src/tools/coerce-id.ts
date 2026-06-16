/**
 * Shared id coercion — smooths an API footgun.
 *
 * Object-shaped tools accept a bare apiName (`objectApiName: 'Account'`) and
 * build the canonical id internally. The single-name component tools, by
 * contrast, historically REJECTED a bare name and demanded the prefixed id
 * (`classApiName: 'ApexClass:Foo'`), even though the param reads like an
 * apiName. In the resolve-first flow that's fine (sfi.resolve returns the
 * prefixed id), but a caller that passes a bare name burns a turn on
 * `invalid-query`.
 *
 * `coercePrefix` removes that asymmetry without changing the happy path or the
 * wrong-type rejection:
 *   - already starts with an accepted prefix → returned unchanged.
 *   - bare apiName (no `:` at all) → `${acceptedPrefixes[0]}${raw}`, i.e. the
 *     PRIMARY accepted type's id. The caller's existing existence check then
 *     surfaces `component-not-found` if that id isn't in the vault.
 *   - carries a DIFFERENT `Type:` prefix (a wrong-type id, e.g. a
 *     `CustomObject:` id handed to a field tool) → returned UNCHANGED so the
 *     caller's existing prefix check still rejects it with its precise
 *     wrong-type message.
 *
 * Pure (no graph access). Salesforce api names never contain `:`, so the
 * "has a colon" test reliably distinguishes a bare apiName from a typed id.
 */
export const coercePrefix = (
  raw: string,
  acceptedPrefixes: readonly string[],
): string => {
  if (acceptedPrefixes.some((p) => raw.startsWith(p))) return raw;
  if (raw.includes(':')) return raw; // a (wrong) Type: prefix — let the caller reject
  const primary = acceptedPrefixes[0] ?? '';
  return `${primary}${raw}`;
};
