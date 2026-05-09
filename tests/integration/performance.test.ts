import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { crystallizeProject } from '../../src/core/crystallizer.js';
import { ensureConfig } from '../../src/utils/config.js';

describe('performance smoke', () => {
  it('crystallizes a 500+ file project within the Phase 7 target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-perf-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (let index = 0; index < 501; index += 1) {
      fs.writeFileSync(
        path.join(src, `file-${index}.ts`),
        `export function fn${index}(value: string): string { validate(value); return value; }\ndeclare function validate(value: string): void;\n`,
      );
    }

    const result = await crystallizeProject(root, ensureConfig(root));

    expect(result.files).toHaveLength(501);
    expect(result.durationMs).toBeLessThan(15_000);
  }, 20_000);
});
