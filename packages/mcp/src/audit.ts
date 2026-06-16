import { appendFileSync } from 'node:fs';

/**
 * One governance audit record for a tool invocation. Deliberately records arg
 * KEYS only — never values — because args can carry PII, record ids, or search
 * strings; the governance need is "who ran what against which vault," not the
 * payload.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp. */
  readonly ts: string;
  readonly tool: string;
  /** The argument names supplied (not their values). */
  readonly argKeys: readonly string[];
  /** Source-tree hash of the vault at query time (which snapshot was queried). */
  readonly vaultHash: string;
}

/**
 * Append-only audit log of MCP tool calls — provenance/governance for
 * enterprise deployments. No-op unless `SF_INTELLIGENCE_AUDIT_LOG` points at a
 * writable file; writes one JSON line per call. Best-effort: an audit-write
 * failure must NEVER break the underlying tool call, so all errors are
 * swallowed.
 *
 * @example
 *   auditToolCall({ ts: new Date().toISOString(), tool: 'sfi.resolve',
 *     argKeys: ['query'], vaultHash: 'sha256:abc' });
 */
export const auditToolCall = (entry: AuditEntry): void => {
  const path = process.env['SF_INTELLIGENCE_AUDIT_LOG'];
  if (path === undefined || path === '') return;
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Governance logging is best-effort; never fail the tool call.
  }
};
