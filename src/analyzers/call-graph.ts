import ts from 'typescript';
import { type ParsedFile, type ScopeInfo, isInsideNestedFunction, lineRange, nodeSnippet, propertyNameText, walk } from './ast.js';

export interface CallSite {
  callee: string;
  argsText: string;
  line: number;
  snippet: string;
  node: ts.CallExpression;
}

export interface SideEffectPattern {
  category: 'db_write' | 'event_emit' | 'external_api' | 'file_write' | 'cache_mutation';
  patterns: RegExp[];
}

export const SIDE_EFFECT_PATTERNS: SideEffectPattern[] = [
  {
    category: 'db_write',
    patterns: [
      /^db\.\w+\.(create|update|delete|upsert|insert|remove)$/,
      /^prisma\.\w+\.(create|update|delete|upsert)$/,
      /^knex(?:\(|\.).*\.(insert|update|del)$/,
      /^sequelize\.\w+\.(create|update|destroy)$/,
      /^mongoose\.\w+\.(save|create|updateOne|deleteOne)$/,
      /(^|\.)save$/,
    ],
  },
  { category: 'event_emit', patterns: [/(\.|^)(emit|dispatch|publish|send|broadcast)$/] },
  {
    category: 'external_api',
    patterns: [
      /^fetch$/,
      /^axios\.(get|post|put|patch|delete)$/,
      /^http\.(get|post|put|request)$/,
      /^got\.(get|post|put)$/,
    ],
  },
  { category: 'file_write', patterns: [/^(fs|fsPromises)\.(write|writeFile|append|appendFile|mkdir|unlink|rm|rename)$/] },
  { category: 'cache_mutation', patterns: [/^(cache|redis)\.(set|del|delete|expire|hset|hdel|hmset|lpush|rpush)$/] },
];

export function extractCalls(parsed: ParsedFile, scope: ScopeInfo): CallSite[] {
  const calls: CallSite[] = [];
  walk(scope.node, (node) => {
    if (!ts.isCallExpression(node) || isInsideNestedFunction(scope.node, node)) return;
    calls.push({
      callee: expressionName(node.expression),
      argsText: node.arguments.map((arg) => arg.getText(parsed.sourceFile)).join(', '),
      line: lineRange(parsed.sourceFile, node).line_start,
      snippet: nodeSnippet(parsed.sourceFile, node),
      node,
    });
  });
  return calls;
}

export function expressionName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return `${expressionName(expression.expression)}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression)) {
    return `${expressionName(expression.expression)}.${expression.argumentExpression.getText()}`;
  }
  return expression.getText();
}

export function callMatches(callee: string, target: string): boolean {
  return callee === target || callee.endsWith(`.${target}`);
}

export function isSideEffectCall(call: CallSite): SideEffectPattern['category'] | null {
  for (const group of SIDE_EFFECT_PATTERNS) {
    if (group.patterns.some((pattern) => pattern.test(call.callee))) return group.category;
  }
  return null;
}

export function isValidationCall(call: CallSite): boolean {
  return /(^|\.)((validate|assert|parse|safeParse|checkInput|requireField)[A-Z_a-z0-9]*|schema\.(parse|safeParse))$/.test(call.callee);
}

export function isRateLimitCall(call: CallSite): boolean {
  return /(^|\.)(rateLimit|rateLimiter|limiter)\.(check|consume|assert|enforce)$/.test(call.callee)
    || /(^|\.)(checkRateLimit|enforceRateLimit|requireRateLimit)$/.test(call.callee);
}

export function isAuthCall(call: CallSite): boolean {
  return /(^|\.)(authorize|requireAuth|assertAuth|checkPermission|verifyPermission|verifyToken|authenticate)$/.test(call.callee);
}

export function isInsideTransactionCall(call: CallSite): boolean {
  let current: ts.Node | undefined = call.node.parent;
  while (current) {
    if (ts.isCallExpression(current) && /(^|\.)(transaction|\$transaction)$/.test(expressionName(current.expression))) return true;
    current = current.parent;
  }
  return false;
}

export function isCallConditionallyNested(scope: ScopeInfo, call: CallSite): boolean {
  let current: ts.Node | undefined = call.node.parent;
  while (current && current !== scope.node) {
    if (ts.isIfStatement(current) || ts.isSwitchStatement(current) || ts.isConditionalExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

export function hasExitBeforeCall(scope: ScopeInfo, call: CallSite): boolean {
  let found = false;
  walk(scope.node, (node) => {
    if (found || node.getStart() >= call.node.getStart() || isInsideNestedFunction(scope.node, node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) found = true;
  });
  return found;
}

export function firstStatementsContainCall(scope: ScopeInfo, calls: CallSite[], predicate: (call: CallSite) => boolean): CallSite | null {
  if (!scope.body) return calls.find(predicate) ?? null;
  const firstStatements = new Set(scope.body.statements.slice(0, 3));
  return calls.find((call) => {
    if (!predicate(call)) return false;
    const statement = enclosingStatement(scope, call.node);
    return statement !== null && firstStatements.has(statement);
  }) ?? null;
}

export interface CallGraphNode {
  scope: string;
  calls: string[];
  internalCalls: string[];
}

export function buildCallGraph(parsed: ParsedFile, scopes: ScopeInfo[]): Map<string, CallGraphNode> {
  const scopeNames = new Set(scopes.map((scope) => scope.name));
  const graph = new Map<string, CallGraphNode>();
  for (const scope of scopes) {
    const calls = extractCalls(parsed, scope).map((call) => call.callee);
    graph.set(scope.name, {
      scope: scope.name,
      calls,
      internalCalls: calls.filter((call) => scopeNames.has(call.split('.').pop() ?? call)),
    });
  }
  return graph;
}

function enclosingStatement(scope: ScopeInfo, node: ts.Node): ts.Statement | null {
  if (!scope.body) return null;
  let current: ts.Node = node;
  while (current.parent && current.parent !== scope.body) {
    current = current.parent;
  }
  return ts.isStatement(current) ? current : null;
}

export function calleeFromImportName(name: ts.PropertyName | ts.BindingName): string {
  return propertyNameText(name);
}
