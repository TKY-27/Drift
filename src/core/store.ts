import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Contract, ContractFile, ContractScope, ContractSummary, Severity, VerificationStrategy } from '../types/contract.js';
import { severityOrder } from '../types/contract.js';
import { normalizeRepoRelative, resolveInside, safeSnippet, sha256, stripUnsafeText, toPosixRelative, writeJsonFile } from '../utils/security.js';
import { loadConfig as readDriftConfig, normalizeConfig } from '../utils/config.js';
import type { DriftConfig } from '../types/config.js';

const CONTRACT_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

export interface ManifestEntry {
  source_file: string;
  contract_file: string;
  contract_hash: string;
}

export interface DriftManifest {
  version: string;
  generated_at: string;
  config_hash: string;
  contracts: ManifestEntry[];
}

export interface IntegrityIssue {
  severity: Severity;
  type:
    | 'missing_contract'
    | 'contract_tampered'
    | 'config_tampered'
    | 'manifest_missing'
    | 'config_missing'
    | 'contract_weakened';
  file: string;
  message: string;
}

export type StoreReadMode = 'worktree' | 'index';

export interface ContractStoreOptions {
  readMode?: StoreReadMode;
}

export interface IntegrityOptions {
  baselineRef?: string | undefined;
}

export interface HistoryEntry {
  date: string;
  action: string;
  source_file?: string;
  contract_id?: string;
  reason?: string;
}

export class ContractStore {
  readonly rootDir: string;
  readonly driftDir: string;
  readonly contractsDir: string;
  readonly manifestPath: string;
  readonly readMode: StoreReadMode;

  constructor(rootDir: string, options: ContractStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.driftDir = path.join(this.rootDir, '.drift');
    this.contractsDir = path.join(this.driftDir, 'contracts');
    this.manifestPath = path.join(this.driftDir, 'manifest.json');
    this.readMode = options.readMode ?? 'worktree';
  }

  contractDir(): string {
    return this.contractsDir;
  }

  configPath(): string {
    return path.join(this.driftDir, 'config.json');
  }

  historyPath(): string {
    return path.join(this.driftDir, 'history.jsonl');
  }

  ensureDirs(): void {
    this.assertTrustedDriftPath(this.driftDir);
    this.assertTrustedDriftPath(this.contractsDir);
    fs.mkdirSync(this.contractsDir, { recursive: true, mode: 0o755 });
  }

  contractPath(sourceFile: string): string {
    const safeSource = normalizeRepoRelative(sourceFile);
    this.assertTrustedDriftPath(this.driftDir);
    this.assertTrustedDriftPath(this.contractsDir);
    return resolveInside(this.contractsDir, `${safeSource}.json`);
  }

  contractPathFor(sourceFile: string): string {
    return this.contractPath(sourceFile);
  }

  sourcePathFor(contractPath: string): string {
    const relative = toPosixRelative(this.contractsDir, contractPath);
    return relative.endsWith('.json') ? relative.slice(0, -'.json'.length) : relative;
  }

  contractRelativePath(sourceFile: string): string {
    return `.drift/contracts/${normalizeRepoRelative(sourceFile)}.json`;
  }

  load(sourceFile: string): ContractFile | null {
    const relative = this.contractRelativePath(sourceFile);
    const parsed = this.readJsonRelative<ContractFile>(relative, CONTRACT_MAX_BYTES, `contract ${sourceFile}`);
    return parsed ? validateContractFile(parsed, `contract ${sourceFile}`) : null;
  }

  save(contractFile: ContractFile): void {
    if (this.readMode !== 'worktree') throw new Error('Cannot save contracts while reading from the Git index');
    this.ensureDirs();
    const source = normalizeRepoRelative(contractFile.source_file);
    const canonical = sanitizeContractFile({
      ...contractFile,
      source_file: source,
    });
    validateContractFile(canonical, `contract ${source}`);
    const target = this.contractPath(source);
    writeJsonFile(target, canonical);
  }

  loadConfig(): DriftConfig {
    return readDriftConfig(this.rootDir);
  }

  saveConfig(config: DriftConfig): void {
    if (this.readMode !== 'worktree') throw new Error('Cannot save config while reading from the Git index');
    this.ensureDirs();
    writeJsonFile(this.configPath(), normalizeConfig(config));
  }

