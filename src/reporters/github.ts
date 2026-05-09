import type { CheckResult, Violation } from '../core/watcher.js';
import { safeSnippet } from '../utils/security.js';

export function renderGithubCheck(result: CheckResult): string {
  const lines: string[] = [];
  lines.push('## Drift Semantic Integrity');
  lines.push('');
  lines.push(`Checked ${result.summary.files_checked} file(s) against ${result.summary.contracts_verified} contract(s).`);
  lines.push('');
  if (result.violations.length === 0) {
    lines.push('No contract violations found.');
  } else {
    lines.push('| Severity | File | Scope | Contract | Reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const violation of result.violations) {
      lines.push(violationRow(violation));
    }
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const warning of result.warnings) lines.push(`- ${markdownText(warning)}`);
  }
  lines.push('');
  lines.push(`Summary: ${result.violations.length} violation(s), ${result.summary.auto_evolved} evolution(s).`);
  return `${lines.join('\n')}\n`;
}

function violationRow(violation: Violation): string {
  const scope = violation.scope ?? '';
  const contract = violation.contract ? `${violation.contract.pattern} (${violation.contract.id})` : violation.type;
  return [
    violation.severity,
    codeText(violation.file),
    markdownText(scope),
    markdownText(contract),
    markdownText(violation.reason),
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function markdownText(value: string): string {
  return safeSnippet(value, 300)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('@', '@\u200B')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function codeText(value: string): string {
  return `\`${markdownText(value).replaceAll('`', '')}\``;
}
