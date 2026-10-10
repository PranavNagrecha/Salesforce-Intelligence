/// <reference types="vitest/globals" />

/**
 * DESCRIPTION <-> SCHEMA PARITY for the core roster.
 *
 * The token-diet short `description` is the only text most hosts read, and it
 * lists arg values inline: `accessLevel` read|edit, `view` 'principals' or
 * 'paths', `principalType` (Profile, PermissionSet, ...). Nothing tied those
 * lists to what the tool accepts, and one shipped advertising a principalType
 * value the tool refuses, so a host following the description got an error.
 *
 * The check, per core tool and per schema arg the description names in
 * backticks:
 *   1. Read the value list that IMMEDIATELY follows the arg: a pipe list
 *      (`a|b|c`, `a | b`), single-quoted values ('a' or 'b'), or a
 *      parenthesized list of bare identifiers ending at `;` or `)`, including
 *      `(for example a, b)` and `(a by default; also b, c)`. Prose after the
 *      arg yields no list, so output-field mentions are not misread. (The
 *      roster writes value lists in these shapes, not as backticked values.)
 *   2. When the JSON schema declares an enum for the arg, every listed value
 *      must be a member (that is what the host validates against).
 *   3. Otherwise the tool validates the value itself, so each value is sent
 *      through the REAL dispatcher (Zod + handler) over an empty vault and must
 *      not be refused on that arg. A deliberately bogus value is sent first as
 *      a control: if the tool does not refuse it, a probe proves nothing, and
 *      the arg is reported as unverifiable instead of silently passing.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { buildContext, shutdown } from '../../src/server.js';
import { advertisedTools } from '../../src/tools/index.js';
import { dispatchTool } from '../../src/tools/tool-dispatch.js';

type JsonSchema = Readonly<Record<string, unknown>>;

interface AdvertisedList {
  readonly arg: string;
  readonly values: readonly string[];
}

const IDENT = /^[A-Za-z][\w-]*$/;

/** Enum members a JSON-schema property declares, however it nests them. */
const schemaEnum = (prop: JsonSchema | undefined): readonly string[] => {
  if (prop === undefined) return [];
  const own = Array.isArray(prop['enum']) ? (prop['enum'] as unknown[]) : [];
  const items = prop['items'] as JsonSchema | undefined;
  const fromItems = items !== undefined && Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : [];
  const alts = [...((prop['anyOf'] as JsonSchema[] | undefined) ?? []), ...((prop['oneOf'] as JsonSchema[] | undefined) ?? [])];
  return [...own, ...fromItems, ...alts.flatMap((a) => schemaEnum(a))].filter((v): v is string => typeof v === 'string');
};

/**
 * The value lists `description` advertises for the args in `argNames`.
 * The parser is under test as much as the roster.
 */
const advertisedValueLists = (description: string, argNames: readonly string[]): AdvertisedList[] => {
  const out: AdvertisedList[] = [];
  const argSet = new Set(argNames);
  for (const m of description.matchAll(/`([A-Za-z_]\w*)`/g)) {
    const arg = m[1] as string;
    if (!argSet.has(arg)) continue;
    // The window ends at the next backticked arg name or the end of the sentence.
    let rest = description.slice((m.index ?? 0) + m[0].length);
    const nextArg = [...rest.matchAll(/`([A-Za-z_]\w*)`/g)].find((n) => argSet.has(n[1] as string));
    if (nextArg?.index !== undefined) rest = rest.slice(0, nextArg.index);
    const sentenceEnd = /\.(?:\s|$)/.exec(rest);
    if (sentenceEnd !== null) rest = rest.slice(0, sentenceEnd.index);
    // Allow a short lead-in between the arg and its list.
    const head = rest.replace(/^\s*(?:\((?:required|optional)\)\s*)?(?:[:=]\s*)?(?:is\s+|one of\s+)?/i, '');
    const values = listAt(head.replace(/\s*\(default\)/gi, ''));
    if (values.length > 0) out.push({ arg, values });
  }
  return out;
};

