# ADR-006: Query consumers open the DuckDB graph in READ-ONLY mode

## Status
Accepted

## Date
2026-06-07 (retroactively recording the read-only-server lock model)

## Context
DuckDB is **single-writer**: one process holding a read-write handle on a
`.duckdb` file takes an exclusive lock, and any other open (read or write) fails
with a lock conflict. SfIntelligence has several processes that want to read the
same vault concurrently — the long-lived MCP server, the eval/QA harness, and
fleet read paths — while refresh is the only writer.

When the MCP server held a *read-write* handle (the early design), it locked the
vault for its whole lifetime. That caused real operational pain recorded across
the project: a refresh or the gate would fail with a DuckDB lock error unless the
server was killed first, the QA harness fought the server for the lock, and the
integration sweep deadlocked against a running server. The server has no reason
to write — it only answers questions.

## Decision
Query-only consumers open the graph through `openGraphReadOnly`
(`access_mode: 'READ_ONLY'`), which:

- never creates the file and never runs migrations (read-only connections cannot
  run DDL) — the vault must already exist;
- surfaces a missing/unreadable file as `open-failed` and a lock conflict as a
  distinct `locked` error with an actionable message;
- allows **multiple readers** to open the same vault concurrently.

This is the correct mode for the MCP server, the eval harness, and fleet reads.
The read-write path (`openGraph`, which creates + migrates) is reserved for
`refresh`, the sole writer. The MCP server is therefore read-only by design and
no longer needs a "pkill the server before the harness" dance.

## Alternatives Considered

### Single read-write server, kill-before-write
- Pros: one code path.
- Cons: the server's exclusive lock blocks refresh/gate/harness; the documented
  workaround was to kill the server first — fragile and easy to forget. Rejected.

### A connection pool / write queue serializing all access
- Pros: could allow writes from the server.
- Cons: large complexity for a capability (server-side writes) the product
  deliberately does not have (ADR-002: read-only by design). Rejected.

### Copy the vault per reader
- Pros: no lock contention.
- Cons: wasteful, and stale the instant refresh runs. Rejected — READ_ONLY
  already permits concurrent readers against the live file.

## Consequences
- The MCP server can run while a refresh or the gate runs against a *different*
  vault, and many readers share one vault — but a single *writer* (refresh) still
  needs exclusive access, so a stale `sfi mcp` must be killed before refreshing
  the **same** vault (a documented gotcha, not a bug).
- `locked` vs `open-failed` are distinct errors so callers can give the right
  remedy ("another process holds the lock" vs "the file is missing").
- Reinforces ADR-002: there is no write path back through the query handle.
