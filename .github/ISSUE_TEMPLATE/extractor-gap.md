---
name: Extractor gap
about: A metadata element that carries a reference but never becomes a graph edge
title: "extractor: <MetadataType> <element> never becomes an edge"
labels: good first issue, extractor
---

**Metadata type and element**
<!-- e.g. Flow `formulas[].expression` -->

**Where it is dropped today**
<!-- file:line in packages/extractors/src or packages/parsers/src, and what the code does instead (skips it, stores a property nobody reads, counts it) -->

**Edge to mint**
<!-- from `<Type>:<ApiName>` to `<Type>:<ApiName>`, edge type (readsFrom / writesTo / references / usedInLayout …), confidence (declared / parsed / heuristic) -->

**Rule for the unresolvable case**
<!-- what happens when the element cannot be resolved to a real component: record it on the node (e.g. `unresolvedX`) and mint nothing. Never build an id from a token that is not an api name. -->

**Verdict this corrects**
<!-- which tool answers wrongly today (find_component_usages, find_dead_code, safe_to_delete_field, unused_components, effective_permissions …) -->

**Fixture and test**
<!-- a synthetic file under packages/extractors/test using Acme_/Demo_ names, and the assertion -->

**Checklist**
- [ ] synthetic fixture (Demo_/Acme_ names only; no real org data)
- [ ] test fails before, passes after
- [ ] extractor JSDoc and `docs/` updated; `node scripts/verify-doc-sync.mjs` passes
- [ ] `changelog.d/<slug>.md` with a `### Fixed` bullet written for admins
- [ ] whole `extractors` and `graph` suites green, `pnpm lint` green
