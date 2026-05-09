import ts from 'typescript';
import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { extractCalls, hasExitBeforeCall, isCallConditionallyNested, type CallSite } from '../call-graph.js';
import { evidence, makeContract } from './common.js';

const GUARD_PATTERNS = [
  /^validate/i,
  /^verify/i,
  /^check/i,
  /^assert/i,
  /^authorize/i,
  /^authenticate/i,
  /^requireAuth/i,
  /^ensurePermission/i,
  /^guardAgainst/i,
];

export function detectGuardContracts(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  if (!isPatternEnabled(config, 'guard_clause')) return [];
  return entryGuardCalls(scope, extractCalls(parsed, scope)).map((call) =>
    makeContract({
      config,
      type: 'invariant',
      pattern: 'guard_clause',
      detection: 'control_flow',
      severity: 'medium',
      description: `${scope.name} runs guard ${call.callee} before core logic`,
      evidence: [evidence(parsed, call.node, 'call_site', 'Guard call appears at the function entry point')],
      verification: {
        strategy: 'call_presence',
        target: call.callee,
        params: { near_start: true, before_first_side_effect: true, path_kind: 'unconditional' },
      },
    }),
  );
}

function entryGuardCalls(scope: ScopeInfo, calls: CallSite[]): CallSite[] {
  if (!scope.body) return calls.filter(isGuardCall);
  const firstStatements = new Set(scope.body.statements.slice(0, 3));
  return calls.filter((call) => {
    const statement = enclosingStatement(scope, call.node);
    return statement
      ? firstStatements.has(statement) && isGuardCall(call) && !isCallConditionallyNested(scope, call) && !hasExitBeforeCall(scope, call)
      : false;
  });
}

function isGuardCall(call: CallSite): boolean {
  const segment = call.callee.split('.').pop() ?? call.callee;
  return GUARD_PATTERNS.some((pattern) => pattern.test(segment));
}

function enclosingStatement(scope: ScopeInfo, node: ts.Node): ts.Statement | null {
  if (!scope.body) return null;
  let current: ts.Node = node;
  while (current.parent && current.parent !== scope.body) {
    current = current.parent;
  }
  return ts.isStatement(current) ? current : null;
}
