import { crystallizeProject } from '../core/crystallizer.js';
import { ensureConfig, loadConfig, normalizeConfig, saveConfig } from '../utils/config.js';
import { renderInit } from '../reporters/terminal.js';
import { renderJson } from '../reporters/json.js';
import fs from 'node:fs';
import path from 'node:path';
import type { DriftConfig } from '../types/config.js';

export interface InitOptions {
  include?: string;
  exclude?: string;
  llm?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  force?: boolean;
  reporter?: string;
}

export async function initCommand(rootDir: string, options: InitOptions = {}): Promise<void> {
  if (fs.existsSync(path.join(rootDir, '.drift')) && !options.force && !options.dryRun) {
    process.stderr.write('Drift is already initialized. Use --force to refresh generated contracts, or drift refresh to preserve manual contracts.\n');
    process.exitCode = 1;
    return;
  }
  const baseConfig = options.dryRun ? loadConfig(rootDir) : ensureConfig(rootDir);
  const config = applyInitOverrides(baseConfig, options);
  if (!options.dryRun) saveConfig(rootDir, config);
  warnIfDriftIgnored(rootDir);
  if (options.verbose) process.stderr.write(`Drift scanning include=${config.include.join(',')} exclude=${config.exclude.join(',')}\n`);
  const crystallizeOptions = options.dryRun === undefined ? {} : { dryRun: options.dryRun };
  const result = await crystallizeProject(rootDir, config, crystallizeOptions);
  const reporter = options.reporter ?? config.reporter;
  process.stdout.write(reporter === 'json' ? renderJson(result) : `${renderInit(result)}\n`);
}

export async function refreshCommand(rootDir: string, options: { reporter?: string } = {}): Promise<void> {
  const config = loadConfig(rootDir);
  const result = await crystallizeProject(rootDir, config, { preserveExisting: true });
  const reporter = options.reporter ?? config.reporter;
  process.stdout.write(reporter === 'json' ? renderJson(result) : `${renderInit(result)}\n`);
}

function applyInitOverrides(config: DriftConfig, options: InitOptions): DriftConfig {
  const next: DriftConfig = {
    ...config,
    include: options.include ? splitPatterns(options.include) : config.include,
    exclude: options.exclude ? splitPatterns(options.exclude) : config.exclude,
    llm: {
      ...config.llm,
      enabled: options.llm === true,
    },
  };
  return normalizeConfig(next);
}

function splitPatterns(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function warnIfDriftIgnored(rootDir: string): void {
  const gitignore = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(gitignore)) return;
  const ignored = fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).some((line) => line.trim() === '.drift' || line.trim() === '.drift/');
  if (ignored) {
    process.stderr.write('Warning: .gitignore ignores .drift, but Drift contracts must be committed.\n');
  }
}
