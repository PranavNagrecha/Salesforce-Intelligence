/**
 * Envelope-honesty assertions — the shared gate the tool sweeps assert with.
 *
 * ## Why this module exists
 *
 * `end-to-end.test.ts` has always ended its whole-roster sweep with one
 * assertion: the envelope is not `not-implemented` and not `unknown-tool`.
 * That rejects a tool with NO handler. It accepts, without a murmur, a tool
 * whose handler ran and lied — `{ totalCount: 0 }` is a clean pass.
 *
 * 0.3.2 was a public apology for exactly that shape. Seven shipped tools
 * reported a finished, trustworthy ZERO for a state that was unchecked,
 * truncated, self-matched, or unsatisfiable:
 *
 *   - `find_component_usages` counted a class's own `class Foo` declaration
 *     as evidence something used it.
 *   - `unused_fields_deep` returned `{ fields: [], totalCount: 0 }` for
 *     objects that DO NOT EXIST — an unchecked zero in a checked zero's
 *     clothes.
 *   - `who_can_access_object` shipped 109 of 218 real rows with
 *     `hasMore: false` and `truncated: false`.
 *   - `find_hardcoded_values_anywhere` could not match the `a00`-`a05`
 *     custom-object key-prefix range at all and reported the resulting zero
 *     as a completed scan.
 *   - A refresh that modelled ZERO components printed "Refresh success".
 *
 * The gate that exists to catch that family accepted that family. This module
 * is the gate rewritten so it cannot.
 *
 * ## The three laws
 *
 * 1. TYPED ABSENCE — an empty collection or a zero count must be accompanied
 *    by a typed state that distinguishes not-retrieved / capped /
 *    checked-empty. A bare `[]` or `0` with no such marker fails.
 * 2. PAGINATION COMPLETENESS — `hasMore` / `truncated` / `nextOffset` must
 *    describe the rows ACTUALLY shipped. A trimmed payload may not claim
 *    completeness, and `nextOffset` must equal `offset + rows.length`.
 * 3. SCOPE REFUSAL — a tool handed an object scope that does not resolve must
 *    return a structured refusal, never a clean zero.
 *
 * ## VACUITY RISK — read this before editing
 *
 * This repo has a documented history of gates that pass while asserting
 * nothing: `scan:leaks` passes when its gitignored config is absent, two
 * 0.3.2 tests "passed" while asserting nothing at all, and the Windows CI job
 * was disarmed at exactly the files carrying the bugs. The specific ways THIS
 * gate could join them, and what stops each:
 *
 *   (V1) **The marker set grows until every payload satisfies it.** Law 1 is
 *        an any-of over honesty markers. Admit one key that every response
 *        carries and the law is decoration. Defence: the accepted set is
 *        enumerated below, each entry justified by the contract type it comes
 *        from, and the DELIBERATELY-REJECTED set is enumerated next to it with
 *        the reason. Measured against 122 live tool payloads on the demo
 *        vault, no accepted marker appears on more than 41% of them, and 3 of
 *        the 73 payloads carrying an absence site carry no marker at all —
 *        i.e. the law discriminates, it does not wave through.
 *   (V2) **The rule never fires.** An audit that walks a shape it never
 *        encounters reports zero findings and looks green. Defence:
 *        {@link HonestyAudit.checks} counts how many times each law was
 *        actually EVALUATED (not how many passed), and the sweep asserts those
 *        counters against a denominator derived from the roster. A law that
 *        stopped firing fails the gate as loudly as a law that failed.
 *   (V3) **The fixture disappears and the suite skips.** A `describe.skipIf`
 *        on a missing vault is how `scan:leaks` passes vacuously. Defence: the
 *        sweep THROWS when the demo vault is absent. There is no skip path.
 *   (V4) **A tool-name allowlist absorbs every failure.** Defence: there is
 *        none. Every predicate below is structural — it reads the payload's
 *        own shape. When a tool fails, the sweep names it as a defect.
 *
 * A comment is not a guard: `envelope-honesty.test.ts` proves each law by
 * feeding it a deliberately-lying payload and requiring the law to FAIL, then
 * the honest counterpart and requiring it to PASS.
 */

/** Which law produced a finding. */
export type HonestyRule =
  | 'legacy-stub'
  | 'typed-absence'
  | 'pagination-completeness'
  | 'scope-refusal';