  listFiles(): string[] {
    this.assertTrustedDriftPath(this.driftDir);
    this.assertTrustedDriftPath(this.contractsDir);
    if (this.readMode === 'index') {
      return gitLsFiles(this.rootDir, '.drift/contracts')
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(this.rootDir, file));
    }
    if (!fs.existsSync(this.contractsDir)) return [];
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (fs.lstatSync(full).isSymbolicLink()) throw new Error(`Refusing to follow symlink in .drift/contracts: ${full}`);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && full.endsWith('.json')) files.push(full);
      }
    };
    visit(this.contractsDir);
    return files;
  }

  listAll(): ContractSummary[] {
    return this.listFiles().map((file) => {
      const contract = this.readContractFileByPath(file);
      return {
        file: contract.source_file,
        contracts: contract.meta.total_contracts,
        severity: countSeverity(contract),
      };
    });
  }

  stats(): { totalFiles: number; totalContracts: number; bySeverity: Record<Severity, number>; byType: Record<string, number> } {
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    const byType: Record<string, number> = {};
    let totalContracts = 0;
    for (const file of this.listFiles()) {
      const contract = this.readContractFileByPath(file);
      for (const scope of contract.scopes) {
        for (const item of scope.contracts) {
          if (isInactiveStatus(item.status)) continue;
          bySeverity[item.severity] += 1;
          byType[item.type] = (byType[item.type] ?? 0) + 1;
          totalContracts += 1;
        }
      }
    }
    return { totalFiles: this.listFiles().length, totalContracts, bySeverity, byType };
  }

  findContract(id: string): { file: ContractFile; contract: Contract; sourceFile: string } | null {
    for (const file of this.listFiles()) {
      const contractFile = this.readContractFileByPath(file);
      for (const scope of contractFile.scopes) {
        const contract = scope.contracts.find((item) => item.id === id);
        if (contract) return { file: contractFile, contract, sourceFile: contractFile.source_file };
      }
    }
    return null;
  }

  updateContract(id: string, updater: (contract: Contract) => void): Contract | null {
    const found = this.findContract(id);
    if (!found) return null;
    updater(found.contract);
    found.file.meta.last_checked_at = new Date().toISOString();
    found.file.meta.total_contracts = found.file.scopes.reduce((sum, scope) => sum + scope.contracts.length, 0);
    this.save(found.file);
    this.writeManifestFromCurrentContracts();
    return found.contract;
  }

  evolveContract(sourceFile: string, contractId: string, update: Partial<Contract>, reason: string): void {
    const contractFile = this.load(sourceFile);
    if (!contractFile) throw new Error(`Contract file not found for ${sourceFile}`);
    const contract = contractFile.scopes.flatMap((scope) => scope.contracts).find((item) => item.id === contractId);
    if (!contract) throw new Error(`Contract not found: ${contractId}`);
    const from = contract.description;
    Object.assign(contract, update);
    contract.status = update.status ?? 'evolved';
    contract.last_verified_at = new Date().toISOString();
    contract.evolution_history = [
      ...(contract.evolution_history ?? []),
      {
        date: new Date().toISOString(),
        from_description: from,
        to_description: contract.description,
        reason,
        commit_hash: 'manual',
        confidence: 1,
      },
    ];
    this.save(contractFile);
    this.writeManifestFromCurrentContracts();
    this.appendHistory({ date: new Date().toISOString(), action: 'evolve', source_file: sourceFile, contract_id: contractId, reason });
  }

  ignoreContract(sourceFile: string, contractId: string): void {
    this.evolveContract(sourceFile, contractId, { status: 'ignored' }, 'manual ignore');
  }

  archiveContract(sourceFile: string, contractId: string): void {
    this.evolveContract(sourceFile, contractId, { status: 'archived' }, 'manual archive');
  }

  listForFile(sourceFile: string): ContractScope[] {
    return this.load(sourceFile)?.scopes ?? [];
  }

  appendHistory(entry: HistoryEntry): void {
    if (this.readMode !== 'worktree') throw new Error('Cannot append history while reading from the Git index');
    this.ensureDirs();
    const safeEntry = {
      date: stripUnsafeText(entry.date),
      action: stripUnsafeText(entry.action),
      source_file: entry.source_file ? normalizeRepoRelative(entry.source_file) : undefined,
      contract_id: entry.contract_id ? stripUnsafeText(entry.contract_id) : undefined,
      reason: entry.reason ? safeSnippet(entry.reason, 500) : undefined,
    };
    fs.appendFileSync(this.historyPath(), `${JSON.stringify(safeEntry)}\n`, { mode: 0o644 });
  }

  ensureDriftDir(): void {
    this.ensureDirs();
  }

  isInitialized(): boolean {
    return fs.existsSync(this.driftDir) && fs.existsSync(this.configPath());
  }

  readManifest(): DriftManifest | null {
    const manifest = this.readJsonRelative<DriftManifest>('.drift/manifest.json', MANIFEST_MAX_BYTES, '.drift/manifest.json');
    return manifest ? validateManifest(manifest) : null;
  }

  writeManifestFromCurrentContracts(): DriftManifest {
    if (this.readMode !== 'worktree') throw new Error('Cannot write manifest while reading from the Git index');
    this.ensureDirs();
    const configRaw = this.readTextRelative('.drift/config.json', 128 * 1024);
    const configHash = configRaw ? sha256(configRaw) : '';
    const contracts = this.listFiles()
      .map((contractFile) => {
        const contract = this.readContractFileByPath(contractFile);
        return {
          source_file: contract.source_file,
          contract_file: toPosixRelative(this.rootDir, contractFile),
          contract_hash: sha256(fs.readFileSync(contractFile)),
        };
      })
      .sort((a, b) => a.source_file.localeCompare(b.source_file));
    const manifest: DriftManifest = {
      version: '0.1.1',
      generated_at: new Date().toISOString(),
      config_hash: configHash,
      contracts,
    };
    writeJsonFile(this.manifestPath, manifest);
    return manifest;
  }

  integrityIssues(options: IntegrityOptions = {}): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    let manifest: DriftManifest | null;
    try {
      manifest = this.readManifest();
    } catch (error) {
      issues.push({
        severity: 'critical',
        type: 'manifest_missing',
        file: '.drift/manifest.json',
        message: error instanceof Error ? error.message : String(error),
      });
      issues.push(...this.gitBaselineIssues(options.baselineRef));
      return deduplicateIssues(issues);
    }
    if (!manifest) {
      const hasContracts = this.listFiles().length > 0;
      if (hasContracts) {
        issues.push({
          severity: 'critical',
          type: 'manifest_missing',
          file: '.drift/manifest.json',
          message: '.drift/manifest.json is missing while contract files exist',
        });
      }
      issues.push(...this.gitBaselineIssues(options.baselineRef));
      return deduplicateIssues(issues);
    }
    if (manifest.config_hash) {
      const currentConfigRaw = this.readTextRelative('.drift/config.json', 128 * 1024);
      if (!currentConfigRaw) {
        issues.push({
          severity: 'critical',
          type: 'config_missing',
          file: '.drift/config.json',
          message: '.drift/config.json is missing',
        });
      } else {
        const currentConfigHash = sha256(currentConfigRaw);
        if (currentConfigHash !== manifest.config_hash) {
          issues.push({
            severity: 'high',
            type: 'config_tampered',
            file: '.drift/config.json',
            message: '.drift/config.json changed outside Drift commands; rerun drift init/refresh or review the change',
          });
        }
      }
    }
    for (const baselineIssue of this.gitBaselineIssues(options.baselineRef)) {
      issues.push(baselineIssue);
    }
    for (const entry of manifest.contracts) {
      let contractPath: string;
      try {
        contractPath = this.resolveManifestContractPath(entry);
      } catch (error) {
        issues.push({
          severity: 'critical',
          type: 'contract_tampered',
          file: entry.source_file,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const contractRaw = this.readTextRelative(entry.contract_file, CONTRACT_MAX_BYTES);
      if (!contractRaw) {
        issues.push({
          severity: 'critical',
          type: 'missing_contract',
          file: entry.source_file,
          message: `Contract file is missing for ${entry.source_file}`,
        });
        continue;
      }
      const contract = validateContractFile(parseJsonObject<ContractFile>(contractRaw, `contract ${contractPath}`, CONTRACT_MAX_BYTES), `contract ${contractPath}`);
      if (contract.source_file !== entry.source_file) {
        issues.push({
          severity: 'critical',
          type: 'contract_tampered',
          file: entry.source_file,
          message: `Manifest source_file ${entry.source_file} does not match contract source_file ${contract.source_file}`,
        });
      }
      const currentHash = sha256(contractRaw);
      if (currentHash !== entry.contract_hash) {
        issues.push({
          severity: 'critical',
          type: 'contract_tampered',
          file: entry.source_file,
          message: `Contract file hash changed for ${entry.source_file}; use drift evolve/ignore to update contracts`,
        });
      }
    }
    const manifestContractFiles = new Set(manifest.contracts.map((entry) => entry.contract_file));
    for (const contractFile of this.listFiles()) {
      const relative = toPosixRelative(this.rootDir, contractFile);
      if (!manifestContractFiles.has(relative)) {
        issues.push({
          severity: 'high',
          type: 'contract_tampered',
          file: relative,
          message: `Contract file ${relative} is not listed in .drift/manifest.json`,
        });
      }
    }
    return deduplicateIssues(issues);
  }

  private gitBaselineIssues(baselineRef = 'HEAD'): IntegrityIssue[] {
    validateGitObjectRef(baselineRef);
    const baselineManifestRaw = gitShow(this.rootDir, `${baselineRef}:.drift/manifest.json`);
    if (!baselineManifestRaw) return [];
    const issues: IntegrityIssue[] = [];
    let baselineManifest: DriftManifest;
    try {
      baselineManifest = validateManifest(JSON.parse(baselineManifestRaw) as DriftManifest);
    } catch {
      return [
        {
          severity: 'critical',
          type: 'contract_weakened',
          file: '.drift/manifest.json',
          message: `Trusted baseline ${baselineRef} contains an invalid .drift/manifest.json`,
        },
      ];
    }
    const baselineConfigRaw = gitShow(this.rootDir, `${baselineRef}:.drift/config.json`);
    const currentConfigRaw = this.readTextRelative('.drift/config.json', 128 * 1024);
    if (baselineConfigRaw && currentConfigRaw && sha256(baselineConfigRaw) !== sha256(currentConfigRaw)) {
      issues.push({
        severity: 'critical',
        type: 'config_tampered',
        file: '.drift/config.json',
        message: `.drift/config.json changed from trusted baseline ${baselineRef}; review and refresh the manifest intentionally`,
      });
    }
    for (const entry of baselineManifest.contracts) {
      const rawBaselineContract = gitShow(this.rootDir, `${baselineRef}:${entry.contract_file}`);
      if (!rawBaselineContract) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: entry.source_file,
          message: `Trusted baseline contract file is missing: ${entry.contract_file}`,
        });
        continue;
      }
      let baselineContractFile: ContractFile;
      try {
        baselineContractFile = validateContractFile(JSON.parse(rawBaselineContract) as ContractFile, `${baselineRef}:${entry.contract_file}`);
      } catch {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: entry.source_file,
          message: `Trusted baseline contract file is invalid: ${entry.contract_file}`,
        });
        continue;
      }
      const current = this.load(entry.source_file);
      if (!current) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: entry.source_file,
          message: `Previously committed contract file is missing for ${entry.source_file}`,
        });
        continue;
      }
      issues.push(...compareContractFiles(entry.source_file, baselineContractFile, current));
    }
    return issues;
  }

  private assertTrustedDriftPath(targetPath: string): void {
    const root = path.resolve(this.rootDir);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Trusted Drift path escapes repository: ${targetPath}`);
    }
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) continue;
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to use symlink inside .drift path: ${current}`);
      }
    }
  }

  private readContractFileByPath(file: string): ContractFile {
    const relative = toPosixRelative(this.rootDir, file);
    const parsed = this.readJsonRelative<ContractFile>(relative, CONTRACT_MAX_BYTES, `contract ${relative}`);
    if (!parsed) throw new Error(`Contract file disappeared while reading: ${relative}`);
    return validateContractFile(parsed, `contract ${relative}`);
  }

  private readJsonRelative<T>(relativePath: string, maxBytes: number, label: string): T | null {
    const raw = this.readTextRelative(relativePath, maxBytes);
    if (raw === null) return null;
    return parseJsonObject<T>(raw, label, maxBytes);
  }

  private readTextRelative(relativePath: string, maxBytes = 4 * 1024 * 1024): string | null {
    const relative = normalizeRepoRelative(relativePath);
    if (this.readMode === 'index') return gitShow(this.rootDir, `:${relative}`, maxBytes);
    const absolute = resolveInside(this.rootDir, relative);
    if (!fs.existsSync(absolute)) return null;
    const lst = fs.lstatSync(absolute);
    if (lst.isSymbolicLink()) throw new Error(`Refusing to read symlinked metadata: ${relative}`);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`Metadata path is not a regular file: ${relative}`);
    if (stat.nlink > 1) throw new Error(`Refusing to read hardlinked metadata: ${relative}`);
    if (stat.size > maxBytes) throw new Error(`${relative} is too large (${stat.size} bytes)`);
    return fs.readFileSync(absolute, 'utf8');
  }

  private resolveManifestContractPath(entry: ManifestEntry): string {
    const expected = this.contractRelativePath(entry.source_file);
    if (entry.contract_file !== expected) {
      throw new Error(`Manifest contract_file ${entry.contract_file} does not match expected ${expected}`);
    }
    return resolveInside(this.rootDir, entry.contract_file);
  }
}

