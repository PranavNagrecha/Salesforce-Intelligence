/// <reference types="vitest/globals" />

import { V01_TOOLS } from '../../src/tools/index.js';
import { routeQuestionInputSchema } from '../../src/tools/route-question.js';

/**
 * Guard against advertised-schema drift for `sfi.route_question` (the
 * CustomPermission enum-drift lesson, router-v2 P5). The Zod validator in
 * route-question.ts is the source of truth; the JSON Schema advertised to MCP
 * clients duplicates it in index.ts. When the two diverge, schema-respecting
 * clients silently cannot reach a param the handler actually accepts — which
 * is exactly how `mode` shipped accepted-but-unadvertised before this test.
 */
describe('route_question advertised inputSchema ↔ Zod validator parity', () => {
  const roster = new Map(V01_TOOLS.map((tool) => [tool.name, tool]));
  const advertised = roster.get('sfi.route_question')?.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  it('sfi.route_question is registered with an object schema', () => {
    expect(advertised).toBeDefined();
    expect(advertised.properties).toBeDefined();
    expect(advertised.required).toEqual(['question']);
  });

  it('advertises exactly the top-level keys the Zod validator accepts', () => {
    const zodKeys = Object.keys(routeQuestionInputSchema.shape).sort();
    const advertisedKeys = Object.keys(advertised.properties ?? {}).sort();
    expect(advertisedKeys).toEqual(zodKeys);
    // Spot-check the P5 addition explicitly so a regression names it.
    expect(advertisedKeys).toContain('context');
    expect(advertisedKeys).toContain('mode');
  });

  it('advertises exactly the context.previous keys the Zod validator accepts', () => {
    const previousZod = routeQuestionInputSchema.shape.context.unwrap().shape.previous;
    const zodKeys = Object.keys(previousZod.shape).sort();
    const contextAdvertised = advertised.properties?.['context'] as {
      readonly properties?: {
        readonly previous?: { readonly properties?: Readonly<Record<string, unknown>> };
      };
    };
    const advertisedKeys = Object.keys(
      contextAdvertised.properties?.previous?.properties ?? {},
    ).sort();
    expect(advertisedKeys).toEqual(zodKeys);
  });

  it('mode enum matches the Zod enum (order included)', () => {
    const zodOptions = routeQuestionInputSchema.shape.mode.unwrap().options;
    const modeAdvertised = advertised.properties?.['mode'] as {
      readonly enum?: readonly string[];
    };
    expect(modeAdvertised.enum).toEqual(zodOptions);
  });

  it('context.previous.plane enum matches the Zod enum (order included)', () => {
    const previousZod = routeQuestionInputSchema.shape.context.unwrap().shape.previous;
    const zodOptions = previousZod.shape.plane.unwrap().options;
    const contextAdvertised = advertised.properties?.['context'] as {
      readonly properties?: {
        readonly previous?: {
          readonly properties?: {
            readonly plane?: { readonly enum?: readonly string[] };
          };
        };
      };
    };
    expect(contextAdvertised.properties?.previous?.properties?.plane?.enum).toEqual(
      zodOptions,
    );
  });
});
