### Fixed

- **A shipped skill taught the model to emit Salesforce enum values that do not
  exist.** `.claude/skills/admin-legacy-automation/SKILL.md` instructed the model
  to report EscalationRule action timing as `SinceCaseCreation` / `SinceLastUpdate`.
  Neither is a Salesforce value: `<escalationStartTime>` is `CaseCreation` |
  `CaseLastModified` (`ALLOWED_START_TIMES`,
  `packages/extractors/src/escalation-rule.ts`). That exact guess previously lived
  in the extractor's allowed-enum and rejected every real escalation rule as
  `malformed-input`, dropping the WHOLE `Case.escalationRules` file from the vault;
  the extractor was corrected then, the skill was not, and kept teaching the
  fabricated values. `pnpm doc-sync` now fails on all three invented spellings.

- **`coversTest` is declared in the contract but has NO producer, and both the
  contract and a shipped skill claimed otherwise.** No extractor, graph-build mint,
  or enricher emits the edge (zero emission sites across `packages/*/src`), so it
  is empty on every real vault. `EdgeType`'s member comment claimed it was
  "declared via @TestVisible/@TestSetup, heuristic from callsApex inference" — no
  such producer was ever written, and neither annotation could implement it
  (`@TestVisible` marks a member on the TARGET and names no test; `@TestSetup` sits
  inside the test class and names no target). `developer-impact-and-reachability`
  told the model a covering test "may be missed", which reads as "coverage is
  basically known" when coverage mapping is entirely unavailable. Both corrected
  to state that an empty result means test-coverage mapping UNAVAILABLE, never
  "no tests cover this"; `pnpm doc-sync` now fails on the old wording.

- **`docs/configuration.md` advertised the fleet drift sweep as `N orgs × 6
  checks` while `STALE_CHECK_TYPES` had grown to 15**, so a reader sizing
  `SFI_LIVE_QUERY_BUDGET` off that sentence under-provisions by 2.5x and gets the
  `budget-exhausted` skips the same paragraph says should not happen. Corrected,
  and `pnpm doc-sync` now pins the stated count to `STALE_CHECK_TYPES.length`
  rather than to a hand-copied number.

- **Citations to files that do not exist.** `packages/graph/src/schema.ts` claimed
  to mirror "the `Graph schema (DuckDB)` section of `ARCHITECTURE.md` verbatim" —
  there is no `ARCHITECTURE.md` in the repo and no section by that name in
  `docs/architecture.md`; corrected to the section that does exist, without the
  "verbatim" claim. A shipped skill (`pre-flight-checks`) and the `/sfi-status`
  command both told the model to point users at `INSTALL.md`, which does not
  exist (the guide is `docs/guides/installation.md`). `CONTRIBUTING.md` sent
  contributors to `website/site-data.json` for the `toolCount` bump; the file is
  `website/src/data/site-data.json`, so the instruction created a decoy rather
  than satisfying the gate it names.

- **`REPO-STRUCTURE.md` under-counted the shipped plugin surface**, advertising
  25 skill folders and 4 slash commands against 26 and 5 on disk —
  `sfi-field-audit` shipped unlisted in both. `pnpm doc-sync` now counts both
  from disk and additionally fails when a command name is missing from the list,
  since a correct total can still hide an unlisted command.

- **The plugin misstated its own size on every surface that states it**, worst
  in `using-sf-intelligence` — the entry skill loaded first in every Salesforce
  session — which advertised 72 component types, 20 edge types, 121 `sfi.*`
  tools and 25 skills against a live 101 / 23 / 209 / 26. `README.md` also
  contradicted itself 135 lines apart (26 skills + 5 slash commands in the
  capability table, 25 + 4 in the install section), and
  `refreshing-the-org-vault` repeated the 72. `pnpm doc-sync` now derives all
  five counts from `COMPONENT_TYPES`, `EDGE_TYPES`, `V01_TOOLS`, and the
  `.claude/` tree, and checks every surface that states one.