function countSeverity(contractFile: ContractFile): Record<Severity, number> {
  const count: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const scope of contractFile.scopes) {
    for (const contract of scope.contracts) {
      if (!isInactiveStatus(contract.status)) count[contract.severity] += 1;
    }
  }
  return count;
}

function compareContractFiles(sourceFile: string, baseline: ContractFile, current: ContractFile): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const currentById = new Map<string, Contract>();
  for (const scope of current.scopes) {
    for (const contract of scope.contracts) currentById.set(contract.id, contract);
  }
  for (const baselineScope of baseline.scopes) {
    for (const baselineContract of baselineScope.contracts) {
      if (isInactiveStatus(baselineContract.status)) continue;
      const currentContract = currentById.get(baselineContract.id);
      if (!currentContract) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Tracked contract ${baselineContract.id} was removed from ${sourceFile}`,
        });
        continue;
      }
      const hasEvolution = (currentContract.evolution_history?.length ?? 0) > (baselineContract.evolution_history?.length ?? 0);
      if (severityOrder[currentContract.severity] < severityOrder[baselineContract.severity]) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} severity was lowered from ${baselineContract.severity} to ${currentContract.severity}`,
        });
      }
      if (currentContract.pattern !== baselineContract.pattern) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} pattern changed from ${baselineContract.pattern} to ${currentContract.pattern}`,
        });
      }
      if (currentContract.detection !== baselineContract.detection) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} detection changed from ${baselineContract.detection} to ${currentContract.detection}`,
        });
      }
      if (currentContract.description !== baselineContract.description && !hasEvolution) {
        issues.push({
          severity: 'high',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} description changed without evolution history`,
        });
      }
      if (currentContract.status !== baselineContract.status && !isReviewableStatusTransition(baselineContract, currentContract)) {
        issues.push({
          severity: 'critical',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} status changed from ${baselineContract.status} to ${currentContract.status} without a reviewable evolution record`,
        });
      }
      if (JSON.stringify(currentContract.verification) !== JSON.stringify(baselineContract.verification)) {
        issues.push({
          severity: 'high',
          type: 'contract_weakened',
          file: sourceFile,
          message: `Contract ${baselineContract.id} verification changed; verification changes require a trusted baseline update`,
        });
      }
    }
  }
  return issues;
}

