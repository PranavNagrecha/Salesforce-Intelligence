# `format: 'proposal'` tool coverage

Which tools can emit a deploy-ready proposal bundle: a local `package.xml` /
`destructiveChanges.xml` for your own deploy tool, never a deploy. Verified
against the MCP input schemas under `packages/mcp/src/tools/`
plus implementations/tests under `packages/mcp/src/tools/` and
`packages/mcp/test/tools/`.

| Tool | `format: 'proposal'` | Artifact |
| --- | --- | --- |
| `sfi.safe_to_delete_field` | Present (`json` \| `checklist` \| `proposal`) | LOCAL `destructiveChanges.xml` + empty `package.xml` |
| `sfi.unused_fields_deep` | Present (`json` \| `csv` \| `cleanup` \| `proposal`) | LOCAL destructive bundle for high-confidence unused fields on the page |
| `sfi.what_if_merge_profiles` | Present (`json` \| `proposal`) | LOCAL `package.xml` pulling both profiles |
| `sfi.permission_risk_report` | **Not present — intentional** | Decision-record **NO BUILD**: report-only; no deployable proposal shape |

Payload shape: [`proposal.schema.json`](./proposal.schema.json).
