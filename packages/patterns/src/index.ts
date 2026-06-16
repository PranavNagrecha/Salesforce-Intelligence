/**
 * @sf-intelligence/patterns
 *
 * Pattern recognizers — naming conventions, permission clusters,
 * PII detection, etc. Phase E tasks populate this. v0.1 ships
 * naming-convention only; v2.0d appends `pii-detection` alongside the
 * `sfi.pii_inventory` and `sfi.field_access_audit` MCP composers; v2.1
 * appends `code-quality-patterns` alongside the `sfi.code_quality_audit`
 * MCP composer and the `developer-code-quality` skill.
 */

export { recognizeNamingConventions } from './naming-convention.js';
export type { PatternError, RecognizeOptions } from './naming-convention.js';
export {
  detectPiiClassification,
  detectPiiClassificationWithReason,
} from './pii-detection.js';
export type {
  PiiCategory,
  PiiClassification,
  PiiDetectionResult,
  PiiDetectionWithReason,
} from './pii-detection.js';
export { countAssertions, detectCodeQualityIssues } from './code-quality-patterns.js';
export type {
  CodeQualityMetadata,
  QualityIssue,
} from './code-quality-patterns.js';
