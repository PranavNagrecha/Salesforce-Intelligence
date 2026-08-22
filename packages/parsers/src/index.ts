/**
 * @sf-intelligence/parsers
 *
 * Source-string parsers that the extractors invoke to surface
 * lexical-level references. v0.2 shipped a formula tokenizer; v0.3
 * adds a heuristic Apex source scanner (regex / brace-balanced; a
 * PMD AST layer follows in v0.4). v1.4 adds the LWC/Aura/VF
 * heuristic frontend scanner family — sibling of the Apex scanner,
 * not a replacement. v0.3 also adds the Apex DEBUG LOG parser — an
 * event-stream reader (not a name scraper) that turns pasted log text
 * into ordered, depth-tracked, entry/exit-paired frames plus the
 * per-category "was this even logged" coverage the domain hinges on.
 */

export {
  apexClassOfSignature,
  classifyCodeUnit,
  debugLogCoverage,
  DEBUG_LOG_CATEGORIES,
  descendantNanosByKind,
  frameSelfNanos,
  indexFrames,
  NON_CPU_FRAME_KINDS,
  parseApexDebugLog,
  parseTriggerUnit,
} from './apex-debug-log.js';
export type {
  CodeUnitKind,
  DebugLogCategory,
  DebugLogCategoryCoverage,
  DebugLogError,
  DebugLogEvent,
  DebugLogFrame,
  DebugLogFrameKind,
  DebugLogHeader,
  DebugLogLevel,
  DebugLogLimitRow,
  DebugLogParseCaveat,
  DebugLogTruncation,
  DebugLogUserDebug,
  ParseApexDebugLogOptions,
  ParsedApexDebugLog,
} from './apex-debug-log.js';
// The AST STRUCTURE projection. Safe to export from the barrel even though it
// runs on the ~5 MB ANTLR grammar: `parseApexStructure` imports the grammar
// DYNAMICALLY on first call, so importing this module costs nothing at load
// time (`apex-ast-edges` stays subpath-only because it imports it statically).
export { parseApexStructure } from './apex-structure.js';
export type {
  ApexCallSite,
  ApexCatchClause,
  ApexDmlOperation,
  ApexDmlSite,
  ApexInnerType,
  ApexMemberNode,
  ApexMethodNode,
  ApexParam,
  ApexQuerySite,
  ApexStructureParse,
  ApexTypeStructure,
  ApexVisibility,
  ParseApexStructureOptions,
} from './apex-structure.js';
export { scanApexSource } from './apex-scanner.js';
export type {
  ApexScannerError,
  ApexScannerErrorKind,
  ApexScannerOutput,
  EventSubscription,
  FieldAccess,
  Instantiation,
  MethodCallSite,
} from './apex-scanner.js';
export { scanFrontendSource } from './frontend-scanner.js';
export type {
  FrontendApexCall,
  FrontendComponentRef,
  FrontendDialect,
  FrontendFieldAccess,
  FrontendFieldAccessOrigin,
  FrontendResourceRef,
  FrontendScannerError,
  FrontendScannerErrorKind,
  FrontendScannerOutput,
} from './frontend-scanner.js';
export { tokenizeFormula } from './formula-tokenizer.js';
export type {
  FieldReference,
  GlobalReference,
  TokenizerError,
  TokenizerErrorKind,
  TokenizerOutput,
} from './formula-tokenizer.js';
