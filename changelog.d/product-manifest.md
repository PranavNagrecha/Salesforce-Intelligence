### Trust

- **Generated ProductManifest + drift gate.** Product capability facts (tool
  registered/advertised counts, core profile, live/local-mutation rosters, graph
  tables + schema version, Concept Model size + content hash, catalog hash) are
  now derived from runtime registries into `eval/product-manifest.json`.
  `sfi.capabilities` exposes the same facts as `productManifest`.
  `scripts/verify-doc-sync.mjs` fails CI when the committed manifest, website
  `site-data.json`, README/CLAUDE concept counts, or `docs/configuration.md`
  roster pins disagree with the registries — closing the 196/209 and 94/143 vs
  142/193 trust-contract drift class. Regenerate with
  `pnpm product-manifest` (or `node scripts/generate-product-manifest.mjs`).
