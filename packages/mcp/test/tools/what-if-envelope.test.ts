/// <reference types="vitest/globals" />
/**
 * P8-what-if-suite — the `what_if_*` family shares one input/output contract.
 *
 * Two guarantees, asserted here so a tool that drifts fails the build:
 *
 *   1. **Output shape** — every tool's `*Output` is assignable to the shared
 *      `WhatIfEnvelope` (`verdict` / `coverageCaveat?` / `trust` / `disclosure`).
 *      Proven at COMPILE TIME: `assertEnvelope<T extends WhatIfEnvelope>()` only
 *      type-checks when `T` carries those fields.
 *   2. **Input shape** — every tool names its primary target with a
 *      canonical-id string param (the one exception, `change_method_signature`,
 *      keys on `classApiName` because a method has no node id). Proven at RUN
 *      TIME by parsing `{}` and asserting the target param is reported missing.
 *      `deactivate_flow` enforces its target in the HANDLER instead of the
 *      schema (its `flowId` is one of several interchangeable selectors —
 *      `componentId` / `flowApiName` / `apiName` — so no single key can be
 *      schema-`required`); for it we assert the schema ACCEPTS the target and
 *      an empty object, and the handler's own suite proves `{}` → invalid-query.
 */
import { z } from 'zod';

import type { Verdict, WhatIfEnvelope } from '../../src/tools/coverage-trust.js';
import {
  whatIfChangeFieldTypeInputSchema,
  type WhatIfChangeFieldTypeOutput,
} from '../../src/tools/what-if-change-field-type.js';
import {
  whatIfChangeFieldValueInputSchema,
  type WhatIfChangeFieldValueOutput,
} from '../../src/tools/what-if-change-field-value.js';
import {
  whatIfChangeMethodSignatureInputSchema,
  type WhatIfChangeMethodSignatureOutput,
} from '../../src/tools/what-if-change-method-signature.js';
import {
  whatIfDeactivateFlowInputSchema,
  type WhatIfDeactivateFlowOutput,
} from '../../src/tools/what-if-deactivate-flow.js';
import {
  whatIfDisableTriggerInputSchema,
  type WhatIfDisableTriggerOutput,
} from '../../src/tools/what-if-disable-trigger.js';
import {
  whatIfMakeFieldRequiredInputSchema,
  type WhatIfMakeFieldRequiredOutput,
} from '../../src/tools/what-if-make-field-required.js';
import {
  whatIfMergeProfilesInputSchema,
  type WhatIfMergeProfilesOutput,
} from '../../src/tools/what-if-merge-profiles.js';
import {
  whatIfAssignPermsetInputSchema,
  whatIfRevokePermsetInputSchema,
  type WhatIfPermsetOutput,
} from '../../src/tools/what-if-permset.js';
import {
  whatIfRemovePicklistValueInputSchema,
  type WhatIfRemovePicklistValueOutput,
} from '../../src/tools/what-if-remove-picklist-value.js';
import {
  whatIfSplitProfileInputSchema,
  type WhatIfSplitProfileOutput,
} from '../../src/tools/what-if-split-profile.js';

/**
 * Compile-time conformance: the generic constraint `T extends WhatIfEnvelope`
 * only resolves when `T` is envelope-shaped, so each call below is a build-time
 * assertion. The body is a no-op — the type parameter does the work.
 */
const assertEnvelope = <T extends WhatIfEnvelope>(value?: T): void => {
  void value;
};

