import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(process.argv[2], {access_mode:'READ_ONLY'});
const c = await db.connect();
const q = async (sql)=>{const r= await c.runAndReadAll(sql); return r.getRowObjectsJS();};
console.log('TOTAL BY TYPE');
console.table(await q("SELECT edge_type, COUNT(*) n FROM edges GROUP BY 1 ORDER BY 1"));
