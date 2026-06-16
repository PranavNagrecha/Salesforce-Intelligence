# Architecture Decision Records

Load-bearing decisions a maintainer must understand before changing the
codebase. Each ADR captures the *why* — the context, the alternatives, and the
consequences — for a decision that would be expensive to reverse.

These records are descriptive of decisions already in force (recorded
retroactively during Phase-10 hardening), not proposals. Don't delete an ADR;
when a decision changes, write a new one that supersedes it
(see `documentation-and-adrs`).

| ADR | Decision | Touches |
| --- | --- | --- |
| [ADR-001](./ADR-001-confidence-tagged-edges.md) | Every graph edge carries a confidence tier (`declared \| parsed \| heuristic`) | `contracts`, every extractor, the trust surface |
| [ADR-002](./ADR-002-offline-vault-live-plane-boundary.md) | Offline-first vault with an opt-in, fail-closed read-only live plane | `mcp/live-consent`, `mcp/tools/live-plane`, `CLAUDE.md` |
| [ADR-003](./ADR-003-graph-edge-contract.md) | A closed, confidence-tagged edge union with `targetMissing` dangling refs | `contracts` `EdgeType`/`EDGE_TYPES`, `graph/import` |
| [ADR-004](./ADR-004-phantom-taxonomy-on-demand.md) | Classify phantoms into a six-bucket taxonomy, computed on demand | `graph/phantom-classify`, `reference_stub`, demand-retrieve |
| [ADR-005](./ADR-005-mcp-response-byte-budget.md) | A global MCP response byte budget with per-family sub-budgets | `mcp/tools/index` `jsonResult`, graph/SOE payload bounds |
| [ADR-006](./ADR-006-read-only-graph-access.md) | Query consumers open the DuckDB graph in READ-ONLY mode | `graph/store` `openGraphReadOnly`, the MCP server |
| [ADR-007](./ADR-007-canonical-response-envelope.md) | Canonical `{data, vaultState}` envelope + `componentId` id key; additive, gate-guarded | `mcp/tools/index`, `mcp/response-consistency`, `check-response-consistency` |

## Relationships

ADR-001 (confidence tiers) is the root of the trust posture; ADR-003 (edge
contract) and ADR-004 (phantom taxonomy) build on it. ADR-002 (offline/live
boundary) and ADR-006 (read-only access) together make the product non-mutating
by design. ADR-005 (byte budget) is independent but cross-references the graph
budgets that ADR-003's tools emit.
