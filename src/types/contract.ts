export type ContractType = 'invariant' | 'boundary' | 'side_effect' | 'dependency';

export type DetectionMethod =
  | 'ast_pattern'
  | 'type_analysis'
  | 'control_flow'
  | 'call_graph'
  | 'import_graph';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type ContractStatus = 'active' | 'evolved' | 'ignored' | 'archived';

export type EvidenceType =
  | 'ast_node'
  | 'type_signature'
  | 'call_site'
  | 'control_path'
  | 'pattern_match';

export type VerificationStrategy =
  | 'pattern_exists'
  | 'pattern_absent'
  | 'call_presence'
  | 'call_absence'
  | 'type_check'
  | 'control_path'
  | 'ast_query'
  | 'import_presence'
  | 'error_strategy';

export interface ContractEvidence {
  type: EvidenceType;
  line_start: number;
  line_end: number;
  snippet: string;
  reasoning: string;
}

export interface Contract {
  id: string;
  type: ContractType;
  description: string;
  pattern: string;
  detection: DetectionMethod;
  severity: Severity;
  status: ContractStatus;
  evidence: ContractEvidence[];
  verification: {
    strategy: VerificationStrategy;
    target: string;
    params?: Record<string, unknown>;
  };
  crystallized_at: string;
  last_verified_at: string;
  evolution_history?: ContractEvolution[];
}

export interface ContractEvolution {
  date: string;
  from_description: string;
  to_description: string;
  reason: string;
  commit_hash: string;
  confidence: number;
}

export interface ContractScope {
  name: string;
  kind: 'function' | 'method' | 'class' | 'module';
  qualified_name?: string;
  signature_hash?: string;
  node_hash?: string;
  line_start: number;
  line_end: number;
  contracts: Contract[];
}

export interface ContractFile {
  source_file: string;
  source_hash: string;
  scopes: ContractScope[];
  meta: {
    drift_version: string;
    crystallized_at: string;
    last_checked_at: string;
    total_contracts: number;
  };
}

export interface ContractSummary {
  file: string;
  contracts: number;
  severity: Record<Severity, number>;
}

export const severityOrder: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function isAtLeastSeverity(actual: Severity, threshold: Severity): boolean {
  return severityOrder[actual] >= severityOrder[threshold];
}

export function maxSeverity(severities: Severity[]): Severity {
  return severities.reduce<Severity>(
    (max, current) => (severityOrder[current] > severityOrder[max] ? current : max),
    'low',
  );
}
