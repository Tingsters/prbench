// Inspect static orchestration arguments. Never execute transcript code.
import ts from 'typescript';
import { isAbsolute } from 'node:path';

export interface ExecutionContext {
  command: string;
  cwd: string;
  cwdSource?: 'recorded-turn-context';
}
export function staticExecutionContexts(
  code: string,
  defaultCwd?: string,
): ExecutionContext[] {
  const file = ts.createSourceFile(
    'call.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (
    (file as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics.length
  )
    return [];
  const constants = new Map<string, string>();
  const bindings = new Set<string>();
  const contexts: ExecutionContext[] = [];
  const value = (node: ts.Expression | undefined): string | undefined => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const part = value(span.expression);
        if (part === undefined) return;
        result += part + span.literal.text;
      }
      return result;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = value(node.left),
        right = value(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
  };
  const name = (node: ts.Expression) => node.getText(file);
  const execute = (node: ts.Expression): boolean => {
    if (ts.isAwaitExpression(node)) return execute(node.expression);
    if (!ts.isCallExpression(node)) return false;
    if (['Promise.all', 'Promise.allSettled'].includes(name(node.expression))) {
      const array = node.arguments[0];
      return (
        node.arguments.length === 1 &&
        !!array &&
        ts.isArrayLiteralExpression(array) &&
        array.elements.every((e) => ts.isExpression(e) && execute(e))
      );
    }
    if (
      name(node.expression) !== 'tools.exec_command' ||
      node.arguments.length !== 1
    )
      return false;
    const object = node.arguments[0];
    if (!object || !ts.isObjectLiteralExpression(object)) return false;
    const properties = new Map<string, ts.Expression>();
    for (const p of object.properties) {
      if (
        !ts.isPropertyAssignment(p) ||
        !p.name ||
        ts.isComputedPropertyName(p.name)
      )
        return false;
      properties.set(
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
          ? p.name.text
          : '',
        p.initializer,
      );
    }
    const command = value(properties.get('cmd')),
      cwd = properties.has('workdir')
        ? value(properties.get('workdir'))
        : defaultCwd;
    if (!command || !cwd || !isAbsolute(cwd)) return false;
    contexts.push({
      command,
      cwd,
      ...(properties.has('workdir')
        ? {}
        : { cwdSource: 'recorded-turn-context' as const }),
    });
    return true;
  };
  const print = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node)) return false;
    if (['text', 'notify'].includes(name(node.expression))) {
      if (
        node.arguments.length === 1 &&
        ts.isAwaitExpression(node.arguments[0]!) &&
        execute(node.arguments[0]!)
      )
        return true;
      let safe = true;
      const inspect = (n: ts.Node) => {
        if (ts.isCallExpression(n) || ts.isFunctionLike(n)) safe = false;
        ts.forEachChild(n, inspect);
      };
      node.arguments.forEach((a) => inspect(a));
      return safe;
    }
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'forEach' ||
      node.arguments.length !== 1
    )
      return false;
    const callback = node.arguments[0]!;
    if (ts.isIdentifier(callback))
      return ['text', 'notify'].includes(callback.text);
    if (
      !ts.isArrowFunction(callback) ||
      callback.parameters.some(
        (p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken,
      )
    )
      return false;
    return ts.isBlock(callback.body)
      ? callback.body.statements.every(
          (s) => ts.isExpressionStatement(s) && print(s.expression),
        )
      : print(callback.body);
  };
  for (const statement of file.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          bindings.has(declaration.name.text) ||
          ['tools', 'Promise', 'text', 'notify'].includes(
            declaration.name.text,
          ) ||
          !declaration.initializer
        )
          return [];
        bindings.add(declaration.name.text);
        const literal = value(declaration.initializer);
        if (literal !== undefined)
          constants.set(declaration.name.text, literal);
        else if (!execute(declaration.initializer)) return [];
      }
    } else if (ts.isExpressionStatement(statement)) {
      if (!execute(statement.expression) && !print(statement.expression))
        return [];
    } else if (
      ts.isForOfStatement(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      const declaration = statement.initializer;
      if (
        !ts.isVariableDeclarationList(declaration) ||
        !(declaration.flags & ts.NodeFlags.Const) ||
        declaration.declarations.length !== 1 ||
        !ts.isIdentifier(declaration.declarations[0]!.name)
      )
        return [];
      const body = ts.isBlock(statement.statement)
        ? statement.statement.statements
        : [statement.statement];
      if (
        !body.every((s) => ts.isExpressionStatement(s) && print(s.expression))
      )
        return [];
    } else return [];
  }
  return contexts;
}

/** Match exact display spellings, never a substring or guessed shell interpretation. */
export function displaysCommand(display: string, command: string): boolean {
  if (display === command) return true;
  const shell =
    /^(?:"(?:[^"\r\n]*[\\/])?(?:pwsh|powershell)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:pwsh|powershell)(?:\.exe)?'|(?:[^\s"']*[\\/])?(?:pwsh|powershell)(?:\.exe)?)\s+-Command\s+([\s\S]+)$/i.exec(
      display,
    ) ??
    /^(?:"[^"\r\n]*\/(?:bash|sh)"|'[^'\r\n]*\/(?:bash|sh)'|(?:[^\s"']*\/)?(?:bash|sh))\s+-[lc]+\s+([\s\S]+)$/.exec(
      display,
    );
  if (!shell) return false;
  return [
    command,
    JSON.stringify(command),
    `'${command.replaceAll("'", "'\\''")}'`,
    `'${command.replaceAll("'", "'\"'\"'")}'`,
    `'${command.replaceAll("'", "''")}'`,
  ].includes(shell[1]!);
}
