import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_SNIPPET_LENGTH = 240;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_STRING_ESCAPE = /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\)/g;
const SECRET_KEY_PATTERN =
  '(?:[A-Z0-9_]*[_-]?)?(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|access[_-]?token|refresh[_-]?token)(?:[_-]?[A-Z0-9_]*)?';
const SECRET_QUOTED_VALUE = new RegExp(
  `(["']?)\\b(${SECRET_KEY_PATTERN})\\b\\1\\s*([:=])\\s*(["'\`])[^"'\\\`\\n]{4,}\\4`,
  'gi',
);
const SECRET_UNQUOTED_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_KEY_PATTERN})\\b\\s*=\\s*[^\\s#;&|]{4,}`,
  'gi',
);
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_QUERY_PARAM =
  /([?&](?:token|access_token|refresh_token|api[_-]?key|secret|password)=)[^&#\s"']+/gi;

export class SecurityError extends Error {
  override name = 'SecurityError';
}

export function stripUnsafeText(value: string): string {
  return value.replace(ANSI_STRING_ESCAPE, '').replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '').trim();
}

export function redactSecrets(value: string): string {
  return stripUnsafeText(value)
    .replace(SECRET_QUOTED_VALUE, (_match, quote: string, name: string, separator: string) => `${quote}${name}${quote}${separator}<redacted>`)
    .replace(SECRET_UNQUOTED_ASSIGNMENT, (_match, name: string) => `${name}=<redacted>`)
    .replace(BEARER_TOKEN, 'Bearer <redacted>')
    .replace(SECRET_QUERY_PARAM, '$1<redacted>');
}

export function safeSnippet(value: string, maxLength = MAX_SNIPPET_LENGTH): string {
  const oneLine = redactSecrets(value).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}...` : oneLine;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeRepoRelative(input: string): string {
  const raw = input.replaceAll('\\', '/');
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\x00-\x1F\x7F-\x9F]/.test(raw)) {
    throw new SecurityError('Path is empty or contains control bytes');
  }
  if (raw !== raw.trim()) {
    throw new SecurityError(`Path contains unsafe surrounding whitespace: ${input}`);
  }
  const cleaned = raw;
  if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned) || cleaned.startsWith('//')) {
    throw new SecurityError(`Absolute paths are not allowed: ${input}`);
  }
  const normalized = path.posix.normalize(cleaned);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new SecurityError(`Path traversal is not allowed: ${input}`);
  }
  return normalized;
}

export function resolveInside(baseDir: string, relativePath: string): string {
  const normalized = normalizeRepoRelative(relativePath);
  if (fs.existsSync(baseDir) && fs.lstatSync(baseDir).isSymbolicLink()) {
    throw new SecurityError(`Base directory must not be a symlink: ${baseDir}`);
  }
  const resolvedBase = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, normalized);
  const relative = path.relative(resolvedBase, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError(`Resolved path escapes base directory: ${relativePath}`);
  }
  assertNoSymlinkWithin(resolvedBase, resolved);
  return resolved;
}

export function resolveRepoPath(rootDir: string, relativePath: string, label = 'path'): string {
  const resolvedRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
  if (fs.existsSync(rootDir) && fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new SecurityError(`Repository root must not be a symlink: ${rootDir}`);
  }
  const normalized = normalizeRepoRelative(relativePath);
  const resolved = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError(`${label} escapes repository: ${relativePath}`);
  }
  assertNoSymlinkWithin(resolvedRoot, resolved);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    const realRelative = path.relative(resolvedRoot, real);
    if (realRelative === '' || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new SecurityError(`${label} resolves outside repository: ${relativePath}`);
    }
  }
  return resolved;
}

export function assertNoSymlinkWithin(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError(`Resolved path escapes base directory: ${targetPath}`);
  }
  let current = resolvedBase;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new SecurityError(`Refusing to follow symlink inside trusted directory: ${current}`);
    }
  }
}

export function toPosixRelative(rootDir: string, absoluteOrRelative: string): string {
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? path.resolve(absoluteOrRelative)
    : path.resolve(rootDir, absoluteOrRelative);
  const relative = path.relative(path.resolve(rootDir), absolute).replaceAll(path.sep, '/');
  return normalizeRepoRelative(relative);
}

export function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SecurityError(`${label} must be a JSON object`);
  }
}

export function readJsonFile<T>(filePath: string, maxBytes: number, label: string): T {
  const lst = fs.lstatSync(filePath);
  if (lst.isSymbolicLink()) {
    throw new SecurityError(`${label} must not be a symlink`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new SecurityError(`${label} must be a regular file`);
  }
  if (stat.nlink > 1) {
    throw new SecurityError(`${label} must not be hardlinked`);
  }
  if (stat.size > maxBytes) {
    throw new SecurityError(`${label} is too large (${stat.size} bytes)`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assertJsonObject(parsed, label);
  return parsed as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const dir = path.dirname(filePath);
  const beforeDirReal = fs.realpathSync(dir);
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new SecurityError(`Refusing to write JSON through symlink: ${filePath}`);
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).nlink > 1) {
    throw new SecurityError(`Refusing to write JSON through hardlink: ${filePath}`);
  }
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.realpathSync(dir) !== beforeDirReal) {
    fs.rmSync(tmp, { force: true });
    throw new SecurityError(`JSON directory changed while writing: ${dir}`);
  }
  fs.renameSync(tmp, filePath);
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}

export function safeReadTextFile(rootDir: string, relativePath: string, maxBytes: number, label = 'source file'): string {
  const absolute = resolveRepoPath(rootDir, relativePath, label);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new SecurityError(`${label} must be a regular file: ${relativePath}`);
  if (stat.nlink > 1) throw new SecurityError(`${label} must not be hardlinked: ${relativePath}`);
  if (stat.size > maxBytes) throw new SecurityError(`${label} is too large (${stat.size} bytes): ${relativePath}`);
  return fs.readFileSync(absolute, 'utf8');
}

export function validateRepoGlob(pattern: string): string {
  const raw = pattern.replaceAll('\\', '/');
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\x00-\x1F\x7F-\x9F]/.test(raw)) throw new SecurityError('Glob pattern is empty or contains control bytes');
  if (raw !== raw.trim()) throw new SecurityError(`Glob pattern contains unsafe surrounding whitespace: ${pattern}`);
  const cleaned = raw;
  if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned) || cleaned.startsWith('//')) {
    throw new SecurityError(`Absolute glob patterns are not allowed: ${pattern}`);
  }
  for (const part of cleaned.split('/')) {
    if (part === '..') throw new SecurityError(`Path traversal is not allowed in glob pattern: ${pattern}`);
  }
  return cleaned.replace(/^\.\//, '');
}

export function globMatches(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRepoRelative(file);
  const normalizedPattern = validateRepoGlob(pattern);
  return globToRegExp(normalizedPattern).test(normalizedFile);
}

function globToRegExp(pattern: string): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const after = pattern[i + 2];
    if (char === '*' && next === '*' && after === '/') {
      regex += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && next === '*') {
      regex += '.*';
      i += 1;
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += escapeRegExp(char ?? '');
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
