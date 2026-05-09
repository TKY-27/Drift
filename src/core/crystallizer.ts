import path from 'node:path';
import fs from 'node:fs';
import { glob } from 'glob';
import type { DriftConfig } from '../types/config.js';
import type { Contract, ContractFile, ContractScope } from '../types/contract.js';
import { parseSource, extractScopes, type ParsedFile, type ScopeInfo } from '../analyzers/ast.js';
import { createTypeContext, type TypeContext } from '../analyzers/types.js';
import { detectContractsForModule, detectContractsForScope } from '../analyzers/pattern-matchers/index.js';
import { normalizeRepoRelative, resolveRepoPath, safeReadTextFile, sha256, toPosixRelative } from '../utils/security.js';
import { sourceMatchesConfig } from '../utils/config.js';
import { ContractStore } from './store.js';

const MAX_DISCOVERED_SOURCE_FILES = 5000;
const MAX_DISCOVERED_SOURCE_BYTES = 128 * 1024 * 1024;

export interface CrystallizeResult {
  files: ContractFile[];
  totalContracts: number;
  durationMs: number;
}

export interface CrystallizeOptions {
  preserveExisting?: boolean;
  dryRun?: boolean;
}

export async function discoverSourceFiles(rootDir: string, config: DriftConfig): Promise<string[]> {
  const files = await glob(config.include, {
    cwd: rootDir,
    ignore: config.exclude,
    nodir: true,
    absolute: false,
    posix: true,
    follow: false,
  });
  const sourceFiles = files.map(normalizeRepoRelative).filter((file) => sourceMatchesConfig(file, config)).sort();
  if (sourceFiles.length > MAX_DISCOVERED_SOURCE_FILES) {
    throw new Error(`Too many source files matched Drift config (${sourceFiles.length}); narrow .drift/config.json include patterns`);
  }
  let totalBytes = 0;
  for (const file of sourceFiles) {
    const stat = fs.statSync(resolveRepoPath(rootDir, file, `source file ${file}`));
    totalBytes += stat.size;
    if (totalBytes > MAX_DISCOVERED_SOURCE_BYTES) {
      throw new Error('Drift source scan exceeds the configured safety byte limit; narrow .drift/config.json include patterns');
    }
  }
  return sourceFiles;
}

export async function crystallizeProject(rootDir: string, config: DriftConfig, options: CrystallizeOptions = {}): Promise<CrystallizeResult> {
  const started = Date.now();
  const sourceFiles = await discoverSourceFiles(rootDir, config);
  const typeContext = createTypeContext(rootDir, sourceFiles.map((file) => path.join(rootDir, file)));
  const store = new ContractStore(rootDir);
  if (!options.dryRun) store.ensureDirs();
  const files: ContractFile[] = [];
  for (const sourceFile of sourceFiles) {
    const fresh = crystallizeFile(rootDir, config, sourceFile, typeContext);
    const contract = options.preserveExisting ? mergeWithExisting(store.load(sourceFile), fresh) : fresh;
    if (!options.dryRun) store.save(contract);
    files.push(contract);
  }
  if (!options.dryRun) store.writeManifestFromCurrentContracts();
  return {
    files,
    totalContracts: files.reduce((sum, file) => sum + file.meta.total_contracts, 0),
    durationMs: Date.now() - started,
  };
}

export function crystallizeFile(rootDir: string, config: DriftConfig, sourceFile: string, typeContext?: TypeContext): ContractFile {
  const normalized = normalizeRepoRelative(sourceFile);
  const absolute = path.join(rootDir, normalized);
  const sourceText = safeReadTextFile(rootDir, normalized, 4 * 1024 * 1024, `source file ${normalized}`);
  const parsed = parseSource(normalized, sourceText);
  const context = typeContext ?? createTypeContext(rootDir, [absolute]);
  const scopes = extractScopes(parsed)
    .filter((scope) => scope.kind === 'function' || scope.kind === 'method')
    .map((scope) => crystallizeScope(config, parsed, context, scope));

  const moduleScope = crystallizeModuleScope(config, parsed);
  if (moduleScope.contracts.length > 0) scopes.unshift(moduleScope);

  const now = new Date().toISOString();
  return {
    source_file: toPosixRelative(rootDir, absolute),
    source_hash: sha256(sourceText),
    scopes,
    meta: {
      drift_version: '0.1.1',
      crystallized_at: now,
      last_checked_at: now,
      total_contracts: scopes.reduce((sum, scope) => sum + scope.contracts.length, 0),
    },
  };
}

