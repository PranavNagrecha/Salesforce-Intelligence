---
name: salesforce-org-context
description: |
  Silent pre-loader for the SfIntelligence vault. Fires automatically
  when the user's message mentions any Salesforce concept — words like
  "object", "field", "trigger", "flow", "validation rule", "permission
  set", "profile", "layout", "Apex", "picklist", "lookup", "record
  type", "metadata", "org", "sandbox"; common object names like
  Account, Contact, Opportunity, Lead, Case, User; or the custom-suffix
  patterns `__c`, `__mdt`, `__e`, `__b`, `__r`, `__x`. Calls
  `sfi.org_card` (the refresh-time orientation card; falls back to
  `sfi.get_manifest` + `sfi.list_components(type: 'CustomObject')` on a
  vault without a card) to warm the cache so the next question answers
  faster. Does not print
  to the user; produces no visible output. Skips when the user invokes
  `/sfi-init`, `/sfi-refresh`, or `/sfi-status`, when the message is
  off-topic, or when context is already loaded this session.
---

# Salesforce org context

## Overview

This skill is a **silent context pre-loader**. It fires on Salesforce
vocabulary in user input — before the user has even finished framing
their question — runs ONE cheap MCP call (`sfi.org_card`, the
refresh-time orientation card) and holds the result in Claude's working
memory. When the user's actual question arrives ("what fields does
`Account` have?"), identity/freshness, scale, coverage and blind spots,
the org's top objects, and the how-to-ask rules are already cached, so
the answering skill spends fewer turns discovering vault state.

The skill produces **no user-visible output**. It is not a response;
it is a context warm-up. The answer to the user's question comes from
`answering-org-questions` (or whichever skill the question's intent
matches). This skill's job is to load, not to speak.

## When to fire

Fire on **any of the following signals** in the user's message:

- **Salesforce nouns:** object, field, trigger, flow, validation rule,
  permission set, profile, layout, Apex (class/trigger), picklist,
  lookup, master-detail, record type, metadata, sandbox, scratch org,
  managed package, SOQL, SOSL, formula, workflow, process builder.