function validateManifest(manifest: DriftManifest): DriftManifest {
  if (typeof manifest.version !== 'string' || typeof manifest.generated_at !== 'string' || typeof manifest.config_hash !== 'string') {
    throw new Error('Invalid manifest metadata');
  }
  if (!Array.isArray(manifest.contracts)) throw new Error('Invalid manifest contracts');
  const seenFiles = new Set<string>();
  const contracts: ManifestEntry[] = [];
  for (const entry of manifest.contracts) {
    const sourceFile = normalizeRepoRelative(entry.source_file);
    const contractFile = normalizeRepoRelative(entry.contract_file);
    const expected = `.drift/contracts/${sourceFile}.json`;
    if (contractFile !== expected) throw new Error(`Manifest contract_file ${contractFile} must equal ${expected}`);
    if (seenFiles.has(sourceFile)) throw new Error(`Duplicate manifest entry for ${sourceFile}`);
    seenFiles.add(sourceFile);
    if (!/^[a-f0-9]{64}$/.test(entry.contract_hash)) throw new Error(`Invalid contract hash for ${entry.source_file}`);
    contracts.push({ source_file: sourceFile, contract_file: contractFile, contract_hash: entry.contract_hash });
  }
  return {
    version: stripUnsafeText(manifest.version),
    generated_at: stripUnsafeText(manifest.generated_at),
    config_hash: stripUnsafeText(manifest.config_hash),
    contracts,
  };
}

