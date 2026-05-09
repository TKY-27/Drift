import fs from 'node:fs';
import path from 'node:path';
import { configuredHooksDir, findGitDir } from './diff.js';

const START = '# >>> drift semantic integrity >>>';
const END = '# <<< drift semantic integrity <<<';

const HOOK_BLOCK = `${START}
if [ ! -x "./node_modules/.bin/drift" ]; then
  echo "drift: local ./node_modules/.bin/drift not found or not executable" >&2
  exit 1
fi
if [ -x "./node_modules/.bin/drift" ]; then
  ./node_modules/.bin/drift check --staged --reporter=terminal || exit $?
fi
${END}
`;

export function installHook(rootDir: string): 'installed' | 'updated' {
  const configured = configuredHooksDir(rootDir);
  if (configured) {
    assertNoSymlinkFromRoot(rootDir, configured);
    return installIntoFile(rootDir, path.join(configured, 'pre-commit'));
  }
  const lefthook = findLefthookConfig(rootDir);
  if (lefthook) return installIntoLefthook(rootDir, lefthook);
  const huskyDir = path.join(rootDir, '.husky');
  if (fs.existsSync(huskyDir) && fs.statSync(huskyDir).isDirectory()) {
    assertNoSymlinkFromRoot(rootDir, huskyDir);
    return installIntoFile(rootDir, path.join(huskyDir, 'pre-commit'));
  }
  const gitDir = findGitDir(rootDir);
  if (!gitDir) throw new Error('No .git directory found. Run drift watch inside a Git repository.');
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
  return installIntoFile(gitDir, path.join(hooksDir, 'pre-commit'));
}

function findLefthookConfig(rootDir: string): string | null {
  for (const name of ['lefthook.yml', 'lefthook.yaml']) {
    const file = path.join(rootDir, name);
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to write lefthook config through symlink: ${file}`);
      return file;
    }
  }
  return null;
}

function installIntoLefthook(rootDir: string, filePath: string): 'installed' | 'updated' {
  assertNoSymlinkFromRoot(rootDir, path.dirname(filePath));
  if (fs.statSync(filePath).nlink > 1) throw new Error(`Refusing to write lefthook config through hardlink: ${filePath}`);
  const current = fs.readFileSync(filePath, 'utf8');
  if (current.includes('drift semantic integrity') || current.includes('./node_modules/.bin/drift check --staged')) return 'updated';
  const block = `
# drift semantic integrity
pre-commit:
  commands:
    drift:
      run: ./node_modules/.bin/drift check --staged --reporter=terminal
`;
  writeHookFile(filePath, `${current.trimEnd()}\n${block}`);
  return 'updated';
}

export function uninstallHook(rootDir: string): 'removed' | 'not_found' {
  const candidates: string[] = [];
  const configured = configuredHooksDir(rootDir);
  if (configured) {
    const hook = path.join(configured, 'pre-commit');
    assertNoSymlinkFromRoot(rootDir, path.dirname(hook));
    if (fs.existsSync(hook) && !fs.lstatSync(hook).isSymbolicLink()) candidates.push(hook);
  }
  const gitDir = findGitDir(rootDir);
  if (gitDir) {
    const gitHook = path.join(gitDir, 'hooks', 'pre-commit');
    assertNoSymlinkFromRoot(gitDir, path.dirname(gitHook));
    if (fs.existsSync(gitHook) && !fs.lstatSync(gitHook).isSymbolicLink()) candidates.push(gitHook);
  }
  let removed = false;
  for (const candidate of candidates) {
    const content = fs.readFileSync(candidate, 'utf8');
    const next = removeBlock(content);
    if (next !== content) {
      writeHookFile(candidate, next);
      removed = true;
    }
  }
  return removed ? 'removed' : 'not_found';
}

function installIntoFile(rootDir: string, filePath: string): 'installed' | 'updated' {
  assertNoSymlinkFromRoot(rootDir, path.dirname(filePath));
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to write hook through symlink: ${filePath}`);
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).nlink > 1) {
    throw new Error(`Refusing to write hook through hardlink: ${filePath}`);
  }
  const exists = fs.existsSync(filePath);
  const current = exists ? fs.readFileSync(filePath, 'utf8') : '#!/bin/sh\n';
  const withoutOld = removeBlock(current).trimEnd();
  const withSetE = ensureSetE(withoutOld);
  const next = insertAfterPreamble(withSetE, HOOK_BLOCK);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  writeHookFile(filePath, next);
  return exists ? 'updated' : 'installed';
}

function assertNoSymlinkFromRoot(rootDir: string, targetPath: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to use symlink in hook path: ${current}`);
    }
  }
}

function removeBlock(content: string): string {
  const pattern = new RegExp(`\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`, 'g');
  return content.replace(pattern, '\n');
}

function ensureSetE(content: string): string {
  if (/^\s*set\s+-e\b/m.test(content)) return content;
  return insertAfterShebang(content.trimEnd(), 'set -e\n');
}

function insertAfterShebang(content: string, block: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.startsWith('#!')) {
    return [lines[0], block.trimEnd(), ...lines.slice(1)].join('\n').trimEnd() + '\n';
  }
  return `${block.trimEnd()}\n${content}`.trimEnd() + '\n';
}

function insertAfterPreamble(content: string, block: string): string {
  const lines = content.split(/\r?\n/);
  let index = lines[0]?.startsWith('#!') ? 1 : 0;
  if (/^\s*set\s+-e\b/.test(lines[index] ?? '')) index += 1;
  return [...lines.slice(0, index), block.trimEnd(), ...lines.slice(index)].join('\n').trimEnd() + '\n';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeHookFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Refusing to write hook through symlink: ${filePath}`);
    if (fs.statSync(filePath).nlink > 1) throw new Error(`Refusing to write hook through hardlink: ${filePath}`);
  }
  const beforeDirReal = fs.realpathSync(dir);
  const tmp = path.join(dir, `.pre-commit.drift-${process.pid}-${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o755);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.realpathSync(dir) !== beforeDirReal) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Hook directory changed while writing: ${dir}`);
  }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o755);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}
