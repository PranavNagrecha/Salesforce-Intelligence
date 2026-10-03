/**
 * `sfi run <tool> [--json] [--vault <path>] [--input <json>] [--<arg> <value>]…`
 * — call any MCP tool from a script, non-interactively, through the same
 * dispatch path the MCP server uses (same validation, same handler, same
 * response envelope).
 *
 * Arguments: `--<arg> <value>` sets one input key (`--object-api-name X` →
 * `objectApiName`); its value is typed from the tool's own input schema
 * (integer / number / boolean / array / object), so `--limit 5` is a number
 * and `--sub-type 123` stays a string. A repeated flag builds an array.
 * `--input '{…}'` merges a JSON object first, for nested inputs (`scope`,
 * `claim`). `--json` prints the response on one line; the default is indented.
 * Exit code 1 when the tool answers with an error.
 */

import {
  buildContext,
  dispatchTool,
  shutdown,
  V01_TOOLS,
  type ToolDefinition,
} from '@sf-intelligence/mcp';
import { Command } from 'commander';

import { VAULT_OPTION_HELP, vaultForAction } from '../vault-option.js';

/** `omni_save_trace` → `sfi.omni_save_trace`; a full name passes through. */
export const toolNameOf = (raw: string): string => (raw.startsWith('sfi.') ? raw : `sfi.${raw}`);

/** `object-api-name` / `object_api_name` → `objectApiName`; camelCase passes through. */
const camel = (key: string): string => key.replace(/[-_]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());

type JsonSchema = { readonly type?: unknown; readonly items?: JsonSchema; readonly properties?: Record<string, JsonSchema> };

const parseJson = (raw: string, what: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what}: not valid JSON: ${raw}`);
  }
};

/** Type one raw CLI value by its schema (strings stay strings unless the schema says otherwise). */
const typed = (raw: string | true, schema: JsonSchema | undefined, key: string): unknown => {
  if (raw === true) return true;
  const type = schema?.type;
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${key}: expected a number, got '${raw}'`);
    return n;
  }
  if (type === 'boolean') {
    if (raw === 'true' || raw === 'false') return raw === 'true';
    throw new Error(`--${key}: expected true or false, got '${raw}'`);
  }
  if (type === 'object') return parseJson(raw, `--${key}`);
  if (type === 'array') return raw.trimStart().startsWith('[') ? parseJson(raw, `--${key}`) : [typed(raw, schema?.items, key)];
  if (type === undefined && /^(\{|\[)/.test(raw.trimStart())) return parseJson(raw, `--${key}`);
  return raw;
};

/**
 * Build a tool's input from `--<arg> <value>` pairs, typed by its JSON input
 * schema. `--key=value` and bare boolean `--flag` are accepted.
 */
export const argsFromFlags = (
  tokens: readonly string[],
  inputSchema: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const properties = ((inputSchema as JsonSchema).properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = { ...base };
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (!token.startsWith('--')) throw new Error(`unexpected argument '${token}' (tool arguments are --<name> <value>)`);
    const eq = token.indexOf('=');
    const rawKey = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let raw: string | true;
    if (eq !== -1) raw = token.slice(eq + 1);
    else if (i + 1 < tokens.length && !(tokens[i + 1] as string).startsWith('--')) raw = tokens[(i += 1)] as string;
    else raw = true;
    const key = camel(rawKey);
    const schema = properties[key];
    const value = typed(raw, schema, rawKey);
    if (seen.has(key)) {
      // A repeated flag builds an array: `--id A --id B`.
      const prev = out[key];
      out[key] = [...(Array.isArray(prev) ? prev : [prev]), ...(Array.isArray(value) ? value : [value])];
    } else {
      out[key] = value; // a flag overrides the same key from --input
      seen.add(key);
    }
  }
  return out;
};

/** The tool definition for a CLI name, or null. */
export const findTool = (raw: string): ToolDefinition | null =>
  V01_TOOLS.find((t) => t.name === toolNameOf(raw)) ?? null;

/** Register `sfi run`. */
export const registerRunCommand = (program: Command): void => {
  program
    .command('run')
    .description(
      'Call any sfi tool from a script: `sfi run <tool> --json --<arg> <value> … [--vault <path>]` (e.g. `sfi run omni_save_trace --json --omniscript Acme_Intake_English_1`). Same validation and response as the MCP tool; values are typed from the tool schema; `--input <json>` for nested inputs; exit 1 when the tool returns an error. `sfi run` alone lists the tools.',
    )
    .argument('[tool]', 'tool name, with or without the `sfi.` prefix')
    .option('--json', 'print the response as one line of JSON (default: indented)')
    .option('--vault <path>', VAULT_OPTION_HELP)
    .option('--input <json>', 'a JSON object of tool arguments, merged before the --<arg> flags')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (tool: string | undefined, flags: { json?: boolean; vault?: string; input?: string }, cmd: Command) => {
      if (tool === undefined) {
        process.stdout.write(`${V01_TOOLS.map((t) => t.name.slice('sfi.'.length)).sort().join('\n')}\n`);
        return;
      }
      const def = findTool(tool);
      if (def === null) {
        process.stderr.write(`sfi run: no tool '${tool}'. \`sfi run\` lists them.\n`);
        process.exitCode = 1;
        return;
      }
      let args: Record<string, unknown>;
      try {
        const base = flags.input === undefined ? {} : parseJson(flags.input, '--input');
        if (typeof base !== 'object' || base === null || Array.isArray(base)) throw new Error('--input: expected a JSON object');
        args = argsFromFlags(cmd.args.slice(1), def.inputSchema, base as Record<string, unknown>);
      } catch (cause) {
        process.stderr.write(`sfi run ${tool}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const vault = vaultForAction(flags);
      if (vault === null) return;
      const ctxResult = await buildContext(vault.vaultRoot);
      if (!ctxResult.ok) {
        process.stderr.write(`sfi run: cannot open the vault at ${vault.vaultRoot}: ${ctxResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const result = await dispatchTool(ctxResult.value, def.name, args);
        const first = result.content[0];
        const text = first !== undefined && first.type === 'text' && typeof first.text === 'string' ? first.text : '{}';
        let envelope: unknown;
        try {
          envelope = JSON.parse(text);
        } catch {
          envelope = { error: { kind: 'internal', message: 'the tool returned a response that is not JSON' } };
        }
        process.stdout.write(`${flags.json === true ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2)}\n`);
        if (result.isError === true || (typeof envelope === 'object' && envelope !== null && 'error' in envelope)) {
          process.exitCode = 1;
        }
      } finally {
        await shutdown(ctxResult.value);
      }
    });
};
