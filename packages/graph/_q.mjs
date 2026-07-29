import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(process.argv[2], {access_mode:'READ_ONLY'});
const c = await db.connect();
const q = async (sql)=>{const r= await c.runAndReadAll(sql); return r.getRowObjectsJS();};
const out = {};
out.total = await q("SELECT edge_type, COUNT(*)::INT n FROM edges GROUP BY 1 ORDER BY 1");
out.byFromType = await q(`SELECT e.edge_type, COALESCE(n.type,'<<DANGLING>>') ft, COUNT(*)::INT n
  FROM edges e LEFT JOIN nodes n ON n.id = e.from_id GROUP BY 1,2 ORDER BY 1,3 DESC`);
out.condNodes = await q("SELECT COUNT(*)::INT n FROM nodes WHERE type='ConditionalContext'");
out.waNodes = await q("SELECT COUNT(*)::INT n FROM nodes WHERE type='WorkflowAlert'");
console.log(JSON.stringify(out,null,1));
