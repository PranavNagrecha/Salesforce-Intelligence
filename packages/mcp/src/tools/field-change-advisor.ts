/**
 * Handler for the `sfi.field_change_advisor` MCP tool.
 *
 * The decision-support "before I touch this field, what breaks?" tool. A field
 * change comes in three flavours an admin worries about — making it required,
 * changing its type, and deleting it — and the org already has tools for each
 * (`what_if_make_field_required`, `what_if_change_field_type`,
 * `safe_to_delete_field`). This synthesises them into ONE briefing so the admin
 * sees the whole blast radius at a glance, with a combined verdict and the
 * union of impacted components.
 *
 * It does NOT change anything (backend knowledge layer); it arms the decision.
 *
 * **Honesty axis**: inherits the boundaries of the composed tools — dataflow
 * into Apex `insert`/`update` sites and dynamic/reflective field access are
 * invisible, so a "safe"-looking field may still be set by code the scanner
 * can't see. Treat verdicts as "investigate", not guarantees.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import type { Context } from '../server.js';

import { safeToDeleteFieldHandler } from './safe-to-delete-field.js';
import { whatIfChangeFieldTypeHandler } from './what-if-change-field-type.js';
import { whatIfMakeFieldRequiredHandler } from './what-if-make-field-required.js';

type ChangeTypeArgs = Parameters<typeof whatIfChangeFieldTypeHandler>[1];

export const fieldChangeAdvisorInputSchema = z.object({
  fieldId: z.string().min(1),
  /** Optional target type to additionally analyse a type change. */
  newType: z.string().min(1).optional(),
  /** Opt-in live plane: cite the field's production null-rate (P6-live-advisor-wire). */
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type FieldChangeAdvisorInput = z.infer<typeof fieldChangeAdvisorInputSchema>;

export interface FieldChangeAdvisorOutput {
  readonly fieldId: ComponentId;
  readonly makeRequired: {
    readonly alreadyRequired: boolean;
    readonly verdict: string;
    readonly impactCount: number;
    /** Live production null-rate (P6-live-advisor-wire), when the live plane is on. */
    readonly liveNullRate?: {
      readonly totalCount: number;
      readonly nullCount: number;
      readonly nullRate: number;
    };
  } | null;
  readonly deletion: {
    readonly verdict: string;
    readonly blockingCount: number;
    readonly riskyCount: number;
  } | null;
  readonly changeType?: {
    readonly newType: string;
    readonly compatibility: string;
    readonly verdict: string;
    readonly impactCount: number;
  };
  readonly recommendations: readonly string[];
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Composes what_if_make_field_required + safe_to_delete_field (+ what_if_change_field_type when newType given) — see each for its own boundaries.',
  'Dataflow into Apex insert/update sites and dynamic/reflective field access are invisible; a field that looks safe may still be written by code the scanner cannot see. Verdicts mean "investigate", not "guaranteed".',
]);

