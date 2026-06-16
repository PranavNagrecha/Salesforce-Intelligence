/// <reference types="vitest/globals" />

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditToolCall } from '../src/audit.js';

let dir: string;
let prior: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-audit-'));
  prior = process.env['SF_INTELLIGENCE_AUDIT_LOG'];
});

afterEach(() => {
  if (prior === undefined) delete process.env['SF_INTELLIGENCE_AUDIT_LOG'];
  else process.env['SF_INTELLIGENCE_AUDIT_LOG'] = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('auditToolCall', () => {
  it('appends one JSON line per call (tool + arg keys, never values)', () => {
    const log = join(dir, 'audit.log');
    process.env['SF_INTELLIGENCE_AUDIT_LOG'] = log;
    auditToolCall({
      ts: '2026-05-28T00:00:00.000Z',
      tool: 'sfi.resolve',
      argKeys: ['query'],
      vaultHash: 'sha256:x',
    });
    auditToolCall({
      ts: '2026-05-28T00:00:01.000Z',
      tool: 'sfi.get_component',
      argKeys: ['id'],
      vaultHash: 'sha256:x',
    });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as {
      tool: string;
      argKeys: string[];
    };
    expect(first.tool).toBe('sfi.resolve');
    expect(first.argKeys).toEqual(['query']);
  });

  it('is a no-op when SF_INTELLIGENCE_AUDIT_LOG is unset', () => {
    delete process.env['SF_INTELLIGENCE_AUDIT_LOG'];
    const log = join(dir, 'audit.log');
    auditToolCall({ ts: 'x', tool: 'sfi.resolve', argKeys: [], vaultHash: 'x' });
    expect(existsSync(log)).toBe(false);
  });

  it('never throws when the log path is unwritable', () => {
    process.env['SF_INTELLIGENCE_AUDIT_LOG'] = join(dir, 'no-such-dir', 'audit.log');
    expect(() =>
      auditToolCall({ ts: 'x', tool: 't', argKeys: [], vaultHash: 'x' }),
    ).not.toThrow();
  });
});
