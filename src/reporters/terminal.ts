import chalk from 'chalk';
import type { ContractFile, Severity } from '../types/contract.js';
import type { CrystallizeResult } from '../core/crystallizer.js';
import type { CheckResult, Violation } from '../core/watcher.js';
import { safeSnippet } from '../utils/security.js';

const severityColor: Record<Severity, (value: string) => string> = {
  critical: chalk.hex('#ff3d00'),
  high: chalk.hex('#ffc53d'),
  medium: chalk.hex('#00d68f'),
  low: chalk.hex('#3d8bff'),
};

const logo = [
  '  ╺━┓┏━╸╻╺┳╸',
  '  ╺━╋╋━╸┃ ┃   drift v0.1.1',
  '  ╺━┛┗━╸╹ ╹   semantic integrity engine',
].join('\n');

export function renderInit(result: CrystallizeResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.hex('#ff3d00')(logo));
  lines.push('');
  lines.push('  Crystallizing semantic contracts');
  lines.push('');
  lines.push(`  Scanned ${result.files.length} files in ${(result.durationMs / 1000).toFixed(2)}s`);
  lines.push('');
  for (const file of result.files.filter((item) => item.meta.total_contracts > 0).slice(0, 8)) {
    lines.push(`  ${chalk.hex('#3d8bff')(terminalText(file.source_file))}`);
    for (const scope of file.scopes) {
      for (const contract of scope.contracts.slice(0, 4)) {
        lines.push(
          `    ${severityColor[contract.severity]('●')} ${severityColor[contract.severity](contract.severity.toUpperCase().padEnd(8))} ${terminalText(contract.description)}`,
        );
      }
    }
  }
  const hidden = result.files.filter((item) => item.meta.total_contracts > 0).length - 8;
  if (hidden > 0) lines.push(`  ... ${hidden} more files`);
  lines.push('');
  lines.push(`  Contracts crystallized: ${chalk.bold(String(result.totalContracts))}`);
  lines.push('  Saved to: .drift/contracts/');
  lines.push('');
  lines.push(`  Run ${chalk.hex('#00d68f')('drift watch')} to install the git hook.`);
  return lines.join('\n');
}

export function renderCheck(result: CheckResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${chalk.hex('#ff3d00')('Drift')} - Checking ${result.summary.files_checked} file(s) against ${result.summary.contracts_verified} contract(s)`);
  lines.push('');
  for (const violation of result.violations) {
    lines.push(renderViolation(violation));
    lines.push(`  ${chalk.dim('─────────────────────────────────────────')}`);
  }
  for (const warning of result.warnings) {
    lines.push(`  ${chalk.hex('#ffc53d')('WARN')} ${terminalText(warning)}`);
  }
  const passed = Math.max(0, result.summary.contracts_verified - result.violations.length);
  lines.push('');
  lines.push(
    `  Summary: ${severityCount(result.violations)}  ${chalk.hex('#00d68f')(`${passed} passed`)}  ${result.summary.auto_evolved} evolved`,
  );
  if (result.violations.length > 0) {
    lines.push(`  ${chalk.hex('#ff3d00')('Commit blocked if any violation meets the configured threshold.')}`);
  }
  return lines.join('\n');
}

export function renderStatus(stats: {
  totalFiles: number;
  totalContracts: number;
  bySeverity: Record<Severity, number>;
  byType: Record<string, number>;
}): string {
  return [
    '',
    chalk.hex('#ff3d00')(logo),
    '',
    '  Status',
    '',
    `  Contract files: ${stats.totalFiles}`,
    `  Active contracts: ${stats.totalContracts}`,
    '',
    `  Critical: ${severityColor.critical(String(stats.bySeverity.critical))}`,
    `  High:     ${severityColor.high(String(stats.bySeverity.high))}`,
    `  Medium:   ${severityColor.medium(String(stats.bySeverity.medium))}`,
    `  Low:      ${severityColor.low(String(stats.bySeverity.low))}`,
    '',
    `  Types: ${Object.entries(stats.byType)
      .map(([type, count]) => `${terminalText(type)}=${count}`)
      .join(', ') || 'none'}`,
  ].join('\n');
}

export function renderLs(files: ContractFile[]): string {
  const lines: string[] = [''];
  for (const file of files) {
    lines.push(`  ${chalk.hex('#3d8bff')(terminalText(file.source_file))}`);
    for (const scope of file.scopes) {
      for (const contract of scope.contracts) {
        const status = contract.status === 'active' ? '' : chalk.dim(` [${terminalText(contract.status)}]`);
        lines.push(
          `    ${terminalText(contract.id)} ${severityColor[contract.severity](contract.severity.padEnd(8))} ${terminalText(scope.name)} ${terminalText(contract.pattern)}${status}`,
        );
        lines.push(`      ${chalk.dim(terminalText(contract.description))}`);
      }
    }
  }
  if (lines.length === 1) lines.push('  No contracts found.');
  return lines.join('\n');
}

function renderViolation(violation: Violation): string {
  const sev = severityColor[violation.severity](violation.severity.toUpperCase());
  const lines = [
    `  ${chalk.hex('#ff3d00')('CONTRACT VIOLATION')} ${sev} in ${chalk.hex('#3d8bff')(terminalText(violation.file))}`,
  ];
  if (violation.scope && violation.contract) {
    lines.push(`  ${chalk.hex('#ff6b3d')(terminalText(violation.scope))} [${terminalText(violation.contract.pattern)}] ${chalk.dim(terminalText(violation.contract.id))}`);
    lines.push(`  ${chalk.dim(`"${terminalText(violation.contract.description)}"`)}`);
  }
  lines.push(`  Reason: ${terminalText(violation.reason)}`);
  lines.push(`  Suggested fix: ${terminalText(violation.suggestion)}`);
  if (violation.old_evidence?.[0]) {
    lines.push(`  Before: ${chalk.dim(terminalText(violation.old_evidence[0].snippet))}`);
  }
  if (violation.new_state) {
    lines.push(`  Current: ${chalk.dim(terminalText(violation.new_state))}`);
  }
  return lines.join('\n');
}

function severityCount(violations: Violation[]): string {
  if (violations.length === 0) return chalk.hex('#00d68f')('0 violations');
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const violation of violations) counts[violation.severity] += 1;
  return (Object.entries(counts) as [Severity, number][])
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => severityColor[severity](`${count} ${severity}`))
    .join('  ');
}

function terminalText(value: string, maxLength = 500): string {
  return safeSnippet(value, maxLength);
}
