import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import type { TypeContext } from '../types.js';
import { detectDependencyPatterns } from './dependencies.js';
import { detectErrorHandlingPattern } from './error-handling.js';
import { detectGuardContracts } from './guards.js';
import { detectImportConstraintPatterns } from './imports.js';
import { detectNullifyPattern } from './nullify.js';
import { detectReturnTypePattern } from './returns.js';
import { detectNoLogSensitivePattern } from './sensitive-logging.js';
import { detectSideEffectPatterns } from './side-effects.js';
import { uniqueContracts } from './common.js';

export interface PatternMatcher {
  name: string;
  detect: (config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo, types: TypeContext) => Contract[];
}

export const PATTERN_MATCHERS: PatternMatcher[] = [
  { name: 'nullify_after_use', detect: (config, parsed, scope) => detectNullifyPattern(config, parsed, scope) },
  { name: 'no_log_sensitive', detect: (config, parsed, scope) => detectNoLogSensitivePattern(config, parsed, scope) },
  { name: 'return_type', detect: (config, parsed, scope, types) => detectReturnTypePattern(config, parsed, types, scope) },
  { name: 'error_boundary', detect: (config, parsed, scope) => detectErrorHandlingPattern(config, parsed, scope) },
  { name: 'db_write', detect: (config, parsed, scope) => detectSideEffectPatterns(config, parsed, scope) },
  { name: 'event_emit', detect: (config, parsed, scope) => detectSideEffectPatterns(config, parsed, scope) },
  { name: 'external_api', detect: (config, parsed, scope) => detectSideEffectPatterns(config, parsed, scope) },
  { name: 'guard_clause', detect: (config, parsed, scope) => detectGuardContracts(config, parsed, scope) },
  { name: 'must_call', detect: (config, parsed, scope) => detectDependencyPatterns(config, parsed, scope) },
];

export const MODULE_PATTERN_MATCHERS: PatternMatcher[] = [
  { name: 'import_constraint', detect: (config, parsed, scope) => detectImportConstraintPatterns(config, parsed, scope) },
];

export function detectContractsForScope(
  config: DriftConfig,
  parsed: ParsedFile,
  scope: ScopeInfo,
  types: TypeContext,
): Contract[] {
  return uniqueContracts(PATTERN_MATCHERS.flatMap((matcher) => matcher.detect(config, parsed, scope, types)));
}

export function detectContractsForModule(
  config: DriftConfig,
  parsed: ParsedFile,
  scope: ScopeInfo,
  types: TypeContext,
): Contract[] {
  return uniqueContracts(MODULE_PATTERN_MATCHERS.flatMap((matcher) => matcher.detect(config, parsed, scope, types)));
}