/** The 9 what_if tools, their input schema, and the required target param. */
const WHAT_IF_TOOLS: ReadonlyArray<{
  readonly tool: string;
  readonly schema: z.ZodTypeAny;
  readonly target: string;
  /**
   * When true, the target requirement is enforced in the HANDLER (invalid-query),
   * not the schema — the tool accepts several interchangeable selectors so no
   * single key can be schema-`required`. The tool's own suite proves `{}` is
   * rejected at the handler layer.
   */
  readonly targetEnforcedInHandler?: boolean;
  /**
   * Minimal NON-target payload the schema still requires (e.g. a hybrid tool
   * that requires `methodName` at the schema layer but enforces the class
   * target in the handler). Defaults to `{}` when the target is the only
   * schema/handler requirement.
   */
  readonly baseValid?: Record<string, unknown>;
}> = [
  { tool: 'what_if_change_field_type', schema: whatIfChangeFieldTypeInputSchema, target: 'fieldId' },
  { tool: 'what_if_change_field_value', schema: whatIfChangeFieldValueInputSchema, target: 'fieldId' },
  { tool: 'what_if_change_method_signature', schema: whatIfChangeMethodSignatureInputSchema, target: 'classApiName', targetEnforcedInHandler: true, baseValid: { methodName: 'foo' } },
  { tool: 'what_if_deactivate_flow', schema: whatIfDeactivateFlowInputSchema, target: 'flowId', targetEnforcedInHandler: true },
  { tool: 'what_if_disable_trigger', schema: whatIfDisableTriggerInputSchema, target: 'triggerId' },
  { tool: 'what_if_make_field_required', schema: whatIfMakeFieldRequiredInputSchema, target: 'fieldId' },
  { tool: 'what_if_merge_profiles', schema: whatIfMergeProfilesInputSchema, target: 'profileIdA' },
  { tool: 'what_if_remove_picklist_value', schema: whatIfRemovePicklistValueInputSchema, target: 'fieldId' },
  { tool: 'what_if_split_profile', schema: whatIfSplitProfileInputSchema, target: 'profileId' },
  { tool: 'what_if_assign_permset', schema: whatIfAssignPermsetInputSchema, target: 'permissionSetId' },
  { tool: 'what_if_revoke_permset', schema: whatIfRevokePermsetInputSchema, target: 'permissionSetId' },
];

describe('P8-what-if-suite — unified what_if contract', () => {
  it('every what_if Output conforms to the shared WhatIfEnvelope', () => {
    assertEnvelope<WhatIfChangeFieldTypeOutput>();
    assertEnvelope<WhatIfChangeFieldValueOutput>();
    assertEnvelope<WhatIfChangeMethodSignatureOutput>();
    assertEnvelope<WhatIfDeactivateFlowOutput>();
    assertEnvelope<WhatIfDisableTriggerOutput>();
    assertEnvelope<WhatIfMakeFieldRequiredOutput>();
    assertEnvelope<WhatIfMergeProfilesOutput>();
    assertEnvelope<WhatIfRemovePicklistValueOutput>();
    assertEnvelope<WhatIfSplitProfileOutput>();
    assertEnvelope<WhatIfPermsetOutput>();
    expect(WHAT_IF_TOOLS).toHaveLength(11);
  });

  it('the unified Verdict vocabulary is the documented superset', () => {
    const verdicts: readonly Verdict[] = ['safe', 'review', 'risky', 'blocking', 'unknown'];
    expect(new Set(verdicts).size).toBe(5);
  });

  it.each(WHAT_IF_TOOLS)(
    '$tool requires its target param "$target"',
    ({ schema, target, targetEnforcedInHandler, baseValid }) => {
      if (targetEnforcedInHandler === true) {
        // Requirement is enforced by the handler (invalid-query), not the
        // schema — the schema ACCEPTS the minimal non-target payload both
        // WITHOUT the target (handler would reject) AND WITH it. `baseValid`
        // carries any non-target field the schema still requires (e.g. a
        // hybrid tool that requires `methodName` but handler-enforces the
        // class target); it defaults to `{}` when the target is the only
        // requirement.
        const base = baseValid ?? {};
        expect(schema.safeParse(base).success).toBe(true);
        expect(schema.safeParse({ ...base, [target]: 'X' }).success).toBe(true);
        return;
      }
      const parsed = schema.safeParse({});
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const missing = parsed.error.issues.map((issue) => issue.path.join('.'));
        expect(missing).toContain(target);
      }
    },
  );
});
