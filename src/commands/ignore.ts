import { ContractStore } from '../core/store.js';

export function ignoreCommand(rootDir: string, id: string, options: { reason?: string } = {}): void {
  const store = new ContractStore(rootDir);
  const updated = store.updateContract(id, (contract) => {
    contract.status = 'ignored';
    contract.last_verified_at = new Date().toISOString();
    contract.evolution_history = [
      ...(contract.evolution_history ?? []),
      {
        date: new Date().toISOString(),
        from_description: contract.description,
        to_description: 'ignored',
        reason: options.reason ?? 'manual ignore',
        commit_hash: 'manual',
        confidence: 1,
      },
    ];
  });
  if (!updated) {
    process.stderr.write(`Contract not found: ${id}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Ignored ${id}\n`);
}
