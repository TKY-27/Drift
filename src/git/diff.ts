import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRepoRelative } from '../utils/security.js';

const GIT_LIST_MAX_BUFFER = 8 * 1024 * 1024;
const STAGED_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

export function findGitDir(rootDir: string): string | null {
  const direct = path.join(rootDir, '.git');
  if (fs.existsSync(direct)) {
    if (fs.lstatSync(direct).isSymbolicLink()) throw new Error(`Refusing to use symlinked .git directory: ${direct}`);
    if (fs.statSync(direct).isDirectory()) return direct;
  }
  try {
    const output = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const gitDir = path.isAbsolute(output) ? path.resolve(output) : path.resolve(rootDir, output);
    const root = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
    const realGitDir = fs.existsSync(gitDir) ? fs.realpathSync(gitDir) : gitDir;
    const relative = path.relative(root, realGitDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing outside-repository Git directory: ${output}`);
    }
    if (fs.existsSync(gitDir) && fs.lstatSync(gitDir).isSymbolicLink()) throw new Error(`Refusing symlinked Git directory: ${gitDir}`);
    return realGitDir;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing ')) throw error;
    return null;
  }
}

export function stagedFiles(rootDir: string): string[] {
  const output = execFileSync('git', ['diff', '--cached', '--name-status', '-z', '-M', '--diff-filter=ACMRD'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  return unique(parseNameStatus(output).flatMap((change) => (change.oldPath ? [change.oldPath, change.path] : [change.path])));
}

export function stagedFileContent(rootDir: string, file: string): string | null {
  const safeFile = normalizeRepoRelative(file);
  try {
    const size = stagedFileSize(rootDir, safeFile);
    if (size !== null && size > STAGED_SOURCE_MAX_BYTES) {
      throw new Error(`Staged file is too large (${size} bytes): ${safeFile}`);
    }
    return execFileSync('git', ['show', `:${safeFile}`], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: STAGED_SOURCE_MAX_BYTES,
    });
  } catch {
    return null;
  }
}

export function stagedFileSize(rootDir: string, file: string): number | null {
  const safeFile = normalizeRepoRelative(file);
  try {
    const output = execFileSync('git', ['cat-file', '-s', `:${safeFile}`], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
    const size = Number(output);
    return Number.isSafeInteger(size) ? size : null;
  } catch {
    return null;
  }
}

export function diffFiles(rootDir: string, ref = 'HEAD'): string[] {
  validateGitRef(ref);
  const output = execFileSync('git', ['diff', '--name-status', '-z', '-M', '--diff-filter=ACMRD', ref, '--'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  return unique(parseNameStatus(output).flatMap((change) => (change.oldPath ? [change.oldPath, change.path] : [change.path])));
}

export function unstagedDriftFiles(rootDir: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--', '.drift'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_LIST_MAX_BUFFER,
    });
    return unique(output
      .split('\0')
      .filter(Boolean)
      .filter((entry) => entry.startsWith('??') || entry[1] !== ' ')
      .map((entry) => entry.slice(3).split(' -> ').pop() ?? '')
      .filter(Boolean)
      .map(normalizeRepoRelative));
  } catch {
    return [];
  }
}

export function unmergedFiles(rootDir: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '-u', '-z'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_LIST_MAX_BUFFER,
    });
    return unique(output
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.split('\t')[1] ?? '')
      .filter(Boolean)
      .map(normalizeRepoRelative));
  } catch {
    return [];
  }
}

export function stagedBinaryFiles(rootDir: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--numstat', '-z'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_LIST_MAX_BUFFER,
    });
    return unique(output
      .split(/\r?\n/)
      .flatMap((chunk) => chunk.split('\0'))
      .filter(Boolean)
      .filter((entry) => entry.startsWith('-\t-\t'))
      .map((entry) => entry.slice('-\t-\t'.length))
      .map(normalizeRepoRelative));
  } catch {
    return [];
  }
}

export function configuredHooksDir(rootDir: string): string | null {
  let output = '';
  try {
    output = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_LIST_MAX_BUFFER,
    }).trim();
  } catch {
    return null;
  }
  if (!output) return null;
  const resolved = path.isAbsolute(output) ? path.resolve(output) : path.resolve(rootDir, output);
  const relative = path.relative(path.resolve(rootDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing outside-repository core.hooksPath: ${output}`);
  }
  return resolved;
}

interface NameStatusChange {
  status: string;
  path: string;
  oldPath?: string;
}

function parseNameStatus(output: string): NameStatusChange[] {
  const parts = output.split('\0').filter(Boolean);
  const changes: NameStatusChange[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[index++];
      const newPath = parts[index++];
      if (oldPath && newPath) changes.push({ status, oldPath: normalizeRepoRelative(oldPath), path: normalizeRepoRelative(newPath) });
    } else {
      const filePath = parts[index++];
      if (filePath) changes.push({ status, path: normalizeRepoRelative(filePath) });
    }
  }
  return changes;
}

function unique(files: string[]): string[] {
  return [...new Set(files)].sort();
}

export function validateGitRef(ref: string): void {
  if (!ref || ref.startsWith('-') || [...ref].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
  if (ref.includes('..') || ref.includes('~') || ref.includes('^') || ref.includes(':') || ref.includes('\\')) {
    throw new Error(`Unsupported git ref syntax: ${ref}`);
  }
}

export function lastCommitMessage(rootDir: string): string {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
