// Maintainer-only measure driver (untracked, never shipped). Spawns a FRESH
// `sfi mcp` from the just-built dist against the configured vault and calls one tool,
// so the post-fix measure tests CURRENT code, not the session's stale server.
// Usage: node zz-measure-ask.mjs <toolName> '<jsonArgs>' [vaultPath]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const BIN = join(repoRoot, 'packages', 'cli', 'bin', 'sfi.js');
const [, , toolName, argsJson, vaultArg] = process.argv;
const vault = vaultArg || join(repoRoot, 'org-kb');

const transport = new StdioClientTransport({
  command: 'node',
  args: [BIN, 'mcp', '--vault', vault],
  cwd: repoRoot,
  stderr: 'ignore',
});
const client = new Client({ name: 'measure', version: '1' }, { capabilities: {} });
try {
  await client.connect(transport);
  const r = await client.callTool({ name: toolName, arguments: argsJson ? JSON.parse(argsJson) : {} });
  process.stdout.write(r.content?.[0]?.text ?? JSON.stringify(r));
} catch (e) {
  process.stdout.write('DRIVER_ERROR: ' + (e?.message || String(e)));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
