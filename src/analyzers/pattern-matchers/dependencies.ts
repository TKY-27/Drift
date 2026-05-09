import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { extractCalls, firstStatementsContainCall, hasExitBeforeCall, isAuthCall, isCallConditionallyNested, isInsideTransactionCall, isRateLimitCall, isSideEffectCall, isValidationCall } from '../call-graph.js';
import { evidence, makeContract } from './common.js';

export function detectDependencyPatterns(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  const calls = extractCalls(parsed, scope);
  const contracts: Contract[] = [];
  const validation = firstStatementsContainCall(scope, calls, isValidationCall);
  if (validation && !isCallConditionallyNested(scope, validation) && !hasExitBeforeCall(scope, validation) && isPatternEnabled(config, 'always_validate')) {
    contracts.push(
      makeContract({
        config,
        type: 'invariant',
        pattern: 'always_validate',
        detection: 'control_flow',
        severity: 'high',
        description: `${scope.name} validates input before core logic via ${validation.callee}`,
        evidence: [evidence(parsed, validation.node, 'call_site', 'Validation call appears in the first statements of the scope')],
        verification: {
          strategy: 'call_presence',
          target: validation.callee,
          params: { near_start: true },
        },
      }),
    );
  }

  const limiter = firstStatementsContainCall(scope, calls, isRateLimitCall);
  if (limiter && !isCallConditionallyNested(scope, limiter) && !hasExitBeforeCall(scope, limiter) && isPatternEnabled(config, 'rate_limit_enforced')) {
    contracts.push(
      makeContract({
        config,
        type: 'invariant',
        pattern: 'rate_limit_enforced',
        detection: 'call_graph',
        severity: 'high',
        description: `${scope.name} enforces rate limiting via ${limiter.callee}`,
        evidence: [evidence(parsed, limiter.node, 'call_site', 'Rate limiter call appears near the entry point')],
        verification: {
          strategy: 'call_presence',
          target: limiter.callee,
          params: { near_start: true },
        },
      }),
    );
  }

  const auth = calls.find(isAuthCall);
  if (auth && isPatternEnabled(config, 'must_call')) {
    contracts.push(
      makeContract({
        config,
        type: 'dependency',
        pattern: 'must_call',
        detection: 'call_graph',
        severity: 'medium',
        description: `${scope.name} depends on authorization call ${auth.callee}`,
        evidence: [evidence(parsed, auth.node, 'call_site', 'Authorization or permission check call is required')],
        verification: {
          strategy: 'call_presence',
          target: auth.callee,
          params: { before_first_side_effect: true, path_kind: 'unconditional' },
        },
      }),
    );
  }

  const transaction = calls.find((call) => /(^|\.)(transaction|\$transaction)$/.test(call.callee));
  const writesInTransaction = calls.filter((call) => isSideEffectCall(call) === 'db_write' && isInsideTransactionCall(call));
  if (transaction && writesInTransaction.length > 0 && isPatternEnabled(config, 'atomic_operation')) {
    contracts.push(
      makeContract({
        config,
        type: 'invariant',
        pattern: 'atomic_operation',
        detection: 'call_graph',
        severity: 'critical',
        description: `${scope.name} performs atomic work inside ${transaction.callee}`,
        evidence: [evidence(parsed, writesInTransaction[0]?.node ?? transaction.node, 'call_site', 'Transaction call protects an atomic operation')],
        verification: {
          strategy: 'call_presence',
          target: transaction.callee,
          params: { transaction_scoped_db_write: true },
        },
      }),
    );
  }

  return contracts;
}
