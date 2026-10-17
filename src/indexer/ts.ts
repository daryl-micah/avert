import { providers } from '../surface/providers.js';
import { ancestors, line, parse, walk, type Node } from './parse.js';
import type { ArgFact, CallSiteFact, FileFacts, ImportedClients } from './types.js';

type Sym = { provider: string; kind: 'ctor' | 'factory' | 'client' };

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const NEXT_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FN_TYPES = new Set(['function_declaration', 'method_definition', 'arrow_function', 'function_expression', 'generator_function_declaration']);

/** Flatten `a.b.c` / `this.a.b` into ["a","b","c"] / ["this","a","b"]. */
function chain(n: Node): string[] | undefined {
  if (n.type === 'identifier' || n.type === 'this') return [n.text];
  if (n.type === 'member_expression') {
    const head = chain(n.childForFieldName('object')!);
    const prop = n.childForFieldName('property');
    return head && prop ? [...head, prop.text] : undefined;
  }
  if (n.type === 'non_null_expression' || n.type === 'parenthesized_expression') return n.namedChildren[0] ? chain(n.namedChildren[0]) : undefined;
  return undefined;
}

function stringValue(n: Node): string | undefined {
  if (n.type === 'string') return n.namedChildren.filter((c) => c?.type === 'string_fragment').map((c) => c!.text).join('');
  if (n.type === 'template_string' && !n.namedChildren.some((c) => c?.type === 'template_substitution')) return n.text.slice(1, -1);
  if (n.type === 'as_expression' || n.type === 'satisfies_expression') return n.namedChildren[0] ? stringValue(n.namedChildren[0]) : undefined;
  return undefined;
}

function literalList(n: Node): string[] | undefined {
  if (n.type === 'as_expression') return n.namedChildren[0] ? literalList(n.namedChildren[0]) : undefined;
  if (n.type !== 'array') return undefined;
  const vals = n.namedChildren.map((c) => (c ? stringValue(c) : undefined));
  return vals.length && vals.every((v) => v !== undefined) ? (vals as string[]) : undefined;
}

/** Name of the function a node defines, if it is one we track. */
function fnName(n: Node): string | undefined {
  if (n.type === 'function_declaration' || n.type === 'generator_function_declaration') return n.childForFieldName('name')?.text;
  if (n.type === 'method_definition') {
    const cls = ancestors(n).find((a) => a.type === 'class_declaration' || a.type === 'class');
    const c = cls?.childForFieldName('name')?.text;
    const m = n.childForFieldName('name')!.text;
    return c ? `${c}.${m}` : m;
  }
  if (n.type === 'arrow_function' || n.type === 'function_expression') {
    const p = n.parent;
    if (p?.type === 'variable_declarator') return p.childForFieldName('name')?.text;
    if (p?.type === 'public_field_definition') {
      const cls = ancestors(n).find((a) => a.type === 'class_declaration');
      const name = p.childForFieldName('name')!.text;
      return cls ? `${cls.childForFieldName('name')!.text}.${name}` : name;
    }
  }
  return undefined;
}

