import { ContractStore } from '../core/store.js';
import { safeSnippet } from '../utils/security.js';
export { ignoreCommand } from './ignore.js';

export function evolveCommand(rootDir: string, id: string, options: { reason?: string; description?: string } = {}): void {
  const reason = options.reason ?? 'manual evolution';
  const store = new ContractStore(rootDir);
  const updated = store.updateContract(id, (contract) => {
    const from = contract.description;
    if (options.description) contract.description = safeSnippet(options.description, 500);
    contract.status = 'evolved';
    contract.last_verified_at = new Date().toISOString();
    contract.evolution_history = [
      ...(contract.evolution_history ?? []),
      {
        date: new Date().toISOString(),
        from_description: from,
        to_description: contract.description,
        reason,
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
  process.stdout.write(`Evolved ${id}: ${updated.description}\n`);
}
