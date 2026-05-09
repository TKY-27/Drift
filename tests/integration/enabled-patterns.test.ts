import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { crystallizeProject } from '../../src/core/crystallizer.js';
import { ContractStore } from '../../src/core/store.js';
import { checkProject } from '../../src/core/watcher.js';
import { ensureConfig, loadConfig } from '../../src/utils/config.js';

const fixtureRoot = path.join(import.meta.dirname, '..', 'fixtures');

const enabledPatterns = [
  'no_log_sensitive',
  'rate_limit_enforced',
  'atomic_operation',
  'event_emit',
  'external_api',
  'file_write',
  'cache_mutation',
  'guard_clause',
] as const;

describe('enabled pattern regressions', () => {
  it('crystallizes currently enabled under-covered patterns from fixtures', async () => {
    const root = makeProject('enabled-patterns/before.ts');
    const config = ensureConfig(root);

    await crystallizeProject(root, config);

    const patterns = crystallizedPatterns(root);
    for (const pattern of enabledPatterns) {
      expect(patterns).toContain(pattern);
    }
  });

  it('detects fixture-backed violations for currently enabled under-covered patterns', async () => {
    const root = makeProject('enabled-patterns/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('enabled-patterns/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));
    const violatedPatterns = new Set(result.violations.map((violation) => violation.contract?.pattern).filter((pattern): pattern is string => Boolean(pattern)));

    for (const pattern of enabledPatterns) {
      expect(violatedPatterns).toContain(pattern);
    }
  });
});

function makeProject(fixture: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeSource(root, readFixture(fixture));
  return root;
}

function writeSource(root: string, source: string): void {
  fs.writeFileSync(path.join(root, 'src', 'example.ts'), source);
}

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(fixtureRoot, relative), 'utf8');
}

function crystallizedPatterns(root: string): Set<string> {
  const contractFile = new ContractStore(root).load('src/example.ts');
  return new Set(contractFile?.scopes.flatMap((scope) => scope.contracts.map((contract) => contract.pattern)) ?? []);
}