/** The value list at the very start of `text`, or [] when it starts with prose. */
const listAt = (text: string): string[] => {
  const pipe = /^([A-Za-z][\w-]*(?:\s*\|\s*[A-Za-z][\w-]*)+)/.exec(text);
  if (pipe?.[1] !== undefined) return pipe[1].split('|').map((v) => v.trim());
  if (text.startsWith("'")) {
    // 'a' (note) or 'b' / 'a', 'b': quoted identifiers outside parentheses.
    const values: string[] = [];
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === "'" && depth === 0) {
        const close = text.indexOf("'", i + 1);
        if (close === -1) break;
        const v = text.slice(i + 1, close);
        if (IDENT.test(v)) values.push(v);
        i = close;
      } else if (c === ';' && depth === 0) break;
    }
    return values;
  }
  if (text.startsWith('(')) {
    const close = text.indexOf(')');
    if (close === -1) return [];
    let inner = text.slice(1, close).trim();
    // `(x by default; also a, b)`: the default is a value too.
    const byDefault = /^([A-Za-z][\w-]*)\s+by default\s*;\s*also\s+(.*)$/i.exec(inner);
    if (byDefault !== null) inner = `${byDefault[1] ?? ''}, ${byDefault[2] ?? ''}`;
    else {
      // `(for example a, b)` / `(e.g. a, b)`: examples are still advertised values.
      inner = inner.replace(/^(?:for example|e\.g\.),?\s+/i, '');
      const semi = inner.indexOf(';');
      if (semi !== -1) inner = inner.slice(0, semi);
    }
    const items = inner
      .split(',')
      .map((v) => v.trim().replace(/^(?:and|or)\s+/i, ''))
      .filter((v) => v.length > 0);
    return items.length > 1 && items.every((v) => IDENT.test(v)) ? items : [];
  }
  return [];
};

/** Synthetic filler for a required arg that is not the one being probed. */
const filler = (name: string, prop: JsonSchema | undefined): unknown => {
  const e = schemaEnum(prop);
  if (e.length > 0) return e[0];
  const type = prop?.['type'];
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (/componentId|objectId/i.test(name)) return 'CustomObject:Account';
  if (/fieldId/i.test(name)) return 'CustomField:Account.Name';
  return 'Account';
};

const refusedOn = (text: string, arg: string): boolean => {
  const body = JSON.parse(text) as { error?: unknown };
  if (body.error === undefined) return false;
  const e = typeof body.error === 'object' && body.error !== null ? (body.error as Record<string, unknown>) : {};
  const message = typeof e['message'] === 'string' ? e['message'] : '';
  return e['path'] === arg || message.includes(arg);
};

interface ToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

interface ParityReport {
  readonly mismatches: string[];
  readonly probed: string[];
  readonly unverifiable: string[];
}

const checkTool = async (ctx: Context, tool: ToolLike, dispatchAs = tool.name): Promise<ParityReport> => {
  const props = (tool.inputSchema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (tool.inputSchema['required'] ?? []) as string[];
  const report: ParityReport = { mismatches: [], probed: [], unverifiable: [] };
  for (const { arg, values } of advertisedValueLists(tool.description, Object.keys(props))) {
    const allowed = schemaEnum(props[arg]);
    if (allowed.length > 0) {
      for (const v of values) {
        if (!allowed.includes(v)) report.mismatches.push(`${tool.name} ${arg}: '${v}' is not in the schema enum [${allowed.join(', ')}]`);
      }
      continue;
    }
    const base: Record<string, unknown> = {};
    for (const r of required) if (r !== arg) base[r] = filler(r, props[r]);
    const call = async (value: string): Promise<boolean> => {
      const res = await dispatchTool(ctx, dispatchAs, { ...base, [arg]: value });
      const text = (res.content as readonly { readonly text?: string }[])[0]?.text ?? '{}';
      return refusedOn(text, arg);
    };
    if (!(await call('zz_not_a_value'))) {
      report.unverifiable.push(`${tool.name} ${arg}`);
      continue;
    }
    report.probed.push(`${tool.name} ${arg}`);
    for (const v of values) {
      if (await call(v)) report.mismatches.push(`${tool.name} ${arg}: advertised '${v}' is refused by the tool`);
    }
  }
  return report;
};

const manifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
});