const contractTypes = new Set(['invariant', 'boundary', 'side_effect', 'dependency']);
const detectionMethods = new Set(['ast_pattern', 'type_analysis', 'control_flow', 'call_graph', 'import_graph']);
const severities = new Set(['critical', 'high', 'medium', 'low']);
const statuses = new Set(['active', 'evolved', 'ignored', 'archived']);
const strategies = new Set<VerificationStrategy>([
  'pattern_exists',
  'pattern_absent',
  'control_path',
  'ast_query',
  'call_presence',
  'call_absence',
  'type_check',
  'import_presence',
  'error_strategy',
]);

function validateContractFile(contractFile: ContractFile, label: string): ContractFile {
  normalizeRepoRelative(contractFile.source_file);
  if (!/^[a-f0-9]{64}$/.test(contractFile.source_hash)) throw new Error(`${label}: invalid source_hash`);
  if (!Array.isArray(contractFile.scopes)) throw new Error(`${label}: scopes must be an array`);
  if (typeof contractFile.meta !== 'object' || contractFile.meta === null) throw new Error(`${label}: invalid meta`);
  if (!Number.isInteger(contractFile.meta.total_contracts)) throw new Error(`${label}: invalid total_contracts`);
  for (const scope of contractFile.scopes) {
    if (typeof scope.name !== 'string' || scope.name.length > 500) throw new Error(`${label}: invalid scope name`);
    if (!['function', 'method', 'class', 'module'].includes(scope.kind)) throw new Error(`${label}: invalid scope kind`);
    if (!Number.isInteger(scope.line_start) || !Number.isInteger(scope.line_end)) throw new Error(`${label}: invalid scope line range`);
    if (!Array.isArray(scope.contracts)) throw new Error(`${label}: contracts must be an array`);
    for (const contract of scope.contracts) validateContract(contract, label);
  }
  return sanitizeContractFile(contractFile);
}

