/**
 * Handlers for the vault git-history tools (P13-GITHIST-tools):
 *
 *   - `sfi.component_history` — the component's change timeline from the
 *     vault's OWN git repo (`sfi vault git enable`): `git log --follow` over
 *     its source file, merged with the metadata-declared lastModified
 *     fields. Optional capped diff for the most recent change.
 *   - `sfi.component_as_of` — the component AS IT WAS at a ref:
 *     `git show <ref>:<sourcePath>` → the historical bytes re-run through
 *     the SAME extractor the refresh uses for that type → properties-as-of.
 *     Types without a wired extractor return the capped raw content with an
 *     honest `extracted: false`.
 *
 * Non-git vaults (history never enabled) answer `available: false` with the
 * enable hint — never an error. Read-only: git only ever READS the local
 * repo; nothing touches Salesforce.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ComponentType, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  extractApexClass,
  extractApexTrigger,
  extractCustomField,
  extractCustomObject,
  extractFlow,
  extractLayout,
  extractPermissionSet,
  extractProfile,
  extractValidationRule,
} from '@sf-intelligence/extractors';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Injectable git runner (tests stub; production = execFile in the vault). */
export type GitExec = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const nodeGitExec: GitExec = async (args, cwd) =>
  promisify(execFile)('git', [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });

/** Max bytes of diff / raw historical content returned per entry. */
export const HISTORY_DIFF_CAP_BYTES = 4_000;
export const AS_OF_RAW_CAP_BYTES = 16_000;

const ENABLE_HINT =
  'This vault has no git history — run `sfi vault git enable` once; refreshes with source changes then auto-commit, and history accrues from that point.';

/**
 * The extractor each as-of-supported type re-runs on historical bytes —
 * REUSING the exact refresh extractors. Types outside this map return raw
 * content honestly (`extracted: false`).
 */
const AS_OF_EXTRACTORS: Partial<
  Record<ComponentType, (path: string) => Promise<Result<unknown, unknown>>>
> = {
  ApexClass: extractApexClass,
  ApexTrigger: extractApexTrigger,
  CustomField: extractCustomField,
  CustomObject: extractCustomObject,
  Flow: extractFlow,
  Layout: extractLayout,
  PermissionSet: extractPermissionSet,
  Profile: extractProfile,
  ValidationRule: extractValidationRule,
};

export const componentHistoryInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  /** Include a capped unified diff for the MOST RECENT change. */
  includeLatestDiff: z.boolean().optional(),
});
export type ComponentHistoryInput = z.infer<typeof componentHistoryInputSchema>;

export interface ComponentHistoryEntry {
  readonly hash: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
}

export interface ComponentHistoryOutput {
  readonly available: boolean;
  readonly componentId: string;
  readonly sourcePath?: string;
  readonly entries: readonly ComponentHistoryEntry[];
  /** Metadata-declared last-modified (org-side), merged for comparison. */
  readonly metadataLastModified: {
    readonly lastModifiedDate: string | null;
    readonly lastModifiedBy: string | null;
  };
  /** Capped unified diff of the most recent change (opt-in). */
  readonly latestDiff?: string;
  readonly latestDiffTruncated?: boolean;
  readonly remedy?: string;
  readonly disclosure: string;
}

const HISTORY_DISCLOSURE =
  "History comes from the vault's LOCAL git repo and starts when `sfi vault git enable` was run — it is refresh-granularity (one commit per source-changing refresh), not the org's audit trail. metadataLastModified is the org-declared stamp from the last retrieve; the two views complement each other.";

const cap = (text: string, max: number): { text: string; truncated: boolean } =>
  Buffer.byteLength(text, 'utf8') <= max
    ? { text, truncated: false }
    : { text: `${Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')}\n…[truncated]`, truncated: true };

