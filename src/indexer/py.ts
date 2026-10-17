import { providers } from '../surface/providers.js';
import { ancestors, line, parse, walk, type Node } from './parse.js';
import type { ArgFact, CallSiteFact, FileFacts, ImportedClients } from './types.js';

type Sym = { provider: string; kind: 'ctor' | 'module' | 'client' };

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route', 'api_route']);

/** Flatten `a.b.c` into ["a","b","c"]; undefined if the chain contains anything but names. */
function chain(n: Node): string[] | undefined {
  if (n.type === 'identifier') return [n.text];
  if (n.type === 'attribute') {
    const head = chain(n.childForFieldName('object')!);
    const attr = n.childForFieldName('attribute');
    return head && attr ? [...head, attr.text] : undefined;
  }
  return undefined;
}

function stringValue(n: Node): string | undefined {
  if (n.type !== 'string') return undefined;
  if (n.namedChildren.some((c) => c?.type === 'interpolation')) return undefined;
  return n.namedChildren.filter((c) => c?.type === 'string_content').map((c) => c!.text).join('');
}

function literalList(n: Node): string[] | undefined {
  if (n.type !== 'list' && n.type !== 'tuple') return undefined;
  const vals = n.namedChildren.map((c) => (c ? stringValue(c) : undefined));
  return vals.length && vals.every((v) => v !== undefined) ? (vals as string[]) : undefined;
}

export async function extractPy(path: string, source: string, imported: ImportedClients): Promise<FileFacts> {
  const root = await parse('py', source);
  const lines = source.split('\n');
  const facts: FileFacts = { path, lang: 'py', functions: [{ name: '<module>', line: 1 }], calls: [], imports: [], routes: [], callSites: [], exportedClients: [] };

  // --- imports and provider symbols
  const syms = new Map<string, Sym>();
  for (const [local, provider] of imported) syms.set(local, { provider, kind: 'client' });
  const pyImports = providers().flatMap((p) => Object.entries(p.py.imports).map(([mod, spec]) => ({ p: p.id, mod, spec })));

  walk(root, (n) => {
    if (n.type === 'import_statement') {
      for (const c of n.namedChildren) {
        if (!c) continue;
        const [mod, local] = c.type === 'aliased_import'
          ? [c.childForFieldName('name')!.text, c.childForFieldName('alias')!.text]
          : [c.text, c.text.split('.')[0]];
        facts.imports.push({ local, module: mod, imported: '*' });
        const hit = pyImports.find((x) => x.mod === mod);
        if (hit) syms.set(local, { provider: hit.p, kind: hit.spec.module_client ? 'client' : 'module' });
      }
      return false;
    }
    if (n.type === 'import_from_statement') {
      const mod = n.childForFieldName('module_name')!.text;
      for (const c of n.childrenForFieldName('name')) {
        if (!c) continue;
        const [name, local] = c.type === 'aliased_import'
          ? [c.childForFieldName('name')!.text, c.childForFieldName('alias')!.text]
          : [c.text, c.text];
        facts.imports.push({ local, module: mod, imported: name });
        const asModule = pyImports.find((x) => x.mod === `${mod}.${name}`);
        const asCtor = pyImports.find((x) => x.mod === mod && x.spec.ctors.includes(name));
        if (asModule) syms.set(local, { provider: asModule.p, kind: asModule.spec.module_client ? 'client' : 'module' });
        else if (asCtor) syms.set(local, { provider: asCtor.p, kind: 'ctor' });
      }
      return false;
    }
  });

  /** Provider of a constructor call, e.g. `OpenAI()` or `genai.Client()`. */
  const ctorProvider = (call: Node): string | undefined => {
    if (call.type !== 'call') return undefined;
    const c = chain(call.childForFieldName('function')!);
    if (!c) return undefined;
    if (c.length === 1) return syms.get(c[0])?.kind === 'ctor' ? syms.get(c[0])!.provider : undefined;
    const s = syms.get(c[0]);
    return c.length === 2 && s && s.kind !== 'ctor' && pyCtors(s.provider).has(c[1]) ? s.provider : undefined;
  };

  // --- module constants and client bindings (`x = OpenAI()`, `self.client = OpenAI()`)
  const consts = new Map<string, string[]>();
  walk(root, (n) => {
    if (n.type !== 'assignment') return;
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    if (!left || !right) return;
    const isModuleLevel = n.parent?.parent?.type === 'module';
    const s = stringValue(right);
    const list = literalList(right);
    if (isModuleLevel && left.type === 'identifier' && (s !== undefined || list)) consts.set(left.text, list ?? [s!]);
    const p = ctorProvider(right);
    const name = chain(left)?.join('.');
    if (p && name) {
      syms.set(name, { provider: p, kind: 'client' });
      if (isModuleLevel) facts.exportedClients.push({ name, provider: p });
    }
  });

  // --- functions, local calls, routes, call sites
  const qualname = (n: Node): string => {
    const names: string[] = [];
    for (const a of [n, ...ancestors(n)]) {
      if (a.type === 'function_definition' || a.type === 'class_definition') names.unshift(a.childForFieldName('name')!.text);
    }
    // keep Class.method or top-level function; nested defs fold into their outermost function
    const fnIdx = [n, ...ancestors(n)].filter((a) => a.type === 'function_definition').length;
    return fnIdx === 0 ? '<module>' : names.slice(0, names.length - (fnIdx - 1)).join('.');
  };
  const enclosingFn = (n: Node): string => {
    const fns = ancestors(n).filter((a) => a.type === 'function_definition');
    return fns.length ? qualname(fns[fns.length - 1]) : '<module>';
  };

  const siteNodes: { node: Node; site: CallSiteFact }[] = [];

  walk(root, (n) => {
    if (n.type === 'function_definition') {
      const outer = ancestors(n).some((a) => a.type === 'function_definition');
      if (!outer) facts.functions.push({ name: qualname(n), line: line(n) });
    }
    if (n.type === 'decorated_definition') {
      const def = n.childForFieldName('definition');
      for (const d of n.namedChildren) {
        if (d?.type !== 'decorator') continue;
        const call = d.namedChildren[0];
        if (call?.type !== 'call') continue;
        const fc = chain(call.childForFieldName('function')!);
        const verb = fc?.[fc.length - 1];
        if (!fc || fc.length < 2 || !verb || !ROUTE_VERBS.has(verb)) continue;
        const args = call.childForFieldName('arguments')!.namedChildren;
        const p = args[0] ? stringValue(args[0]) : undefined;
        if (!p?.startsWith('/') || def?.type !== 'function_definition') continue;
        let method = verb.toUpperCase();
        if (verb === 'route' || verb === 'api_route') {
          const m = args.find((a) => a?.type === 'keyword_argument' && a.childForFieldName('name')!.text === 'methods');
          const vals = m ? literalList(m.childForFieldName('value')!) : undefined;
          method = vals?.[0]?.toUpperCase() ?? 'GET';
        }
        facts.routes.push({ method, path: p, handler: qualname(def), line: line(d) });
      }
    }
    if (n.type !== 'call') return;
    const fnNode = n.childForFieldName('function')!;
    const c = chain(fnNode);
    if (!c) return;
    const from = enclosingFn(n);

    // longest prefix that names a client
    let k = c.length - 1;
    while (k > 0 && syms.get(c.slice(0, k).join('.'))?.kind !== 'client') k--;
    const rest = c.slice(k);
    const sym = k > 0 ? syms.get(c.slice(0, k).join('.')) : undefined;
    if (sym && rest.length >= 2 && !pyCtors(sym.provider).has(rest[0])) {
      const resource = rest.slice(0, -1).map((seg) => (/^[A-Z]/.test(seg) && !seg.endsWith('s') ? seg + 's' : seg));
      const site: CallSiteFact = {
        provider: sym.provider, resource, method: rest[rest.length - 1], fn: from, line: line(n),
        snippet: lines[line(n) - 1].trim().slice(0, 160), args: pyArgs(n, consts), fallbackDepth: 0,
      };
      siteNodes.push({ node: n, site });
      return;
    }
    facts.calls.push({ from, callee: c, line: line(n) });
  });

  // --- fallback depth: inside an except clause whose try body also calls a provider
  for (const { node, site } of siteNodes) {
    for (const a of ancestors(node)) {
      if (a.type !== 'except_clause') continue;
      const body = a.parent?.childForFieldName('body');
      if (body && siteNodes.some((o) => o.node.startIndex >= body.startIndex && o.node.endIndex <= body.endIndex)) site.fallbackDepth++;
    }
    facts.callSites.push(site);
  }
  return facts;
}

