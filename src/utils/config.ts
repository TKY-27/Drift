import fs from 'node:fs';
import path from 'node:path';
import type { DriftConfig, Reporter } from '../types/config.js';
import { defaultConfig } from '../types/config.js';
import type { Severity } from '../types/contract.js';
import { globMatches, readJsonFile, SecurityError, validateRepoGlob, writeJsonFile } from './security.js';

const CONFIG_MAX_BYTES = 128 * 1024;
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 240;
const severities: Severity[] = ['critical', 'high', 'medium', 'low'];

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && severities.includes(value as Severity);
}

export function isReporter(value: unknown): value is Reporter {
  return value === 'terminal' || value === 'json' || value === 'github';
}

export function configPath(rootDir: string): string {
  return path.join(rootDir, '.drift', 'config.json');
}

export function ensureConfig(rootDir: string): DriftConfig {
  assertDriftDirIsNotSymlink(rootDir);
  const target = configPath(rootDir);
  if (!fs.existsSync(target)) {
    writeJsonFile(target, defaultConfig);
    return defaultConfig;
  }
  return loadConfig(rootDir);
}

export function loadConfig(rootDir: string): DriftConfig {
  assertDriftDirIsNotSymlink(rootDir);
  const target = configPath(rootDir);
  if (!fs.existsSync(target)) return defaultConfig;
  const parsed = readJsonFile<Partial<DriftConfig>>(target, CONFIG_MAX_BYTES, '.drift/config.json');
  return normalizeConfig(parsed);
}

export function saveConfig(rootDir: string, config: DriftConfig): void {
  assertDriftDirIsNotSymlink(rootDir);
  fs.mkdirSync(path.join(rootDir, '.drift'), { recursive: true, mode: 0o755 });
  writeJsonFile(configPath(rootDir), normalizeConfig(config));
}

function assertDriftDirIsNotSymlink(rootDir: string): void {
  const driftDir = path.join(rootDir, '.drift');
  if (fs.existsSync(driftDir) && fs.lstatSync(driftDir).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked .drift directory: ${driftDir}`);
  }
  const config = path.join(driftDir, 'config.json');
  if (fs.existsSync(config) && fs.lstatSync(config).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked .drift/config.json: ${config}`);
  }
}

export function normalizeConfig(input: Partial<DriftConfig>): DriftConfig {
  if (input.severity_threshold !== undefined && !isSeverity(input.severity_threshold)) {
    throw new SecurityError(`Unsupported severity_threshold in .drift/config.json: ${String(input.severity_threshold)}`);
  }
  if (input.git_hook !== undefined && (!isPlainObject(input.git_hook))) {
    throw new SecurityError('Config git_hook must be an object');
  }
  if (input.git_hook?.block_on !== undefined && !isSeverity(input.git_hook.block_on)) {
    throw new SecurityError(`Unsupported git_hook.block_on in .drift/config.json: ${String(input.git_hook.block_on)}`);
  }
  if (input.patterns !== undefined && !isPlainObject(input.patterns)) {
    throw new SecurityError('Config patterns must be an object');
  }
  if (input.patterns) {
    for (const [pattern, value] of Object.entries(input.patterns)) {
      if (!isPlainObject(value)) throw new SecurityError(`Config pattern ${pattern} must be an object`);
      if (value.severity !== undefined && !isSeverity(value.severity)) {
        throw new SecurityError(`Unsupported severity for pattern ${pattern}: ${String(value.severity)}`);
      }
    }
  }

  const merged: DriftConfig = {
    ...defaultConfig,
    ...input,
    llm: { ...defaultConfig.llm, ...input.llm },
    evolution: { ...defaultConfig.evolution, ...input.evolution },
    git_hook: { ...defaultConfig.git_hook, ...input.git_hook },
    patterns: { ...defaultConfig.patterns, ...input.patterns },
  };

  merged.include = normalizePatterns(input.include, defaultConfig.include, 'include');
  merged.exclude = [
    ...new Set([
      ...normalizePatterns(input.exclude, defaultConfig.exclude, 'exclude'),
      '**/node_modules/**',
      '**/dist/**',
      '**/.drift/**',
      '**/.git/**',
    ]),
  ];

  if (!isSeverity(merged.severity_threshold)) throw new SecurityError(`Unsupported severity_threshold in .drift/config.json: ${String(merged.severity_threshold)}`);
  if (!isSeverity(merged.git_hook.block_on)) throw new SecurityError(`Unsupported git_hook.block_on in .drift/config.json: ${String(merged.git_hook.block_on)}`);
  if (!isReporter(merged.reporter)) throw new SecurityError(`Unsupported reporter in .drift/config.json: ${String(merged.reporter)}`);

  for (const [pattern, value] of Object.entries(merged.patterns)) {
    merged.patterns[pattern] = {
      enabled: value?.enabled !== false,
      severity: isSeverity(value?.severity) ? value.severity : defaultConfig.patterns[pattern]?.severity ?? 'medium',
    };
  }

  if (merged.llm.enabled) {
    // LLM can write descriptions, but it is never part of trust decisions.
    merged.llm.enabled = false;
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePatterns(value: unknown, fallback: string[], label: string): string[] {
  const source = Array.isArray(value) ? value : fallback;
  const patterns = source.filter((item): item is string => typeof item === 'string').map(validateRepoGlob);
  if (patterns.length === 0) throw new SecurityError(`Config ${label} must contain at least one safe pattern`);
  if (patterns.length > MAX_PATTERNS) throw new SecurityError(`Config ${label} contains too many patterns`);
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) throw new SecurityError(`Config ${label} pattern is too long: ${pattern.slice(0, 40)}`);
  }
  return patterns;
}

export function isPatternEnabled(config: DriftConfig, pattern: string): boolean {
  return config.patterns[pattern]?.enabled === true;
}

export function patternSeverity(config: DriftConfig, pattern: string, fallback: Severity): Severity {
  return config.patterns[pattern]?.severity ?? fallback;
}

export function sourceMatchesConfig(file: string, config: DriftConfig): boolean {
  if (!/\.[cm]?[tj]sx?$/.test(file)) return false;
  if (isHardExcluded(file)) return false;
  return config.include.some((pattern) => globMatches(file, pattern)) && !config.exclude.some((pattern) => globMatches(file, pattern));
}

function isHardExcluded(file: string): boolean {
  return file.includes('/node_modules/')
    || file.startsWith('node_modules/')
    || file.includes('/dist/')
    || file.startsWith('dist/')
    || file.includes('/.drift/')
    || file.startsWith('.drift/')
    || file.includes('/.git/')
    || file.startsWith('.git/');
}
