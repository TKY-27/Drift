import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { extractImports } from '../ast.js';
import { makeContract } from './common.js';

const SECURITY_IMPORT = /(crypto|security|auth|encrypt|decrypt|hash|jwt|token|password)/i;

export function detectImportConstraintPatterns(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  if (scope.kind !== 'module' || !isPatternEnabled(config, 'import_constraint')) return [];
  return extractImports(parsed)
    .filter((info) => SECURITY_IMPORT.test(info.module) || info.names.some((name) => SECURITY_IMPORT.test(name)))
    .map((info) =>
      makeContract({
        config,
        type: 'dependency',
        pattern: 'import_constraint',
        detection: 'import_graph',
        severity: 'low',
        description: `Security-sensitive import from ${info.module} is preserved`,
        evidence: [
          {
            type: 'pattern_match',
            line_start: info.line,
            line_end: info.line,
            snippet: info.snippet,
            reasoning: 'Security-related import detected',
          },
        ],
        verification: {
          strategy: 'import_presence',
          target: info.module,
          params: { names: info.names, named: info.named, default: info.default, namespace: info.namespace, type_only: info.typeOnly },
        },
      }),
    );
}
