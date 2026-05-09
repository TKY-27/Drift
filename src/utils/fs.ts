import fs from 'node:fs';
import path from 'node:path';

export function findUp(startDir: string, target: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, target);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
