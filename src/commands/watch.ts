import { installHook, uninstallHook } from '../git/hooks.js';

export function watchCommand(rootDir: string): void {
  const result = installHook(rootDir);
  process.stdout.write(`Drift pre-commit hook ${result}. It requires local ./node_modules/.bin/drift and never downloads via npx.\n`);
}

export function unwatchCommand(rootDir: string): void {
  const result = uninstallHook(rootDir);
  process.stdout.write(result === 'removed' ? 'Drift pre-commit hook removed.\n' : 'No Drift hook block found.\n');
}
