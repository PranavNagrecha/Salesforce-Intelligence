/**
 * Finding baseline — stable fingerprints for acknowledged SAST/heuristic
 * findings that persist across vault refreshes (v4.0 R8).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

import { vaultPaths } from './layout.js';

/** Persisted baseline file at `{vaultRoot}/meta/baseline.json`. */
export interface BaselineFile {
  readonly version: 1;
  readonly findings: readonly BaselineEntry[];
}

export interface BaselineEntry {
  readonly fingerprint: string;
  readonly tool: string;
  readonly rule: string;
  readonly componentId: string;
  readonly location: string;
  readonly acknowledgedAt: string;
  readonly note?: string;
}

export interface BaselineError {
  readonly kind: 'parse-error' | 'write-failed';
  readonly message: string;
  readonly path?: string;
}

/**
 * Content-stable fingerprint: tool + rule + component + location (not line
 * numbers). Survives unrelated edits elsewhere in the class file.
 */
export const findingFingerprint = (
  tool: string,
  rule: string,
  componentId: string,
  location: string,
): string =>
  createHash('sha256')
    .update(`${tool}\0${rule}\0${componentId}\0${location}`, 'utf8')
    .digest('hex');

export const loadBaseline = async (
  vaultRoot: string,
): Promise<Result<BaselineFile, BaselineError>> => {
  const path = vaultPaths(vaultRoot).baseline;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return ok({ version: 1, findings: [] });
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'parse-error', message, path });
  }
  try {
    const parsed = JSON.parse(raw) as BaselineFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.findings)) {
      return err({ kind: 'parse-error', message: 'invalid baseline shape', path });
    }
    return ok(parsed);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'parse-error', message, path });
  }
};

export const saveBaseline = async (
  vaultRoot: string,
  file: BaselineFile,
): Promise<Result<void, BaselineError>> => {
  const path = vaultPaths(vaultRoot).baseline;
  const dir = dirname(path);
  const tmp = `${path}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
    return ok(undefined);
  } catch (cause) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'write-failed', message, path });
  }
};

export const isFingerprintSuppressed = (
  file: BaselineFile,
  fingerprint: string,
): boolean => file.findings.some((entry) => entry.fingerprint === fingerprint);

export const acknowledgeFinding = async (
  vaultRoot: string,
  entry: Omit<BaselineEntry, 'fingerprint' | 'acknowledgedAt'> & {
    readonly acknowledgedAt?: string;
  },
): Promise<Result<BaselineFile, BaselineError>> => {
  const loaded = await loadBaseline(vaultRoot);
  if (!loaded.ok) return loaded;
  const fingerprint = findingFingerprint(
    entry.tool,
    entry.rule,
    entry.componentId,
    entry.location,
  );
  const row: BaselineEntry = {
    fingerprint,
    tool: entry.tool,
    rule: entry.rule,
    componentId: entry.componentId,
    location: entry.location,
    acknowledgedAt: entry.acknowledgedAt ?? new Date().toISOString(),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
  const without = loaded.value.findings.filter((f) => f.fingerprint !== fingerprint);
  const next: BaselineFile = {
    version: 1,
    findings: [...without, row].sort((a, b) =>
      a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
    ),
  };
  const saved = await saveBaseline(vaultRoot, next);
  if (!saved.ok) return saved;
  return ok(next);
};
