import fs from 'node:fs';
import path from 'node:path';
import type { DriftConfig } from '../types/config.js';
import type { Contract, ContractScope, Severity } from '../types/contract.js';
import { isAtLeastSeverity, maxSeverity } from '../types/contract.js';
import { parseSource, extractScopes, findScopeByStableId, findTreeSitterPattern, type ParsedFile, type ScopeInfo } from '../analyzers/ast.js';
import { createTypeContext, getParameterInfo, getReturnType, hasThrowStatement } from '../analyzers/types.js';
import { extractCalls, callMatches, firstStatementsContainCall, hasExitBeforeCall, isCallConditionallyNested, isInsideTransactionCall, isSideEffectCall } from '../analyzers/call-graph.js';
import { hasGuaranteedNullify } from '../analyzers/pattern-matchers/nullify.js';
import { findSensitiveLogging } from '../analyzers/pattern-matchers/sensitive-logging.js';
import { detectErrorHandling } from '../analyzers/control-flow.js';
import { extractImports } from '../analyzers/ast.js';
import { discoverSourceFiles } from './crystallizer.js';
import { ContractStore, type IntegrityIssue } from './store.js';
import { diffFiles, stagedBinaryFiles, stagedFileContent, stagedFileSize, stagedFiles, unmergedFiles, unstagedDriftFiles } from '../git/diff.js';
import { normalizeRepoRelative, safeReadTextFile } from '../utils/security.js';
import { sourceMatchesConfig } from '../utils/config.js';
import { decideEvolution, type Evolution } from './evolver.js';

const SOURCE_MAX_BYTES = 4 * 1024 * 1024;

export type VerificationStatus = 'passed' | 'violated' | 'evolved';

export interface Violation {
  type: 'contract_violation' | 'scope_deleted' | 'integrity' | 'uncrystallized_file';
  severity: Severity;
  file: string;
  scope?: string;
  contract?: Contract;
  reason: string;
  suggestion: string;
  old_evidence?: Contract['evidence'];
  new_state?: string | undefined;
}

export interface CheckResult {
  violations: Violation[];
  warnings: string[];
  evolutions: Evolution[];
  summary: {
    files_checked: number;
    contracts_verified: number;
    violations: number;
    auto_evolved: number;
  };
}

export interface CheckOptions {
  staged?: boolean;
  diff?: string;
  files?: string[];
  baselineRef?: string | undefined;
  readMode?: 'worktree' | 'index';
  strictIntegrity?: boolean;
}