- **Common standard object names used structurally:** `Account`,
  `Contact`, `Opportunity`, `Lead`, `Case`, `User`, `Task`, `Event`,
  `Campaign`, `Asset`, `Order`, `Product`, `Quote`, `Contract`. ("John
  from Accounting" is not a trigger; "fields on `Account`" is.)
- **Custom-suffix patterns** anywhere in the message: `*__c` (custom
  object/field), `*__mdt` (custom metadata type), `*__e` (platform
  event), `*__b` (big object), `*__r` (relationship), `*__x` (external
  object).
- **Vault references:** `org-kb/`, "the manifest", "the vault", "the
  index", "the graph".

When multiple triggers appear in one message, still fire once.

## When NOT to fire

- **Explicit slash command for another skill.** `/sfi-init`,
  `/sfi-refresh`, `/sfi-status` have their own skills with their own
  pre-flight steps. Don't double-load context they'll re-derive.
- **The user's message is off-topic.** "What's the weather?", "help
  me write a Python script" — no Salesforce vocabulary, no fire.
- **Context is already loaded this session.** This skill is a one-time
  warm-up per session. If `sfi.org_card` (or `sfi.get_manifest`) has
  already returned a successful result in this conversation, do not
  re-call. The card is the same; the object list is the same.
- **The user is asking a generic Salesforce question with no reference
  to *their* org.** "What is a permission set?" — no fire. "What
  permission sets do we have?" — fire.
- **The vault doesn't exist.** If a previous tool call returned
  `vaultExists: false` (or `not-found` for missing `manifest.json`),
  the user needs `/sfi-init` first. Don't fire repeatedly into a
  missing vault; surface the gap once via the entry skill and stop.

## What to load

ONE call. Hold the result in context.

1. **`sfi.org_card` with `{}`.** The refresh-time orientation card — a
   single cheap cache read that supersedes the old two-call warm-up:
   identity & freshness (`refreshedAt`, `sourceTreeHash`), per-type
   scale counts, coverage and blind spots, the org's top objects by
   inbound dependencies, automation density, permissions posture,
   integration surface, naming conventions, and the how-to-ask rules.

**Fallback (older vault):** when `org_card` returns `available: false`
(the vault predates the card-rendering refresh), fall back to the
previous warm-up — `sfi.get_manifest` with `{}` then
`sfi.list_components` with `{ type: 'CustomObject' }` — and mention
`/sfi-refresh` will generate the card next time. Do not pre-load other
types; the answering skill fetches them on demand.

**Do not** call `sfi.health_check` here — `using-sf-intelligence` runs
it at the start of any org-touching session. Re-running it is redundant.

## Silent loading discipline

This skill produces **no visible output**. Concretely:

- Do not print the manifest. The user didn't ask for it.
- Do not summarize the object list. The user didn't ask for it.
- Do not mention that you pre-loaded anything. Mentioning the warm-up
  defeats the warm-up — the user came for an answer, not a status
  update.
- Do not block the user's question on the pre-load. If the loads fail,
  proceed to the answering skill anyway; that skill will surface the
  failure cleanly. The warm-up is best-effort.

The only acceptable visible signal from this skill firing is **silence**.
If the user's next message asks "what fields does Account have?", the
visible work is the answer to that question, not the metadata of how
you got there.

## When already loaded

This skill is **session-scoped** — fire once per session. After the
two calls succeeded:

- Do not re-fire on subsequent Salesforce vocabulary in the same
  session. Do not re-call `get_manifest` to "refresh" the in-memory
  copy. The cache is stable until something genuinely changes it.
- If the conversation pivots away and returns to Salesforce
  vocabulary later, still don't re-fire. The vault hasn't changed.

The exception: after the user runs `/sfi-refresh` or `/sfi-init`
mid-session, the vault genuinely changed. The **next**
Salesforce-vocabulary message may re-fire this skill.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'll print a quick 'context loaded' note so the user knows I'm ready." | No. The warm-up is invisible by design. Telling the user about it is noise. The answer to their next question is the only visible signal. |
| "I'll pre-load every type, not just CustomObject, to be thorough." | One call is the warm-up budget. `CustomObject` covers ~80% of follow-up questions. Other types load on demand from the answering skill. |
| "The user might ask about Apex, so I'll pre-grep the Apex source too." | `sfi.search_apex_source` is not cheap and not always needed. Don't pre-grep. Wait for the question to specify what to grep for. |
| "The user typed `/sfi-status`; I'll fire too because they mentioned the vault." | `pre-flight-checks` is the skill for that. It calls `get_manifest` itself as Probe 2. Double-firing is redundant. |
| "The user only mentioned 'object' in passing; that's not really a Salesforce question." | The skill is supposed to be aggressive about firing on vocabulary. False positives are cheap (two MCP calls); false negatives cost the user a slower next turn. Err toward firing. |
| "I'll fire even when there's no Salesforce vocabulary, just in case." | No. Without vocabulary, the user is on a different topic. Firing wastes the warm-up on context that won't be used. |
| "`get_manifest` failed; I'll show the user the error." | This skill is silent. Forward the failure to the next skill that runs (almost certainly `using-sf-intelligence` or `pre-flight-checks`); they have the right surface for error reporting. |

## Red flags

- **Both calls fail.** The MCP server is probably down. Don't keep
  trying from this skill — let the next user-visible skill surface the
  failure via `pre-flight-checks`.
- **`sfi.list_components` returns `invalid-query`.** Implementation
  bug here, not a user problem. Silently log; move on.
- **The user's message has Salesforce vocabulary but is plainly
  asking a question this product can't answer** (live data, Apex
  semantics, record counts). Still fire — the warm-up doesn't hurt,
  and the answering skill will explain the v0.1 boundary. But do not
  expand the pre-load to try to compensate.
- **You catch yourself wanting to add a third call** ("let me also
  pre-load CustomField..."). Stop. The whole-vault warm-up is a v0.2
  concern. v0.1's budget is two calls.
- **The user invoked a slash command and you fired anyway.** Roll
  back: the slash command's skill is the right entry; this pre-loader
  shouldn't be running in parallel.

## Verification

Before considering this skill's work complete (i.e., before yielding
to the next skill in the chain), confirm:

- [ ] I detected a Salesforce vocabulary trigger in the user's message
      (a noun, an object name, a `__c`/`__mdt`/`__e`/`__b` suffix, or
      a vault reference) — not just adjacent topic.
- [ ] I did not fire because the user invoked `/sfi-init`,
      `/sfi-refresh`, or `/sfi-status`.
- [ ] I did not fire because context was already loaded earlier in
      this session.
- [ ] I called exactly `sfi.get_manifest` and
      `sfi.list_components(type: 'CustomObject')` — in that order, no
      additional calls.
- [ ] I produced no user-visible output from this skill firing. No
      "context loaded" note. No manifest summary. Silence.
- [ ] If a call failed, I yielded to the next skill rather than
      retrying or surfacing the error from inside this one.
- [ ] I am ready to yield to the next skill (almost always
      `using-sf-intelligence` or `answering-org-questions`) with the
      pre-loaded context warm in memory.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — it returns the answering plane and the ordered `sfi.*` tools to run (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
