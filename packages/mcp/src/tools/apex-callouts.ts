/**
 * ARCH-08. Apex HTTP callout sites, read from the vault's Apex source.
 *
 * `HttpRequest.setEndpoint(...)` call sites are not modeled as graph nodes, so
 * "what external systems does this org call?" had no structured answer. This
 * module greps `.cls` / `.trigger` source for `setEndpoint(` and classifies the
 * FIRST argument:
 *   - `named-credential` — a `'callout:Name…'` literal (the alias is named).
 *   - `literal-host`     — a `'https://host…'` literal (the host is named).
 *   - `dynamic`          — anything else (a variable, a custom-setting read,
 *                          a concatenation that does not start with a full
 *                          literal URL): the target is resolved at runtime.
 * A `dynamic` argument is then read statically (`apex-callout-resolve.ts`,
 * eval B01): literals and constants (`Consts.PREFIX`, same-class finals) are
 * folded into a literal prefix and each non-literal part is attributed to a
 * custom metadata field, custom label or custom setting, valued from the
 * vault where it holds them (`resolution`). An argument built entirely from
 * constants is re-classified as `named-credential` / `literal-host`; one whose
 * literal prefix NAMES a credential or host followed by a dynamic part becomes
 * `partially-resolved` — the credential / host is reported (with
 * `nameMayContinue` when nothing shows the runtime part does not extend the
 * name), the rest is not guessed.
 * A literal host is then joined to the org's RemoteSiteSetting allowlist; a
 * host no ACTIVE remote site covers is reported as unauthorized (the callout
 * throws at runtime unless something outside the vault authorizes it).
 * `@isTest` classes are skipped: their endpoints are mock targets, never called.
 *
 * Each call site also carries `asyncContext` when it runs off the request
 * thread: inside a `@future` method body (method-granular, `allowsCallouts`
 * from `callout=true`) or in a class implementing `Queueable` /
 * `Database.Batchable` (class-granular: the method may also be called
 * synchronously; `allowsCallouts` from `Database.AllowsCallouts`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { listEdgesForNodes, listNodesByIds } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import {
  type CalloutEndpointResolution,
  endpointArgumentText,
  prefixNameEnd,
  prefixNames,
  resolveEndpointArgument,
  vaultCalloutLookups,
} from './apex-callout-resolve.js';
import { stripApexComments } from './apex-dml-index.js';
import { grepVaultSource } from './search-apex-source.js';

export type ApexCalloutTarget = 'named-credential' | 'literal-host' | 'partially-resolved' | 'dynamic';

export interface ApexCallout {
  readonly sourceComponentId: ComponentId;
  readonly path: string;
  readonly line: number;
  readonly target: ApexCalloutTarget;
  /**
   * Lower-cased host for `literal-host`, and for `partially-resolved` when the
   * literal prefix names it; null otherwise.
   */
  readonly host: string | null;
  /**
   * Named Credential alias for `named-credential`, and for `partially-resolved`
   * when the literal prefix names it; null otherwise.
   */
  readonly namedCredential: string | null;
  /**
   * Whenever `host` is set: the active RemoteSiteSetting URL that authorizes
   * the host, or null when none does. Absent otherwise.
   */
  readonly authorizedBy?: string | null;
  /**
   * Present (true) on a `partially-resolved` site whose `host` /
   * `namedCredential` runs to the end of the literal prefix with nothing
   * showing where it stops: `'callout:My_API' + path` names `My_API`, but the
   * runtime part could extend it. The host still joins the RemoteSiteSetting
   * allowlist and `unauthorizedCalloutHosts`.
   */
  readonly nameMayContinue?: true;
  /**
   * For a call site whose argument is not one literal: the literal prefix
   * (literals + resolved constants), the constants it came through, and each
   * non-literal part with its source (custom metadata type + field, custom
   * label, custom setting, or `unresolved`) and the values the vault holds for
   * it. Heuristic static reading; absent when nothing in the argument is known.
   */
  readonly resolution?: CalloutEndpointResolution;
  /** Present when the call site runs asynchronously (see module doc). */
  readonly asyncContext?: ApexCalloutAsyncContext;
  /**
   * `dynamic` call sites in a component that builds a `'callout:'` endpoint at
   * runtime: the catalog's NamedCredentials whose name is a quoted literal in
   * that component (`same-component`) or in an Apex component with a graph edge
   * into it (`direct-caller`). Heuristic: the literal is there, the call passing
   * it is not traced. Absent when none matched.
   */
  readonly credentialCandidates?: readonly CalloutCredentialCandidate[];
}