export async function extractTs(path: string, source: string, imported: ImportedClients): Promise<FileFacts> {
  const root = await parse(path.endsWith('x') ? 'tsx' : 'ts', source);
  const lines = source.split('\n');
  const facts: FileFacts = { path, lang: 'ts', functions: [{ name: '<module>', line: 1 }], calls: [], imports: [], routes: [], callSites: [], exportedClients: [] };

  const syms = new Map<string, Sym>();
  for (const [local, provider] of imported) syms.set(local, { provider, kind: 'client' });
  const specs = providers().flatMap((p) => Object.entries(p.ts.imports).map(([mod, spec]) => ({ p: p.id, mod, spec })));

  // --- imports
  walk(root, (n) => {
    if (n.type !== 'import_statement') return;
    const mod = stringValue(n.childForFieldName('source')!) ?? '';
    const hit = specs.find((s) => s.mod === mod);
    const clause = n.namedChildren.find((c) => c?.type === 'import_clause');
    for (const c of clause?.namedChildren ?? []) {
      if (!c) continue;
      if (c.type === 'identifier') {
        facts.imports.push({ local: c.text, module: mod, imported: 'default' });
        if (hit?.spec.ctors.includes('default')) syms.set(c.text, { provider: hit.p, kind: hit.spec.call ? 'factory' : 'ctor' });
      } else if (c.type === 'namespace_import') {
        const local = c.namedChildren[0]!.text;
        facts.imports.push({ local, module: mod, imported: '*' });
      } else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s?.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')!.text;
          const local = s.childForFieldName('alias')?.text ?? name;
          facts.imports.push({ local, module: mod, imported: name });
          if (hit?.spec.ctors.includes(name)) syms.set(local, { provider: hit.p, kind: 'ctor' });
        }
      }
    }
    return false;
  });

  const ctorProvider = (n: Node): string | undefined => {
    if (n.type === 'await_expression') return n.namedChildren[0] ? ctorProvider(n.namedChildren[0]) : undefined;
    if (n.type === 'new_expression') {
      const c = chain(n.childForFieldName('constructor')!);
      const s = c?.length === 1 ? syms.get(c[0]) : undefined;
      return s && s.kind !== 'client' ? s.provider : undefined;
    }
    if (n.type === 'call_expression') {
      const c = chain(n.childForFieldName('function')!);
      const s = c?.length === 1 ? syms.get(c[0]) : undefined;
      return s?.kind === 'factory' ? s.provider : undefined;
    }
    return undefined;
  };

  // --- module constants and client bindings
  const consts = new Map<string, string[]>();
  walk(root, (n) => {
    let name: string | undefined;
    let value: Node | null = null;
    if (n.type === 'variable_declarator') {
      name = n.childForFieldName('name')?.text;
      value = n.childForFieldName('value');
      const topLevel = !ancestors(n).some((a) => FN_TYPES.has(a.type) || a.type === 'class_body');
      if (topLevel && name && value) {
        const s = stringValue(value);
        const list = literalList(value);
        if (s !== undefined || list) consts.set(name, list ?? [s!]);
      }
    } else if (n.type === 'public_field_definition') {
      name = 'this.' + n.childForFieldName('name')?.text;
      value = n.childForFieldName('value');
    } else if (n.type === 'assignment_expression') {
      name = chain(n.childForFieldName('left')!)?.join('.');
      value = n.childForFieldName('right');
    }
    if (!name || !value) return;
    const p = ctorProvider(value);
    if (!p) return;
    syms.set(name, { provider: p, kind: 'client' });
    if (ancestors(n).some((a) => a.type === 'export_statement')) facts.exportedClients.push({ name, provider: p });
  });
  // `export { stripe }` / `export default stripe`
  walk(root, (n) => {
    if (n.type !== 'export_statement') return;
    for (const s of n.descendantsOfType('export_specifier')) {
      const name = s?.childForFieldName('name')?.text;
      const sym = name ? syms.get(name) : undefined;
      if (sym?.kind === 'client') facts.exportedClients.push({ name: s!.childForFieldName('alias')?.text ?? name!, provider: sym.provider });
    }
    const v = n.childForFieldName('value');
    if (v?.type === 'identifier' && syms.get(v.text)?.kind === 'client') facts.exportedClients.push({ name: 'default', provider: syms.get(v.text)!.provider });
  });

  const enclosingFn = (n: Node): string => {
    let best = '<module>';
    for (const a of ancestors(n)) {
      if (!FN_TYPES.has(a.type)) continue;
      const nm = fnName(a) ?? routeHandlerName.get(a.startIndex);
      if (nm) best = nm; // outermost named function wins
    }
    return best;
  };

  // --- routes: app.post('/x', handler) and Next.js app router files
  const routeHandlerName = new Map<number, string>();
  walk(root, (n) => {
    if (n.type !== 'call_expression') return;
    const c = chain(n.childForFieldName('function')!);
    const verb = c?.[c.length - 1];
    if (!c || c.length !== 2 || !verb || !ROUTE_VERBS.has(verb)) return;
    const args = n.childForFieldName('arguments')!.namedChildren.filter(Boolean) as Node[];
    const p = args[0] ? stringValue(args[0]) : undefined;
    const h = args[args.length - 1];
    if (!p?.startsWith('/') || args.length < 2) return;
    const method = verb === 'all' ? 'ANY' : verb.toUpperCase();
    let handler: string | undefined;
    if (h.type === 'identifier') handler = h.text;
    else if (h.type === 'member_expression') handler = chain(h)?.join('.');
    else if (FN_TYPES.has(h.type)) {
      handler = `${method} ${p}`;
      routeHandlerName.set(h.startIndex, handler);
      facts.functions.push({ name: handler, line: line(h) });
    }
    if (handler) facts.routes.push({ method, path: p, handler, line: line(n) });
  });
  const next = path.match(/(?:^|\/)app\/(.*?)\/?route\.(?:ts|js|tsx)$/);
  if (next) {
    const routePath = '/' + next[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/');
    walk(root, (n) => {
      if (n.type !== 'export_statement') return;
      const d = n.childForFieldName('declaration');
      const names = d?.type === 'function_declaration' ? [d.childForFieldName('name')!.text]
        : d?.type === 'lexical_declaration' ? d.namedChildren.map((v) => v?.childForFieldName('name')?.text ?? '') : [];
      for (const nm of names) if (NEXT_VERBS.has(nm)) facts.routes.push({ method: nm, path: routePath.replace(/\/$/, '') || '/', handler: nm, line: line(n) });
    });
  }

  // --- functions, calls, call sites
  const siteNodes: { node: Node; site: CallSiteFact }[] = [];
  walk(root, (n) => {
    if (FN_TYPES.has(n.type)) {
      const nm = fnName(n);
      if (nm && !ancestors(n).some((a) => FN_TYPES.has(a.type))) facts.functions.push({ name: nm, line: line(n) });
    }
    if (n.type !== 'call_expression') return;
    const c = chain(n.childForFieldName('function')!);
    if (!c) return;
    const from = enclosingFn(n);
    let k = c.length - 1;
    while (k > 0 && syms.get(c.slice(0, k).join('.'))?.kind !== 'client') k--;
    const sym = k > 0 ? syms.get(c.slice(0, k).join('.')) : undefined;
    const rest = c.slice(k);
    if (sym && rest.length >= 2) {
      const site: CallSiteFact = {
        provider: sym.provider, resource: rest.slice(0, -1), method: rest[rest.length - 1], fn: from, line: line(n),
        snippet: lines[line(n) - 1].trim().slice(0, 160), args: tsArgs(n, consts), fallbackDepth: 0,
      };
      siteNodes.push({ node: n, site });
      return;
    }
    facts.calls.push({ from, callee: c, line: line(n) });
  });

  for (const { node, site } of siteNodes) {
    for (const a of ancestors(node)) {
      if (a.type !== 'catch_clause') continue;
      const body = a.parent?.childForFieldName('body');
      if (body && siteNodes.some((o) => o.node.startIndex >= body.startIndex && o.node.endIndex <= body.endIndex)) site.fallbackDepth++;
    }
    facts.callSites.push(site);
  }
  return facts;
}

