/**
 * @sf-intelligence/cli
 *
 * The `sfi` command-line interface. v0.1 ships an empty shell with stub
 * `init`, `refresh`, `status`, and `mcp` subcommands; Phase G tasks
 * replace each stub's `.action(...)` body with the real implementation.
 * The bin entrypoint at `bin/sfi.js` invokes `createProgram` and parses
 * `process.argv`.
 */

export { createProgram } from './program.js';
