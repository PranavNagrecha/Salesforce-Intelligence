/**
 * Handlers for the annotations overlay tools (P13-ANNOT-tools + R8-ANNOTATION-REVIEW):
 *
 *   - `sfi.annotations` — read the materialized overlay (whole vault or one
 *     component): the curated meaning (owner / status / glossary / domain /
 *     note) humans stated or confirmed about org components.
 *   - `sfi.propose_annotation` — record an AI PROPOSAL: written with
 *     `source: 'ai', confirmed: false` ALWAYS (the server cannot confirm —
 *     confirmation is a human act), and rate-capped per server session so a
 *     chatty model cannot flood the overlay.
 *   - `sfi.review_annotations` — list unconfirmed proposals (filterable).
 *   - `sfi.confirm_annotation` — promote an AI proposal to human-confirmed
 *     (wraps `sfi annotate confirm` logic).
 *   - `sfi.reject_annotation` — discard an unconfirmed proposal (dedicated
 *     reject verb wrapping the CLI `--unset` write).
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

/**
 * Prefer the HTTP caller identity when known (R8-PERCALLER-TOKENS);
 * otherwise the historical solo/stdio fallback (`ai` / `human`).
 */
const attributedAuthor = (ctx: Context, fallback: string): string => {
  const identity = ctx.callerIdentity;
  if (identity === undefined) return fallback;
  return identity.label ?? identity.id;
};

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
      message: `proposal session cap reached (${PROPOSE_SESSION_CAP}) — confirm or discard existing proposals first (\`sfi.confirm_annotation\` / \`sfi.reject_annotation\`, or CLI \`sfi annotate confirm <id> <key>\` / \`sfi annotate <id> --key <k> --unset\`).`,
    });
  }
  const node = await getNodeById(ctx.graph, input.componentId);
  const componentExists = node.ok && node.value !== null;
  const baseAuthor = attributedAuthor(ctx, 'ai');
  const recorded = await appendAnnotationEvent(ctx.vaultRoot, {
    componentId: input.componentId,
    key: input.key,
    value: input.value,
    author: input.rationale !== undefined ? `${baseAuthor} (${input.rationale})` : baseAuthor,
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
        'Review with sfi.review_annotations; confirm with sfi.confirm_annotation (or CLI: sfi annotate confirm <componentId> <key>); reject with sfi.reject_annotation.',
      disclosure: ANNOTATION_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const reviewAnnotationsInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  key: z.enum(ANNOTATION_KEYS).optional(),
  /** Substring match against the stored author (e.g. `ai`). */
  author: z.string().min(1).optional(),
});

export type ReviewAnnotationsInput = z.infer<typeof reviewAnnotationsInputSchema>;

export interface ReviewAnnotationsOutput {
  readonly proposals: readonly Annotation[];
  readonly totalCount: number;
  readonly disclosure: string;
}

/**
 * The `sfi.review_annotations` MCP tool — list unconfirmed proposals only.
 *
 * @example
 *   const r = await reviewAnnotationsHandler(ctx, { key: 'status' });
 */
