/**
 * Handler for the `sfi.guidance` MCP tool — the `knowledge` plane.
 *
 * Greenfield / best-practice questions ("Flow vs Apex?", "what governor limits
 * should I design around?", "how do I set up SFDX?") have no org-specific
 * answer. This tool returns a curated, honest SUMMARY plus pointers to official
 * Salesforce docs for a topic — explicitly NOT specific to the connected org.
 * It reads only the static `KNOWLEDGE_TOPICS` table; it never touches the vault
 * or fabricates org data (the v0.1 no-speculation contract).
 *
 *   - With `topic`: resolve it (exact key or loose match) and return that
 *     topic's title/summary/docs, plus the full topic list for discovery.
 *   - Without `topic` (or on an unknown topic): return the catalog of available
 *     topics so the caller can pick one. `matched` flags whether a topic
 *     resolved.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import {
  KNOWLEDGE_TOPICS,
  resolveTopicKey,
  type KnowledgeTopic,
} from '../knowledge-topics.js';
import type { Context } from '../server.js';

/**
 * Zod schema for `sfi.guidance`.
 *   - `topic`: optional free-text topic (a known key like `flow-vs-apex`, or a
 *     phrase the resolver loose-matches). Omit to list all available topics.
 */
export const guidanceInputSchema = z.object({
  topic: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `guidanceInputSchema`. */
export type GuidanceInput = z.infer<typeof guidanceInputSchema>;

/** One entry in the discoverable topic catalog. */
export interface GuidanceTopicSummary {
  readonly key: string;
  readonly title: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GuidanceOutput {
  /** The resolved topic key, or `null` when listing / unmatched. */
  readonly topic: string | null;
  /** The curated guidance for the resolved topic, or `null`. */
  readonly guidance: KnowledgeTopic | null;
  /** True when a topic resolved; false when listing or the topic was unknown. */
  readonly matched: boolean;
  /** Every available topic (key + title) for discovery. */
  readonly availableTopics: readonly GuidanceTopicSummary[];
  /** Verbatim honesty axis: this is general guidance, not org-specific. */
  readonly disclosure: string;
}

const DISCLOSURE =
  'General Salesforce best-practice guidance with links to official docs — NOT specific to this org or its metadata. For org-specific answers, use the vault tools (schema, automation, permissions, impact) or the opt-in live plane.';

/**
 * The `sfi.guidance` MCP tool. Returns curated greenfield guidance for a topic,
 * or the topic catalog when none is supplied. Pure over the static topic table.
 *
 * @example
 *   const r = await guidanceHandler(ctx, { topic: 'flow-vs-apex' });
 *   if (r.ok) console.log(r.value.data.guidance?.summary);
 */
export const guidanceHandler = async (
  ctx: Context,
  input: GuidanceInput,
): Promise<Result<McpResponse<GuidanceOutput>, McpError>> => {
  const availableTopics: GuidanceTopicSummary[] = Object.entries(
    KNOWLEDGE_TOPICS,
  ).map(([key, t]) => ({ key, title: t.title }));

  const key = input.topic !== undefined ? resolveTopicKey(input.topic) : null;
  const guidance = key !== null ? (KNOWLEDGE_TOPICS[key] ?? null) : null;

  return ok({
    data: {
      topic: key,
      guidance,
      matched: guidance !== null,
      availableTopics,
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
