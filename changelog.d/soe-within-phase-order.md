### Fixed

- **`sfi.order_of_execution` / `sfi.what_happens_on_save` no longer present an
  alphabetisation as the execution sequence.** Co-firing automations inside one
  phase were sorted by ascending component id and handed consecutive `stepIndex`
  values, with no caveat anywhere. Salesforce does not define which of two
  record-triggered flows in the same phase runs first, so a numbered list of six
  before-save flows read as an order that was really a sort.

  The stable sort stays — determinism of the response is wanted — but whenever a
  phase holds two or more steps the response now carries `withinPhaseOrder`:
  which phases are ambiguous, a three-state `triggerOrderState`, and (when the
  order was extracted) how many of the object's record-triggered flows declare
  one. `stepIndex` orders the PHASES; inside one it is a reading position. A
  composition with at most one step per phase emits nothing and is
  byte-identical to before.

  `triggerOrderState` is three states because two of them look identical from a
  zero count and mean opposite things. An object with NO record-triggered flows
  — an ambiguous phase made of validation rules, Apex triggers or workflow rules
  — is `not-applicable`: the caveat says Flow Trigger Order does not bear on it,
  and NO `coverageCaveat` is attached. Only `not-extracted` (the object HAS
  record-triggered flows whose order this vault never extracted) is a gap a
  refresh can close.

### Added

- **The Flow extractor reads `<Flow><triggerOrder>`** — Flow Trigger Order,
  1-2000, the one declaration that CAN fix the run order between two
  record-triggered flows on the same object and timing. The SOE tools sort the
  flow phases by it (declared ascending, then flows declaring none, then
  ascending component id — which is exactly the previous order when nothing
  declares one), so the disclosure becomes precise instead of blanket.

  It is a TOP-LEVEL `<Flow>` child, a sibling of `<start>` and `<status>` — NOT
  a `<start>` child, which is where the Flow Builder UI's placement of the
  setting makes everyone look for it. Measured across a real 275-flow vault, all
  24 declarations sit after `</start>`; reading it off `<start>` finds nothing
  and would report every flow as declaring no order. A regression test pins the
  location.

  The property is written on every Flow node, `null` included, so the KEY's
  absence means something distinct and important: the vault predates the
  extractor and the tool DID NOT CHECK. On such a vault the two SOE tools emit a
  `coverageCaveat` naming `Flow.triggerOrder` and pointing at `sfi refresh`,
  rather than reporting the flows as declaring no order — but only for an object
  that actually HAS record-triggered flows, never for one where the declaration
  could not have applied to a single step.
