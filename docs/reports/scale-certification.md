# Scale certification — 50,000 components

**Purpose.** Answer the due-diligence question "does it scale to a large enterprise
org?" with a measured number, not a guess. The graph engine is certified here at
**50,000 components** — 5× the 10,000-component regression gate that runs in CI
(`packages/graph/test/scale-import.test.ts`).

Measured **2026-06-25** on a developer laptop (Apple Silicon, Node 20). Synthetic
data only (no real org). Re-run any time: `pnpm eval:scale:cert`
(or `SCALE_CERT_COUNT=100000 node eval/scale-cert.mjs` for a different size).

## Result

| Operation | Workload | Measured | Budget | Verdict |
| --- | --- | --- | --- | --- |
| **Graph import** | 50,000 components (1,000 objects × ~50 fields) | **40.5 s** | 420 s | ✅ well under |
| **Resolve** (typo-tolerant front door) | 4 queries over the 50k graph | **293 ms** (~73 ms/query) | 5,000 ms | ✅ well under |

Import is roughly linear with component count (10k ≈ 8 s, 50k ≈ 40 s here); DuckDB
batched inserts keep it sub-budget. Resolve latency stays low at scale because the
front door queries the indexed graph, not a linear scan.

## Method

`eval/scale-cert.mjs` generates a synthetic org (objects + fields), imports it into a
throwaway DuckDB graph via the real `importExtractionResults`, then runs
`resolveComponents` against it — the same engine code the product ships. No fixtures,
no network, no real org.

## What this means for real orgs

- **The graph is not the bottleneck at enterprise scale.** 50k components import in
  well under a minute and resolve in tens of milliseconds.
- **The practical limit on very large orgs is the upstream `sf project retrieve` +
  extraction**, not the graph. A full retrieve of a 100k+ component org can be slow or
  hit Metadata API limits — which is exactly what the **scoped-refresh policy** is for:
  `sfi refresh --types CustomObject,CustomField,ApexClass,...` builds a focused vault for
  the domains you care about, and multiple scoped vaults can be registered and compared.
- **Recommended guidance:** orgs up to ~50k modeled components are comfortable in a
  single vault. Beyond that, scope the refresh by metadata type (or by domain) rather
  than pulling everything at once.

## Relationship to the CI gate

The 10k import budget (`SCALE_IMPORT_BUDGET_MS`, 90 s) is the **regression floor** that
runs on every CI build — it guards against a perf regression. This 50k certification is
the **proven headroom** above that floor, run on demand (it's heavier than a CI gate
should be). The two are complementary: CI proves we didn't regress; this proves we scale.
