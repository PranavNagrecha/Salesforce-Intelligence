/// <reference types="vitest/globals" />

import { V01_TOOLS } from '../../src/tools/index.js';
import { COMPONENT_TYPES } from '../../src/tools/list-components.js';

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
