/**
 * @sf-intelligence/parsers
 *
 * Source-string parsers that the extractors invoke to surface
 * lexical-level references. v0.2 shipped a formula tokenizer; v0.3
 * adds a heuristic Apex source scanner (regex / brace-balanced; a
 * PMD AST layer follows in v0.4). v1.4 adds the LWC/Aura/VF
 * heuristic frontend scanner family — sibling of the Apex scanner,
 * not a replacement.
 */

export { scanApexSource } from './apex-scanner.js';
export type {
  ApexScannerError,
  ApexScannerErrorKind,
  ApexScannerOutput,
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