export async function checkProject(rootDir: string, config: DriftConfig, options: CheckOptions = {}): Promise<CheckResult> {
  const readMode = options.readMode ?? (options.staged ? 'index' : 'worktree');
  const store = new ContractStore(rootDir, { readMode });
  const warnings: string[] = [];
  const violations: Violation[] = [];
  const evolutions: Evolution[] = [];
  const blockedFiles = new Set<string>();

  if (options.staged) {
    for (const file of unmergedFiles(rootDir)) {
      violations.push({
        type: 'integrity',
        severity: 'critical',
        file,
        reason: `Unmerged Git index entry detected: ${file}`,
        suggestion: 'Resolve the merge conflict before running Drift',
      });
    }
    for (const file of stagedBinaryFiles(rootDir).filter((file) => sourceMatchesConfig(file, config))) {
      violations.push({
        type: 'integrity',
        severity: 'critical',
        file,
        reason: `Binary staged source file detected: ${file}`,
        suggestion: 'Do not stage binary content for TypeScript/JavaScript source paths',
      });
      blockedFiles.add(file);
    }
    for (const file of stagedFiles(rootDir).filter((file) => sourceMatchesConfig(file, config))) {
      const size = stagedFileSize(rootDir, file);
      if (size !== null && size > SOURCE_MAX_BYTES) {
        violations.push({
          type: 'integrity',
          severity: 'critical',
          file,
          reason: `Staged source file exceeds Drift safety limit: ${size} bytes`,
          suggestion: 'Split or remove the oversized staged source file before running Drift',
        });
        blockedFiles.add(file);
      }
    }
    for (const file of unstagedDriftFiles(rootDir)) {
      violations.push({
        type: 'integrity',
        severity: 'critical',
        file,
        reason: `Unstaged Drift metadata change detected: ${file}`,
        suggestion: 'Stage the .drift change with the source change, or restore it before committing',
      });
    }
  }

  for (const issue of store.integrityIssues({ baselineRef: options.baselineRef ?? options.diff })) {
    violations.push(integrityIssueToViolation(issue));
  }
  if (violations.some((violation) => violation.type === 'integrity' && violation.severity === 'critical')) {
    return {
      violations,
      warnings,
      evolutions,
      summary: {
        files_checked: 0,
        contracts_verified: 0,
        violations: violations.length,
        auto_evolved: 0,
      },
    };
  }

  const targetFiles = await resolveTargetFiles(rootDir, config, store, options);
  const typeContext = createTypeContext(rootDir, targetFiles.map((file) => path.join(rootDir, file)));
  let contractsVerified = 0;

  for (const sourceFile of targetFiles) {
    if (blockedFiles.has(sourceFile)) continue;
    const contractFile = store.load(sourceFile);
    if (!contractFile) {
      violations.push({
        type: 'uncrystallized_file',
        severity: 'high',
        file: sourceFile,
        reason: `No contract file exists for ${sourceFile}`,
        suggestion: 'Run drift init/refresh and commit the generated .drift contract before this source change',
      });
      continue;
    }
    const absolute = path.join(rootDir, sourceFile);
    const sourceText = options.staged
      ? stagedFileContent(rootDir, sourceFile)
      : fs.existsSync(absolute)
        ? safeReadTextFile(rootDir, sourceFile, 4 * 1024 * 1024, `source file ${sourceFile}`)
        : null;
    if (sourceText === null) {
      const activeContracts = contractFile.scopes.flatMap((scope) => scope.contracts).filter(isActiveContract);
      if (activeContracts.length === 0) continue;
      violations.push({
        type: 'scope_deleted',
        severity: maxSeverity(activeContracts.map((contract) => contract.severity)),
        file: sourceFile,
        reason: `${sourceFile} was deleted while active contracts still exist`,
        suggestion: 'Restore the file or explicitly archive the affected contracts with drift ignore',
      });
      continue;
    }
    let parsed: ParsedFile;
    let scopes: ScopeInfo[];
    try {
      parsed = parseSource(sourceFile, sourceText);
      scopes = extractScopes(parsed);
    } catch (error) {
      violations.push({
        type: 'integrity',
        severity: 'critical',
        file: sourceFile,
        reason: `Failed to parse ${sourceFile}: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: 'Fix the syntax or remove the malformed staged change before running Drift',
      });
      continue;
    }
    for (const storedScope of contractFile.scopes) {
      const currentScope = storedScope.kind === 'module' ? moduleScope(parsed) : findScopeByStableId(scopes, storedScope);
      const activeContracts = storedScope.contracts.filter(isActiveContract);
      contractsVerified += activeContracts.length;
      if (activeContracts.length === 0) continue;
      if (!currentScope) {
        violations.push({
          type: 'scope_deleted',
          severity: maxSeverity(activeContracts.map((contract) => contract.severity)),
          file: sourceFile,
          scope: storedScope.name,
          reason: `Scope ${storedScope.name} no longer exists`,
          suggestion: 'Restore the scope or intentionally archive/evolve its contracts',
        });
        continue;
      }
      for (const contract of activeContracts) {
        const result = verifyContract(config, contract, storedScope, parsed, currentScope, typeContext);
        if (result.status === 'violated') {
          const evolution = maybeEvolve(config, result, contract, storedScope.name, sourceFile);
          if (evolution) {
            evolutions.push(evolution);
            continue;
          }
          violations.push({
            type: 'contract_violation',
            severity: contract.severity,
            file: sourceFile,
            scope: storedScope.name,
            contract,
            reason: result.reason,
            suggestion: result.suggestion,
            old_evidence: contract.evidence,
            new_state: result.newState,
          });
        }
      }
    }
  }

  // `drift check` is intentionally read-only for contract files. Mutating
  // last_checked_at here would weaken the manifest tamper check.
  return {
    violations,
    warnings,
    evolutions,
    summary: {
      files_checked: targetFiles.length,
      contracts_verified: contractsVerified,
      violations: violations.length,
      auto_evolved: evolutions.length,
    },
  };
}

export function shouldBlock(result: CheckResult, threshold: Severity): boolean {
  return result.violations.some((violation) => violation.type === 'integrity' || isAtLeastSeverity(violation.severity, threshold));
}

interface VerifyResult {
  status: VerificationStatus;
  reason: string;
  suggestion: string;
  newState?: string | undefined;
}

function verifyContract(
  config: DriftConfig,
  contract: Contract,
  storedScope: ContractScope,
  parsed: ParsedFile,
  currentScope: ScopeInfo,
  typeContext: ReturnType<typeof createTypeContext>,
): VerifyResult {
  void config;
  void storedScope;
  switch (contract.verification.strategy) {
    case 'pattern_exists': {
      if (contract.pattern === 'nullify_after_use') {
        const variable = paramString(contract.verification.params?.variable);
        const exists = hasGuaranteedNullify(currentScope, variable);
        return exists
          ? pass()
          : violated(
              `Required nullification for ${variable} is missing`,
              `Restore ${variable} = null or ${variable} = undefined after its final sensitive use`,
              'nullification pattern absent',
            );
      }
      return violated(
        `Unsupported pattern_exists contract pattern: ${contract.pattern}`,
        'Fix the contract pattern or archive it with a trusted Drift command',
        'unsupported pattern',
      );
    }
    case 'call_absence': {
      if (contract.verification.target === 'sensitive_logging') {
        const names = contract.verification.params?.sensitive_names;
        const sensitiveNames = Array.isArray(names) ? names.filter((item): item is string => typeof item === 'string') : [];
        const logs = findSensitiveLogging(parsed, currentScope, sensitiveNames);
        return logs.length === 0
          ? pass()
          : violated(
              `Sensitive value is logged by ${logs[0]?.callee ?? 'logger'}`,
              'Remove sensitive identifiers from logger/console arguments or redact them before logging',
              logs[0]?.snippet,
            );
      }
      const calls = extractCalls(parsed, currentScope);
      const forbidden = calls.find((call) => callMatches(call.callee, contract.verification.target));
      return forbidden
        ? violated(
            `Forbidden call ${contract.verification.target} is present`,
            `Remove ${contract.verification.target} from ${currentScope.name} or evolve/archive the contract intentionally`,
            forbidden.snippet,
          )
        : pass();
    }
    case 'pattern_absent': {
      const calls = extractCalls(parsed, currentScope);
      const forbidden = calls.find((call) => callMatches(call.callee, contract.verification.target));
      return forbidden
        ? violated(
            `Forbidden pattern ${contract.verification.target} is present`,
            `Remove ${contract.verification.target} from ${currentScope.name} or evolve/archive the contract intentionally`,
            forbidden.snippet,
          )
        : pass();
    }
    case 'call_presence': {
      const calls = extractCalls(parsed, currentScope);
      const target = contract.verification.target;
      const nearStart = contract.verification.params?.near_start === true;
      const beforeFirstSideEffect = contract.verification.params?.before_first_side_effect === true;
      const transactionScopedDbWrite = contract.verification.params?.transaction_scoped_db_write === true;
      const expectedPathKind = paramString(contract.verification.params?.path_kind);
      const found = nearStart
        ? firstStatementsContainCall(currentScope, calls, (call) => callMatches(call.callee, target)) !== null
        : calls.some((call) => callMatches(call.callee, target));
      if (found && beforeFirstSideEffect) {
        const targetCall = calls.find((call) => callMatches(call.callee, target));
        const firstSideEffect = calls.find((call) => isSideEffectCall(call) !== null);
        if (targetCall && firstSideEffect && targetCall.node.getStart() > firstSideEffect.node.getStart()) {
          return violated(
            `Required call ${target} no longer happens before the first side effect`,
            `Move ${target} before side-effecting work in ${currentScope.name}`,
            'required call occurs too late',
          );
        }
      }
      if (found && transactionScopedDbWrite) {
        const hasProtectedWrite = calls.some((call) => isSideEffectCall(call) === 'db_write' && isInsideTransactionCall(call));
        if (!hasProtectedWrite) {
          return violated(
            `No database write remains protected by ${target}`,
            `Keep database writes inside ${target}'s transaction callback`,
            'transaction scoped db write absent',
          );
        }
      }
      if (found && expectedPathKind === 'unconditional') {
        const targetCall = calls.find((call) => callMatches(call.callee, target));
        if (targetCall && (isCallConditionallyNested(currentScope, targetCall) || hasExitBeforeCall(currentScope, targetCall))) {
          return violated(
            `Required call ${target} is no longer unconditional`,
            `Keep ${target} on all execution paths in ${currentScope.name}`,
            'call path became conditional',
          );
        }
      }
      if (!found && expectedPathKind === 'conditional') return pass();
      return found
        ? pass()
        : violated(`Required call ${target} is missing`, `Restore a call to ${target} in ${currentScope.name}`, 'call absent');
    }
    case 'type_check': {
      const expected = paramString(contract.verification.params?.expected_return);
      const expectedNoThrow = contract.verification.params?.no_throw;
      const actual = getReturnType(typeContext, parsed, currentScope);
      if (expected && actual !== expected) {
        return violated(
          `Return type changed from ${expected} to ${actual}`,
          `Keep the ${expected} contract or run drift evolve ${contract.id} with evidence for an intentional migration`,
          `return=${actual}`,
        );
      }
      const actualNoThrow = !hasThrowStatement(currentScope);
      if (typeof expectedNoThrow === 'boolean' && actualNoThrow !== expectedNoThrow) {
        return violated(
          `Throw behavior changed: expected no_throw=${String(expectedNoThrow)}, got no_throw=${String(actualNoThrow)}`,
          'Restore the previous error boundary behavior or evolve the contract with caller/test evidence',
          `no_throw=${String(actualNoThrow)}`,
        );
      }
      const expectedParameters = JSON.stringify(contract.verification.params?.parameters ?? []);
      if (expectedParameters !== '[]') {
        const actualParameters = JSON.stringify(getParameterInfo(typeContext, parsed, currentScope));
        if (actualParameters !== expectedParameters) {
          return violated(
            'Parameter type/nullability contract changed',
            `Keep ${currentScope.name}'s parameter types and nullability stable or evolve the contract intentionally`,
            `parameters=${actualParameters}`,
          );
        }
      }
      return pass();
    }
    case 'import_presence': {
      const imports = extractImports(parsed);
      const requiredNames = arrayOfStrings(contract.verification.params?.names);
      const requiredNamed = namedImportParams(contract.verification.params?.named);
      const requiredDefault = paramString(contract.verification.params?.default);
      const requiredNamespace = paramString(contract.verification.params?.namespace);
      const requiredTypeOnly = contract.verification.params?.type_only;
      const matchingImports = imports.filter((item) =>
        item.module === contract.verification.target
        && (typeof requiredTypeOnly !== 'boolean' || item.typeOnly === requiredTypeOnly),
      );
      const allNames = new Set(matchingImports.flatMap((item) => item.names));
      const allNamed = matchingImports.flatMap((item) => item.named);
      const exists = matchingImports.length > 0
        && requiredNames.every((name) => allNames.has(name))
        && requiredNamed.every((required) => allNamed.some((actual) => actual.imported === required.imported && actual.local === required.local))
        && (!requiredDefault || matchingImports.some((item) => item.default === requiredDefault))
        && (!requiredNamespace || matchingImports.some((item) => item.namespace === requiredNamespace));
      return exists
        ? pass()
        : violated(
            `Required import ${contract.verification.target} is missing`,
            `Restore import from ${contract.verification.target} or evolve the import constraint`,
            'import absent',
          );
    }
    case 'error_strategy': {
      const expected = paramString(contract.verification.params?.strategy);
      const actual = detectErrorHandling(parsed, currentScope)?.strategy ?? 'none';
      return actual === expected
        ? pass()
        : violated(
            `Error handling changed from ${expected} to ${actual}`,
            'Restore the prior catch strategy or evolve the contract with explicit evidence',
            `strategy=${actual}`,
          );
    }
    case 'ast_query':
      try {
        return findTreeSitterPattern(parsed, contract.verification.target, currentScope)
          ? pass()
          : violated(
              `AST query did not match: ${contract.verification.target}`,
              'Restore the queried AST pattern or evolve/archive this contract intentionally',
              'ast query absent',
            );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return violated(`Invalid AST query in contract: ${message}`, 'Fix or archive the malformed contract', 'invalid ast query');
      }
    case 'control_path':
      return pass();
  }
}

