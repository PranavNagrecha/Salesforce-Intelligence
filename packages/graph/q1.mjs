import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create('/Users/pranavnagrecha/VS Code/Personal/Intelligence Layer/.wt-field-audit/org-kb/graph/graph.duckdb', {access_mode:'READ_ONLY'});
const c = await db.connect();
const J = (o)=>JSON.stringify(o,(k,v)=>typeof v==='bigint'?Number(v):v);
async function q(sql){ const r = await c.run(sql); return await r.getRowObjects(); }
console.log('total VR condition readsFrom:', J(await q(`select count(*) n from edges where from_id like 'ConditionalContext:ValidationRule:%' and edge_type='readsFrom'`)));
console.log('by firer type:', J(await q(`select regexp_extract(from_id, 'ConditionalContext:([A-Za-z]+):', 1) k, count(*) n from edges where from_id like 'ConditionalContext:%' and edge_type='readsFrom' group by 1 order by n desc`)));
console.log('overlap:', J(await q(`
with cc2 as (
  select from_id, to_id, regexp_replace(regexp_replace(from_id, '^ConditionalContext:', ''), '\\.condition-[0-9]+$', '') firer
  from edges where from_id like 'ConditionalContext:ValidationRule:%' and edge_type='readsFrom'
)
select count(*) total, sum(case when exists (select 1 from edges e where e.from_id = cc2.firer and e.to_id = cc2.to_id and e.edge_type='references') then 1 else 0 end) dup from cc2
`)));
console.log('sample:', J(await q(`select from_id, to_id, edge_type, source from edges where from_id like 'ConditionalContext:ValidationRule:Contact.Address_Mailing_City%' or (from_id='ValidationRule:Contact.Address_Mailing_City')`)));
