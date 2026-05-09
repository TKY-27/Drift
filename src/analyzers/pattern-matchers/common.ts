import ts from 'typescript';
import { nanoid } from 'nanoid';
import type { DriftConfig } from '../../types/config.js';
import type { Contract, ContractEvidence, ContractType, DetectionMethod, Severity, VerificationStrategy } from '../../types/contract.js';
import { patternSeverity } from '../../utils/config.js';
import { safeSnippet } from '../../utils/security.js';
import { lineRange, type ParsedFile, type ScopeInfo, walk, isInsideNestedFunction } from '../ast.js';

export const SENSITIVE_NAMES = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'credential',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionKey',
  'session_key',
  'passphrase',
  'pin',
] as const;

export function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_NAMES.some((candidate) => normalized === candidate.toLowerCase().replace(/[_-]/g, ''));
}

export function collectSensitiveNames(scope: ScopeInfo): Set<string> {
  const names = new Set<string>();
  walk(scope.node, (node) => {
    if (isInsideNestedFunction(scope.node, node)) return;
    if (ts.isIdentifier(node) && isSensitiveName(node.text)) names.add(node.text);
  });
  return names;
}

export function evidence(parsed: ParsedFile, node: ts.Node, type: ContractEvidence['type'], reasoning: string): ContractEvidence {
  const range = lineRange(parsed.sourceFile, node);
  return {
    type,
    ...range,
    snippet: safeSnippet(node.getText(parsed.sourceFile)),
    reasoning,
  };
}

export function makeContract(args: {
  config: DriftConfig;
  type: ContractType;
  pattern: string;
  detection: DetectionMethod;
  severity?: Severity;
  description: string;
  evidence: ContractEvidence[];
  verification: {
    strategy: VerificationStrategy;
    target: string;
    params?: Record<string, unknown>;
  };
}): Contract {
  const now = new Date().toISOString();
  return {
    id: `ct_${nanoid(8)}`,
    type: args.type,
    description: safeSnippet(args.description, 500),
    pattern: args.pattern,
    detection: args.detection,
    severity: patternSeverity(args.config, args.pattern, args.severity ?? 'medium'),
    status: 'active',
    evidence: args.evidence,
    verification: args.verification,
    crystallized_at: now,
    last_verified_at: now,
  };
}

export function uniqueContracts(contracts: Contract[]): Contract[] {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = `${contract.type}:${contract.pattern}:${contract.verification.strategy}:${contract.verification.target}:${JSON.stringify(contract.verification.params ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
