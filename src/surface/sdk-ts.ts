import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parse, walk, type Node } from '../indexer/parse.js';
import { snake } from './providers.js';
import { docText, MAX_DEPTH, MAX_OPS, SKIP_MEMBERS, type ParamInfo, type Surface } from './surface.js';

// Public surface of an npm SDK, read from its .d.ts files by walking from the root client class.

interface TypeRef { name: string; qualifier?: string; file: string }
interface Member { name: string; deprecated: boolean; doc?: string; type?: TypeRef[]; params?: TypeRef[][] }
interface Decl {
  kind: 'class' | 'interface' | 'alias';
  file: string;
  depth: number;               // namespace nesting; shallower wins on name clashes
  props: Member[];             // properties and getters (resource candidates / param fields)
  methods: Member[];           // operation candidates
  extends: TypeRef[];
  alias: TypeRef[];            // union / intersection members of a type alias
}
interface FileDecls {
  decls: Map<string, Decl[]>;
  named: Map<string, { from: string; name: string }>; // import { A as B } from './x'
  ns: Map<string, string>;                            // import * as X from './x'
  reexports: { name?: string; as?: string; from: string }[];
}

const DECL_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'interface_declaration', 'type_alias_declaration']);

const isDeprecated = (n: Node) => {
  const prev = n.previousNamedSibling;
  return prev?.type === 'comment' && /@deprecated/.test(prev.text);
};

/** Named types referenced by a type node, flattening unions, intersections, arrays and generics' outer name. */
function typeRefs(n: Node | null, file: string): TypeRef[] {
  if (!n) return [];
  switch (n.type) {
    case 'type_annotation': case 'parenthesized_type': case 'readonly_type':
      return typeRefs(n.namedChildren[0], file);
    case 'type_identifier': return [{ name: n.text, file }];
    case 'nested_type_identifier': return [{ name: n.childForFieldName('name')!.text, qualifier: n.childForFieldName('module')!.text.split('.')[0], file }];
    case 'generic_type': {
      const name = n.childForFieldName('name')!;
      // Promise<X>, Array<X> etc. are wrappers; anything else is the named type itself
      if (/^(Promise|APIPromise|Array|ReadonlyArray|Partial|Required|Readonly)$/.test(name.text)) return typeRefs(n.childForFieldName('type_arguments')?.namedChildren[0] ?? null, file);
      return typeRefs(name, file);
    }
    case 'union_type': case 'intersection_type':
      return n.namedChildren.flatMap((c) => typeRefs(c, file));
    case 'object_type': return [{ name: `__inline_${n.startIndex}`, file }];
    default: return [];
  }
}

function memberName(n: Node): string | undefined {
  const nm = n.childForFieldName('name');
  if (!nm) return undefined;
  return nm.type === 'string' ? nm.namedChildren[0]?.text : nm.text;
}

function paramsOf(fp: Node | null, file: string): TypeRef[][] {
  return (fp?.namedChildren ?? []).filter((p) => p?.type === 'required_parameter' || p?.type === 'optional_parameter')
    .map((p) => typeRefs(p!.childForFieldName('type'), file));
}

