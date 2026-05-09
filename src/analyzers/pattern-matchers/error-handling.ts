import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { detectErrorHandling } from '../control-flow.js';
import { makeContract } from './common.js';

export function detectErrorHandlingPattern(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  if (!isPatternEnabled(config, 'error_boundary')) return [];
  const pattern = detectErrorHandling(parsed, scope);
  if (!pattern || pattern.strategy === 'none') return [];
  return [
    makeContract({
      config,
      type: 'boundary',
      pattern: 'error_boundary',
      detection: 'control_flow',
      severity: pattern.strategy === 'swallow' ? 'critical' : 'high',
      description: `${scope.name} uses ${pattern.strategy} error handling`,
      evidence: [
        {
          type: 'control_path',
          line_start: pattern.line,
          line_end: pattern.line,
          snippet: pattern.snippet,
          reasoning: `Catch block classified as ${pattern.strategy}`,
        },
      ],
      verification: {
        strategy: 'error_strategy',
        target: scope.name,
        params: { strategy: pattern.strategy },
      },
    }),
  ];
}
