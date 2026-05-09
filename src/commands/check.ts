import { checkProject, shouldBlock } from '../core/watcher.js';
import { loadConfig } from '../utils/config.js';
import { renderCheck } from '../reporters/terminal.js';
import { renderJson } from '../reporters/json.js';
import { renderGithubCheck } from '../reporters/github.js';
import type { Severity } from '../types/contract.js';

export async function checkCommand(
  rootDir: string,
  files: string[],
  options: { staged?: boolean; diff?: string; baselineRef?: string; reporter?: string; severity?: Severity; severityThreshold?: Severity } = {},
): Promise<void> {
  const config = loadConfig(rootDir);
  const checkOptions: Parameters<typeof checkProject>[2] = { files };
  if (options.staged !== undefined) checkOptions.staged = options.staged;
  if (options.diff !== undefined) checkOptions.diff = options.diff;
  if (options.baselineRef !== undefined) checkOptions.baselineRef = options.baselineRef;
  const result = await checkProject(rootDir, config, checkOptions);
  const reporter = options.reporter ?? config.reporter;
  if (reporter === 'json') process.stdout.write(renderJson(result));
  else if (reporter === 'github') process.stdout.write(renderGithubCheck(result));
  else process.stdout.write(`${renderCheck(result)}\n`);
  const threshold = options.severity ?? options.severityThreshold ?? (options.staged ? config.git_hook.block_on : config.severity_threshold);
  if (shouldBlock(result, threshold)) process.exitCode = 1;
}
