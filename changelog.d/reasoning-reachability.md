### Added

- **Concept reasoning now runs inside the answers people actually ask for
  (REASONING-REACHABILITY).** The deterministic concept model (142 concepts /
  193 rules) was reachable through exactly one leaf tool, `sfi.interpret`, which
  no other tool composed — 208 of 209 registered tools never touched the
  reasoning engine, and 133 of the 193 rules are node-shaped, so every one of
  them required the caller to already know the exact canonical id. New shared
  helper `knowledge/reason-component.ts` (`reasonAboutComponent`) is now the
  single code path; `sfi.interpret` is a thin projection of it.
- **`conceptReasoning` on `sfi.field_360`, `sfi.explain_apex_method`,
  `sfi.what_happens_on_save` and `sfi.get_component`**, default ON with
  `includeConceptReasoning: false` to opt out. Cited claims on the shared
  `EvidenceEnvelope v2` shape plus a `completeness` digest that keeps four
  states apart: rules that fired, rules evaluated that matched nothing, rules
  provably inapplicable to the component type, and rules that could not be
  evaluated. `completeness.noRuleCoversComponentType` marks the case where
  nothing was analysed, so an empty claim list is never read as a clean result.
- **Natural identifiers reach the reasoning plane.** `sfi.interpret` and
  `reasonAboutComponent` accept a non-canonical identifier (`Account.Foo__c`, a
  bare object or class name) and resolve it through the same shared resolver
  `sfi.resolve` uses, echoing the chosen anchor in `resolvedFrom`. A canonical
  id skips resolution entirely; an ambiguous identifier returns `invalid-query`
  naming every candidate rather than silently picking one.
- **`completeness` on `sfi.interpret`.** The dedicated reasoning tool was less
  honest than the tools composing it: on a component where nothing could be
  evaluated it returned an empty claim list plus "no curated reasoning rule
  matched the graph slice", which states rules ran when none had.

### Changed

- Concept-rule applicability now fails toward "could not determine" rather than
  "correctly skipped". Only the node-scoped bind categories, where
  `componentTypes` genuinely gates the root, can report a rule as provably
  inapplicable; edge and multi-edge shapes — and any bind shape the classifier
  does not recognise — are reported as undetermined with a `reason`.
- `MAX_BYTES` in `scripts/check-cli-bundle.mjs` raised to 5,900,000 for the
  added feature code. The ANTLR re-inline guard (`MAX_ANTLR_REFS`) is unchanged.

### Fixed

- **Order-of-execution steps were stripped by a double-counted budget.**
  `sfi.what_happens_on_save` attached the reasoning block and then subtracted
  its size from a budget that already measured the whole payload, charging it
  twice; measured, 33 of 50 real objects lost their entire action inventory on
  payloads well under budget, and the tool disclosed a truncation its own
  arithmetic had invented. The block is now attached after budget enforcement.
- **The size fit discarded the claims instead of the enumeration.** Fitting a
  composed block to its byte ceiling dropped cited claims — the product — while
  the actual bulk was the `completeness` enumeration of rule ids; measured over
  75 components it discarded every claim and still exceeded the ceiling by ~89%.
  Enumerations are now sampled (counts stay exact) and claims are only trimmed
  when they genuinely dominate the payload.
- **A missing reasoning block is no longer silent.** `sfi.field_360`,
  `sfi.explain_apex_method` and `sfi.get_component` returned no block and no
  explanation when reasoning was skipped or could not run, turning an
  unambiguous absence into an ambiguous one. Every path now discloses which
  case applied, including the `get_component` metadata probe (where the flag is
  deliberately ignored) and the doc-fallback path (no graph node to anchor on).
- **Retrieval was blamed for rules that had nothing to do with retrieval.** The
  unevaluable disclosure keyed on the total count and told the user their vault
  was missing metadata; measured, that sentence shipped on 100% of field and
  apex calls where not one rule was actually blocked by retrieval. The two
  reasons now carry separate counts, separate sentences, and separate `absence`
  treatment, and only a real retrieval gap can set `absence.status:
  'not-checked'`.
- **The suggested remedy could make coverage worse.** `sfi refresh --no-pull`
  is now recommended only when the vault has no coverage rows at all; on a vault
  that has them it leaves every family unconfirmed (measured: 5 missing families
  becoming 17), so a full refresh is recommended instead.
- The reasoning engine ran 4-6 times per composed call while fitting a block to
  its byte budget. It now runs once and the fit is a pure re-projection.
