// Test fixture for P7-readonly-fleet-serving cross-process lock behavior.
//
// Opens the DuckDB vault at $DBP in $MODE ('RO' | 'RW') and HOLDS the handle
// (and thus the OS-level file lock) open until killed, printing 'READY' on
// stdout once the lock is held. It simulates, from a SEPARATE process, either a
// serving `sfi mcp` server (MODE=RO, shared lock) or a concurrent `sfi refresh`
// (MODE=RW, exclusive lock). DuckDB's single-writer lock only fires across
// processes, so the cross-process scenarios cannot be exercised in-process.
//
// Plain .mjs (not `*.test.ts`): it is spawned with `node`, must not be collected
// as a vitest test, and must not depend on the TypeScript build. It imports
// `@duckdb/node-api` directly, mirroring what `store.ts#openGraphReadOnly` does
// internally — which is why it must live inside the package tree (so Node
// resolves the dependency from `packages/graph/node_modules`).
import { DuckDBInstance } from '@duckdb/node-api';

const dbPath = process.env.DBP;
const mode = process.env.MODE ?? 'RO';
const instance =
  mode === 'RO'
    ? await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' })
    : await DuckDBInstance.create(dbPath);
await instance.connect();
process.stdout.write('READY\n');
// Hold the lock until the parent test sends SIGKILL.
setInterval(() => {}, 1 << 30);
