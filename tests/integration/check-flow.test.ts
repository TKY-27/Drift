import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { crystallizeProject } from '../../src/core/crystallizer.js';
import { checkProject } from '../../src/core/watcher.js';
import { ensureConfig, loadConfig } from '../../src/utils/config.js';
import { ContractStore } from '../../src/core/store.js';

const fixtureRoot = path.join(import.meta.dirname, '..', 'fixtures');

describe('drift init -> check', () => {
  it('detects removed password nullification', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('nullify-pattern/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'nullify_after_use')).toBe(true);
  });

  it('allows a safe refactor that keeps nullification', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('nullify-pattern/after-safe.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'nullify_after_use')).toBe(false);
  });

  it('detects return type and throw behavior changes', async () => {
    const root = makeProject('return-type-change/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('return-type-change/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'return_type')).toBe(true);
  });

  it('detects removed side effects', async () => {
    const root = makeProject('side-effect-removed/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('side-effect-removed/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'db_write')).toBe(true);
  });

  it('detects changed error handling strategy', async () => {
    const root = makeProject('error-handling-change/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('error-handling-change/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'error_boundary')).toBe(true);
  });

  it('detects removed validation, authorization, and database side effect', async () => {
    const root = makeProject('guard-clause-removed/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('guard-clause-removed/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'always_validate')).toBe(true);
    expect(result.violations.some((violation) => violation.contract?.pattern === 'guard_clause')).toBe(true);
    expect(result.violations.some((violation) => violation.contract?.pattern === 'must_call')).toBe(true);
    expect(result.violations.some((violation) => violation.contract?.pattern === 'db_write')).toBe(true);
  });

  it('reports manual contract tampering through the manifest', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const store = new ContractStore(root);
    const contractPath = store.contractPath('src/example.ts');
    const raw = fs.readFileSync(contractPath, 'utf8').replace('"severity": "critical"', '"severity": "low"');
    fs.writeFileSync(contractPath, raw);

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity')).toBe(true);
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