export interface CalloutCredentialCandidate {
  readonly namedCredential: ComponentId;
  /**
   * `same-component` / `direct-caller`: the name is a quoted literal there.
   * `vault-record`: a `'callout:' + <custom metadata field / label>` endpoint
   * whose vault values name this credential (`namedIn` = those records).
   */
  readonly tier: 'same-component' | 'direct-caller' | 'vault-record';
  /** Components carrying the name literal (capped). */
  readonly namedIn: readonly string[];
  readonly confidence: 'heuristic';
}

export interface ApexCalloutAsyncContext {
  readonly mechanism: 'future' | 'queueable' | 'batchable';
  /** `@future(callout=true)` / `implements Database.AllowsCallouts`. */
  readonly allowsCallouts: boolean;
  /** `method`: the call site is inside the async method; `class`: somewhere in an async job class. */
  readonly granularity: 'method' | 'class';
}

export interface ApexCalloutScan {
  readonly callouts: readonly ApexCallout[];
  /** Sorted distinct literal hosts no active RemoteSiteSetting authorizes. */
  readonly unauthorizedHosts: readonly string[];
  /** True when the grep hit its row limit — `callouts` is then a floor. */
  readonly truncated: boolean;
  /** Vault-relative source files that could not be read (NOT searched). */
  readonly unreadablePaths: readonly string[];
}

const CALLOUT_SCAN_LIMIT = 5000;
/** Cap on `credentialCandidates[].namedIn`. */
const NAMED_IN_CAP = 5;
const SET_ENDPOINT_PATTERN = /\bsetEndpoint\s*\(\s*([\s\S]*)$/;
const FIRST_LITERAL_PATTERN = /^'((?:\\.|[^'\\])*)'/;

const hostOf = (url: string): string | null => {
  const m = /^https?:\/\/([^/:?#\s]+)/i.exec(url.trim());
  return m?.[1] !== undefined && m[1].length > 0 ? m[1].toLowerCase() : null;
};

/** Classify the text following `setEndpoint(` on one source line. */
export const classifyEndpointArgument = (
  argText: string,
): { readonly target: ApexCalloutTarget; readonly host: string | null; readonly namedCredential: string | null } => {
  const lit = FIRST_LITERAL_PATTERN.exec(argText.trim());
  const literal = lit?.[1];
  if (literal !== undefined) {
    const nc = /^callout:([A-Za-z_][A-Za-z_0-9]*(?:__[A-Za-z_0-9]+)?)/i.exec(literal);
    if (nc?.[1] !== undefined) return { target: 'named-credential', host: null, namedCredential: nc[1] };
    const host = hostOf(literal);
    if (host !== null) return { target: 'literal-host', host, namedCredential: null };
  }
  return { target: 'dynamic', host: null, namedCredential: null };
};

/** Comment-free source with string literal CONTENTS blanked (same offsets, same newlines). */
const codeOnly = (src: string): string =>
  stripApexComments(src).replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length));

/** Offset of the `}` closing the `{` at `open`, or the end of text. */
const matchingBrace = (code: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
};

const FUTURE_ANNOTATION = /@future\b\s*(\([^)]*\))?/gi;

/**
 * The async context a 1-based `line` of Apex `source` runs in, or undefined
 * when it runs on the caller's thread as far as this file shows.
 */
