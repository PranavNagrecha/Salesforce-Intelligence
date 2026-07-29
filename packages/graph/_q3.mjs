import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(process.argv[2], {access_mode:'READ_ONLY'});
const c = await db.connect();
const r = await c.runAndReadAll("SELECT type, COUNT(*)::INT n FROM nodes GROUP BY 1 ORDER BY 1");
console.log(JSON.stringify(r.getRowObjectsJS()));
