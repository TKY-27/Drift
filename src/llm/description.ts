import type { Contract } from '../types/contract.js';

export function fallbackDescription(contract: Partial<Contract>): string {
  const pattern = contract.pattern ?? 'semantic_contract';
  const target = contract.verification?.target;
  return target ? `${pattern} is preserved for ${target}` : `${pattern} is preserved`;
}
