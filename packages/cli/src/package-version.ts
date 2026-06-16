import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

declare const SFI_BUILD_VERSION: string | undefined;

/** CLI package version from the bundled define or `packages/cli/package.json`. */
export const readCliPackageVersion = (): string => {
  if (typeof SFI_BUILD_VERSION !== 'undefined') return SFI_BUILD_VERSION;
  for (const rel of ['../package.json', '../../package.json'] as const) {
    try {
      const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version !== undefined) return parsed.version;
    } catch {
      // dist/ bundle layout differs from src/ — try the next candidate.
    }
  }
  return '0.0.0';
};
