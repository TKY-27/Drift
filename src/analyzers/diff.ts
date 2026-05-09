import type { Contract, ContractScope } from '../types/contract.js';

export interface SemanticChange {
  type: 'scope_removed' | 'return_changed' | 'call_removed' | 'pattern_removed' | 'error_strategy_changed';
  name: string;
  from?: string;
  to?: string;
  contract?: Contract;
}

export function summarizeScopeRemoval(scope: ContractScope): SemanticChange {
  return {
    type: 'scope_removed',
    name: scope.name,
    from: `${scope.contracts.length} contract(s)`,
  };
}