/** One honesty violation on one payload. */
export interface HonestyFinding {
  readonly rule: HonestyRule;
  /** Tool that produced the payload. */
  readonly tool: string;
  /** Dotted path inside `data` the finding is about (`''` = whole envelope). */
  readonly path: string;
  /** What the payload claimed and why that claim is not supported. */
  readonly detail: string;
}

/**
 * How many times each law was EVALUATED on this payload — the anti-vacuity
 * instrument (V2). A law that never evaluates asserts nothing, and a caller
 * that only reads `findings` cannot tell that apart from a law that passed.
 */
export interface HonestyChecks {
  readonly legacyStub: number;
  readonly typedAbsence: number;
  readonly pagination: number;
  readonly scopeRefusal: number;
}

/** Result of auditing one envelope. */
export interface HonestyAudit {
  readonly findings: readonly HonestyFinding[];
  readonly checks: HonestyChecks;
}

/** The two legacy stub envelopes: a tool registered without a handler / a typo. */
const LEGACY_STUBS = new Set(['not-implemented', 'unknown-tool']);

/**
 * The `McpError.kind` union (`packages/contracts/src/index.ts`). An `error`
 * whose kind is outside it is itself a defect — a handler inventing an
 * error vocabulary the caller cannot switch on.
 */
const MCP_ERROR_KINDS = new Set([
  'vault-missing',
  'vault-stale',
  'component-not-found',
  'invalid-query',
  'oversize',
  'internal',
]);

/**
 * Structured refusals that satisfy Law 3. Both are real refusals: a bare api
 * name that resolves to nothing is `invalid-query` (the wording
 * `unused_fields_deep`'s own tool description promises), and a canonical id
 * that names no node is `component-not-found` (what `who_can_access_object`
 * returns). Nothing else counts — an `internal` is a crash, not a refusal.
 */
const SCOPE_REFUSAL_KINDS = new Set(['invalid-query', 'component-not-found']);

/**
 * Keys whose presence on the enclosing object types an absence.
 *
 * ACCEPTED — each is a declared honesty axis, not incidental payload:
 *
 *   - `absence` / `absenceStatus` — `EvidenceAbsenceV2`
 *     (`proven-none` | `not-checked` | `unknown`). The strongest form: the
 *     tool states outright how to read its own zero.
 *   - `evidenceEnvelope.absence` — the same block nested under
 *     `EvidenceEnvelopeV2`.
 *   - `coverage` / `completeness` carrying a `status` — `EvidenceCoverageV2`
 *     (`complete` | `partial` | `unknown`).
 *   - `trust.completeness.status` — the `TrustSummary` completeness axis.
 *   - `coverageCaveat` — the per-tool coverage-honesty block (376 uses in
 *     `packages/mcp/src/tools`).
 *   - `boundaries` — the "what this scan could NOT see" string list (593
 *     uses). The dominant vocabulary in this tree.
 *   - `limitations` / `trust.limitations` — same axis, `TrustSummary` form.
 *   - `notModeled` / `neverModeled` / `uncheckedTypes` / `notCheckedTypes` —
 *     the family-was-never-extracted sentinel described in
 *     `packages/mcp/src/tools/absence-disclosure.ts`: "a container with
 *     `customPermissionGrantCount: 0` was CHECKED and holds none; a container
 *     with no such key was never checked."
 *   - `disclosure` — a free-text honesty sentence attached to the payload.
 *
 * REJECTED, and why (this list is load-bearing — see V1):
 *
 *   - bare `trust`. Present on 35 of 122 live payloads and says nothing about
 *     absence; only its `completeness` / `limitations` children do.
 *   - `truncated` / `hasMore` / `capped` / `nextOffset` / `nextCursor`. These
 *     describe the PAGE, not whether the scan ran. `truncated: false` sitting
 *     beside `totalCount: 0` is the precise `who_can_access_object` lie this
 *     gate exists to catch; accepting it as an absence marker would make Law 1
 *     certify the bug. Page shape is governed by Law 2 instead.
 *   - `appliedScope`. It echoes what was ASKED, not what was checked —
 *     `pii_inventory` and `unused_components` both echo a scope for an object
 *     that does not exist while shipping a clean zero.
 *   - envelope-level `contentPolicy.disclosure`. Universal boilerplate on
 *     every response; the audit therefore never looks outside `data`.
 *
 * This array is NOT decoration. `envelope-honesty.test.ts` pins it against
 * {@link typedAbsenceMarker} in both directions: every key listed here must be
 * accepted, and every key REJECTED above must stay rejected. Widening the
 * accepted set therefore requires editing this list, which is the one place a
 * reviewer looks — a comment claiming what the function does would drift the
 * first time someone edited the function, which is exactly how the duplicated
 * disclosure wordings in `absence-disclosure.ts` went wrong.
 */
