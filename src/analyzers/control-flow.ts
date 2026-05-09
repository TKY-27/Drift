import ts from 'typescript';
import type { ParsedFile, ScopeInfo } from './ast.js';
import { isInsideNestedFunction, lineRange, nodeSnippet, walk } from './ast.js';
import { expressionName } from './call-graph.js';

export type ErrorStrategy = 'none' | 'rethrow' | 'wrap_and_throw' | 'return_error' | 'swallow' | 'fallback';

export interface ErrorHandlingPattern {
  strategy: ErrorStrategy;
  line: number;
  snippet: string;
}

export interface ControlFlowPath {
  calls: string[];
  exits: boolean;
  line_start: number;
  line_end: number;
}

export function enumerateControlFlowPaths(parsed: ParsedFile, scope: ScopeInfo): ControlFlowPath[] {
  const statements = scope.body ? [...scope.body.statements] : [scope.node];
  const paths = enumerateStatements(statements).map((path) => {
    const lines = path.nodes.map((node) => lineRange(parsed.sourceFile, node));
    return {
      calls: path.calls,
      exits: path.exits,
      line_start: Math.min(...lines.map((line) => line.line_start), scope.line_start),
      line_end: Math.max(...lines.map((line) => line.line_end), scope.line_end),
    };
  });
  return paths.length > 0 ? paths : [{ calls: [], exits: false, line_start: scope.line_start, line_end: scope.line_end }];
}

export function detectErrorHandling(parsed: ParsedFile, scope: ScopeInfo): ErrorHandlingPattern | null {
  let pattern: ErrorHandlingPattern | null = null;
  walk(scope.node, (node) => {
    if (pattern || !ts.isTryStatement(node) || !node.catchClause || isInsideNestedFunction(scope.node, node)) return;
    const block = node.catchClause.block;
    const strategy = classifyCatchBlock(block);
    pattern = {
      strategy,
      line: lineRange(parsed.sourceFile, node.catchClause).line_start,
      snippet: nodeSnippet(parsed.sourceFile, node.catchClause),
    };
  });
  return pattern;
}

export function classifyCatchBlock(block: ts.Block): ErrorStrategy {
  if (block.statements.length === 0) return 'swallow';
  let sawConsoleOnly = true;
  for (const statement of block.statements) {
    if (ts.isThrowStatement(statement)) {
      const expression = statement.expression;
      if (expression && ts.isNewExpression(expression)) return 'wrap_and_throw';
      return 'rethrow';
    }
    if (ts.isReturnStatement(statement)) {
      const text = statement.expression?.getText() ?? '';
      if (/error|err|failure|Result|left|ok:\s*false/i.test(text)) return 'return_error';
      return 'fallback';
    }
    const text = statement.getText();
    if (!/^console\.(log|warn|error|debug)\(/.test(text)) {
      sawConsoleOnly = false;
    }
  }
  return sawConsoleOnly ? 'swallow' : 'fallback';
}

interface PathBuilder {
  calls: string[];
  exits: boolean;
  nodes: ts.Node[];
}

function enumerateStatements(statements: ts.Node[]): PathBuilder[] {
  let paths: PathBuilder[] = [{ calls: [], exits: false, nodes: [] }];
  for (const statement of statements) {
    const branches = pathsForStatement(statement);
    paths = paths.flatMap((path) => {
      if (path.exits) return [path];
      return branches.map((branch) => ({
        calls: [...path.calls, ...branch.calls],
        exits: branch.exits,
        nodes: [...path.nodes, ...branch.nodes],
      }));
    });
  }
  return paths;
}

function pathsForStatement(statement: ts.Node): PathBuilder[] {
  if (ts.isIfStatement(statement)) {
    const thenStatements = ts.isBlock(statement.thenStatement) ? [...statement.thenStatement.statements] : [statement.thenStatement];
    const elseStatements = statement.elseStatement
      ? ts.isBlock(statement.elseStatement)
        ? [...statement.elseStatement.statements]
        : [statement.elseStatement]
      : [];
    return [...enumerateStatements(thenStatements), ...enumerateStatements(elseStatements)].map((path) => ({
      ...path,
      nodes: [statement, ...path.nodes],
    }));
  }
  const calls: string[] = [];
  walk(statement, (node) => {
    if (node !== statement && isInsideNestedFunction(statement, node)) return;
    if (ts.isCallExpression(node)) calls.push(expressionName(node.expression));
  });
  return [{ calls, exits: ts.isReturnStatement(statement) || ts.isThrowStatement(statement), nodes: [statement] }];
}
