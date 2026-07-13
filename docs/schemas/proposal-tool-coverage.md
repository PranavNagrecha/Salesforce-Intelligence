# Finding #35 — `format: 'proposal'` tool coverage

**Status: ALREADY-DONE** (R7-DIFF-01-FOLLOWUP verify, tip of this branch).

Verified against advertised MCP input schemas in `packages/mcp/src/tools/index.ts`
plus implementations/tests under `packages/mcp/src/tools/` and
`packages/mcp/test/tools/`.

| Tool | `format: 'proposal'` | Artifact |
| --- | --- | --- |
| `sfi.safe_to_delete_field` | Present (`json` \| `checklist` \| `proposal`) | LOCAL `destructiveChanges.xml` + empty `package.xml` |
| `sfi.unused_fields_deep` | Present (`json` \| `csv` \| `cleanup` \| `proposal`) | LOCAL destructive bundle for high-confidence unused fields on the page |
| `sfi.what_if_merge_profiles` | Present (`json` \| `proposal`) | LOCAL `package.xml` pulling both profiles |
| `sfi.permission_risk_report` | **Not present — intentional** | Decision-record **NO BUILD**: report-only; no deployable proposal shape |

Payload shape: [`proposal.schema.json`](./proposal.schema.json).
No code change required for R7-DIFF-01-FOLLOWUP.
