# Access-Surface Regression Test Harness

## Overview

The **access-surface regression fixture** (`eval/access-surface.cases.json`) documents the deterministic routing behavior of `classifyQuestion()` from `packages/mcp/src/intent-router.ts` across 37 test cases covering the access-control and permission-modeling routing surface.

The **test harness** (`packages/mcp/test/access-surface.test.ts`) loads this fixture, invokes the router on each case, and asserts that the actual result matches the recorded ground truth.

## Fixture Structure

The fixture is a JSON document with:

- **`_about`**: Commentary on the fixture's purpose, versioning, and synthetic nature (no real org identifiers)
- **`cases`**: An array of test cases, each with:
  - `id`: Unique case identifier (e.g., `field-access-canonical`)
  - `query`: The plain-language question to classify
  - `expect`: Routing outcome type (`'routes'` or `'unrouted-gap'`)
    - `'routes'`: The query successfully routes to a concrete intent
    - `'unrouted-gap'`: The query deliberately falls through; documents a known phrasing gap
  - `intent`: The classified intent name (e.g., `field-access`, `unrouted`)
  - `plane`: The answering plane (`vault`, `live`, `hybrid`, `unknown`)
  - `tools`: Ordered list of `sfi.*` tool names (empty for unrouted cases)
  - `gap`: The gap category if this case documents an honest capability boundary (`null` for regular routes)
  - `note`: Human context (why this case matters, what boundary it pins)

### Case Types

**Regular routed cases** have:
- `expect: 'routes'`, `gap: null`
- Assert the router lands on the right intent, plane, and tools

**Honest-gap cases** have:
- `expect: 'routes'`, `gap: '<category>'`
- Assert the router routes to a dedicated capability-gap intent (e.g., `unassigned-permset-groups`) that documents what is not modeled
- Must NOT fall through to `unrouted` or a confident-wrong tool

**Unrouted-gap cases** have:
- `expect: 'unrouted-gap'`, `gap: '<category>'`
- Assert the query falls through to the `unrouted` catch-all
- Documents a grammatical-direction or phrasing gap the current regex set does not yet cover

## How the Harness Works

### Load & Parse

The harness loads `eval/access-surface.cases.json` at test time. File-not-found errors are fatal.

### Assert Each Case

For each case:

1. **Invoke the router**: `classifyQuestion(query)` from the compiled MCP dist
2. **Extract actual results**:
   - `intent`: The routed intent name
   - `plane`: The answering plane
   - `gap`: The gap category (or `null` if no gap)
3. **Compare against expected**:
   - Intent must match exactly
   - Plane must match exactly
   - Gap value must match exactly (including `null`)
4. **Report failures** with the case ID, query, mismatches, and the case note

### Individual Tests

- One test per case: `case: {id} — {query}`
- Each failure includes the note, so context is preserved
- Failures halt the suite (fail-fast on first mismatch)

### Summary Test

An `all cases pass` test ensures no cases were silently skipped and provides aggregate diagnostics.

## Running the Harness

### Full MCP test suite

```bash
pnpm -C packages/mcp test
```

The `access-surface.test.ts` runs as part of the standard gate.

### Harness only

```bash
pnpm -C packages/mcp test -- access-surface.test.ts
```

### With Vitest watch mode

```bash
pnpm -C packages/mcp test -- --watch access-surface.test.ts
```

## Updating the Fixture

When router behavior changes intentionally:

1. Run the harness; it will report the mismatch
2. Verify the new behavior is correct (test manually with `classifyQuestion()` or `sfi.route_question`)
3. Update the fixture case(s) in `eval/access-surface.cases.json` to match the new ground truth:
   - Update `intent`, `plane`, `tools`, `gap` fields
   - Keep the case `id`, `query`, `note`, and `expect` (unless the routing outcome type changes)
   - Commit the fixture update in the same PR as the router change

### Honest-Gap Cases

If a gap is filled (a new route is added for a phrasing the harness marked as `unrouted-gap`):

1. Change `expect: 'unrouted-gap'` → `expect: 'routes'`
2. Set `gap: null`
3. Update `intent`, `plane`, `tools` to the new route
4. Update the `note` to reflect the change (e.g., "FIXED: now routes to X tool")

### Confirming Coverage

After updating, re-run:

```bash
pnpm -C packages/mcp test -- access-surface.test.ts
```

All 37 cases must pass.

## Design Principles

1. **No real org identifiers**: Every case name and field is synthetic (System Administrator, Salary, Payment, Account, CreateApprovalProcess)
2. **Deterministic**: The router is rule-based and testable; no LLM guessing
3. **Honest about gaps**: Cases document known limitations (unrouted phrasings, unmodeled capabilities) so they are visible to product planning, not silently unrouted
4. **Regression net**: The fixture is a contract between the router's current behavior and future changes — if a case flips unintentionally, the test catches it
5. **Self-documenting**: Each case's `note` explains the boundary it pins and why it matters

## Troubleshooting

### Fixture load fails

- Check `eval/access-surface.cases.json` exists and is valid JSON
- Ensure the file path resolve is correct (test runs from `packages/mcp/test/`)

### Harness fails on an existing case

- The router has changed (likely unintentionally)
- Check `packages/mcp/src/intent-router.ts` for recent regex or rule changes
- If the change is intentional, update the fixture; if unintentional, revert the router change

### New cases needed?

- Describe the boundary or phrasing gap
- Add the case to `eval/access-surface.cases.json`
- Run the harness; it will report what the router currently does
- Update the case's `expect`, `intent`, `plane`, `tools`, `gap` fields to match
- Commit with a note explaining the new boundary