export const reviewAnnotationsHandler = async (
  ctx: Context,
  input: ReviewAnnotationsInput,
): Promise<Result<McpResponse<ReviewAnnotationsOutput>, McpError>> => {
  const all = await readAnnotations(ctx.vaultRoot);
  let proposals = all.filter((a) => !a.confirmed);
  if (input.componentId !== undefined) {
    proposals = proposals.filter((a) => a.componentId === input.componentId);
  }
  if (input.key !== undefined) {
    proposals = proposals.filter((a) => a.key === input.key);
  }
  if (input.author !== undefined) {
    const needle = input.author;
    proposals = proposals.filter((a) => a.author.includes(needle));
  }
  return ok({
    data: {
      proposals,
      totalCount: proposals.length,
      disclosure: ANNOTATION_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const confirmAnnotationInputSchema = z.object({
  componentId: z.string().min(1),
  key: z.enum(ANNOTATION_KEYS),
  /** Confirming human recorded on the event (defaults to `human`). */
  author: z.string().min(1).max(200).optional(),
});

export type ConfirmAnnotationInput = z.infer<typeof confirmAnnotationInputSchema>;

export interface ConfirmAnnotationOutput {
  readonly confirmed: boolean;
  readonly alreadyConfirmed: boolean;
  readonly annotation: {
    readonly componentId: string;
    readonly key: string;
    readonly value: string;
    readonly source: 'human';
    readonly confirmed: true;
  };
  readonly disclosure: string;
}

/**
 * The `sfi.confirm_annotation` MCP tool — re-write an AI proposal as
 * human-confirmed (same write as `sfi annotate confirm`).
 */
export const confirmAnnotationHandler = async (
  ctx: Context,
  input: ConfirmAnnotationInput,
): Promise<Result<McpResponse<ConfirmAnnotationOutput>, McpError>> => {
  const existing = annotationsFor(await readAnnotations(ctx.vaultRoot), input.componentId).find(
    (a) => a.key === input.key,
  );
  if (existing === undefined) {
    return err({
      kind: 'invalid-query',
      message: `no annotation found for ${input.componentId} ${input.key}`,
    });
  }
  if (existing.confirmed) {
    return ok({
      data: {
        confirmed: true,
        alreadyConfirmed: true,
        annotation: {
          componentId: existing.componentId,
          key: existing.key,
          value: existing.value,
          source: 'human',
          confirmed: true,
        },
        disclosure: ANNOTATION_DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }
  const recorded = await appendAnnotationEvent(ctx.vaultRoot, {
    componentId: input.componentId,
    key: input.key,
    value: existing.value,
    author: input.author ?? attributedAuthor(ctx, 'human'),
    source: 'human',
    confirmed: true,
    at: new Date().toISOString(),
    op: 'set',
  });
  if (!recorded) {
    return err({
      kind: 'internal',
      message: 'annotation write failed (meta/annotations.jsonl not writable)',
    });
  }
  return ok({
    data: {
      confirmed: true,
      alreadyConfirmed: false,
      annotation: {
        componentId: input.componentId,
        key: input.key,
        value: existing.value,
        source: 'human',
        confirmed: true,
      },
      disclosure: ANNOTATION_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const rejectAnnotationInputSchema = z.object({
  componentId: z.string().min(1),
  key: z.enum(ANNOTATION_KEYS),
  /** Author recorded on the unset event (defaults to `human`). */
  author: z.string().min(1).max(200).optional(),
});

export type RejectAnnotationInput = z.infer<typeof rejectAnnotationInputSchema>;

export interface RejectAnnotationOutput {
  readonly rejected: boolean;
  readonly componentId: string;
  readonly key: string;
  readonly previousValue: string;
  readonly disclosure: string;
}

/**
 * The `sfi.reject_annotation` MCP tool — discard an unconfirmed proposal
 * (dedicated reject verb; writes the same `op: 'unset'` event as CLI `--unset`).
 */
export const rejectAnnotationHandler = async (
  ctx: Context,
  input: RejectAnnotationInput,
): Promise<Result<McpResponse<RejectAnnotationOutput>, McpError>> => {
  const existing = annotationsFor(await readAnnotations(ctx.vaultRoot), input.componentId).find(
    (a) => a.key === input.key,
  );
  if (existing === undefined) {
    return err({
      kind: 'invalid-query',
      message: `no annotation found for ${input.componentId} ${input.key}`,
    });
  }
  if (existing.confirmed) {
    return err({
      kind: 'invalid-query',
      message: `${input.componentId} ${input.key} is already confirmed — sfi.reject_annotation only discards unconfirmed proposals (use \`sfi annotate <id> --key <k> --unset\` to remove a confirmed entry).`,
    });
  }
  const recorded = await appendAnnotationEvent(ctx.vaultRoot, {
    componentId: input.componentId,
    key: input.key,
    author: input.author ?? attributedAuthor(ctx, 'human'),
    source: 'human',
    confirmed: true,
    at: new Date().toISOString(),
    op: 'unset',
  });
  if (!recorded) {
    return err({
      kind: 'internal',
      message: 'annotation write failed (meta/annotations.jsonl not writable)',
    });
  }
  return ok({
    data: {
      rejected: true,
      componentId: input.componentId,
      key: input.key,
      previousValue: existing.value,
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
