#!/usr/bin/env node
// PERF-11: the CLI is one ~8 MB bundle that every invocation (including the
// MCP server a host spawns) parses from scratch. Node >= 22.1 can cache the
// compiled code on disk; enable it before loading the bundle. Best-effort:
// older Node lacks the API, and NODE_DISABLE_COMPILE_CACHE=1 turns it off.
import module from 'node:module';

try {
  module.enableCompileCache?.();
} catch {
  // A cache that cannot be created only costs speed.
}

const { createProgram } = await import('../dist/index.js');

createProgram()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
