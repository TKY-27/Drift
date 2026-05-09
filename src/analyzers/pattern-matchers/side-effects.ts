import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { extractCalls, hasExitBeforeCall, isCallConditionallyNested, isSideEffectCall } from '../call-graph.js';
import { evidence, makeContract } from './common.js';

const CATEGORY_DESCRIPTION: Record<string, string> = {
  db_write: 'writes to a database',
  event_emit: 'emits or dispatches an event',
  external_api: 'calls an external HTTP API',
  file_write: 'writes to the file system',
  cache_mutation: 'mutates cache state',
};

export function detectSideEffectPatterns(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  const contracts: Contract[] = [];
  for (const call of extractCalls(parsed, scope)) {
    const category = isSideEffectCall(call);
    if (!category || !isPatternEnabled(config, category)) continue;
    const pathKind = isCallConditionallyNested(scope, call) || hasExitBeforeCall(scope, call) ? 'conditional' : 'unconditional';
    contracts.push(
      makeContract({
        config,
        type: 'side_effect',
        pattern: category,
        detection: 'call_graph',
        severity: category === 'db_write' ? 'medium' : 'medium',
        description: `${scope.name} ${CATEGORY_DESCRIPTION[category]} via ${call.callee}`,
        evidence: [evidence(parsed, call.node, 'call_site', `${call.callee} is a ${category} side effect`)],
        verification: {
          strategy: 'call_presence',
          target: call.callee,
          params: { category, path_kind: pathKind },
        },
      }),
    );
  }
  return contracts;
}