export const ABSENCE_MARKER_KEYS = [
  'absence',
  'absenceStatus',
  'boundaries',
  'coverage',
  'coverageCaveat',
  'completeness',
  'disclosure',
  'evidenceEnvelope',
  'limitations',
  'neverModeled',
  'notCheckedTypes',
  'notModeled',
  'trust',
  'uncheckedTypes',
] as const;

/**
 * Keys that must NEVER type an absence, pinned so the rejection is testable.
 * See the REJECTED notes on {@link ABSENCE_MARKER_KEYS} for why each is here.
 */
export const REJECTED_ABSENCE_MARKER_KEYS = [
  'appliedScope',
  'capped',
  'hasMore',
  'limit',
  'nextCursor',
  'nextOffset',
  'offset',
  'truncated',
] as const;

/** Page-shape keys Law 2 reasons over. */
const PAGE_KEYS = [
  'totalCount',
  'returnedCount',
  'hasMore',
  'nextOffset',
  'nextCursor',
  'limit',
  'offset',
  'truncated',
] as const;

/** A plain JSON object (not an array, not null). */
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const isNonEmptyStringList = (value: unknown): boolean =>
  Array.isArray(value) && value.some(isNonEmptyString);

/**
 * Read a `status`-bearing honesty block: `{ status: 'partial', … }`. Returns
 * the status when the block is shaped like `EvidenceCoverageV2` /
 * `EvidenceAbsenceV2`, else `null`.
 */
const statusOf = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  const status = value['status'];
  return isNonEmptyString(status) ? (status as string) : null;
};

/**
 * The typed-absence marker on ONE object, or `null`. Named rather than
 * boolean so a failure message can say WHICH axis satisfied a sibling and a
 * reviewer can see the rule is discriminating, not rubber-stamping.
 */
export const typedAbsenceMarker = (owner: unknown): string | null => {
  if (!isObject(owner)) return null;

  if (statusOf(owner['absence']) !== null) return 'absence.status';
  if (isNonEmptyString(owner['absenceStatus'])) return 'absenceStatus';

  const envelope = owner['evidenceEnvelope'];
  if (isObject(envelope)) {
    if (statusOf(envelope['absence']) !== null) {
      return 'evidenceEnvelope.absence.status';
    }
    if (statusOf(envelope['coverage']) !== null) {
      return 'evidenceEnvelope.coverage.status';
    }
  }

  if (statusOf(owner['coverage']) !== null) return 'coverage.status';
  if (statusOf(owner['completeness']) !== null) return 'completeness.status';

  const trust = owner['trust'];
  if (isObject(trust)) {
    if (statusOf(trust['completeness']) !== null) {
      return 'trust.completeness.status';
    }
    if (isNonEmptyStringList(trust['limitations'])) {
      return 'trust.limitations[]';
    }
  }

  const caveat = owner['coverageCaveat'];
  if (isNonEmptyString(caveat) || (isObject(caveat) && Object.keys(caveat).length > 0)) {
    return 'coverageCaveat';
  }

  if (isNonEmptyStringList(owner['boundaries'])) return 'boundaries[]';
  if (isNonEmptyStringList(owner['limitations'])) return 'limitations[]';
  if (isNonEmptyStringList(owner['uncheckedTypes'])) return 'uncheckedTypes[]';
  if (isNonEmptyStringList(owner['notCheckedTypes'])) return 'notCheckedTypes[]';
  if (owner['notModeled'] !== undefined) return 'notModeled';
  if (owner['neverModeled'] !== undefined) return 'neverModeled';
  if (isNonEmptyString(owner['disclosure'])) return 'disclosure';

  return null;
};

/** One place in a payload where the tool asserted "none". */
interface AbsenceSite {
  readonly path: string;
  readonly owner: JsonObject;
  readonly shape: string;
}

