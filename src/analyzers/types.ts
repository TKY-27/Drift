import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import type { ParsedFile, ScopeInfo } from './ast.js';

const TYPE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const TYPE_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

export interface TypeContext {
  rootDir: string;
  program: ts.Program | null;
  checker: ts.TypeChecker | null;
}

export function createTypeContext(rootDir: string, fileNames: string[]): TypeContext {
  const resolvedRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
  const configPath = path.join(resolvedRoot, 'tsconfig.json');
  const safeFileNames = fileNames.flatMap((fileName) => safeRealFile(resolvedRoot, fileName) ?? []);
  try {
    const hostState = { bytesRead: 0 };
    const guardedHost = guardedParseHost(resolvedRoot, hostState);
    if (fs.existsSync(configPath) && !fs.lstatSync(configPath).isSymbolicLink()) {
      const config = ts.readConfigFile(configPath, (filePath) => guardedReadFile(resolvedRoot, hostState, filePath));
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        guardedHost,
        path.dirname(configPath),
      );
      const program = ts.createProgram(safeFileNames, sanitizeCompilerOptions(parsed.options), guardedCompilerHost(resolvedRoot, hostState, sanitizeCompilerOptions(parsed.options)));
      return { rootDir: resolvedRoot, program, checker: program.getTypeChecker() };
    }
    const options = sanitizeCompilerOptions({
      allowJs: true,
      checkJs: false,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    });
    const program = ts.createProgram(safeFileNames, options, guardedCompilerHost(resolvedRoot, hostState, options));
    return { rootDir: resolvedRoot, program, checker: program.getTypeChecker() };
  } catch {
    return { rootDir: resolvedRoot, program: null, checker: null };
  }
}

export function getExplicitReturnType(parsed: ParsedFile, scope: ScopeInfo): string | null {
  const node = scope.node;
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    node.type
  ) {
    return node.type.getText(parsed.sourceFile);
  }
  return null;
}

export function getReturnType(typeContext: TypeContext, parsed: ParsedFile, scope: ScopeInfo): string {
  const explicit = getExplicitReturnType(parsed, scope);
  if (explicit) return explicit;
  const node = findProgramFunctionNode(typeContext, parsed, scope);
  if (!typeContext.checker || !node) return 'unknown';
  try {
    const signature = typeContext.checker.getSignatureFromDeclaration(node);
    if (!signature) return 'unknown';
    const returnType = typeContext.checker.getReturnTypeOfSignature(signature);
    return typeContext.checker.typeToString(returnType);
  } catch {
    return 'unknown';
  }
}

export interface ParameterContractInfo {
  name: string;
  type: string;
  optional: boolean;
  nullable: boolean;
}

export function getParameterInfo(typeContext: TypeContext, parsed: ParsedFile, scope: ScopeInfo): ParameterContractInfo[] {
  const parsedNode = scope.node;
  if (!isSupportedFunctionNode(parsedNode)) return [];
  const checkerNode = findProgramFunctionNode(typeContext, parsed, scope);
  return parsedNode.parameters.map((param, index) => {
    const name = param.name.getText(parsed.sourceFile);
    const explicit = param.type?.getText(parsed.sourceFile);
    let type = explicit ?? 'unknown';
    const checkerParam = checkerNode?.parameters[index];
    if (!explicit && typeContext.checker && checkerParam) {
      try {
        const symbol = typeContext.checker.getSymbolAtLocation(checkerParam.name);
        if (symbol) type = typeContext.checker.typeToString(typeContext.checker.getTypeOfSymbolAtLocation(symbol, checkerParam.name));
      } catch {
        type = 'unknown';
      }
    }
    return {
      name,
      type,
      optional: Boolean(param.questionToken) || type.includes('undefined'),
      nullable: /\bnull\b/.test(type) || /\bundefined\b/.test(type) || Boolean(param.questionToken),
    };
  });
}

type SupportedFunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isSupportedFunctionNode(node: ts.Node): node is SupportedFunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function findProgramFunctionNode(typeContext: TypeContext, parsed: ParsedFile, scope: ScopeInfo): SupportedFunctionNode | null {
  if (!typeContext.program || !isSupportedFunctionNode(scope.node)) return null;
  const programSource = findProgramSourceFile(typeContext, parsed);
  if (!programSource) return null;
  const start = scope.node.getStart(parsed.sourceFile);
  const end = scope.node.getEnd();
  let found: SupportedFunctionNode | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isSupportedFunctionNode(node) && node.getStart(programSource) === start && node.getEnd() === end) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(programSource);
  return found;
}