function maybeEvolve(config: DriftConfig, result: VerifyResult, contract: Contract, scope: string, file: string): Evolution | null {
  if (!config.evolution.auto_evolve) return null;
  if (contract.severity === 'critical') return null;
  if (contract.pattern !== 'return_type' && contract.pattern !== 'error_boundary') return null;
  const evolution: Evolution = {
    contract,
    scope,
    file,
    change: result.newState ?? result.reason,
    confidence: 0,
  };
  const decision = decideEvolution(evolution, process.env.DRIFT_COMMIT_MESSAGE ?? '', [{ file, contractType: contract.type, pattern: contract.pattern, isModified: true }]);
  if (decision.action !== 'auto_evolve') return null;
  return { ...evolution, confidence: decision.confidence, decision };
}

function pass(): VerifyResult {
  return { status: 'passed', reason: '', suggestion: '' };
}

function violated(reason: string, suggestion: string, newState?: string): VerifyResult {
  return { status: 'violated', reason, suggestion, newState };
}

function paramString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function namedImportParams(value: unknown): Array<{ imported: string; local: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { imported: string; local: string } =>
    typeof item === 'object'
    && item !== null
    && typeof (item as { imported?: unknown }).imported === 'string'
    && typeof (item as { local?: unknown }).local === 'string',
  );
}

