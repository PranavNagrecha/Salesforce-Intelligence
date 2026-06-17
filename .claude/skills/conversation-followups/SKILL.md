---
name: conversation-followups
description: |
  Conversation memory and follow-up handling for the sf-intelligence org. Fire
  on follow-up turns that depend on what was just discussed — pronouns and
  ellipsis ("what about the other one?", "and on Contact?", "is that one safe to
  delete?", "show me its dependencies", "the second one"), refinements of a prior
  answer, or "what should I look at next?". Keeps the resolved component, the
  last tool/plane, and the disambiguation options from the previous turns so the
  user does not have to repeat themselves. Pairs with answering-org-questions
  (which does the actual lookups) and using-sf-intelligence (the cascade).
---

# Conversation follow-ups

## Overview

Admins ask in *threads*, not isolated questions. "What runs on save for Account?"
→ "what about Contact?" → "is the second flow safe to deactivate?" Each follow-up
leans on the previous turn. This skill is the **short-term memory** that makes the
thread feel intelligent: carry the context forward instead of asking the user to
re-state it, and never silently re-bind a pronoun to the wrong thing.

It does not do lookups itself — `answering-org-questions` and the `sfi.*` tools
do. This skill governs **what "it"/"that"/"the other one" refers to** and **what
to offer next**.

## Carry this context across turns

Hold, and update each turn:

- **The resolved component(s).** The canonical id(s) the last answer was about
  (`CustomField:Account.Industry__c`, `Flow:Onboarding`). "it" / "that field" /
  "its dependencies" bind here.
- **The last plane + tool.** Whether the previous answer was `vault` / `live` /
  `hybrid`, and which tool produced it. "do the same on Contact" reuses the tool
  with a new object; "now check production" re-runs the live variant.
- **The open disambiguation set.** If the last turn returned `sfi.resolve`
  `ambiguous` with N candidates, remember them. "the second one" / "the Contact
  one" selects from that set **without re-resolving**.
- **The object/scope in focus.** "and the validation rules?" inherits the object
  from the prior turn.

## Resolving references — the rules

- **Pronoun → last resolved id.** "is it safe to delete?" with `Industry__c` in
  focus → `sfi.safe_to_delete_field` on `CustomField:Account.Industry__c`. State
  what "it" bound to ("For `CustomField:Account.Industry__c` …") so the user can
  catch a mis-bind.
- **"the other / the second / the Contact one" → the remembered candidate set.**
  Pick from the prior `ambiguous` options; do not silently re-run resolve and
  hope for the same order.
- **"what about X / and on Y" → same tool, new target.** Re-run the previous
  tool/plane against the new component. If the new target needs resolving, resolve
  it first.
- **Ambiguous reference with no remembered set → ask, don't guess.** If "the
  other one" has nothing to bind to, present a clarifying question (AskUserQuestion)
  rather than picking. This is the same never-silently-guess rule as resolve.
- **Topic change resets focus.** A fresh named entity replaces the carried one;
  don't drag stale context into an unrelated question.

## State confidence per claim, not per answer

A single answer can mix certainty levels — say so inline rather than once at the
end:

- **Sure (declared / `offline_snapshot` exact):** state it plainly.
- **Spot-check (parsed / heuristic, or a static-analysis boundary):** flag it —
  "by static analysis (no runtime proof), …", "heuristic from N samples, verify
  before acting".
- **Live (`live_org`):** stamp the as-of time; note it can change.
- **Mixed (hybrid):** attribute each half — "the vault shows 3 writers (offline,
  refreshed May 20); live data shows 94% populated (queried just now)."

When a follow-up would push a `heuristic` finding toward a deploy/delete decision,
make the confidence explicit *before* the user acts.

## Suggest the next question

End substantive answers with 1–3 *grounded* next steps the data supports — not
generic filler. Draw them from what the current answer surfaced:

- After "what runs on save for Account" → "Want the order-of-execution, or which
  of these writes `Industry__c`?"
- After a `safe_to_delete_field` `review` verdict → "Want the blast radius
  (`sfi.get_impact`), or the live population to confirm it's empty?"
- After `org_overview` → "Want the security sweep, the cleanup sweep, or a domain
  deep-dive?" (route to `admin-playbooks`).

Only suggest steps the tools can actually deliver; if a suggestion would hit a
`gap`/`unknown` route, don't offer it.

## When NOT to fire

- **First turn / no prior context** → `using-sf-intelligence` + `answering-org-questions`.
- **The follow-up names a fresh component explicitly** → just answer it; no
  pronoun resolution needed.
- **The user contradicts the carried context** ("no, I meant the Lead field") →
  drop the carried binding and re-resolve to what they now mean.

## Verification

- [ ] I bound every pronoun / "the other one" to a specific carried id (or asked
      when there was nothing to bind to) — and I stated what it bound to.
- [ ] For "same thing on X" I reused the prior tool/plane against the new target.
- [ ] I stated confidence per claim (sure vs spot-check vs live), not once.
- [ ] I offered only next steps the tools can actually answer.
- [ ] A topic change reset focus instead of dragging stale context forward.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