function tsArgs(call: Node, consts: Map<string, string[]>): ArgFact[] {
  const out: ArgFact[] = [];
  const resolve = (v: Node): string[] | undefined => {
    const s = stringValue(v);
    if (s !== undefined) return [s];
    if (v.type !== 'identifier' && v.type !== 'shorthand_property_identifier') return undefined;
    for (const a of ancestors(v)) {
      if (a.type !== 'for_in_statement') continue;
      const left = a.childForFieldName('left');
      if (left?.text === v.text || left?.namedChildren.some((c) => c?.text === v.text)) {
        const right = a.childForFieldName('right')!;
        return literalList(right) ?? (right.type === 'identifier' ? consts.get(right.text) : undefined);
      }
    }
    return consts.get(v.text);
  };
  const first = call.childForFieldName('arguments')!.namedChildren[0];
  if (first?.type !== 'object') return out;
  for (const p of first.namedChildren) {
    if (!p) continue;
    let name: string | undefined;
    let value: Node | undefined;
    if (p.type === 'pair') {
      const key = p.childForFieldName('key')!;
      name = key.type === 'string' ? stringValue(key) : key.text;
      value = p.childForFieldName('value')!;
    } else if (p.type === 'shorthand_property_identifier') {
      name = p.text;
      value = p;
    }
    if (!name || !value) continue;
    const values = resolve(value);
    out.push({ name, binding: values ? 'literal' : 'dynamic', values: values ?? [] });
  }
  return out;
}
