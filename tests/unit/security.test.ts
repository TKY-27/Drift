import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource, extractScopes } from '../../src/analyzers/ast.js';
import { buildCallGraph, callMatches } from '../../src/analyzers/call-graph.js';
import { enumerateControlFlowPaths } from '../../src/analyzers/control-flow.js';
import { hasThrowStatement } from '../../src/analyzers/types.js';
import { ContractStore } from '../../src/core/store.js';
import { parseBlamePorcelain } from '../../src/git/blame.js';
import { renderLs } from '../../src/reporters/terminal.js';
import type { ContractFile } from '../../src/types/contract.js';
import { normalizeRepoRelative, safeSnippet } from '../../src/utils/security.js';

describe('security utilities', () => {
  it('rejects path traversal in source paths', () => {
    expect(() => normalizeRepoRelative('../secret.ts')).toThrow();
    expect(() => normalizeRepoRelative('/tmp/secret.ts')).toThrow();
  });

  it('forces contract paths under .drift/contracts', () => {
    const store = new ContractStore('/tmp/project');
    expect(() => store.contractPath('../outside.ts')).toThrow();
    expect(store.contractPath('src/auth.ts')).toBe(path.join('/tmp/project', '.drift', 'contracts', 'src', 'auth.ts.json'));
  });

  it('redacts obvious secret assignments in snippets', () => {
    expect(safeSnippet('const password = "super-secret-password";')).toContain('<redacted>');
  });

  it('redacts JSON, single-quoted, and dotenv-style secrets in snippets', () => {
    const snippet = safeSnippet('{"api_key":"sk_live_123456"} PASSWORD=super-secret refresh_token: \'abcdef12345\'');

    expect(snippet).toContain('<redacted>');
    expect(snippet).not.toContain('sk_live_123456');
    expect(snippet).not.toContain('super-secret');
    expect(snippet).not.toContain('abcdef12345');
  });

  it('strips terminal control sequences from rendered contract metadata', () => {
    const malicious = '\u001B]2;owned\u0007';
    const file: ContractFile = {
      source_file: `src/example.ts${malicious}`,
      source_hash: 'a'.repeat(64),
      scopes: [
        {
          name: `run${malicious}`,
          kind: 'function',
          line_start: 1,
          line_end: 1,
          contracts: [
            {
              id: 'ct_safe',
              type: 'invariant',
              description: `must call auth ${malicious}`,
              pattern: `custom${malicious}`,
              detection: 'ast_pattern',
              severity: 'medium',
              status: 'active',
              evidence: [{ type: 'pattern_match', line_start: 1, line_end: 1, snippet: malicious, reasoning: malicious }],
              verification: { strategy: 'call_presence', target: 'auth' },
              crystallized_at: 'now',
              last_verified_at: 'now',
            },
          ],
        },
      ],
      meta: { drift_version: '0.1.0', crystallized_at: 'now', last_checked_at: 'now', total_contracts: 1 },
    };

    expect(renderLs([file])).not.toContain(malicious);
  });

  it('parses plain TypeScript generic arrows as TS, not TSX', () => {
    const parsed = parseSource('src/example.ts', 'export const id = <T>(value: T): T => value;\n');

    expect(extractScopes(parsed).some((scope) => scope.name === 'id')).toBe(true);
  });

  it('does not satisfy qualified call contracts with shorter callees', () => {
    expect(callMatches('create', 'db.invoice.create')).toBe(false);
    expect(callMatches('invoice.create', 'db.invoice.create')).toBe(false);
    expect(callMatches('this.db.invoice.create', 'db.invoice.create')).toBe(true);
  });

  it('treats throws in try-finally without catch as throwing behavior', () => {
    const parsed = parseSource('src/example.ts', 'export function run(): void { try { throw new Error("x"); } finally { cleanup(); } }\n');
    const scope = extractScopes(parsed).find((item) => item.name === 'run');

    expect(scope && hasThrowStatement(scope)).toBe(true);
  });

  it('rejects control characters in repository paths', () => {
    expect(() => normalizeRepoRelative('src/bad\nname.ts')).toThrow();
  });

  it('builds a minimal internal call graph', () => {
    const parsed = parseSource('src/example.ts', 'function helper(): void {}\nexport function run(): void { helper(); }\n');
    const scopes = extractScopes(parsed);
    const graph = buildCallGraph(parsed, scopes);

    expect(graph.get('run')?.internalCalls).toContain('helper');
  });

  it('enumerates simple branch control-flow paths', () => {
    const parsed = parseSource('src/example.ts', 'export function run(value: boolean): void { if (value) { authorize(); return; } audit(); }\n');
    const scope = extractScopes(parsed).find((item) => item.name === 'run');

    expect(scope && enumerateControlFlowPaths(parsed, scope)).toHaveLength(2);
  });

  it('parses git blame porcelain records', () => {
    const blame = parseBlamePorcelain([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author Ada',
      'author-mail <ada@example.com>',
      'author-time 1700000000',
      'summary init',
      '\tconst x = 1;',
    ].join('\n'));

    expect(blame[0]).toMatchObject({ author: 'Ada', finalLine: 1, summary: 'init' });
  });
});