const loadNode = async (
  ctx: Context,
  componentId: string,
): Promise<Result<Node, McpError>> => {
  const node = await getNodeById(ctx.graph, componentId as never);
  if (!node.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
  }
  if (node.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no component '${componentId}' in this vault`,
      path: componentId,
    });
  }
  return ok(node.value);
};

/**
 * `sfi.component_history` — change timeline from the vault's own git repo.
 *
 * @example
 *   const r = await componentHistoryHandler(ctx, { componentId: 'ApexClass:Alpha' });
 *   if (r.ok && r.value.data.available) show(r.value.data.entries);
 */
export const componentHistoryHandler = async (
  ctx: Context,
  input: ComponentHistoryInput,
  gitExec: GitExec = nodeGitExec,
): Promise<Result<McpResponse<ComponentHistoryOutput>, McpError>> => {
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const nodeResult = await loadNode(ctx, input.componentId);
  if (!nodeResult.ok) return nodeResult;
  const node = nodeResult.value;
  const metadataLastModified = {
    lastModifiedDate: node.lastModifiedDate,
    lastModifiedBy: node.lastModifiedBy,
  };
  if (!existsSync(join(ctx.vaultRoot, '.git'))) {
    return ok({
      data: {
        available: false,
        componentId: input.componentId,
        entries: [],
        metadataLastModified,
        remedy: ENABLE_HINT,
        disclosure: HISTORY_DISCLOSURE,
      },
      vaultState,
    });
  }
  const limit = input.limit ?? 20;
  let stdout: string;
  try {
    ({ stdout } = await gitExec(
      ['log', '--follow', `--max-count=${limit}`, '--format=%H%x09%aI%x09%an%x09%s', '--', node.sourcePath],
      ctx.vaultRoot,
    ));
  } catch (cause) {
    return err({
      kind: 'internal',
      message: `git log failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const entries: ComponentHistoryEntry[] = stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [hash = '', date = '', author = '', ...rest] = l.split('\t');
      return { hash, date, author, subject: rest.join('\t') };
    });

  let latestDiff: string | undefined;
  let latestDiffTruncated: boolean | undefined;
  if (input.includeLatestDiff === true && entries.length > 0) {
    try {
      const { stdout: diff } = await gitExec(
        ['show', '--format=', '--unified=2', entries[0]?.hash ?? 'HEAD', '--', node.sourcePath],
        ctx.vaultRoot,
      );
      const capped = cap(diff, HISTORY_DIFF_CAP_BYTES);
      latestDiff = capped.text;
      latestDiffTruncated = capped.truncated;
    } catch {
      // diff is garnish — entries stand on their own
    }
  }

  return ok({
    data: {
      available: true,
      componentId: input.componentId,
      sourcePath: node.sourcePath,
      entries,
      metadataLastModified,
      ...(latestDiff !== undefined
        ? { latestDiff, latestDiffTruncated: latestDiffTruncated === true }
        : {}),
      disclosure: HISTORY_DISCLOSURE,
    },
    vaultState,
  });
};

export const componentAsOfInputSchema = z.object({
  componentId: z.string().min(1),
  /** A git ref in the vault repo: commit hash, HEAD~2, a tag… */
  ref: z.string().min(1),
});
export type ComponentAsOfInput = z.infer<typeof componentAsOfInputSchema>;

export interface ComponentAsOfOutput {
  readonly available: boolean;
  readonly componentId: string;
  readonly ref: string;
  /** True when the type's extractor re-ran on the historical bytes. */
  readonly extracted: boolean;
  /** The as-of node properties (extractor output), when extracted. */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Capped raw historical content when the type has no wired extractor. */
  readonly rawContent?: string;
  readonly rawContentTruncated?: boolean;
  readonly remedy?: string;
  readonly disclosure: string;
}

const AS_OF_DISCLOSURE =
  "Properties-as-of re-runs the SAME extractor the refresh uses on the file's historical bytes from the vault's local git repo — declared metadata only, no live org access. Coverage starts when vault history was enabled.";

/**
 * `sfi.component_as_of` — the component's declared properties at a git ref.
 *
 * @example
 *   const r = await componentAsOfHandler(ctx, { componentId: 'ApexClass:Alpha', ref: 'HEAD~1' });
 */