export const fieldChangeAdvisorHandler = async (
  ctx: Context,
  input: FieldChangeAdvisorInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<FieldChangeAdvisorOutput>, McpError>> => {
  const fieldId = input.fieldId as ComponentId;

  // Validate the field exists once, up front, with a clear error.
  const node = await getNodeById(ctx.graph, fieldId);
  if (!node.ok) return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
  if (node.value === null || node.value.type !== 'CustomField') {
    return err({ kind: 'component-not-found', message: `no CustomField matches \`${fieldId}\` in this vault`, path: fieldId });
  }

  const recommendations: string[] = [];

  // --- make required ---
  let makeRequired: FieldChangeAdvisorOutput['makeRequired'] = null;
  const mr = await whatIfMakeFieldRequiredHandler(
    ctx,
    {
      fieldId,
      ...(input.liveEnabled !== undefined ? { liveEnabled: input.liveEnabled } : {}),
      ...(input.orgAlias !== undefined ? { orgAlias: input.orgAlias } : {}),
    },
    exec,
  );
  if (mr.ok) {
    const nr = mr.value.data.liveNullRate;
    makeRequired = {
      alreadyRequired: mr.value.data.alreadyRequired,
      verdict: mr.value.data.verdict,
      impactCount: mr.value.data.impacts.length,
      ...(nr !== undefined
        ? { liveNullRate: { totalCount: nr.totalCount, nullCount: nr.nullCount, nullRate: nr.nullRate } }
        : {}),
    };
    // Lead with a vault-staleness warning when the live plane reports the org is ahead.
    if (mr.value.data.staleness?.vaultStale === true && mr.value.data.staleness.warning !== null) {
      recommendations.push(mr.value.data.staleness.warning);
    }
    if (mr.value.data.alreadyRequired) {
      recommendations.push('Field is already required — making it required is a no-op.');
    } else if (mr.value.data.impacts.length > 0) {
      recommendations.push(
        `Making it required affects ${mr.value.data.impacts.length} create path(s) (verdict: ${mr.value.data.verdict}). Ensure every Flow/Apex/integration that inserts this object sets the field, or inserts will start failing.`,
      );
    }
    // Cite the LIVE production population alongside the vault impact (hybrid).
    if (nr !== undefined) {
      recommendations.push(
        `Live (read-only): ${nr.nullCount} of ${nr.totalCount} existing record(s) (${Math.round(nr.nullRate * 100)}%) currently have this field null. ${nr.interpretation}`,
      );
    }
  }

  // --- deletion ---
  let deletion: FieldChangeAdvisorOutput['deletion'] = null;
  const del = await safeToDeleteFieldHandler(ctx, { fieldId });
  if (del.ok) {
    const reasoning = del.value.data.reasoning;
    const blockingCount = reasoning.filter((r) => r.verdict === 'blocking').reduce((n, r) => n + r.count, 0);
    const riskyCount = reasoning.filter((r) => r.verdict === 'risky').reduce((n, r) => n + r.count, 0);
    deletion = { verdict: del.value.data.verdict, blockingCount, riskyCount };
    if (del.value.data.verdict === 'blocking') {
      recommendations.push(
        `Deletion is BLOCKED: ${blockingCount} declared dependency(ies) (layouts/flows/validation rules/formulas) must be removed first.`,
      );
    } else if (del.value.data.verdict === 'risky') {
      recommendations.push(
        `Deletion is risky: ${riskyCount} heuristic reference(s) need a spot-check (Apex/LWC) before removing.`,
      );
    } else if (del.value.data.verdict === 'safe') {
      recommendations.push('No incoming dependencies found — deletion looks safe (still confirm dynamic references).');
    }
  }

  // --- change type (only when a target type is supplied) ---
  let changeType: FieldChangeAdvisorOutput['changeType'];
  if (input.newType !== undefined) {
    const ct = await whatIfChangeFieldTypeHandler(
      ctx,
      { fieldId, newType: input.newType } as unknown as ChangeTypeArgs,
    );
    if (ct.ok) {
      changeType = {
        newType: ct.value.data.newType,
        compatibility: ct.value.data.compatibility,
        verdict: ct.value.data.verdict,
        impactCount: ct.value.data.impacts.length,
      };
      recommendations.push(
        `Changing type to ${ct.value.data.newType} is ${ct.value.data.compatibility} (verdict: ${ct.value.data.verdict}); ${ct.value.data.impacts.length} component(s) reference the field.`,
      );
    } else {
      recommendations.push(
        `Could not analyse a type change to "${input.newType}" — it may not be a recognised field type. Skipping the type-change angle.`,
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('No impacts detected on the measured axes; still review references before changing the field.');
  }

  return ok({
    data: {
      fieldId,
      makeRequired,
      deletion,
      ...(changeType !== undefined ? { changeType } : {}),
      recommendations,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
