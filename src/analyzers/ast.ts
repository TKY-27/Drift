import ts from 'typescript';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { safeSnippet, sha256 } from '../utils/security.js';

export interface ParsedFile {
  sourceFile: ts.SourceFile;
  sourceText: string;
  filePath: string;
  tree: Parser.Tree;
}

export interface ScopeInfo {
  name: string;
  kind: 'function' | 'method' | 'class' | 'module';
  qualified_name: string;
  signature_hash: string;
  node_hash: string;
  node: ts.Node;
  body?: ts.Block;
  line_start: number;
  line_end: number;
  snippet: string;
}

export interface ImportInfo {
  module: string;
  names: string[];
  named: Array<{ imported: string; local: string }>;
  default?: string;
  namespace?: string;
  typeOnly: boolean;
  line: number;
  snippet: string;
}

export function parseSource(filePath: string, sourceText: string): ParsedFile {
  const parser = new Parser();
  parser.setLanguage(isJsxLike(filePath) ? TypeScript.tsx : TypeScript.typescript);
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') : 'unknown parse error';
    throw new Error(`Failed to parse ${filePath}: ${message}`);
  }
  return {
    filePath,
    sourceText,
    tree: parseTreeSitter(parser, sourceText),
    sourceFile,
  };
}

function parseTreeSitter(parser: Parser, sourceText: string): Parser.Tree {
  try {
    return parser.parse(sourceText);
  } catch {
    return parser.parse('');
  }
}

export function findTreeSitterPattern(parsed: ParsedFile, query: string, scope?: ScopeInfo): boolean {
  // tree-sitter-typescript ships a native binding with incomplete typed-lint metadata.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const language = parsed.filePath.endsWith('.tsx') || parsed.filePath.endsWith('.jsx') ? TypeScript.tsx : TypeScript.typescript;
  const parserQuery = new Parser.Query(language, query);
  return parserQuery.matches(parsed.tree.rootNode).some((match) => {
    if (!scope) return true;
    const start = parsed.sourceFile.getLineAndCharacterOfPosition(scope.node.getStart(parsed.sourceFile)).line;
    const end = parsed.sourceFile.getLineAndCharacterOfPosition(scope.node.getEnd()).line;
    return match.captures.some((capture) => capture.node.startPosition.row >= start && capture.node.endPosition.row <= end);
  });
}

export function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { line_start: number; line_end: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { line_start: start, line_end: end };
}

export function nodeSnippet(sourceFile: ts.SourceFile, node: ts.Node): string {
  return safeSnippet(node.getText(sourceFile));
}

export function extractScopes(parsed: ParsedFile): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];
  const sourceFile = parsed.sourceFile;

  function pushScope(node: ts.Node, name: string, kind: ScopeInfo['kind'], body?: ts.Block): void {
    const range = lineRange(sourceFile, node);
    const scope: ScopeInfo = {
      name,
      kind,
      qualified_name: qualifiedName(node, name, kind),
      signature_hash: sha256(signatureText(sourceFile, node)).slice(0, 16),
      node_hash: sha256(node.getText(sourceFile)).slice(0, 16),
      node,
      ...range,
      snippet: nodeSnippet(sourceFile, node),
    };
    if (body) scope.body = body;
    scopes.push(scope);
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      pushScope(node, node.name.text, 'function', node.body);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
            const body = ts.isBlock(declaration.initializer.body) ? declaration.initializer.body : undefined;
            pushScope(declaration.initializer, declaration.name.text, 'function', body);
          }
        }
      }
    } else if (ts.isMethodDeclaration(node) && node.name && node.body) {
      pushScope(node, propertyNameText(node.name), 'method', node.body);
    } else if (ts.isClassDeclaration(node) && node.name) {
      pushScope(node, node.name.text, 'class');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return scopes;
}

export function extractImports(parsed: ParsedFile): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const sourceFile = parsed.sourceFile;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const names: string[] = [];
    const named: Array<{ imported: string; local: string }> = [];
    const clause = statement.importClause;
    if (clause?.name) names.push(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.push(element.name.text);
        named.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text });
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    }
    const info: ImportInfo = {
      module: statement.moduleSpecifier.text,
      names,
      named,
      typeOnly: statement.importClause?.isTypeOnly === true,
      line: lineRange(sourceFile, statement).line_start,
      snippet: nodeSnippet(sourceFile, statement),
    };
    if (clause?.name) info.default = clause.name.text;
    if (bindings && ts.isNamespaceImport(bindings)) info.namespace = bindings.name.text;
    imports.push(info);
  }
  return imports;
}

export function propertyNameText(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return name.expression.getText();
  return name.getText();
}

export function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

export function isInsideNestedFunction(root: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function findScope(scopes: ScopeInfo[], name: string, kind: ScopeInfo['kind']): ScopeInfo | null {
  return scopes.find((scope) => scope.name === name && scope.kind === kind) ?? null;
}

export function findScopeByStableId(scopes: ScopeInfo[], stored: Pick<ScopeInfo, 'name' | 'kind'> & Partial<Pick<ScopeInfo, 'qualified_name' | 'signature_hash' | 'node_hash'>>): ScopeInfo | null {
  if (stored.qualified_name) {
    const byQualified = scopes.filter((scope) => scope.qualified_name === stored.qualified_name && scope.kind === stored.kind);
    if (stored.signature_hash) {
      const bySignature = byQualified.find((scope) => scope.signature_hash === stored.signature_hash);
      if (bySignature) return bySignature;
    }
    if (stored.node_hash) {
      const byNode = byQualified.find((scope) => scope.node_hash === stored.node_hash);
      if (byNode) return byNode;
    }
    if (byQualified.length === 1) return byQualified[0] ?? null;
    if (stored.qualified_name !== stored.name) return null;
  }
  if (stored.signature_hash) {
    const bySignature = scopes.find((scope) => scope.name === stored.name && scope.kind === stored.kind && scope.signature_hash === stored.signature_hash);
    if (bySignature) return bySignature;
  }
  return findScope(scopes, stored.name, stored.kind);
}

function isJsxLike(filePath: string): boolean {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function collectIdentifiersBefore(scope: ScopeInfo, position: number): Set<string> {
  const names = new Set<string>();
  walk(scope.node, (node) => {
    if (node.getStart() >= position) return;
    if (ts.isIdentifier(node) && !isInsideNestedFunction(scope.node, node)) {
      names.add(node.text);
    }
  });
  return names;
}

function qualifiedName(node: ts.Node, name: string, kind: ScopeInfo['kind']): string {
  if (kind === 'method') {
    const classNode = findParentClass(node);
    if (classNode?.name) return `${classNode.name.text}.${name}`;
  }
  return name;
}

function findParentClass(node: ts.Node): ts.ClassDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

function signatureText(sourceFile: ts.SourceFile, node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const params = node.parameters.map((param) => param.getText(sourceFile)).join(',');
    const returnType = node.type?.getText(sourceFile) ?? '';
    return `${params}:${returnType}`;
  }
  return node.getText(sourceFile).slice(0, 300);
}
