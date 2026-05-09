import type { Severity } from './contract.js';

export type Reporter = 'terminal' | 'json' | 'github';

export interface PatternConfig {
  enabled: boolean;
  severity: Severity;
}

export interface DriftConfig {
  version: string;
  language: 'typescript' | 'javascript';
  include: string[];
  exclude: string[];
  severity_threshold: Severity;
  patterns: Record<string, PatternConfig>;
  llm: {
    enabled: boolean;
    provider: 'ollama' | 'anthropic';
    model: string;
    base_url?: string;
    api_key_env?: string;
  };
  evolution: {
    auto_evolve: boolean;
    require_commit_message_evidence: boolean;
    archive_after_days_inactive: number;
  };
  reporter: Reporter;
  git_hook: {
    type: 'pre-commit';
    block_on: Severity;
  };
}

export const defaultConfig: DriftConfig = {
  version: '0.1.1',
  language: 'typescript',
  include: ['src/**/*.ts', 'src/**/*.tsx', 'lib/**/*.ts', 'lib/**/*.tsx'],
  exclude: [
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/*.d.ts',
    '**/node_modules/**',
    '**/dist/**',
    '**/.drift/**',
  ],
  severity_threshold: 'medium',
  patterns: {
    nullify_after_use: { enabled: true, severity: 'critical' },
    no_log_sensitive: { enabled: true, severity: 'critical' },
    always_validate: { enabled: true, severity: 'high' },
    rate_limit_enforced: { enabled: true, severity: 'high' },
    atomic_operation: { enabled: true, severity: 'critical' },
    return_type: { enabled: true, severity: 'high' },
    param_constraint: { enabled: true, severity: 'medium' },
    nullability: { enabled: true, severity: 'medium' },
    error_boundary: { enabled: true, severity: 'high' },
    db_write: { enabled: true, severity: 'medium' },
    event_emit: { enabled: true, severity: 'medium' },
    external_api: { enabled: true, severity: 'medium' },
    file_write: { enabled: true, severity: 'medium' },
    cache_mutation: { enabled: true, severity: 'medium' },
    guard_clause: { enabled: true, severity: 'medium' },
    must_call: { enabled: true, severity: 'medium' },
    import_constraint: { enabled: true, severity: 'low' },
  },
  llm: {
    enabled: false,
    provider: 'ollama',
    model: 'llama3.2',
    base_url: 'http://localhost:11434',
  },
  evolution: {
    auto_evolve: true,
    require_commit_message_evidence: true,
    archive_after_days_inactive: 180,
  },
  reporter: 'terminal',
  git_hook: {
    type: 'pre-commit',
    block_on: 'high',
  },
};