/**
 * Every absence site under `data`, to one level of nesting.
 *
 * An absence site is an empty array, or a `…Count` / `…Total` number equal to
 * zero. One level of nesting is deliberate and matches the response guard's
 * own reach (`collectTrimCandidates` in `tool-dispatch.ts` descends exactly
 * one level into a direct child object) — deeper walking would start flagging
 * per-row detail objects, where a `0` is a datum rather than a claim.
 */
const collectAbsenceSites = (data: unknown): readonly AbsenceSite[] => {
  const sites: AbsenceSite[] = [];
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        if (value.length === 0) sites.push({ path, owner: node, shape: '[]' });
        continue;
      }
      if (typeof value === 'number' && value === 0 && /(count|total)$/i.test(key)) {
        sites.push({ path, owner: node, shape: '0' });
        continue;
      }
      if (depth < 1) walk(value, path, depth + 1);
    }
  };
  walk(data, '', 0);
  return sites;
};

/** Lengths of every array directly under `data`, by key. */
const shippedRowCounts = (data: JsonObject): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) counts.set(key, value.length);
  }
  return counts;
};

/**
 * Merge `data` and `data.pageInfo` into one page-shape view.
 *
 * A cursor-aware handler publishes `PageInfo` under `data.pageInfo`
 * (`totalCount` / `returnedCount` / `hasMore` / `nextCursor`) while legacy
 * offset tools publish the same axes at the top level. Reading both means Law
 * 2 covers each family without a per-tool branch. `pageInfo` wins on conflict
 * — the contract says the handler's own pagination is authoritative.
 */
const pageView = (data: JsonObject): JsonObject => {
  const view: JsonObject = {};
  for (const key of PAGE_KEYS) {
    if (key in data) view[key] = data[key];
  }
  const info = data['pageInfo'];
  if (isObject(info)) {
    for (const key of PAGE_KEYS) {
      if (key in info) view[key] = info[key];
    }
  }
  return view;
};

/**
 * LAW 1 — typed absence.
 *
 * A zero must say how it was reached. The marker is looked for on the site's
 * own enclosing object first, then on `data` — a payload-wide `boundaries`
 * legitimately covers the lists it describes, which is how every honest tool
 * in this tree already writes it.
 */
const auditTypedAbsence = (
  tool: string,
  data: JsonObject,
): { findings: readonly HonestyFinding[]; evaluated: number } => {
  const sites = collectAbsenceSites(data);
  if (sites.length === 0) return { findings: [], evaluated: 0 };

  const payloadMarker = typedAbsenceMarker(data);
  const findings: HonestyFinding[] = [];
  for (const site of sites) {
    if (payloadMarker !== null) continue;
    if (typedAbsenceMarker(site.owner) !== null) continue;
    findings.push({
      rule: 'typed-absence',
      tool,
      path: site.path,
      detail:
        `\`${site.path}\` is ${site.shape} with no typed-absence marker on it or on ` +
        `\`data\`. A caller cannot tell "checked, genuinely none" from "never ` +
        `retrieved" or "capped before it got here". Attach one of: absence.status ` +
        `(EvidenceAbsenceV2), coverage/completeness.status, trust.completeness, ` +
        `coverageCaveat, boundaries[], or the not-extracted sentinel.`,
    });
  }
  return { findings, evaluated: sites.length };
};

/**
 * LAW 2 — pagination completeness.
 *
 * Every predicate compares a published claim against the rows the payload
 * ACTUALLY carries. `rows.length` is taken as the longest array directly under
 * `data`: no shorter list can be the paged one, so a `totalCount` exceeding
 * even the longest list was not shipped by ANY list in the response. That
 * makes the comparison sound without a per-tool map of "which key is the page"
 * — the sort of hand-maintained table this gate exists to retire.
 */