function readDecls(file: string, root: Node): FileDecls {
  const fd: FileDecls = { decls: new Map(), named: new Map(), ns: new Map(), reexports: [] };
  const add = (name: string, d: Decl) => fd.decls.set(name, [...(fd.decls.get(name) ?? []), d]);
  const bodyMembers = (body: Node, d: Decl) => {
    for (const m of body.namedChildren) {
      if (!m) continue;
      const name = memberName(m);
      if (!name || name.startsWith('[')) continue;
      if (m.namedChildren.some((c) => c?.type === 'accessibility_modifier' && c.text !== 'public')) continue;
      const deprecated = isDeprecated(m);
      if (m.type === 'public_field_definition' || m.type === 'property_signature') {
        const t = m.childForFieldName('type');
        const fn = t?.namedChildren[0];
        const prev = m.previousNamedSibling;
        const doc = prev?.type === 'comment' ? docText(prev.text) : undefined;
        if (fn?.type === 'function_type') d.methods.push({ name, deprecated, params: paramsOf(fn.childForFieldName('parameters'), file) });
        else d.props.push({ name, deprecated, doc, type: typeRefs(t, file) });
      } else if (m.type === 'method_signature' || m.type === 'method_definition' || m.type === 'abstract_method_signature') {
        const isGetter = m.children.some((c) => c?.type === 'get');
        if (isGetter) d.props.push({ name, deprecated, type: typeRefs(m.childForFieldName('return_type'), file) });
        else d.methods.push({ name, deprecated, params: paramsOf(m.childForFieldName('parameters'), file) });
      }
    }
  };
  walk(root, (n) => {
    if (n.type === 'import_statement') {
      const from = n.childForFieldName('source')?.namedChildren[0]?.text ?? '';
      for (const c of n.descendantsOfType(['namespace_import', 'import_specifier'])) {
        if (!c) continue;
        if (c.type === 'namespace_import') fd.ns.set(c.namedChildren[0]!.text, from);
        else fd.named.set(c.childForFieldName('alias')?.text ?? c.childForFieldName('name')!.text, { from, name: c.childForFieldName('name')!.text });
      }
      return false;
    }
    if (n.type === 'export_statement' && n.childForFieldName('source')) {
      const from = n.childForFieldName('source')!.namedChildren[0]!.text;
      const specs = n.descendantsOfType('export_specifier');
      if (!specs.length) fd.reexports.push({ from });
      for (const s of specs) fd.reexports.push({ from, name: s!.childForFieldName('name')!.text, as: s!.childForFieldName('alias')?.text ?? s!.childForFieldName('name')!.text });
      return false;
    }
    if (!DECL_TYPES.has(n.type)) return;
    let depth = 0;
    for (let p = n.parent; p; p = p.parent) if (p.type === 'internal_module' || p.type === 'module') depth++;
    if (n.type === 'class_declaration' || n.type === 'abstract_class_declaration' || n.type === 'interface_declaration') {
      const d: Decl = { kind: n.type === 'interface_declaration' ? 'interface' : 'class', file, depth, props: [], methods: [], extends: [], alias: [] };
      for (const h of n.descendantsOfType(['extends_clause', 'extends_type_clause'])) {
        if (h?.parent !== n && h?.parent?.parent !== n) continue;
        for (const c of h.namedChildren) {
          if (!c) continue;
          if (c.type === 'identifier') d.extends.push({ name: c.text, file });
          else if (c.type === 'member_expression') d.extends.push({ name: c.childForFieldName('property')!.text, qualifier: c.childForFieldName('object')!.text, file });
          else d.extends.push(...typeRefs(c, file));
        }
      }
      const body = n.childForFieldName('body');
      if (body) bodyMembers(body, d);
      add(n.childForFieldName('name')!.text, d);
    } else if (n.type === 'type_alias_declaration') {
      const d: Decl = { kind: 'alias', file, depth, props: [], methods: [], extends: [], alias: typeRefs(n.childForFieldName('value'), file) };
      // inline object members of the alias become fields
      for (const o of n.childForFieldName('value')?.descendantsOfType('object_type') ?? []) if (o) bodyMembers(o, d);
      add(n.childForFieldName('name')!.text, d);
    }
  });
  return fd;
}

/** Directory holding the package's type declarations. */
function typesRoot(pkgDir: string): string {
  const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const dot = pj.exports?.['.'];
  const candidates = [pj.types, pj.typings, dot?.types, dot?.import?.types, dot?.require?.types, typeof dot?.import === 'string' ? dot.import : undefined]
    .filter((x): x is string => typeof x === 'string');
  for (const c of candidates) {
    const p = join(pkgDir, c);
    if (existsSync(p)) return dirname(p);
  }
  return pkgDir;
}

function dtsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...dtsFiles(p)); }
    else if (/\.d\.(m|c)?ts$/.test(e.name) && statSync(p).size < 8_000_000) out.push(p);
  }
  return out;
}

