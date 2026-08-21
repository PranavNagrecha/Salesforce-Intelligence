### Fixed

- **Repeated boilerplate no longer pollutes the routing corpus.**
  `tool.description` serves two roles with opposite requirements: the
  host-facing CONTRACT wants exhaustive caveats repeated verbatim wherever they
  apply, while the funnel's RETRIEVAL DOCUMENT wants vocabulary that
  DISCRIMINATES between tools. Text identical across N tools is ideal for a
  reader and poison for retrieval — it depresses the document frequency of every
  term it contains for EVERY tool, including tools that never mention the
  subject. Nobody searches for a tool by its caveat.

  Two measured regressions, both caught by tests, now both stripped before
  indexing (and only before indexing — the advertised description a host reads
  is untouched, pinned by a guard test in both directions):

  - A declared-only permission WARNING on four tools broke FOUR routing tests,
    including `sfi.org_card` — a tool the change never touched.
  - A `conceptReasoning` block on four component-anchored tools displaced
    `sfi.interpret` from a top-5 recall assertion by **0.0010** of a score
    point. **Neither parent branch failed alone; only the merge did** — a branch
    gate structurally cannot observe a corpus interaction with a sibling it was
    never compiled against.

  A description carrying no boilerplate is returned byte-identical, so the pass
  cannot perturb a tool it does not target, and a bounded rule whose closing
  marker is missing leaves the text ALONE rather than truncating it — silently
  deleting real capability prose is worse than leaving boilerplate indexed.

### Known limitation

- This is the THIRD exception to "index the description" (`CORPUS_EXCLUDED`,
  whole-tool, was the first). Three exceptions is the design saying the
  description should not BE the corpus. The durable fix is a curated retrieval
  document per tool, decoupled from the advertised contract; `TOOL_KEYWORDS` is
  already a curated retrieval channel and shows the shape. Recorded, not built.