async function resolveTargetFiles(
  rootDir: string,
  config: DriftConfig,
  store: ContractStore,
  options: CheckOptions,
): Promise<string[]> {
  if (options.files && options.files.length > 0) return options.files.map(normalizeRepoRelative);
  if (options.staged) return stagedFiles(rootDir).filter((file) => sourceMatchesConfig(file, config));
  if (options.diff) return diffFiles(rootDir, options.diff).filter((file) => sourceMatchesConfig(file, config));
  const discovered = await discoverSourceFiles(rootDir, config);
  let manifest: ReturnType<ContractStore['readManifest']>;
  try {
    manifest = store.readManifest();
  } catch {
    manifest = null;
  }
  if (manifest && manifest.contracts.length > 0) {
    const manifestFiles = manifest.contracts.map((entry) => normalizeRepoRelative(entry.source_file)).filter((file) => sourceMatchesConfig(file, config));
    return [...new Set([...manifestFiles, ...discovered])].sort();
  }
  return discovered;
}

function moduleScope(parsed: ParsedFile): ScopeInfo {
  return {
    name: '<module>',
    kind: 'module',
    qualified_name: '<module>',
    signature_hash: '<module>',
    node_hash: '<module>',
    node: parsed.sourceFile,
    line_start: 1,
    line_end: parsed.sourceFile.getLineAndCharacterOfPosition(parsed.sourceText.length).line + 1,
    snippet: '<module>',
  };
}

function integrityIssueToViolation(issue: IntegrityIssue): Violation {
  return {
    type: 'integrity',
    severity: issue.severity,
    file: issue.file,
    reason: issue.message,
    suggestion:
      issue.type === 'config_tampered'
        ? 'Review the config change and run drift init to regenerate the signed manifest'
        : 'Restore the contract file or use drift ignore/evolve so the manifest is updated intentionally',
  };
}

function isActiveContract(contract: Contract): boolean {
  return contract.status !== 'ignored' && contract.status !== 'archived';
}