function validateContract(contract: Contract, label: string): void {
  if (typeof contract.id !== 'string' || !/^ct_[A-Za-z0-9_-]+$/.test(contract.id)) throw new Error(`${label}: invalid contract id`);
  if (!contractTypes.has(contract.type)) throw new Error(`${label}: invalid contract type`);
  if (!detectionMethods.has(contract.detection)) throw new Error(`${label}: invalid detection method`);
  if (!severities.has(contract.severity)) throw new Error(`${label}: invalid severity`);
  if (!statuses.has(contract.status)) throw new Error(`${label}: invalid status`);
  if (typeof contract.pattern !== 'string' || contract.pattern.length > 200 || typeof contract.description !== 'string' || contract.description.length > 1000) {
    throw new Error(`${label}: invalid contract text`);
  }
  if (!Array.isArray(contract.evidence)) throw new Error(`${label}: invalid evidence`);
  for (const evidence of contract.evidence) {
    if (typeof evidence.snippet !== 'string' || evidence.snippet.length > 1000 || typeof evidence.reasoning !== 'string' || evidence.reasoning.length > 1000) {
      throw new Error(`${label}: invalid evidence text`);
    }
    if (!Number.isInteger(evidence.line_start) || !Number.isInteger(evidence.line_end)) throw new Error(`${label}: invalid evidence lines`);
  }
  if (!strategies.has(contract.verification.strategy)) throw new Error(`${label}: invalid verification strategy`);
  if (typeof contract.verification.target !== 'string' || contract.verification.target.length > 1000) {
    throw new Error(`${label}: invalid verification target`);
  }
  if (contract.evolution_history) {
    if (!Array.isArray(contract.evolution_history)) throw new Error(`${label}: invalid evolution history`);
    for (const item of contract.evolution_history) {
      if (
        typeof item.date !== 'string'
        || typeof item.from_description !== 'string'
        || typeof item.to_description !== 'string'
        || typeof item.reason !== 'string'
        || typeof item.commit_hash !== 'string'
        || typeof item.confidence !== 'number'
      ) {
        throw new Error(`${label}: invalid evolution history entry`);
      }
    }
  }
}