function findProgramSourceFile(typeContext: TypeContext, parsed: ParsedFile): ts.SourceFile | null {
  const expected = path.resolve(typeContext.rootDir, parsed.filePath);
  return typeContext.program?.getSourceFile(expected)
    ?? typeContext.program?.getSourceFiles().find((sourceFile) => samePath(sourceFile.fileName, expected))
    ?? null;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function hasThrowStatement(scope: ScopeInfo): boolean {
  let found = false;

  function visit(node: ts.Node, insideCaughtTry = false): void {
    if (found) return;
    if (ts.isTryStatement(node)) {
      ts.forEachChild(node.tryBlock, (child) => visit(child, node.catchClause !== undefined));
      if (node.catchClause) visit(node.catchClause, false);
      if (node.finallyBlock) visit(node.finallyBlock, false);
      return;
    }
    if (ts.isThrowStatement(node) && !insideCaughtTry) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child, insideCaughtTry));
  }

  visit(scope.node);
  return found;
}

function isInsideRoot(rootDir: string, fileName: string): boolean {
  const resolved = fs.existsSync(fileName) ? fs.realpathSync(fileName) : path.resolve(fileName);
  const relative = path.relative(rootDir, resolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeRealFile(rootDir: string, fileName: string): string | null {
  const resolved = path.resolve(fileName);
  if (!isInsideRoot(rootDir, resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  if (fs.lstatSync(resolved).isSymbolicLink()) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > TYPE_FILE_MAX_BYTES) return null;
  return fs.realpathSync(resolved);
}

function guardedParseHost(rootDir: string, state: { bytesRead: number }): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (filePath) => safeRealFile(rootDir, filePath) !== null,
    readFile: (filePath) => guardedReadFile(rootDir, state, filePath),
    readDirectory: (dir, extensions, excludes, includes, depth) => {
      const safeDir = safeRealDirectory(rootDir, dir);
      if (!safeDir) return [];
      return ts.sys.readDirectory(safeDir, extensions, excludes, includes, depth).filter((file) => safeRealFile(rootDir, file) !== null);
    },
    trace: () => undefined,
  };
}

function guardedCompilerHost(rootDir: string, state: { bytesRead: number }, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  host.fileExists = (filePath) => safeRealFile(rootDir, filePath) !== null;
  host.readFile = (filePath) => guardedReadFile(rootDir, state, filePath);
  host.directoryExists = (dirPath) => safeRealDirectory(rootDir, dirPath) !== null;
  host.readDirectory = (dir, extensions, excludes, includes, depth) => {
    const safeDir = safeRealDirectory(rootDir, dir);
    if (!safeDir) return [];
    return ts.sys.readDirectory(safeDir, extensions, excludes, includes, depth).filter((file) => safeRealFile(rootDir, file) !== null);
  };
  host.realpath = (filePath) => safeRealPath(rootDir, filePath) ?? path.resolve(filePath);
  return host;
}

function guardedReadFile(rootDir: string, state: { bytesRead: number }, filePath: string): string | undefined {
  const safeFile = safeRealFile(rootDir, filePath);
  if (!safeFile) return undefined;
  const stat = fs.statSync(safeFile);
  if (state.bytesRead + stat.size > TYPE_TOTAL_MAX_BYTES) return undefined;
  state.bytesRead += stat.size;
  return fs.readFileSync(safeFile, 'utf8');
}

function safeRealDirectory(rootDir: string, dirPath: string): string | null {
  const resolved = path.resolve(dirPath);
  if (!isInsideRoot(rootDir, resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  if (fs.lstatSync(resolved).isSymbolicLink()) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return null;
  return fs.realpathSync(resolved);
}

function safeRealPath(rootDir: string, targetPath: string): string | null {
  return safeRealFile(rootDir, targetPath) ?? safeRealDirectory(rootDir, targetPath);
}

function sanitizeCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  const sanitized: ts.CompilerOptions = {
    allowJs: options.allowJs ?? true,
    checkJs: options.checkJs ?? false,
    module: options.module ?? ts.ModuleKind.ESNext,
    moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    skipLibCheck: true,
    strict: options.strict ?? true,
    target: options.target ?? ts.ScriptTarget.ES2022,
  };
  if (options.esModuleInterop !== undefined) sanitized.esModuleInterop = options.esModuleInterop;
  if (options.exactOptionalPropertyTypes !== undefined) sanitized.exactOptionalPropertyTypes = options.exactOptionalPropertyTypes;
  if (options.jsx !== undefined) sanitized.jsx = options.jsx;
  if (options.noImplicitAny !== undefined) sanitized.noImplicitAny = options.noImplicitAny;
  if (options.strictNullChecks !== undefined) sanitized.strictNullChecks = options.strictNullChecks;
  return sanitized;
}
