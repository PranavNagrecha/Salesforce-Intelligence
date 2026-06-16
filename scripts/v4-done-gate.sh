#!/usr/bin/env bash
# PLAN-v4.0 section 6 — done gate. Run from sf-intelligence/ root.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== v4.0 done gate ==="
pnpm -r build
pnpm lint
pnpm -r test
pnpm test:integration:gate
pnpm e2e
pnpm eval:build-ci-vault
EVAL_STRICT=1 pnpm eval
EVAL_STRICT=1 pnpm eval:analytical
pnpm eval:scale
SCALE_IMPORT_BUDGET_MS="${SCALE_IMPORT_BUDGET_MS:-90000}" pnpm --filter @sf-intelligence/graph test test/scale-import.test.ts
SCALE_REFRESH_FIELD_COUNT="${SCALE_REFRESH_FIELD_COUNT:-1000}" SCALE_REFRESH_BUDGET_MS="${SCALE_REFRESH_BUDGET_MS:-600000}" pnpm --filter @sf-intelligence/cli test test/scale-refresh.test.ts
pnpm guard
echo "=== v4.0 done gate: PASS ==="
