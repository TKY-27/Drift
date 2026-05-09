import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function resolveProjectRoot(startDir: string): string {
  const resolvedStart = fs.existsSync(startDir) ? fs.realpathSync(startDir) : path.resolve(startDir);
  const driftRoot = findUp(resolvedStart, path.join('.drift', 'config.json'));
  if (driftRoot) return driftRoot;
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedStart,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
    if (output) return fs.existsSync(output) ? fs.realpathSync(output) : path.resolve(output);
  } catch {
    // Non-Git directories are valid for `drift init`; use the current directory.
  }
  return resolvedStart;
}

function findUp(startDir: string, relativeFile: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate) && !fs.lstatSync(candidate).isSymbolicLink()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
