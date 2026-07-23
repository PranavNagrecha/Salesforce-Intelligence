### Fixed
- `sfi.call_graph` no longer emits an edge pointing at a node absent from its
  own `nodes` list. A `callsApex` edge whose target was tagged `targetMissing`
  at import (a heuristic phantom — e.g. the Apex scanner minting
  `ApexClass:{PascalCaseLocalVar}` from a `Map<Id,Foo> Foo = …` local that the
  local-declaration scanner, lowercase-initial only, never registered) was
  dropped from `nodes` by the node-resolve pass but left in `edges`, producing
  an edge-without-node. `call_graph` now honors `targetMissing` the way
  `getSubgraph` already does: phantom edges are skipped during the walk, and a
  final self-contained-slice filter guarantees every emitted edge has both
  endpoints in `nodes` (also dropping any `declared`/`parsed` dangler to an
  out-of-vault class). Genuine resolved cross-class call edges are unaffected.
