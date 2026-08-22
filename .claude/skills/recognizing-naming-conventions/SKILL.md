---
name: recognizing-naming-conventions
description: |
  Surfaces observed naming-convention patterns from the SfIntelligence
  vault. Use when the user asks "what's our convention", "what's the
  naming standard", "do we always …", "is this consistent with the
  rest of the org", or proposes a new component name and wants it
  sanity-checked ("can I name this `CustomerOrder__c`?", "should I
  call this `Foo__c` or `Bar__c`?"). Calls
  `sfi.get_naming_convention_report` and reports its observations as
  **heuristic** — observed patterns, not enforced rules.
---

# Recognizing naming conventions

## Overview

`sfi.get_naming_convention_report` walks the vault's custom fields and
reports dominant **prefix**, **suffix**, and **casing** patterns per
parent object. Each observation has `confidence: 'heuristic'` — these
are *observed* regularities, not declared rules. This skill teaches
Claude how to call the tool, how to surface what it says, and how to
evaluate a proposed name against it without overclaiming.

The recognizer is deliberately conservative. It needs at least **5
custom fields** on a parent before it will say anything. A pattern has
to hold for **60% or more** of the fields in the group (75% for a
suffix-only pattern with no co-dominant prefix). Below those bars, the
recognizer emits silence — better silence than a noisy false positive.
This skill inherits that discipline: when the recognizer is silent,
say so honestly. Don't fill the gap with a guess.

## When to fire

- The user asks **what the convention is**: "what's our convention for
  status fields?", "what's the naming standard for custom fields on
  Account?", "how do we name dates around here?", "do we prefix with
  `Acc_` or not?".
- The user asks whether a name is **consistent**: "is `Foo__c`
  consistent with the rest of the org?", "does this name fit?", "is
  this aligned with how we name fields?".
- The user **proposes a name** for a new component and wants a check:
  "can I name this `CustomerOrder__c`?", "should I call this
  `Order_Date__c` or `Order_On__c`?", "I'm about to create
  `Foo_Bar__c` — does that look right?".
- The user references **"naming standards", "naming convention",
  "field naming", "naming pattern"** in any phrasing.

## When NOT to fire

- The user asks **what fields exist on Account** (schema lookup, not
  pattern detection). Defer to `answering-org-questions` →
  `sfi.list_components` or `sfi.get_component`.
- The user asks Claude to **rename** a field or **enforce** a
  convention across the org. v0.1 is read-only; the recognizer
  observes, it does not write or deploy. Tell the user to use
  `sf project deploy` themselves.
- The user wants the vault **refreshed** ("rebuild the index", "pull
  latest"). Defer to `refreshing-the-org-vault`.
- The user asks about a **declared** dependency ("what uses
  `Industry__c`?"). That's `sfi.get_edges`, not the recognizer.
  Naming patterns are heuristic by definition; declared edges are
  ground truth.

## How to invoke

The MCP tool is **`sfi.get_naming_convention_report`**. Input:

```json
{ "scope": "CustomField:Account.*" }
```

Three valid `scope` values:

- **`'all'`** (or omit `scope`) — analyze every parent object that
  meets the 5-field minimum. Use when the user asks generally.
- **`'CustomField:{ObjectApiName}'`** and
  **`'CustomField:{ObjectApiName}.*'`** — equivalent; both narrow to
  one parent. Use when the user names a specific object.

Anything else returns `invalid-query`.

The response is `{ observations: PatternObservation[], analyzed, note? }`.
Each observation has `scope`, `statement` (human-readable summary),
`evidence: { matching, total, examples[] }` (up to 5 examples), and
`confidence: 'heuristic'` (always — the recognizer never asserts).

`analyzed` carries the DENOMINATORS, and they are what make an empty
`observations` list readable:

- `objectsWithCustomFields` / `objectsBelowMinimumGroupSize` /
  `minimumGroupSize` — how many objects were in scope and how many
  emitted nothing because they sit under the minimum.
- `standardFieldsExcluded` — standard fields dropped before grouping
  WITHIN the analyzed scope, and `standardFieldsExcludedOrgWide` the
  org-wide figure. They differ on a scoped call by design; never
  quote the org-wide number as the scoped one.
- `scopedObjectCustomFieldCount` — the scoped object's custom-field
  count, `null` on a `scope: 'all'` call.

`note` is present on a scoped call that produced nothing; quote it.

## The 5-field minimum

If a parent object has fewer than 5 custom fields, the recognizer
returns **no observations for that scope**. This is by design — fewer
samples make every "pattern" coincidental.

When the report comes back empty for a scope the user asked about,
surface this honestly:

> "`CustomField:Account.*` has only 3 custom fields in the vault,
> which is below the recognizer's 5-field minimum. No naming pattern
> is reported. Manual review recommended — there isn't enough data
> to call a convention."

Do **not** invent a pattern from 2–4 samples. The recognizer is silent
on purpose; the skill is silent in step.

## How to report

When the recognizer returns observations, present them with their
evidence and heuristic confidence. The user is deciding whether to
follow the pattern; give them the numbers.

Acceptable:

> Based on `sfi.get_naming_convention_report` for
> `CustomField:Account.*` (parent: `CustomObject:Account`):
>
> - **Observed prefix:** `Acc_` (23 of 28 fields, ~82%). Examples:
>   `Acc_Revenue__c`, `Acc_Region__c`, `Acc_Tier__c`.
> - **Observed casing:** PascalCase after the prefix (21 of 28).
>
> Both observations are `heuristic` confidence — they describe what
> the vault contains, not what the org *requires*. Five fields don't
> match the prefix; the pattern is dominant but not universal.

Unacceptable:

> The convention is `Acc_<name>__c`. All Account fields use it.

The first cites evidence and qualifies. The second asserts a rule
that does not exist. Always cite the parent's canonical ID
(`CustomObject:Account`) so the user can navigate to its vault entry.

## Evaluating a proposed name

When the user proposes a name for a new field, the flow is:

1. **Identify the scope.** If the user said "a new field on
   `Account`", scope = `'CustomField:Account.*'`. If they didn't say
   a parent ("a new custom field"), ask which object — naming
   patterns are per-parent.
2. **Call `sfi.run_analysis` with `{ "name": "sfi.get_naming_convention_report", "args": { … } }`** for that scope.
3. **Compare the proposal against the observations.**
   - Does the proposed name match the observed prefix (if any)?
   - Does it match the observed suffix (if any)?
   - Does it match the observed casing (if any)?
4. **Report alignment or divergence**, with evidence.

Aligned example:

> Your proposed name `Acc_Order_Date__c` matches the observed
> convention for `CustomField:Account.*`:
>
> - Prefix `Acc_` ✓ (observed in 23 of 28 fields, ~82%).
> - Suffix `_Date` ✓ (observed in 8 of 28 fields, ~29% — note that
>   suffix is a weaker signal than prefix and didn't meet the
>   recognizer's 75% suffix-only bar; treat as a soft hint).
> - PascalCase after the prefix ✓.
>
> Looks aligned. Heuristic only — the convention isn't enforced
> anywhere in metadata.

Divergent example:

> Your proposed name `OrderDate__c` doesn't match the observed
> convention for `CustomField:Account.*`. The recognizer reports the
> prefix `Acc_` in 23 of 28 fields (~82%, heuristic). Consider
> `Acc_Order_Date__c` to stay aligned — but this is an observation,
> not a rule. If you have a reason to break the pattern, it's your
> call.

If the report is **empty** for the requested scope (5-field minimum
not met, or no pattern crossed the 60% bar), say so honestly — see
the *5-field minimum* section above — and point the user at
`org-kb/components/CustomField/{ObjectApiName}/` to eyeball the
existing fields.

## Confidence discipline

Every observation is `heuristic` — the recognizer cannot produce
`declared` patterns, because naming isn't encoded in Salesforce
metadata as a rule. Use the language of observation, not assertion:

| Say this | Don't say this |
|---|---|
| "Observed pattern" / "Appears to be the convention" | "The convention is" / "The rule is" |
| "Based on patterns in the vault" | "Account fields use this prefix" |
| "23 of 28 fields use this prefix" (cite numbers) | (drop the count) |
| "Heuristic confidence" (cite it once per response) | (silent on confidence) |

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'll call it 'the convention' for brevity." | These are heuristics. Say "observed pattern" or "appears to be the convention". Brevity isn't worth misrepresenting confidence. |
| "Fewer than 5 fields, but I'll still emit a pattern from what I see." | The recognizer enforces a 5-field minimum *for a reason* — patterns from 2–4 samples are coincidence. Surface the silence honestly. |
| "The recognizer didn't fire on Account; I'll improvise from general Salesforce best practice." | General Salesforce best practice doesn't know *this* org. If the recognizer is silent, the right answer is "no observed pattern", not a substitute pattern. |
| "82% adherence is high enough that I'll call it a rule." | 82% isn't 100%. 5 of 28 fields break the pattern. Report the percentage; let the user decide whether the pattern is strong enough to follow. |
| "The user proposed a name without specifying the object; I'll just run the recognizer with `scope: 'all'`." | Pattern recognition is per-parent. Different objects have different conventions. Ask which object the new field is for. |
| "I'll skip calling the tool and answer from the schema I already saw earlier this turn." | Schema lookups give you names, not patterns. The recognizer's prefix/suffix/casing detection is what makes "this matches" or "this doesn't" a defensible claim. Call the tool. |
| "The report is empty; I'll tell the user there is no convention." | Empty means "no pattern crossed the 60% bar" or "<5 fields", not "the org has no convention". Say what the recognizer actually means; don't translate silence into a negative claim. |
| "The user is just brainstorming a name; I don't need to call the tool." | Even a brainstorm is better informed by the observed pattern. The cost of the call is one MCP round-trip; the cost of suggesting a divergent name is a rename later. |

## Red flags

Stop and ask the user, or surface a limit, when:

- **The recognizer returns `invalid-query`** (the scope wasn't `'all'`
  or `'CustomField:{ObjectApiName}.*'`). Re-check the scope you
  passed; ask the user which object they meant if it's ambiguous.
- **The recognizer returns `internal`** (a graph error). Don't retry
  blindly — fire `pre-flight-checks` to see if the vault is healthy.
- **The user proposes a name for a metadata type the recognizer
  doesn't cover.** v0.1's recognizer is custom-fields-only. For
  CustomObject, ValidationRule, Flow, ApexClass, ApexTrigger, Layout,
  PermissionSet, or Profile naming, say so plainly: "The v0.1
  recognizer only reports patterns for custom fields. Manual review
  recommended for {type} naming."
- **The user wants the recognizer to **enforce** a pattern** (block a
  deploy if a name doesn't match). v0.1 observes; it does not
  enforce. Say so.
- **The observed pattern has low adherence** (e.g., 60% — just over
  the bar). Don't present a 60% match as if it were 95%. Cite the
  numbers and let the user weigh them.
- **`sfi.health_check`** reports the vault as `stale` or `missing`.
  Stop. Route to `/sfi-refresh` (stale) or `/sfi-init` (missing).
  Naming patterns from a stale vault may reflect a renamed-away
  prefix that no longer applies.

## Verification

Before sending a response, confirm:

- [ ] I called `sfi.run_analysis` for `sfi.get_naming_convention_report` with a valid scope
      (`'all'` or `'CustomField:{ObjectApiName}.*'`), and I picked
      the scope from the user's question — not a guess.
- [ ] I reported every observation in the response, with its
      `matching`, `total`, and at least one example from `examples`.
- [ ] I used the language of observation, not assertion: "observed",
      "appears", "based on patterns" — never "the convention is".
- [ ] I cited `heuristic` confidence at least once per response.
- [ ] If the report was empty, I said so honestly and named the
      reason (5-field minimum, no pattern crossed 60%) — I did not
      improvise a pattern.
- [ ] If I evaluated a proposed name, I compared it against the
      observed prefix/suffix/casing and reported alignment with
      evidence, not a verdict.
- [ ] I cited the parent's canonical ID
      (`CustomObject:{ApiName}`) when reporting a per-object
      pattern.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
