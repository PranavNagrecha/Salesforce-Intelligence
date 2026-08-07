### Changed

- **Retrieval ledger + family epochs (AUDIT-F5).** Coverage rows carry per-family
  `retrievedAt` / `epoch` (preserved across scoped `--types` refreshes). Refresh
  writes `meta/retrieval-ledger.json` and appends `meta/tombstones.jsonl` for
  confirmed reconcile deletions (never on refuse). `TrustSummary.freshness`
  can disclose `overall: 'mixed'` with `families` / `oldestEvidenceAt`.
  `sfi.coverage_report` surfaces tombstones + mixed-freshness limitations.
