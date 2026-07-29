import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(process.argv[2], {access_mode:'READ_ONLY'});
const c = await db.connect();
const q = async (sql)=>{const r= await c.runAndReadAll(sql); return r.getRowObjectsJS();};
const out = {};
out.overlap = await q(`
WITH cond AS (
  SELECT json_extract_string(properties_json,'$.firerId') firer, to_id, from_id
  FROM edges WHERE edge_type='readsFrom' AND from_id LIKE 'ConditionalContext:ValidationRule:%'
), refs AS (
  SELECT from_id firer, to_id, source FROM edges WHERE edge_type='references' AND from_id LIKE 'ValidationRule:%'
)
SELECT COUNT(*)::INT total,
       CAST(SUM(CASE WHEN r.firer IS NOT NULL THEN 1 ELSE 0 END) AS INT) AS matched
FROM cond c LEFT JOIN refs r ON r.firer=c.firer AND r.to_id=c.to_id`);
out.matchedBySource = await q(`
WITH cond AS (
  SELECT json_extract_string(properties_json,'$.firerId') firer, to_id FROM edges WHERE edge_type='readsFrom' AND from_id LIKE 'ConditionalContext:ValidationRule:%'
), refs AS (
  SELECT from_id firer, to_id, source FROM edges WHERE edge_type='references' AND from_id LIKE 'ValidationRule:%'
)
SELECT r.source, COUNT(*)::INT n FROM cond c JOIN refs r ON r.firer=c.firer AND r.to_id=c.to_id GROUP BY 1 ORDER BY 2 DESC`);
out.vrRefTotal = await q("SELECT source, COUNT(*)::INT n FROM edges WHERE edge_type='references' AND from_id LIKE 'ValidationRule:%' GROUP BY 1 ORDER BY 2 DESC");
out.concrete = await q(`SELECT from_id,to_id,edge_type,source FROM edges WHERE to_id='CustomField:Contact.Mailing_City__c' ORDER BY from_id LIMIT 40`);
out.condNodeExists = await q(`SELECT COUNT(*)::INT n FROM nodes WHERE id LIKE 'ConditionalContext:ValidationRule:%'`);
console.log(JSON.stringify(out,null,1));
