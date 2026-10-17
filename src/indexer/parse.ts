import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const grammars = {
  py: () => require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
  ts: () => require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  tsx: () => require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
};
export type Grammar = keyof typeof grammars;

let ready: Promise<void> | undefined;
const parsers = new Map<Grammar, Parser>();

export async function parser(g: Grammar): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let p = parsers.get(g);
  if (!p) {
    p = new Parser();
    p.setLanguage(await Language.load(grammars[g]()));
    parsers.set(g, p);
  }
  return p;
}

export async function parse(g: Grammar, source: string): Promise<Node> {
  const tree = (await parser(g)).parse(source);
  if (!tree) throw new Error('parse failed');
  return tree.rootNode;
}

export type { Node };

/** Depth-first walk; return false from `visit` to skip a subtree. */
export function walk(n: Node, visit: (n: Node) => boolean | void): void {
  if (visit(n) === false) return;
  for (const c of n.namedChildren) if (c) walk(c, visit);
}

export const line = (n: Node) => n.startPosition.row + 1;

export function ancestors(n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
}
