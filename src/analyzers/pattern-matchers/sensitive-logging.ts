import ts from 'typescript';
import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import type { ParsedFile, ScopeInfo } from '../ast.js';
import { extractCalls, type CallSite } from '../call-graph.js';
import { collectSensitiveNames, evidence, makeContract } from './common.js';

const LOGGER_PATTERN = /(^console\.(log|warn|error|debug|info)$)|(^logger\.)|(\.logger\.)/;

export function findSensitiveLogging(parsed: ParsedFile, scope: ScopeInfo, sensitiveNames?: Iterable<string>): CallSite[] {
  const names = [...collectTaintedNames(scope, sensitiveNames)];
  if (names.length === 0) return [];
  return extractCalls(parsed, scope).filter((call) => {
    if (!LOGGER_PATTERN.test(call.callee)) return false;
    return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(call.argsText));
  });
}

function collectTaintedNames(scope: ScopeInfo, sensitiveNames?: Iterable<string>): Set<string> {
  const tainted = new Set(sensitiveNames ?? collectSensitiveNames(scope));
  let changed = true;
  while (changed) {
    changed = false;
    visit(scope.node);
  }
  return tainted;

  function visit(node: ts.Node): void {
    if (isNested(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && containsTainted(node.initializer)) {
      if (!tainted.has(node.name.text)) {
        tainted.add(node.name.text);
        changed = true;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && containsTainted(node.right)) {
      if (!tainted.has(node.left.text)) {
        tainted.add(node.left.text);
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  }

  function containsTainted(node: ts.Node): boolean {
    let found = false;
    function walkNode(child: ts.Node): void {
      if (found) return;
      if (ts.isIdentifier(child) && tainted.has(child.text)) found = true;
      ts.forEachChild(child, walkNode);
    }
    walkNode(node);
    return found;
  }

  function isNested(node: ts.Node): boolean {
    return node !== scope.node
      && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));
  }
}

export function detectNoLogSensitivePattern(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  if (!isPatternEnabled(config, 'no_log_sensitive')) return [];
  const names = [...collectSensitiveNames(scope)];
  if (names.length === 0 || findSensitiveLogging(parsed, scope, names).length > 0) return [];
  const anchor = firstIdentifierNode(scope.node, names[0] ?? '') ?? scope.node;
  return [
    makeContract({
      config,
      type: 'invariant',
      pattern: 'no_log_sensitive',
      detection: 'call_graph',
      severity: 'critical',
      description: `Sensitive values are never passed to console/logger calls in ${scope.name}`,
      evidence: [evidence(parsed, anchor, 'pattern_match', `Sensitive identifiers detected: ${names.join(', ')}; no logging calls consume them`)],
      verification: {
        strategy: 'call_absence',
        target: 'sensitive_logging',
        params: { sensitive_names: names },
      },
    }),
  ];
}

function firstIdentifierNode(root: ts.Node, name: string): ts.Node | null {
  let result: ts.Node | null = null;
  function visit(node: ts.Node): void {
    if (result) return;
    if (ts.isIdentifier(node) && node.text === name) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
