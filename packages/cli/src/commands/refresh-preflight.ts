/**
 * P12-FIRSTRUN-refresh-preflight — set expectations before a full refresh.
 *
 * A first user pointing `sfi refresh` at a large org gets a long `sf project
 * retrieve` and a big tree with no warning. This assesses the expected size
 * (from the prior refresh's component count, when re-refreshing) and returns a
 * one-line expectation + a `--types` scoping hint when it's large or unscoped —
 * and stays quiet for a small or already-scoped refresh. Pure + side-effect-free
 * so the wiring in `refresh` just prints `message`.
 */

/** Above this prior-refresh component count, a full re-pull is "large". */
export const LARGE_ORG_COMPONENT_THRESHOLD = 3000;

export interface RefreshSizeInput {
  /** The prior refresh's total component count, or null on a first refresh. */
  readonly priorComponentCount: number | null;
  /** True when the caller passed `--types` (already scoped). */
  readonly scoped: boolean;
  /** True when `--no-pull` (no network retrieve — nothing to warn about). */
  readonly noPull: boolean;
}

export interface RefreshSizeAssessment {
  /** `quiet` prints nothing; `note` is informational; `warn` is the large-org heads-up. */
  readonly level: 'quiet' | 'note' | 'warn';
  readonly message: string | null;
}

export const assessRefreshSize = (input: RefreshSizeInput): RefreshSizeAssessment => {
  // No network retrieve, or the user already scoped it → nothing to set up.
  if (input.noPull || input.scoped) return { level: 'quiet', message: null };

  if (input.priorComponentCount !== null && input.priorComponentCount >= LARGE_ORG_COMPONENT_THRESHOLD) {
    return {
      level: 'warn',
      message:
        `Heads-up: the last refresh built ${input.priorComponentCount.toLocaleString()} components — a full re-pull ` +
        `can take several minutes and produce a large local tree. Scope it with ` +
        `\`sfi refresh --types CustomObject,CustomField,ApexClass,Flow\` (comma-separated) if you only need part of the org.`,
    };
  }

  if (input.priorComponentCount === null) {
    return {
      level: 'note',
      message:
        'First full refresh: `sf project retrieve` + extraction can take a few minutes for a large org. ' +
        'You can scope it with `--types <Type,Type>` (e.g. CustomObject,CustomField,ApexClass,Flow) and refresh more later.',
    };
  }

  return { level: 'quiet', message: null };
};