const auditPagination = (
  tool: string,
  data: JsonObject,
  envelope: JsonObject,
): { findings: readonly HonestyFinding[]; evaluated: number } => {
  const page = pageView(data);
  if (Object.keys(page).length === 0) return { findings: [], evaluated: 0 };

  const rows = shippedRowCounts(data);
  const lengths = [...rows.values()];
  const longest = lengths.length > 0 ? Math.max(...lengths) : 0;
  const offset = typeof page['offset'] === 'number' ? (page['offset'] as number) : 0;
  const totalCount = page['totalCount'];
  const returnedCount = page['returnedCount'];
  const hasMore = page['hasMore'];
  const truncated = page['truncated'];
  const nextOffset = page['nextOffset'];
  const hasCursor = isNonEmptyString(page['nextCursor']);
  const findings: HonestyFinding[] = [];

  // P1 — a payload that shipped fewer rows than it counted may not claim
  // completeness. This is the `who_can_access_object` archetype verbatim:
  // 109 of 218 rows with `hasMore: false` and `truncated: false`.
  if (
    typeof totalCount === 'number' &&
    totalCount > longest + offset &&
    hasMore !== true &&
    truncated !== true &&
    !hasCursor
  ) {
    findings.push({
      rule: 'pagination-completeness',
      tool,
      path: 'totalCount',
      detail:
        `totalCount ${totalCount} exceeds offset ${offset} + the longest list ` +
        `actually shipped (${longest}), yet hasMore=${String(hasMore)}, ` +
        `truncated=${String(truncated)} and there is no nextCursor. The payload ` +
        `claims a complete answer over rows it did not deliver.`,
    });
  }

  // P2 — `nextOffset` must equal `offset + rows.length` for a list that is
  // actually present. A pointer past rows the caller never received skips a
  // whole window on the next call.
  if (typeof nextOffset === 'number') {
    const matches = lengths.some((length) => offset + length === nextOffset);
    if (!matches) {
      findings.push({
        rule: 'pagination-completeness',
        tool,
        path: 'nextOffset',
        detail:
          `nextOffset ${nextOffset} does not equal offset ${offset} + the length of ` +
          `any list in this response (${JSON.stringify([...rows])}). Resuming from ` +
          `it skips or repeats rows.`,
      });
    }
  }

  // P3 — claiming more rows exist while offering no way to reach them.
  if (hasMore === true && (nextOffset === null || nextOffset === undefined) && !hasCursor) {
    findings.push({
      rule: 'pagination-completeness',
      tool,
      path: 'hasMore',
      detail:
        'hasMore is true but the payload carries neither nextOffset nor nextCursor — ' +
        'the remaining rows are unreachable.',
    });
  }

  // P4 — the two completeness axes contradicting each other.
  if (truncated === true && hasMore === false) {
    findings.push({
      rule: 'pagination-completeness',
      tool,
      path: 'truncated',
      detail: 'truncated is true while hasMore is false — the payload contradicts itself.',
    });
  }

  // P5 — the global response-budget guard trimmed rows, yet the payload still
  // publishes completeness. `responseBudget.truncated` is stamped by
  // `jsonResult` AFTER the handler built its page, so a handler flag left at
  // `false` is false exactly when it is printed.
  const budget = envelope['responseBudget'];
  if (isObject(budget) && budget['truncated'] === true) {
    if (truncated === false || hasMore === false) {
      findings.push({
        rule: 'pagination-completeness',
        tool,
        path: 'responseBudget.truncated',
        detail:
          'the response-budget guard trimmed rows from this payload, but the payload ' +
          `still publishes truncated=${String(truncated)} / hasMore=${String(hasMore)}.`,
      });
    }
  }

  // P6 — `returnedCount` must name a list that exists at that length.
  if (typeof returnedCount === 'number' && !lengths.includes(returnedCount)) {
    findings.push({
      rule: 'pagination-completeness',
      tool,
      path: 'returnedCount',
      detail:
        `returnedCount ${returnedCount} matches no list in this response ` +
        `(${JSON.stringify([...rows])}) — it does not describe the rows shipped.`,
    });
  }

  return { findings, evaluated: 1 };
};

/**
 * The two legacy stubs, plus the error vocabulary itself.
 *
 * The original `assertNotStubEnvelope` compared `body.error` — a STRING — to
 * the two stub names. Live handlers return `error` as an `McpError` OBJECT, so
 * that comparison could only ever fire on the legacy string form. Both shapes
 * are checked here, and an `error.kind` outside the contract union is reported
 * rather than accepted as "structured, therefore fine".
 */