function isInactiveStatus(status: Contract['status']): boolean {
  return status === 'ignored' || status === 'archived';
}

function isReviewableStatusTransition(baseline: Contract, current: Contract): boolean {
  if (baseline.status !== 'active') return false;
  if (current.status !== 'evolved') return false;
  return (current.evolution_history?.length ?? 0) > (baseline.evolution_history?.length ?? 0);
}

function sanitizeContract(contract: Contract): Contract {
  const sanitized: Contract = {
    ...contract,
    description: safeSnippet(contract.description, 500),
    pattern: stripUnsafeText(contract.pattern),
    evidence: contract.evidence.map((item) => ({
      ...item,
      snippet: safeSnippet(item.snippet, 500),
      reasoning: safeSnippet(item.reasoning, 500),
    })),
    verification: {
      ...contract.verification,
      target: stripUnsafeText(contract.verification.target),
    },
    crystallized_at: stripUnsafeText(contract.crystallized_at),
    last_verified_at: stripUnsafeText(contract.last_verified_at),
  };
  const params = sanitizeJsonValue(contract.verification.params);
  if (params !== undefined) sanitized.verification.params = params as Record<string, unknown>;
  if (contract.evolution_history) {
    sanitized.evolution_history = contract.evolution_history.map((item) => ({
      date: stripUnsafeText(item.date),
      from_description: safeSnippet(item.from_description, 500),
      to_description: safeSnippet(item.to_description, 500),
      reason: safeSnippet(item.reason, 500),
      commit_hash: stripUnsafeText(item.commit_hash),
      confidence: Math.max(0, Math.min(1, item.confidence)),
    }));
  }
  return sanitized;
}

function sanitizeContractFile(contractFile: ContractFile): ContractFile {
  const scopes = contractFile.scopes.map(sanitizeScope);
  return {
    ...contractFile,
    source_file: normalizeRepoRelative(contractFile.source_file),
    scopes,
    meta: {
      drift_version: stripUnsafeText(contractFile.meta.drift_version),
      crystallized_at: stripUnsafeText(contractFile.meta.crystallized_at),
      last_checked_at: stripUnsafeText(contractFile.meta.last_checked_at),
      total_contracts: scopes.reduce((sum, scope) => sum + scope.contracts.length, 0),
    },
  };
}

function sanitizeScope(scope: ContractScope): ContractScope {
  const sanitized: ContractScope = {
    ...scope,
    name: safeSnippet(scope.name, 500),
    kind: scope.kind,
    line_start: scope.line_start,
    line_end: scope.line_end,
    contracts: scope.contracts.map(sanitizeContract),
  };
  if (scope.qualified_name) sanitized.qualified_name = safeSnippet(scope.qualified_name, 500);
  if (scope.signature_hash) sanitized.signature_hash = stripUnsafeText(scope.signature_hash);
  if (scope.node_hash) sanitized.node_hash = stripUnsafeText(scope.node_hash);
  return sanitized;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return stripUnsafeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [stripUnsafeText(key), sanitizeJsonValue(entry)]));
  }
  return value;
}

function parseJsonObject<T>(raw: string, label: string, maxBytes: number): T {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`${label} is too large`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as T;
}

function gitShow(rootDir: string, spec: string, maxBytes = 8 * 1024 * 1024): string | null {
  try {
    const size = execFileSync('git', ['cat-file', '-s', spec], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
    const parsedSize = Number(size);
    if (!Number.isSafeInteger(parsedSize) || parsedSize > maxBytes) {
      throw new Error(`${spec} is too large (${size} bytes)`);
    }
    return execFileSync('git', ['show', spec], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: maxBytes,
    });
  } catch {
    return null;
  }
}

function gitLsFiles(rootDir: string, pathspec: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', pathspec], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean).map(normalizeRepoRelative);
  } catch {
    return [];
  }
}

function validateGitObjectRef(ref: string): void {
  if (!ref || ref.startsWith('-') || [...ref].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
  if (
    ref.includes('..')
    || ref.includes('~')
    || ref.includes('^')
    || ref.includes(':')
    || ref.includes('\\')
    || ref.includes('@{')
  ) {
    throw new Error(`Unsupported git ref syntax: ${ref}`);
  }
}

function deduplicateIssues(issues: IntegrityIssue[]): IntegrityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.file}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
