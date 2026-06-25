# SAST accuracy report — heuristic code-quality recognizers

Measured against a **labeled synthetic Apex corpus** (`eval/sast-corpus.json`). Every
finding the product emits is tagged `confidence: heuristic`; this report makes that
honesty *measurable*. Synthetic data only — re-run with `node eval/sast-accuracy.mjs`.

Corpus: **20 cases** across 6 rules (positives, negatives, FP-traps, and FN-blindspots).

## Per-rule results

| Rule | Cases | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `soql-in-loop` | 6 | 3 | 0 | 0 | 3 | 100% | 100% |
| `dml-in-loop` | 2 | 1 | 0 | 0 | 1 | 100% | 100% |
| `hardcoded-id` | 4 | 2 | 0 | 0 | 2 | 100% | 100% |
| `hardcoded-email` | 2 | 1 | 0 | 0 | 1 | 100% | 100% |
| `missing-crud-check` | 3 | 1 | 0 | 1 | 1 | 100% | 50% |
| `missing-fls-check` | 3 | 1 | 0 | 0 | 2 | 100% | 100% |
| **overall** | 20 | 9 | 0 | 1 | 10 | **100%** | **90%** |

## Where it misses (transparency)

- **FALSE NEGATIVE** — `missing-crud-check` · case `crud-fn-helper` (a real issue the heuristic missed)

## Honest reading

- **High precision is the design goal:** the recognizers are conservative — they avoid
  false positives (flagging clean code) even at the cost of recall, because a noisy SAST
  tool gets ignored. The FP-trap cases (SOQL in a comment/string, short non-Id literals)
  confirm comments/strings are stripped before matching.
- **The false negatives are the *documented* boundary, not surprises:** cross-method
  issues (a helper class that performs the DML/SOQL) and reflective access are invisible
  to a regex/token scanner — exactly what CLAUDE.md / POSITIONING disclose. (A dynamic
  `Database.query(...)` inside a loop IS still caught as a governor risk; only the
  query's resolved targets stay unknown.) The FN are measured here, not hand-waved.
- **Per-rule samples are small** (this is a seed corpus — expand `eval/sast-corpus.json`).
  The robust headline is overall precision; per-rule recall with n<5 is illustrative.
- **Use it as an advisor, not an oracle:** every finding stays `heuristic`; this report is
  the evidence behind that label.