const auditStub = (
  tool: string,
  envelope: JsonObject,
): { findings: readonly HonestyFinding[]; evaluated: number } => {
  if (!('error' in envelope)) return { findings: [], evaluated: 1 };
  const error = envelope['error'];
  const findings: HonestyFinding[] = [];

  if (typeof error === 'string') {
    if (LEGACY_STUBS.has(error)) {
      findings.push({
        rule: 'legacy-stub',
        tool,
        path: 'error',
        detail: `returned legacy stub '${error}' — the tool has no handler.`,
      });
    }
    return { findings, evaluated: 1 };
  }

  if (isObject(error)) {
    const kind = error['kind'];
    if (typeof kind === 'string' && LEGACY_STUBS.has(kind)) {
      findings.push({
        rule: 'legacy-stub',
        tool,
        path: 'error.kind',
        detail: `returned legacy stub '${kind}' — the tool has no handler.`,
      });
    } else if (typeof kind !== 'string' || !MCP_ERROR_KINDS.has(kind)) {
      findings.push({
        rule: 'legacy-stub',
        tool,
        path: 'error.kind',
        detail:
          `error.kind ${JSON.stringify(kind)} is outside the McpError union ` +
          `(${[...MCP_ERROR_KINDS].join(' | ')}) — a caller cannot switch on it.`,
      });
    }
    return { findings, evaluated: 1 };
  }

  findings.push({
    rule: 'legacy-stub',
    tool,
    path: 'error',
    detail: `error is ${JSON.stringify(error)} — neither a string nor an McpError.`,
  });
  return { findings, evaluated: 1 };
};

/**
 * Audit one envelope against laws 0-2. Law 3 needs a second, deliberately
 * unresolvable call, so it lives in {@link auditScopeRefusal}.
 *
 * Returns findings rather than throwing so a sweep can enumerate the WHOLE
 * defect backlog in one run. A gate that dies on the first violation reports
 * one bug and hides the other sixteen.
 */
export const auditEnvelope = (tool: string, envelope: unknown): HonestyAudit => {
  if (!isObject(envelope)) {
    return {
      findings: [
        {
          rule: 'legacy-stub',
          tool,
          path: '',
          detail: `envelope is not an object: ${JSON.stringify(envelope)}`,
        },
      ],
      checks: { legacyStub: 1, typedAbsence: 0, pagination: 0, scopeRefusal: 0 },
    };
  }

  const stub = auditStub(tool, envelope);
  const data = envelope['data'];
  if (!isObject(data)) {
    // A structured error, or a scalar `data`. Nothing to page and nothing to
    // count — the absence laws do not apply and must NOT be recorded as
    // evaluated, or the anti-vacuity counters would inflate on error runs.
    return {
      findings: stub.findings,
      checks: {
        legacyStub: stub.evaluated,
        typedAbsence: 0,
        pagination: 0,
        scopeRefusal: 0,
      },
    };
  }

  const absence = auditTypedAbsence(tool, data);
  const pagination = auditPagination(tool, data, envelope);
  return {
    findings: [...stub.findings, ...absence.findings, ...pagination.findings],
    checks: {
      legacyStub: stub.evaluated,
      typedAbsence: absence.evaluated,
      pagination: pagination.evaluated,
      scopeRefusal: 0,
    },
  };
};

/**
 * LAW 3 — scope refusal.
 *
 * `envelope` must be the response to a call whose object scope names something
 * that provably does not exist in the vault. The only honest answer is a
 * structured refusal. A `data` payload — empty or not — means the tool either
 * answered a question about a component that is not there, or silently dropped
 * the scope and answered a different question.
 *
 * The sub-classification is diagnostic only. It never softens the verdict:
 * every non-refusal is a finding.
 */
