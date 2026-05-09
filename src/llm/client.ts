import type { DriftConfig } from '../types/config.js';
import type { Contract } from '../types/contract.js';
import { fallbackDescription } from './description.js';

export async function generateDescription(
  contract: Partial<Contract>,
  codeSnippet: string,
  config: DriftConfig['llm'],
): Promise<string> {
  await Promise.resolve();
  if (!config.enabled) return fallbackDescription(contract);
  void codeSnippet;
  return fallbackDescription(contract);
}