function pyCtors(provider: string): Set<string> {
  return new Set(Object.values(providers().find((p) => p.id === provider)!.py.imports).flatMap((s) => s.ctors));
}

function pyArgs(call: Node, consts: Map<string, string[]>): ArgFact[] {
  const out: ArgFact[] = [];
  const resolve = (v: Node): ArgFact['values'] | undefined => {
    const s = stringValue(v);
    if (s !== undefined) return [s];
    if (v.type !== 'identifier') return undefined;
    // loop variable over a literal list -> ordered fallback chain
    for (const a of ancestors(v)) {
      if (a.type === 'for_statement' && a.childForFieldName('left')?.text === v.text) {
        const right = a.childForFieldName('right')!;
        return literalList(right) ?? (right.type === 'identifier' ? consts.get(right.text) : undefined);
      }
    }
    return consts.get(v.text);
  };
  const push = (name: string, v: Node) => {
    const values = resolve(v);
    out.push({ name, binding: values ? 'literal' : 'dynamic', values: values ?? [] });
  };
  const flattenDict = (d: Node) => {
    for (const pair of d.namedChildren) {
      if (pair?.type !== 'pair') continue;
      const key = stringValue(pair.childForFieldName('key')!);
      if (key) push(key, pair.childForFieldName('value')!);
    }
  };
  for (const a of call.childForFieldName('arguments')!.namedChildren) {
    if (!a) continue;
    if (a.type === 'keyword_argument') {
      const name = a.childForFieldName('name')!.text;
      const value = a.childForFieldName('value')!;
      if (name === 'params' && value.type === 'dictionary') flattenDict(value);
      else push(name, value);
    } else if (a.type === 'dictionary') flattenDict(a);
  }
  return out;
}
