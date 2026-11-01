import { Engine } from "php-parser";

type AstNode = Record<string, any>;

export type PhpCodeLensSymbol = {
  name: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  selection: { line: number; column: number };
};

const engine = new Engine({
  parser: { extractDoc: false, suppressErrors: false },
  ast: { withPositions: true, withSource: false },
  lexer: { all_tokens: false, comment_tokens: false },
});

const supportedKinds = new Set(["class", "interface", "trait", "enum", "method", "function"]);

function textName(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  for (const candidate of [node?.name, node?.value, node?.raw]) {
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return "";
}

function walk(node: any, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.kind === "string") visit(node);
  for (const value of Object.values(node)) {
    if (value === node.loc || value === node.leadingComments || value === node.trailingComments) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

export function parsePhpCodeLensSymbols(source: string, sourcePath = "document.php"): PhpCodeLensSymbol[] {
  try {
    const program = engine.parseCode(source, sourcePath) as AstNode;
    const symbols: PhpCodeLensSymbol[] = [];
    walk(program, (node) => {
      if (!supportedKinds.has(node.kind)) return;
      const name = textName(node.name);
      const start = node.loc?.start;
      const end = node.loc?.end;
      if (!name || !Number.isInteger(start?.line) || !Number.isInteger(end?.line)) return;
      const selection = node.name?.loc?.start ?? start;
      symbols.push({
        name,
        range: {
          startLine: Math.max(0, start.line - 1),
          startColumn: Math.max(0, start.column ?? 0),
          endLine: Math.max(0, end.line - 1),
          endColumn: Math.max(0, end.column ?? 0),
        },
        selection: {
          line: Math.max(0, (selection.line ?? start.line) - 1),
          column: Math.max(0, selection.column ?? start.column ?? 0),
        },
      });
    });
    return symbols;
  } catch {
    return [];
  }
}