export const componentAsOfHandler = async (
  ctx: Context,
  input: ComponentAsOfInput,
  gitExec: GitExec = nodeGitExec,
): Promise<Result<McpResponse<ComponentAsOfOutput>, McpError>> => {
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const nodeResult = await loadNode(ctx, input.componentId);
  if (!nodeResult.ok) return nodeResult;
  const node = nodeResult.value;
  if (!existsSync(join(ctx.vaultRoot, '.git'))) {
    return ok({
      data: {
        available: false,
        componentId: input.componentId,
        ref: input.ref,
        extracted: false,
        remedy: ENABLE_HINT,
        disclosure: AS_OF_DISCLOSURE,
      },
      vaultState,
    });
  }
  if (!/^[A-Za-z0-9_./~^-]+$/.test(input.ref)) {
    return err({ kind: 'invalid-query', message: `ref '${input.ref}' contains unsupported characters` });
  }
  let bytes: string;
  try {
    ({ stdout: bytes } = await gitExec(
      ['show', `${input.ref}:${node.sourcePath}`],
      ctx.vaultRoot,
    ));
  } catch (cause) {
    return err({
      kind: 'invalid-query',
      message: `git show failed for ${input.ref}:${node.sourcePath} — ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)} (the ref may predate vault history or the file's tracking)`,
    });
  }

  const extractor = AS_OF_EXTRACTORS[node.type];
  if (extractor === undefined) {
    const capped = cap(bytes, AS_OF_RAW_CAP_BYTES);
    return ok({
      data: {
        available: true,
        componentId: input.componentId,
        ref: input.ref,
        extracted: false,
        rawContent: capped.text,
        rawContentTruncated: capped.truncated,
        remedy: `type ${node.type} has no as-of extractor wired yet — raw historical content returned`,
        disclosure: AS_OF_DISCLOSURE,
      },
      vaultState,
    });
  }

  // Extractors read from DISK and derive identity from the path — mirror the
  // file's vault-relative layout under a temp root so both behaviors hold.
  const tempRoot = await mkdtemp(join(tmpdir(), 'sfi-as-of-'));
  try {
    const tempPath = join(tempRoot, node.sourcePath);
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, bytes, 'utf8');
    // Body-file types (Apex class/trigger) carry their declared properties in
    // a `-meta.xml` sidecar — fetch it from the SAME ref so the extractor
    // sees the historical pair. Best-effort: a missing sidecar just degrades.
    if (/\.(cls|trigger)$/.test(node.sourcePath)) {
      try {
        const { stdout: sidecar } = await gitExec(
          ['show', `${input.ref}:${node.sourcePath}-meta.xml`],
          ctx.vaultRoot,
        );
        await writeFile(`${tempPath}-meta.xml`, sidecar, 'utf8');
      } catch {
        // sidecar absent at that ref — extractor may still parse the body
      }
    }
    const extractedResult = await extractor(tempPath);
    if (
      typeof extractedResult === 'object' &&
      extractedResult !== null &&
      'ok' in extractedResult &&
      extractedResult.ok === true
    ) {
      const value = (extractedResult as { value: { nodes?: readonly Node[] } }).value;
      const match =
        value.nodes?.find((n) => n.id === node.id) ?? value.nodes?.[0] ?? null;
      if (match !== null && match !== undefined) {
        return ok({
          data: {
            available: true,
            componentId: input.componentId,
            ref: input.ref,
            extracted: true,
            properties: {
              apiName: match.apiName,
              label: match.label,
              type: match.type,
              ...match.properties,
            },
            disclosure: AS_OF_DISCLOSURE,
          },
          vaultState,
        });
      }
    }
    const capped = cap(bytes, AS_OF_RAW_CAP_BYTES);
    return ok({
      data: {
        available: true,
        componentId: input.componentId,
        ref: input.ref,
        extracted: false,
        rawContent: capped.text,
        rawContentTruncated: capped.truncated,
        remedy: 'extractor could not parse the historical bytes — raw content returned',
        disclosure: AS_OF_DISCLOSURE,
      },
      vaultState,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
