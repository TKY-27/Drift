import { execFileSync } from 'node:child_process';
import { normalizeRepoRelative } from '../utils/security.js';
import { validateGitRef } from './diff.js';

const BLAME_MAX_BUFFER = 8 * 1024 * 1024;

export interface BlameLine {
  commit: string;
  originalLine: number;
  finalLine: number;
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
}

export function blameFile(rootDir: string, file: string, ref = 'HEAD'): BlameLine[] {
  validateGitRef(ref);
  const safeFile = normalizeRepoRelative(file);
  const output = execFileSync('git', ['blame', '--line-porcelain', ref, '--', safeFile], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: BLAME_MAX_BUFFER,
  });
  return parseBlamePorcelain(output);
}

export function blameLine(rootDir: string, file: string, line: number, ref = 'HEAD'): BlameLine | null {
  if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid blame line: ${String(line)}`);
  return blameFile(rootDir, file, ref).find((entry) => entry.finalLine === line) ?? null;
}

export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split(/\r?\n/);
  const result: BlameLine[] = [];
  let current: Partial<BlameLine> | null = null;

  for (const line of lines) {
    if (!line) continue;
    if (/^[0-9a-f]{40} /.test(line)) {
      if (current?.commit) pushComplete(result, current);
      const [commit, original, finalLine] = line.split(' ');
      current = {
        commit: commit ?? '',
        originalLine: Number(original),
        finalLine: Number(finalLine),
        author: '',
        authorMail: '',
        authorTime: 0,
        summary: '',
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) current.author = line.slice('author '.length);
    else if (line.startsWith('author-mail ')) current.authorMail = line.slice('author-mail '.length).replace(/^<|>$/g, '');
    else if (line.startsWith('author-time ')) current.authorTime = Number(line.slice('author-time '.length));
    else if (line.startsWith('summary ')) current.summary = line.slice('summary '.length);
  }

  if (current?.commit) pushComplete(result, current);
  return result;
}

function pushComplete(result: BlameLine[], entry: Partial<BlameLine>): void {
  const originalLine = entry.originalLine;
  const finalLine = entry.finalLine;
  const authorTime = entry.authorTime;
  if (
    typeof entry.commit === 'string'
    && typeof originalLine === 'number'
    && Number.isInteger(originalLine)
    && typeof finalLine === 'number'
    && Number.isInteger(finalLine)
    && typeof entry.author === 'string'
    && typeof entry.authorMail === 'string'
    && typeof authorTime === 'number'
    && Number.isFinite(authorTime)
    && typeof entry.summary === 'string'
  ) {
    result.push({
      commit: entry.commit,
      originalLine,
      finalLine,
      author: entry.author,
      authorMail: entry.authorMail,
      authorTime,
      summary: entry.summary,
    });
  }
}
