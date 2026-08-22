/**
 * The ONE runtime governor-limit signature recogniser, shared by
 * `sfi.explain_debug_log` and `sfi.explain_error`.
 *
 * **Why this module exists.** `explain_debug_log` owned `parseGovernorLimit`
 * and `explain_error` had no limit recogniser at all, so
 * `"System.LimitException: Too many SOQL queries: 101"` returned a fully-null
 * `disposition: 'none'` from one tool and a classified `soql` limit from the
 * other. Wiring the detector into `explain_error` could not be a plain import:
 * `explain-debug-log.ts` ALREADY imports `detectStatusCode` /
 * `parseApexStackFrame` / `parseFlowFault` / `STATUS_CODE_TAXONOMY` from
 * `explain-error.ts`, so the reverse import would close a module cycle. The
 * detector is lifted HERE instead and both tools import it, which is the point
 * of the fix: two tools that share one recogniser are INCAPABLE of disagreeing
 * about the same string, where two copies would drift.
 *
 * Nothing in here touches the graph or the vault — it is pure text
 * classification over a pasted log / error string.
 */

/**
 * Runtime governor-limit TYPES. Each maps (where a static rule exists) to the
 * `governor_limit_risks` rule most likely to have produced it — see
 * {@link LIMIT_TO_STATIC_RULES}.
 */
export type GovernorLimitType =
  | 'soql'
  | 'query-rows'
  | 'dml'
  | 'dml-rows'
  | 'cpu'
  | 'heap'
  | 'callouts'
  | 'future-calls'
  | 'email-invocations'
  | 'stack-depth'
  | 'other';

/** A parsed runtime governor-limit signature. */
export interface DetectedGovernorLimit {
  readonly limitType: GovernorLimitType;
  /** Plain-language description of the limit + its documented ceiling. */
  readonly description: string;
  /** The verbatim exception message segment that was recognized. */
  readonly message: string;
  /** The actual usage that tripped the limit, when the log stated it. */
  readonly actual: number | null;
  /** The allowed ceiling, when a `LIMIT_USAGE` block stated it. */
  readonly allowed: number | null;
}

/**
 * Classifiers for a runtime governor limit, most-specific first. Each carries a
 * documented ceiling for the plain-language `description`.
 */
// The regex matches the RESOURCE NAME (not only the "Too many …" phrasing) so
// both an exception message (`Too many SOQL queries: 101`) and a `LIMIT_USAGE`
// block resource (`Number of SOQL queries: 101 out of 100`) classify. Ordered
// most-specific first (`dml rows` before `dml statements`, `query rows` before
// the SOQL classifier).
const LIMIT_CLASSIFIERS: readonly {
  readonly re: RegExp;
  readonly type: GovernorLimitType;
  readonly description: string;
}[] = [
  { re: /soql queries/i, type: 'soql', description: 'SOQL queries per transaction (100 synchronous / 200 asynchronous)' },
  { re: /query rows/i, type: 'query-rows', description: 'query rows retrieved per transaction (50,000)' },
  { re: /dml rows/i, type: 'dml-rows', description: 'rows processed by DML per transaction (10,000)' },
  { re: /dml statements/i, type: 'dml', description: 'DML statements per transaction (150)' },
  { re: /(?:apex )?cpu time/i, type: 'cpu', description: 'Apex CPU time per transaction (10s synchronous / 60s asynchronous)' },
  { re: /heap size/i, type: 'heap', description: 'Apex heap size per transaction (6MB synchronous / 12MB asynchronous)' },
  { re: /callouts/i, type: 'callouts', description: 'callouts per transaction (100)' },
  { re: /future calls/i, type: 'future-calls', description: 'future method invocations per transaction (50)' },
  { re: /email invocations/i, type: 'email-invocations', description: 'email invocations per transaction (10)' },
  { re: /(?:trigger|stack) depth/i, type: 'stack-depth', description: 'maximum trigger / recursion depth (16)' },
];

/**
 * Parse a runtime governor-limit signature. Recognizes a `System.LimitException`
 * message, a bare `Too many … : N`, a CPU/heap signature, or an exceeding
 * `LIMIT_USAGE` block (`Number of SOQL queries: 101 out of 100`). Returns null
 * when no governor-limit signal is present.
 *
 * A limit the classifiers do not recognize returns `limitType: 'other'` with
 * `description: 'a governor limit'` — the honest partial. It never guesses a
 * specific limit.
 */
export const parseGovernorLimit = (logText: string): DetectedGovernorLimit | null => {
  const limEx = logText.match(/System\.LimitException:\s*([^\r\n|]+)/i);
  const tooMany = logText.match(/\bToo many [A-Za-z ]+?:\s*\d+/i);
  const cpuHeap = logText.match(
    /(?:Apex )?CPU time limit exceeded|Maximum CPU time exceeded|Apex heap size too large/i,
  );
  // A LIMIT_USAGE row where usage exceeded the ceiling ("101 out of 100").
  let exceededUsage: RegExpMatchArray | null = null;
  for (const m of logText.matchAll(
    /Number of ([A-Za-z ]+?):\s*(\d+)\s+out of\s+(\d+)/gi,
  )) {
    if (Number(m[2]) > Number(m[3])) {
      exceededUsage = m;
      break;
    }
  }

  const message =
    limEx?.[1]?.trim() ??
    tooMany?.[0]?.trim() ??
    cpuHeap?.[0]?.trim() ??
    (exceededUsage !== null
      ? `Number of ${exceededUsage[1]?.trim()}: ${exceededUsage[2]} out of ${exceededUsage[3]}`
      : null);
  if (message === null) return null;

  // Classify from the recognized message first, then fall back to the log.
  let type: GovernorLimitType = 'other';
  let description = 'a governor limit';
  for (const c of LIMIT_CLASSIFIERS) {
    if (c.re.test(message)) {
      type = c.type;
      description = c.description;
      break;
    }
  }
  if (type === 'other') {
    const hay = exceededUsage?.[1] ?? logText;
    for (const c of LIMIT_CLASSIFIERS) {
      if (c.re.test(hay)) {
        type = c.type;
        description = c.description;
        break;
      }
    }
  }

  let actual: number | null = null;
  let allowed: number | null = null;
  if (exceededUsage !== null) {
    actual = Number(exceededUsage[2]);
    allowed = Number(exceededUsage[3]);
  } else {
    const colonNum = message.match(/:\s*(\d+)\s*$/);
    if (colonNum) actual = Number(colonNum[1]);
  }
  return { limitType: type, description, message, actual, allowed };
};

/**
 * `governor_limit_risks` rule ids each limit type maps to (may be empty).
 *
 * An EMPTY array is a CHECKED zero: the mapping is total over
 * {@link GovernorLimitType}, so `[]` means "no static rule models this limit",
 * never "nobody looked".
 */
export const LIMIT_TO_STATIC_RULES: Readonly<
  Record<GovernorLimitType, readonly string[]>
> = Object.freeze({
  soql: ['soql-in-loop'],
  'query-rows': ['soql-in-loop'],
  dml: ['dml-in-loop', 'database-upsert-no-options'],
  'dml-rows': ['dml-in-loop', 'database-upsert-no-options'],
  // CPU is frequently burned by the same loop patterns — related, not exact.
  cpu: ['soql-in-loop', 'dml-in-loop'],
  heap: [],
  callouts: [],
  'future-calls': [],
  'email-invocations': [],
  'stack-depth': [],
  other: [],
});