- **A shipped skill documented an entire tool contract that does not exist.**
  `admin-page-layout-routing` invented all four cascade stage names for
  `sfi.layout_for_user` (`ProfileLayoutAssignment` / `ProfileDefaultRecordType` /
  `MasterFallback` / `PermissionSetRecordTypeVisibility`) — the real union is
  `ProfileLookup | LayoutAssignment | RecordTypeResolution | LightningPageLookup |
  Default` — plus verdicts (`no-match`, `resolved`) outside the real
  `matched | fallback | unknown | not-found`, and per-step keys (`rule`, `note`,
  `layoutId`) the response has never carried. Worse, every documented example
  wrapped the args in a `recordContext` / `userContext` envelope while
  `layoutForUserInputSchema` is FLAT with `objectApiName` required — so each
  example in the skill was a call that returns `invalid-query`. The skill also
  taught that an unresolvable profile arrives as `{ error: { kind:
  'component-not-found' } }`; it arrives as a SUCCESSFUL response whose single
  step is `ProfileLookup` / `not-found`, which a reader following the old text
  would narrate as "this profile has no layout assigned". Rewritten against the
  Zod schema and handler.

- **`sfi.why_cant_user_see_record`'s canonical example passed parameters the tool
  has never had.** `admin-sharing-troubleshooting` fired it with
  `{ userId, recordId }`; the schema takes `componentId` / `objectApiName`, a
  nested `userContext` bundle, and `accessLevel`. Both invented keys are stripped
  and the call then fails BOTH required-axis refinements. The documented response
  shape was fabricated end to end (`rule` / `decision` / `name` / `ruleType` /
  `note` against the real `stage` / `verdict` / `reason` / `traversed`), it
  presented `"Public"` as an OWD value — a Salesforce UI label, absent from
  `ALLOWED_SHARING_MODEL`, which the extractor REJECTS — and it rendered
  `owner-based` / `criteria-based` as `ruleType` VALUES where the extractor emits
  `owner` / `criteria` / `guest` / `territory` / `territoryGroup`.

