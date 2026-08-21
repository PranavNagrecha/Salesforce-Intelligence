# ADR-004: Classify phantoms into an eight-bucket taxonomy, computed on demand

## Status
Accepted

## Date
2026-06-07 (retroactively recording the P7 reference-stub / GATE-0 decision)

## Context
ADR-003 leaves dangling edges (`targetMissing`) — references to ids with no node.
A real org has tens of thousands of them, and they are not all the same thing.
The phantom-taxonomy audit (`docs/reports/phantom-taxonomy-audit.md`, GATE-0)
measured the population on real orgs and found wildly different causes:
50,415 / 63,136 phantom grants were pure permission references, hundreds of
automation references pointed at genuinely-missing components, and many were just
standard or managed-package members that will never be in a DX retrieve.

Two naive responses both fail:

- **Retrieve-all** the phantoms: the audit showed this would bloat the vault with
  700+ objects and tens of thousands of grant-only references nobody asked about.
- **Ignore them all**: hides the *automation-critical* minority that is exactly
  what an impact analysis needs.

So phantoms must be *classified*, and the classification must distinguish "go get
this" from "stub it forever".

## Decision
Classify each phantom into one of eight mutually-exclusive buckets
(`PhantomClassification` in contracts), from its id shape, its inbound edge
kinds, and its ComponentType's manifest coverage:

- `automation-critical` — automation/code references it → a demand-retrieve
  candidate.
- `blindspot-manifest` — its whole ComponentType was never retrieved → widen the
  manifest.
- `managed-extension` — managed-package (namespaced) member → stub forever.
- `standard-field-phantom` — a standard object or a field on one → stub forever.
- `grant-only` — only permission grants reference it → stub forever.
- `unresolved-profile-id` — an `UnresolvedProfile:{id}`: a Profile *Id* a
  RestrictionRule / DuplicateRule referenced that the vault could not resolve to
  an api name. Remedy is an Id→apiName index or live Tooling, **never** a wider
  retrieve manifest.
- `change-event-stream` — a Change Data Capture entity
  (`CustomObject:AccountChangeEvent`, `CustomObject:Order__ChangeEvent`). The
  platform synthesises it from its parent object's CDC configuration and the
  Metadata API emits no component for it on ANY org, so the absence is
  STRUCTURAL, not a coverage gap: no `sfi refresh` and no wider manifest can
  populate it. Added because the coverage/edge-shape buckets each handed it a
  remedy that cannot work — `standard-field-phantom` ("treat it as standard") for
  the standard form, `automation-critical` (demand-retrievable) for the custom
  form on an automation edge — and the latter made the B29 auto-expansion
  re-request the same entity on every refresh, forever, with no terminating
  condition.
- `unknown` — referenced, but neither by automation nor a pure grant.

**Where each bucket is produced.** Seven of the eight come from the shared
`classifyPhantom` in `graph/phantom-classify.ts` (`change-event-stream` is an
id-shape short-circuit, but it lives IN the shared classifier so the refresh
roll-up and `get_component` agree — the choice the paragraph below asks any
bucket-adder to make). The eighth, `unresolved-profile-id`, is an id-shape
short-circuit that runs BEFORE `classifyPhantom` — it lives in
`mcp/tools/phantom-taxonomy.ts`, not in the shared classifier. Consequence, recorded here rather than hidden: the
refresh-time roll-up `computePhantomBucketSummary` calls `classifyPhantom`
directly and therefore CANNOT emit an `unresolved-profile-id` bucket (it CAN
emit `change-event-stream`, which is why that one was put in the shared
classifier). The same
`UnresolvedProfile:` id is reported as `unresolved-profile-id` by
`get_component` and lands in a different bucket in the refresh summary. Anyone
adding a bucket must decide which of the two surfaces it belongs to, or move the
short-circuit down into the shared classifier.

Compute this **on demand** (`graph/phantom-classify.ts`), shared by the MCP layer
(`reference_stub` on `get_component`) and the CLI (`refresh --components`
demand-retrieve gate). **Do not materialise stub nodes into the graph.** A
materialised stub would make its dangling edges resolve, which would break the
`targetMissing` / blindspot / taxonomy semantics that depend on those edges
staying dangling. A `ReferenceStub` (`tier: 'stub'`) is surfaced in
`McpError.stub` when a lookup hits a phantom, giving the consumer a classified
stub + remedy instead of a bare not-found.

A *functional* reference (the signal for `automation-critical`) excludes
`grantedBy` and `usedInLayout` — permission grants and layout decoration are
access, not usage (`NON_FUNCTIONAL_EDGE_KINDS`).

## Alternatives Considered

### Retrieve every phantom on refresh
- Rejected by the GATE-0 data: 700+ object bloat, 50k+ grant-only noise.

### Materialise stub nodes in the graph
- Pros: every edge resolves; simpler reads.
- Cons: destroys the dangling-edge semantics the taxonomy and blindspot reports
  are built on. Rejected — classify on demand instead.

### A single "phantom" flag (no buckets)
- Cons: cannot separate the demand-retrieve minority from the stub-forever
  majority, which is the entire point. Rejected.

## Consequences
- `retrieve_blindspot_report` / `demand-retrieve` act only on the actionable
  buckets, never on stub-forever ones.
- Classification logic lives once in `@sf-intelligence/graph` (both CLI and MCP
  depend on it) so the two surfaces cannot disagree.
- The classifier is shape-sensitive: an early bug misbucketed a managed
  `hed__`-namespace object as a heuristic-local var (see FINDINGS A3-PAIR-BATTERY)
  — a reminder that id-shape rules need real-org fixtures.
