/**
 * MCP resource bindings for the v0.1 server.
 *
 * v0.1 advertises a single resource — `sfi://vault/manifest` — that
 * returns the loaded `VaultManifest` as canonical JSON. Component bodies
 * (`sfi://component/{type}/{id}`) and raw source files
 * (`sfi://source/{path}`) are intentionally NOT exposed as resources at
 * v0.1; the equivalent reads happen through the
 * `sfi.get_component` and `sfi.search_apex_source` tools, which carry
 * the `vaultState` envelope. Phase G may revisit if clients ask for
 * URI-based access.
 *
 * Registering the manifest resource lets MCP clients that prefer
 * resource URIs over tool calls see the freshness signal without going
 * through a tool.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { Context } from './server.js';

/** Canonical URI for the manifest resource. */
const MANIFEST_URI = 'sfi://vault/manifest';
/** MIME advertised for the manifest resource body. */
const JSON_MIME = 'application/json';
/** Indentation used when serializing the manifest to keep it human-readable. */
const JSON_INDENT = 2;

/**
 * Register `resources/list` and `resources/read` handlers on `server`.
 *
 * v0.1 lists exactly one resource and only honors reads for that
 * specific URI; any other URI receives a structured error block.
 *
 * @example
 *   const server = new Server({ name: 'sf-intelligence', version: '0.1.0' });
 *   registerResources(server, ctx);
 */
export const registerResources = (server: Server, ctx: Context): void => {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: MANIFEST_URI,
        name: 'vault-manifest',
        description:
          'The current vault manifest (org-kb/meta/manifest.json) as JSON.',
        mimeType: JSON_MIME,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== MANIFEST_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: JSON_MIME,
            text: JSON.stringify(
              { error: 'unknown-resource', uri },
              null,
              JSON_INDENT,
            ),
          },
        ],
      };
    }
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: JSON.stringify(ctx.manifest, null, JSON_INDENT),
        },
      ],
    };
  });
};
