/**
 * Handlers for the annotations overlay tools (P13-ANNOT-tools):
 *
 *   - `sfi.annotations` — read the materialized overlay (whole vault or one
 *     component): the curated meaning (owner / status / glossary / domain /
 *     note) humans stated or confirmed about org components.
 *   - `sfi.propose_annotation` — record an AI PROPOSAL: written with
 *     `source: 'ai', confirmed: false` ALWAYS (the server cannot confirm —
 *     confirmation is a human act via `sfi annotate confirm`), and
 *     rate-capped per server session so a chatty model cannot flood the
 *     overlay.
 *
 * Local vault-file writes from the server have precedent (the question-gap
 * log, the demand queue) and do not touch Salesforce. Provenance for
 * annotation-derived claims is `annotation` — curated, NOT derived from the
 * vault snapshot — and must never bleed into `offline_snapshot`.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import {
  ANNOTATION_KEYS,
  annotationsFor,
  appendAnnotationEvent,
  readAnnotations,
  type Annotation,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Disclosure shipped with every annotations payload. */
export const ANNOTATION_DISCLOSURE =
  'Annotations are CURATED knowledge (humans stated or confirmed them; AI proposals are unconfirmed until a human confirms) — provenance `annotation`, never derived from the org snapshot. An unconfirmed `source: ai` entry is a proposal, not a fact.';

/** Max AI proposals per server session (a chatty model must not flood the overlay). */
export const PROPOSE_SESSION_CAP = 20;

let proposalsThisSession = 0;

/** Test seam: reset the per-session proposal counter. */
export const resetProposalSessionCap = (): void => {
  proposalsThisSession = 0;
};

export const annotationsInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  /** Filter to one key (owner | status | glossary | domain | note). */
  key: z.enum(ANNOTATION_KEYS).optional(),
});

export type AnnotationsInput = z.infer<typeof annotationsInputSchema>;

export interface AnnotationsOutput {
  readonly annotations: readonly Annotation[];
  readonly totalCount: number;
  /** Count of unconfirmed AI proposals in the returned slice. */
  readonly unconfirmedProposals: number;
  readonly disclosure: string;
}

/**
 * The `sfi.annotations` MCP tool — read the materialized overlay.
 *
 * @example
 *   const r = await annotationsHandler(ctx, { componentId: 'CustomField:Contact.SSN__c' });
 *   if (r.ok) console.log(r.value.data.annotations);
 */
export const annotationsHandler = async (
  ctx: Context,
  input: AnnotationsInput,
): Promise<Result<McpResponse<AnnotationsOutput>, McpError>> => {
  const all = await readAnnotations(ctx.vaultRoot);
  const scoped =
    input.componentId === undefined ? all : annotationsFor(all, input.componentId);
  const filtered = input.key === undefined ? scoped : scoped.filter((a) => a.key === input.key);
  return ok({
    data: {
      annotations: filtered,
      totalCount: filtered.length,
      unconfirmedProposals: filtered.filter((a) => a.source === 'ai' && !a.confirmed).length,
      disclosure: ANNOTATION_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const proposeAnnotationInputSchema = z.object({
  componentId: z.string().min(1),
  key: z.enum(ANNOTATION_KEYS),
  value: z.string().min(1).max(500),
  /** Short reason shown to the confirming human. */
  rationale: z.string().min(1).max(500).optional(),
});

export type ProposeAnnotationInput = z.infer<typeof proposeAnnotationInputSchema>;

export interface ProposeAnnotationOutput {
  readonly recorded: boolean;
  readonly proposal: {
    readonly componentId: string;
    readonly key: string;
    readonly value: string;
    readonly source: 'ai';
    readonly confirmed: false;
  };
  /** True when the subject id resolves to a real node (a proposal on a phantom is allowed but flagged). */
  readonly componentExists: boolean;
  readonly remainingSessionProposals: number;
  readonly confirmHint: string;
  readonly disclosure: string;
}

/**
 * The `sfi.propose_annotation` MCP tool — record an AI proposal.
 * ALWAYS `source: 'ai', confirmed: false`; rate-capped per session.
 *
 * @example
 *   const r = await proposeAnnotationHandler(ctx, {
 *     componentId: 'CustomField:Contact.Fax__c', key: 'status', value: 'deprecated',
 *   });
 */
export const proposeAnnotationHandler = async (
  ctx: Context,
  input: ProposeAnnotationInput,
): Promise<Result<McpResponse<ProposeAnnotationOutput>, McpError>> => {
  if (proposalsThisSession >= PROPOSE_SESSION_CAP) {
    return err({
      kind: 'invalid-query',
      message: `proposal session cap reached (${PROPOSE_SESSION_CAP}) — confirm or discard existing proposals first (\`sfi annotate confirm <id> <key>\` / \`sfi annotate <id> --key <k> --unset\`).`,
    });
  }
  const node = await getNodeById(ctx.graph, input.componentId);
  const componentExists = node.ok && node.value !== null;
  const recorded = await appendAnnotationEvent(ctx.vaultRoot, {
    componentId: input.componentId,
    key: input.key,
    value: input.value,
    author: input.rationale !== undefined ? `ai (${input.rationale})` : 'ai',
    source: 'ai',
    confirmed: false,
    at: new Date().toISOString(),
    op: 'set',
  });
  if (!recorded) {
    return err({
      kind: 'internal',
      message: 'annotation write failed (meta/annotations.jsonl not writable)',
    });
  }
  proposalsThisSession += 1;
  return ok({
    data: {
      recorded: true,
      proposal: {
        componentId: input.componentId,
        key: input.key,
        value: input.value,
        source: 'ai',
        confirmed: false,
      },
      componentExists,
      remainingSessionProposals: PROPOSE_SESSION_CAP - proposalsThisSession,
      confirmHint:
        'A human confirms with: sfi annotate confirm <componentId> <key>',
      disclosure: ANNOTATION_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Consumer embedding (P13-ANNOT-tools): the annotations block a component
 * tool attaches when the subject has annotations. Returns undefined when
 * none exist, so annotation-free vaults stay byte-identical.
 */
export interface AnnotationsBlock {
  readonly provenance: 'annotation';
  readonly entries: readonly Annotation[];
  readonly disclosure: string;
}

export const annotationsBlockFor = async (
  ctx: Context,
  componentId: string,
): Promise<AnnotationsBlock | undefined> => {
  const entries = annotationsFor(await readAnnotations(ctx.vaultRoot), componentId);
  if (entries.length === 0) return undefined;
  return { provenance: 'annotation', entries, disclosure: ANNOTATION_DISCLOSURE };
};
