### Changed

- `sfi.route_question` — every `toolCandidates` row now carries `answers`, the
  tool's one-line summary, and a populated `category`.

  The router's contract is "the funnel advises, the host LLM decides", but under
  the default `core` tool profile the host is advertised 19 of 207 tools. For the
  other 188 a candidate row named a tool whose description was nowhere in the
  host's context, recoverable only by an `sfi.describe_analysis` round trip per
  candidate. The host was being asked to choose between bare names.

  Measured over 50 questions, giving the host the one-liners moved top-1 tool
  choice from 39/50 to 42/50; of the six picks that changed, three became correct
  and **none** became wrong.

  Nothing about ranking changes: no score, no order, and no funnel input moves,
  so `router-recall` and `funnel-generalization` are unchanged at every K. The
  values reuse `oneLiner()` and `analysisCategory()` from `catalog-gateway.ts` —
  the same helpers `sfi.list_analyses` already renders — so there is one source of
  truth. Response cost is ~1.3 KB against the ~45 KB budget.

  Route-INSERTED rows previously hard-coded `category: null` even though the field
  was declared and documented; they now carry the coarse category as a fallback,
  while funnel-scored rows keep their more specific capability-map category.
