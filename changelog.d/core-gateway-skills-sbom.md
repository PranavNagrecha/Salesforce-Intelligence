### Changed

- **Skills / agents / commands under default `SFI_TOOL_PROFILE=core`** now
  instruct hosts to invoke non-core analyses through `sfi.run_analysis`
  `{ name, args }` (Decision 2=C). Shared grounding footer + entry skill teach
  the gateway; `pnpm skill-gateway` fails CI on direct non-core Call/Fire
  instructions. Website, `llms.txt`, and `.claude-plugin/plugin.json` match
  (pinned `sf-intelligence@0.2.5`; core is the default, not full).
- **SBOM** generation uses `@cyclonedx/cdxgen` via `pnpm sbom` (pnpm-aware,
  fail-closed). Tag publish attaches a non-empty CycloneDX 1.5 artifact or
  fails the job — no more empty `npm sbom` skip.
