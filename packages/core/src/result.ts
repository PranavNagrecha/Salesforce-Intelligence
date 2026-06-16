import type { Result } from '@sf-intelligence/contracts';

/**
 * Construct a successful `Result`. Pairs with `err()` for the failure case.
 *
 * Prefer `ok`/`err` over throwing for any error a caller is expected to
 * handle. Throwing is reserved for true invariant violations.
 *
 * @example
 *   function parseNumber(input: string): Result<number, string> {
 *     const n = Number(input);
 *     if (Number.isNaN(n)) {
 *       return err(`not a number: ${input}`);
 *     }
 *     return ok(n);
 *   }
 */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/**
 * Construct a failed `Result`. Pairs with `ok()` for the success case.
 *
 * The error value can be any shape — a string for simple cases, a structured
 * object (e.g., `ExtractorError`) for callers that need to discriminate.
 *
 * @example
 *   function loadFile(path: string): Result<string, { kind: 'not-found'; path: string }> {
 *     if (!exists(path)) {
 *       return err({ kind: 'not-found', path });
 *     }
 *     return ok(readFileSync(path, 'utf8'));
 *   }
 */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
