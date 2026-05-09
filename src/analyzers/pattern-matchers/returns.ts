import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import { type ParsedFile, type ScopeInfo } from '../ast.js';
import { getParameterInfo, getReturnType, hasThrowStatement, type TypeContext } from '../types.js';
import { evidence, makeContract } from './common.js';

export function detectReturnTypePattern(
  config: DriftConfig,
  parsed: ParsedFile,
  typeContext: TypeContext,
  scope: ScopeInfo,
): Contract[] {
  if (!isPatternEnabled(config, 'return_type')) return [];
  const returnType = getReturnType(typeContext, parsed, scope);
  if (returnType === 'unknown' || returnType === 'any') return [];
  const noThrow = !hasThrowStatement(scope);
  const params = getParameterInfo(typeContext, parsed, scope);
  const contracts: Contract[] = [
    makeContract({
      config,
      type: 'boundary',
      pattern: 'return_type',
      detection: 'type_analysis',
      severity: 'high',
      description: `${scope.name} returns ${returnType}${noThrow ? ' and never throws' : ' and may throw'}`,
      evidence: [evidence(parsed, scope.node, 'type_signature', `Explicit return type is ${returnType}; no_throw=${String(noThrow)}`)],
      verification: {
        strategy: 'type_check',
        target: scope.name,
        params: { expected_return: returnType, no_throw: noThrow, parameters: params },
      },
    }),
  ];
  if (params.length > 0 && isPatternEnabled(config, 'param_constraint')) {
    contracts.push(
      makeContract({
        config,
        type: 'boundary',
        pattern: 'param_constraint',
        detection: 'type_analysis',
        severity: 'medium',
        description: `${scope.name} parameter types and optionality are stable`,
        evidence: [evidence(parsed, scope.node, 'type_signature', `Parameter contract: ${JSON.stringify(params)}`)],
        verification: {
          strategy: 'type_check',
          target: scope.name,
          params: { parameters: params },
        },
      }),
    );
  }
  if (params.length > 0 && isPatternEnabled(config, 'nullability')) {
    contracts.push(
      makeContract({
        config,
        type: 'boundary',
        pattern: 'nullability',
        detection: 'type_analysis',
        severity: 'medium',
        description: `${scope.name} parameter nullability is stable`,
        evidence: [evidence(parsed, scope.node, 'type_signature', `Nullability contract: ${JSON.stringify(params.map((param) => ({ name: param.name, nullable: param.nullable, optional: param.optional })))}`)],
        verification: {
          strategy: 'type_check',
          target: scope.name,
          params: { parameters: params },
        },
      }),
    );
  }
  return contracts;
}
