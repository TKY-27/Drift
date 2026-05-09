import { Command, InvalidArgumentError } from 'commander';
import { initCommand, refreshCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { statusCommand } from './commands/status.js';
import { lsCommand } from './commands/ls.js';
import { evolveCommand } from './commands/evolve.js';
import { ignoreCommand } from './commands/ignore.js';
import { watchCommand, unwatchCommand } from './commands/watch.js';
import { addCommand } from './commands/add.js';
import type { ContractType, Severity, VerificationStrategy } from './types/contract.js';
import type { Reporter } from './types/config.js';
import { safeSnippet } from './utils/security.js';
import { resolveProjectRoot } from './utils/root.js';

const program = new Command();
const projectRoot = (): string => resolveProjectRoot(process.cwd());

program
  .name('drift')
  .description('Semantic Integrity Engine - guard the meaning of AI-modified code')
  .version('0.1.1');

program
  .command('init')
  .description('Analyze the codebase and crystallize semantic contracts')
  .option('--include <glob>', 'Override include patterns (comma-separated)')
  .option('--exclude <glob>', 'Override exclude patterns (comma-separated)')
  .option('--llm', 'Enable LLM description generation in config')
  .option('--verbose', 'Show detailed extraction progress')
  .option('--dry-run', 'Show what would be extracted without saving')
  .option('--force', 'Overwrite existing Drift contracts without prompting')
  .option('--reporter <reporter>', 'terminal, json, or github', parseReporter)
  .action(async (options: { include?: string; exclude?: string; llm?: boolean; verbose?: boolean; dryRun?: boolean; force?: boolean; reporter?: string }) =>
    initCommand(projectRoot(), options),
  );

program
  .command('check')
  .description('Verify current code against crystallized contracts')
  .argument('[files...]', 'Specific source files to check')
  .option('--staged', 'Check Git staged files only')
  .option('--diff <ref>', 'Check files changed against a Git ref')
  .option('--baseline-ref <ref>', 'Trusted Git ref for .drift integrity comparison')
  .option('--reporter <reporter>', 'terminal, json, or github', parseReporter)
  .option('--severity <severity>', 'critical, high, medium, low', parseSeverity)
  .option('--severity-threshold <severity>', 'critical, high, medium, low', parseSeverity)
  .action(async (files: string[], options: { staged?: boolean; diff?: string; baselineRef?: string; reporter?: Reporter; severity?: Severity; severityThreshold?: Severity }) =>
    checkCommand(projectRoot(), files, options),
  );

program
  .command('ci')
  .description('CI mode: JSON output and exit code')
  .option('--staged', 'Check Git staged files only')
  .option('--diff <ref>', 'Check files changed against a Git ref')
  .option('--baseline-ref <ref>', 'Trusted Git ref for .drift integrity comparison')
  .option('--severity-threshold <severity>', 'critical, high, medium, low', parseSeverity)
  .action(async (options: { staged?: boolean; diff?: string; baselineRef?: string; severityThreshold?: Severity }) => {
    if (!options.baselineRef) {
      process.stderr.write('drift ci requires --baseline-ref <ref> so CI compares .drift against a trusted base.\n');
      process.exitCode = 1;
      return;
    }
    await checkCommand(projectRoot(), [], { ...options, reporter: 'json' });
  });

program
  .command('watch')
  .description('Install a Git pre-commit hook that runs drift check --staged')
  .action(() => watchCommand(projectRoot()));

program
  .command('unwatch')
  .description('Remove the Drift Git hook block')
  .action(() => unwatchCommand(projectRoot()));

program
  .command('status')
  .description('Show contract summary')
  .option('--reporter <reporter>', 'terminal, json, or github', parseReporter)
  .action((options: { reporter?: string }) => statusCommand(projectRoot(), options));

program
  .command('ls')
  .description('List all contracts, or contracts for a specific file')
  .argument('[file]', 'Source file')
  .option('--reporter <reporter>', 'terminal, json, or github', parseReporter)
  .action((file: string | undefined, options: { reporter?: string }) => lsCommand(projectRoot(), file, options));

program
  .command('evolve')
  .description('Manually evolve a contract')
  .argument('<id>', 'Contract id')
  .option('--reason <reason>', 'Reason for evolution')
  .option('--description <description>', 'Updated description')
  .action((id: string, options: { reason?: string; description?: string }) => evolveCommand(projectRoot(), id, options));

program
  .command('ignore')
  .description('Ignore a contract until it is intentionally restored')
  .argument('<id>', 'Contract id')
  .option('--reason <reason>', 'Reason for archiving')
  .action((id: string, options: { reason?: string }) => ignoreCommand(projectRoot(), id, options));

program
  .command('refresh')
  .description('Re-crystallize contracts from current source files')
  .option('--reporter <reporter>', 'terminal, json, or github', parseReporter)
  .action(async (options: { reporter?: string }) => refreshCommand(projectRoot(), options));

program
  .command('add')
  .description('Add a manual custom contract')
  .argument('<file>', 'Source file')
  .requiredOption('--description <description>', 'Human-readable contract description')
  .requiredOption('--target <target>', 'Verification target, such as a required call')
  .option('--scope <scope>', 'Scope name')
  .option('--type <type>', 'invariant, boundary, side_effect, dependency', parseContractType)
  .option('--severity <severity>', 'critical, high, medium, low', parseSeverity)
  .option('--pattern <pattern>', 'Pattern name', 'custom')
  .option('--strategy <strategy>', 'Verification strategy', parseVerificationStrategy, 'call_presence')
  .action((file: string, options: Parameters<typeof addCommand>[2]) => addCommand(projectRoot(), file, options));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.DRIFT_DEBUG_STACK === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${safeSnippet(message, 1000)}\n`);
  process.exitCode = 1;
});

function parseSeverity(value: string): Severity {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') return value;
  throw new InvalidArgumentError('Expected one of: critical, high, medium, low');
}

function parseReporter(value: string): Reporter {
  if (value === 'terminal' || value === 'json' || value === 'github') return value;
  throw new InvalidArgumentError('Expected one of: terminal, json, github');
}

function parseContractType(value: string): ContractType {
  if (value === 'invariant' || value === 'boundary' || value === 'side_effect' || value === 'dependency') return value;
  throw new InvalidArgumentError('Expected one of: invariant, boundary, side_effect, dependency');
}

function parseVerificationStrategy(value: string): VerificationStrategy {
  if (
    value === 'ast_query' ||
    value === 'pattern_absent' ||
    value === 'call_presence' ||
    value === 'call_absence' ||
    value === 'type_check' ||
    value === 'pattern_exists' ||
    value === 'control_path' ||
    value === 'import_presence' ||
    value === 'error_strategy'
  ) {
    return value;
  }
  throw new InvalidArgumentError('Expected a supported verification strategy');
}