describe('core tool descriptions advertise only values the tool accepts', () => {
  let vault = '';
  let ctx: Context | null = null;

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sfi-desc-parity-'));
    await mkdir(vaultPaths(vault).graph, { recursive: true });
    const saved = await saveManifest(vault, manifest());
    if (!saved.ok) throw new Error(saved.error.message);
    const built = await buildContext(vault);
    if (!built.ok) throw new Error(built.error.message);
    ctx = built.value;
  });

  afterAll(async () => {
    if (ctx !== null) await shutdown(ctx);
    await rm(vault, { recursive: true, force: true });
  });

  it('parses the advertised list shapes and ignores prose', () => {
    const d =
      "Args: `a` read|edit (default) | all; `b` 'one' (default: x) or 'two'; `c` (Red, Green; Blue is refused); " +
      '`d` (default 120, max 250); `e` names the thing, for example `a`; ' +
      '`f` (for example Up, Down, and Left); `g` (soft by default; also hard, none) and ' +
      '`h` (for example ["Quoted"]).';
    expect(advertisedValueLists(d, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual([
      { arg: 'a', values: ['read', 'edit', 'all'] },
      { arg: 'b', values: ['one', 'two'] },
      { arg: 'c', values: ['Red', 'Green'] },
      { arg: 'f', values: ['Up', 'Down', 'Left'] },
      { arg: 'g', values: ['soft', 'hard', 'none'] },
    ]);
  });

  it('FAILS on a synthetic description that advertises a value the tool refuses', async () => {
    const real = advertisedTools('core').find((t) => t.name === 'sfi.who_can_access_object');
    expect(real).toBeDefined();
    const synthetic: ToolLike = {
      name: 'sfi.who_can_access_object',
      inputSchema: real!.inputSchema,
      description:
        'Args: `componentId` (required); optional `accessLevel` read|share and `principalType` (Profile, Queue; a group is listed) to filter.',
    };
    const report = await checkTool(ctx!, synthetic);
    expect(report.mismatches).toEqual([
      expect.stringContaining("accessLevel: 'share' is not in the schema enum"),
      expect.stringContaining("principalType: advertised 'Queue' is refused"),
    ]);
  });

  it('FAILS on the example and by-default list shapes too', async () => {
    const core = advertisedTools('core');
    const edges = core.find((t) => t.name === 'sfi.get_edges');
    const consent = core.find((t) => t.name === 'sfi.live_consent');
    expect(edges).toBeDefined();
    expect(consent).toBeDefined();
    const mutated = [
      { ...edges!, description: 'Optional `edgeType` (for example grantedTo, readsFrom), `direction`.' },
      { ...consent!, description: '`scopes` (aggregate by default; also sample, admin) and `ttlMinutes`.' },
    ] as ToolLike[];
    const mismatches: string[] = [];
    for (const t of mutated) mismatches.push(...(await checkTool(ctx!, t)).mismatches);
    expect(mismatches).toEqual([
      expect.stringContaining("edgeType: 'grantedTo' is not in the schema enum"),
      expect.stringContaining("scopes: 'admin' is not in the schema enum"),
    ]);
  });

  it('passes on the current core roster, and actually probes the handler-validated args', async () => {
    const all: ParityReport = { mismatches: [], probed: [], unverifiable: [] };
    let lists = 0;
    for (const tool of advertisedTools('core')) {
      const props = Object.keys(((tool.inputSchema as JsonSchema)['properties'] ?? {}) as Record<string, unknown>);
      lists += advertisedValueLists(tool.description, props).length;
      const r = await checkTool(ctx!, tool as ToolLike);
      all.mismatches.push(...r.mismatches);
      all.probed.push(...r.probed);
      all.unverifiable.push(...r.unverifiable);
    }
    expect(all.mismatches).toEqual([]);
    // An advertised list the tool neither enumerates nor refuses a bogus value
    // for proves nothing either way: name it here instead of passing silently.
    expect(all.unverifiable).toEqual([]);
    // Not vacuous: the roster advertises lists, and the arg that once drifted is
    // checked against the real handler, not skipped.
    expect(lists).toBeGreaterThan(5);
    expect(all.probed).toContain('sfi.who_can_access_object principalType');
  }, 60_000);
});
