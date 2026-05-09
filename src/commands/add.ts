import fs from 'node:fs';
import type { Contract, ContractFile, ContractType, DetectionMethod, Severity, VerificationStrategy } from '../types/contract.js';
import { ContractStore } from '../core/store.js';
import { normalizeRepoRelative, resolveRepoPath, sha256, safeSnippet } from '../utils/security.js';
import { loadConfig, sourceMatchesConfig } from '../utils/config.js';
import { nanoid } from 'nanoid';

export function addCommand(
  rootDir: string,
  file: string,
  options: {
    scope?: string;
    type?: ContractType;
    severity?: Severity;
    pattern?: string;
    description?: string;
    strategy?: VerificationStrategy;
    target?: string;
  } = {},
): void {
  if (!options.description || !options.target) {
    process.stderr.write('drift add requires --description and --target.\n');
    process.exitCode = 1;
    return;
  }
  const sourceFile = normalizeRepoRelative(file);
  const config = loadConfig(rootDir);
  if (!sourceMatchesConfig(sourceFile, config)) {
    process.stderr.write(`Source file is outside Drift include/exclude configuration: ${sourceFile}\n`);
    process.exitCode = 1;
    return;
  }
  const store = new ContractStore(rootDir);
  const absolute = resolveRepoPath(rootDir, sourceFile, `source file ${sourceFile}`);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    process.stderr.write(`Source file not found: ${sourceFile}\n`);
    process.exitCode = 1;
    return;
  }
  const existing = store.load(sourceFile);
  const now = new Date().toISOString();
  const contract: Contract = {
    id: `ct_${nanoid(8)}`,
    type: options.type ?? 'invariant',
    description: safeSnippet(options.description, 500),
    pattern: options.pattern ?? 'custom',
    detection: 'ast_pattern' satisfies DetectionMethod,
    severity: options.severity ?? 'medium',
    status: 'active',
    evidence: [
      {
        type: 'pattern_match',
        line_start: 1,
        line_end: 1,
        snippet: 'manual contract',
        reasoning: 'Added manually by drift add',
      },
    ],
    verification: {
      strategy: options.strategy ?? 'call_presence',
      target: options.target,
    },
    crystallized_at: now,
    last_verified_at: now,
  };
  const contractFile: ContractFile =
    existing ??
    {
      source_file: sourceFile,
      source_hash: sha256(fs.readFileSync(absolute)),
      scopes: [],
      meta: {
        drift_version: '0.1.1',
        crystallized_at: now,
        last_checked_at: now,
        total_contracts: 0,
      },
    };
  const scopeName = options.scope ?? '<module>';
  let scope = contractFile.scopes.find((item) => item.name === scopeName);
  if (!scope) {
    scope = { name: scopeName, kind: scopeName === '<module>' ? 'module' : 'function', line_start: 1, line_end: 1, contracts: [] };
    contractFile.scopes.push(scope);
  }
  scope.contracts.push(contract);
  contractFile.meta.total_contracts = contractFile.scopes.reduce((sum, item) => sum + item.contracts.length, 0);
  store.save(contractFile);
  store.writeManifestFromCurrentContracts();
  process.stdout.write(`Added ${contract.id} to ${sourceFile}\n`);
}