function crystallizeScope(config: DriftConfig, parsed: ParsedFile, typeContext: TypeContext, scope: ScopeInfo): ContractScope {
  const contracts = detectContractsForScope(config, parsed, scope, typeContext);
  return {
    name: scope.name,
    kind: scope.kind,
    qualified_name: scope.qualified_name,
    signature_hash: scope.signature_hash,
    node_hash: scope.node_hash,
    line_start: scope.line_start,
    line_end: scope.line_end,
    contracts,
  };
}

function crystallizeModuleScope(config: DriftConfig, parsed: ParsedFile): ContractScope {
  const moduleScope: ScopeInfo = {
    name: '<module>',
    kind: 'module',
    qualified_name: '<module>',
    signature_hash: sha256('<module>').slice(0, 16),
    node_hash: sha256(parsed.sourceText).slice(0, 16),
    node: parsed.sourceFile,
    line_start: 1,
    line_end: parsed.sourceFile.getLineAndCharacterOfPosition(parsed.sourceText.length).line + 1,
    snippet: '<module>',
  };
  return {
    name: moduleScope.name,
    kind: 'module',
    qualified_name: moduleScope.qualified_name,
    signature_hash: moduleScope.signature_hash,
    node_hash: moduleScope.node_hash,
    line_start: moduleScope.line_start,
    line_end: moduleScope.line_end,
    contracts: detectContractsForModule(config, parsed, moduleScope, {
      rootDir: '',
      program: null,
      checker: null,
    }),
  };
}

function mergeWithExisting(existing: ContractFile | null, fresh: ContractFile): ContractFile {
  if (!existing) return fresh;
  const mergedScopes = fresh.scopes.map((freshScope) => {
    const existingScope = findMatchingScope(existing.scopes, freshScope);
    if (!existingScope) return freshScope;
    const freshContracts = freshScope.contracts.map((contract) => {
    const previous = findMatchingContract(existingScope.contracts, contract);
      if (!previous) return contract;
      const preserved: Contract = {
        ...contract,
        id: previous.id,
        status: previous.status,
        crystallized_at: previous.crystallized_at,
      };
      if (previous.evolution_history) preserved.evolution_history = previous.evolution_history;
      return preserved;
    });
    const freshIds = new Set(freshContracts.map((contract) => contract.id));
    const retainedManual = existingScope.contracts.filter((contract) => !freshIds.has(contract.id));
    return {
      ...freshScope,
      contracts: uniqueById([...freshContracts, ...retainedManual]),
    };
  });
  for (const existingScope of existing.scopes) {
    if (!mergedScopes.some((scope) => scopesMatch(scope, existingScope))) {
      const retained = existingScope.contracts;
      if (retained.length > 0) mergedScopes.push({ ...existingScope, contracts: retained });
    }
  }
  return {
    ...fresh,
    scopes: mergedScopes,
    meta: {
      ...fresh.meta,
      crystallized_at: existing.meta.crystallized_at,
      total_contracts: mergedScopes.reduce((sum, scope) => sum + scope.contracts.length, 0),
    },
  };
}

function findMatchingScope(scopes: ContractScope[], target: ContractScope): ContractScope | null {
  return scopes.find((scope) => scopesMatch(scope, target)) ?? null;
}

function scopesMatch(left: ContractScope, right: ContractScope): boolean {
  if (left.qualified_name && right.qualified_name) return left.qualified_name === right.qualified_name && left.kind === right.kind;
  if (hasSpecificQualifiedName(left) || hasSpecificQualifiedName(right)) return false;
  return left.name === right.name && left.kind === right.kind;
}

function findMatchingContract(contracts: Contract[], target: Contract): Contract | null {
  return contracts.find((contract) =>
    contract.pattern === target.pattern
    && contract.type === target.type
    && contract.verification.strategy === target.verification.strategy
    && contract.verification.target === target.verification.target
    && JSON.stringify(contract.verification.params ?? {}) === JSON.stringify(target.verification.params ?? {}),
  ) ?? null;
}

function uniqueById(contracts: Contract[]): Contract[] {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    if (seen.has(contract.id)) return false;
    seen.add(contract.id);
    return true;
  });
}

function hasSpecificQualifiedName(scope: ContractScope): boolean {
  return Boolean(scope.qualified_name && scope.qualified_name !== scope.name);
}
