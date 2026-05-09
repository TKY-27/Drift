import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addCommand } from '../../src/commands/add.js';
import { ignoreCommand } from '../../src/commands/evolve.js';
import { refreshCommand } from '../../src/commands/init.js';
import { crystallizeProject } from '../../src/core/crystallizer.js';
import { checkProject, shouldBlock } from '../../src/core/watcher.js';
import { ContractStore } from '../../src/core/store.js';
import { ensureConfig, loadConfig } from '../../src/utils/config.js';
import { validateGitRef } from '../../src/git/diff.js';
import { installHook } from '../../src/git/hooks.js';

const fixtureRoot = path.join(import.meta.dirname, '..', 'fixtures');

describe('security regressions', () => {
  it('checks staged blob content instead of the working tree', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'crystallize']);

    writeSource(root, readFixture('nullify-pattern/after-violation.ts'));
    git(root, ['add', 'src/example.ts']);
    writeSource(root, readFixture('nullify-pattern/before.ts'));

    const result = await checkProject(root, loadConfig(root), { staged: true });

    expect(result.violations.some((violation) => violation.contract?.pattern === 'nullify_after_use')).toBe(true);
  });

  it('blocks high severity violations by default', async () => {
    const root = makeProject('return-type-change/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('return-type-change/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(shouldBlock(result, loadConfig(root).severity_threshold)).toBe(true);
  });

  it('uses a high default staged hook threshold for validation regressions', async () => {
    const root = makeProject('guard-clause-removed/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    writeSource(root, readFixture('guard-clause-removed/after-violation.ts'));
    git(root, ['add', 'src/example.ts']);

    const result = await checkProject(root, loadConfig(root), { staged: true });

    expect(shouldBlock(result, loadConfig(root).git_hook.block_on)).toBe(true);
    expect(loadConfig(root).git_hook.block_on).toBe('high');
  });

  it('does not crash when crystallizing implicit return types', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export function increment(x: number) { return x + 1; }\n');

    await expect(crystallizeProject(root, ensureConfig(root))).resolves.toBeTruthy();
  });

  it('fails closed for new uncrystallized source files', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'export const token = "x";\n');

    const result = await checkProject(root, loadConfig(root), { files: ['src/new.ts'] });

    expect(result.violations.some((violation) => violation.type === 'uncrystallized_file')).toBe(true);
  });

  it('rejects unsafe git refs', () => {
    expect(() => validateGitRef('--output=/tmp/x')).toThrow();
    expect(() => validateGitRef('HEAD..main')).toThrow();
  });

  it('rejects contract symlink traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-outside-'));
    fs.mkdirSync(path.join(root, '.drift', 'contracts'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.drift', 'contracts', 'src'));
    const store = new ContractStore(root);

    expect(() => store.contractPath('src/a.ts')).toThrow();
  });

  it('rejects .drift parent symlink traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-outside-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    writeSource(root, readFixture('nullify-pattern/before.ts'));
    fs.symlinkSync(outside, path.join(root, '.drift'));

    expect(() => ensureConfig(root)).toThrow();
  });

  it('detects manifest source_file mismatch', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const manifestPath = path.join(root, '.drift', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { contracts: Array<{ source_file: string }> };
    manifest.contracts[0]!.source_file = 'src/missing.ts';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity')).toBe(true);
  });

  it('detects deleted staged contracted files', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    git(root, ['rm', '-q', 'src/example.ts']);

    const result = await checkProject(root, loadConfig(root), { staged: true });

    expect(result.violations.some((violation) => violation.type === 'scope_deleted')).toBe(true);
  });

  it('fails closed when a committed contract pattern is weakened with a matching manifest hash update', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    const store = new ContractStore(root);
    const contractPath = store.contractPath('src/example.ts');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as {
      scopes: Array<{ contracts: Array<{ pattern: string }> }>;
    };
    contract.scopes[0]!.contracts[0]!.pattern = 'custom';
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    store.writeManifestFromCurrentContracts();

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity')).toBe(true);
  });

  it('includes uncrystallized new files in normal check when a manifest exists', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'export function newFile(): string { return "x"; }\n');

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'uncrystallized_file' && violation.file === 'src/new.ts')).toBe(true);
  });

  it('refuses to write husky hooks through symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    const outside = path.join(os.tmpdir(), `drift-hook-${Date.now()}`);
    fs.mkdirSync(path.join(root, '.husky'), { recursive: true });
    fs.writeFileSync(outside, '#!/bin/sh\n');
    fs.symlinkSync(outside, path.join(root, '.husky', 'pre-commit'));

    git(root, ['init', '-q']);
    git(root, ['config', 'core.hooksPath', '.husky']);

    expect(() => installHook(root)).toThrow();
  });

  it('fails staged checks when .drift has unstaged changes', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    writeSource(root, readFixture('nullify-pattern/after-violation.ts'));
    git(root, ['add', 'src/example.ts']);
    const store = new ContractStore(root);
    const id = store.load('src/example.ts')!.scopes[0]!.contracts[0]!.id;
    store.updateContract(id, (contract) => {
      contract.status = 'archived';
    });

    const result = await checkProject(root, loadConfig(root), { staged: true });

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.file.startsWith('.drift/'))).toBe(true);
  });

  it('fails closed when all Drift metadata is deleted from a trusted baseline', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    fs.rmSync(path.join(root, '.drift'), { recursive: true, force: true });

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.reason.includes('Previously committed contract file is missing'))).toBe(true);
  });

  it('blocks forged archive status even with evolution history and a matching manifest', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    const store = new ContractStore(root);
    const id = store.load('src/example.ts')!.scopes[0]!.contracts[0]!.id;
    store.updateContract(id, (contract) => {
      contract.status = 'archived';
      contract.evolution_history = [
        ...(contract.evolution_history ?? []),
        {
          date: new Date().toISOString(),
          from_description: contract.description,
          to_description: 'archived',
          reason: 'forged',
          commit_hash: 'manual',
          confidence: 1,
        },
      ];
    });

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.reason.includes('status changed'))).toBe(true);
  });

  it('protects evolved contracts that already exist in the trusted baseline', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const store = new ContractStore(root);
    const id = store.load('src/example.ts')!.scopes[0]!.contracts[0]!.id;
    store.updateContract(id, (contract) => {
      contract.status = 'evolved';
      contract.evolution_history = [
        ...(contract.evolution_history ?? []),
        {
          date: new Date().toISOString(),
          from_description: contract.description,
          to_description: contract.description,
          reason: 'trusted',
          commit_hash: 'manual',
          confidence: 1,
        },
      ];
    });
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'trusted evolved contract']);
    const contractPath = store.contractPath('src/example.ts');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as { scopes: Array<{ contracts: Array<{ id: string }> }> };
    contract.scopes[0]!.contracts = contract.scopes[0]!.contracts.filter((item) => item.id !== id);
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    store.writeManifestFromCurrentContracts();

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.reason.includes('Tracked contract'))).toBe(true);
  });

  it('checks staged .drift metadata from the Git index', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    const store = new ContractStore(root);
    const contractPath = store.contractPath('src/example.ts');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as {
      scopes: Array<{ contracts: Array<{ severity: string }> }>;
    };
    contract.scopes[0]!.contracts[0]!.severity = 'low';
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    store.writeManifestFromCurrentContracts();
    git(root, ['add', '.drift']);
    git(root, ['checkout', '--', '.drift']);

    const result = await checkProject(root, loadConfig(root), { staged: true });

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.reason.includes('severity was lowered'))).toBe(true);
  });

  it('uses an explicit baseline ref for contract weakening checks', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init']);
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'contracts']);
    git(root, ['tag', 'trusted-contracts']);
    const store = new ContractStore(root);
    const contractPath = store.contractPath('src/example.ts');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as {
      scopes: Array<{ contracts: Array<{ detection: string }> }>;
    };
    contract.scopes[0]!.contracts[0]!.detection = 'call_graph';
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    store.writeManifestFromCurrentContracts();
    git(root, ['add', '.drift']);
    git(root, ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'weaken contracts']);

    const result = await checkProject(root, loadConfig(root), { baselineRef: 'trusted-contracts' });

    expect(result.violations.some((violation) => violation.type === 'integrity' && violation.reason.includes('detection changed'))).toBe(true);
  });

  it('installs a pre-commit hook that fails closed without the local drift binary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    git(root, ['init', '-q']);

    installHook(root);
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hook, 'utf8');

    expect(content).toContain('./node_modules/.bin/drift check --staged');
    expect(content).not.toContain('npx');
    expect(content.startsWith('#!/bin/sh\nset -e\n# >>> drift semantic integrity >>>')).toBe(true);
    expect(() => execFileSync(hook, { cwd: root, stdio: 'ignore' })).toThrow();
  });

  it('installs into configured hooksPath instead of an inactive .husky directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    git(root, ['init', '-q']);
    fs.mkdirSync(path.join(root, '.husky'), { recursive: true });
    fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
    git(root, ['config', 'core.hooksPath', '.githooks']);

    installHook(root);

    expect(fs.existsSync(path.join(root, '.githooks', 'pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.husky', 'pre-commit'))).toBe(false);
  });

  it('does not write Drift metadata when adding a contract for a missing file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;

    try {
      addCommand(root, 'src/missing.ts', { description: 'must call auth', target: 'authorize' });

      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(root, '.drift', 'contracts'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.drift', 'manifest.json'))).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
    }
  });

  it('enforces manually added generic call_absence contracts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export function run(): void { dangerousCall(); }\n');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;

    try {
      addCommand(root, 'src/example.ts', {
        description: 'must not call dangerousCall',
        target: 'dangerousCall',
        strategy: 'call_absence',
        scope: 'run',
      });
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
    }

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.verification.strategy === 'call_absence')).toBe(true);
  });

  it('requires default import details for import constraints', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'import encrypt from "crypto-utils";\nexport function run(): unknown { return encrypt; }\n');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'import { encrypt } from "crypto-utils";\nexport function run(): unknown { return encrypt; }\n');

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'import_constraint')).toBe(true);
  });

  it('allows security-sensitive named imports to be split across declarations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'import { encrypt, hash } from "crypto-utils";\nexport function run(): unknown { return [encrypt, hash]; }\n');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'import { encrypt } from "crypto-utils";\nimport { hash } from "crypto-utils";\nexport function run(): unknown { return [encrypt, hash]; }\n');

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'import_constraint')).toBe(false);
  });

  it('detects authorization calls that became conditional before a database write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'example.ts'),
      'export async function saveInvoice(user: User, data: Data): Promise<void> {\n  authorize(user);\n  await db.invoice.create({ data });\n}\n',
    );
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(
      path.join(root, 'src', 'example.ts'),
      'export async function saveInvoice(user: User, data: Data): Promise<void> {\n  if (user.isAdmin) authorize(user);\n  await db.invoice.create({ data });\n}\n',
    );

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'must_call')).toBe(true);
  });

  it('creates explicit parameter and nullability contracts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export function normalizeEmail(email: string): string { return email.toLowerCase(); }\n');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export function normalizeEmail(email?: string | null): string { return email?.toLowerCase() ?? ""; }\n');

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.pattern === 'param_constraint')).toBe(true);
    expect(result.violations.some((violation) => violation.contract?.pattern === 'nullability')).toBe(true);
  });

  it('rejects invalid severity thresholds in config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    fs.mkdirSync(path.join(root, '.drift'), { recursive: true });
    fs.writeFileSync(path.join(root, '.drift', 'config.json'), '{"version":"0.1.0","severity_threshold":"none"}\n');

    expect(() => loadConfig(root)).toThrow(/severity_threshold/);
  });

  it('refresh preserves manually added contracts', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      addCommand(root, 'src/example.ts', {
        description: 'must call auditTrail',
        pattern: 'custom',
        target: 'auditTrail',
      });
      await refreshCommand(root);
    } finally {
      stdout.mockRestore();
    }

    const refreshed = new ContractStore(root).load('src/example.ts');
    expect(refreshed?.scopes.flatMap((scope) => scope.contracts).some((contract) => contract.pattern === 'custom' && contract.verification.target === 'auditTrail')).toBe(true);
  });

  it('refresh does not drop active generated contracts that are absent from fresh detection', async () => {
    const root = makeProject('side-effect-removed/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    writeSource(root, readFixture('side-effect-removed/after-violation.ts'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await refreshCommand(root);
    } finally {
      stdout.mockRestore();
    }

    const refreshed = new ContractStore(root).load('src/example.ts');
    expect(refreshed?.scopes.flatMap((scope) => scope.contracts).some((contract) => contract.pattern === 'db_write')).toBe(true);
  });

  it('does not block deleted files when every contract was ignored', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const store = new ContractStore(root);
    for (const summary of store.listAll()) {
      const contractFile = store.load(summary.file)!;
      for (const scope of contractFile.scopes) {
        for (const contract of scope.contracts) {
          store.updateContract(contract.id, (item) => {
            item.status = 'archived';
            item.evolution_history = [
              ...(item.evolution_history ?? []),
              {
                date: new Date().toISOString(),
                from_description: item.description,
                to_description: 'archived',
                reason: 'test',
                commit_hash: 'manual',
                confidence: 1,
              },
            ];
          });
        }
      }
    }
    fs.rmSync(path.join(root, 'src', 'example.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.type === 'scope_deleted')).toBe(false);
  });

  it('drift ignore marks contracts ignored and removes them from verification', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const id = new ContractStore(root).load('src/example.ts')!.scopes
      .flatMap((scope) => scope.contracts)
      .find((contract) => contract.pattern === 'nullify_after_use')!.id;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      ignoreCommand(root, id, { reason: 'accepted risk' });
    } finally {
      stdout.mockRestore();
    }
    writeSource(root, readFixture('nullify-pattern/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(new ContractStore(root).load('src/example.ts')?.scopes.flatMap((scope) => scope.contracts).find((contract) => contract.id === id)?.status).toBe('ignored');
    expect(result.violations.some((violation) => violation.contract?.id === id)).toBe(false);
  });

  it('continues verifying manually evolved contracts', async () => {
    const root = makeProject('nullify-pattern/before.ts');
    const config = ensureConfig(root);
    await crystallizeProject(root, config);
    const store = new ContractStore(root);
    const id = store.load('src/example.ts')!.scopes.flatMap((scope) => scope.contracts).find((contract) => contract.pattern === 'nullify_after_use')!.id;
    store.updateContract(id, (contract) => {
      contract.status = 'evolved';
      contract.evolution_history = [
        ...(contract.evolution_history ?? []),
        {
          date: new Date().toISOString(),
          from_description: contract.description,
          to_description: contract.description,
          reason: 'test',
          commit_hash: 'manual',
          confidence: 1,
        },
      ];
    });
    writeSource(root, readFixture('nullify-pattern/after-violation.ts'));

    const result = await checkProject(root, loadConfig(root));

    expect(result.violations.some((violation) => violation.contract?.id === id)).toBe(true);
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

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}
