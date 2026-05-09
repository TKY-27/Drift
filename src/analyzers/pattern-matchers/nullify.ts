import ts from 'typescript';
import type { DriftConfig } from '../../types/config.js';
import type { Contract } from '../../types/contract.js';
import { isPatternEnabled } from '../../utils/config.js';
import { collectIdentifiersBefore, type ParsedFile, type ScopeInfo, walk, isInsideNestedFunction } from '../ast.js';
import { evidence, isSensitiveName, makeContract } from './common.js';

export interface NullifyPattern {
  variable: string;
  node: ts.BinaryExpression;
  afterFinalUse: boolean;
  allPaths: boolean;
}

export function findNullifyPatterns(scope: ScopeInfo): NullifyPattern[] {
  const results: NullifyPattern[] = [];
  walk(scope.node, (node) => {
    if (!ts.isBinaryExpression(node) || isInsideNestedFunction(scope.node, node)) return;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    if (!ts.isIdentifier(node.left) || !isSensitiveName(node.left.text)) return;
    const rhs = node.right;
    const nullish = rhs.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(rhs) && rhs.text === 'undefined');
    if (!nullish) return;
    const namesBefore = collectIdentifiersBefore(scope, node.getStart());
    if (!namesBefore.has(node.left.text)) return;
    const afterFinalUse = !hasIdentifierReadAfter(scope, node.left.text, node.getEnd());
    const allPaths = isInsideFinallyBlock(scope.node, node)
      || (!isInsideConditionalBranch(scope.node, node) && !hasExitAfterSensitiveReadBefore(scope, node.left.text, node.getStart()));
    results.push({ variable: node.left.text, node, afterFinalUse, allPaths });
  });
  return results;
}

export function detectNullifyPattern(config: DriftConfig, parsed: ParsedFile, scope: ScopeInfo): Contract[] {
  if (!isPatternEnabled(config, 'nullify_after_use')) return [];
  return findNullifyPatterns(scope).filter((pattern) => pattern.afterFinalUse && pattern.allPaths).map((pattern) =>
    makeContract({
      config,
      type: 'invariant',
      pattern: 'nullify_after_use',
      detection: 'ast_pattern',
      severity: 'critical',
      description: `${pattern.variable} is nullified after use in ${scope.name}`,
      evidence: [evidence(parsed, pattern.node, 'ast_node', `Sensitive variable ${pattern.variable} is explicitly cleared after use`)],
      verification: {
        strategy: 'pattern_exists',
        target: 'nullify_after_use',
        params: { variable: pattern.variable, after_final_use: true, in_all_paths: true },
      },
    }),
  );
}

export function hasGuaranteedNullify(scope: ScopeInfo, variable: string): boolean {
  return findNullifyPatterns(scope).some((pattern) => pattern.variable === variable && pattern.afterFinalUse && pattern.allPaths);
}

function hasIdentifierReadAfter(scope: ScopeInfo, variable: string, position: number): boolean {
  let found = false;
  walk(scope.node, (node) => {
    if (found || node.getStart() <= position || isInsideNestedFunction(scope.node, node)) return;
    if (!ts.isIdentifier(node) || node.text !== variable) return;
    if (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;
    found = true;
  });
  return found;
}

function hasExitAfterSensitiveReadBefore(scope: ScopeInfo, variable: string, position: number): boolean {
  let firstRead: number | null = null;
  const exits: number[] = [];
  walk(scope.node, (node) => {
    if (node.getStart() >= position || isInsideNestedFunction(scope.node, node)) return;
    if (ts.isIdentifier(node) && node.text === variable && isIdentifierRead(node)) {
      firstRead = firstRead === null ? node.getStart() : Math.min(firstRead, node.getStart());
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) exits.push(node.getStart());
  });
  const firstReadPosition = firstRead;
  return firstReadPosition !== null && exits.some((exitPosition) => exitPosition > firstReadPosition && exitPosition < position);
}

function isInsideConditionalBranch(root: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (ts.isBlock(current) && ts.isTryStatement(current.parent) && current.parent.finallyBlock === current) return false;
    if (ts.isIfStatement(current) || ts.isSwitchStatement(current) || ts.isConditionalExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

function isInsideFinallyBlock(root: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (ts.isBlock(current) && ts.isTryStatement(current.parent) && current.parent.finallyBlock === current) return true;
    current = current.parent;
  }
  return false;
}

function isIdentifierRead(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  return true;
}