- **`sfi.code_quality_audit` silently widened a scoped audit to the whole org.**
  The input schema was a bare `z.object`, so the `componentFilter` key that this
  repo's own `developer-code-quality` skill documented was DROPPED — the caller
  asked for one class and got the org-wide leaderboard back with no
  `appliedScope` to reveal it, then read it as that class's findings. That is a
  confidently-wrong answer, not an error. `componentFilter` is now an honored
  scope alias (ADR-007's "never silently strip a mismatched alias"), routed
  through the same `resolveScopeId` that already yields `invalid-query` on a
  non-Apex prefix and `component-not-found` on an unresolved id; and the schema
  is `.strict()`, so any OTHER mis-spelled scope key is a loud `invalid-query`
  instead of a silent widening. The advertised JSON Schema in `roster.ts` mirrors
  both. The same skill also documented `ruleFilter` as a bare string against a
  `z.array`, which under `.strict()` is now unambiguously an error rather than a
  quiet mismatch.

- **Skills instructed the model to read signals with ZERO producers.**
  `parsedCron`, `rawCronExpression`, `isCdcEnabled` and `maxDepthObserved` are
  written by nothing in `packages/*/src`. `architect-async-and-events` built a
  whole "cron-parse-failure axis" on `parsedCron` — there is no cron parser in
  this repo at all (`cron-parser` is not a dependency), and the two REAL
  cron-shaped fields (`cronExpressions[]`, `scheduledByCalls[].cronExpression`)
  are also unpopulated: the Apex scanner's `System.schedule(name, cron, new X())`
  regex captures the class name and DISCARDS the cron argument. The skill also
  told the model to read `properties.isCdcEnabled` off a CustomObject, and used
  `maxDepthObserved` / a `cyclesDetected[]` LIST where `async_chain_depth`
  returns `maxDepth` and a `cyclesDetected` BOOLEAN. Each is the `coversTest`
  failure class: `undefined` narrated as a negative finding ("CDC is not
  enabled", "this job has no schedule"). Corrected, with the cron question routed
  honestly to `sfi.live_scheduled_jobs`.

- **Two boundary disclosures were overtaken by shipped work and became false
  refusals.** `architect-async-and-events` still said CDC per-channel filter
  expressions are not extracted — a dedicated `platformEventChannelMember`
  extractor reads them and `cdc_subscribers` surfaces them as
  `channelMembers[].filterExpression`; and `admin-legacy-automation` still told
  the model EmailTemplate merge tokens are un-tokenized and to surface the body
  verbatim — the v3.0 body-merge scan resolves `{!Object.Field}` into
  `references` edges plus `properties.mergeFields` / `referencedObjects`, and
  there is no body property to surface (the extractor stores `bodyLength`, a
  number). Refusing a question the product can answer is the same defect as
  answering one it cannot.

- **EmailTemplate property-name drift.** Skills read `type` / `letterhead` /
  `body`; the extractor emits `templateType` / `letterheadName` / `bodyLength`.
  Every one of those reads returns `undefined`.

- **`criteriaItemCount` was documented in the wrong place for three of four rule
  families.** `admin-legacy-automation` claimed `properties.criteriaItemCount` on
  WorkflowRule, AssignmentRule, EscalationRule and AutoResponseRule. It is a NODE
  property on WorkflowRule only; AssignmentRule and AutoResponseRule carry it
  per-`ruleEntry` on their outgoing `references` / `sendsEmail` EDGES; and
  EscalationRule does not emit it at all (`active`, `ruleEntryCount`,
  `actionCount`, `conditions`). A missing count read as zero criteria is a
  fabricated negative.

- **`ADR-004` documented six phantom buckets against a seven-member
  `PhantomClassification`**, and the error had propagated into two JSDoc headers
  (`graph/phantom-bucket-summary.ts`, `mcp/tools/phantom-taxonomy.ts`). The
  seventh, `unresolved-profile-id`, is an id-shape short-circuit in the MCP tool
  that runs BEFORE the shared `classifyPhantom` — so the refresh-time roll-up
  cannot emit it and buckets the same id differently from `get_component`. That
  divergence is now recorded in the ADR and both headers rather than left for the
  next reader to rediscover.

- **`event_subscribers` overclaimed its own publisher coverage.** Its verbatim
  disclosure and JSDoc named Apex `EventBus.publish(...)` as a detection source.
  No scanner in `packages/parsers/src` or `packages/extractors/src` detects it —
  the Apex scanner covers `EventBus.subscribe` and nothing on the publish side —
  so only Flow `<recordCreates>` publishers ever reach `publishers[]`. The test
  suite is green on that path because the fixture seeds the edge directly.
  Coverage is now stated as asymmetric, so an empty `publishers[]` reads as "no
  modeled FLOW publisher", never "nothing publishes this event".

### Changed

- `pnpm doc-sync` gained contract-DERIVED guards rather than more phrase
  blacklists: cascade `stage` / `verdict` values rendered in a skill are checked
  against the TS unions parsed out of the tool source; OWD and sharing-`ruleType`
  values against `ALLOWED_SHARING_MODEL` and the extractor's `RuleType`; the
  phantom bucket count and every member name against `PhantomClassification`;
  and `code_quality_audit`'s scope alias + `.strict()` against the built schema.
  A zero-producer guard re-runs the producer search each gate and fails in BOTH
  directions — if a skill starts reading an absent signal, and if one of those
  signals is finally implemented (at which point the "this does not exist" prose
  becomes the lie).

- `packages/graph` and `packages/mcp` vitest configs set `hookTimeout` to match
  their already-raised `testTimeout`. Both had raised `testTimeout` for the
  DuckDB-backed suites but left hooks on vitest's 10s default
  (`hookTimeout ??= 1e4`), so a `beforeAll` that OPENS the graph had a fraction
  of the budget of the tests that query it. Under the parallel pool that surfaced
  as an intermittent setup failure in a different package each run — a FALSE red
  that invites re-running until green. Only the setup budget changed; no
  assertion was weakened.
