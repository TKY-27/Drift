import type { Contract } from '../types/contract.js';
import type { ContractStore } from './store.js';

export interface Evolution {
  contract: Contract;
  scope: string;
  file: string;
  change: string;
  confidence: number;
  decision?: EvolutionDecision;
}

export interface EvolutionDecision {
  action: 'auto_evolve' | 'warn_and_evolve' | 'block';
  confidence: number;
  reasoning: string;
  evolution?: Evolution;
}

export interface FileChange {
  file: string;
  contractType?: string;
  pattern?: string;
  isModified: boolean;
}

export function decideEvolution(evolution: Evolution, commitMessage: string, allChanges: FileChange[]): EvolutionDecision {
  let confidence = 0;
  const reasons: string[] = [];
  const lowerMessage = commitMessage.toLowerCase();
  const intentKeywords = [
    'refactor',
    'migrate',
    'replace',
    'upgrade',
    'redesign',
    'rework',
    'convert',
    'switch to',
    'move to',
    'adopt',
    'deprecate',
    'remove',
    'simplify',
    'consolidate',
  ];
  if (intentKeywords.some((keyword) => lowerMessage.includes(keyword))) {
    confidence += 0.3;
    reasons.push('commit message indicates intentional change');
  }

  const samePatternChanges = allChanges.filter(
    (change) => change.contractType === evolution.contract.type && change.pattern === evolution.contract.pattern,
  );
  if (samePatternChanges.length >= 3) {
    confidence += 0.3;
    reasons.push(`same pattern changed in ${samePatternChanges.length} files`);
  }

  if (allChanges.some((change) => /test|spec/.test(change.file))) {
    confidence += 0.15;
    reasons.push('corresponding tests changed');
  }

  if (allChanges.some((change) => change.file !== evolution.file && change.isModified)) {
    confidence += 0.25;
    reasons.push('related files changed together');
  }

  if (confidence >= 0.6) return { action: 'auto_evolve', confidence, reasoning: reasons.join('; '), evolution };
  if (confidence >= 0.3) return { action: 'warn_and_evolve', confidence, reasoning: reasons.join('; '), evolution };
  return { action: 'block', confidence, reasoning: 'insufficient evidence of intentional change', evolution };
}

export function evaluateEvolution(
  evolution: Evolution,
  context: {
    commitMessage: string;
    allChangedFiles: string[];
    allEvolutionCandidates: Evolution[];
  },
): EvolutionDecision {
  const changes = context.allChangedFiles.map((file) => ({
    file,
    isModified: true,
  })).map((change) => {
    const candidate = context.allEvolutionCandidates.find((item) => item.file === change.file);
    return candidate
      ? { ...change, contractType: candidate.contract.type, pattern: candidate.contract.pattern }
      : change;
  });
  return decideEvolution(evolution, context.commitMessage, changes);
}

export function applyEvolution(store: ContractStore, decision: EvolutionDecision): void {
  if (decision.action === 'block' || !decision.evolution) return;
  store.evolveContract(
    decision.evolution.file,
    decision.evolution.contract.id,
    {
      status: 'evolved',
      description: decision.evolution.contract.description,
      last_verified_at: new Date().toISOString(),
    },
    decision.reasoning,
  );
}
