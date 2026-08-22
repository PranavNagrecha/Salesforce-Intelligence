import { openGraphReadOnly, closeGraph } from './dist/src/index.js';
const [,, dbPath, ...sqlParts] = process.argv;
const sql = sqlParts.join(' ');
const r = await openGraphReadOnly(dbPath);
if (!r.ok) { console.error('open failed', r.error); process.exit(1); }
const res = await r.value.connection.runAndReadAll(sql);
const rows = res.getRowObjects();
console.log(JSON.stringify(rows, (k,v)=> typeof v === 'bigint' ? Number(v) : v, 2));
await closeGraph(r.value);
