/** Stage keys describe effective inputs; an unrelated Git commit is provenance. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { digest } from "../util/hash.ts";
import { randomUUID } from "node:crypto";
import ts from "typescript";

export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const stageKey = (stage: string, value: unknown) =>
  digest(canonical({ schema: "prbench.stage-key/v2", stage, value }));
export function implementationDigest(root: string, entries: string[]): string {
  const files = new Map<string, string>();
  const packageFile = join(root, "package.json");
  const pkg = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8"))
    : {};
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const visit = (file: string) => {
    const path = resolve(root, file),
      name = relative(root, path).replace(/\\/g, "/");
    if (name === ".." || name.startsWith("../"))
      throw new Error(`Stage dependency escapes its declared root: ${name}`);
    if (files.has(name)) return;
    const source = readFileSync(path, "utf8");
    files.set(name, digest(source));
    if (![".ts", ".js", ".mts", ".mjs", ".cjs"].includes(extname(path))) return;
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const module = (specifier: string) => {
      if (!specifier.startsWith(".")) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!;
        if (
          !specifier.startsWith("node:") &&
          specifier !== "bun" &&
          !declared.has(packageName)
        )
          throw new Error(
            `Unclassified package dependency: ${name} -> ${specifier}`,
          );
        return;
      }
      const target = resolve(dirname(path), specifier),
        found = [
          target,
          `${target}.ts`,
          `${target}.js`,
          join(target, "index.ts"),
        ].find(existsSync);
      if (!found)
        throw new Error(`Unresolved stage dependency: ${name} -> ${specifier}`);
      visit(found);
    };
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        if (
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly)
        )
          continue;
        if (ts.isStringLiteral(statement.moduleSpecifier))
          module(statement.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier
      ) {
        if (statement.isTypeOnly) continue;
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 &&
          statement.exportClause.elements.every((e) => e.isTypeOnly)
        )
          continue;
        if (ts.isStringLiteral(statement.moduleSpecifier))
          module(statement.moduleSpecifier.text);
      }
    }
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (!arg || !ts.isStringLiteral(arg))
          throw new Error(
            `Dynamic stage dependency needs an explicit contract: ${name}`,
          );
        module(arg.text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  };
  for (const entry of entries) visit(entry);
  return stageKey(
    "implementation",
    [...files].sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function directoryHash(root: string, only?: string[]): string {
  const files: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(dir, entry.name),
        name = relative(root, file).replace(/\\/g, "/");
      if (entry.isSymbolicLink())
        throw new Error(`Immutable inputs contain a symlink: ${name}`);
      if (entry.isDirectory()) walk(file);
      else if (!only || only.includes(name))
        files.push([name, digest(readFileSync(file))]);
    }
  };
  walk(root);
  return stageKey("directory", files);
}
export class StageCache {
  constructor(readonly root: string) {}
  private path(stage: string, key: string) {
    if (!/^[a-z-]+$/.test(stage) || !/^[a-f0-9]{64}$/.test(key))
      throw new Error("Invalid cache address.");
    return join(this.root, stage, `${key}.json`);
  }
  get<T>(stage: string, key: string): T | undefined {
    const file = this.path(stage, key);
    if (!existsSync(file)) return;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (
      value.schema !== "prbench.cache/v2" ||
      value.key !== key ||
      value.sha256 !== digest(canonical(value.payload))
    )
      throw new Error(`Cache integrity failure: ${stage}/${key}`);
    return value.payload as T;
  }
  put<T>(stage: string, key: string, payload: T) {
    const file = this.path(stage, key),
      existing = this.get<T>(stage, key);
    if (existing !== undefined) {
      if (canonical(existing) !== canonical(payload))
        throw new Error("Attempted to overwrite an immutable cache entry.");
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify(
        {
          schema: "prbench.cache/v2",
          key,
          sha256: digest(canonical(payload)),
          payload,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600, flush: true },
    );
    try {
      linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (canonical(this.get(stage, key)) !== canonical(payload))
        throw new Error("Attempted to overwrite an immutable cache entry.");
    } finally {
      unlinkSync(temp);
    }
  }
  putIfAbsent<T>(stage: string, key: string, payload: T) {
    try {
      this.put(stage, key, payload);
    } catch (error) {
      if (
        !String(error).includes("overwrite an immutable cache entry") ||
        this.get(stage, key) === undefined
      )
        throw error;
    }
  }
}