export const auditScopeRefusal = (
  tool: string,
  scopeKey: string,
  ghostScope: string,
  envelope: unknown,
): HonestyAudit => {
  const checks: HonestyChecks = {
    legacyStub: 0,
    typedAbsence: 0,
    pagination: 0,
    scopeRefusal: 1,
  };
  if (!isObject(envelope)) {
    return {
      findings: [
        {
          rule: 'scope-refusal',
          tool,
          path: scopeKey,
          detail: `envelope is not an object: ${JSON.stringify(envelope)}`,
        },
      ],
      checks,
    };
  }

  const error = envelope['error'];
  if (isObject(error) && typeof error['kind'] === 'string') {
    if (SCOPE_REFUSAL_KINDS.has(error['kind'])) return { findings: [], checks };
    return {
      findings: [
        {
          rule: 'scope-refusal',
          tool,
          path: scopeKey,
          detail:
            `${scopeKey}='${ghostScope}' names nothing in the vault; the tool ` +
            `answered with error.kind '${String(error['kind'])}' instead of ` +
            `${[...SCOPE_REFUSAL_KINDS].join(' / ')}.`,
        },
      ],
      checks,
    };
  }

  const data = envelope['data'];
  const rows = isObject(data) ? shippedRowCounts(data) : new Map<string, number>();
  // Diagnostic sub-label only — the finding fires either way. "Fabricated
  // rows" needs a populated list of RECORDS, not a populated list of prose:
  // `boundaries` / `disclosures` are non-empty string arrays on almost every
  // honest payload, and counting them as rows would label every clean zero a
  // fabrication. The discriminator is structural (are the elements objects?)
  // rather than a list of blessed key names — a name allowlist is how this
  // class of bug survives. It errs toward CLEAN ZERO, the milder label.
  const fabricated = isObject(data)
    ? Object.entries(data).some(
        ([, value]) =>
          Array.isArray(value) && value.length > 0 && value.some((row) => isObject(row)),
      )
    : false;
  const verdict = fabricated ? 'FABRICATED ROWS' : 'CLEAN ZERO';
  const marker = typedAbsenceMarker(data);
  return {
    findings: [
      {
        rule: 'scope-refusal',
        tool,
        path: scopeKey,
        detail:
          `${scopeKey}='${ghostScope}' names nothing in the vault, yet the tool ` +
          `returned a data payload — ${verdict}. Lists: ${JSON.stringify([...rows])}. ` +
          `Absence marker: ${marker ?? 'NONE'}. An unresolvable scope must be ` +
          `refused with invalid-query / component-not-found, never answered.`,
      },
    ],
    checks,
  };
};

/** Sum two check tallies. */
export const addChecks = (a: HonestyChecks, b: HonestyChecks): HonestyChecks => ({
  legacyStub: a.legacyStub + b.legacyStub,
  typedAbsence: a.typedAbsence + b.typedAbsence,
  pagination: a.pagination + b.pagination,
  scopeRefusal: a.scopeRefusal + b.scopeRefusal,
});

/** An all-zero tally, for reducing. */
export const NO_CHECKS: HonestyChecks = {
  legacyStub: 0,
  typedAbsence: 0,
  pagination: 0,
  scopeRefusal: 0,
};

/** Render findings as a numbered report suitable for a test failure message. */
export const formatFindings = (findings: readonly HonestyFinding[]): string =>
  findings
    .map(
      (finding, index) =>
        `${String(index + 1).padStart(3, ' ')}. [${finding.rule}] ${finding.tool}` +
        `${finding.path.length > 0 ? ` @ ${finding.path}` : ''}\n       ${finding.detail}`,
    )
    .join('\n');

/**
 * Throwing form for call sites that audit ONE envelope (the SOE anchors in
 * `end-to-end.test.ts`). The sweep uses {@link auditEnvelope} directly so it
 * can enumerate the whole backlog instead of dying on the first violation.
 */
export const assertEnvelopeHonest = (tool: string, envelope: unknown): void => {
  const { findings } = auditEnvelope(tool, envelope);
  if (findings.length > 0) {
    throw new Error(
      `envelope-honesty violations for '${tool}':\n${formatFindings(findings)}`,
    );
  }
};

/**
 * The original gate, preserved as its own export so the historical call sites
 * keep their exact meaning: reject ONLY the two legacy stubs. Everything
 * stronger lives in {@link auditEnvelope}.
 *
 * Kept deliberately narrow — folding it into the full audit would change what
 * the 0.1-era assertions in `end-to-end.test.ts` mean without anyone reading
 * the diff.
 */
export const assertNotStubEnvelope = (envelope: unknown, tool: string): void => {
  if (!isObject(envelope) || !('error' in envelope)) return;
  const error = envelope['error'];
  const kind =
    typeof error === 'string'
      ? error
      : isObject(error) && typeof error['kind'] === 'string'
        ? error['kind']
        : null;
  if (kind !== null && LEGACY_STUBS.has(kind)) {
    throw new Error(`tool '${tool}' returned legacy stub: ${kind}`);
  }
};