export const calloutAsyncContext = (source: string, line: number): ApexCalloutAsyncContext | undefined => {
  const code = codeOnly(source);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1);
  if (line < 1 || line > lineStarts.length) return undefined;
  // The call-site line's span; a method body overlapping it (one-line bodies
  // included) contains the call.
  const lineStart = lineStarts[line - 1] ?? 0;
  const lineEnd = (lineStarts[line] ?? code.length + 1) - 1;
  for (const m of code.matchAll(FUTURE_ANNOTATION)) {
    const open = code.indexOf('{', (m.index ?? 0) + m[0].length);
    if (open === -1 || open > lineEnd) continue;
    if (matchingBrace(code, open) >= lineStart) {
      return { mechanism: 'future', allowsCallouts: /\bcallout\s*=\s*true\b/i.test(m[1] ?? ''), granularity: 'method' };
    }
  }
  const header = /\bclass\s+\w+[^{]*\{/i.exec(code)?.[0] ?? '';
  const allowsCallouts = /\bDatabase\s*\.\s*AllowsCallouts\b/i.test(header);
  if (/\bimplements\b[^{]*\bQueueable\b/i.test(header)) {
    return { mechanism: 'queueable', allowsCallouts, granularity: 'class' };
  }
  if (/\bimplements\b[^{]*\bDatabase\s*\.\s*Batchable\b/i.test(header)) {
    return { mechanism: 'batchable', allowsCallouts, granularity: 'class' };
  }
  return undefined;
};

const componentIdForPath = (path: string): ComponentId | null => {
  const m = /([^/\\]+)\.(cls|trigger)$/i.exec(path);
  if (m?.[1] === undefined) return null;
  return `${m[2]?.toLowerCase() === 'trigger' ? 'ApexTrigger' : 'ApexClass'}:${m[1]}` as ComponentId;
};

/**
 * Enumerate Apex callout sites and join literal hosts to the active
 * RemoteSiteSetting URLs passed in `remoteSiteUrls`.
 */
export const scanApexCallouts = async (
  ctx: Context,
  activeRemoteSiteUrls: readonly string[],
): Promise<ApexCalloutScan> => {
  const grep = await grepVaultSource(ctx, {
    query: 'setEndpoint\\s*\\(',
    regex: true,
    limit: CALLOUT_SCAN_LIMIT,
    suffixes: ['.cls', '.trigger'],
  });
  if (!grep.ok) return { callouts: [], unauthorizedHosts: [], truncated: false, unreadablePaths: [] };
  const allow = new Map<string, string>();
  for (const url of activeRemoteSiteUrls) {
    const host = hostOf(url);
    if (host !== null && !allow.has(host)) allow.set(host, url);
  }
  const callouts: ApexCallout[] = [];
  const lookups = vaultCalloutLookups(ctx);
  const codeByPath = new Map<string, string>();
  // Test classes set mock endpoints that never leave the org.
  const isTestFile = new Map<string, boolean>();
  const rawByPath = new Map<string, string>();
  for (const path of new Set(grep.value.matches.map((m) => m.path))) {
    try {
      const raw = await readFile(join(ctx.vaultRoot, path), 'utf-8');
      rawByPath.set(path, raw);
      isTestFile.set(path, /@isTest\b/i.test(raw));
    } catch {
      isTestFile.set(path, false);
    }
  }
  for (const match of grep.value.matches) {
    if (isTestFile.get(match.path) === true) continue;
    const snippet = match.snippet;
    // Skip commented-out call sites.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(snippet)) continue;
    const arg = SET_ENDPOINT_PATTERN.exec(snippet)?.[1];
    const id = componentIdForPath(match.path);
    if (arg === undefined || id === null) continue;
    const raw = rawByPath.get(match.path);
    let c: ResolvedCallout | null = null;
    if (raw !== undefined) {
      let code = codeByPath.get(match.path);
      if (code === undefined) {
        code = stripApexComments(raw);
        codeByPath.set(match.path, code);
      }
      c = await resolveCalloutArgument(code, match.line, id, lookups);
    }
    // Source unreadable or the argument could not be delimited: the
    // first-literal reading of the call line is all there is.
    c ??= classifyEndpointArgument(arg);
    const asyncContext = raw === undefined ? undefined : calloutAsyncContext(raw, match.line);
    callouts.push({
      sourceComponentId: id,
      path: match.path,
      line: match.line,
      ...c,
      ...(c.host !== null ? { authorizedBy: allow.get(c.host) ?? null } : {}),
      ...(asyncContext !== undefined ? { asyncContext } : {}),
    });
  }
  callouts.sort((a, b) =>
    a.sourceComponentId < b.sourceComponentId ? -1 : a.sourceComponentId > b.sourceComponentId ? 1 : a.line - b.line,
  );
  const unauthorizedHosts = [
    ...new Set(
      callouts
        .filter((c) => c.host !== null && c.authorizedBy === null)
        .map((c) => c.host as string),
    ),
  ].sort();
  return {
    callouts,
    unauthorizedHosts,
    truncated: grep.value.truncated,
    unreadablePaths: grep.value.unreadablePaths,
  };
};

type ResolvedCallout = Pick<ApexCallout, 'target' | 'host' | 'namedCredential' | 'resolution' | 'nameMayContinue'>;

/**
 * Statically read one call site's full `setEndpoint(...)` argument (see module
 * doc). A literal (or constant) prefix followed by a runtime part is
 * `partially-resolved` when the prefix names a credential or host
 * (`prefixNames`): outright when a separator or the vault values show where
 * the name ends, with `nameMayContinue` when nothing does. `'https://api.' + x`
 * names no host, though its first literal starts with a URL. A plain single
 * literal carries no `resolution` block (nothing to explain). Returns null when
 * the argument cannot be delimited.
 */
const resolveCalloutArgument = async (
  code: string,
  line: number,
  id: ComponentId,
  lookups: ReturnType<typeof vaultCalloutLookups>,
): Promise<ResolvedCallout | null> => {
  const argText = endpointArgumentText(code, line);
  if (argText === null) return null;
  const unknown = { target: 'dynamic' as const, host: null, namedCredential: null };
  const ownClass = id.slice(id.indexOf(':') + 1);
  const resolution = await resolveEndpointArgument(argText, ownClass, code, lookups);
  if (resolution === null) return unknown;
  const whole = resolution.dynamicParts.length === 0;
  const plainLiteral = whole && resolution.constants.length === 0;
  const attach = plainLiteral ? {} : { resolution };
  const named = prefixNames(resolution.literalPrefix, prefixNameEnd(resolution));
  const hedge = named.nameMayContinue ? { nameMayContinue: true as const } : {};
  if (named.namedCredential !== null) {
    return {
      target: whole ? 'named-credential' : 'partially-resolved',
      host: null,
      namedCredential: named.namedCredential,
      ...hedge,
      ...attach,
    };
  }
  if (named.host !== null) {
    return { target: whole ? 'literal-host' : 'partially-resolved', host: named.host, namedCredential: null, ...hedge, ...attach };
  }
  return { ...unknown, ...attach };
};

/**
 * Eval B01. For a call site whose endpoint is `'callout:'` followed directly
 * by a custom metadata field or custom label, the credential name is the
 * first path segment of each value the vault holds for that part. Each such
 * name that is a NamedCredential in the catalog becomes a `vault-record`
 * candidate, merged with any candidates already attached. Pure; no I/O.
 */
export const attachVaultRecordCredentialCandidates = (
  callouts: readonly ApexCallout[],
  credentialNames: readonly string[],
): readonly ApexCallout[] => {
  const known = new Map(credentialNames.map((n) => [n.toLowerCase(), n]));
  return callouts.map((c) => {
    const r = c.resolution;
    const first = r?.dynamicParts[0];
    if (r === undefined || first === undefined || r.literalPrefix.toLowerCase() !== 'callout:') return c;
    const namedIn = new Map<string, Set<string>>();
    for (const v of first.vaultValues ?? []) {
      const name = known.get((v.value.split(/[/?#]/)[0] ?? '').trim().toLowerCase());
      if (name === undefined) continue;
      const holders = namedIn.get(name) ?? new Set<string>();
      for (const from of [v.from, ...(v.alsoFrom ?? [])]) holders.add(from);
      namedIn.set(name, holders);
    }
    if (namedIn.size === 0) return c;
    const added: CalloutCredentialCandidate[] = [...namedIn]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, from]) => ({
        namedCredential: `NamedCredential:${name}` as ComponentId,
        tier: 'vault-record',
        namedIn: [...from].sort().slice(0, NAMED_IN_CAP),
        confidence: 'heuristic',
      }));
    return { ...c, credentialCandidates: [...(c.credentialCandidates ?? []), ...added] };
  });
};

const RUNTIME_CREDENTIAL = /'callout:'/;

/**
 * Join each `dynamic` call site whose component builds a `'callout:'` endpoint
 * at runtime to the NamedCredentials named as quoted literals in that component
 * or in the Apex components with a graph edge into it (eval A09: a helper's
 * callout read 'dynamic' while the same response linked its credential to the
 * helper's callers). Reads only the callout components and their direct Apex
 * callers. Returns the callouts unchanged when nothing matches.
 */
export const attachCredentialCandidates = async (
  ctx: Context,
  callouts: readonly ApexCallout[],
  credentialNames: readonly string[],
): Promise<readonly ApexCallout[]> => {
  if (credentialNames.length === 0) return callouts;
  const readCode = async (path: string): Promise<string | null> => {
    try {
      return stripApexComments(await readFile(resolveVaultSourcePath(ctx.vaultRoot, path), 'utf-8'));
    } catch {
      return null;
    }
  };
  const ownCode = new Map<string, string | null>();
  for (const c of callouts) {
    if (c.target !== 'dynamic' || ownCode.has(c.sourceComponentId)) continue;
    const code = await readCode(c.path);
    ownCode.set(c.sourceComponentId, code !== null && RUNTIME_CREDENTIAL.test(code) ? code : null);
  }
  const runtimeIds = [...ownCode].filter(([, code]) => code !== null).map(([id]) => id as ComponentId);
  if (runtimeIds.length === 0) return callouts;

  const inbound = await listEdgesForNodes(ctx.graph, runtimeIds, { direction: 'in' });
  const callersOf = new Map<string, string[]>();
  if (inbound.ok) {
    for (const [id, edges] of inbound.value) {
      callersOf.set(
        id,
        [...new Set(edges.map((e) => e.fromId as string))].filter(
          (from) => from !== id && /^Apex(?:Class|Trigger):/.test(from),
        ),
      );
    }
  }
  const callerIds = [...new Set([...callersOf.values()].flat())] as ComponentId[];
  const callerCode = new Map<string, string>();
  const callerNodes = await listNodesByIds(ctx.graph, callerIds);
  if (callerNodes.ok) {
    for (const n of callerNodes.value) {
      if (n.sourcePath === null || n.sourcePath.length === 0) continue;
      const code = await readCode(n.sourcePath);
      if (code !== null) callerCode.set(n.id, code);
    }
  }
  const names = credentialNames.map((name) => ({
    name,
    quoted: new RegExp(`'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'),
  }));
  const candidatesFor = (id: string): CalloutCredentialCandidate[] => {
    const own = ownCode.get(id);
    if (own === null || own === undefined) return [];
    const out: CalloutCredentialCandidate[] = [];
    for (const { name, quoted } of names) {
      if (quoted.test(own)) {
        out.push({ namedCredential: `NamedCredential:${name}` as ComponentId, tier: 'same-component', namedIn: [id], confidence: 'heuristic' });
        continue;
      }
      const namedIn = (callersOf.get(id) ?? []).filter((c) => quoted.test(callerCode.get(c) ?? '')).sort();
      if (namedIn.length > 0) {
        out.push({
          namedCredential: `NamedCredential:${name}` as ComponentId,
          tier: 'direct-caller',
          namedIn: namedIn.slice(0, NAMED_IN_CAP),
          confidence: 'heuristic',
        });
      }
    }
    return out;
  };
  const byId = new Map(runtimeIds.map((id) => [id as string, candidatesFor(id)]));
  return callouts.map((c) => {
    const found = c.target === 'dynamic' ? byId.get(c.sourceComponentId) : undefined;
    return found !== undefined && found.length > 0 ? { ...c, credentialCandidates: found } : c;
  });
};
