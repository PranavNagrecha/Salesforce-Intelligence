/// <reference types="vitest/globals" />

import { V01_TOOLS } from '../../src/tools/index.js';
import {
  COMPONENT_TYPES,
  listComponentsInputSchema,
} from '../../src/tools/list-components.js';

/**
 * Guard against advertised-schema drift. `list_components` validates its `type`
 * against the Zod `COMPONENT_TYPES` enum (the source of truth), but the JSON
 * Schema advertised to MCP clients duplicates that list in `index.ts`. When the
 * two diverge, schema-respecting clients silently cannot reach a type the
 * handler actually accepts — exactly how `CustomPermission` shipped retrievable
 * but unlistable before 0.1.19. This test fails the moment they drift again.
 */
describe('list_components advertised inputSchema enum ↔ Zod validator parity', () => {
  it('advertises exactly the COMPONENT_TYPES the handler accepts', () => {
    const roster = new Map(V01_TOOLS.map((t) => [t.name, t]));
    const tool = roster.get('sfi.list_components');
    expect(tool, 'sfi.list_components must be registered').toBeDefined();

    const schema = tool?.inputSchema as
      | { properties?: { type?: { enum?: readonly string[] } } }
      | undefined;
    const advertised = schema?.properties?.type?.enum ?? [];

    // Same set (no missing / extra members) and same length (no duplicates).
    expect(new Set(advertised)).toEqual(new Set(COMPONENT_TYPES));
    expect(advertised.length).toBe(COMPONENT_TYPES.length);

    // Spot-check the 0.1.19 addition explicitly so a regression names it.
    expect(advertised).toContain('CustomPermission');
  });

  it('advertises the missingDescription / hasDescription boolean filters the Zod schema accepts', () => {
    const roster = new Map(V01_TOOLS.map((t) => [t.name, t]));
    const tool = roster.get('sfi.list_components');
    expect(tool, 'sfi.list_components must be registered').toBeDefined();

    const schema = tool?.inputSchema as
      | { properties?: Record<string, { type?: string }> }
      | undefined;
    const props = schema?.properties ?? {};

    // The Zod validator accepts these (coerced-boolean) narrows; the advertised
    // JSON Schema must expose them or a schema-respecting client can never send
    // the description filter — the same silent-unreachability failure mode the
    // CustomPermission enum drift caused. Assert presence AND boolean type.
    expect(props['missingDescription']).toEqual({ type: 'boolean' });
    expect(props['hasDescription']).toEqual({ type: 'boolean' });
  });
});

// LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES: the accepted `type` enum had
// drifted BEHIND the ComponentType union, so metadata families the extractors
// retrieve and model into the graph (SamlSsoConfig, Skill, ServiceChannel,
// Network, CustomSite, the Bot / OmniStudio / CPQ / GenAI / Wave tiers, …) were
// rejected at the Zod boundary with `invalid-query` — retrievable but
// unlistable. The enum is now the FULL union (proven exhaustive by the
// compile-time ComponentTypesComplete guard). These previously-omitted types
// must parse; genuine typos must still be rejected.
describe('listComponentsInputSchema type enum covers retrieved-but-formerly-rejected types (LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES)', () => {
  // A representative sample of the types the stale allowlist omitted — one per
  // affected tier. Each is a real modeled ComponentType whose extractor writes
  // graph nodes, so `list_components { type }` must reach the handler (where the
  // honest empty/coverage handling lives), not fail input validation.
  const FORMERLY_OMITTED: readonly string[] = [
    'SamlSsoConfig',
    'WorkflowAlert',
    'CpqProductRule',
    'OmniScript',
    'PlatformEventChannel',
    'SessionSettings',
    'StandardValueSet',
    'ServiceChannel',
    'Certificate',
    'GenAiFunction',
    'Network',
    'CustomSite',
    'Bot',
    'Skill',
    'WaveDashboard',
  ];

  it.each(FORMERLY_OMITTED)('accepts type=%s at the Zod boundary', (type) => {
    expect(COMPONENT_TYPES).toContain(type);
    const parsed = listComponentsInputSchema.safeParse({ type });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a genuinely unknown type as invalid input', () => {
    expect(listComponentsInputSchema.safeParse({ type: 'NotARealType' }).success).toBe(
      false,
    );
  });
});
