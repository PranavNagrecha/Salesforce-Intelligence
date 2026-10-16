# ADR-010: A 16-tool default profile and the `sfi.run_analysis` gateway

## Status
Accepted

## Date
2026-10-15 (shipped in 0.5.0; recorded with the 0.6.0 docs audit)

## Context
By 0.4.0 the server registered more than two hundred tools and advertised a
25-tool default profile whose centre was a pair of router tools:
`sfi.route_question` returned a shortlist for a question and
`sfi.synthesize_answer` folded tool output into prose. Hosts were taught to
call the router first on every question. Three problems showed up on real use
and in the 2026-10 product-gap review:

1. **Host context.** Every advertised tool costs schema bytes in the host's
   context on every turn. The full roster (226 non-hidden schemas) costs tens
   of thousands of tokens in clients that do not defer tool definitions, and
   even the 25-tool profile spent most of its budget on machinery (routing,
   synthesis, self-description) rather than on answers.
2. **Routing is the host model's job.** The deterministic router is a lookup
   table that puts the right tool first about six times in ten on fresh
   phrasing (see [routing.md](../routing.md) § 13). A host model with good
   tool descriptions routes at least as well, in one hop, without a server
   round trip. Growing the regex router was measured and refused twice.
3. **The questions that matter were not directly callable.** The two verdict
   defects found on a real org in the honest evaluation (a dead-code false
   positive, a missed where-used reference) were in tools that the default
   profile hid behind the router, while the profile advertised tools that
   answer no end-user question.

The product's package page advertises a handful of questions. The default
surface should be exactly the tools that answer them, plus the minimum spine
needed to resolve names, fetch a component and reach everything else.

## Decision
1. **The default profile (`core`) advertises 16 tools.** The spine:
   `sfi.resolve`, `sfi.search_components`, `sfi.get_component`,
   `sfi.health_check`, `sfi.list_analyses`, `sfi.describe_analysis`,
   `sfi.run_analysis`, `sfi.live_consent`. The question tools:
   `sfi.find_component_usages`, `sfi.safe_to_delete_field`,
   `sfi.what_happens_on_save`, `sfi.find_dead_code`,
   `sfi.why_cant_user_see_record`, `sfi.effective_permissions`,
   `sfi.flow_graph`, `sfi.org_overview`. The question half is **derived** from
   the list of advertised questions (`ADVERTISED_QUESTION_TOOLS` in
   `packages/mcp/src/tools/tool-profile.ts`): adding a question to the
   package page adds its tool to the default, and a question with no tool
   behind it fails the build.
2. **Every other analysis runs through the gateway.**
   `sfi.run_analysis { name: 'sfi.<tool>', args }` dispatches to the same
   handler with the same validation and returns byte-identical output.
   `sfi.list_analyses` renders every tool's one-line summary;
   `sfi.describe_analysis { name, detail }` returns a tool's full contract on
   demand. The gateway re-uses the existing dispatch, so the byte budget
   ([ADR-005](./ADR-005-mcp-response-byte-budget.md)), the envelope
   ([ADR-007](./ADR-007-canonical-response-envelope.md)) and the scope
   contract ([ADR-009](./ADR-009-selector-scope-honesty.md)) apply unchanged.
3. **A direct call to a non-core tool under `core` fails closed** with an
   error that names the fix (`Tool 'sfi.X' is not directly invokable under
   SFI_TOOL_PROFILE=core. Call sfi.run_analysis { name: 'sfi.X', args } …`).
   It never silently answers from a lookalike tool.
4. **`SFI_TOOL_PROFILE=full` advertises the whole roster.** The profile is
   fixed at server boot because clients fetch `tools/list` once.
5. **Routing stays in the host.** The product improves routing by improving
   the LLM-facing surface: short tool descriptions that carry the question
   they answer, the `answers` one-liner on every catalog row and shortlist
   row, argument aliases, and errors that say what to do. The deterministic
   router (`intent-router.ts`) is advisory and is not grown.
6. **The roster is derived, never hand-mirrored.** `eval/product-manifest.json`
   carries `tools.profiles.core`; the docs gate pins every hand-written core
   count to it, and the skill-gateway check fails on any skill or doc that
   instructs a direct call to a non-core tool.

## Alternatives Considered

### Keep advertising the full roster
- Pros: every tool is one hop away; no gateway to learn.
- Cons: the context cost in real hosts, and a 226-schema list that the host
  model routes over worse than a 16-schema one. Rejected; it remains
  available as `SFI_TOOL_PROFILE=full`.

### Keep the 25-tool profile with the router tools in it
- Pros: no change for hosts that followed the old instructions.
- Cons: two hops (`route_question`, then the tool) before any answer; the
  router is a lookup table; and the tools that answer the advertised
  questions stayed hidden. Rejected.

### Hide everything behind `run_analysis`, advertise only the spine
- Pros: the smallest possible list.
- Cons: the eight advertised questions deserve a one-hop answer, and tool
  descriptions are how the host routes; a question with no description in
  context is routed blind. Rejected.

### Per-host dynamic tool lists
- Pros: each host could see what it needs.
- Cons: MCP clients fetch `tools/list` once at connect; there is no
  dependable re-advertise. Rejected; the profile is a boot-time choice.

## Consequences
- Every instruction aimed at a host or an agent (skills, commands, docs, the
  end-user prompt) names core tools or says "through `sfi.run_analysis`".
  The skill-gateway checker enforces it, and a release that teaches a direct
  call to a hidden tool fails the gate.
- Tool descriptions are the routing surface, so they are short, lead with
  the question they answer, and the long form moves to
  `sfi.describe_analysis { detail: 'full' }`.
- Hosts that pre-date 0.5.0 and call hidden tools directly get the named
  error, not a wrong answer; the fix is in
  [guides/upgrading.md](../guides/upgrading.md).
- Scripts are unaffected: `sfi run <tool>` runs any tool.
- No tool is deleted by this decision. Shrinking the default surface and
  routing through one gateway is what makes the next tool cheap to add and
  hard to teach wrongly.