export async function tsSurface(pkgDir: string, rootClass: string): Promise<Surface> {
  const root = typesRoot(pkgDir);
  const files = new Map<string, FileDecls>();
  for (const f of dtsFiles(root)) files.set(f, readDecls(f, await parse('ts', readFileSync(f, 'utf8'))));

  const modFile = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith('.')) return undefined;
    const base = normalize(join(dirname(from), spec)).replace(/\.(m|c)?js$/, '');
    return [`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, join(base, 'index.d.ts'), join(base, 'index.d.mts')].find((p) => files.has(p));
  };
  const findIn = (file: string | undefined, name: string, seen = new Set<string>()): Decl[] => {
    if (!file || seen.has(file + name)) return [];
    seen.add(file + name);
    const fd = files.get(file)!;
    const local = fd.decls.get(name);
    if (local) return local;
    const imp = fd.named.get(name);
    if (imp) { const r = findIn(modFile(file, imp.from), imp.name, seen); if (r.length) return r; }
    for (const re of fd.reexports) {
      if (re.as === name) { const r = findIn(modFile(file, re.from), re.name!, seen); if (r.length) return r; }
      if (!re.name) { const r = findIn(modFile(file, re.from), name, seen); if (r.length) return r; }
    }
    return [];
  };
  const globalByName = new Map<string, Decl[]>();
  for (const fd of files.values()) for (const [n, ds] of fd.decls) globalByName.set(n, [...(globalByName.get(n) ?? []), ...ds]);

  const resolve = (t: TypeRef): Decl[] => {
    const fd = files.get(t.file)!;
    if (t.qualifier && fd.ns.has(t.qualifier)) {
      const r = findIn(modFile(t.file, fd.ns.get(t.qualifier)!), t.name);
      if (r.length) return r;
    }
    const r = findIn(t.file, t.name);
    if (r.length) return r;
    const g = globalByName.get(t.name) ?? [];
    const min = Math.min(...g.map((d) => d.depth));
    return g.filter((d) => d.depth === min);
  };

  /** Field names of a params type, following extends, aliases, unions and intersections. */
  const fields = (refs: TypeRef[], depth = 0, acc = new Map<string, ParamInfo>()) => {
    if (depth > 6) return acc;
    for (const r of refs) {
      if (/^(RequestOptions|RequestInit|FinalRequestOptions)$/.test(r.name)) continue;
      for (const d of resolve(r)) {
        for (const p of d.props) if (!acc.has(snake(p.name))) acc.set(snake(p.name), { deprecated: p.deprecated, ...(p.doc ? { doc: p.doc } : {}) });
        fields([...d.extends, ...d.alias], depth + 1, acc);
      }
    }
    return acc;
  };

  const surface: Surface = new Map();
  const visit = (decls: Decl[], path: string[], deprecated: boolean, stack: Set<Decl>) => {
    if (path.length > MAX_DEPTH || surface.size > MAX_OPS) return;
    const members = (d: Decl, depth = 0): { props: Member[]; methods: Member[] } => {
      const base = depth < 4 ? d.extends.flatMap((e) => resolve(e)).map((b) => members(b, depth + 1)) : [];
      return { props: [...d.props, ...base.flatMap((b) => b.props)], methods: [...d.methods, ...base.flatMap((b) => b.methods)] };
    };
    for (const d of decls) {
      if (stack.has(d)) continue;
      const next = new Set(stack).add(d);
      const { props, methods } = members(d);
      if (path.length) {
        for (const m of methods) {
          if (m.name.startsWith('_') || m.name.startsWith('#') || SKIP_MEMBERS.has(m.name)) continue;
          const key = [...path, m.name].map(snake).join('.');
          const first = (m.params ?? [])[0] ?? [];
          const prev = surface.get(key);
          const params = Object.fromEntries(fields(first));
          if (prev) { Object.assign(prev.params, params); prev.deprecated &&= deprecated || m.deprecated; }
          else surface.set(key, { resource: path, method: m.name, deprecated: deprecated || m.deprecated, params });
        }
      }
      for (const p of props) {
        if (p.name.startsWith('_') || SKIP_MEMBERS.has(p.name) || !p.type?.length) continue;
        const targets = p.type.flatMap(resolve).filter((t) => t.kind !== 'alias' && (t.methods.length || t.props.length || t.extends.length));
        if (targets.length) visit(targets, [...path, p.name], deprecated || p.deprecated, next);
      }
    }
  };
  const roots = globalByName.get(rootClass)?.filter((d) => d.kind === 'class') ?? [];
  if (!roots.length) throw new Error(`root client class ${rootClass} not found in ${root}`);
  visit(roots.sort((a, b) => b.props.length - a.props.length).slice(0, 1), [], false, new Set());
  return surface;
}
